// Conformance writer: every concept write routes through here so the bundle
// stays conformant OKF v0.2 (CLAUDE.md invariant 1). Emits the scaffold
// (type/title/description, plus resource/tags when applicable) and the v0.2
// families — `generated` (who changed the content, when), `verified` events,
// `status`, `stale_after`, `sources` — in canonical key order, preserves
// unknown keys on edit, and normalizes body links to bundle-absolute form.
// Legacy v0.1 keys (`timestamp`, `last_reviewed`) are superseded in place
// when their v0.2 counterpart is written. Each write also regenerates
// index.md up the touched dir chain and appends a log.md entry (Stage 1.2).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { resolveActor } from "../config.ts";
import { normalizeLinks } from "../graph/links.ts";
import { readConceptPermissive } from "./bundle.ts";
import {
  fmGenerated,
  fmString,
  isActor,
  isIsoInstant,
  normalizeVerified,
  serialize,
  STATUSES,
  type ActorEvent,
  type SourceEntry,
} from "./document.ts";
import { regenerateIndexes } from "./indexmd.ts";
import { appendLog } from "./logmd.ts";
import { idToAbsPath, inDbOnlyDir, isReservedName, slugify } from "./paths.ts";

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
  /** Lifecycle status (§5.4): draft | stable | deprecated; `""` removes the key. */
  status?: string;
  /** ISO instant after which the content is stale (§5.5); `""` removes it. */
  staleAfter?: string;
  /** Provenance entries (§5.1); `[]` removes them; missing `id`s are assigned. */
  sources?: SourceEntry[];
  /** Actor (§7) recorded as `generated.by` on content writes; default: the configured local actor. */
  actor?: string;
  /** Explicit `generated` event (imports carrying a foreign doc's provenance, upgrades). */
  generated?: ActorEvent;
  /** Replace the whole `verified` list (imports/upgrades); `verify` appends one event. */
  verified?: ActorEvent[];
  /** Record one verification event; an earlier event by the same actor is replaced. */
  verify?: ActorEvent;
  /**
   * Extra frontmatter to carry (import path); overrides existing unknown keys,
   * never scaffold keys. A key set to `undefined` is removed from the doc.
   */
  extra?: Record<string, unknown>;
  /**
   * Metadata-only write (internal; e.g. marking read, a verification stamp):
   * `generated` is kept — it means *content* change — and no log.md entry is
   * appended. Requires the concept to exist.
   */
  metadataOnly?: boolean;
}

export interface WriteResult {
  id: string;
  path: string;
  created: boolean;
  /**
   * True when an update would have produced byte-identical output but for a
   * refreshed `generated` event, so the write was skipped entirely (see the
   * no-op guard below). Absent on real writes and creates.
   */
  noop?: boolean;
}

/** Emitted instant format: ISO 8601 UTC, second precision. */
export const nowTimestamp = (): string =>
  new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const SCAFFOLD = new Set([
  "type", "title", "description", "resource", "tags",
  "status", "generated", "verified", "stale_after", "sources",
]);

const requireActor = (actor: string, what: string): string => {
  if (!isActor(actor))
    throw new OkfWriteError(
      `${what} must follow the OKF actor convention (human:<id>, process:<id>, or <producer>/<version>): ${actor}`,
    );
  return actor;
};

/** A short stable id for a source: its host, its file name, or `source`. */
function sourceIdFor(s: SourceEntry): string {
  try {
    return slugify(new URL(s.resource).hostname);
  } catch {
    /* not a URL */
  }
  try {
    return slugify(posix.basename(s.resource).replace(/\.md$/, ""));
  } catch {
    return "source";
  }
}

/** Validate `sources` entries and assign missing ids (unique within the doc). */
export function normalizeSources(sources: SourceEntry[]): SourceEntry[] {
  const used = new Set<string>();
  return sources.map((s) => {
    if (typeof s.resource !== "string" || s.resource.trim() === "")
      throw new OkfWriteError("every sources entry needs a resource (URL, bundle path, or scope descriptor)");
    if (s.last_modified !== undefined && !isIsoInstant(s.last_modified))
      throw new OkfWriteError(`sources.last_modified must be an ISO 8601 instant with offset: ${String(s.last_modified)}`);
    const base = typeof s.id === "string" && s.id !== "" ? s.id : sourceIdFor(s);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    const out: SourceEntry = { id, resource: s.resource.trim() };
    for (const [k, v] of Object.entries(s))
      if (k !== "id" && k !== "resource" && v !== undefined && v !== null && v !== "") out[k] = v;
    return out;
  });
}

const event = (e: ActorEvent): ActorEvent =>
  e.at === undefined ? { by: e.by } : { by: e.by, at: e.at };

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
  const prev = existing?.doc.frontmatter ?? {};
  const prevBody = existing?.doc.body ?? "";

  // Canonical key order; unknown keys from the existing doc follow, verbatim.
  const fm: Record<string, unknown> = {
    type: input.type ?? fmString(prev.type),
    title: input.title ?? fmString(prev.title),
    description: input.description ?? fmString(prev.description),
  };
  for (const k of ["type", "title", "description"] as const)
    if ((fm[k] as string).trim() === "")
      throw new OkfWriteError(
        `${k} is required (conformant writes always carry type/title/description)`,
      );
  const resource = input.resource ?? prev.resource;
  if (resource !== undefined && resource !== "") fm.resource = resource;
  const tags = input.tags ?? prev.tags;
  if (Array.isArray(tags) ? tags.length > 0 : tags !== undefined) fm.tags = tags;

  if (input.status !== undefined && input.status !== "" && !(STATUSES as readonly string[]).includes(input.status))
    throw new OkfWriteError(`status must be one of ${STATUSES.join(", ")}: ${input.status}`);
  const status = input.status === undefined ? prev.status : input.status || undefined;
  if (status !== undefined) fm.status = status;

  // `generated` (§5.2): a content write is a new event by `actor`; metadata-only
  // writes keep the existing one (a legacy v0.1 `timestamp` is left in place —
  // `okb upgrade` converts it with a stated actor).
  const prevGen = fmGenerated(prev);
  let generated: ActorEvent | undefined;
  if (input.generated) generated = event({ ...input.generated, by: requireActor(input.generated.by, "generated.by") });
  else if (input.metadataOnly) generated = prevGen ?? undefined;
  else generated = { by: requireActor(input.actor ?? resolveActor(), "actor"), at: nowTimestamp() };
  if (generated) fm.generated = generated;

  let verified = input.verified ? input.verified.map(event) : normalizeVerified(prev);
  if (input.verify) {
    const ev = event({ by: requireActor(input.verify.by, "verify.by"), at: input.verify.at ?? nowTimestamp() });
    verified = [...verified.filter((e) => e.by !== ev.by), ev];
  }
  if (verified.length > 0) fm.verified = verified;

  if (input.staleAfter !== undefined && input.staleAfter !== "" && !isIsoInstant(input.staleAfter))
    throw new OkfWriteError(`stale_after must be an ISO 8601 instant with offset (e.g. 2026-12-31T00:00:00Z): ${input.staleAfter}`);
  const staleAfter = input.staleAfter === undefined ? prev.stale_after : input.staleAfter || undefined;
  if (staleAfter !== undefined) fm.stale_after = staleAfter;

  const sources =
    input.sources === undefined
      ? prev.sources
      : input.sources.length === 0
        ? undefined
        : normalizeSources(input.sources);
  if (sources !== undefined) fm.sources = sources;

  // Legacy v0.1 keys are superseded the moment their v0.2 counterpart is
  // written by this call; otherwise they pass through like any unknown key.
  const supersededTs = generated !== undefined && (input.generated !== undefined || !input.metadataOnly);
  for (const [k, v] of Object.entries({ ...prev, ...input.extra })) {
    if (SCAFFOLD.has(k) || v === undefined) continue;
    if (k === "timestamp" && supersededTs) continue;
    if (k === "last_reviewed" && (input.verify !== undefined || input.verified !== undefined)) continue;
    fm[k] = v;
  }

  let body = normalizeLinks(input.id, input.body ?? prevBody).replace(/\r\n?/g, "\n");
  if (body !== "" && !body.endsWith("\n")) body += "\n";

  // No-op guard: when updating a parseable concept would change nothing on
  // disk except a refreshed `generated` event, skip the whole write — no
  // rewrite, no bump, no log.md entry, no index regeneration. Re-running
  // imports or repeated agent passes over unchanged content then leave no
  // trace in git history ("last content change" stays truthful).
  if (existing !== undefined && prevGen !== null) {
    const asIs = serialize({ frontmatter: { ...fm, generated: event(prevGen) }, body });
    if (asIs === existing.raw) return { id: input.id, path, created: false, noop: true };
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialize({ frontmatter: fm, body }), "utf8");
  const dir = posix.dirname(input.id);
  await regenerateIndexes(root, dir === "." ? "" : dir);
  const kind = existing === undefined ? "Creation" : "Update";
  if (!inDbOnlyDir(input.id) && !input.metadataOnly)
    // Private concepts never leak titles into the committed root log.md;
    // metadata-only stamps aren't content changes worth a log entry.
    await appendLog(root, kind, input.id, fm.title as string, fm.description as string);
  return { id: input.id, path, created: existing === undefined };
}
