// Conformance writer (Stage 1.1): every concept write goes through here so the
// bundle stays OKF-conformant — frontmatter scaffold (type/title/description/
// timestamp), unknown keys preserved on edit, internal links normalized to
// bundle-absolute, UTF-8 LF output. A byte-identical write is a no-op (the
// timestamp only refreshes on meaningful change).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { LINK, resolveLinkTarget } from "../graph/links.ts";
import { OkfParseError, parse, serialize, type OkfDocument } from "./document.ts";
import { idToAbsPath, InvalidIdError, isReservedName, validateId } from "./paths.ts";

export class WriteRefusedError extends Error {}

export interface WriteParams {
  id: string;
  /** Required when creating; optional (retype) on edit. */
  type?: string;
  title?: string;
  description?: string;
  /** Replaces the whole body; omitted = keep the existing body. */
  body?: string;
}

export interface WriteResult {
  id: string;
  created: boolean;
  /** False when the write was a byte-identical no-op (file untouched). */
  changed: boolean;
}

/**
 * Rewrite internal `.md` link targets to bundle-absolute (`/dir/x.md`) form,
 * preserving fragments and link titles. External/anchor/non-`.md` targets and
 * links that escape the bundle root pass through untouched. Pure, idempotent.
 */
export function normalizeLinks(srcId: string, body: string): string {
  return body.replace(LINK, (match, raw: string) => {
    const id = resolveLinkTarget(srcId, raw);
    if (id === null) return match;
    let t = raw.trim();
    let title = "";
    if (t.startsWith("<") && t.includes(">")) {
      title = t.slice(t.indexOf(">") + 1).trim();
      t = t.slice(1, t.indexOf(">"));
    } else {
      const sp = t.search(/\s/);
      if (sp >= 0) {
        title = t.slice(sp + 1).trim();
        t = t.slice(0, sp);
      }
    }
    const hash = t.indexOf("#");
    const target = `/${id}.md${hash >= 0 ? t.slice(hash) : ""}`;
    const wrapped = /[\s()]/.test(target) ? `<${target}>` : target;
    return `](${wrapped}${title ? ` ${title}` : ""})`;
  });
}

const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Create or update one concept conformantly. Parent directories are created. */
export async function writeConcept(
  root: string,
  p: WriteParams,
  now = new Date(),
): Promise<WriteResult> {
  validateId(p.id);
  if (isReservedName(`${posix.basename(p.id)}.md`))
    throw new InvalidIdError(`reserved filename cannot be a concept: ${p.id}.md`);

  const abs = idToAbsPath(root, p.id);
  let raw: string | null = null;
  try {
    raw = await readFile(abs, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let existing: OkfDocument | null = null;
  if (raw !== null) {
    try {
      existing = parse(raw);
    } catch (e) {
      if (!(e instanceof OkfParseError)) throw e;
      throw new WriteRefusedError(
        `refusing to edit ${p.id}: unparseable frontmatter (fix it by hand; see okb doctor)`,
      );
    }
  }

  let fm: Record<string, unknown>;
  if (existing) {
    fm = { ...existing.frontmatter }; // unknown keys + key order preserved
    if (p.type !== undefined) fm.type = p.type;
    if (p.title !== undefined) fm.title = p.title;
    if (p.description !== undefined) fm.description = p.description;
  } else {
    if (!p.type) throw new WriteRefusedError(`creating ${p.id} requires --type`);
    fm = {
      type: p.type,
      title: p.title ?? posix.basename(p.id),
      description: p.description ?? "",
      timestamp: "",
    };
  }

  let body = normalizeLinks(p.id, p.body ?? existing?.body ?? "");
  if (body !== "" && !body.endsWith("\n")) body += "\n";

  // No meaningful change (old timestamp still in fm) → leave the file alone.
  if (existing && serialize({ frontmatter: fm, body }) === raw)
    return { id: p.id, created: false, changed: false };

  fm.timestamp = isoSeconds(now);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, serialize({ frontmatter: fm, body }), "utf8");
  return { id: p.id, created: existing === null, changed: true };
}
