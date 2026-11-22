import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { postgresAccess } from "./cache-settings.ts";
import type { EdgeRecord, IndexEngine, LinkCandidate, Neighbor, NodeRecord, ReviewRow, SearchExcerptPart, SearchHit } from "./interface.ts";
import { EngineError } from "./sqlite.ts";

const schemaVersion = 1;

function checkSchema(schema: string): void {
  if (!/^okb_[a-f0-9]{32}$/.test(schema)) throw new EngineError("Invalid PostgreSQL brain schema.");
}

/** A graph/index schema can exist for vectors alone. Only the keyword marker counts here. */
export async function hasPostgresIndex(sql: SQL, schema: string): Promise<boolean> {
  checkSchema(schema);
  const [row] = await sql<{ exists: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = 'keyword_meta' AND c.relkind = 'r'
  ) AS exists`;
  return row?.exists === true;
}

async function createTables(tx: SQL, schema: string): Promise<void> {
  const namespace = tx(schema);
  await tx`CREATE SCHEMA IF NOT EXISTS ${namespace}`;
  await tx`CREATE TABLE ${namespace}.keyword_meta (singleton boolean PRIMARY KEY CHECK (singleton), version integer NOT NULL)`;
  await tx`CREATE TABLE ${namespace}.keyword_nodes (
    id text COLLATE "C" PRIMARY KEY, type text NOT NULL, title text NOT NULL, description text NOT NULL,
    resource text, changed_at text, last_reviewed text, status text NOT NULL, stale_after text,
    trust text NOT NULL, body_len integer NOT NULL, content_hash text NOT NULL,
    body text NOT NULL, tag_text text NOT NULL,
    terms tsvector GENERATED ALWAYS AS (
      pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', title), 'A') ||
      pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', tag_text), 'B') ||
      pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', body), 'D')
    ) STORED
  )`;
  await tx`CREATE INDEX keyword_terms_idx ON ${namespace}.keyword_nodes USING gin (terms)`;
  await tx`CREATE TABLE ${namespace}.keyword_tags (
    node_id text COLLATE "C" NOT NULL, tag text COLLATE "C" NOT NULL, PRIMARY KEY (node_id, tag)
  )`;
  await tx`CREATE TABLE ${namespace}.keyword_edges (
    src text COLLATE "C" NOT NULL, dst text COLLATE "C" NOT NULL, rel text, PRIMARY KEY (src, dst)
  )`;
  await tx`CREATE INDEX keyword_edges_dst_idx ON ${namespace}.keyword_edges (dst, src)`;
  await tx`CREATE TABLE ${namespace}.keyword_review (
    node_id text COLLATE "C" PRIMARY KEY, snooze_until text NOT NULL
  )`;
  await tx`INSERT INTO ${namespace}.keyword_meta (singleton, version) VALUES (true, ${schemaVersion})`;
}

function excerptParts(excerpt: string, marker: string): SearchExcerptPart[] {
  const parts: SearchExcerptPart[] = [];
  const start = `${marker}BEGIN`, stop = `${marker}END`;
  let budget = 320;
  let match = false;
  for (const part of excerpt.split(new RegExp(`(${start}|${stop})`))) {
    if (part === start || part === stop) { match = part === start; continue; }
    if (!part) continue;
    if (!budget) { parts.push({ text: "…", match: false }); break; }
    const truncated = part.length > budget;
    parts.push({ text: part.slice(0, budget) + (truncated ? "…" : ""), match });
    if (truncated) break;
    budget -= part.length;
  }
  return parts;
}

// PostgreSQL text cannot store NUL. Markdown remains the source of truth for the original bytes.
const safeText = (value: string): string => value.replaceAll("\0", "�");

/** Open the optional PostgreSQL keyword/graph cache. The caller owns the SQL pool. */
export async function openPostgresEngine(sql: SQL, schema: string, create: boolean): Promise<IndexEngine> {
  checkSchema(schema);
  const namespace = sql(schema);

  function locked<T>(work: (tx: SQL) => Promise<T>): Promise<T> {
    return sql.begin("ISOLATION LEVEL READ COMMITTED", async (tx) => {
      // Also used by the vector backend when creating the same per-brain schema.
      await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${schema}::text, 0))`;
      return work(tx);
    }) as Promise<T>;
  }

  if (!await hasPostgresIndex(sql, schema)) {
    if (!create) throw new EngineError("no PostgreSQL index for this bundle yet — run `okb index` first");
    await locked(async (tx) => {
      if (!await hasPostgresIndex(tx, schema)) await createTables(tx, schema);
    });
  }
  const [meta] = await sql<{ version: number }[]>`SELECT version FROM ${namespace}.keyword_meta WHERE singleton`;
  return bindEngine(sql, { current: meta?.version === schemaVersion });

  function bindEngine(sql: SQL, state: { current: boolean }, inBatch = false): IndexEngine {
    const namespace = sql(schema);
    const write = inBatch ? <T>(work: (tx: SQL) => Promise<T>) => work(sql) : locked;
    function requireCurrent(): void {
      if (!state.current) throw new EngineError("PostgreSQL index schema is from a different okb version — run `okb rebuild --confirm-destructive`");
    }

    async function insertEdges(tx: SQL, edges: EdgeRecord[]): Promise<void> {
      if (!edges.length) return;
      await tx`INSERT INTO ${namespace}.keyword_edges (src, dst, rel)
        SELECT src, dst, rel FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(edges)}::text::jsonb) AS x(src text, dst text, rel text)
        ON CONFLICT (src, dst) DO NOTHING`;
    }

    async function directEdges(id: string, limit: number | null): Promise<{ out: EdgeRecord[]; in: EdgeRecord[] }> {
      requireCurrent();
      const rows = await sql<(EdgeRecord & { direction: "out" | "in" })[]>`
        (SELECT 'out' AS direction, e.src, e.dst, e.rel FROM ${namespace}.keyword_edges e
         JOIN ${namespace}.keyword_nodes n ON n.id = e.dst WHERE e.src = ${id} ORDER BY e.dst LIMIT ${limit})
        UNION ALL
        (SELECT 'in' AS direction, e.src, e.dst, e.rel FROM ${namespace}.keyword_edges e
         JOIN ${namespace}.keyword_nodes n ON n.id = e.src WHERE e.dst = ${id} ORDER BY e.src LIMIT ${limit})
        ORDER BY direction, dst, src`;
      const result: { out: EdgeRecord[]; in: EdgeRecord[] } = { out: [], in: [] };
      for (const { direction, ...edge } of rows) result[direction].push(edge);
      return result;
    }

    const engine: IndexEngine = {
      async upsertNode(n) {
        requireCurrent();
        const tags = n.tags.map(safeText);
        await write(async (tx) => {
          await tx`INSERT INTO ${namespace}.keyword_nodes
            (id, type, title, description, resource, changed_at, last_reviewed, status, stale_after, trust, body_len, content_hash, body, tag_text)
            VALUES (${n.id}, ${safeText(n.type)}, ${safeText(n.title)}, ${safeText(n.description)}, ${n.resource === null ? null : safeText(n.resource)},
              ${n.timestamp}, ${n.lastReviewed}, ${n.status}, ${n.staleAfter}, ${n.trust}, ${n.bodyLen}, ${n.contentHash}, ${safeText(n.body)}, ${tags.join(" ")})
            ON CONFLICT (id) DO UPDATE SET type = excluded.type, title = excluded.title, description = excluded.description,
              resource = excluded.resource, changed_at = excluded.changed_at, last_reviewed = excluded.last_reviewed,
              status = excluded.status, stale_after = excluded.stale_after, trust = excluded.trust, body_len = excluded.body_len,
              content_hash = excluded.content_hash, body = excluded.body, tag_text = excluded.tag_text`;
          await tx`DELETE FROM ${namespace}.keyword_tags WHERE node_id = ${n.id}`;
          if (tags.length) await tx`INSERT INTO ${namespace}.keyword_tags (node_id, tag)
            SELECT ${n.id}, value FROM pg_catalog.jsonb_array_elements_text(${JSON.stringify(tags)}::text::jsonb)
            ON CONFLICT DO NOTHING`;
        });
      },
      async removeNode(id) {
        requireCurrent();
        await write(async (tx) => {
          const removed = await tx`DELETE FROM ${namespace}.keyword_nodes WHERE id = ${id} RETURNING id`;
          if (!removed.length) return;
          await tx`DELETE FROM ${namespace}.keyword_tags WHERE node_id = ${id}`;
          await tx`DELETE FROM ${namespace}.keyword_edges WHERE src = ${id} OR dst = ${id}`;
          await tx`DELETE FROM ${namespace}.keyword_review WHERE node_id = ${id}`;
        });
      },
      async getNode(id) {
        requireCurrent();
        const [node] = await sql<NodeRecord[]>`SELECT id, type, title, description, resource, changed_at AS timestamp,
          last_reviewed AS "lastReviewed", status, stale_after AS "staleAfter", trust, body_len AS "bodyLen", content_hash AS "contentHash"
          FROM ${namespace}.keyword_nodes WHERE id = ${id}`;
        return node ?? null;
      },
      async hasNode(id) {
        requireCurrent();
        return (await sql`SELECT id FROM ${namespace}.keyword_nodes WHERE id = ${id}`).length > 0;
      },
      async getTags(id) {
        requireCurrent();
        return (await sql<{ tag: string }[]>`SELECT tag FROM ${namespace}.keyword_tags WHERE node_id = ${id} ORDER BY tag`).map(({ tag }) => tag);
      },
      async listNodeIds() {
        requireCurrent();
        return (await sql<{ id: string }[]>`SELECT id FROM ${namespace}.keyword_nodes ORDER BY id`).map(({ id }) => id);
      },
      async listLinkCandidates(tags) {
        requireCurrent();
        const rows = await sql<{ id: string; title: string; tag: string | null }[]>`SELECT n.id, n.title, t.tag
          FROM ${namespace}.keyword_nodes n LEFT JOIN ${namespace}.keyword_tags t ON t.node_id = n.id
            AND t.tag IN (SELECT value FROM pg_catalog.jsonb_array_elements_text(${JSON.stringify(tags.map(safeText))}::text::jsonb))
          ORDER BY n.id, t.tag`;
        const candidates: LinkCandidate[] = [];
        for (const { id, title, tag } of rows) {
          let candidate = candidates.at(-1);
          if (!candidate || candidate.id !== id) {
            candidate = { id, title, sharedTags: [] };
            candidates.push(candidate);
          }
          if (tag !== null) candidate.sharedTags.push(tag);
        }
        return candidates;
      },
      async contentHashes() {
        requireCurrent();
        const rows = await sql<{ id: string; content_hash: string }[]>`SELECT id, content_hash FROM ${namespace}.keyword_nodes`;
        return new Map(rows.map(({ id, content_hash }) => [id, content_hash]));
      },
      async replaceEdges(edges) {
        requireCurrent();
        await write(async (tx) => {
          await tx`DELETE FROM ${namespace}.keyword_edges`;
          await insertEdges(tx, edges);
        });
      },
      async replaceEdgesFor(src, edges) {
        requireCurrent();
        await write(async (tx) => {
          await tx`DELETE FROM ${namespace}.keyword_edges WHERE src = ${src}`;
          await insertEdges(tx, edges.map(({ dst, rel }) => ({ src, dst, rel })));
        });
      },
      async listEdges() {
        requireCurrent();
        return sql<EdgeRecord[]>`SELECT e.src, e.dst, e.rel FROM ${namespace}.keyword_edges e
          JOIN ${namespace}.keyword_nodes s ON s.id = e.src JOIN ${namespace}.keyword_nodes d ON d.id = e.dst ORDER BY e.src, e.dst`;
      },
      async edgesOf(id) {
        const edges = await directEdges(id, null);
        return { out: edges.out.map(({ dst }) => dst), in: edges.in.map(({ src }) => src) };
      },
      focusEdges: (id, limit) => directEdges(id, limit < 0 ? null : limit),
      async search(query, limit = 20, excerpts = false) {
        requireCurrent();
        if (!query.trim()) return [];
        const marker = randomUUID().replaceAll("-", "");
        const options = `StartSel=${marker}BEGIN,StopSel=${marker}END,MaxWords=18,MinWords=5,MaxFragments=1,FragmentDelimiter=…`;
        const rows = await sql<(SearchHit & { excerpt: string | null })[]>`
          WITH q AS (SELECT pg_catalog.plainto_tsquery('pg_catalog.simple', ${safeText(query)}) AS words),
          hits AS MATERIALIZED (
            SELECT n.id, n.title, n.body, n.tag_text, pg_catalog.ts_rank(n.terms, q.words) AS score
            FROM ${namespace}.keyword_nodes n CROSS JOIN q WHERE n.terms @@ q.words
            ORDER BY score DESC, n.id LIMIT ${limit < 0 ? null : limit}
          )
          SELECT id, title, score, CASE WHEN ${excerpts} THEN pg_catalog.ts_headline('pg_catalog.simple',
            title || chr(10) || body || chr(10) || tag_text, q.words, ${options}) END AS excerpt
          FROM hits CROSS JOIN q ORDER BY score DESC, id`;
        return rows.map(({ excerpt, ...hit }) => ({ ...hit, ...(excerpt === null ? {} : { keywordExcerpt: excerptParts(excerpt, marker) }) }));
      },
      async neighbors(id, depth = 1) {
        requireCurrent();
        return sql<Neighbor[]>`WITH RECURSIVE walk(id, depth) AS (
          SELECT ${id}::text COLLATE "C", 0
          UNION
          SELECT n.id, w.depth + 1 FROM walk w JOIN ${namespace}.keyword_edges e ON w.id IN (e.src, e.dst)
            JOIN ${namespace}.keyword_nodes n ON n.id = CASE WHEN e.src = w.id THEN e.dst ELSE e.src END
          WHERE w.depth < ${depth}
        ) SELECT id, MIN(depth) AS depth FROM walk WHERE id <> ${id} GROUP BY id ORDER BY depth, id`;
      },
      async listReviewRows() {
        requireCurrent();
        return sql<ReviewRow[]>`SELECT n.id, n.type, n.title, n.changed_at AS timestamp, n.last_reviewed AS "lastReviewed",
          n.status, n.stale_after AS "staleAfter", n.trust,
          EXISTS (SELECT 1 FROM ${namespace}.keyword_tags t WHERE t.node_id = n.id AND t.tag = 'inbox') AS inbox,
          r.snooze_until AS "snoozeUntil" FROM ${namespace}.keyword_nodes n
          LEFT JOIN ${namespace}.keyword_review r ON r.node_id = n.id ORDER BY n.id`;
      },
      async listResources() {
        requireCurrent();
        return sql<{ id: string; resource: string }[]>`SELECT id, resource FROM ${namespace}.keyword_nodes WHERE resource <> '' ORDER BY id`;
      },
      async listTags() {
        requireCurrent();
        return (await sql<{ tag: string }[]>`SELECT DISTINCT tag FROM ${namespace}.keyword_tags ORDER BY tag`).map(({ tag }) => tag);
      },
      async tagCounts() {
        requireCurrent();
        return sql<{ tag: string; count: number }[]>`SELECT tag, COUNT(*)::integer AS count FROM ${namespace}.keyword_tags GROUP BY tag ORDER BY tag`;
      },
      async setSnooze(id, untilIso) {
        requireCurrent();
        await write(async (tx) => {
          await tx`INSERT INTO ${namespace}.keyword_review (node_id, snooze_until) VALUES (${id}, ${untilIso})
            ON CONFLICT (node_id) DO UPDATE SET snooze_until = excluded.snooze_until`;
        });
      },
      async clearSnooze(id) {
        requireCurrent();
        await write(async (tx) => { await tx`DELETE FROM ${namespace}.keyword_review WHERE node_id = ${id}`; });
      },
      async wipe() {
        await write(async (tx) => {
          await tx`DROP TABLE IF EXISTS ${namespace}.keyword_meta, ${namespace}.keyword_nodes,
            ${namespace}.keyword_tags, ${namespace}.keyword_edges, ${namespace}.keyword_review`;
          await createTables(tx, schema);
        });
        state.current = true;
      },
      close() {},
    };
    if (!inBatch) engine.batch = async (work) => {
      const batchState = { current: state.current };
      const result = await locked((tx) => work(bindEngine(tx, batchState, true)));
      state.current = batchState.current;
      return result;
    };
    // Database errors may include connection or query details. Keep every method
    // behind the same error boundary as opening the selected cache.
    return new Proxy(engine, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver);
        return typeof method === "function"
          ? (...args: unknown[]) => postgresAccess(async () => Reflect.apply(method, target, args))
          : method;
      },
    });
  }
}
