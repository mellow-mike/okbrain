// Reverse edges: "Cited by". The DB materializes these later (Stage 1.4); this
// pure helper derives them from an edge list for the read-only graph and tests.

import type { Edge } from "./links.ts";

/** Map each concept to the sorted ids that link to it. */
export function backlinks(edges: Edge[]): Map<string, string[]> {
  const byDst = new Map<string, Set<string>>();
  for (const { src, dst } of edges) {
    (byDst.get(dst) ?? byDst.set(dst, new Set()).get(dst)!).add(src);
  }
  const out = new Map<string, string[]>();
  for (const [dst, srcs] of byDst) out.set(dst, [...srcs].sort());
  return out;
}
