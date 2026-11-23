import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { openLocalContext } from "../src/core/context.ts";
import type { LocalUsageView } from "../src/core/local-usage.ts";
import { getOp, runOp } from "../src/core/operations.ts";
import { writeConcept } from "../src/core/okf/write.ts";
import { okb } from "./helpers.ts";

test("local opt-in counts opens and verified citations without changing notes or affecting other brains", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-usage-"));
  const bundle = join(root, "brain");
  const other = join(root, "other");
  const data = join(root, "data");
  await mkdir(bundle);
  await mkdir(other);
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ choices: [{ message: { content: "Larkspur [notes/evidence]. Repeat [notes/evidence]. Unknown [notes/elsewhere]." } }] });
  } });
  const overrides = { XDG_DATA_HOME: data, LOCALAPPDATA: data, XDG_CONFIG_HOME: root, APPDATA: root,
    OKB_CHAT_PROVIDER: "ollama", OKB_CHAT_BASE_URL: `http://127.0.0.1:${model.port}/v1` };
  const prior = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const token = "local-note-usage";
  const api = createApiServer({ bundle, token, port: 0 });
  const readonly = createApiServer({ bundle, token, port: 0, readonly: true });
  const isolated = createApiServer({ bundle: other, token, port: 0 });
  const evidence = { id: "notes/evidence", type: "note", title: "Larkspur", description: "Garden note", body: "Larkspur garden." };

  async function op(base: string, name: string, params: object) {
    return fetch(`${base}api/op/${name}`, { method: "POST", headers: { "x-okb-token": token, "content-type": "application/json" }, body: JSON.stringify(params) });
  }

  try {
    await writeConcept(bundle, evidence);
    await writeConcept(other, evidence);
    await writeConcept(bundle, { id: "summary", type: "note", title: "Garden summary", description: "Sources", sources: [
      { resource: "/notes/evidence.md", title: "Evidence", usage_count: 91 },
      { resource: "https://example.test/external", usage_count: 23 },
    ] });
    expect((await op(api.url, "index", {})).ok).toBe(true);
    const notePath = join(bundle, "notes", "evidence.md");
    const original = await readFile(notePath, "utf8");
    const read = async (base = api.url, id = evidence.id) => {
      const response = await op(base, "read_concept", { id });
      expect(response.ok).toBe(true);
      return await response.json() as { result: { localUsage?: LocalUsageView; frontmatter: { sources: { usage_count: number }[] } } };
    };
    expect((await read()).result.localUsage).toBeUndefined();
    expect(await Bun.file(join(data, "okbrain", "note-usage", "usage.db")).exists()).toBe(false);
    expect(await (await op(api.url, "note_usage_settings", { mode: "on" })).json()).toEqual({ result: { enabled: true, windowDays: 30 } });
    expect((await read()).result.localUsage?.note).toMatchObject({ usage_count: 1, opens: 1, citations: 0 });

    const summary = (await read(api.url, "summary")).result;
    expect(summary.frontmatter.sources.map((source: { usage_count: number }) => source.usage_count)).toEqual([91, 23]);
    expect(summary.localUsage?.sources).toEqual({ "/notes/evidence.md": expect.objectContaining({ usage_count: 1 }) });
    expect((await read(readonly.url)).result.localUsage).toBeUndefined();
    expect((await read(isolated.url)).result.localUsage).toBeUndefined();
    expect((await op(readonly.url, "note_usage_settings", { mode: "off" })).status).toBe(403);
    const mcp = openLocalContext(bundle, true, false, "test-agent/1");
    try { expect(await runOp(getOp("read_concept")!, mcp.ctx, { id: evidence.id })).not.toHaveProperty("localUsage"); }
    finally { mcp.close(); }

    const asked = await (await op(api.url, "ask", { question: "Larkspur", profile: "lean" })).json() as { result: { citations: { id: string }[] } };
    expect(asked.result.citations.map(({ id }) => id)).toEqual([evidence.id]);
    expect((await op(api.url, "rebuild", { "confirm-destructive": true })).ok).toBe(true);
    const fromCli = await okb(["--bundle", bundle, "read", evidence.id, "--json"]);
    expect(fromCli.code).toBe(0);
    expect(JSON.parse(fromCli.stdout).localUsage.note).toMatchObject({ usage_count: 3, opens: 2, citations: 1 });
    expect(await readFile(notePath, "utf8")).toBe(original);

    expect((await okb(["--bundle", bundle, "usage", "settings", "off"])).code).toBe(0);
    expect((await read()).result.localUsage).toBeUndefined();
    expect((await op(api.url, "note_usage_settings", { mode: "on" })).ok).toBe(true);
    expect((await read()).result.localUsage?.note).toMatchObject({ usage_count: 1, opens: 1, citations: 0 });
  } finally {
    await Promise.allSettled([api.stop(), readonly.stop(), isolated.stop(), model.stop(true)]);
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
