// Stage-0 acceptance (ROADMAP 0.8): drive the real CLI end-to-end over the
// checked-in example bundle — index → search → read → list → graph → doctor →
// export-viz → rebuild. Runs against a temp copy so derived artifacts
// (.okb/, viz.html) never land in the repo bundle.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okb } from "./helpers.ts";

const EXAMPLE = join(import.meta.dir, "..", "bundles", "example");
const CONCEPTS = ["concepts/knowledge-graph", "concepts/local-first", "concepts/okf", "okbrain"];

let root: string;
const at = (...args: string[]) => okb([...args, "--bundle", root]);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-accept-"));
  await cp(EXAMPLE, root, { recursive: true });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("Stage-0 acceptance on bundles/example", () => {
  test("the checked-in bundle is fully conformant — zero errors, zero warnings", async () => {
    const r = await okb(["doctor", "--bundle", EXAMPLE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("ok — 7 files, 4 concepts, 0 errors, 0 warnings\n");
  });

  test("index builds the full graph; a second run skips everything", async () => {
    expect((await at("index")).stdout).toBe("indexed 4, skipped 0, removed 0, edges 8\n");
    expect((await at("index")).stdout).toBe("indexed 0, skipped 4, removed 0, edges 8\n");
  });

  test("list shows every concept", async () => {
    const r = await at("list");
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(CONCEPTS);
  });

  test("search finds concepts by keyword", async () => {
    const r = await at("search", "graph", "--json");
    expect(r.code).toBe(0);
    const ids = (JSON.parse(r.stdout) as { id: string }[]).map((h) => h.id);
    expect(ids).toContain("concepts/knowledge-graph");
  });

  test("read returns the raw concept", async () => {
    const r = await at("read", "concepts/okf");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("title: Open Knowledge Format");
    expect(r.stdout).toContain("# Citations");
  });

  test("graph walks links + backlinks from the project hub", async () => {
    const r = await at("graph", "okbrain");
    expect(r.code).toBe(0);
    for (const id of ["concepts/okf", "concepts/knowledge-graph", "concepts/local-first"])
      expect(r.stdout).toContain(`1  ${id} — `);
  });

  test("export-viz writes a self-contained viewer with the whole graph", async () => {
    const r = await at("export-viz");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(4 concepts, 8 links)");
    const html = await readFile(join(root, "viz.html"), "utf8");
    for (const id of CONCEPTS) expect(html).toContain(id);
  });

  test("rebuild regenerates the identical derived state", async () => {
    const r = await at("rebuild", "--confirm-destructive");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("indexed 4, skipped 0, removed 0, edges 8\n");
  });
});
