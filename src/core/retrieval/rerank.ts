// Optional rerank arm (2.3): tighten the fused top-k with a cross-encoder.
// Deliberately opt-in — it only runs when a rerank provider is *explicitly*
// configured (config `ai.rerankProvider` or $OKB_RERANK_PROVIDER), never via
// key detection, so a merely-exported VOYAGE_API_KEY can't make every search
// silently spend API credits.

import type { Gateway } from "../ai/gateway.ts";
import type { AiSettings } from "../config.ts";
import type { HybridHit } from "./hybrid.ts";

export function rerankConfigured(
  ai: AiSettings,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.OKB_RERANK_PROVIDER ?? ai.rerankProvider);
}

/** Reorder the head of `hits` by cross-encoder relevance; the tail keeps its fused order. */
export async function rerankHits(
  query: string,
  hits: HybridHit[],
  gw: Gateway,
  topN = 20,
): Promise<HybridHit[]> {
  const head = hits.slice(0, topN);
  if (head.length < 2) return hits;
  const { ranked } = await gw.rerank(
    query,
    head.map((h) => `${h.title} — ${h.snippet ?? h.description}`),
  );
  const seen = new Set(ranked.map((r) => r.index));
  return [
    ...ranked.map(({ index, score }) => ({ ...head[index]!, rerankScore: score })),
    ...head.filter((_, i) => !seen.has(i)), // providers may return a subset
    ...hits.slice(topN),
  ];
}
