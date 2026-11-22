// Bundle → engine index build. Idempotent: unchanged files (by content hash)
// skip node writes, vanished concepts are removed, and the edge set is replaced
// wholesale from freshly extracted links. All extracted edges are stored —
// including dangling ones (target concept doesn't exist yet); the engine's
// queries resolve against nodes, so a dangling edge surfaces on its own once
// its target is written, which is what makes `updateIndexFor` sound.
// Permissive on read: a concept with unparseable frontmatter is still indexed
// (empty frontmatter, raw text as body) so search never loses it — `okb
// doctor` is where it gets flagged.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathFieldCandidates, sourceTargets } from "../graph/links.ts";
import { classifyTargets, type TypedTarget } from "../graph/typed-edges.ts";
import { log } from "../log.ts";
import { listConcepts, readConceptPermissive, type PermissiveConcept } from "../okf/bundle.ts";
import {
  fmSources,
  fmStatus,
  fmString,
  fmTags,
  generatedAt,
  isIsoInstant,
  lastVerifiedAt,
  trustTier,
  type OkfDocument,
} from "../okf/document.ts";
import type { EdgeRecord, IndexEngine } from "./interface.ts";

export interface IndexStats {
  indexed: number;
  skipped: number;
  removed: number;
  /** Resolved edges (both endpoints indexed) after the build. */
  edges: number;
}

const indexWrites = new Map<string, Promise<void>>();

/** Keep whole index passes and point updates from interleaving in this process. */
export function withIndexWrite<T>(root: string, write: () => T | Promise<T>): Promise<T> {
  const path = realpathSync(root);
  const result = (indexWrites.get(path) ?? Promise.resolve()).then(write);
  const release = result.then(() => {}, () => {});
  indexWrites.set(path, release);
  void release.then(() => {
    if (indexWrites.get(path) === release) indexWrites.delete(path);
  });
  return result;
}

const hashOf = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");

async function upsertConcept(engine: IndexEngine, { id, doc, parsed }: PermissiveConcept, hash: string): Promise<void> {
  if (!parsed) log.warn("indexing concept with unparseable frontmatter", { id });
  const fm = doc.frontmatter;
  await engine.upsertNode({
    id,
    type: fmString(fm.type),
    title: fmString(fm.title),
    description: fmString(fm.description),
    resource: typeof fm.resource === "string" ? fm.resource : null,
    timestamp: generatedAt(fm),
    lastReviewed: lastVerifiedAt(fm, true) ?? (fmString(fm.last_reviewed) || null),
    status: fmStatus(fm),
    staleAfter: isIsoInstant(fm.stale_after) ? fm.stale_after : null,
    trust: trustTier(fm),
    bodyLen: doc.body.length,
    contentHash: hash,
    body: doc.body,
    tags: fmTags(fm.tags),
  });
}

/**
 * Outgoing typed targets: body links (classified), then `sources` provenance
 * edges typed `cites` — minus self-links (dangling targets kept; see header).
 */
function outgoing(id: string, doc: OkfDocument, sources: (string | null)[]): TypedTarget[] {
  const out = classifyTargets(id, doc.body);
  const seen = new Set(out.map((t) => t.dst));
  for (const dst of sources) {
    if (dst === null || seen.has(dst)) continue;
    seen.add(dst);
    out.push({ dst, rel: "cites" });
  }
  return out.filter((t) => t.dst !== id);
}

/** (Re)index the bundle at `root` into `engine`. Safe to run repeatedly. */
export function buildIndex(root: string, engine: IndexEngine): Promise<IndexStats> {
  const run = (index: IndexEngine) => reconcileIndex(root, index);
  return engine.batch ? engine.batch(run) : run(engine);
}

async function reconcileIndex(root: string, engine: IndexEngine): Promise<IndexStats> {
  const ids = await listConcepts(root);
  const known = new Set(ids);
  const have = await engine.contentHashes();
  const edges: EdgeRecord[] = [];
  let indexed = 0;
  let skipped = 0;

  for (const id of ids) {
    const concept = await readConceptPermissive(root, id);
    const sources = sourceTargets(id, concept.doc.frontmatter, known);
    for (const t of outgoing(id, concept.doc, sources)) edges.push({ src: id, dst: t.dst, rel: t.rel });

    const hash = hashOf(concept.raw);
    if (have.get(id) === hash) {
      skipped++;
      continue;
    }
    await upsertConcept(engine, concept, hash);
    indexed++;
  }

  let removed = 0;
  for (const id of have.keys()) {
    if (known.has(id)) continue;
    await engine.removeNode(id);
    removed++;
  }

  await engine.replaceEdges(edges);
  return { indexed, skipped, removed, edges: (await engine.listEdges()).length };
}

/** Refresh one concept in an existing index after a write (node + its out-edges). */
export function updateIndexFor(root: string, id: string, engine: IndexEngine): Promise<void> {
  const run = (index: IndexEngine) => reconcileConcept(root, id, index);
  return engine.batch ? engine.batch(run) : run(engine);
}

async function reconcileConcept(root: string, id: string, engine: IndexEngine): Promise<void> {
  const concept = await readConceptPermissive(root, id);
  await upsertConcept(engine, concept, hashOf(concept.raw));
  const sources = await Promise.all(fmSources(concept.doc.frontmatter).map(async ({ resource }) => {
    const target = pathFieldCandidates(id, resource);
    if (!target) return null;
    const { relative, root } = target;
    return root !== undefined && !(await engine.hasNode(relative)) && (await engine.hasNode(root)) ? root : relative;
  }));
  await engine.replaceEdgesFor(id, outgoing(id, concept.doc, sources));
}
