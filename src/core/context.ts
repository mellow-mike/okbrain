// Shared OpContext wiring for the CLI, local API and MCP. Caches open lazily.
// A read on a never-indexed bundle must not create an empty index.

import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { configForBrain, loadConfig, resolveActor, type OkbConfig } from "./config.ts";
import type { BundleWatchBackend } from "./engine/bundle-watch.ts";
import { closeCacheClient, createCacheClient, postgresAccess, readCacheSettings } from "./engine/cache-settings.ts";
import type { IndexEngine, IndexVectors } from "./engine/interface.ts";
import { hasPostgresIndex, openPostgresEngine } from "./engine/postgres.ts";
import { hasPostgresVectors, openPostgresVectors } from "./engine/postgres-vectors.ts";
import { defaultDbPath, EngineError, openSqliteEngine } from "./engine/sqlite.ts";
import { defaultVectorsPath, openVectorStore } from "./engine/vectors.ts";
import type { OpContext } from "./operations.ts";

export interface LocalContext {
  ctx: OpContext;
  cacheBackend(): "sqlite" | "postgres";
  close(): Promise<void>;
}

export function openLocalContext(
  bundle: string,
  trusted = true,
  readonly = false,
  actor?: string,
): LocalContext {
  let engine: IndexEngine | undefined;
  let vectors: IndexVectors | undefined;
  let cfg: OkbConfig | undefined;
  let client: SQL | undefined;
  let settings: ReturnType<typeof readCacheSettings> | undefined;
  const saved = () => settings === undefined ? (settings = readCacheSettings(bundle)) : settings;

  function postgres() {
    const selected = saved();
    if (!selected?.connection) return;
    client ??= createCacheClient(selected.connection);
    return { client, schema: selected.namespace };
  }

  const ctx: OpContext = {
    bundle,
    trusted,
    readonly,
    localUsage: actor === undefined,
    actor: () => actor ?? resolveActor((cfg ??= loadConfig())),
    engine: async (createIfMissing = false) => {
      if (engine) return engine;
      const pg = postgres();
      if (pg)
        return engine = await postgresAccess(() => openPostgresEngine(pg.client, pg.schema, createIfMissing));
      const db = defaultDbPath(bundle);
      if (!createIfMissing && !existsSync(db))
        throw new EngineError("no index for this bundle yet — run `okb index` first");
      return engine = openSqliteEngine(db);
    },
    hasIndex: () => {
      const pg = postgres();
      return pg ? postgresAccess(() => hasPostgresIndex(pg.client, pg.schema)) : existsSync(defaultDbPath(bundle));
    },
    vectors: async (createIfMissing = false) => {
      if (vectors) return vectors;
      const pg = postgres();
      if (pg)
        return vectors = await postgresAccess(() => openPostgresVectors(pg.client, pg.schema, createIfMissing));
      const path = defaultVectorsPath(bundle);
      if (!createIfMissing && !existsSync(path))
        throw new EngineError("no vector index for this bundle yet — run `okb embed` first");
      return vectors = openVectorStore(path);
    },
    hasVectors: () => {
      const pg = postgres();
      return pg ? postgresAccess(() => hasPostgresVectors(pg.client, pg.schema)) : existsSync(defaultVectorsPath(bundle));
    },
    config: () => configForBrain((cfg ??= loadConfig()), ctx.brain, bundle),
  };
  return {
    ctx,
    cacheBackend: () => saved()?.connection ? "postgres" : "sqlite",
    close: async () => {
      if (engine) await engine.close();
      if (vectors) await vectors.close();
      if (client) await closeCacheClient(client);
    },
  };
}

export const localBundleWatchBackend: BundleWatchBackend = {
  identity(bundle) {
    const saved = readCacheSettings(bundle);
    return saved?.connection
      ? createHash("sha256").update(saved.namespace).update(saved.connection).digest("hex")
      : "sqlite";
  },
  async exists(bundle) {
    const local = openLocalContext(bundle);
    try { return await local.ctx.hasIndex(); }
    finally { await local.close(); }
  },
  async open(bundle) {
    const local = openLocalContext(bundle);
    try { return { engine: await local.ctx.engine(true), close: local.close }; }
    catch (error) { await local.close(); throw error; }
  },
};
