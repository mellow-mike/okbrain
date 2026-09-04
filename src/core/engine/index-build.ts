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
import { sourceTargets } from "../graph/links.ts";
import { classifyTargets, type TypedTarget } from "../graph/typed-edges.ts";
import { log } from "../log.ts";
import { listConcepts, readConceptPermissive, type PermissiveConcept } from "../okf/bundle.ts";
import {
  fmStatus,
  fmString,
  fmTags,
  generatedAt,
  isIsoInstant,
  lastVerifiedAt,
  trustTier,
  type OkfDocument,
} from "../okf/document.ts";
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
function outgoing(id: string, doc: OkfDocument, known: Set<string>): TypedTarget[] {
  const out = classifyTargets(id, doc.body);
  const seen = new Set(out.map((t) => t.dst));
  for (const dst of sourceTargets(id, doc.frontmatter, known))
    if (!seen.has(dst)) out.push({ dst, rel: "cites" });
  return out.filter((t) => t.dst !== id);
}

/** (Re)index the bundle at `root` into `engine`. Safe to run repeatedly. */
export async function buildIndex(root: string, engine: Engine): Promise<IndexStats> {
  const ids = await listConcepts(root);
  const known = new Set(ids);
  const have = engine.contentHashes();
  const edges: EdgeRecord[] = [];
  let indexed = 0;
  let skipped = 0;

  for (const id of ids) {
    const concept = await readConceptPermissive(root, id);
    for (const t of outgoing(id, concept.doc, known)) edges.push({ src: id, dst: t.dst, rel: t.rel });

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
  engine.replaceEdgesFor(id, outgoing(id, concept.doc, new Set([...engine.listNodeIds(), id])));
}
