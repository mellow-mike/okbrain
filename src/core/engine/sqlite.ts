// SQLite engine: bun:sqlite + FTS5. The DB lives inside the bundle at
// `.okb/index.db` (dot-dirs are invisible to the bundle walker and gitignored),
// so deleting it — or `okb rebuild` — is always safe. FTS rows share the nodes
// table's rowid, so node and index stay paired without a mapping table.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  EdgeRecord,
  Engine,
  Neighbor,
  NodeRecord,
  NodeUpsert,
  SearchHit,
} from "./interface.ts";

export class EngineError extends Error {}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE nodes(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  resource TEXT,
  body_len INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE edges(
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  PRIMARY KEY (src, dst)
) WITHOUT ROWID;
CREATE INDEX edges_dst ON edges(dst);
CREATE TABLE tags(
  node_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (node_id, tag)
) WITHOUT ROWID;
CREATE VIRTUAL TABLE fts USING fts5(title, body, tags);
`;

/** Default on-disk location of the derived index for a bundle. */
export function defaultDbPath(bundleRoot: string): string {
  return join(bundleRoot, ".okb", "index.db");
}

/**
 * Escape a user query into an FTS5 MATCH expression: each whitespace-separated
 * term is double-quoted (implicit AND), so FTS5 operators/punctuation in user
 * input can't cause syntax errors.
 */
export function toMatchExpr(query: string): string {
  return query
    .split(/\s+/)
    .filter((t) => t !== "")
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" ");
}

interface NodeRow {
  id: string;
  type: string;
  title: string;
  description: string;
  resource: string | null;
  body_len: number;
  content_hash: string;
}

function migrate(db: Database): void {
  const { user_version } = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!;
  if (user_version === SCHEMA_VERSION) return;
  if (user_version !== 0)
    throw new EngineError(
      `index schema v${user_version} is newer than supported v${SCHEMA_VERSION}; run \`okb rebuild\` with a matching okb`,
    );
  try {
    db.exec(SCHEMA);
  } catch (e) {
    throw new EngineError(
      `cannot create index schema (SQLite build may lack FTS5): ${(e as Error).message}`,
    );
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Open (creating/migrating as needed) a SQLite engine at `dbPath`. */
export function openSqliteEngine(dbPath: string): Engine {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);

  const upsert = db.transaction((n: NodeUpsert) => {
    db.query(
      `INSERT INTO nodes (id, type, title, description, resource, body_len, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type=excluded.type, title=excluded.title,
         description=excluded.description, resource=excluded.resource,
         body_len=excluded.body_len, content_hash=excluded.content_hash`,
    ).run(n.id, n.type, n.title, n.description, n.resource, n.bodyLen, n.contentHash);
    const { rowid } = db
      .query<{ rowid: number }, [string]>("SELECT rowid FROM nodes WHERE id = ?")
      .get(n.id)!;
    db.query("DELETE FROM fts WHERE rowid = ?").run(rowid);
    db.query("INSERT INTO fts (rowid, title, body, tags) VALUES (?, ?, ?, ?)").run(
      rowid,
      n.title,
      n.body,
      n.tags.join(" "),
    );
    db.query("DELETE FROM tags WHERE node_id = ?").run(n.id);
    for (const tag of n.tags)
      db.query("INSERT OR IGNORE INTO tags (node_id, tag) VALUES (?, ?)").run(n.id, tag);
  });

  const remove = db.transaction((id: string) => {
    const row = db
      .query<{ rowid: number }, [string]>("SELECT rowid FROM nodes WHERE id = ?")
      .get(id);
    if (!row) return;
    db.query("DELETE FROM fts WHERE rowid = ?").run(row.rowid);
    db.query("DELETE FROM tags WHERE node_id = ?").run(id);
    db.query("DELETE FROM edges WHERE src = ? OR dst = ?").run(id, id);
    db.query("DELETE FROM nodes WHERE id = ?").run(id);
  });

  const replaceEdges = db.transaction((edges: EdgeRecord[]) => {
    db.query("DELETE FROM edges").run();
    for (const { src, dst } of edges)
      db.query("INSERT INTO edges (src, dst) VALUES (?, ?)").run(src, dst);
  });

  const toRecord = (r: NodeRow): NodeRecord => ({
    id: r.id,
    type: r.type,
    title: r.title,
    description: r.description,
    resource: r.resource,
    bodyLen: r.body_len,
    contentHash: r.content_hash,
  });

  return {
    upsertNode: (n) => upsert(n),
    removeNode: (id) => remove(id),

    getNode(id) {
      const row = db
        .query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?")
        .get(id);
      return row ? toRecord(row) : null;
    },

    getTags(id) {
      return db
        .query<{ tag: string }, [string]>(
          "SELECT tag FROM tags WHERE node_id = ? ORDER BY tag",
        )
        .all(id)
        .map((r) => r.tag);
    },

    contentHashes() {
      const rows = db
        .query<{ id: string; content_hash: string }, []>(
          "SELECT id, content_hash FROM nodes",
        )
        .all();
      return new Map(rows.map((r) => [r.id, r.content_hash]));
    },

    replaceEdges: (edges) => replaceEdges(edges),

    listEdges() {
      return db
        .query<EdgeRecord, []>("SELECT src, dst FROM edges ORDER BY src, dst")
        .all();
    },

    search(query, limit = 20) {
      const expr = toMatchExpr(query);
      if (expr === "") return [];
      // Column weights (title, body, tags): a title hit should beat a body hit.
      return db
        .query<SearchHit, [string, number]>(
          `SELECT n.id, n.title, -bm25(fts, 10.0, 1.0, 5.0) AS score
           FROM fts JOIN nodes n ON n.rowid = fts.rowid
           WHERE fts MATCH ? ORDER BY score DESC, n.id LIMIT ?`,
        )
        .all(expr, limit);
    },

    neighbors(id, depth = 1) {
      return db
        .query<Neighbor, [string, number, string]>(
          `WITH RECURSIVE walk(id, depth) AS (
             SELECT ?, 0
             UNION
             SELECT CASE WHEN e.src = w.id THEN e.dst ELSE e.src END, w.depth + 1
             FROM edges e JOIN walk w ON w.id IN (e.src, e.dst)
             WHERE w.depth < ?
           )
           SELECT id, MIN(depth) AS depth FROM walk
           WHERE id <> ? GROUP BY id ORDER BY depth, id`,
        )
        .all(id, depth, id);
    },

    wipe() {
      db.exec("DELETE FROM fts; DELETE FROM tags; DELETE FROM edges; DELETE FROM nodes;");
    },

    close: () => db.close(),
  };
}
