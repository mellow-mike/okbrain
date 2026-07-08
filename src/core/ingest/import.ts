// Bulk import (Stage 1.3): map existing markdown (a file or a directory tree)
// onto OKF concepts through the conformance writer. Ids mirror the source's
// relative layout with each segment slugified; frontmatter is filled from the
// source where present and derived from the body otherwise; unknown source
// keys are carried into the concept. Dedupe is by id: existing concepts are
// skipped unless `overwrite`, and two sources mapping to one id keep the first.

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { listMdFiles } from "../okf/bundle.ts";
import { fmString, fmTags, OkfParseError, parse, type OkfDocument } from "../okf/document.ts";
import { idToAbsPath, InvalidIdError, isReservedName, slugify } from "../okf/paths.ts";
import { OkfWriteError, writeConcept } from "../okf/write.ts";
import { clip } from "./capture.ts";

export interface ImportInput {
  path: string;
  /** Fallback `type` when the source has none (default `note`). */
  type?: string;
  /** Directory prefix inside the bundle for all imported ids. */
  dest?: string;
  /** Update concepts whose id already exists instead of skipping them. */
  overwrite?: boolean;
}

export interface ImportResult {
  imported: string[];
  skipped: { path: string; reason: string }[];
}

const relPathToSlugId = (relPath: string): string =>
  relPath.replace(/\.md$/, "").split("/").map(slugify).join("/");

const deriveTitle = (body: string, relPath: string): string =>
  (/^#\s+(.+)$/m.exec(body)?.[1] ?? "").trim() || basename(relPath, ".md");

function deriveDescription(body: string, relPath: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "" && !/^(#|---)/.test(l.trim()));
  return line ? clip(line.trim(), 120) : `Imported from ${relPath}`;
}

export async function importPath(root: string, input: ImportInput): Promise<ImportResult> {
  const src = resolve(input.path);
  const st = await stat(src).catch(() => null);
  if (!st) throw new OkfWriteError(`import path not found: ${input.path}`);
  if (st.isFile() && !src.endsWith(".md"))
    throw new OkfWriteError(`not a markdown file: ${input.path}`);

  const files = st.isFile()
    ? [basename(src)]
    : (await listMdFiles(src)).filter((p) => !isReservedName(basename(p)));
  const srcDir = st.isFile() ? resolve(src, "..") : src;

  const result: ImportResult = { imported: [], skipped: [] };
  const claimed = new Set<string>();
  for (const relPath of files) {
    let id: string;
    try {
      id = input.dest ? `${input.dest}/${relPathToSlugId(relPath)}` : relPathToSlugId(relPath);
    } catch (e) {
      if (!(e instanceof InvalidIdError)) throw e;
      result.skipped.push({ path: relPath, reason: e.message });
      continue;
    }
    if (claimed.has(id)) {
      result.skipped.push({ path: relPath, reason: `id collision with another import: ${id}` });
      continue;
    }
    claimed.add(id);
    if (!input.overwrite && existsSync(idToAbsPath(root, id))) {
      result.skipped.push({ path: relPath, reason: `concept exists: ${id} (use --overwrite)` });
      continue;
    }
    const raw = await readFile(resolve(srcDir, ...relPath.split("/")), "utf8");
    let doc: OkfDocument;
    try {
      doc = parse(raw);
    } catch (e) {
      if (!(e instanceof OkfParseError)) throw e;
      doc = { frontmatter: {}, body: raw }; // permissive: keep it all as body
    }
    const fm = doc.frontmatter;
    const tags = fmTags(fm.tags);
    await writeConcept(root, {
      id,
      type: fmString(fm.type) || input.type || "note",
      title: fmString(fm.title) || deriveTitle(doc.body, relPath),
      description: fmString(fm.description) || deriveDescription(doc.body, relPath),
      body: doc.body,
      resource: fmString(fm.resource) || undefined,
      tags: tags.length > 0 ? tags : undefined,
      extra: fm,
    });
    result.imported.push(id);
  }
  return result;
}
