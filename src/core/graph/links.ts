// Link extraction -> directed edges. Markdown links between `.md` concepts are
// the graph's primary edges (CONTEXT, Knowledge graph); OKF v0.2 `sources`
// entries whose `resource` names another concept are provenance edges. Targets
// are resolved in the bundle's own forward-slash namespace (posix path math,
// OS-independent), external/anchor/non-md links are dropped, and unresolved
// targets are filtered against the known concept set. Edges are directed and
// deduped.

import { posix } from "node:path";
import { fmSources } from "../okf/document.ts";

export interface Edge {
  src: string;
  dst: string;
}

// Inline markdown link/image targets: the `(...)` after `](`.
export const LINK = /\]\(([^)]*)\)/g;

// Split a raw target into its destination (unwrapping `<...>`) and whatever
// trails it (` "title"` and, for wrapped targets, anything after `>`).
function splitTarget(raw: string): { dest: string; suffix: string } {
  const t = raw.trim();
  if (t.startsWith("<") && t.includes(">")) {
    const end = t.indexOf(">");
    return { dest: t.slice(1, end), suffix: t.slice(end + 1) };
  }
  const dest = t.split(/\s/, 1)[0]!;
  return { dest, suffix: t.slice(dest.length) };
}

/**
 * Resolve one raw link target to a bundle-relative concept id, or null if it is
 * external, an anchor, non-`.md`, or escapes the bundle root. Pure.
 */
export function resolveLinkTarget(srcId: string, rawTarget: string): string | null {
  let t = splitTarget(rawTarget).dest;
  if (t === "" || t.startsWith("#")) return null; // empty or anchor-only
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

/**
 * Resolve a path-valued frontmatter field (`sources[].resource`, `computation`,
 * `executor.resource`, … — OKF v0.2 §6.2). Same rules as links, plus the
 * convention the spec's own examples use: a bare relative path that resolves
 * to nothing next to the concept is retried from the bundle root
 * (`policies/x.md` written in `metrics/y.md`). Returns null for URLs, scope
 * descriptors, and non-`.md` artifacts.
 */
export function resolvePathField(
  srcId: string,
  raw: string,
  known?: Set<string>,
): string | null {
  const rel = resolveLinkTarget(srcId, raw);
  if (rel === null || known === undefined || known.has(rel)) return rel;
  if (raw.startsWith("/") || raw.startsWith(".")) return rel;
  const fromRoot = resolveLinkTarget("", raw);
  return fromRoot !== null && known.has(fromRoot) ? fromRoot : rel;
}

/**
 * Rewrite every resolvable internal link to bundle-absolute form (`/dir/x.md`),
 * the stable form OKF prefers. Anchors and ` "title"` suffixes are preserved;
 * external, broken-syntax, and non-`.md` targets pass through untouched.
 * Destinations needing it (spaces, parens) are `<...>`-wrapped. Idempotent.
 */
export function normalizeLinks(srcId: string, body: string): string {
  return body.replace(LINK, (match, raw: string) => {
    const id = resolveLinkTarget(srcId, raw);
    if (id === null) return match;
    const { dest, suffix } = splitTarget(raw);
    const hash = dest.indexOf("#");
    const abs = `/${id}.md${hash >= 0 ? dest.slice(hash) : ""}`;
    return `](${/[ ()]/.test(abs) ? `<${abs}>` : abs}${suffix})`;
  });
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

/** Concept ids named by `sources[].resource` (provenance edges), deduped. */
export function sourceTargets(
  srcId: string,
  fm: Record<string, unknown>,
  known?: Set<string>,
): string[] {
  const seen = new Set<string>();
  for (const s of fmSources(fm)) {
    const id = resolvePathField(srcId, s.resource, known);
    if (id !== null) seen.add(id);
  }
  return [...seen];
}

export interface LinkDoc {
  id: string;
  body: string;
  frontmatter?: Record<string, unknown>;
}

/**
 * Build directed edges from concepts (body links first, then provenance).
 * Targets not in `known` (broken links) are dropped; `known` defaults to the
 * set of provided ids. Edges are deduped and a concept never links to itself.
 */
export function buildEdges(
  docs: LinkDoc[],
  known: Set<string> = new Set(docs.map((d) => d.id)),
): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const { id, body, frontmatter } of docs) {
    const targets = [...extractTargets(id, body), ...sourceTargets(id, frontmatter ?? {}, known)];
    for (const dst of targets) {
      if (dst === id || !known.has(dst)) continue;
      const key = JSON.stringify([id, dst]); // collision-proof (ids may hold spaces)
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ src: id, dst });
    }
  }
  return edges;
}
