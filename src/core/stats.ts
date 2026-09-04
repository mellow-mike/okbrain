// `okb stats`: a deterministic snapshot of the brain — counts by type, link and
// tag totals, orphans, freshness, and the OKF v0.2 signals (lifecycle status,
// trust tiers, concepts past `stale_after`) — aggregated from engine rows +
// resolved edges. Pure (takes `now` so freshness is testable); no AI, no I/O.
// Fits the thin-harness rule (CLAUDE.md invariant 5): an aggregate/lookup is
// code, not a skill.

import type { EdgeRecord, ReviewRow } from "./engine/interface.ts";
import { orphans } from "./graph/queries.ts";
import type { Status, TrustTier } from "./okf/document.ts";

export interface TagCount {
  tag: string;
  count: number;
}

export interface BrainStats {
  concepts: number;
  /** Concept counts per type, most-common first (ties broken by type name). */
  byType: { type: string; count: number }[];
  byStatus: Record<Status, number>;
  byTrust: Record<TrustTier, number>;
  edges: number;
  /** Resolved edges carrying a typed relation (`rel` non-null). */
  typedEdges: number;
  tags: number;
  topTags: TagCount[];
  orphans: number;
  inbox: number;
  neverReviewed: number;
  /** Concepts past their `stale_after` instant (OKF v0.2 §5.5). */
  expired: number;
  /** `generated.at` of the oldest / newest concept (ISO); null when none. */
  oldest: string | null;
  newest: string | null;
  /** Concepts whose last content change is older than `staleDays`. */
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
  const byStatus: Record<Status, number> = { draft: 0, stable: 0, deprecated: 0 };
  const byTrust: Record<TrustTier, number> = { unverified: 0, "machine-confirmed": 0, "human-reviewed": 0 };
  let inbox = 0;
  let neverReviewed = 0;
  let stale = 0;
  let expired = 0;
  let oldest: { iso: string; t: number } | null = null;
  let newest: { iso: string; t: number } | null = null;

  for (const r of rows) {
    byTypeMap.set(r.type, (byTypeMap.get(r.type) ?? 0) + 1);
    byStatus[r.status]++;
    byTrust[r.trust]++;
    if (r.inbox) inbox++;
    if (r.lastReviewed === null) neverReviewed++;
    if (r.staleAfter !== null && Date.parse(r.staleAfter) <= now.getTime()) expired++;
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
    byStatus,
    byTrust,
    edges: edges.length,
    typedEdges: edges.filter((e) => e.rel !== null).length,
    tags: tagCounts.length,
    topTags,
    orphans: orphans(rows.map((r) => r.id), edges).length,
    inbox,
    neverReviewed,
    expired,
    oldest: oldest?.iso ?? null,
    newest: newest?.iso ?? null,
    stale,
    staleDays,
  };
}
