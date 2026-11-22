// SQLite engine: bun:sqlite + FTS5. The DB lives inside the bundle at
// `.okb/index.db` (dot-dirs are invisible to the bundle walker and gitignored),
// so deleting it — or `okb rebuild` — is always safe. FTS rows share the nodes
// table's rowid, so node and index stay paired without a mapping table.
// Schema migrations ARE rebuilds (the DB is a disposable cache): a version
// mismatch makes every data method fail with guidance, and wipe() — what
// `okb rebuild` runs — recreates the current schema unconditionally.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Status, TrustTier } from "../okf/document.ts";
import { ensureExtensionCapableSqlite } from "./custom-sqlite.ts";
import type {
  EdgeRecord,
  Engine,
  LinkCandidate,
  Neighbor,
  NodeRecord,
  NodeUpsert,
  ReviewRow,
  SearchExcerptPart,
  SearchHit,
} from "./interface.ts";

export class EngineError extends Error {}

const SCHEMA_VERSION = 4;
const BUSY_TIMEOUT_MS = 1000;
const STARTUP_BUSY_TIMEOUT_MS = 25;

const SCHEMA = `
CREATE TABLE nodes(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  resource TEXT,
  timestamp TEXT,
  last_reviewed TEXT,
  status TEXT NOT NULL,
  stale_after TEXT,
  trust TEXT NOT NULL,
  body_len INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE edges(
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  rel TEXT,
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

function excerptParts(excerpt: string, marker: string): SearchExcerptPart[] {
  const parts: SearchExcerptPart[] = [];
  let budget = 320;
  let match = false;
  for (const part of excerpt.split(new RegExp(`(${marker}[<>])`, "u"))) {
    if (part === `${marker}<` || part === `${marker}>`) { match = part.endsWith("<"); continue; }
    if (part === "") continue;
    if (budget <= 0) { parts.push({ text: "…", match: false }); break; }
    const text = part.length > budget ? part.slice(0, budget) + "…" : part;
    parts.push({ text, match });
    if (part.length > budget) break;
    budget -= part.length;
  }
  return parts;
}

interface NodeRow {
  id: string;
  type: string;
  title: string;
  description: string;
  resource: string | null;
  timestamp: string | null;
  last_reviewed: string | null;
  status: Status;
  stale_after: string | null;
  trust: TrustTier;
  body_len: number;
  content_hash: string;
}

function isTransientLock(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(code);
}

function createSchema(db: Database): void {
  try {
    db.exec(SCHEMA);
  } catch (error) {
    if (isTransientLock(error)) throw error;
    throw new EngineError(
      `cannot create index schema (SQLite build may lack FTS5): ${(error as Error).message}`,
      { cause: error },
    );
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function schemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
}

/** True when the schema is current; false = stale, only wipe() may repair. */
function migrate(db: Database): boolean {
  const version = schemaVersion(db);
  if (version !== 0) return version === SCHEMA_VERSION;
  // Concurrent openers can both see version 0. Only the writer holding the
  // transaction may initialize it, and the schema and version commit together.
  return db.transaction(() => {
    const currentVersion = schemaVersion(db);
    if (currentVersion === 0) createSchema(db);
    return currentVersion === 0 || currentVersion === SCHEMA_VERSION;
  }).immediate();
}

function initialize(db: Database): boolean {
  db.exec(`PRAGMA busy_timeout = ${STARTUP_BUSY_TIMEOUT_MS}`);
  const deadline = performance.now() + BUSY_TIMEOUT_MS;
  let delay = 5;
  while (true) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      const schemaOk = migrate(db);
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      return schemaOk;
    } catch (error) {
      const remaining = deadline - performance.now();
      if (!isTransientLock(error) || remaining <= 0) throw error;
      // SQLite can return BUSY immediately when changing the journal mode
      // requires a lock upgrade, even with a native busy timeout configured.
      Bun.sleepSync(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 50);
    }
  }
}

/** Open (creating/migrating as needed) a SQLite engine at `dbPath`. */
export function openSqliteEngine(dbPath: string): Engine {
  // On macOS the extension-capable SQLite must be set before ANY Database
  // opens — including this one — or the vector store can never load vec0.
  ensureExtensionCapableSqlite();
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  let schemaOk: boolean;
  try {
    schemaOk = initialize(db);
  } catch (error) {
    db.close();
    throw error;
  }

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
      `INSERT INTO nodes (id, type, title, description, resource, timestamp, last_reviewed,
         status, stale_after, trust, body_len, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type=excluded.type, title=excluded.title,
         description=excluded.description, resource=excluded.resource,
         timestamp=excluded.timestamp, last_reviewed=excluded.last_reviewed,
         status=excluded.status, stale_after=excluded.stale_after, trust=excluded.trust,
         body_len=excluded.body_len, content_hash=excluded.content_hash`,
    ).run(
      n.id,
      n.type,
      n.title,
      n.description,
      n.resource,
      n.timestamp,
      n.lastReviewed,
      n.status,
      n.staleAfter,
      n.trust,
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
    for (const { src, dst, rel } of edges)
      db.query("INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, ?)").run(src, dst, rel);
  });

  const replaceEdgesFor = db.transaction(
    (src: string, edges: { dst: string; rel: string | null }[]) => {
      db.query("DELETE FROM edges WHERE src = ?").run(src);
      for (const { dst, rel } of edges)
        db.query("INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, ?)").run(src, dst, rel);
    },
  );

  const toRecord = (r: NodeRow): NodeRecord => ({
    id: r.id,
    type: r.type,
    title: r.title,
    description: r.description,
    resource: r.resource,
    timestamp: r.timestamp,
    lastReviewed: r.last_reviewed,
    status: r.status,
    staleAfter: r.stale_after,
    trust: r.trust,
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

    hasNode: fresh((id) => db.query("SELECT 1 FROM nodes WHERE id = ?").get(id) !== null),

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

    listLinkCandidates: fresh((tags: readonly string[]) => {
      const wanted = new Set(tags);
      const rows = db.query<{ id: string; title: string; tag: string | null }, [boolean]>(
        `SELECT n.id, n.title, t.tag FROM nodes n
         LEFT JOIN tags t ON t.node_id = n.id AND ?
         ORDER BY n.id, t.tag`,
      ).all(wanted.size > 0);
      const candidates: LinkCandidate[] = [];
      for (const { id, title, tag } of rows) {
        let candidate = candidates.at(-1);
        if (candidate?.id !== id) {
          candidate = { id, title, sharedTags: [] };
          candidates.push(candidate);
        }
        if (tag !== null && wanted.has(tag)) candidate.sharedTags.push(tag);
      }
      return candidates;
    }),

    replaceEdges: fresh((edges) => replaceEdges(edges)),
    replaceEdgesFor: fresh((src, edges) => replaceEdgesFor(src, edges)),

    listEdges: fresh(() =>
      // Dangling edges (unindexed endpoint) stay stored but never surface.
      db
        .query<EdgeRecord, []>(
          `SELECT e.src, e.dst, e.rel FROM edges e
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

    focusEdges: fresh((id, limit) => ({
      out: db.query<EdgeRecord, [string, number]>(
        "SELECT e.* FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? ORDER BY e.dst LIMIT ?",
      ).all(id, limit),
      in: db.query<EdgeRecord, [string, number]>(
        "SELECT e.* FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? ORDER BY e.src LIMIT ?",
      ).all(id, limit),
    })),

    search: fresh((query, limit = 20, excerpts = false) => {
      const expr = toMatchExpr(query);
      if (expr === "") return [];
      // Column weights (title, body, tags): a title hit should beat a body hit.
      const rows = `FROM fts JOIN nodes n ON n.rowid = fts.rowid WHERE fts MATCH ? ORDER BY score DESC, n.id LIMIT ?`;
      const fields = `n.id, n.title, -bm25(fts, 10.0, 1.0, 5.0) AS score`;
      if (excerpts) {
        // Markers are per query so source text cannot masquerade as highlighting.
        const marker = randomUUID();
        return db.query<SearchHit & { excerpt: string }, [string, string, string, number]>(
          `SELECT ${fields}, snippet(fts, -1, ?, ?, '…', 18) AS excerpt ${rows}`,
        ).all(`${marker}<`, `${marker}>`, expr, limit)
          .map(({ excerpt, ...hit }) => ({ ...hit, keywordExcerpt: excerptParts(excerpt, marker) }));
      }
      return db
        .query<SearchHit, [string, number]>(
          `SELECT ${fields} ${rows}`,
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
             n.status, n.stale_after AS staleAfter, n.trust,
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

    listTags: fresh(() =>
      db
        .query<{ tag: string }, []>("SELECT DISTINCT tag FROM tags ORDER BY tag")
        .all()
        .map((r) => r.tag),
    ),

    tagCounts: fresh(() =>
      db
        .query<{ tag: string; count: number }, []>(
          "SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY tag",
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
      db.transaction(() => {
        for (const t of ["fts", "nodes", "edges", "tags", "review_state"])
          db.exec(`DROP TABLE IF EXISTS ${t}`);
        createSchema(db);
      }).immediate();
      schemaOk = true;
    },

    close: () => db.close(),
  };
}
