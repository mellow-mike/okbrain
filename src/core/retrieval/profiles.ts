// Retrieval profiles (2.3): the cost knobs. A profile decides how deep each
// recall arm goes, whether rerank / multi-query expansion run, and how many
// characters of context `okb ask` may pack — `lean` keeps a local model
// comfortable, `max` spends for recall. Selection: explicit `--profile` →
// config `retrieval.profile` → balanced.

import type { OkbConfig } from "../config.ts";

export interface RetrievalProfile {
  name: string;
  /** Chunks fetched from the vector store per query. */
  vecK: number;
  /** Keyword (FTS) hits fetched per query. */
  ftsK: number;
  /** Top fused hits whose graph neighbors join the pool (0 = arm off). */
  expandTop: number;
  /** Run the rerank arm (still requires an explicitly configured provider). */
  rerank: boolean;
  /** Extra chat-generated query phrasings for `okb ask` (0 = off). */
  multiQuery: number;
  /** Max characters of concept context packed into a synthesis prompt. */
  budgetChars: number;
}

export const PROFILES: Record<string, RetrievalProfile> = {
  lean: { name: "lean", vecK: 8, ftsK: 8, expandTop: 0, rerank: false, multiQuery: 0, budgetChars: 6_000 },
  balanced: { name: "balanced", vecK: 16, ftsK: 16, expandTop: 4, rerank: true, multiQuery: 0, budgetChars: 12_000 },
  max: { name: "max", vecK: 32, ftsK: 32, expandTop: 8, rerank: true, multiQuery: 2, budgetChars: 24_000 },
};

export class ProfileError extends Error {}

export function resolveProfile(explicit: string | undefined, cfg: OkbConfig): RetrievalProfile {
  const name = explicit ?? cfg.retrieval?.profile ?? "balanced";
  const p = PROFILES[name];
  if (!p)
    throw new ProfileError(
      `unknown retrieval profile: ${name} (known: ${Object.keys(PROFILES).join(", ")})`,
    );
  return p;
}
