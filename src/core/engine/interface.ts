// The engine contract: the derived, rebuildable cache behind all DB access
// (CLAUDE.md invariant 4). SQLite is the default implementation; Postgres is a
// later drop-in. Canonical knowledge never lives only here — `wipe` + a bundle
// re-index must always restore full state.

export interface NodeRecord {
  id: string;
  type: string;
  title: string;
  description: string;
  resource: string | null;
  bodyLen: number;
  /** Hash of the raw concept file; lets index builds skip unchanged files. */
  contentHash: string;
}

/** A node plus the searchable text the engine feeds to its keyword index. */
export interface NodeUpsert extends NodeRecord {
  body: string;
  tags: string[];
}

export interface EdgeRecord {
  src: string;
  dst: string;
}

export interface SearchHit {
  id: string;
  title: string;
  /** Higher is better (BM25-derived). */
  score: number;
}

export interface Neighbor {
  id: string;
  /** Hops from the origin (≥1); minimum over all paths. */
  depth: number;
}

export interface Engine {
  upsertNode(node: NodeUpsert): void;
  removeNode(id: string): void;
  getNode(id: string): NodeRecord | null;
  getTags(id: string): string[];
  /** All indexed node ids, sorted. */
  listNodeIds(): string[];
  /** id → contentHash for every indexed node (drives skip/removal logic). */
  contentHashes(): Map<string, string>;
  /**
   * Atomically replace the whole edge set. Stored edges may dangle (target not
   * indexed yet); every edge-reading query resolves against `nodes`, so a
   * dangling edge surfaces by itself once its target is written (1.4).
   */
  replaceEdges(edges: EdgeRecord[]): void;
  /** Replace one concept's outgoing edges (incremental update on write). */
  replaceEdgesFor(src: string, dsts: string[]): void;
  /** Resolved edges only (both endpoints indexed), sorted by src then dst. */
  listEdges(): EdgeRecord[];
  /** One concept's resolved links (`out`) and backlinks (`in`), sorted. */
  edgesOf(id: string): { out: string[]; in: string[] };
  /** Keyword search (BM25) over title/body/tags. */
  search(query: string, limit?: number): SearchHit[];
  /** Undirected neighborhood (links + backlinks) out to `depth` hops. */
  neighbors(id: string, depth?: number): Neighbor[];
  /** Drop all derived state; the next index build repopulates it. */
  wipe(): void;
  close(): void;
}
