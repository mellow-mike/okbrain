// `okb stats`: pure aggregation units over crafted engine rows, plus a CLI
// e2e that indexes a small bundle and reads the JSON snapshot back.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EdgeRecord, ReviewRow } from "../src/core/engine/interface.ts";
import { writeConcept } from "../src/core/okf/write.ts";
import { computeStats, type TagCount } from "../src/core/stats.ts";
import { okb } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-07-22T12:00:00Z");
const daysAgo = (d: number): string =>
  new Date(NOW.getTime() - d * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

const row = (id: string, over: Partial<ReviewRow> = {}): ReviewRow => ({
  id,
  type: "note",
  title: id,
  timestamp: daysAgo(0),
  lastReviewed: null,
  inbox: false,
  snoozeUntil: null,
  ...over,
});

describe("computeStats (pure)", () => {
  test("counts concepts, types, edges, tags, and orphans", () => {
    const rows = [
      row("notes/a"),
      row("notes/b"),
      row("refs/r", { type: "reference" }),
    ];
    const edges: EdgeRecord[] = [
      { src: "notes/a", dst: "notes/b", rel: null },
      { src: "notes/a", dst: "refs/r", rel: "cites" },
    ];
    const tags: TagCount[] = [
      { tag: "core", count: 3 },
      { tag: "inbox", count: 1 },
    ];
    const s = computeStats(rows, edges, tags, NOW);
    expect(s.concepts).toBe(3);
    expect(s.edges).toBe(2);
    expect(s.typedEdges).toBe(1);
    expect(s.tags).toBe(2);
    // note 2, reference 1 — most common first.
    expect(s.byType).toEqual([
      { type: "note", count: 2 },
      { type: "reference", count: 1 },
    ]);
    // core (3) beats inbox (1).
    expect(s.topTags[0]).toEqual({ tag: "core", count: 3 });
    expect(s.orphans).toBe(0); // every concept touches an edge
  });

  test("orphans, inbox, and never-reviewed are counted", () => {
    const rows = [
      row("a", { lastReviewed: daysAgo(1) }),
      row("b", { inbox: true }),
      row("lonely"),
    ];
    const edges: EdgeRecord[] = [{ src: "a", dst: "b", rel: null }];
    const s = computeStats(rows, edges, [], NOW);
    expect(s.orphans).toBe(1); // only "lonely" has no edge
    expect(s.inbox).toBe(1);
    expect(s.neverReviewed).toBe(2); // b and lonely never reviewed
  });

  test("freshness: oldest/newest and the stale window", () => {
    const rows = [
      row("fresh", { timestamp: daysAgo(1) }),
      row("mid", { timestamp: daysAgo(100) }),
      row("ancient", { timestamp: daysAgo(400) }),
      row("undated", { timestamp: null }),
    ];
    const s = computeStats(rows, [], [], NOW, { staleDays: 180 });
    expect(s.newest).toBe(daysAgo(1));
    expect(s.oldest).toBe(daysAgo(400));
    expect(s.stale).toBe(1); // only "ancient" (>180d); "undated" never counts
    expect(s.staleDays).toBe(180);
  });

  test("topTags is capped and empty bundles report zeros", () => {
    const many: TagCount[] = Array.from({ length: 15 }, (_, i) => ({
      tag: `t${String(i).padStart(2, "0")}`,
      count: 15 - i,
    }));
    expect(computeStats([row("a")], [], many, NOW, { topTags: 3 }).topTags).toHaveLength(3);
    const empty = computeStats([], [], [], NOW);
    expect(empty).toMatchObject({ concepts: 0, edges: 0, tags: 0, orphans: 0, newest: null, oldest: null });
  });
});

describe("okb stats (CLI)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-stats-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test("indexes a bundle and reports its shape as JSON", async () => {
    await writeConcept(root, {
      id: "notes/a", type: "note", title: "A", description: "d",
      tags: ["core"], body: "See [b](/notes/b.md).",
    });
    await writeConcept(root, { id: "notes/b", type: "note", title: "B", description: "d", tags: ["core"] });
    await writeConcept(root, { id: "refs/r", type: "reference", title: "R", description: "src" });
    expect((await okb(["index", "--bundle", root])).code).toBe(0);

    const r = await okb(["stats", "--json", "--bundle", root]);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.concepts).toBe(3);
    expect(s.edges).toBe(1); // a → b
    expect(s.byType).toEqual([
      { type: "note", count: 2 },
      { type: "reference", count: 1 },
    ]);
    expect(s.topTags).toEqual([{ tag: "core", count: 2 }]);
    expect(s.orphans).toBe(1); // refs/r links to nothing

    // Human render mentions the headline counts.
    const human = await okb(["stats", "--bundle", root]);
    expect(human.stdout).toContain("3 concepts, 1 links");
  });

  test("requires an index (never silently creates an empty one)", async () => {
    await writeConcept(root, { id: "notes/a", type: "note", title: "A", description: "d" });
    const r = await okb(["stats", "--bundle", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("okb index");
  });
});
