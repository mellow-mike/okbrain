// Resurface (F-B): pure scorer units, engine v2 review surface, metadata-only
// writes, and the CLI flow on a fixture bundle with a known shape. All
// timestamps are crafted relative to a fixed `now`, so ordering is exact.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EdgeRecord, ReviewRow } from "../src/core/engine/interface.ts";
import { EngineError, openSqliteEngine } from "../src/core/engine/sqlite.ts";
import { writeConcept } from "../src/core/okf/write.ts";
import { defaultReviewConfig, reviewQueue } from "../src/core/review/score.ts";
import { okb } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-07-11T12:00:00Z");
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

const queue = (rows: ReviewRow[], edges: EdgeRecord[] = []) =>
  reviewQueue(rows, edges, NOW, { ...defaultReviewConfig, queueSize: 100 });

describe("scoring signals (pure)", () => {
  // A linked pair isolates staleness: no orphan/hub/neighbor/inbox signal fires.
  const pair = (days: number): [ReviewRow[], EdgeRecord[]] => [
    [row("a", { timestamp: daysAgo(days) }), row("b", { timestamp: daysAgo(days) })],
    [{ src: "a", dst: "b" }],
  ];

  test("staleness scales with age and caps at a year", () => {
    const [rows, edges] = pair(100);
    const [first] = queue(rows, edges);
    expect(first!.score).toBeCloseTo(100 / 365, 5);
    expect(first!.reasons).toEqual(["untouched 3mo"]);
    const [cRows, cEdges] = pair(1000);
    expect(queue(cRows, cEdges)[0]!.score).toBeCloseTo(1.0, 5); // capped, no anniversary
  });

  test("fresh, linked concepts score zero and stay out", () => {
    const [rows, edges] = pair(0);
    expect(queue(rows, edges)).toEqual([]);
  });

  test("orphan fires on degree zero only", () => {
    const rows = [
      row("a", { timestamp: daysAgo(10) }),
      row("b", { timestamp: daysAgo(10) }),
      row("c", { timestamp: daysAgo(10) }),
    ];
    const q = queue(rows, [{ src: "a", dst: "b" }]);
    const c = q.find((i) => i.id === "c")!;
    expect(c.score).toBeCloseTo(10 / 365 + 2.0, 5);
    expect(c.reasons).toContain("orphan for 10d");
    expect(q.find((i) => i.id === "a")!.reasons).toEqual(["untouched 10d"]);
  });

  test("stale hub needs in-degree ≥ 3 and > 90d", () => {
    const rows = [
      row("hub", { timestamp: daysAgo(100) }),
      row("x", { timestamp: daysAgo(100) }),
      row("y", { timestamp: daysAgo(100) }),
      row("z", { timestamp: daysAgo(100) }),
    ];
    const edges = [
      { src: "x", dst: "hub" },
      { src: "y", dst: "hub" },
      { src: "z", dst: "hub" },
    ];
    const q = queue(rows, edges);
    const hub = q.find((i) => i.id === "hub")!;
    expect(hub.reasons).toContain("cited by 3, untouched 3mo");
    expect(hub.score).toBeCloseTo(100 / 365 + 1.5, 5);
  });

  test("neighbor activity: fresh neighbor + stale self", () => {
    const rows = [row("a", { timestamp: daysAgo(45) }), row("b", { timestamp: daysAgo(2) })];
    const q = queue(rows, [{ src: "a", dst: "b" }]);
    const a = q.find((i) => i.id === "a")!;
    expect(a.reasons).toContain("a neighbor changed 2d ago");
    expect(a.score).toBeCloseTo(45 / 365 + 1.0, 5);
    expect(q.find((i) => i.id === "b")!.reasons).toEqual(["untouched 2d"]);
  });

  test("inbox tag and anniversary add their weights", () => {
    const [inbox] = queue([row("a", { timestamp: daysAgo(10), inbox: true })]);
    expect(inbox!.score).toBeCloseTo(10 / 365 + 2.0 + 1.5, 5); // stale + orphan + inbox
    expect(inbox!.reasons).toContain("in inbox");

    const [anni] = queue([row("b", { timestamp: daysAgo(365) })], [{ src: "b", dst: "b2" }]);
    expect(anni!.reasons).toContain("1y today");
    const none = queue([row("c", { timestamp: daysAgo(370) })], [{ src: "c", dst: "c2" }]);
    expect(none[0]!.reasons).not.toContain("1y today");
  });

  test("cooldown and snooze exclude; expiry re-admits", () => {
    const base = { timestamp: daysAgo(200) };
    expect(queue([row("a", { ...base, lastReviewed: daysAgo(5) })])).toEqual([]);
    expect(queue([row("a", { ...base, lastReviewed: daysAgo(40) })])).toHaveLength(1);
    expect(queue([row("a", { ...base, snoozeUntil: daysAgo(-3) })])).toEqual([]);
    expect(queue([row("a", { ...base, snoozeUntil: daysAgo(1) })])).toHaveLength(1);
  });

  test("unknown timestamp: no staleness reason, orphan still fires", () => {
    const [it] = queue([row("a", { timestamp: null })]);
    expect(it!.score).toBe(2.0);
    expect(it!.reasons).toEqual(["orphan"]);
  });

  test("deterministic order: score desc, then older timestamp, then id", () => {
    const tied = [
      row("b", { timestamp: daysAgo(60) }),
      row("a", { timestamp: daysAgo(60) }),
      row("mid", { timestamp: daysAgo(55) }),
      row("newer", { timestamp: daysAgo(50) }),
    ];
    // Equal scores (all orphans, same weights differ only by staleness):
    // older timestamp first; exact ties fall back to id.
    expect(queue(tied).map((i) => i.id)).toEqual(["a", "b", "mid", "newer"]);
  });

  test("queueSize truncates after ranking", () => {
    const rows = [
      row("a", { timestamp: daysAgo(300) }),
      row("b", { timestamp: daysAgo(200) }),
      row("c", { timestamp: daysAgo(100) }),
    ];
    const top = reviewQueue(rows, [], NOW, { ...defaultReviewConfig, queueSize: 2 });
    expect(top.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("engine v2 review surface", () => {
  test("listReviewRows joins tags and snooze; clear/remove drop state", () => {
    const eng = openSqliteEngine(":memory:");
    const node = {
      id: "n",
      type: "note",
      title: "N",
      description: "",
      resource: null,
      timestamp: daysAgo(10),
      lastReviewed: daysAgo(3),
      bodyLen: 1,
      contentHash: "h",
      body: "x",
      tags: ["inbox", "other"],
    };
    eng.upsertNode(node);
    eng.setSnooze("n", daysAgo(-5));
    expect(eng.listReviewRows()).toEqual([
      {
        id: "n",
        type: "note",
        title: "N",
        timestamp: daysAgo(10),
        lastReviewed: daysAgo(3),
        inbox: true,
        snoozeUntil: daysAgo(-5),
      },
    ]);
    eng.clearSnooze("n");
    expect(eng.listReviewRows()[0]!.snoozeUntil).toBeNull();
    eng.setSnooze("n", daysAgo(-5));
    eng.removeNode("n");
    expect(eng.listReviewRows()).toEqual([]);
    eng.close();
  });

  test("stale schema: data methods refuse, wipe() repairs (rebuild path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okb-schema-"));
    const db = join(dir, "index.db");
    try {
      openSqliteEngine(db).close(); // current schema
      const raw = new Database(db);
      raw.exec("PRAGMA user_version = 1"); // pretend it's from an older okb
      raw.close();

      const eng = openSqliteEngine(db);
      expect(() => eng.search("x")).toThrow(EngineError);
      expect(() => eng.search("x")).toThrow(/okb rebuild/);
      eng.wipe(); // what `okb rebuild` runs
      expect(eng.search("x")).toEqual([]);
      eng.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("metadata-only writes", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-meta-"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("keeps timestamp, skips log.md, preserves unknown keys", async () => {
    await writeConcept(root, {
      id: "notes/keep",
      type: "note",
      title: "Keep",
      description: "d",
      body: "b",
      extra: { custom: "kept" },
    });
    const before = await readFile(join(root, "notes", "keep.md"), "utf8");
    const log = await readFile(join(root, "log.md"), "utf8");

    await writeConcept(root, {
      id: "notes/keep",
      extra: { last_reviewed: "2026-07-11T09:00:00Z" },
      metadataOnly: true,
    });
    const after = await readFile(join(root, "notes", "keep.md"), "utf8");
    expect(after).toContain(before.match(/timestamp: .*/)![0]); // unchanged
    expect(after).toContain("last_reviewed: 2026-07-11T09:00:00Z");
    expect(after).toContain("custom: kept");
    expect(await readFile(join(root, "log.md"), "utf8")).toBe(log); // no new entry
  });

  test("requires an existing concept", async () => {
    await expect(
      writeConcept(root, { id: "notes/ghost", metadataOnly: true }),
    ).rejects.toThrow(/requires an existing concept/);
  });
});

describe("okb review (CLI on a fixture bundle)", () => {
  let root: string;
  const at = (id: string) => join(root, ...id.split("/")) + ".md";
  const concept = (title: string, ts: string, body = "Body.", tags = ""): string =>
    `---\ntype: note\ntitle: ${title}\ndescription: d\ntimestamp: ${ts}\n${tags}---\n${body}\n`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-review-"));
    await mkdir(join(root, "hubs"), { recursive: true });
    await mkdir(join(root, "orphans"), { recursive: true });
    await mkdir(join(root, "inbox"), { recursive: true });
    // hub: 400d old, cited by three fresh notes → staleness 1.0 + hub 1.5 + neighbor 1.0 = 3.5
    await writeFile(at("hubs/hub"), concept("Hub", daysAgo(400)), "utf8");
    for (const n of ["a", "b", "c"])
      await writeFile(
        at(n),
        concept(n.toUpperCase(), daysAgo(0), `Links [hub](/hubs/hub.md).`),
        "utf8",
      );
    // lonely orphan: 200d → 200/365 + 2.0 ≈ 2.548
    await writeFile(at("orphans/lonely"), concept("Lonely", daysAgo(200)), "utf8");
    // inbox clip: 40d, orphan, tagged inbox → 40/365 + 2.0 + 1.5 ≈ 3.61
    await writeFile(
      at("inbox/clip"),
      concept("Clip", daysAgo(40), "Body.", "tags:\n  - inbox\n"),
      "utf8",
    );
    expect((await okb(["index", "--bundle", root])).code).toBe(0);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("queue is ordered with reasons; fresh linked notes stay out", async () => {
    const r = await okb(["review", "--json", "--bundle", root]);
    expect(r.code).toBe(0);
    const q = JSON.parse(r.stdout) as { id: string; reasons: string[] }[];
    expect(q.map((i) => i.id)).toEqual(["inbox/clip", "hubs/hub", "orphans/lonely"]);
    expect(q[0]!.reasons).toContain("in inbox");
    expect(q[1]!.reasons).toContain("cited by 3, untouched 13mo");
    expect(q[2]!.reasons.join()).toContain("orphan");

    const human = await okb(["review", "--bundle", root]);
    expect(human.stdout).toMatch(/^1\. inbox\/clip — Clip \(3\.61\)/);
  });

  test("done by position stamps last_reviewed without touching content", async () => {
    const before = await readFile(at("orphans/lonely"), "utf8");
    const r = await okb(["review", "done", "3", "--bundle", root]); // position 3 = lonely
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("reviewed orphans/lonely");

    const after = await readFile(at("orphans/lonely"), "utf8");
    expect(after).toContain(`timestamp: ${daysAgo(200)}`); // content timestamp kept
    expect(after).toMatch(/last_reviewed: \d{4}-/);
    expect((await okb(["doctor", "--bundle", root])).code).toBe(0);

    // Out of the queue for the cooldown; log.md untouched by the stamp.
    const q = JSON.parse((await okb(["review", "--json", "--bundle", root])).stdout);
    expect(q.map((i: { id: string }) => i.id)).toEqual(["inbox/clip", "hubs/hub"]);
    expect(before).not.toContain("last_reviewed");
  });

  test("snooze hides; rebuild forgets the snooze but keeps last_reviewed", async () => {
    const r = await okb(["review", "snooze", "hubs/hub", "--days", "3", "--bundle", root]);
    expect(r.code).toBe(0);
    let q = JSON.parse((await okb(["review", "--json", "--bundle", root])).stdout);
    expect(q.map((i: { id: string }) => i.id)).toEqual(["inbox/clip"]);

    expect(
      (await okb(["rebuild", "--confirm-destructive", "--bundle", root])).code,
    ).toBe(0);
    q = JSON.parse((await okb(["review", "--json", "--bundle", root])).stdout);
    expect(q.map((i: { id: string }) => i.id)).toEqual(["inbox/clip", "hubs/hub"]); // snooze gone
    // lonely still cooled down: last_reviewed lives in the bundle.
    expect(q.map((i: { id: string }) => i.id)).not.toContain("orphans/lonely");
  });

  test("done with an unknown id is not_found; snooze validates days", async () => {
    const r = await okb(["review", "done", "nope/none", "--bundle", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not in index");
    const bad = await okb(["review", "snooze", "1", "--days", "0", "--bundle", root]);
    expect(bad.code).toBe(2);
  });

  test("two-word commands get their own help", async () => {
    const r = await okb(["help", "review", "done"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: okb review done <id>");
  });
});
