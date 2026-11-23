import type { SQL } from "bun";
import { postgresAccess } from "./cache-settings.ts";
import type { EmbedMeta, IndexVectors } from "./interface.ts";
import { requireVectorKey, VecError } from "./vectors.ts";

const schemaVersion = 1;
const maxDimension = 16000;

function quote(name: string) {
  return '"' + name.replaceAll('"', '""') + '"';
}

function safeSchema(schema: string) {
  if (!/^okb_[a-f0-9]{32}$/u.test(schema)) throw new VecError("Invalid Postgres brain schema.");
  return quote(schema);
}

export async function hasPostgresVectors(sql: SQL, schema: string): Promise<boolean> {
  safeSchema(schema);
  return postgresAccess(async () => {
    const [row] = await sql<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schema} AND c.relname = 'vector_meta' AND c.relkind = 'r'
      ) AS present
    `;
    return row?.present === true;
  });
}

function vectorInput(vector: number[], dimension: number) {
  if (vector.length !== dimension) throw new VecError(`Expected an embedding with ${dimension} dimensions.`);
  const normalized = vector.map((value) => {
    const item = Math.fround(value);
    if (!Number.isFinite(item)) throw new VecError("Embedding values must be finite single-precision numbers.");
    return item;
  });
  return JSON.stringify(normalized);
}

type MetaRow = { version: number; provider: string | null; model: string | null; dim: number | null };

/** A separate, rebuildable cache in the selected brain's schema. The caller owns the SQL pool. */
export async function openPostgresVectors(sql: SQL, schema: string, create: boolean): Promise<IndexVectors> {
  const namespace = safeSchema(schema);
  const metaTable = `${namespace}.vector_meta`;
  const hashTable = `${namespace}.vector_hashes`;
  const chunkTable = `${namespace}.vector_chunks`;
  return postgresAccess(async () => {
    if (!create && !await hasPostgresVectors(sql, schema))
      throw new VecError("No Postgres vector cache for this brain yet. Run okb embed first.");
    const [extension] = await sql<{ schema: string }[]>`
      SELECT n.nspname AS schema
      FROM pg_catalog.pg_extension AS e JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace
      WHERE e.extname = 'vector'
    `;
    if (!extension) throw new VecError("Ask your database administrator to install the pgvector extension in this database.");
    const vectorSchema = quote(extension.schema);
    const vectorType = `${vectorSchema}.vector`;
    const cosine = `${vectorSchema}.cosine_distance`;

    async function storedMeta(connection: SQL, lock: "" | " FOR UPDATE" = ""): Promise<EmbedMeta | null> {
      const [row] = await connection.unsafe<MetaRow[]>(`SELECT version, provider, model, dim FROM ${metaTable} WHERE singleton${lock}`);
      if (row?.version !== schemaVersion) throw new VecError("This Postgres vector cache needs rebuilding. Run okb embed.");
      return row.dim === null ? null : { provider: row.provider!, model: row.model!, dim: row.dim };
    }

    async function createTables(connection: SQL) {
      await connection.unsafe(`
        CREATE TABLE IF NOT EXISTS ${metaTable} (
          singleton boolean PRIMARY KEY CHECK (singleton),
          version integer NOT NULL,
          provider text, model text, dim integer,
          CHECK ((provider IS NULL AND model IS NULL AND dim IS NULL) OR
                 (provider IS NOT NULL AND model IS NOT NULL AND dim IS NOT NULL AND dim BETWEEN 1 AND ${maxDimension}))
        )
      `);
      await connection.unsafe(`
        CREATE TABLE IF NOT EXISTS ${hashTable} (
          node_id text PRIMARY KEY, embed_hash text NOT NULL
        )
      `);
      await connection.unsafe(`
        CREATE TABLE IF NOT EXISTS ${chunkTable} (
          node_id text NOT NULL, seq integer NOT NULL, text text NOT NULL, embedding ${vectorType} NOT NULL,
          PRIMARY KEY (node_id, seq)
        )
      `);
    }

    if (create) {
      await sql.begin(async (tx) => {
        // The keyword store can create this same schema through another pool.
        await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${schema}::text, 0))`;
        await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${namespace}`);
        await createTables(tx);
        const [row] = await tx.unsafe<{ version: number }[]>(`SELECT version FROM ${metaTable} WHERE singleton FOR UPDATE`);
        if (row && row.version !== schemaVersion) {
          await tx.unsafe(`DROP TABLE ${chunkTable}, ${hashTable}, ${metaTable}`);
          await createTables(tx);
        }
        await tx.unsafe(`INSERT INTO ${metaTable} (singleton, version) VALUES (true, $1) ON CONFLICT (singleton) DO NOTHING`, [schemaVersion]);
      });
    } else {
      await storedMeta(sql);
    }

    const changeKey = (key: EmbedMeta | null, expectedKey?: EmbedMeta | null) => postgresAccess(async () => {
      if (key && (!Number.isInteger(key.dim) || key.dim < 1 || key.dim > maxDimension))
        throw new VecError(`Invalid embedding dimension: ${key.dim}.`);
      await sql.begin(async (tx) => {
        requireVectorKey(await storedMeta(tx, " FOR UPDATE"), expectedKey);
        await tx.unsafe(`DELETE FROM ${chunkTable}`);
        await tx.unsafe(`DELETE FROM ${hashTable}`);
        await tx.unsafe(`UPDATE ${metaTable} SET provider = $1, model = $2, dim = $3 WHERE singleton`,
          [key?.provider ?? null, key?.model ?? null, key?.dim ?? null]);
      });
    });

    const store: IndexVectors = {
      meta: () => postgresAccess(() => storedMeta(sql)),
      reset: changeKey,
      clear: (expectedKey) => changeKey(null, expectedKey),
      embeddedHashes: () => postgresAccess(async () => {
        const rows = await sql.unsafe<{ node_id: string; embed_hash: string }[]>(`SELECT node_id, embed_hash FROM ${hashTable}`);
        return new Map(rows.map(({ node_id, embed_hash }) => [node_id, embed_hash]));
      }),
      replace: (nodeId, hash, chunks, expectedKey) => postgresAccess(() => sql.begin(async (tx) => {
        const key = await storedMeta(tx, " FOR UPDATE");
        requireVectorKey(key, expectedKey);
        if (!key && chunks.length) throw new VecError("Vector storage has no cache key yet. Reset before storing chunks.");
        const next = key ? chunks.map(({ vector, seq, text }) => ({ seq, text, embedding: vectorInput(vector, key.dim) })) : [];
        await tx.unsafe(`DELETE FROM ${chunkTable} WHERE node_id = $1`, [nodeId]);
        for (const { seq, text, embedding } of next)
          await tx.unsafe(`INSERT INTO ${chunkTable} (node_id, seq, text, embedding) VALUES ($1, $2, $3, $4::${vectorType})`,
            [nodeId, seq, text, embedding]);
        await tx.unsafe(`
          INSERT INTO ${hashTable} (node_id, embed_hash) VALUES ($1, $2)
          ON CONFLICT (node_id) DO UPDATE SET embed_hash = excluded.embed_hash
        `, [nodeId, hash]);
      })),
      remove: (nodeId, expectedKey) => postgresAccess(() => sql.begin(async (tx) => {
        requireVectorKey(await storedMeta(tx, " FOR UPDATE"), expectedKey);
        await tx.unsafe(`DELETE FROM ${chunkTable} WHERE node_id = $1`, [nodeId]);
        await tx.unsafe(`DELETE FROM ${hashTable} WHERE node_id = $1`, [nodeId]);
      })),
      search: (vector, k = 10) => postgresAccess(() => sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
        const key = await storedMeta(tx);
        if (!key || k === 0) return [];
        if (!Number.isSafeInteger(k) || k < 0) throw new VecError("The vector result limit must be a nonnegative integer.");
        const input = vectorInput(vector, key.dim);
        const rows = await tx.unsafe<{ node_id: string; seq: number; text: string; distance: number }[]>(`
          SELECT node_id, seq, text, distance FROM (
            SELECT node_id, seq, text, ${cosine}(embedding, $1::${vectorType}) AS distance FROM ${chunkTable}
          ) AS scored
          WHERE distance <> 'NaN'::double precision
          ORDER BY distance, node_id COLLATE pg_catalog."C", seq LIMIT $2
        `, [input, k]);
        return rows.map(({ node_id, seq, text, distance }) => ({ nodeId: node_id, seq, text, distance }));
      })),
      count: () => postgresAccess(async () => {
        const [row] = await sql.unsafe<{ n: string }[]>(`SELECT pg_catalog.count(*)::text AS n FROM ${chunkTable}`);
        return Number(row!.n);
      }),
      close: () => {},
    };
    return store;
  });
}
