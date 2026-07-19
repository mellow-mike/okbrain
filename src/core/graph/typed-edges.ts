// Typed edges (4.3). OKF keeps links untyped on disk on purpose; okbrain
// types them ONLY in the derived DB so relational retrieval works without
// touching the format. Classification is deterministic and local: the clause
// directly before the link ("depends on [X]") wins, else the nearest
// preceding heading ("# Citations" → cites), else null (plain link). One
// shared phrase→relation vocabulary drives both this classifier and the
// relational query detector (core/retrieval/relational.ts).

import { LINK, resolveLinkTarget } from "./links.ts";

/** Phrase → relation. Ordered; longest phrase wins on query detection. */
export const REL_VOCAB: readonly { phrase: string; rel: string }[] = [
  { phrase: "citations", rel: "cites" },
  { phrase: "citation", rel: "cites" },
  { phrase: "cites", rel: "cites" },
  { phrase: "cited", rel: "cites" },
  { phrase: "cite", rel: "cites" },
  { phrase: "sources", rel: "cites" },
  { phrase: "references", rel: "cites" },
  { phrase: "bibliography", rel: "cites" },
  { phrase: "joins with", rel: "joins-with" },
  { phrase: "joins", rel: "joins-with" },
  { phrase: "related to", rel: "related-to" },
  { phrase: "related", rel: "related-to" },
  { phrase: "see also", rel: "related-to" },
  { phrase: "depends on", rel: "depends-on" },
  { phrase: "depend on", rel: "depends-on" },
  { phrase: "dependencies", rel: "depends-on" },
  { phrase: "depends", rel: "depends-on" },
  { phrase: "part of", rel: "part-of" },
  { phrase: "based on", rel: "based-on" },
  { phrase: "created by", rel: "created-by" },
  { phrase: "authored by", rel: "created-by" },
  { phrase: "written by", rel: "created-by" },
  { phrase: "works at", rel: "works-at" },
  { phrase: "works for", rel: "works-at" },
  { phrase: "supports", rel: "supports" },
  { phrase: "contradicts", rel: "contradicts" },
];

export interface TypedTarget {
  dst: string;
  rel: string | null;
}

const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm;

const normalize = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const headingRel = (text: string): string | null =>
  REL_VOCAB.find((v) => v.phrase === normalize(text))?.rel ?? null;

// Clause must END with the phrase (optionally + article/punct) right before
// the link: "…depends on the [X]" types, "…depends on X, but [Y]" doesn't.
const SENTENCE_RES = REL_VOCAB.map((v) => ({
  rel: v.rel,
  re: new RegExp(
    `\\b${v.phrase.replace(/ /g, "\\s+")}(?:\\s+(?:the|a|an))?\\s*[:,–—-]*\\s*$`,
    "i",
  ),
}));

function relAt(
  body: string,
  linkIndex: number,
  headings: { index: number; rel: string | null }[],
): string | null {
  const open = body.lastIndexOf("[", linkIndex);
  if (open >= 0) {
    const clause = body.slice(Math.max(0, open - 100), open).split(/[.!?;\n]/).pop()!;
    for (const { re, rel } of SENTENCE_RES) if (re.test(clause)) return rel;
  }
  let rel: string | null = null; // nearest preceding heading governs, known or not
  for (const h of headings) {
    if (h.index > linkIndex) break;
    rel = h.rel;
  }
  return rel;
}

/**
 * Resolved internal link targets with their classified relation, deduped
 * first-seen (the first occurrence's relation wins, matching edge dedupe).
 */
export function classifyTargets(srcId: string, body: string): TypedTarget[] {
  const headings: { index: number; rel: string | null }[] = [];
  for (const m of body.matchAll(HEADING_RE))
    headings.push({ index: m.index, rel: headingRel(m[1]!) });

  const out: TypedTarget[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(LINK)) {
    const dst = resolveLinkTarget(srcId, m[1]!);
    if (dst === null || seen.has(dst)) continue;
    seen.add(dst);
    out.push({ dst, rel: relAt(body, m.index, headings) });
  }
  return out;
}
