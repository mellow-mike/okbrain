// Stage-0 acceptance: the whole spine, end to end, through the real CLI
// against a copy of the shipped example bundle — index → search → read →
// graph → doctor → export-viz → rebuild.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import type { VizGraph } from "../src/core/viz/export.ts";

const EXAMPLE = join(import.meta.dir, "..", "bundles", "example");
let root: string;

async function okb(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...args, "--bundle", root], {
    out: (t) => void (stdout += t),
    err: (t) => void (stderr += t),
  });
  return { code, stdout, stderr };
}

const json = <T>(r: { stdout: string }): T => JSON.parse(r.stdout) as T;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-e2e-"));
  await cp(EXAMPLE, root, { recursive: true });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("stage-0 acceptance on bundles/example", () => {
  test("doctor: the shipped bundle is fully conformant (no warnings either)", async () => {
    const r = await okb("doctor", "--json");
    expect(r.code).toBe(0);
    expect(json<{ ok: boolean; concepts: number; errors: number; warnings: number }>(r)).toMatchObject(
      { ok: true, concepts: 4, errors: 0, warnings: 0 },
    );
  });

  test("index: 4 concepts, 7 edges", async () => {
    const r = await okb("index", "--json");
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ indexed: 4, skipped: 0, removed: 0, edges: 7 });
  });

  test("search: finds the linked-atomic-notes note", async () => {
    const r = await okb("search", "atomic", "--json");
    expect(r.code).toBe(0);
    expect(json<{ id: string }[]>(r).map((h) => h.id)).toContain("notes/zettelkasten");
  });

  test("read: returns the raw concept", async () => {
    const r = await okb("read", "projects/okbrain");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("type: project");
    expect(r.stdout).toContain("# okbrain");
  });

  test("graph: zettelkasten's 1-hop neighborhood (links + backlinks)", async () => {
    const r = await okb("graph", "notes/zettelkasten", "--json");
    expect(r.code).toBe(0);
    expect(json<{ id: string }[]>(r).map((n) => n.id).sort()).toEqual([
      "notes/evergreen-notes",
      "projects/okbrain",
      "references/open-knowledge-format",
    ]);
  });

  test("export-viz: viz.html carries the same graph", async () => {
    const r = await okb("export-viz", "--json");
    expect(r.code).toBe(0);
    const html = await readFile(join(root, "viz.html"), "utf8");
    const data = /<script id="okb-graph"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const g = JSON.parse(data) as VizGraph;
    expect(g.nodes.length).toBe(4);
    expect(g.edges.length).toBe(7);
    // internal links rewired for in-viewer navigation
    expect(g.nodes.find((n) => n.id === "notes/zettelkasten")!.body).toContain(
      "(#concept:notes%2Fevergreen-notes)",
    );
  });

  test("rebuild: wipe + reindex reproduces identical derived state", async () => {
    const r = await okb("rebuild", "--confirm-destructive", "--json");
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ indexed: 4, edges: 7 });
    expect(existsSync(join(root, ".okb", "index.db"))).toBe(true);
    const g = await okb("graph", "notes/zettelkasten", "--json");
    expect(json<unknown[]>(g).length).toBe(3);
  });
});
