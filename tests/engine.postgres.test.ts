import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { hasPostgresIndex, openPostgresEngine } from "../src/core/engine/postgres.ts";
import type { IndexEngine, NodeUpsert } from "../src/core/engine/interface.ts";
import { openSqliteEngine } from "../src/core/engine/sqlite.ts";

const postgresUrl = process.env.OKB_TEST_POSTGRES_URL;
const integration = test.skipIf(!postgresUrl);
const namespace = () => `okb_${randomUUID().replaceAll("-", "")}`;

const node = (id: string, fields: Partial<NodeUpsert> = {}): NodeUpsert => ({
  id, type: "note", title: id, description: "A fixture concept", resource: null,
  timestamp: "2026-11-20T00:00:00Z", lastReviewed: null, status: "stable", staleAfter: null,
  trust: "unverified", bodyLen: 0, contentHash: `hash-${id}`, body: "", tags: [], ...fields,
});

async function seed(engine: IndexEngine): Promise<void> {
  await engine.upsertNode(node("notes/orchid", { title: "Garden orchid", tags: ["plants", "inbox", "plants"],
    body: "An orchid shares the garden with a violet.", resource: "https://example.test/plant" }));
  await engine.upsertNode(node("notes/care", { title: "Weekly note", tags: ["plants"], body: "Water the orchid in the garden." }));
  await engine.upsertNode(node("notes/violet", { title: "Garden violet", body: "Observe the small flowers." }));
  await engine.replaceEdges([
    { src: "notes/orchid", dst: "notes/care", rel: "cites" },
    { src: "notes/orchid", dst: "notes/care", rel: "ignored duplicate" },
    { src: "notes/orchid", dst: "notes/future", rel: null },
    { src: "notes/care", dst: "notes/violet", rel: "extends" },
    { src: "notes/violet", dst: "notes/orchid", rel: null },
  ]);
  await engine.setSnooze("notes/orchid", "2026-11-29T00:00:00Z");
}

integration("PostgreSQL matches the SQLite index contract and uses structured keyword excerpts", async () => {
  const sql = new SQL(postgresUrl!);
  const schema = namespace();
  const sqlite = openSqliteEngine(":memory:");
  try {
    expect(await hasPostgresIndex(sql, schema)).toBe(false);
    await expect(openPostgresEngine(sql, schema, false)).rejects.toThrow(/run `okb index`/);
    const [engine] = await Promise.all([openPostgresEngine(sql, schema, true), openPostgresEngine(sql, schema, true)]);
    await Promise.all([seed(sqlite), seed(engine)]);
    expect(await engine.listNodeIds()).toEqual(sqlite.listNodeIds());
    expect(await engine.getNode("notes/orchid")).toEqual(sqlite.getNode("notes/orchid"));
    expect(await engine.getNode("absent")).toBeNull();
    expect(await engine.hasNode("notes/care")).toBe(true);
    expect(await engine.contentHashes()).toEqual(sqlite.contentHashes());
    expect(await engine.getTags("notes/orchid")).toEqual(sqlite.getTags("notes/orchid"));
    expect(await engine.listTags()).toEqual(sqlite.listTags());
    expect(await engine.tagCounts()).toEqual(sqlite.tagCounts());
    expect(await engine.listLinkCandidates(["plants", "inbox"])).toEqual(sqlite.listLinkCandidates(["plants", "inbox"]));
    expect(await engine.listReviewRows()).toEqual(sqlite.listReviewRows());
    expect(await engine.listResources()).toEqual(sqlite.listResources());
    expect(await engine.listEdges()).toEqual(sqlite.listEdges());
    expect(await engine.edgesOf("notes/orchid")).toEqual(sqlite.edgesOf("notes/orchid"));
    expect(await engine.focusEdges("notes/orchid", 1)).toEqual(sqlite.focusEdges("notes/orchid", 1));
    expect(await engine.neighbors("notes/orchid", 4)).toEqual(sqlite.neighbors("notes/orchid", 4));

    const hits = await engine.search("garden orchid", 4, true);
    expect(hits.map(({ id }) => id)).toEqual(sqlite.search("garden orchid", 4).map(({ id }) => id));
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(hits[0]?.keywordExcerpt?.some(({ text, match }) => match && /orchid|garden/i.test(text))).toBe(true);
    expect(hits[0]?.keywordExcerpt?.every(({ text }) => !/[a-f0-9]{32}(?:BEGIN|END)/.test(text))).toBe(true);
    expect(await engine.search("orchid OR garden")).toEqual([]);
    expect(await engine.search("'\" !!")).toEqual([]);
    expect(await engine.search("orchid", 1, false)).toHaveLength(1);

    await engine.upsertNode(node("notes/future"));
    expect(await engine.edgesOf("notes/orchid")).toMatchObject({ out: ["notes/care", "notes/future"] });
    await engine.replaceEdgesFor("notes/orchid", [{ dst: "notes/violet", rel: "extends" }]);
    expect(await engine.edgesOf("notes/orchid")).toMatchObject({ out: ["notes/violet"] });
    await engine.clearSnooze("notes/orchid");
    expect((await engine.listReviewRows()).find(({ id }) => id === "notes/orchid")?.snoozeUntil).toBeNull();
    await engine.removeNode("notes/violet");
    expect(await engine.listEdges()).toEqual([]);
    await engine.close();
    expect(await hasPostgresIndex(sql, schema)).toBe(true);
  } finally {
    sqlite.close();
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql.close();
  }
});

integration("keyword transactions roll back, initialize in an independent namespace, and wipe only keyword tables", async () => {
  const sql = new SQL(postgresUrl!);
  const schema = namespace();
  const other = namespace();
  try {
    await sql`CREATE SCHEMA ${sql(schema)}`;
    await sql`CREATE TABLE ${sql(schema)}.vector_meta (id integer PRIMARY KEY)`;
    await sql`INSERT INTO ${sql(schema)}.vector_meta VALUES (9)`;
    expect(await hasPostgresIndex(sql, schema)).toBe(false);
    const engine = await openPostgresEngine(sql, schema, true);
    const isolated = await openPostgresEngine(sql, other, true);
    await seed(engine);
    expect(await isolated.listNodeIds()).toEqual([]);

    const previous = await engine.listEdges();
    await expect(engine.replaceEdges([{ src: "notes/orchid", dst: "notes/violet", rel: null },
      { src: null!, dst: "notes/care", rel: null }])).rejects.toThrow("PostgreSQL cache is unavailable.");
    expect(await engine.listEdges()).toEqual(previous);
    const peer = await openPostgresEngine(sql, schema, false);
    await expect(engine.batch!(async (tx) => {
      expect(tx.batch).toBeUndefined();
      await tx.upsertNode(node("notes/uncommitted"));
      await tx.replaceEdges([]);
      expect(await tx.hasNode("notes/uncommitted")).toBe(true);
      expect(await tx.listEdges()).toEqual([]);
      expect(await peer.hasNode("notes/uncommitted")).toBe(false);
      expect(await peer.listEdges()).toEqual(previous);
      throw new Error("Cancel this transaction");
    })).rejects.toThrow();
    expect(await engine.hasNode("notes/uncommitted")).toBe(false);
    expect(await engine.listEdges()).toEqual(previous);

    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const rebuild = engine.batch!(async (tx) => {
      await tx.upsertNode(node("notes/rebuilt"));
      order.push("rebuild opened");
      reading.resolve();
      await release.promise;
      order.push("rebuild finished");
    });
    await reading.promise;
    const point = peer.batch!(async (tx) => {
      order.push("point opened");
      expect(await tx.hasNode("notes/rebuilt")).toBe(true);
      await tx.upsertNode(node("notes/point"));
    });
    try {
      await Bun.sleep(40);
      expect(order).toEqual(["rebuild opened"]);
    } finally { release.resolve(); }
    await Promise.all([rebuild, point]);
    expect(order).toEqual(["rebuild opened", "rebuild finished", "point opened"]);
    expect(await engine.hasNode("notes/point")).toBe(true);

    await sql`UPDATE ${sql(schema)}.keyword_meta SET version = 50`;
    const stale = await openPostgresEngine(sql, schema, false);
    await expect(stale.listNodeIds()).rejects.toThrow(/run `okb rebuild/);
    await stale.wipe();
    expect(await stale.listNodeIds()).toEqual([]);
    expect((await sql<{ id: number }[]>`SELECT id FROM ${sql(schema)}.vector_meta`).map(({ id }) => id)).toEqual([9]);
    expect(await hasPostgresIndex(sql, other)).toBe(true);
  } finally {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    await sql`DROP SCHEMA IF EXISTS ${sql(other)} CASCADE`;
    await sql.close();
  }
});

test("invalid PostgreSQL schema names fail before connecting", async () => {
  const sql = new SQL({ url: "postgres://test@127.0.0.1:1/test", connectionTimeout: 1 });
  try {
    await expect(hasPostgresIndex(sql, "public")).rejects.toThrow("Invalid PostgreSQL brain schema.");
    await expect(openPostgresEngine(sql, "okb_ABC", true)).rejects.toThrow("Invalid PostgreSQL brain schema.");
  } finally { await sql.close(); }
});
