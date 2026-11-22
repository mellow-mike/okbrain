import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";
import { readConcept } from "../src/core/okf/bundle.ts";
import { TOOL_ACTOR } from "../src/core/version.ts";
import { okb } from "./helpers.ts";

test("CLI init starts blank, and an optional starter remains portable", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "okb-starter-cli-"));
  const config = loadConfig();
  try {
    expect((await okb(["--bundle", bundle, "init"])).code).toBe(0);
    expect((await okb(["--bundle", bundle, "list", "--json"])).stdout.trim()).toBe("[]");
    expect((await okb(["--bundle", bundle, "brain-templates"])).stdout).toMatch(/personal[\s\S]*projects/);
    expect((await okb(["--bundle", bundle, "init", "--template", "unknown"])).code).toBe(2);
    const created = await okb(["--bundle", bundle, "init", "--template", "projects"]);
    expect(created).toMatchObject({ code: 0, stdout: expect.stringContaining("added projects starter guide") });
    const guide = await readConcept(bundle, "start-here");
    expect(guide.doc.frontmatter).toMatchObject({
      type: "guide", starter_template: "projects",
      tags: ["project", "decision", "lesson"], generated: { by: TOOL_ACTOR },
    });
    expect(await readFile(join(bundle, "index.md"), "utf8")).toContain("(/start-here.md)");
    expect((await okb(["--bundle", bundle, "doctor"])).code).toBe(0);
    expect((await okb(["--bundle", bundle, "init", "--template", "personal"])).code).toBe(2);
    expect((await readConcept(bundle, "start-here")).raw).toBe(guide.raw);
  } finally {
    saveConfig(config);
    await rm(bundle, { force: true, recursive: true });
  }
});

test("App starter applies only to the selected empty writable mount and refreshes its local index", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "okb-starter-app-"));
  const mounted = join(bundle, "mounted");
  const readonly = join(bundle, "readonly");
  await mkdir(mounted);
  await mkdir(readonly);
  const config = loadConfig();
  const token = "starter-test-token";
  const server = createApiServer({ bundle, port: 0, token });
  function command(name: string, input = {}, brain = "target", auth = token) {
    return fetch(server.url + "api/op/" + name, {
      method: "POST",
      headers: { "content-type": "application/json", "x-okb-token": auth, "x-okb-brain": brain },
      body: JSON.stringify(input),
    });
  }
  try {
    saveConfig({ ...config, defaultBundle: bundle, brains: { target: mounted, readonly: { path: readonly, readonly: true } } });
    const before = loadConfig();
    const params = { template: "personal", "no-default-bundle": true };
    expect((await command("brain_templates")).status).toBe(200);
    expect((await command("init", params, "readonly")).status).toBe(403);
    expect((await command("init", params, "target", "invalid")).status).toBe(401);
    expect(await Bun.file(join(readonly, "start-here.md")).exists()).toBe(false);
    expect((await command("index")).status).toBe(200);
    const made = await command("init", params);
    expect(made.status).toBe(200);
    expect(await made.json()).toMatchObject({ result: { path: null, starter: { name: "personal", id: "start-here" } } });
    expect(loadConfig()).toEqual(before);
    expect(await Bun.file(join(bundle, "start-here.md")).exists()).toBe(false);
    const search = await command("search", { query: "reading", profile: "lean" });
    expect(search.status).toBe(200);
    expect(JSON.stringify(await search.json())).toContain("start-here");
    const original = "Human-edited note without frontmatter.\n";
    await writeFile(join(readonly, "original.md"), original);
    saveConfig({ ...before, brains: { ...before.brains, readonly } });
    expect((await command("init", params, "readonly")).status).toBe(400);
    expect(await readFile(join(readonly, "original.md"), "utf8")).toBe(original);
  } finally {
    server.stop();
    saveConfig(config);
    await rm(bundle, { force: true, recursive: true });
  }
});
