// SQLite engine: bun:sqlite + FTS5. The DB lives inside the bundle at
// `.okb/index.db` (dot-dirs are invisible to the bundle walker and gitignored),
// so deleting it — or `okb rebuild` — is always safe. FTS rows share the nodes
// table's rowid, so node and index stay paired without a mapping table.
// Schema migrations ARE rebuilds (the DB is a disposable cache): a version
// mismatch makes every data method fail with guidance, and wipe() — what
// `okb rebuild` runs — recreates the current schema unconditionally.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureExtensionCapableSqlite } from "./custom-sqlite.ts";
import type {
  EdgeRecord,
  Engine,
  Neighbor,
  NodeRecord,
  NodeUpsert,
  ReviewRow,
  SearchHit,
} from "./interface.ts";

export class EngineError extends Error {}

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE nodes(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  resource TEXT,
  timestamp TEXT,
  last_reviewed TEXT,
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
CREATE TABLE review_state(
  node_id TEXT PRIMARY KEY,
  snooze_until TEXT NOT NULL
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
  timestamp: string | null;
  last_reviewed: string | null;
  body_len: number;
  content_hash: string;
}

function createSchema(db: Database): void {
  try {
    db.exec(SCHEMA);
  } catch (e) {
    throw new EngineError(
      `cannot create index schema (SQLite build may lack FTS5): ${(e as Error).message}`,
    );
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** True when the schema is current; false = stale, only wipe() may repair. */
function migrate(db: Database): boolean {
  const { user_version } = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!;
  if (user_version === SCHEMA_VERSION) return true;
  if (user_version !== 0) return false;
  createSchema(db);
  return true;
}

/** Open (creating/migrating as needed) a SQLite engine at `dbPath`. */
export function openSqliteEngine(dbPath: string): Engine {
  // On macOS the extension-capable SQLite must be set before ANY Database
  // opens — including this one — or the vector store can never load vec0.
  ensureExtensionCapableSqlite();
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  let schemaOk = migrate(db);

  // Data methods refuse a stale schema so a v1 index can't half-answer.
  const fresh =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A): R => {
      if (!schemaOk)
        throw new EngineError(
          "index schema is from a different okb version — run `okb rebuild --confirm-destructive` to regenerate it",
        );
      return fn(...a);
    };

  const upsert = db.transaction((n: NodeUpsert) => {
    db.query(
      `INSERT INTO nodes (id, type, title, description, resource, timestamp, last_reviewed, body_len, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type=excluded.type, title=excluded.title,
         description=excluded.description, resource=excluded.resource,
         timestamp=excluded.timestamp, last_reviewed=excluded.last_reviewed,
         body_len=excluded.body_len, content_hash=excluded.content_hash`,
    ).run(
      n.id,
      n.type,
      n.title,
      n.description,
      n.resource,
      n.timestamp,
      n.lastReviewed,
      n.bodyLen,
      n.contentHash,
    );
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
    db.query("DELETE FROM review_state WHERE node_id = ?").run(id);
    db.query("DELETE FROM nodes WHERE id = ?").run(id);
  });

  const replaceEdges = db.transaction((edges: EdgeRecord[]) => {
    db.query("DELETE FROM edges").run();
    for (const { src, dst } of edges)
      db.query("INSERT OR IGNORE INTO edges (src, dst) VALUES (?, ?)").run(src, dst);
  });

  const replaceEdgesFor = db.transaction((src: string, dsts: string[]) => {
    db.query("DELETE FROM edges WHERE src = ?").run(src);
    for (const dst of dsts)
      db.query("INSERT OR IGNORE INTO edges (src, dst) VALUES (?, ?)").run(src, dst);
  });

  const toRecord = (r: NodeRow): NodeRecord => ({
    id: r.id,
    type: r.type,
    title: r.title,
    description: r.description,
    resource: r.resource,
    timestamp: r.timestamp,
    lastReviewed: r.last_reviewed,
    bodyLen: r.body_len,
    contentHash: r.content_hash,
  });

  return {
    upsertNode: fresh((n) => upsert(n)),
    removeNode: fresh((id) => remove(id)),

    getNode: fresh((id) => {
      const row = db
        .query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?")
        .get(id);
      return row ? toRecord(row) : null;
    }),

    getTags: fresh((id) =>
      db
        .query<{ tag: string }, [string]>(
          "SELECT tag FROM tags WHERE node_id = ? ORDER BY tag",
        )
        .all(id)
        .map((r) => r.tag),
    ),

    contentHashes: fresh(() => {
      const rows = db
        .query<{ id: string; content_hash: string }, []>(
          "SELECT id, content_hash FROM nodes",
        )
        .all();
      return new Map(rows.map((r) => [r.id, r.content_hash]));
    }),

    listNodeIds: fresh(() =>
      db
        .query<{ id: string }, []>("SELECT id FROM nodes ORDER BY id")
        .all()
        .map((r) => r.id),
    ),

    replaceEdges: fresh((edges) => replaceEdges(edges)),
    replaceEdgesFor: fresh((src, dsts) => replaceEdgesFor(src, dsts)),

    listEdges: fresh(() =>
      // Dangling edges (unindexed endpoint) stay stored but never surface.
      db
        .query<EdgeRecord, []>(
          `SELECT e.src, e.dst FROM edges e
           JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
           ORDER BY e.src, e.dst`,
        )
        .all(),
    ),

    edgesOf: fresh((id) => {
      const ids = (sql: string) =>
        db.query<{ id: string }, [string]>(sql).all(id).map((r) => r.id);
      return {
        out: ids(
          "SELECT e.dst AS id FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? ORDER BY e.dst",
        ),
        in: ids(
          "SELECT e.src AS id FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? ORDER BY e.src",
        ),
      };
    }),

    search: fresh((query, limit = 20) => {
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
    }),

    neighbors: fresh((id, depth = 1) =>
      db
        .query<Neighbor, [string, number, string]>(
          `WITH RECURSIVE walk(id, depth) AS (
             SELECT ?, 0
             UNION
             SELECT n.id, w.depth + 1
             FROM edges e JOIN walk w ON w.id IN (e.src, e.dst)
             JOIN nodes n ON n.id = CASE WHEN e.src = w.id THEN e.dst ELSE e.src END
             WHERE w.depth < ?
           )
           SELECT id, MIN(depth) AS depth FROM walk
           WHERE id <> ? GROUP BY id ORDER BY depth, id`,
        )
        .all(id, depth, id),
    ),

    listReviewRows: fresh(() =>
      db
        .query<Omit<ReviewRow, "inbox"> & { inbox: number }, []>(
          `SELECT n.id, n.type, n.title, n.timestamp, n.last_reviewed AS lastReviewed,
             EXISTS(SELECT 1 FROM tags t WHERE t.node_id = n.id AND t.tag = 'inbox') AS inbox,
             (SELECT snooze_until FROM review_state r WHERE r.node_id = n.id) AS snoozeUntil
           FROM nodes n ORDER BY n.id`,
        )
        .all()
        .map((r) => ({ ...r, inbox: r.inbox === 1 })),
    ),

    listResources: fresh(() =>
      db
        .query<{ id: string; resource: string }, []>(
          "SELECT id, resource FROM nodes WHERE resource IS NOT NULL AND resource != '' ORDER BY id",
        )
        .all(),
    ),

    setSnooze: fresh((id, untilIso) => {
      db.query(
        "INSERT INTO review_state (node_id, snooze_until) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET snooze_until=excluded.snooze_until",
      ).run(id, untilIso);
    }),

    clearSnooze: fresh((id) => {
      db.query("DELETE FROM review_state WHERE node_id = ?").run(id);
    }),

    wipe() {
      // Drop + recreate rather than DELETE FROM: this is also the upgrade
      // path from any older schema version (`okb rebuild`).
      for (const t of ["fts", "nodes", "edges", "tags", "review_state"])
        db.exec(`DROP TABLE IF EXISTS ${t}`);
      createSchema(db);
      schemaOk = true;
    },

    close: () => db.close(),
  };
}
