// Link suggestion (4.4): deterministic cross-link proposals with stated
// reasons (the Resurface pattern — reasons are the UX). Signals: the
// candidate's title mentioned in the body (strongest), keyword similarity
// over the FTS index (per-word, since engine.search is AND-semantics), and
// shared tags. Suggestions always route through review — accepting is a
// separate explicit write (`link_accept`), never an auto-insert.

import type { Engine } from "../engine/interface.ts";
import { extractTargets } from "./links.ts";

export interface LinkSuggestion {
  id: string;
  title: string;
  score: number;
  reasons: string[];
}

export interface SuggestInput {
  id: string;
  title: string;
  description: string;
  body: string;
  tags: string[];
}

const FTS_K = 20;
const STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "are", "was", "has",
  "have", "its", "into", "over", "about", "one", "two", "how", "what", "when",
]);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Distinct meaty words (≥3 chars, no stop-words) from title+description, capped. */
const queryWords = (c: SuggestInput): string[] =>
  [...new Set(
    `${c.title} ${c.description}`.toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  )].slice(0, 8);

export function suggestLinks(concept: SuggestInput, eng: Engine, limit = 5): LinkSuggestion[] {
  // Never suggest what's already connected (either direction) or the self.
  const excluded = new Set<string>([concept.id, ...extractTargets(concept.id, concept.body)]);
  for (const id of eng.edgesOf(concept.id).in) excluded.add(id);

  const scores = new Map<string, { score: number; reasons: Set<string> }>();
  const bump = (id: string, pts: number, reason: string): void => {
    if (excluded.has(id)) return;
    let cur = scores.get(id);
    if (!cur) scores.set(id, (cur = { score: 0, reasons: new Set() }));
    cur.score += pts;
    cur.reasons.add(reason);
  };

  for (const id of eng.listNodeIds()) {
    if (excluded.has(id)) continue;
    const n = eng.getNode(id)!;
    const title = n.title.trim();
    if (title.length >= 3 && new RegExp(`\\b${escapeRe(title)}\\b`, "i").test(concept.body))
      bump(id, 3, `mentions "${title}"`);
    const shared = eng.getTags(id).filter((t) => concept.tags.includes(t));
    if (shared.length > 0)
      bump(id, 0.5 * Math.min(shared.length, 3), `shares tags: ${shared.slice(0, 3).join(", ")}`);
  }

  const words = queryWords(concept);
  for (const w of words)
    eng.search(w, FTS_K).forEach((h, i) =>
      bump(h.id, (2 / words.length) * ((FTS_K - i) / FTS_K), "similar content"),
    );

  return [...scores.entries()]
    .map(([id, s]) => ({ id, title: eng.getNode(id)!.title, score: s.score, reasons: [...s.reasons] }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}
