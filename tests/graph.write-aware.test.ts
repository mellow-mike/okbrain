// Stage 1.4 write-aware graph: dangling-edge storage + incremental index
// update on write, path/orphan queries, and the direction-tagged `okb graph`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { buildIndex } from "../src/core/engine/index-build.ts";
import { defaultDbPath, openSqliteEngine } from "../src/core/engine/sqlite.ts";
import { orphans, shortestPath } from "../src/core/graph/queries.ts";
import type { EdgeRecord } from "../src/core/engine/interface.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-graph14-"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function okb(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...args, "--bundle", root], {
    out: (t) => void (stdout += t),
    err: (t) => void (stderr += t),
  });
  return { code, stdout, stderr };
}

const write = (id: string, title: string, body: string) =>
  okb("write", id, "--type", "note", "--title", title, "--description", "d", "--body", body);

describe("shortestPath / orphans (pure)", () => {
  const edges: EdgeRecord[] = [
    { src: "a", dst: "b" },
    { src: "c", dst: "b" }, // a-b-c only connects against link direction
    { src: "c", dst: "d" },
  ];

  test("finds the shortest undirected path inclusive of endpoints", () => {
    expect(shortestPath(edges, "a", "d")).toEqual(["a", "b", "c", "d"]);
    expect(shortestPath(edges, "a", "a")).toEqual(["a"]);
  });

  test("respects the hop limit and reports unreachable as null", () => {
    expect(shortestPath(edges, "a", "d", 2)).toBeNull();
    expect(shortestPath(edges, "a", "x")).toBeNull();
  });

  test("orphans are ids untouched by any edge", () => {
    expect(orphans(["a", "b", "lone"], edges)).toEqual(["lone"]);
  });
});

describe("engine: dangling edges", () => {
  test("stored but invisible until the target exists; never walked through", async () => {
    const eng = openSqliteEngine(":memory:");
    await write("a", "A", "[x](/ghost.md) and [b](/b.md)");
    await write("b", "B", "[x](/ghost.md)");
    await buildIndex(root, eng);
    // ghost doesn't exist: edge hidden, and a→ghost→b must not fake a depth-2 route
    expect(eng.listEdges()).toEqual([{ src: "a", dst: "b" }]);
    expect(eng.neighbors("a", 5)).toEqual([{ id: "b", depth: 1 }]);
    eng.close();
  });
});

describe("incremental index update on write", () => {
  test("a write with an existing index is searchable and linked without okb index", async () => {
    await write("a", "Alpha", "plain");
    await okb("index");
    await write("b", "Brandnew", "See [a](/a.md).");
    const search = await okb("search", "Brandnew", "--json");
    const hits = JSON.parse(search.stdout) as { id: string; sources: string[] }[];
    expect(hits[0]).toMatchObject({ id: "b", sources: ["keyword"] });
    // hybrid graph expansion also surfaces the concept b links to
    expect(hits.some((h) => h.id === "a" && h.sources.includes("graph"))).toBe(true);
    const graph = await okb("graph", "a");
    expect(graph.stdout).toBe("1 ← b — Brandnew\n");
  });

  test("writing a concept resolves pre-existing dangling links to it (backlinks appear)", async () => {
    await write("a", "Alpha", "cites [future](/future.md)");
    await okb("index");
    expect((await okb("graph", "a")).stdout).toBe("(no neighbors)\n");
    await write("future", "Future", "now real");
    expect((await okb("graph", "future")).stdout).toBe("1 ← a — Alpha\n");
  });

  test("a write without an existing index does not create one", async () => {
    await write("a", "Alpha", "plain");
    expect(existsSync(defaultDbPath(root))).toBe(false);
  });

  test("import refreshes the index for every imported concept", async () => {
    await write("hub", "Hub", "plain");
    await okb("index");
    const src = await mkdtemp(join(tmpdir(), "okb-graph14-src-"));
    try {
      await Bun.write(join(src, "spoke.md"), "# Spoke\n\nlinks [hub](/hub.md)\n");
      await okb("import", src);
      expect((await okb("graph", "hub")).stdout).toBe("1 ← spoke — Spoke\n");
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });
});

describe("okb path / okb orphans", () => {
  beforeEach(async () => {
    await write("a", "A", "[b](/b.md)");
    await write("b", "B", "");
    await write("c", "C", "[b](/b.md)"); // reaching c from a goes against this link
    await write("lone", "Lone", "no links");
    await okb("index");
  });

  test("path renders per-hop directions and exits 0", async () => {
    const r = await okb("path", "a", "c");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("a → b ← c\n");
  });

  test("no path (or over the hop limit) renders a message and exits 1", async () => {
    expect(await okb("path", "a", "lone")).toMatchObject({ code: 1, stdout: "(no path)\n" });
    expect((await okb("path", "a", "c", "--max-depth", "1")).code).toBe(1);
  });

  test("path with an unindexed endpoint is not_found", async () => {
    const r = await okb("path", "a", "ghost");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not in index");
  });

  test("orphans lists only unlinked concepts", async () => {
    const r = await okb("orphans");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("lone — Lone\n");
  });
});
