import type { EdgeRecord, Engine, NodeRecord } from "../engine/interface.ts";
import { inDbOnlyDir } from "../okf/paths.ts";

const SEARCH_LIMIT = 100;
const ROOTS = 8;
const LINKS_PER_DIRECTION = 30;
const MAP_NODES = 60;
const MAP_EDGES = 100;

export const MAP_SOURCES = ["all", "notes", "web", "imports"] as const;
type SourceFilter = typeof MAP_SOURCES[number];

interface FocusOptions {
  id?: string;
  query?: string;
  includePrivate?: boolean;
  source?: SourceFilter;
  since?: string;
}

function sourceOf(node: NodeRecord): Exclude<SourceFilter, "all"> {
  if (node.type === "conversation" || node.id.startsWith("db_only/imports/")) return "imports";
  return /^https?:\/\//i.test(node.resource ?? "") ? "web" : "notes";
}

export function focusedMap(engine: Engine, options: FocusOptions) {
  const candidates = options.id ? [{ id: options.id }] : engine.search(options.query ?? "", SEARCH_LIMIT);
  let bounded = candidates.length === SEARCH_LIMIT;
  const cache = new Map<string, NodeRecord | null>();
  function visibleNode(id: string) {
    if (!cache.has(id)) cache.set(id, engine.getNode(id));
    const node = cache.get(id);
    if (!node || (!options.includePrivate && inDbOnlyDir(id))) return null;
    if (options.source && options.source !== "all" && options.source !== sourceOf(node)) return null;
    if (options.since && (!node.timestamp || Date.parse(node.timestamp) < Date.parse(options.since))) return null;
    return node;
  }

  const nodes = new Map<string, { id: string; title: string; description: string; type: string; root: boolean; source: string; private: boolean }>();
  function add(node: NodeRecord, root: boolean) {
    const { id, title, description, type } = node;
    nodes.set(id, { id, title, description, type, root, source: sourceOf(node), private: inDbOnlyDir(id) });
  }
  const roots = candidates.flatMap(({ id }) => {
    const node = visibleNode(id);
    return node ? [node] : [];
  });
  if (roots.length > ROOTS) bounded = true;
  const selected = roots.slice(0, ROOTS);
  for (const root of selected) add(root, true);
  const edges = new Map<string, EdgeRecord>();
  for (const { id } of selected) {
    const { out, in: incoming } = engine.focusEdges(id, LINKS_PER_DIRECTION + 1);
    if (out.length > LINKS_PER_DIRECTION || incoming.length > LINKS_PER_DIRECTION) bounded = true;
    for (const edge of [...out.slice(0, LINKS_PER_DIRECTION), ...incoming.slice(0, LINKS_PER_DIRECTION)]) {
      if (edge.src === edge.dst) continue;
      const node = visibleNode(edge.src === id ? edge.dst : edge.src);
      if (!node) continue;
      const key = JSON.stringify([edge.src, edge.dst]);
      if (edges.has(key)) continue;
      if (edges.size >= MAP_EDGES || (!nodes.has(node.id) && nodes.size >= MAP_NODES)) {
        bounded = true;
        continue;
      }
      if (!nodes.has(node.id)) add(node, false);
      edges.set(key, edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], bounded };
}
