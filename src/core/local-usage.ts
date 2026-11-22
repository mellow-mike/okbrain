import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { dataDir } from "./config.ts";
import { ensureExtensionCapableSqlite } from "./engine/custom-sqlite.ts";
import { resolvePathField } from "./graph/links.ts";
import { log } from "./log.ts";
import { fmSources } from "./okf/document.ts";
import { idToAbsPath, InvalidIdError, isReservedName } from "./okf/paths.ts";
import type { OpContext } from "./operations.ts";

const days = 30;
const dayMs = 86_400_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const isNote = (id: string) => !isReservedName(`${posix.basename(id)}.md`);

export interface LocalUsageSignal {
  usage_count: number;
  usage_window: { from: string; to: string };
  opens: number;
  citations: number;
}

export interface LocalUsageView {
  note: LocalUsageSignal;
  /** Local, bundle-relative source resources only. */
  sources: Record<string, LocalUsageSignal>;
}

function openUsage(create: boolean): Database | undefined {
  const dir = join(dataDir(), "note-usage");
  const path = join(dir, "usage.db");
  if (!create && !existsSync(path)) return undefined;
  if (create) mkdirSync(dir, { mode: 0o700, recursive: true });
  ensureExtensionCapableSqlite();
  const db = new Database(path, { readwrite: true, create });
  try {
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;");
    if (create) db.exec(`
      CREATE TABLE IF NOT EXISTS brains (key TEXT PRIMARY KEY, since TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daily (
        brain TEXT NOT NULL REFERENCES brains(key) ON DELETE CASCADE,
        note TEXT NOT NULL,
        day TEXT NOT NULL,
        opens INTEGER NOT NULL,
        citations INTEGER NOT NULL,
        PRIMARY KEY (brain, note, day)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS daily_retention ON daily(day);
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const brainKey = (bundle: string) => hash(realpathSync(bundle));
const enabledSince = (db: Database, key: string) => db.query<{ since: string }, [string]>(
  "SELECT since FROM brains WHERE key = ?",
).get(key)?.since;

export function noteUsageSettings(bundle: string, enabled?: boolean) {
  const db = openUsage(enabled === true);
  if (!db) return { enabled: false, windowDays: days };
  try {
    const key = brainKey(bundle);
    if (enabled === true) db.query("INSERT OR IGNORE INTO brains (key, since) VALUES (?, ?)").run(key, new Date().toISOString());
    if (enabled === false) db.query("DELETE FROM brains WHERE key = ?").run(key);
    return { enabled: enabledSince(db, key) !== undefined, windowDays: days };
  } finally { db.close(); }
}

function collectUsage<T>(ctx: OpContext, ids: readonly string[], kind: "opens" | "citations",
  result: (signalFor: (id: string) => LocalUsageSignal) => T): T | undefined {
  if (!ctx.localUsage || !ctx.trusted || ctx.readonly || !ids.length) return undefined;
  let db: Database | undefined;
  try {
    db = openUsage(false);
    if (!db) return undefined;
    const storage = db;
    const key = brainKey(ctx.bundle);
    const now = new Date();
    const to = now.toISOString();
    const today = to.slice(0, 10);
    const firstDay = new Date(Date.parse(today) - (days - 1) * dayMs).toISOString();
    return storage.transaction(() => {
      const since = enabledSince(storage, key);
      if (since === undefined) return undefined;
      storage.query("DELETE FROM daily WHERE day < ?").run(firstDay.slice(0, 10));
      const bump = storage.query(`INSERT INTO daily (brain, note, day, opens, citations) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (brain, note, day) DO UPDATE SET opens = opens + excluded.opens, citations = citations + excluded.citations`);
      for (const id of new Set(ids.filter(isNote))) bump.run(key, hash(id), today, Number(kind === "opens"), Number(kind === "citations"));
      const from = since <= to && since > firstDay ? since : firstDay;
      const sum = storage.query<{ opens: number; citations: number }, [string, string, string, string]>(
        "SELECT coalesce(sum(opens), 0) AS opens, coalesce(sum(citations), 0) AS citations FROM daily WHERE brain = ? AND note = ? AND day >= ? AND day <= ?",
      );
      return result((id) => {
        const { opens, citations } = sum.get(key, hash(id), from.slice(0, 10), today)!;
        return { usage_count: opens + citations, usage_window: { from, to }, opens, citations };
      });
    }).immediate();
  } catch (error) {
    log.warn("Could not update local note usage. Check that the local usage database is writable.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally { db?.close(); }
}

export function recordNoteOpen(ctx: OpContext, id: string, frontmatter: Record<string, unknown>): LocalUsageView | undefined {
  if (!isNote(id) || frontmatter.type === "forwarding") return undefined;
  return collectUsage(ctx, [id], "opens", (signalFor) => {
    const known = { has(candidate: string): boolean {
      if (!isNote(candidate)) return false;
      try { return existsSync(idToAbsPath(ctx.bundle, candidate)); }
      catch (error) {
        if (error instanceof InvalidIdError) return false;
        throw error;
      }
    } };
    const sources = new Map<string, LocalUsageSignal>();
    for (const { resource } of fmSources(frontmatter)) {
      const target = resolvePathField(id, resource, known);
      if (target === null || !known.has(target)) continue;
      const signal = signalFor(target);
      if (signal.usage_count > 0) sources.set(resource, signal);
    }
    return { note: signalFor(id), sources: Object.fromEntries(sources) };
  });
}

export function recordCitedNotes(ctx: OpContext, ids: readonly string[]): void {
  collectUsage(ctx, ids, "citations", () => undefined);
}
