// Opt-in, local-only usability sessions (docs/USABILITY.md). A facilitator
// starts a session for one brain. While it runs, the owner surfaces (the local
// app and the CLI) leave a timeline of what kind of thing happened and how long
// it took, so a study can report time to a first saved note and re-finding
// success. The store lives in per-user application data, never in the bundle.
//
// Its columns hold enumerated words, whole numbers, and a short task label, and
// the schema enforces that. Note IDs, titles, paths, tags, bodies, query text,
// model output, and error messages have no column to land in. Ordinary use
// never creates the store: every recording path returns after one `existsSync`
// until the first session starts.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.ts";
import { ensureExtensionCapableSqlite } from "./engine/custom-sqlite.ts";
import { log } from "./log.ts";
import type { OpContext } from "./operations.ts";
import { VERSION } from "./version.ts";

export const USABILITY_SCHEMA = "okbrain-usability/1";
export const USABILITY_RETENTION_DAYS = 30;
const retentionMs = USABILITY_RETENTION_DAYS * 86_400_000;

/** What a participant did. `error` is a failed attempt at one of the others. */
export const USABILITY_ACTIVITIES = ["save", "search", "open", "browse", "map", "ask", "review"] as const;
export const USABILITY_KINDS = [...USABILITY_ACTIVITIES, "error", "task_start", "task_end"] as const;
/** MCP is absent on purpose: an agent's calls are never part of a session. */
export const USABILITY_SURFACES = ["gui", "cli"] as const;
/** Where an opened note was reached from. */
export const USABILITY_OPEN_VIA = ["search", "browse", "map", "link", "review", "direct"] as const;
/** Which path saved a note. */
export const USABILITY_SAVE_VIA = ["capture", "note", "clip", "import", "answer", "claim", "feed"] as const;
export const USABILITY_TASK_OUTCOMES = ["found", "not_found", "abandoned"] as const;
/** An `OpError` code, or `failed` for any other error. The message is never kept. */
export const USABILITY_ERROR_CODES = ["untrusted", "bad_params", "not_found", "refused", "failed"] as const;
export const USABILITY_LABEL = /^[A-Za-z0-9_-]{1,16}$/;

export type UsabilityActivity = typeof USABILITY_ACTIVITIES[number];
export type UsabilityKind = typeof USABILITY_KINDS[number];
export type UsabilitySurface = typeof USABILITY_SURFACES[number];
export type UsabilityOpenVia = typeof USABILITY_OPEN_VIA[number];
export type UsabilitySaveVia = typeof USABILITY_SAVE_VIA[number];
export type UsabilityTaskOutcome = typeof USABILITY_TASK_OUTCOMES[number];
export type UsabilityErrorCode = typeof USABILITY_ERROR_CODES[number];

/** A caller mistake or a refused request, converted to an `OpError` by the ops. */
export class UsabilityError extends Error {
  constructor(message: string, readonly code: "bad_params" | "refused") {
    super(message);
  }
}

/** The countable facts one successful activity contributes. Never content. */
export interface UsabilityDetail {
  via?: UsabilityOpenVia | UsabilitySaveVia;
  count?: number;
  rank?: number;
}

export interface UsabilityEvent {
  seq: number;
  /** Milliseconds from the session start to when the event was recorded. */
  offsetMs: number;
  kind: UsabilityKind;
  surface: UsabilitySurface;
  durationMs?: number;
  /** A task result (`task_end`) or an error code (`error`). */
  outcome?: UsabilityTaskOutcome | UsabilityErrorCode;
  count?: number;
  rank?: number;
  /** How a note was opened or saved. For `error`, the activity that failed. */
  via?: UsabilityOpenVia | UsabilitySaveVia | UsabilityActivity;
  label?: string;
}

export interface UsabilityTaskSummary {
  label: string;
  /** Absent while the task is still open. */
  outcome: UsabilityTaskOutcome | null;
  durationMs: number | null;
  searches: number;
  opens: number;
  firstOpenRank: number | null;
  firstOpenVia: UsabilityOpenVia | null;
}

export interface UsabilitySummary {
  /** Session length. Null while the session is still recording. */
  durationMs: number | null;
  events: number;
  timeToFirstSaveMs: number | null;
  firstSaveKind: UsabilitySaveVia | null;
  errors: number;
  tasks: UsabilityTaskSummary[];
  refind: {
    /** Tasks that ended with an outcome. */
    tasks: number;
    found: number;
    notFound: number;
    abandoned: number;
    /** `found / tasks`, from 0 to 1. */
    successRate: number | null;
    /** Median duration of the tasks that ended as found. */
    medianFoundMs: number | null;
  };
  search: { count: number; p50Ms: number | null; p95Ms: number | null };
}

export interface UsabilitySessionExport {
  id: string;
  startedAt: string;
  endedAt: string | null;
  appVersion: string;
  platform: string;
  events: UsabilityEvent[];
  summary: UsabilitySummary;
}

export interface UsabilityExport {
  schema: typeof USABILITY_SCHEMA;
  exportedAt: string;
  retentionDays: number;
  sessions: UsabilitySessionExport[];
}

export interface UsabilityStatus {
  recording: boolean;
  /** Start of the recording session. */
  startedAt: string | null;
  /** Events in the recording session. */
  events: number;
  /** Label of the open task. */
  task: string | null;
  /** Sessions kept for this brain, including a recording one. */
  sessions: number;
  retentionDays: number;
}

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const outcomes = [...new Set<string>([...USABILITY_TASK_OUTCOMES, ...USABILITY_ERROR_CODES])];
const vias = [...new Set<string>([...USABILITY_OPEN_VIA, ...USABILITY_SAVE_VIA, ...USABILITY_ACTIVITIES])];
const whole = (column: string, least: number) => `(typeof(${column}) = 'integer' AND ${column} >= ${least})`;

// Every text column is an enumeration or a short fixed alphabet, so a bug
// elsewhere cannot store free text here.
const storeSchema = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*'),
    brain TEXT NOT NULL CHECK (length(brain) = 64 AND brain NOT GLOB '*[^0-9a-f]*'),
    started_at INTEGER NOT NULL CHECK ${whole("started_at", 0)},
    ended_at INTEGER CHECK (ended_at IS NULL OR ${whole("ended_at", 0)}),
    app_version TEXT NOT NULL CHECK (length(app_version) BETWEEN 1 AND 32 AND app_version NOT GLOB '*[^0-9A-Za-z.+-]*'),
    platform TEXT NOT NULL CHECK (platform IN ('darwin', 'linux', 'win32', 'other'))
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX IF NOT EXISTS sessions_recording ON sessions(brain) WHERE ended_at IS NULL;
  CREATE INDEX IF NOT EXISTS sessions_retention ON sessions(started_at);
  CREATE TABLE IF NOT EXISTS events (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK ${whole("seq", 1)},
    offset_ms INTEGER NOT NULL CHECK ${whole("offset_ms", 0)},
    kind TEXT NOT NULL CHECK (kind IN (${sqlList(USABILITY_KINDS)})),
    surface TEXT NOT NULL CHECK (surface IN (${sqlList(USABILITY_SURFACES)})),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR ${whole("duration_ms", 0)}),
    outcome TEXT CHECK (outcome IS NULL OR outcome IN (${sqlList(outcomes)})),
    "count" INTEGER CHECK ("count" IS NULL OR ${whole('"count"', 0)}),
    "rank" INTEGER CHECK ("rank" IS NULL OR ${whole('"rank"', 1)}),
    via TEXT CHECK (via IS NULL OR via IN (${sqlList(vias)})),
    label TEXT CHECK (label IS NULL OR (length(label) BETWEEN 1 AND 16 AND label NOT GLOB '*[^A-Za-z0-9_-]*')),
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID;
`;

/** `dataDir()/usability/sessions.db`. The folder is private to the user. */
export function usabilityStorePath(): string {
  return join(dataDir(), "usability", "sessions.db");
}

function openStore(create: boolean): Database | undefined {
  const path = usabilityStorePath();
  if (!create && !existsSync(path)) return undefined;
  if (create) mkdirSync(join(dataDir(), "usability"), { mode: 0o700, recursive: true });
  ensureExtensionCapableSqlite();
  const db = new Database(path, { readwrite: true, create });
  try {
    // Deleted sessions are overwritten in place, so Clear leaves nothing behind.
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    if (create) {
      db.exec(storeSchema);
      // SQLite gives its journal the database's mode. The private folder still
      // protects the file where a filesystem has no modes to set.
      try { chmodSync(path, 0o600); } catch { /* keep the session usable */ }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const brainKey = (bundle: string) => createHash("sha256").update(realpathSync.native(bundle)).digest("hex");

/** Only the local app and the CLI, acting for the owner on a writable brain. */
function recordingSurface(ctx: OpContext): UsabilitySurface | undefined {
  if (ctx.localUsage !== true || !ctx.trusted || ctx.readonly === true) return undefined;
  return ctx.surface === "gui" || ctx.surface === "cli" ? ctx.surface : undefined;
}

interface Recording { id: string; startedAt: number }

function recordingSession(db: Database, key: string, now: number): Recording | undefined {
  const row = db.query<{ id: string; started_at: number }, [string, number]>(
    "SELECT id, started_at FROM sessions WHERE brain = ? AND ended_at IS NULL AND started_at >= ?",
  ).get(key, now - retentionMs);
  return row ? { id: row.id, startedAt: row.started_at } : undefined;
}

/**
 * Drop sessions past the retention window. Ordinary use of an existing store
 * comes through here, so a finished study is deleted on time even when nobody
 * opens the session controls again. It reads first and only takes the write
 * lock when something has expired.
 */
function dropExpired(db: Database, now: number): void {
  const cutoff = now - retentionMs;
  try {
    if (!db.query<{ id: string }, [number]>("SELECT id FROM sessions WHERE started_at < ? LIMIT 1").get(cutoff)) return;
    db.transaction(() => { db.query("DELETE FROM sessions WHERE started_at < ?").run(cutoff); }).immediate();
  } catch { /* Another process holds the store. The next activity tries again. */ }
}

const wholeNumber = (value: number | undefined, least: number): number | null =>
  value !== undefined && Number.isFinite(value) && value >= least ? Math.min(Math.round(value), Number.MAX_SAFE_INTEGER) : null;

interface EventInput {
  kind: UsabilityKind;
  durationMs?: number;
  outcome?: UsabilityEvent["outcome"];
  count?: number;
  rank?: number;
  via?: UsabilityEvent["via"];
  label?: string;
}

function insertEvent(db: Database, session: Recording, surface: UsabilitySurface, event: EventInput, now: number): void {
  const { next } = db.query<{ next: number }, [string]>(
    "SELECT coalesce(max(seq), 0) + 1 AS next FROM events WHERE session_id = ?",
  ).get(session.id)!;
  db.query(`INSERT INTO events (session_id, seq, offset_ms, kind, surface, duration_ms, outcome, "count", "rank", via, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    session.id, next, Math.max(0, now - session.startedAt), event.kind, surface, wholeNumber(event.durationMs, 0),
    event.outcome ?? null, wholeNumber(event.count, 0), wholeNumber(event.rank, 1), event.via ?? null, event.label ?? null,
  );
}

let warned = false;

function record(ctx: OpContext, event: EventInput): void {
  const surface = recordingSurface(ctx);
  if (!surface) return;
  let db: Database | undefined;
  try {
    db = openStore(false);
    if (!db) return;
    const store = db;
    dropExpired(store, Date.now());
    const key = brainKey(ctx.bundle);
    if (!recordingSession(store, key, Date.now())) return;
    store.transaction(() => {
      const now = Date.now();
      const session = recordingSession(store, key, now);
      if (session) insertEvent(store, session, surface, event, now);
    }).immediate();
  } catch (error) {
    // A study must never get in the way of the work it observes.
    if (!warned) log.warn("Could not record a usability event. Check that the local usability store is writable.", {
      error: error instanceof Error ? error.message : String(error),
    });
    warned = true;
  } finally { db?.close(); }
}

/** Record one successful owner activity. Does nothing unless a session is recording. */
export function recordUsabilityActivity(ctx: OpContext, kind: UsabilityActivity, detail: UsabilityDetail, durationMs: number): void {
  record(ctx, { kind, durationMs, ...detail });
}

/** Record that an owner activity failed, keeping its error code and nothing else. */
export function recordUsabilityFailure(ctx: OpContext, kind: UsabilityActivity, code: UsabilityErrorCode, durationMs: number): void {
  record(ctx, { kind: "error", via: kind, outcome: code, durationMs });
}

const lengthOf = (value: unknown): number => Array.isArray(value) ? value.length : 0;
const field = (value: unknown, name: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;

function savedOne(via: UsabilitySaveVia) {
  return (_params: Record<string, unknown>, result: unknown): UsabilityDetail | undefined =>
    field(result, "noop") === true ? undefined : { via, count: 1 };
}

function savedMany(via: UsabilitySaveVia, count: (result: unknown) => number) {
  return (_params: Record<string, unknown>, result: unknown): UsabilityDetail | undefined => {
    const saved = count(result);
    return saved > 0 ? { via, count: saved } : undefined;
  };
}

interface OpActivity {
  kind: UsabilityActivity;
  /** What to keep from a successful call, or undefined when it is not an event. */
  detail(params: Record<string, unknown>, result: unknown): UsabilityDetail | undefined;
}

/**
 * The registry operations a session observes, by name. Anything absent is
 * never recorded. `tests/usability.test.ts` holds every name to the registry,
 * so a renamed operation cannot silently stop recording.
 */
export const USABILITY_OPERATIONS: Readonly<Record<string, OpActivity>> = {
  capture: { kind: "save", detail: savedOne("capture") },
  new_concept: { kind: "save", detail: savedOne("note") },
  write_concept: { kind: "save", detail: savedOne("note") },
  take: { kind: "save", detail: savedOne("claim") },
  // A clip of a page that is already saved only counts when it adds a highlight.
  clip: { kind: "save", detail: (_params, result) =>
    field(result, "deduped") === true && field(result, "appended") !== true ? undefined : { via: "clip", count: 1 } },
  import: { kind: "save", detail: savedMany("import", (result) => lengthOf(field(result, "imported"))) },
  import_conversations: { kind: "save", detail: savedMany("import", (result) => lengthOf(field(result, "imported"))) },
  rss: { kind: "save", detail: savedMany("feed", (result) =>
    Array.isArray(result) ? result.reduce((total: number, feed) => total + lengthOf(field(feed, "added")), 0) : 0) },
  search: { kind: "search", detail: (_params, result) => ({ count: lengthOf(result) }) },
  read_concept: { kind: "open", detail: (params) => ({
    via: USABILITY_OPEN_VIA.find((via) => via === params.via) ?? "direct",
    ...(typeof params.rank === "number" ? { rank: params.rank } : {}),
  }) },
  // Plain ID lists are lookups the app makes for pickers. A listing with
  // details or a filter is what a person browses.
  list_concepts: { kind: "browse", detail: (params, result) =>
    params.detail === true || params.type !== undefined || params.tag !== undefined || params.status !== undefined
      ? { count: lengthOf(result) } : undefined },
  focused_map: { kind: "map", detail: (_params, result) => ({ count: lengthOf(field(result, "nodes")) }) },
  graph_data: { kind: "map", detail: (_params, result) => ({ count: lengthOf(field(result, "nodes")) }) },
  ask: { kind: "ask", detail: (_params, result) => ({ count: lengthOf(field(result, "citations")) }) },
  ask_plan: { kind: "ask", detail: (_params, result) => ({ count: lengthOf(field(result, "citations")) }) },
  review_done: { kind: "review", detail: () => ({}) },
  review_snooze: { kind: "review", detail: () => ({}) },
};

/**
 * Record one settled registry operation. Called by `runOp` for every op, so it
 * returns before touching the filesystem for anything off the allowlist.
 */
export function recordOpEvent(
  ctx: OpContext,
  opName: string,
  params: Record<string, unknown>,
  settled: { result: unknown } | { error: UsabilityErrorCode },
  durationMs: number,
): void {
  const activity = Object.hasOwn(USABILITY_OPERATIONS, opName) ? USABILITY_OPERATIONS[opName] : undefined;
  if (!activity) return;
  if ("error" in settled) return recordUsabilityFailure(ctx, activity.kind, settled.error, durationMs);
  const detail = activity.detail(params, settled.result);
  if (detail) recordUsabilityActivity(ctx, activity.kind, detail, durationMs);
}

/**
 * True while this brain has a recording session the caller would add to. The
 * local app asks on every status check, for a read-only brain too, so this is
 * also where an existing store sheds its expired sessions.
 */
export function usabilityRecording(ctx: OpContext): boolean {
  if (ctx.localUsage !== true) return false;
  let db: Database | undefined;
  try {
    db = openStore(false);
    if (!db) return false;
    const now = Date.now();
    dropExpired(db, now);
    return recordingSurface(ctx) !== undefined && recordingSession(db, brainKey(ctx.bundle), now) !== undefined;
  } catch {
    return false;
  } finally { db?.close(); }
}

function requireOwner(ctx: OpContext): UsabilitySurface {
  const surface = recordingSurface(ctx);
  if (!surface) throw new UsabilityError("Usability sessions are managed from the local app or the CLI on a writable brain.", "refused");
  return surface;
}

function openTask(db: Database, session: string): string | null {
  const last = db.query<{ kind: string; label: string }, [string]>(
    "SELECT kind, label FROM events WHERE session_id = ? AND kind IN ('task_start', 'task_end') ORDER BY seq DESC LIMIT 1",
  ).get(session);
  return last?.kind === "task_start" ? last.label : null;
}

function statusOf(db: Database | undefined, key: string, now: number): UsabilityStatus {
  const idle: UsabilityStatus = { recording: false, startedAt: null, events: 0, task: null, sessions: 0, retentionDays: USABILITY_RETENTION_DAYS };
  if (!db) return idle;
  const sessions = db.query<{ total: number }, [string]>("SELECT count(*) AS total FROM sessions WHERE brain = ?").get(key)!.total;
  const session = recordingSession(db, key, now);
  if (!session) return { ...idle, sessions };
  const events = db.query<{ total: number }, [string]>("SELECT count(*) AS total FROM events WHERE session_id = ?").get(session.id)!.total;
  return { recording: true, startedAt: new Date(session.startedAt).toISOString(), events, task: openTask(db, session.id), sessions,
    retentionDays: USABILITY_RETENTION_DAYS };
}

/** Run one lifecycle step in a write transaction, after dropping expired sessions. */
function withStore<T>(create: boolean, absent: () => T, run: (db: Database, now: number) => T): T {
  let db: Database | undefined;
  try {
    db = openStore(create);
    if (!db) return absent();
    const store = db;
    return store.transaction(() => {
      const now = Date.now();
      store.query("DELETE FROM sessions WHERE started_at < ?").run(now - retentionMs);
      return run(store, now);
    }).immediate();
  } catch (error) {
    if (error instanceof UsabilityError) throw error;
    log.warn("The local usability store could not be used.", { error: error instanceof Error ? error.message : String(error) });
    throw new UsabilityError("Could not use the local usability store. Check that its folder in your application data is writable.", "refused");
  } finally { db?.close(); }
}

function endTask(db: Database, session: Recording, surface: UsabilitySurface, label: string, outcome: UsabilityTaskOutcome, now: number): void {
  insertEvent(db, session, surface, { kind: "task_end", label, outcome }, now);
}

/** View, start, stop, or clear this brain's usability sessions. */
export function usabilitySession(ctx: OpContext, action: "status" | "start" | "stop" | "clear"): UsabilityStatus {
  const surface = requireOwner(ctx);
  const key = brainKey(ctx.bundle);
  return withStore(action === "start", () => statusOf(undefined, key, Date.now()), (db, now) => {
    const session = recordingSession(db, key, now);
    if (action === "start") {
      if (session) throw new UsabilityError("A usability session is already recording for this brain. Stop it before starting another.", "refused");
      db.query("INSERT INTO sessions (id, brain, started_at, app_version, platform) VALUES (?, ?, ?, ?, ?)").run(
        randomUUID(), key, now, VERSION.replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 32) || "unknown",
        process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "other",
      );
    } else if (action === "stop" && session) {
      // A task left open has no result, so the summary reports it as abandoned.
      const task = openTask(db, session.id);
      if (task) endTask(db, session, surface, task, "abandoned", now);
      db.query("UPDATE sessions SET ended_at = ? WHERE id = ?").run(now, session.id);
    } else if (action === "clear") {
      db.query("DELETE FROM sessions WHERE brain = ?").run(key);
    }
    return statusOf(db, key, now);
  });
}

/** Mark the start or the end of one facilitator task in the recording session. */
export function usabilityTask(ctx: OpContext, action: "start" | "end", label: string, outcome?: UsabilityTaskOutcome): UsabilityStatus {
  const surface = requireOwner(ctx);
  if (!USABILITY_LABEL.test(label))
    throw new UsabilityError("Use a task label of 1 to 16 letters, digits, hyphens, or underscores.", "bad_params");
  if (action === "end" && !outcome) throw new UsabilityError("End a task as found, not_found, or abandoned.", "bad_params");
  if (action === "start" && outcome) throw new UsabilityError("A task gets its outcome when it ends.", "bad_params");
  const key = brainKey(ctx.bundle);
  const noSession = () => { throw new UsabilityError("Start a usability session before marking a task.", "refused"); };
  return withStore(false, noSession, (db, now) => {
    const session = recordingSession(db, key, now);
    if (!session) return noSession();
    const task = openTask(db, session.id);
    if (action === "start") {
      if (task) throw new UsabilityError(`End task ${task} before starting another.`, "refused");
      insertEvent(db, session, surface, { kind: "task_start", label }, now);
    } else {
      if (task !== label) throw new UsabilityError(task ? `The open task is ${task}.` : "No task is open. Start one first.", "refused");
      endTask(db, session, surface, label, outcome!, now);
    }
    return statusOf(db, key, now);
  });
}

/** The value at fraction `q` of the sorted values, interpolating between neighbours. */
function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  return Math.round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower));
}

/** Derive the study measures from one session's events, in recorded order. */
export function summarizeUsability(events: readonly UsabilityEvent[], durationMs: number | null): UsabilitySummary {
  const firstSave = events.find((event) => event.kind === "save");
  const searches = events.filter((event) => event.kind === "search");
  const tasks: UsabilityTaskSummary[] = [];
  let open: { summary: UsabilityTaskSummary; startedAt: number } | undefined;
  for (const event of events) {
    if (event.kind === "task_start" && event.label) {
      open = { startedAt: event.offsetMs, summary: {
        label: event.label, outcome: null, durationMs: null, searches: 0, opens: 0, firstOpenRank: null, firstOpenVia: null,
      } };
      tasks.push(open.summary);
    } else if (!open) {
      continue;
    } else if (event.kind === "task_end") {
      open.summary.outcome = USABILITY_TASK_OUTCOMES.find((outcome) => outcome === event.outcome) ?? null;
      open.summary.durationMs = event.offsetMs - open.startedAt;
      open = undefined;
    } else if (event.kind === "search") {
      open.summary.searches++;
    } else if (event.kind === "open") {
      if (open.summary.opens++ === 0) {
        open.summary.firstOpenRank = event.rank ?? null;
        open.summary.firstOpenVia = USABILITY_OPEN_VIA.find((via) => via === event.via) ?? null;
      }
    }
  }
  const ended = tasks.filter((task) => task.outcome !== null);
  const found = ended.filter((task) => task.outcome === "found");
  return {
    durationMs,
    events: events.length,
    timeToFirstSaveMs: firstSave?.offsetMs ?? null,
    firstSaveKind: USABILITY_SAVE_VIA.find((via) => via === firstSave?.via) ?? null,
    errors: events.filter((event) => event.kind === "error").length,
    tasks,
    refind: {
      tasks: ended.length,
      found: found.length,
      notFound: ended.filter((task) => task.outcome === "not_found").length,
      abandoned: ended.filter((task) => task.outcome === "abandoned").length,
      successRate: ended.length ? Math.round((found.length / ended.length) * 1000) / 1000 : null,
      medianFoundMs: quantile(found.flatMap((task) => task.durationMs === null ? [] : [task.durationMs]), 0.5),
    },
    search: {
      count: searches.length,
      p50Ms: quantile(searches.flatMap((event) => event.durationMs === undefined ? [] : [event.durationMs]), 0.5),
      p95Ms: quantile(searches.flatMap((event) => event.durationMs === undefined ? [] : [event.durationMs]), 0.95),
    },
  };
}

interface EventRow {
  seq: number; offset_ms: number; kind: UsabilityKind; surface: UsabilitySurface; duration_ms: number | null;
  outcome: UsabilityEvent["outcome"] | null; count: number | null; rank: number | null; via: UsabilityEvent["via"] | null; label: string | null;
}

/** Every stored session for this brain with its events and summary. The brain key stays behind. */
export function usabilityExport(ctx: OpContext): UsabilityExport {
  requireOwner(ctx);
  const key = brainKey(ctx.bundle);
  const exported = (sessions: UsabilitySessionExport[]): UsabilityExport =>
    ({ schema: USABILITY_SCHEMA, exportedAt: new Date().toISOString(), retentionDays: USABILITY_RETENTION_DAYS, sessions });
  return withStore(false, () => exported([]), (db) => exported(
    db.query<{ id: string; started_at: number; ended_at: number | null; app_version: string; platform: string }, [string]>(
      "SELECT id, started_at, ended_at, app_version, platform FROM sessions WHERE brain = ? ORDER BY started_at, id",
    ).all(key).map((session) => {
      const events = db.query<EventRow, [string]>(
        `SELECT seq, offset_ms, kind, surface, duration_ms, outcome, "count", "rank", via, label FROM events WHERE session_id = ? ORDER BY seq`,
      ).all(session.id).map((row): UsabilityEvent => ({
        seq: row.seq, offsetMs: row.offset_ms, kind: row.kind, surface: row.surface,
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        ...(row.outcome === null ? {} : { outcome: row.outcome }),
        ...(row.count === null ? {} : { count: row.count }),
        ...(row.rank === null ? {} : { rank: row.rank }),
        ...(row.via === null ? {} : { via: row.via }),
        ...(row.label === null ? {} : { label: row.label }),
      }));
      return {
        id: session.id,
        startedAt: new Date(session.started_at).toISOString(),
        endedAt: session.ended_at === null ? null : new Date(session.ended_at).toISOString(),
        appVersion: session.app_version,
        platform: session.platform,
        events,
        summary: summarizeUsability(events, session.ended_at === null ? null : session.ended_at - session.started_at),
      };
    }),
  ));
}
