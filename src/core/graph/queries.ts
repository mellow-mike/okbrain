// Graph queries over the resolved edge list (Stage 1.4): shortest paths and
// orphan detection. Pure functions over `Engine.listEdges()` output rather than
// SQL, so they work identically on any engine; bundles are laptop-scale, and
// path reconstruction wants BFS parent tracking anyway. Undirected, matching
// `neighbors` — a backlink connects as much as a link.

import type { EdgeRecord } from "../engine/interface.ts";

function adjacency(edges: EdgeRecord[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const { src, dst } of edges) {
    add(src, dst);
    add(dst, src);
  }
  for (const list of adj.values()) list.sort(); // deterministic tie-breaks
  return adj;
}

/** Shortest undirected path from `src` to `dst` inclusive, or null within `maxHops`. */
export function shortestPath(
  edges: EdgeRecord[],
  src: string,
  dst: string,
  maxHops = 10,
): string[] | null {
  if (src === dst) return [src];
  const adj = adjacency(edges);
  const parent = new Map<string, string>([[src, src]]);
  let frontier = [src];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const u of frontier)
      for (const v of adj.get(u) ?? []) {
        if (parent.has(v)) continue;
        parent.set(v, u);
        if (v === dst) {
          const path = [dst];
          for (let n = u; n !== src; n = parent.get(n)!) path.push(n);
          return [...path, src].reverse();
        }
        next.push(v);
      }
    frontier = next;
  }
  return null;
}

/** Ids with no resolved edge in either direction, in input order. */
export function orphans(ids: string[], edges: EdgeRecord[]): string[] {
  const linked = new Set<string>();
  for (const { src, dst } of edges) {
    linked.add(src);
    linked.add(dst);
  }
  return ids.filter((id) => !linked.has(id));
}
