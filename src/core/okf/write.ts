// Conformance writer (Stage 1.1): every concept write routes through here so
// the bundle stays conformant (CLAUDE.md invariant 1). Emits the full
// frontmatter scaffold (type/title/description/timestamp, plus resource/tags
// when applicable) in canonical key order, preserves unknown keys on edit,
// refreshes timestamp, and normalizes body links to bundle-absolute form.
// Each write also regenerates index.md up the touched dir chain and appends
// a log.md entry (Stage 1.2).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { normalizeLinks } from "../graph/links.ts";
import { readConceptPermissive } from "./bundle.ts";
import { fmString, serialize } from "./document.ts";
import { regenerateIndexes } from "./indexmd.ts";
import { appendLog } from "./logmd.ts";
import { idToAbsPath, isReservedName } from "./paths.ts";

export class OkfWriteError extends Error {}

export interface WriteConceptInput {
  id: string;
  type?: string;
  title?: string;
  description?: string;
  resource?: string;
  /** `[]` removes existing tags; undefined keeps them. */
  tags?: string[];
  /** Markdown body; undefined keeps the existing body on update. */
  body?: string;
}

export interface WriteResult {
  id: string;
  path: string;
  created: boolean;
}

/** Emitted `timestamp` format: ISO 8601 UTC, second precision. */
export const nowTimestamp = (): string =>
  new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const SCAFFOLD = new Set(["type", "title", "description", "timestamp", "resource", "tags"]);

/** Create or update one concept. Returns the written path and created flag. */
export async function writeConcept(
  root: string,
  input: WriteConceptInput,
): Promise<WriteResult> {
  const path = idToAbsPath(root, input.id); // validates the id
  if (isReservedName(posix.basename(input.id) + ".md"))
    throw new OkfWriteError(
      `${input.id} is a reserved file, not a concept; index.md/log.md are maintained by okbrain`,
    );

  let existing;
  try {
    existing = await readConceptPermissive(root, input.id);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing && !existing.parsed)
    throw new OkfWriteError(
      `refusing to overwrite ${input.id}: its frontmatter is unparseable (see okb doctor)`,
    );
  const prev = existing?.doc.frontmatter;
  const prevBody = existing?.doc.body ?? "";

  // Canonical key order; unknown keys from the existing doc follow, verbatim.
  const fm: Record<string, unknown> = {
    type: input.type ?? fmString(prev?.type),
    title: input.title ?? fmString(prev?.title),
    description: input.description ?? fmString(prev?.description),
    timestamp: nowTimestamp(),
  };
  for (const k of ["type", "title", "description"] as const)
    if ((fm[k] as string).trim() === "")
      throw new OkfWriteError(
        `${k} is required (conformant writes always carry type/title/description)`,
      );
  const resource = input.resource ?? prev?.resource;
  if (resource !== undefined && resource !== "") fm.resource = resource;
  const tags = input.tags ?? prev?.tags;
  if (Array.isArray(tags) ? tags.length > 0 : tags !== undefined) fm.tags = tags;
  for (const [k, v] of Object.entries(prev ?? {}))
    if (!SCAFFOLD.has(k)) fm[k] = v;

  let body = normalizeLinks(input.id, input.body ?? prevBody).replace(/\r\n?/g, "\n");
  if (body !== "" && !body.endsWith("\n")) body += "\n";

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialize({ frontmatter: fm, body }), "utf8");
  const dir = posix.dirname(input.id);
  await regenerateIndexes(root, dir === "." ? "" : dir);
  const kind = prev === undefined ? "Creation" : "Update";
  await appendLog(root, kind, input.id, fm.title as string, fm.description as string);
  return { id: input.id, path, created: prev === undefined };
}
