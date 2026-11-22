import type { EdgeRecord, Engine, NodeRecord } from "../engine/interface.ts";
import { isPrivateConceptAt } from "../okf/privacy.ts";

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

export async function focusedMap(bundle: string, engine: Engine, options: FocusOptions) {
  const candidates = options.id ? [{ id: options.id }] : engine.search(options.query ?? "", SEARCH_LIMIT);
  let bounded = candidates.length === SEARCH_LIMIT;
  const cache = new Map<string, Promise<{ node: NodeRecord; private: boolean } | null>>();
  function visibleNode(id: string) {
    let result = cache.get(id);
    if (!result) {
      result = (async () => {
        const node = engine.getNode(id);
        if (!node || (options.source && options.source !== "all" && options.source !== sourceOf(node))) return null;
        if (options.since && (!node.timestamp || Date.parse(node.timestamp) < Date.parse(options.since))) return null;
        const privateNote = await isPrivateConceptAt(bundle, id);
        return privateNote && !options.includePrivate ? null : { node, private: privateNote };
      })();
      cache.set(id, result);
    }
    return result;
  }

  const nodes = new Map<string, { id: string; title: string; description: string; type: string; root: boolean; source: string; private: boolean }>();
  function add(candidate: { node: NodeRecord; private: boolean }, root: boolean) {
    const { node } = candidate;
    const { id, title, description, type } = node;
    nodes.set(id, { id, title, description, type, root, source: sourceOf(node), private: candidate.private });
  }
  const roots = (await Promise.all(candidates.map(({ id }) => visibleNode(id)))).filter((node) => node !== null);
  if (roots.length > ROOTS) bounded = true;
  const selected = roots.slice(0, ROOTS);
  for (const root of selected) add(root, true);
  const edges = new Map<string, EdgeRecord>();
  for (const { node: { id } } of selected) {
    const { out, in: incoming } = engine.focusEdges(id, LINKS_PER_DIRECTION + 1);
    if (out.length > LINKS_PER_DIRECTION || incoming.length > LINKS_PER_DIRECTION) bounded = true;
    for (const edge of [...out.slice(0, LINKS_PER_DIRECTION), ...incoming.slice(0, LINKS_PER_DIRECTION)]) {
      if (edge.src === edge.dst) continue;
      const candidate = await visibleNode(edge.src === id ? edge.dst : edge.src);
      if (!candidate) continue;
      const { node } = candidate;
      const key = JSON.stringify([edge.src, edge.dst]);
      if (edges.has(key)) continue;
      if (edges.size >= MAP_EDGES || (!nodes.has(node.id) && nodes.size >= MAP_NODES)) {
        bounded = true;
        continue;
      }
      if (!nodes.has(node.id)) add(candidate, false);
      edges.set(key, edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], bounded };
}
