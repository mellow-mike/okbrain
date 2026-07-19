import { afterAll, describe, expect, test } from "bun:test";
import type { Engine, NodeUpsert } from "../src/core/engine/interface.ts";
import { openSqliteEngine, toMatchExpr } from "../src/core/engine/sqlite.ts";

function node(id: string, over: Partial<NodeUpsert> = {}): NodeUpsert {
  return {
    id,
    type: "note",
    title: id,
    description: "",
    resource: null,
    timestamp: null,
    lastReviewed: null,
    bodyLen: 0,
    contentHash: `hash-${id}`,
    body: "",
    tags: [],
    ...over,
  };
}

const engine: Engine = openSqliteEngine(":memory:");
afterAll(() => engine.close());

describe("nodes + tags", () => {
  test("upsert inserts, then updates in place", () => {
    engine.upsertNode(node("a", { title: "Alpha", tags: ["x", "y"] }));
    expect(engine.getNode("a")?.title).toBe("Alpha");
    expect(engine.getTags("a")).toEqual(["x", "y"]);

    engine.upsertNode(node("a", { title: "Alpha2", contentHash: "h2", tags: ["z"] }));
    expect(engine.getNode("a")).toMatchObject({ title: "Alpha2", contentHash: "h2" });
    expect(engine.getTags("a")).toEqual(["z"]);
  });

  test("removeNode drops node, tags, fts row, and incident edges", () => {
    engine.upsertNode(node("gone", { title: "unique-marker", tags: ["t"] }));
    engine.upsertNode(node("stays"));
    engine.replaceEdges([
      { src: "gone", dst: "stays", rel: null },
      { src: "stays", dst: "gone", rel: null },
    ]);
    engine.removeNode("gone");
    expect(engine.getNode("gone")).toBeNull();
    expect(engine.getTags("gone")).toEqual([]);
    expect(engine.listEdges()).toEqual([]);
    expect(engine.search("unique-marker")).toEqual([]);
  });

  test("contentHashes maps every indexed node", () => {
    expect(engine.contentHashes().get("a")).toBe("h2");
  });
});

describe("search (FTS5/BM25)", () => {
  test("matches across title, body, and tags", () => {
    engine.upsertNode(node("t", { title: "quantum computing", body: "intro" }));
    engine.upsertNode(node("b", { body: "notes about quantum stuff" }));
    engine.upsertNode(node("g", { tags: ["quantum"] }));

    const hits = engine.search("quantum");
    expect(new Set(hits.map((h) => h.id))).toEqual(new Set(["t", "b", "g"]));
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
  });

  test("title match outranks body match", () => {
    const e = openSqliteEngine(":memory:");
    e.upsertNode(node("title-hit", { title: "quantum computing", body: "intro notes" }));
    e.upsertNode(node("body-hit", { title: "misc notes", body: "about quantum stuff" }));
    expect(e.search("quantum").map((h) => h.id)).toEqual(["title-hit", "body-hit"]);
    e.close();
  });

  test("FTS5 operator characters in the query are neutralized", () => {
    expect(() => engine.search('quantum" OR NEAR(')).not.toThrow();
    expect(engine.search("")).toEqual([]);
  });

  test("toMatchExpr quotes each term", () => {
    expect(toMatchExpr('foo bar"baz')).toBe('"foo" "bar""baz"');
  });

  test("limit caps results", () => {
    expect(engine.search("quantum", 1)).toHaveLength(1);
  });
});

describe("neighbors (depth-bounded CTE)", () => {
  test("depth 1 covers out-links and backlinks; depth 2 expands; origin excluded", () => {
    const e = openSqliteEngine(":memory:");
    for (const id of ["a", "b", "c", "d"]) e.upsertNode(node(id));
    // a -> b -> c, d -> a
    e.replaceEdges([
      { src: "a", dst: "b", rel: null },
      { src: "b", dst: "c", rel: null },
      { src: "d", dst: "a", rel: null },
    ]);
    expect(e.neighbors("a")).toEqual([
      { id: "b", depth: 1 },
      { id: "d", depth: 1 },
    ]);
    expect(e.neighbors("a", 2)).toEqual([
      { id: "b", depth: 1 },
      { id: "d", depth: 1 },
      { id: "c", depth: 2 },
    ]);
    expect(e.neighbors("missing")).toEqual([]);
    e.close();
  });

  test("cycles terminate and report minimum depth", () => {
    const e = openSqliteEngine(":memory:");
    for (const id of ["a", "b"]) e.upsertNode(node(id));
    e.replaceEdges([
      { src: "a", dst: "b", rel: null },
      { src: "b", dst: "a", rel: null },
    ]);
    expect(e.neighbors("a", 5)).toEqual([{ id: "b", depth: 1 }]);
    e.close();
  });
});

describe("wipe", () => {
  test("clears all derived state", () => {
    engine.wipe();
    expect(engine.contentHashes().size).toBe(0);
    expect(engine.listEdges()).toEqual([]);
    expect(engine.search("quantum")).toEqual([]);
  });
});
