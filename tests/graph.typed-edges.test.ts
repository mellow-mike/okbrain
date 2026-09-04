// Typed edges (4.3): deterministic relation classification (sentence clause
// wins, else nearest heading, else null), rel storage in the engine, the
// relational retrieval arm (no-op for non-relational queries), and its
// surfacing through hybrid retrieval.

import { describe, expect, test } from "bun:test";
import { openSqliteEngine } from "../src/core/engine/sqlite.ts";
import type { Engine, NodeUpsert } from "../src/core/engine/interface.ts";
import { classifyTargets } from "../src/core/graph/typed-edges.ts";
import { relationalRanking } from "../src/core/retrieval/relational.ts";
import { hybridRetrieve } from "../src/core/retrieval/hybrid.ts";
import { PROFILES } from "../src/core/retrieval/profiles.ts";

describe("classifyTargets", () => {
  test("nearest heading types the links under it", () => {
    const body = [
      "Intro with a [plain link](/a.md).",
      "",
      "# Citations",
      "",
      "- [Source one](/refs/one.md)",
      "- [Source two](/refs/two.md)",
      "",
      "# Unrelated Heading",
      "",
      "[after](/b.md)",
    ].join("\n");
    expect(classifyTargets("notes/x", body)).toEqual([
      { dst: "a", rel: null },
      { dst: "refs/one", rel: "cites" },
      { dst: "refs/two", rel: "cites" },
      { dst: "b", rel: null }, // unknown heading = untyped, not inherited
    ]);
  });

  test("sentence clause beats the heading; articles tolerated", () => {
    const body = [
      "# Citations",
      "",
      "This service depends on the [queue](/infra/queue.md).",
      "Alice works at [Acme](/orgs/acme.md), part of [Mega](/orgs/mega.md).",
    ].join("\n");
    expect(classifyTargets("notes/x", body)).toEqual([
      { dst: "infra/queue", rel: "depends-on" },
      { dst: "orgs/acme", rel: "works-at" },
      { dst: "orgs/mega", rel: "part-of" },
    ]);
  });

  test("first occurrence wins on duplicate targets (matches edge dedupe)", () => {
    const body = "See [x](/x.md).\n\n# Citations\n\n- [x again](/x.md)\n";
    expect(classifyTargets("notes/y", body)).toEqual([{ dst: "x", rel: null }]);
  });

  test("joins-with and see-also headings map per the vocabulary", () => {
    const body = "# Joins\n\n[orders](/tables/orders.md)\n\n# See also\n\n[related](/z.md)\n";
    expect(classifyTargets("tables/users", body)).toEqual([
      { dst: "tables/orders", rel: "joins-with" },
      { dst: "z", rel: "related-to" },
    ]);
  });
});

const node = (id: string, title: string, body = ""): NodeUpsert => ({
  id,
  type: "note",
  title,
  description: "",
  resource: null,
  timestamp: null,
  lastReviewed: null,
  status: "stable", staleAfter: null, trust: "unverified",
  bodyLen: body.length,
  contentHash: id,
  body,
  tags: [],
});

function fixtureEngine(): Engine {
  const e = openSqliteEngine(":memory:");
  e.upsertNode(node("projects/atlas", "Project Atlas", "the atlas project"));
  e.upsertNode(node("refs/paper", "Atlas Paper", "a paper"));
  e.upsertNode(node("infra/queue", "Queue", "queueing"));
  e.replaceEdges([
    { src: "refs/paper", dst: "projects/atlas", rel: "cites" },
    { src: "projects/atlas", dst: "infra/queue", rel: "depends-on" },
  ]);
  return e;
}

describe("engine stores rel", () => {
  test("listEdges round-trips rel; replaceEdgesFor too", () => {
    const e = fixtureEngine();
    expect(e.listEdges()).toEqual([
      { src: "projects/atlas", dst: "infra/queue", rel: "depends-on" },
      { src: "refs/paper", dst: "projects/atlas", rel: "cites" },
    ]);
    e.replaceEdgesFor("refs/paper", [{ dst: "projects/atlas", rel: null }]);
    expect(e.listEdges().find((x) => x.src === "refs/paper")!.rel).toBeNull();
    e.close();
  });
});

describe("relationalRanking", () => {
  test("'what cites X' → inbound cites edges of the anchor", () => {
    const e = fixtureEngine();
    const r = relationalRanking("what cites project atlas", e);
    expect(r).not.toBeNull();
    expect(r!.rel).toBe("cites");
    expect(r!.anchor).toBe("projects/atlas");
    expect(r!.ranking).toEqual(["refs/paper"]);
    e.close();
  });

  test("'atlas depends on' → outbound depends-on edges", () => {
    const e = fixtureEngine();
    const r = relationalRanking("what does project atlas depend on", e);
    expect(r).not.toBeNull();
    expect(r!.rel).toBe("depends-on");
    expect(r!.ranking).toEqual(["infra/queue"]);
    e.close();
  });

  test("no-ops: no relation phrase, no anchor hit, no edges of that rel", () => {
    const e = fixtureEngine();
    expect(relationalRanking("weather tomorrow", e)).toBeNull();
    expect(relationalRanking("what cites zzz-nonexistent", e)).toBeNull();
    expect(relationalRanking("queue contradicts", e)).toBeNull(); // rel unused in graph
    expect(relationalRanking("cites", e)).toBeNull(); // nothing left to anchor on
    e.close();
  });
});

describe("hybrid integration", () => {
  test("relational hits join fusion tagged 'relational'", async () => {
    const e = fixtureEngine();
    const { hits } = await hybridRetrieve(
      ["what cites project atlas"],
      { engine: e },
      PROFILES.lean!,
      10,
    );
    const paper = hits.find((h) => h.id === "refs/paper");
    expect(paper).toBeDefined();
    expect(paper!.sources).toContain("relational");
    e.close();
  });

  test("non-relational queries fuse exactly as before (no-op arm)", async () => {
    const e = fixtureEngine();
    const { hits } = await hybridRetrieve(["queueing"], { engine: e }, PROFILES.lean!, 10);
    expect(hits.every((h) => !h.sources.includes("relational"))).toBe(true);
    e.close();
  });
});
