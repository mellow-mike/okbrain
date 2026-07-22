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
import { idToAbsPath, inDbOnlyDir, isReservedName } from "./paths.ts";

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
  /** Extra frontmatter to carry (import path); overrides existing unknown keys, never scaffold keys. */
  extra?: Record<string, unknown>;
  /**
   * Metadata-only write (internal; e.g. Resurface's `last_reviewed` stamp):
   * the existing `timestamp` is kept — it means *content* change — and no
   * log.md entry is appended. Requires the concept to exist.
   */
  metadataOnly?: boolean;
}

export interface WriteResult {
  id: string;
  path: string;
  created: boolean;
  /**
   * True when an update would have produced byte-identical output but for a
   * refreshed `timestamp`, so the write was skipped entirely (see the no-op
   * guard below). Absent on real writes and creates.
   */
  noop?: boolean;
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
  if (input.metadataOnly && !existing)
    throw new OkfWriteError(`metadata-only write requires an existing concept: ${input.id}`);
  const prev = existing?.doc.frontmatter;
  const prevBody = existing?.doc.body ?? "";

  const prevTs = fmString(prev?.timestamp);
  // Canonical key order; unknown keys from the existing doc follow, verbatim.
  const fm: Record<string, unknown> = {
    type: input.type ?? fmString(prev?.type),
    title: input.title ?? fmString(prev?.title),
    description: input.description ?? fmString(prev?.description),
    timestamp: input.metadataOnly && prevTs !== "" ? prevTs : nowTimestamp(),
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
  for (const [k, v] of Object.entries({ ...prev, ...input.extra }))
    if (!SCAFFOLD.has(k)) fm[k] = v;

  let body = normalizeLinks(input.id, input.body ?? prevBody).replace(/\r\n?/g, "\n");
  if (body !== "" && !body.endsWith("\n")) body += "\n";

  // No-op guard: when updating a parseable concept that already carries a
  // timestamp would change nothing on disk except that timestamp's refresh,
  // skip the whole write — no rewrite, no timestamp bump, no log.md entry, no
  // index regeneration. Re-running imports or repeated agent passes over
  // unchanged content then leave no trace in git history (the timestamp means
  // "last content change", so bumping it for an identical file is a lie).
  if (existing !== undefined && prevTs !== "") {
    const asIs = serialize({ frontmatter: { ...fm, timestamp: prevTs }, body });
    if (asIs === existing.raw) return { id: input.id, path, created: false, noop: true };
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialize({ frontmatter: fm, body }), "utf8");
  const dir = posix.dirname(input.id);
  await regenerateIndexes(root, dir === "." ? "" : dir);
  const kind = prev === undefined ? "Creation" : "Update";
  if (!inDbOnlyDir(input.id) && !input.metadataOnly)
    // Private concepts never leak titles into the committed root log.md;
    // metadata-only stamps aren't content changes worth a log entry.
    await appendLog(root, kind, input.id, fm.title as string, fm.description as string);
  return { id: input.id, path, created: prev === undefined };
}
