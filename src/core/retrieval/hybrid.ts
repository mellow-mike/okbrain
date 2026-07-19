// Hybrid retrieval (2.3): keyword (FTS5/BM25) and vector (sqlite-vec) recall
// fused with Reciprocal Rank Fusion, then graph expansion over the links of
// the top hits. The vector arm is strictly optional: queries are embedded
// with the store's own cache key (the documents' space), and any failure —
// no store, unreachable provider, dimension drift — degrades to keyword-only
// with a note, never an error. Deterministic given its inputs.

import type { Engine, VectorStore } from "../engine/interface.ts";
import { relationalRanking } from "./relational.ts";
import type { RetrievalProfile } from "./profiles.ts";

export type RecallSource = "keyword" | "vector" | "graph" | "relational";

export interface HybridHit {
  id: string;
  title: string;
  description: string;
  /** RRF-fused score; comparable only within one result set. */
  score: number;
  /** Recall arms that surfaced this hit. */
  sources: RecallSource[];
  /** Closest chunk text (vector arm); feeds display, rerank, and ask packing. */
  snippet?: string;
  /** Relevance from the rerank arm, when it ran. */
  rerankScore?: number;
}

export interface HybridArms {
  engine: Engine;
  vectors?: VectorStore;
  /** Embed queries in the store's space; absent = keyword-only. */
  embed?(texts: string[]): Promise<number[][]>;
}

export interface HybridResult {
  hits: HybridHit[];
  /** Why the vector arm didn't run; null when it did. */
  vectorSkipped: string | null;
}

const RRF_K = 60;
/** Fused-score share a graph-expanded neighbor inherits from its parent hit. */
const GRAPH_DAMP = 0.25;

/** Reciprocal Rank Fusion: score(d) = Σ over rankings of 1/(K + rank), 1-based. */
export function rrfFuse(rankings: string[][]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings)
    ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  return scores;
}

const byScore = (a: [string, number], b: [string, number]): number =>
  b[1] - a[1] || (a[0] < b[0] ? -1 : 1);

export async function hybridRetrieve(
  queries: string[],
  arms: HybridArms,
  profile: RetrievalProfile,
  limit: number,
): Promise<HybridResult> {
  const eng = arms.engine;
  const rankings: string[][] = [];
  const sources = new Map<string, Set<RecallSource>>();
  const mark = (id: string, s: RecallSource) => {
    if (!sources.has(id)) sources.set(id, new Set());
    sources.get(id)!.add(s);
  };

  for (const q of queries) {
    rankings.push(eng.search(q, profile.ftsK).map((h) => (mark(h.id, "keyword"), h.id)));
    // Relational arm (4.3): typed-edge recall for queries naming a relation;
    // deterministic, and a strict no-op for everything else.
    const rel = relationalRanking(q, eng);
    if (rel !== null) rankings.push(rel.ranking.map((id) => (mark(id, "relational"), id)));
  }

  const snippets = new Map<string, string>();
  let vectorSkipped: string | null = null;
  if (!arms.vectors || !arms.embed)
    vectorSkipped = "no vector index — run `okb embed` to enable semantic recall";
  else
    try {
      for (const qvec of await arms.embed(queries)) {
        const ranking: string[] = []; // chunks → concepts: best (first) chunk wins
        for (const hit of arms.vectors.search(qvec, profile.vecK))
          if (!ranking.includes(hit.nodeId)) {
            ranking.push(hit.nodeId);
            mark(hit.nodeId, "vector");
            if (!snippets.has(hit.nodeId)) snippets.set(hit.nodeId, hit.text);
          }
        rankings.push(ranking);
      }
    } catch (e) {
      vectorSkipped = (e as Error).message; // optional arm: degrade, never break recall
    }

  const fused = rrfFuse(rankings);
  const ordered = [...fused.entries()].sort(byScore);

  const expanded = new Map<string, number>();
  for (const [id, score] of ordered.slice(0, profile.expandTop)) {
    const { out, in: cited } = eng.edgesOf(id);
    for (const nb of new Set([...out, ...cited]))
      if (!fused.has(nb)) {
        expanded.set(nb, Math.max(expanded.get(nb) ?? 0, score * GRAPH_DAMP));
        mark(nb, "graph");
      }
  }

  const hits: HybridHit[] = [];
  for (const [id, score] of [...ordered, ...expanded.entries()].sort(byScore)) {
    if (hits.length === limit) break;
    const node = eng.getNode(id);
    if (!node) continue; // stale vector row; the next okb index/embed reconciles
    hits.push({
      id,
      title: node.title,
      description: node.description,
      score,
      sources: [...sources.get(id)!],
      ...(snippets.has(id) ? { snippet: snippets.get(id)! } : {}),
    });
  }
  return { hits, vectorSkipped };
}
