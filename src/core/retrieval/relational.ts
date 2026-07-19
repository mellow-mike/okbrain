// Relational retrieval arm (4.3): deterministic recall over typed edges.
// A query that names a known relation ("what cites X", "Y depends on")
// contributes the concepts connected to its anchor by that relation as one
// more ranking for RRF fusion; anything else is a strict no-op. Direction is
// not guessed from grammar: inbound then outbound neighbors, deduped — the
// arm recalls candidates, fusion ranks them.

import type { Engine } from "../engine/interface.ts";
import { REL_VOCAB } from "../graph/typed-edges.ts";

/** Question scaffolding stripped before the anchor search (FTS is AND-based). */
const STOP = new Set([
  "what", "which", "who", "whom", "does", "do", "did", "is", "are", "was",
  "were", "the", "a", "an", "of", "on", "in", "to", "by", "my", "me", "show",
  "list", "all", "everything", "anything", "things",
]);

export interface RelationalMatch {
  ranking: string[];
  rel: string;
  anchor: string;
}

export function relationalRanking(query: string, eng: Engine): RelationalMatch | null {
  const padded = ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  let hit: { phrase: string; rel: string } | undefined;
  for (const v of REL_VOCAB)
    if (padded.includes(` ${v.phrase} `) && (hit === undefined || v.phrase.length > hit.phrase.length))
      hit = v;
  if (hit === undefined) return null;

  const rest = padded
    .replace(` ${hit.phrase} `, " ")
    .split(/\s+/)
    .filter((t) => t !== "" && !STOP.has(t))
    .join(" ");
  if (rest === "") return null;
  const anchor = eng.search(rest, 1)[0];
  if (anchor === undefined) return null;

  const edges = eng.listEdges().filter((e) => e.rel === hit.rel);
  const ranking = [
    ...new Set([
      ...edges.filter((e) => e.dst === anchor.id).map((e) => e.src),
      ...edges.filter((e) => e.src === anchor.id).map((e) => e.dst),
    ]),
  ];
  return ranking.length === 0 ? null : { ranking, rel: hit.rel, anchor: anchor.id };
}
