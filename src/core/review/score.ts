// Resurface scoring (F-B.1): pure, deterministic ranking of what deserves
// another look, computed from engine rows + resolved edges — no AI, no I/O.
// Every contributing signal adds a human-readable reason; the reasons are the
// UX. Config values are code defaults until the Stage-2.1 config file wires
// `review.*` keys.

import type { LinkEdge, ReviewRow } from "../engine/interface.ts";

export interface ReviewConfig {
  cooldownDays: number;
  queueSize: number;
  weights: {
    staleness: number;
    orphan: number;
    staleHub: number;
    neighborActivity: number;
    inbox: number;
    anniversary: number;
  };
}

export const defaultReviewConfig: ReviewConfig = {
  cooldownDays: 30,
  queueSize: 5,
  weights: {
    staleness: 1.0,
    orphan: 2.0,
    staleHub: 1.5,
    neighborActivity: 1.0,
    inbox: 1.5,
    anniversary: 0.5,
  },
};

export interface ReviewItem {
  id: string;
  title: string;
  score: number;
  reasons: string[];
  /** Optional AI one-liner tying the item to recent activity (F-B.8). */
  garnish?: string;
}

const DAY = 86_400_000;

const daysSince = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / DAY));
};

const age = (d: number): string =>
  d < 90 ? `${d}d` : d < 720 ? `${Math.round(d / 30)}mo` : `${Math.round((d / 365) * 10) / 10}y`;

/** Rank all rows and return the top of the queue (deterministic order). */
export function reviewQueue(
  rows: ReviewRow[],
  edges: LinkEdge[],
  now: Date,
  cfg: ReviewConfig = defaultReviewConfig,
): ReviewItem[] {
  const staleDays = new Map(rows.map((r) => [r.id, daysSince(r.timestamp, now)]));
  const degree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const freshestNeighbor = new Map<string, number>(); // min days over neighbors
  for (const { src, dst } of edges) {
    degree.set(src, (degree.get(src) ?? 0) + 1);
    degree.set(dst, (degree.get(dst) ?? 0) + 1);
    inDegree.set(dst, (inDegree.get(dst) ?? 0) + 1);
    const sd = staleDays.get(src);
    const dd = staleDays.get(dst);
    if (dd != null)
      freshestNeighbor.set(src, Math.min(freshestNeighbor.get(src) ?? Infinity, dd));
    if (sd != null)
      freshestNeighbor.set(dst, Math.min(freshestNeighbor.get(dst) ?? Infinity, sd));
  }

  const w = cfg.weights;
  const ranked: { item: ReviewItem; ts: string }[] = [];
  for (const r of rows) {
    const reviewed = daysSince(r.lastReviewed, now);
    if (reviewed !== null && reviewed < cfg.cooldownDays) continue;
    if (r.snoozeUntil !== null && Date.parse(r.snoozeUntil) > now.getTime()) continue;

    const d = staleDays.get(r.id) ?? null;
    let score = 0;
    const reasons: string[] = [];
    // A signal only adds its reason when it actually contributes — so a
    // zero-weighted (config-disabled) signal disappears from the UX too.
    const add = (points: number, reason: string): void => {
      if (points <= 0) return;
      score += points;
      reasons.push(reason);
    };
    if (d !== null) add((w.staleness * Math.min(d, 365)) / 365, `untouched ${age(d)}`);
    if ((degree.get(r.id) ?? 0) === 0)
      add(w.orphan, d !== null ? `orphan for ${age(d)}` : "orphan");
    const cited = inDegree.get(r.id) ?? 0;
    if (cited >= 3 && d !== null && d > 90)
      add(w.staleHub, `cited by ${cited}, untouched ${age(d)}`);
    const nb = freshestNeighbor.get(r.id);
    if (nb !== undefined && nb <= 7 && d !== null && d > 30)
      add(w.neighborActivity, `a neighbor changed ${age(nb)} ago`);
    if (r.inbox) add(w.inbox, "in inbox");
    if (d !== null && d >= 364) {
      const years = Math.round(d / 365);
      if (Math.abs(d - years * 365) <= 1) add(w.anniversary, `${years}y today`);
    }
    if (score > 0)
      ranked.push({
        item: { id: r.id, title: r.title, score, reasons },
        ts: r.timestamp ?? "￿", // unknown age sorts after any real date
      });
  }

  ranked.sort(
    (a, b) =>
      b.item.score - a.item.score ||
      (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) || // older first
      (a.item.id < b.item.id ? -1 : 1),
  );
  return ranked.slice(0, cfg.queueSize).map((r) => r.item);
}
