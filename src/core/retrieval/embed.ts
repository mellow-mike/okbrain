// Embed pipeline (2.2): bundle → chunks → gateway.embed → vector store.
// Independent of the keyword index — it walks the bundle itself, so `okb
// embed` works with or without `okb index`. Incremental by content hash over
// exactly what feeds the embedding (title, description, body — NOT raw
// frontmatter, so metadata-only stamps like last_reviewed never re-embed).
// The store's cache key is (provider, model, dim): a key change triggers a
// full reset here; the write hook (embedConcept) only ever refreshes under a
// matching key and leaves resets to `okb embed`.

import { createHash } from "node:crypto";
import type { AiOptions } from "../ai/gateway.ts";
import { createGateway, resolveCall } from "../ai/gateway.ts";
import type { AiSettings } from "../config.ts";
import type { VectorStore } from "../engine/interface.ts";
import { VecError } from "../engine/vectors.ts";
import { listConcepts, readConceptPermissive } from "../okf/bundle.ts";
import { fmString, type OkfDocument } from "../okf/document.ts";
import { chunkText, type Chunk } from "./chunk.ts";

/** What the pipeline needs from AI: a pinned identity plus the embed call. */
export interface Embedder {
  provider: string;
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Resolve the configured embed provider/model once and wrap the gateway. */
export function gatewayEmbedder(ai: AiSettings, opts: AiOptions = {}): Embedder {
  const r = resolveCall("embed", ai, process.env, opts);
  const gw = createGateway(ai);
  return {
    provider: r.provider,
    model: r.model,
    embed: async (texts) => (await gw.embed(texts, opts)).vectors,
  };
}

export interface EmbedStats {
  /** Concepts (re)embedded this run. */
  embedded: number;
  /** Chunks stored this run. */
  chunks: number;
  /** Concepts skipped as unchanged. */
  skipped: number;
  /** Stale concepts removed from the store. */
  removed: number;
  /** Changed concepts left for a later run (--limit). */
  pending: number;
  provider: string;
  model: string;
  dim: number | null;
  /** True when the cache key changed and the store was rebuilt from scratch. */
  reset: boolean;
}

export interface EmbedOptions {
  /** Max concepts to (re)embed this run (paces API spend). */
  limit?: number;
  /** Texts per embed call. */
  batchSize?: number;
}

interface Job {
  id: string;
  hash: string;
  chunks: Chunk[];
  /** Embedding inputs, one per chunk: title-prefixed chunk text. */
  inputs: string[];
  vectors: number[][];
}

/** Chunks + inputs + the hash of everything that feeds them. */
function prepare(doc: OkfDocument): Omit<Job, "id" | "vectors"> {
  const title = fmString(doc.frontmatter.title);
  const description = fmString(doc.frontmatter.description);
  const hash = createHash("sha256")
    .update(JSON.stringify([title, description, doc.body]), "utf8")
    .digest("hex");
  // An empty body still deserves a vector — title/description carry meaning.
  const chunks = chunkText(doc.body.trim() !== "" ? doc.body : description || title);
  return {
    hash,
    chunks,
    inputs: chunks.map((c) => (title !== "" ? `${title}\n\n${c.text}` : c.text)),
  };
}

/** (Re)embed the bundle at `root` into `store`. Incremental; safe to re-run. */
export async function embedBundle(
  root: string,
  store: VectorStore,
  emb: Embedder,
  opts: EmbedOptions = {},
): Promise<EmbedStats> {
  const batchSize = opts.batchSize ?? 32;
  const ids = await listConcepts(root);
  const meta = store.meta();
  const needReset = meta === null || meta.provider !== emb.provider || meta.model !== emb.model;
  const have = needReset ? new Map<string, string>() : store.embeddedHashes();

  // Drop concepts that vanished from the bundle (reset wipes everything anyway).
  let removed = 0;
  if (!needReset) {
    const current = new Set(ids);
    for (const id of have.keys())
      if (!current.has(id)) {
        store.remove(id);
        removed++;
      }
  }

  const jobs: Job[] = [];
  let skipped = 0;
  for (const id of ids) {
    const { doc } = await readConceptPermissive(root, id);
    const p = prepare(doc);
    if (have.get(id) === p.hash) {
      skipped++;
      continue;
    }
    jobs.push({ id, ...p, vectors: [] });
  }
  const run = jobs.slice(0, opts.limit ?? jobs.length);

  let dim = meta?.dim ?? null;
  let didReset = false;
  let embedded = 0;
  let storedChunks = 0;
  const flush = (job: Job) => {
    store.replace(
      job.id,
      job.hash,
      job.chunks.map((c, i) => ({ ...c, vector: job.vectors[i]! })),
    );
    embedded++;
    storedChunks += job.chunks.length;
  };

  const queue = run.flatMap((job) => job.inputs.map((input) => ({ job, input })));
  for (let i = 0; i < queue.length; i += batchSize) {
    const batch = queue.slice(i, i + batchSize);
    const vectors = await emb.embed(batch.map((b) => b.input));
    const d = vectors[0]!.length;
    if (needReset && !didReset) {
      store.reset({ provider: emb.provider, model: emb.model, dim: d });
      didReset = true;
      dim = d;
    } else if (d !== dim) {
      throw new VecError(
        `${emb.provider}/${emb.model} returned ${d}-dim vectors but the store holds ${dim}-dim — run \`okb embed\` again to rebuild`,
      );
    }
    batch.forEach((b, j) => b.job.vectors.push(vectors[j]!));
    for (const job of new Set(batch.map((b) => b.job)))
      if (job.vectors.length === job.inputs.length) flush(job);
  }

  // Nothing produced text this run: a pending reset still must invalidate the
  // old key (we never learned a dim, so back to the never-embedded state).
  if (needReset && !didReset && queue.length === 0) {
    store.clear();
    didReset = true;
  }
  for (const job of run) if (job.inputs.length === 0) flush(job);

  return {
    embedded,
    chunks: storedChunks,
    skipped,
    removed,
    pending: jobs.length - run.length,
    provider: emb.provider,
    model: emb.model,
    dim: store.meta()?.dim ?? dim,
    reset: needReset && didReset,
  };
}

/**
 * Write-hook: refresh one concept's vectors after a write. Only acts when the
 * store's cache key matches the configured embedder (resets belong to `okb
 * embed`) and the concept actually changed. Returns whether it embedded.
 */
export async function embedConcept(
  root: string,
  id: string,
  store: VectorStore,
  emb: Embedder,
): Promise<boolean> {
  const meta = store.meta();
  if (meta === null || meta.provider !== emb.provider || meta.model !== emb.model) return false;
  const { doc } = await readConceptPermissive(root, id);
  const p = prepare(doc);
  if (store.embeddedHashes().get(id) === p.hash) return false;
  let vectors: number[][] = [];
  if (p.inputs.length > 0) {
    vectors = await emb.embed(p.inputs);
    if (vectors[0]!.length !== meta.dim)
      throw new VecError(
        `${emb.provider}/${emb.model} returned ${vectors[0]!.length}-dim vectors but the store holds ${meta.dim}-dim`,
      );
  }
  store.replace(id, p.hash, p.chunks.map((c, i) => ({ ...c, vector: vectors[i]! })));
  return true;
}
