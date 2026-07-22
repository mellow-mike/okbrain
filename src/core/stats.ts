// `okb stats`: a deterministic snapshot of the brain — counts by type, link and
// tag totals, orphans, and freshness — aggregated from engine rows + resolved
// edges. Pure (takes `now` so freshness is testable); no AI, no I/O. Fits the
// thin-harness rule (CLAUDE.md invariant 5): an aggregate/lookup is code, not a
// skill.

import type { EdgeRecord, ReviewRow } from "./engine/interface.ts";
import { orphans } from "./graph/queries.ts";

export interface TagCount {
  tag: string;
  count: number;
}

export interface BrainStats {
  concepts: number;
  /** Concept counts per type, most-common first (ties broken by type name). */
  byType: { type: string; count: number }[];
  edges: number;
  /** Resolved edges carrying a typed relation (`rel` non-null). */
  typedEdges: number;
  tags: number;
  topTags: TagCount[];
  orphans: number;
  inbox: number;
  neverReviewed: number;
  /** Frontmatter timestamp of the oldest / newest concept (ISO); null when none. */
  oldest: string | null;
  newest: string | null;
  /** Concepts whose timestamp is older than `staleDays`. */
  stale: number;
  staleDays: number;
}

const DAY = 86_400_000;

const parseTs = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** Aggregate brain-wide stats from engine data. `now` drives the freshness math. */
export function computeStats(
  rows: ReviewRow[],
  edges: EdgeRecord[],
  tagCounts: TagCount[],
  now: Date,
  opts: { staleDays?: number; topTags?: number } = {},
): BrainStats {
  const staleDays = opts.staleDays ?? 180;
  const topN = opts.topTags ?? 10;
  const staleBefore = now.getTime() - staleDays * DAY;

  const byTypeMap = new Map<string, number>();
  let inbox = 0;
  let neverReviewed = 0;
  let stale = 0;
  let oldest: { iso: string; t: number } | null = null;
  let newest: { iso: string; t: number } | null = null;

  for (const r of rows) {
    byTypeMap.set(r.type, (byTypeMap.get(r.type) ?? 0) + 1);
    if (r.inbox) inbox++;
    if (r.lastReviewed === null) neverReviewed++;
    const t = parseTs(r.timestamp);
    if (t !== null) {
      if (oldest === null || t < oldest.t) oldest = { iso: r.timestamp!, t };
      if (newest === null || t > newest.t) newest = { iso: r.timestamp!, t };
      if (t < staleBefore) stale++;
    }
  }

  const byType = [...byTypeMap]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
  const topTags = [...tagCounts]
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1))
    .slice(0, topN);

  return {
    concepts: rows.length,
    byType,
    edges: edges.length,
    typedEdges: edges.filter((e) => e.rel !== null).length,
    tags: tagCounts.length,
    topTags,
    orphans: orphans(rows.map((r) => r.id), edges).length,
    inbox,
    neverReviewed,
    oldest: oldest?.iso ?? null,
    newest: newest?.iso ?? null,
    stale,
    staleDays,
  };
}
