import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { computationRuntime } from "../src/core/okf/computation.ts";
import { readConcept } from "../src/core/okf/bundle.ts";
import { mcpOps } from "../src/mcp/server.ts";
import { okb } from "./helpers.ts";

const token = "computation-owner-test";
const note = "---\ntype: Attested Computation\ntitle: Local result\ndescription: Reviewed CSV computation\n"
  + "generated: { by: 'human:operator', at: '2026-01-01T00:00:00Z' }\n"
  + "verified: [{ by: 'human:operator', at: '2026-01-02T00:00:00Z' }]\n"
  + "unknown_metadata: preserve me\n---\nKeep this body.\n";

function requests(api: ApiServer) {
  const post = (operation: string, data: object, options: RequestInit = {}, query = "") =>
    fetch(api.url + "api/op/computation_" + operation + query, {
      method: "POST", headers: { "x-okb-token": token, "content-type": "application/json" }, body: JSON.stringify(data), ...options,
    });
  const call = async <T>(operation: string, data: object) => {
    const response = await post(operation, data);
    const payload = await response.json() as { result: T; error?: string };
    if (!response.ok) throw new Error(payload.error ?? String(response.status));
    return payload.result;
  };
  return { post, call };
}

test("approves, computes, independently verifies, and explicitly records a scoped process receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-computation-"));
  const api = createApiServer({ bundle: root, port: 0, token });
  try {
    const id = "metrics/revenue";
    await mkdir(join(root, "metrics"));
    await mkdir(join(root, "data"));
    await writeFile(join(root, `${id}.md`), note);
    const csv = 'year,region,approved,cents\r\n2026,"North, West",true,9007199254740991\r\n'
      + '2026,"North, West",true,9\r\n2026,"North, West",false,100\r\n2025,Other,true,12\r\n';
    await writeFile(join(root, "data", "revenue.csv"), csv);
    const config = {
      parameters: [
        { name: "year", type: "integer", required: true }, { name: "area", type: "string", required: true },
        { name: "reviewed", type: "boolean", required: true },
      ],
      executor: { source: "data/revenue.csv", operation: "sum", column: "cents",
        filters: [{ column: "year", parameter: "year" }, { column: "region", parameter: "area" }, { column: "approved", parameter: "reviewed" }] },
    };
    const { post, call } = requests(api);
    const configBody = { id, contract: JSON.stringify(config) };
    expect((await post("configure", configBody, { headers: { "content-type": "application/json" } }, "?token=" + token)).status).toBe(401);
    expect((await post("configure", configBody, { headers: { "content-type": "application/json", "x-okb-token": token,
      origin: "https://elsewhere.example" } })).status).toBe(403);
    await call("configure", configBody);
    const configured = await readConcept(root, id);
    expect(configured.doc.frontmatter.runtime).toBe(computationRuntime);
    expect(configured.doc.frontmatter.unknown_metadata).toBe("preserve me");
    const input = { id, parameters: JSON.stringify({ year: 2026, area: "North, West", reviewed: true }) };
    expect((await post("preview", { ...input, parameters: '{"year":"2026","area":"North, West","reviewed":true}' })).status).toBe(400);
    const preview = await call<{ approval: string; source: { text: string } }>("preview", input);
    expect(preview.source.text).toBe(csv);
    expect(preview).not.toHaveProperty("result");
    expect((await post("run", { ...input, approval: "0".repeat(64) })).status).toBe(403);
    await writeFile(join(root, "data/revenue.csv"), csv.replace(",9\r\n", ",10\r\n"));
    expect((await post("run", { ...input, approval: preview.approval })).status).toBe(403);
    await writeFile(join(root, "data/revenue.csv"), csv);

    const computed = await okb(["computation", "run", id, "--parameters", input.parameters, "--approval", preview.approval, "--bundle", root, "--json"]);
    expect(computed.code).toBe(0);
    const receipt = JSON.parse(computed.stdout) as {
      digest: string; result: { operation: string; rowCount: number; matchedRows: number; value: string }; [name: string]: unknown;
    };
    expect(receipt.result).toEqual({ operation: "sum", rowCount: 4, matchedRows: 2, value: "9007199254741000" });
    expect(JSON.stringify(receipt)).not.toContain(csv);
    const { digest: _initial, ...wrong } = receipt;
    wrong.result = { ...wrong.result, value: "42" };
    const forged = { ...wrong, digest: createHash("sha256").update(JSON.stringify(wrong)).digest("hex") };
    expect((await post("verify", { id, receipt: JSON.stringify(forged) })).status).toBe(403);
    const submitted = JSON.stringify(Object.fromEntries(Object.entries(receipt).reverse()));
    const verifying = { id, receipt: submitted };
    const verified = await call<{ approval: string; verified: boolean }>("verify", verifying);
    expect(verified.verified).toBe(true);
    expect((await readConcept(root, id)).raw).toBe(configured.raw);
    expect((await post("attest", { ...verifying, approval: verified.approval })).status).toBe(403);
    expect((await post("attest", { ...verifying, approval: preview.approval, confirm: true })).status).toBe(403);
    await call("attest", { ...verifying, approval: verified.approval, confirm: true });
    const stamped = await readConcept(root, id);
    expect(stamped.doc.frontmatter.generated).toEqual(configured.doc.frontmatter.generated);
    expect(stamped.doc.frontmatter.verified).toContainEqual(expect.objectContaining({ by: "process:okbrain-csv-aggregate-v1" }));
    expect(stamped.doc.frontmatter.computation_verification).toMatchObject({ receipt_digest: receipt.digest });
    expect(stamped.doc.body).toBe(configured.doc.body);
    const replay = await call<{ reused: boolean }>("attest", { ...verifying, approval: verified.approval, confirm: true });
    expect(replay.reused).toBe(true);
    expect((await readConcept(root, id)).raw).toBe(stamped.raw);
    await writeFile(join(root, "data/revenue.csv"), csv + "2026,Other,true,22\r\n");
    expect((await post("verify", verifying)).status).toBe(403);
    expect((await readConcept(root, id)).raw).toBe(stamped.raw);
    expect(mcpOps(true).some((operation) => operation.name.startsWith("computation_"))).toBe(false);
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("rejects undeclared files and external runtimes and respects readonly mounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-computation-boundary-"));
  const api = createApiServer({ bundle: root, port: 0, token });
  const readonly = createApiServer({ bundle: root, port: 0, token, readonly: true });
  try {
    const id = "count";
    await writeFile(join(root, "count.md"), note);
    const { post, call } = requests(api);
    const contract = (source: string) => JSON.stringify({ parameters: [], executor: { operation: "count", source } });
    expect((await post("configure", { id, contract: contract("../outside.csv") })).status).toBe(400);
    expect((await post("configure", { id, contract: contract("db_only/private.csv") })).status).toBe(403);
    await call("configure", { id, contract: contract("local.csv") });
    if (process.platform !== "win32") {
      await symlink(join(root, "count.md"), join(root, "local.csv"));
      expect((await post("preview", { id, parameters: "{}" })).status).toBe(400);
      await rm(join(root, "local.csv"));
    }
    await writeFile(join(root, "local.csv"), 'kind\n"unclosed\n');
    const invalid = await call<{ approval: string }>("preview", { id, parameters: "{}" });
    expect((await post("run", { id, parameters: "{}", approval: invalid.approval })).status).toBe(400);
    await writeFile(join(root, "local.csv"), "kind\nfruit\nseed\n");
    expect((await requests(readonly).post("preview", { id, parameters: "{}" })).status).toBe(403);

    const acme = resolve(import.meta.dir, "../bundles/acme_retail");
    const path = join(acme, "computations/revenue-ytd.md");
    const before = await readFile(path, "utf8");
    expect((await okb(["computation", "preview", "computations/revenue-ytd", "--parameters", '{"year":2026}', "--bundle", acme])).code).toBe(1);
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await Promise.all([api.stop(), readonly.stop()]);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
