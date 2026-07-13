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
  /** Frontmatter `timestamp` (last content change); null when absent/unparseable. */
  timestamp: string | null;
  /** Frontmatter `last_reviewed` (Resurface stamp); null when never reviewed. */
  lastReviewed: string | null;
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

/** One node's review-relevant fields (Resurface feeds these to the scorer). */
export interface ReviewRow {
  id: string;
  type: string;
  title: string;
  timestamp: string | null;
  lastReviewed: string | null;
  inbox: boolean;
  /** DB-only snooze (`review_state`); gone after a rebuild, by design. */
  snoozeUntil: string | null;
}

/** Vector-store cache key: any change invalidates every stored vector. */
export interface EmbedMeta {
  provider: string;
  model: string;
  dim: number;
}

export interface ChunkVector {
  seq: number;
  text: string;
  vector: number[];
}

export interface VecHit {
  nodeId: string;
  seq: number;
  text: string;
  /** Cosine distance; lower is closer. */
  distance: number;
}

/**
 * Derived vector cache, separate from the keyword index (own DB file): it
 * survives `okb rebuild` (embeddings cost real money) and machines without
 * vector support keep a fully working keyword index. Rebuildable from the
 * bundle via `okb embed` at any time.
 */
export interface VectorStore {
  /** Current cache key; null when nothing was ever embedded. */
  meta(): EmbedMeta | null;
  /** Wipe everything and pin a new cache key (vec table created at `dim`). */
  reset(meta: EmbedMeta): void;
  /** Wipe everything including the key (back to the never-embedded state). */
  clear(): void;
  /** node_id → embed-input hash for every tracked concept (drives skip logic). */
  embeddedHashes(): Map<string, string>;
  /** Atomically swap one concept's chunks (empty = tracked, nothing to embed). */
  replace(nodeId: string, embedHash: string, chunks: ChunkVector[]): void;
  remove(nodeId: string): void;
  /** k nearest chunks by cosine distance; [] when nothing is embedded. */
  search(vector: number[], k?: number): VecHit[];
  /** Total stored chunks. */
  count(): number;
  close(): void;
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
  /** Every node's review fields (Resurface), sorted by id. */
  listReviewRows(): ReviewRow[];
  /** id + resource for every node that has one (clip dedupe), sorted by id. */
  listResources(): { id: string; resource: string }[];
  /** Snooze a concept out of the review queue until `untilIso`. */
  setSnooze(id: string, untilIso: string): void;
  clearSnooze(id: string): void;
  /**
   * Drop all derived state; the next index build repopulates it. Also the
   * only escape from a stale schema: it recreates tables at the current
   * version, so `okb rebuild` works no matter how old the index file is.
   */
  wipe(): void;
  close(): void;
}
