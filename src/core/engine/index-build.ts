// Bundle → engine index build. Idempotent: unchanged files (by content hash)
// skip node writes, vanished concepts are removed, and the edge set is replaced
// wholesale from freshly extracted links. Permissive on read: a concept with
// unparseable frontmatter is still indexed (empty frontmatter, raw text as
// body) so search never loses it — `okb doctor` is where it gets flagged.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildEdges } from "../graph/links.ts";
import { log } from "../log.ts";
import { listConcepts } from "../okf/bundle.ts";
import { OkfParseError, parse, type OkfDocument } from "../okf/document.ts";
import { idToAbsPath } from "../okf/paths.ts";
import type { Engine } from "./interface.ts";

export interface IndexStats {
  indexed: number;
  skipped: number;
  removed: number;
  edges: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function tagList(v: unknown): string[] {
  if (typeof v === "string" && v.trim() !== "") return [v];
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string");
  return [];
}

/** (Re)index the bundle at `root` into `engine`. Safe to run repeatedly. */
export async function buildIndex(root: string, engine: Engine): Promise<IndexStats> {
  const ids = await listConcepts(root);
  const have = engine.contentHashes();
  const docs: { id: string; body: string }[] = [];
  let indexed = 0;
  let skipped = 0;

  for (const id of ids) {
    const raw = await readFile(idToAbsPath(root, id), "utf8");
    let doc: OkfDocument;
    try {
      doc = parse(raw);
    } catch (e) {
      if (!(e instanceof OkfParseError)) throw e;
      log.warn("indexing concept with unparseable frontmatter", { id });
      doc = { frontmatter: {}, body: raw };
    }
    docs.push({ id, body: doc.body });

    const hash = createHash("sha256").update(raw, "utf8").digest("hex");
    if (have.get(id) === hash) {
      skipped++;
      continue;
    }
    const fm = doc.frontmatter;
    engine.upsertNode({
      id,
      type: str(fm.type),
      title: str(fm.title),
      description: str(fm.description),
      resource: typeof fm.resource === "string" ? fm.resource : null,
      bodyLen: doc.body.length,
      contentHash: hash,
      body: doc.body,
      tags: tagList(fm.tags),
    });
    indexed++;
  }

  const current = new Set(ids);
  let removed = 0;
  for (const id of have.keys()) {
    if (current.has(id)) continue;
    engine.removeNode(id);
    removed++;
  }

  const edges = buildEdges(docs);
  engine.replaceEdges(edges);
  return { indexed, skipped, removed, edges: edges.length };
}
