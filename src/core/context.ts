// Shared OpContext wiring for local adapters (CLI, local API; MCP reuses it
// with trusted=false). Engines open lazily — a read on a never-indexed bundle
// must fail loudly, not create an empty index (B3) — and the caller owns
// close via the returned handle.

import { existsSync } from "node:fs";
import { loadConfig, resolveActor, type OkbConfig } from "./config.ts";
import type { Engine, VectorStore } from "./engine/interface.ts";
import { defaultDbPath, EngineError, openSqliteEngine } from "./engine/sqlite.ts";
import { defaultVectorsPath, openVectorStore } from "./engine/vectors.ts";
import type { OpContext } from "./operations.ts";

export interface LocalContext {
  ctx: OpContext;
  close(): void;
}

export function openLocalContext(
  bundle: string,
  trusted = true,
  readonly = false,
  actor?: string,
): LocalContext {
  let engine: Engine | undefined;
  let vectors: VectorStore | undefined;
  let cfg: OkbConfig | undefined;
  const ctx: OpContext = {
    bundle,
    trusted,
    readonly,
    actor: () => actor ?? resolveActor((cfg ??= loadConfig())),
    engine: (createIfMissing = false) => {
      if (!engine) {
        const db = defaultDbPath(bundle);
        if (!createIfMissing && !existsSync(db))
          throw new EngineError("no index for this bundle yet — run `okb index` first");
        engine = openSqliteEngine(db);
      }
      return engine;
    },
    hasIndex: () => existsSync(defaultDbPath(bundle)),
    vectors: (createIfMissing = false) => {
      if (!vectors) {
        const path = defaultVectorsPath(bundle);
        if (!createIfMissing && !existsSync(path))
          throw new EngineError("no vector index for this bundle yet — run `okb embed` first");
        vectors = openVectorStore(path);
      }
      return vectors;
    },
    hasVectors: () => existsSync(defaultVectorsPath(bundle)),
    config: () => (cfg ??= loadConfig()),
  };
  return {
    ctx,
    close: () => {
      engine?.close();
      vectors?.close();
    },
  };
}
