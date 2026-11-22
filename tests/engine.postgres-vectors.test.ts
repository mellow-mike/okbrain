import { SQL } from "bun";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { hasPostgresVectors, openPostgresVectors } from "../src/core/engine/postgres-vectors.ts";
import { openVectorStore, VecError } from "../src/core/engine/vectors.ts";

const url = process.env.OKB_TEST_POSTGRES_URL;
const key = { provider: "fixture", model: "m1", dim: 3 };
const chunk = (seq: number, text: string, vector: number[]) => ({ seq, text, vector });

test.skipIf(!url)("pgvector exactly ranks nonzero embeddings and keeps brain caches independent", async () => {
  const address = new URL(url!);
  if (!["127.0.0.1", "[::1]"].includes(address.hostname)) throw new Error("Use a disposable loopback PostgreSQL fixture.");
  const sql = new SQL(address.toString());
  const schema = () => "okb_" + randomBytes(16).toString("hex");
  const first = schema();
  const second = schema();
  const sqlite = openVectorStore(":memory:");
  try {
    await expect(hasPostgresVectors(sql, "shared")).rejects.toBeInstanceOf(VecError);
    expect(await hasPostgresVectors(sql, first)).toBe(false);
    await expect(openPostgresVectors(sql, first, false)).rejects.toThrow("Run okb embed");
    const [postgres, isolated] = await Promise.all([
      openPostgresVectors(sql, first, true), openPostgresVectors(sql, second, true),
    ]);
    expect(await postgres.meta()).toBeNull();
    expect(await postgres.search([1, 0, 0])).toEqual([]);
    expect(await postgres.count()).toBe(0);
    await expect(Promise.resolve(postgres.replace("before-key", "bad", [chunk(0, "bad", [1, 0, 0])]))).rejects.toBeInstanceOf(VecError);
    await postgres.replace("tracked", "empty", []);
    expect(await postgres.embeddedHashes()).toEqual(new Map([["tracked", "empty"]]));

    sqlite.reset(key);
    await postgres.reset(key);
    await isolated.reset(key);
    await isolated.replace("notes/it's", "isolated", [chunk(0, "isolated", [0, 1, 0])]);
    const fixture = [
      { id: "notes/it's", hash: "ha", chunks: [chunk(0, "aligned", [1, 0, 0]), chunk(1, "close", [0.8, 0.2, 0])] },
      { id: "notes/b", hash: "hb", chunks: [chunk(0, "orthogonal", [0, 1, 0])] },
    ];
    for (const { id, hash, chunks } of fixture) {
      sqlite.replace(id, hash, chunks);
      await postgres.replace(id, hash, chunks);
    }
    const hits = await postgres.search([8, 1, 0], 3);
    const local = sqlite.search([8, 1, 0], 3);
    expect(hits.map(({ nodeId, seq, text }) => ({ nodeId, seq, text }))).toEqual(
      local.map(({ nodeId, seq, text }) => ({ nodeId, seq, text })),
    );
    for (let i = 0; i < local.length; i++) expect(hits[i]!.distance).toBeCloseTo(local[i]!.distance, 5);
    expect(await postgres.search([8, 1, 0], 0)).toEqual([]);
    expect((await isolated.search([1, 0, 0]))[0]?.text).toBe("isolated");

    await expect(Promise.resolve(postgres.replace("notes/it's", "must-roll-back", [
      chunk(3, "first insert", [0, 0, 1]), chunk(3, "duplicate sequence", [0, 1, 0]),
    ]))).rejects.toThrow("PostgreSQL cache is unavailable");
    await expect(Promise.resolve(postgres.replace("notes/it's", "must-roll-back", [chunk(0, "wrong dim", [1, 0])])))
      .rejects.toThrow("3 dimensions");
    await expect(Promise.resolve(postgres.replace("notes/it's", "must-roll-back", [chunk(0, "not finite", [NaN, 0, 1])])))
      .rejects.toThrow("finite");
    expect(await postgres.count()).toBe(3);
    expect((await postgres.embeddedHashes()).get("notes/it's")).toBe("ha");
    await postgres.replace("zeros", "zero", [chunk(0, "undefined cosine", [0, 0, 0])]);
    expect(await postgres.search([0, 0, 0])).toEqual([]);
    expect((await postgres.search([1, 0, 0])).every((hit) => Number.isFinite(hit.distance))).toBe(true);
    expect(await postgres.count()).toBe(4);

    await postgres.close();
    const reopened = await openPostgresVectors(sql, first, false);
    expect(await reopened.meta()).toEqual(key);
    await reopened.replace("notes/it's", "empty-again", []);
    await reopened.remove("zeros");
    expect(await reopened.count()).toBe(1);
    expect((await reopened.embeddedHashes()).get("notes/it's")).toBe("empty-again");
    const next = { ...key, model: "m2", dim: 2 };
    await reopened.reset(next);
    expect(await reopened.meta()).toEqual(next);
    expect(await reopened.embeddedHashes()).toEqual(new Map<string, string>());
    expect(await reopened.count()).toBe(0);
    await reopened.replace("next", "next", [chunk(0, "next", [1, 1])]);
    await reopened.clear();
    expect(await hasPostgresVectors(sql, first)).toBe(true);
    expect(await reopened.meta()).toBeNull();
    expect(await reopened.count()).toBe(0);
    expect(await isolated.count()).toBe(1);
  } finally {
    sqlite.close();
    try {
      await sql`DROP SCHEMA IF EXISTS ${sql(first)} CASCADE`;
      await sql`DROP SCHEMA IF EXISTS ${sql(second)} CASCADE`;
    } finally { await sql.close(); }
  }
}, 12_000);
