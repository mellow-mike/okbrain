// Conformance writer: every concept write routes through here so the bundle
// stays conformant OKF v0.2 (CLAUDE.md invariant 1). Emits the scaffold
// (type/title/description, plus resource/tags when applicable) and the v0.2
// families — `generated` (who changed the content, when), `verified` events,
// `status`, `stale_after`, `sources` — in canonical key order, preserves
// unknown keys on edit, and normalizes body links to bundle-absolute form.
// Legacy v0.1 keys (`timestamp`, `last_reviewed`) are superseded in place
// when their v0.2 counterpart is written. Each write also regenerates
// index.md up the touched dir chain and appends a log.md entry (Stage 1.2).

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { chmod, link, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
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
  type OkfDocument,
  type SourceEntry,
} from "./document.ts";
import { regenerateIndexBranches, regenerateIndexes } from "./indexmd.ts";
import { appendConceptLogs, appendLog, formatLogEntry, todayUtc, type ConceptLogEntry } from "./logmd.ts";
import { assertBundleFile, assertConceptPathSpelling, idToAbsPath, isReservedName, slugify } from "./paths.ts";
import { isPrivateConcept } from "./privacy.ts";

export class OkfWriteError extends Error {}

/**
 * Everything a note write touches must be a regular file before any byte is
 * written: the note, each `index.md` above it, and the logs beside them. A
 * link among them would send the write somewhere else on this computer (B23).
 */
async function assertWriteTargets(root: string, id: string): Promise<void> {
  await assertBundleFile(root, `${id}.md`);
  const folders = id.split("/").slice(0, -1);
  for (let depth = 0; depth <= folders.length; depth++) {
    const folder = folders.slice(0, depth).join("/");
    for (const name of ["index.md", "log.md"]) await assertBundleFile(root, folder ? `${folder}/${name}` : name);
  }
}

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

interface WriteOptions {
  /** Leave an existing concept alone, including one created by a concurrent import. */
  createOnly?: boolean;
  /** Recheck a reviewed create-only write before staging and publication. */
  authorize?: () => void | Promise<void>;
  /** The caller will regenerate the affected index branch after a batch. */
  deferIndex?: boolean;
  /** Apply a reviewed write only if the concept still has these exact bytes. */
  expected?: string;
  /** Accumulate derived metadata until the importing operation finishes. */
  batch?: { dirs: Set<string>; log: ConceptLogEntry[] };
}

/** Import a group of concepts through the same writer and refresh metadata even after a partial import. */
export async function writeConceptBatch<T>(root: string, write: (
  add: (input: WriteConceptInput, options?: Pick<WriteOptions, "createOnly" | "expected">) => Promise<WriteResult>,
) => Promise<T>): Promise<T> {
  const batch = { dirs: new Set<string>(), log: [] as ConceptLogEntry[] };
  try {
    return await write((input, options) => writeConcept(root, input, { ...options, batch }));
  } finally {
    try { await regenerateIndexBranches(root, batch.dirs); }
    finally { await appendConceptLogs(root, batch.log); }
  }
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

/** Publish reviewed raw bytes atomically, optionally checking a stronger caller-owned snapshot. */
export async function publishConcept(
  path: string,
  bytes: string,
  mode: number | undefined,
  expected?: string,
  matches?: () => Promise<boolean>,
): Promise<boolean> {
  const temporary = join(dirname(path), `.okb-write-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx", mode });
    if (matches && !await matches()) return false;
    if (expected === undefined) await link(temporary, path);
    else {
      if (!matches && readFileSync(path, "utf8") !== expected) return false;
      renameSync(temporary, path);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === (expected === undefined ? "EEXIST" : "ENOENT")) return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Publish an already validated filing document. Its original provenance must pass through untouched. */
export async function writeFilingDocument(root: string, id: string, doc: OkfDocument, expected?: string): Promise<boolean> {
  const path = idToAbsPath(root, id);
  if (isReservedName(posix.basename(id) + ".md")) throw new OkfWriteError("Choose a concept path for filing.");
  await assertConceptPathSpelling(root, id);
  await assertWriteTargets(root, id);
  const privateConcept = isPrivateConcept(id, doc.frontmatter);
  return publishConcept(path, serialize(doc), privateConcept ? 0o600 : undefined, expected);
}

/** Create or update one concept. Returns the written path and created flag. */
export async function writeConcept(
  root: string,
  input: WriteConceptInput,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const path = idToAbsPath(root, input.id); // validates the id
  if (isReservedName(posix.basename(input.id) + ".md"))
    throw new OkfWriteError(
      `${input.id} is a reserved file, not a concept; index.md/log.md are maintained by okbrain`,
    );
  await assertConceptPathSpelling(root, input.id);
  await assertWriteTargets(root, input.id);

  let existing;
  try {
    if (options.createOnly) {
      await lstat(path);
      return { id: input.id, path, created: false, noop: true };
    }
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
  if (options.expected !== undefined && existing?.raw !== options.expected)
    throw new OkfWriteError("The concept changed. Review it again before saving.");
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

  const privateConcept = isPrivateConcept(input.id, fm);
  const authorize = options.createOnly ? options.authorize : undefined;
  await authorize?.();
  await mkdir(dirname(path), { recursive: true, mode: privateConcept ? 0o700 : undefined });
  const serialized = serialize({ frontmatter: fm, body });
  const mode = privateConcept ? 0o600 : undefined;
  if (options.createOnly) {
    // Publish complete bytes without ever replacing a concurrent writer's note.
    const confirmed = authorize && (async () => { await authorize(); return true; });
    if (!await publishConcept(path, serialized, mode, undefined, confirmed))
      return { id: input.id, path, created: false, noop: true };
  } else if (options.expected !== undefined) {
    const info = await lstat(path);
    if (!info.isFile() || !await publishConcept(path, serialized, mode ?? (info.mode & 0o777), options.expected))
      throw new OkfWriteError("The concept changed. Review it again before saving.");
  } else {
    await writeFile(path, serialized, { encoding: "utf8", mode });
    if (privateConcept && process.platform !== "win32") await chmod(path, 0o600);
  }
  const dir = posix.dirname(input.id) === "." ? "" : posix.dirname(input.id);
  const kind = existing === undefined ? "Creation" : "Update";
  const publicLog = !privateConcept && !input.metadataOnly;
  if (options.batch) {
    options.batch.dirs.add(dir);
    if (publicLog) {
      options.batch.log.push({ id: input.id, date: todayUtc(),
        entry: formatLogEntry(kind, input.id, fm.title as string, fm.description as string) });
    }
  } else {
    if (!options.deferIndex) await regenerateIndexes(root, dir);
    // Private concepts never leak titles into the committed root log.md;
    // metadata-only stamps aren't content changes worth a log entry.
    if (publicLog) await appendLog(root, kind, input.id, fm.title as string, fm.description as string);
  }
  return { id: input.id, path, created: existing === undefined };
}
