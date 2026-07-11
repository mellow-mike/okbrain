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
import { extractTargets } from "../graph/links.ts";
import { log } from "../log.ts";
import { listConcepts, readConceptPermissive, type PermissiveConcept } from "../okf/bundle.ts";
import { fmString, fmTags } from "../okf/document.ts";
import type { EdgeRecord, Engine } from "./interface.ts";

export interface IndexStats {
  indexed: number;
  skipped: number;
  removed: number;
  /** Resolved edges (both endpoints indexed) after the build. */
  edges: number;
}

const hashOf = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");

function upsertConcept(engine: Engine, { id, doc, parsed }: PermissiveConcept, hash: string): void {
  if (!parsed) log.warn("indexing concept with unparseable frontmatter", { id });
  const fm = doc.frontmatter;
  engine.upsertNode({
    id,
    type: fmString(fm.type),
    title: fmString(fm.title),
    description: fmString(fm.description),
    resource: typeof fm.resource === "string" ? fm.resource : null,
    timestamp: fmString(fm.timestamp) || null,
    lastReviewed: fmString(fm.last_reviewed) || null,
    bodyLen: doc.body.length,
    contentHash: hash,
    body: doc.body,
    tags: fmTags(fm.tags),
  });
}

/** Extracted targets minus self-links (dangling targets kept; see header). */
const outgoing = (id: string, body: string): string[] =>
  extractTargets(id, body).filter((dst) => dst !== id);

/** (Re)index the bundle at `root` into `engine`. Safe to run repeatedly. */
export async function buildIndex(root: string, engine: Engine): Promise<IndexStats> {
  const ids = await listConcepts(root);
  const have = engine.contentHashes();
  const edges: EdgeRecord[] = [];
  let indexed = 0;
  let skipped = 0;

  for (const id of ids) {
    const concept = await readConceptPermissive(root, id);
    for (const dst of outgoing(id, concept.doc.body)) edges.push({ src: id, dst });

    const hash = hashOf(concept.raw);
    if (have.get(id) === hash) {
      skipped++;
      continue;
    }
    upsertConcept(engine, concept, hash);
    indexed++;
  }

  const current = new Set(ids);
  let removed = 0;
  for (const id of have.keys()) {
    if (current.has(id)) continue;
    engine.removeNode(id);
    removed++;
  }

  engine.replaceEdges(edges);
  return { indexed, skipped, removed, edges: engine.listEdges().length };
}

/** Refresh one concept in an existing index after a write (node + its out-edges). */
export async function updateIndexFor(root: string, id: string, engine: Engine): Promise<void> {
  const concept = await readConceptPermissive(root, id);
  upsertConcept(engine, concept, hashOf(concept.raw));
  engine.replaceEdgesFor(id, outgoing(id, concept.doc.body));
}
