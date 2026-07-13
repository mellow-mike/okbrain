// sqlite-vec vector store in its own DB file (`.okb/vectors.db`), deliberately
// separate from the main index: a vec0 virtual table can't even be DROPped
// without the extension loaded, so the keyword index must never depend on it,
// and `okb rebuild` regenerating the keyword index must not discard paid-for
// embeddings. The cache key is (provider, model, dim) in `meta`; the embed
// pipeline (core/retrieval/embed.ts) resets the store when the key changes.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { ensureExtensionCapableSqlite } from "./custom-sqlite.ts";
import type { ChunkVector, EmbedMeta, VectorStore } from "./interface.ts";
import { EngineError } from "./sqlite.ts";

export class VecError extends EngineError {}

const VEC_SCHEMA_VERSION = 1;

/** Default on-disk location of a bundle's vector store. */
export function defaultVectorsPath(bundleRoot: string): string {
  return join(bundleRoot, ".okb", "vectors.db");
}

/** Locate the loadable vec0 extension ($OKB_SQLITE_VEC overrides, e.g. for a compiled binary). */
function extensionPath(): string {
  if (process.env.OKB_SQLITE_VEC) return process.env.OKB_SQLITE_VEC;
  try {
    const p = sqliteVec.getLoadablePath();
    if (existsSync(p)) return p;
  } catch {
    // fall through to the actionable error
  }
  throw new VecError(
    "cannot locate the sqlite-vec extension — set OKB_SQLITE_VEC to the vec0 library path",
  );
}

export function openVectorStore(dbPath: string): VectorStore {
  ensureExtensionCapableSqlite();
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  try {
    db.loadExtension(extensionPath());
  } catch (e) {
    db.close();
    if (e instanceof VecError) throw e;
    const mac =
      process.platform === "darwin"
        ? " — macOS needs an extension-capable SQLite: `brew install sqlite` (or set OKB_SQLITE_LIB to a libsqlite3.dylib)"
        : "";
    throw new VecError(`cannot load the sqlite-vec extension: ${(e as Error).message}${mac}`);
  }
  db.exec("PRAGMA journal_mode = WAL");

  const dropAll = () => {
    for (const t of ["chunks", "meta", "embed_state"]) db.exec(`DROP TABLE IF EXISTS ${t}`);
  };
  const createBase = () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY CHECK (key = 'v'),
        provider TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS embed_state(
        node_id TEXT PRIMARY KEY,
        embed_hash TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
  };
  // This store is a cache of derived data keyed by content hash: on a schema
  // change just start over (the next `okb embed` reports the full re-embed).
  const { user_version } = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!;
  if (user_version !== VEC_SCHEMA_VERSION) {
    dropAll();
    db.exec(`PRAGMA user_version = ${VEC_SCHEMA_VERSION}`);
  }
  createBase();

  const getMeta = (): EmbedMeta | null =>
    db.query<EmbedMeta, []>("SELECT provider, model, dim FROM meta").get() ?? null;

  const reset = db.transaction((m: EmbedMeta) => {
    if (!Number.isInteger(m.dim) || m.dim < 1)
      throw new VecError(`invalid embedding dimension: ${m.dim}`);
    dropAll();
    createBase();
    db.query("INSERT INTO meta (key, provider, model, dim) VALUES ('v', ?, ?, ?)").run(
      m.provider,
      m.model,
      m.dim,
    );
    db.exec(
      `CREATE VIRTUAL TABLE chunks USING vec0(
         embedding float[${m.dim}] distance_metric=cosine,
         node_id TEXT, +seq INTEGER, +text TEXT
       )`,
    );
  });

  const replace = db.transaction((nodeId: string, hash: string, chunks: ChunkVector[]) => {
    if (getMeta() === null) {
      if (chunks.length > 0)
        throw new VecError("vector store has no cache key yet — reset() before storing chunks");
    } else {
      db.query("DELETE FROM chunks WHERE node_id = ?").run(nodeId);
      for (const c of chunks)
        db.query("INSERT INTO chunks (embedding, node_id, seq, text) VALUES (?, ?, ?, ?)").run(
          new Float32Array(c.vector),
          nodeId,
          c.seq,
          c.text,
        );
    }
    db.query(
      "INSERT INTO embed_state (node_id, embed_hash) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET embed_hash=excluded.embed_hash",
    ).run(nodeId, hash);
  });

  const remove = db.transaction((nodeId: string) => {
    if (getMeta() !== null) db.query("DELETE FROM chunks WHERE node_id = ?").run(nodeId);
    db.query("DELETE FROM embed_state WHERE node_id = ?").run(nodeId);
  });

  return {
    meta: getMeta,
    reset: (m) => reset(m),
    clear: db.transaction(() => {
      dropAll();
      createBase();
    }),
    embeddedHashes: () =>
      new Map(
        db
          .query<{ node_id: string; embed_hash: string }, []>(
            "SELECT node_id, embed_hash FROM embed_state",
          )
          .all()
          .map((r) => [r.node_id, r.embed_hash]),
      ),
    replace: (nodeId, hash, chunks) => replace(nodeId, hash, chunks),
    remove: (nodeId) => remove(nodeId),
    search: (vector, k = 10) => {
      if (getMeta() === null) return [];
      return db
        .query<{ node_id: string; seq: number; text: string; distance: number }, [Float32Array, number]>(
          "SELECT node_id, seq, text, distance FROM chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        )
        .all(new Float32Array(vector), k)
        .map((r) => ({ nodeId: r.node_id, seq: r.seq, text: r.text, distance: r.distance }));
    },
    count: () =>
      getMeta() === null
        ? 0
        : db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()!.n,
    close: () => db.close(),
  };
}
