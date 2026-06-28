// Link extraction -> directed edges. Markdown links between `.md` concepts are
// the graph's primary edges (CONTEXT, Knowledge graph). Targets are resolved in
// the bundle's own forward-slash namespace (posix path math, OS-independent),
// external/anchor/non-md links are dropped, and unresolved targets are filtered
// against the known concept set. Edges are directed and deduped.

import { posix } from "node:path";

export interface Edge {
  src: string;
  dst: string;
}

// Inline markdown link/image targets: the `(...)` after `](`.
const LINK = /\]\(([^)]*)\)/g;

/**
 * Resolve one raw link target to a bundle-relative concept id, or null if it is
 * external, an anchor, non-`.md`, or escapes the bundle root. Pure.
 */
export function resolveLinkTarget(srcId: string, rawTarget: string): string | null {
  let t = rawTarget.trim();
  if (t === "") return null;
  // Strip an optional `<...>` wrapper and any ` "title"` suffix.
  if (t.startsWith("<") && t.includes(">")) t = t.slice(1, t.indexOf(">"));
  else t = t.split(/\s/, 1)[0]!;
  if (t === "" || t.startsWith("#")) return null; // anchor-only
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null; // scheme: http:, mailto:, ...
  t = t.split("#", 1)[0]!.split("?", 1)[0]!; // drop fragment/query
  if (!t.endsWith(".md")) return null;
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep raw if not valid percent-encoding */
  }
  const fromDir = posix.dirname(srcId);
  const joined = t.startsWith("/") ? t.slice(1) : posix.join(fromDir, t);
  if (joined === ".." || joined.startsWith("../")) return null; // escaped root
  return joined.slice(0, -3); // strip .md
}

/** All resolved internal link target ids in a body, deduped, in first-seen order. */
export function extractTargets(srcId: string, body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(LINK)) {
    const id = resolveLinkTarget(srcId, m[1]!);
    if (id !== null) seen.add(id);
  }
  return [...seen];
}

/**
 * Build directed edges from concepts. Targets not in `known` (broken links) are
 * dropped; `known` defaults to the set of provided ids. Edges are deduped and a
 * concept never links to itself.
 */
export function buildEdges(
  docs: { id: string; body: string }[],
  known: Set<string> = new Set(docs.map((d) => d.id)),
): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const { id, body } of docs) {
    for (const dst of extractTargets(id, body)) {
      if (dst === id || !known.has(dst)) continue;
      const key = JSON.stringify([id, dst]); // collision-proof (ids may hold spaces)
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ src: id, dst });
    }
  }
  return edges;
}
