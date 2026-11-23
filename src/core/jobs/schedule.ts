import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "../config.ts";
import { ensureExtensionCapableSqlite } from "../engine/custom-sqlite.ts";
import { log } from "../log.ts";

export const maintenanceJobNames = ["index", "rss", "review", "doctor", "embed"] as const;
export type MaintenanceJobName = typeof maintenanceJobNames[number];
export type MaintenanceTarget = { path: string; brain: string | null };
export type MaintenanceCadence = "6h" | "daily" | "weekly";
export type MaintenanceScheduleInput = {
  cadence: MaintenanceCadence;
  jobs: MaintenanceJobName[];
  approvals?: { embed?: string; rss?: string };
};
type MaintenanceStatus = "completed" | "failed" | "skipped";
type MaintenanceJobResult = { name: string; status: MaintenanceStatus; ms: number };
export type MaintenanceRunResult = { status: MaintenanceStatus; jobs?: MaintenanceJobResult[]; message?: string };
type MaintenanceRun = Omit<MaintenanceRunResult, "status"> & {
  startedAt: number;
  finishedAt?: number;
  status: MaintenanceStatus | "running" | "interrupted";
};
export type MaintenanceSchedule = MaintenanceScheduleInput & {
  target: MaintenanceTarget;
  enabled: boolean;
  nextAt: number | null;
  lastRun?: MaintenanceRun;
};
export interface MaintenanceSchedulerOptions {
  allowed: (target: MaintenanceTarget) => boolean;
  run: (schedule: MaintenanceSchedule, signal: AbortSignal, isCurrent: () => boolean) => Promise<MaintenanceRunResult>;
  now?: () => number;
  path?: string;
  intervalMs?: number;
}

export class MaintenanceScheduleError extends Error {
  constructor(message: string, readonly status = 409, options?: ErrorOptions) { super(message, options); }
}

const hours = 60 * 60_000;
const cadenceMs = { "6h": 6 * hours, daily: 24 * hours, weekly: 7 * 24 * hours } as const;
const storeError = (cause?: unknown) => new MaintenanceScheduleError("Unable to use the private maintenance schedule store.", 409, { cause });
const interrupted = "The app stopped before scheduled maintenance finished.";

type Row = {
  key: string;
  path: string;
  brain: string | null;
  cadence: MaintenanceCadence;
  jobs: string;
  approvals: string | null;
  enabled: number;
  next_at: number | null;
  generation: string;
  last_status: MaintenanceRun["status"] | null;
  last_run: string | null;
};

const keyOf = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const targetOf = ({ path, brain }: Row): MaintenanceTarget => ({ path, brain });

function view(row: Row): MaintenanceSchedule {
  return {
    target: targetOf(row), cadence: row.cadence, jobs: JSON.parse(row.jobs) as MaintenanceJobName[],
    ...(row.approvals ? { approvals: JSON.parse(row.approvals) as MaintenanceScheduleInput["approvals"] } : {}),
    enabled: Boolean(row.enabled), nextAt: row.next_at,
    ...(row.last_run ? { lastRun: JSON.parse(row.last_run) as MaintenanceRun } : {}),
  };
}

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function privateMode(info: NonNullable<ReturnType<typeof stat>>) {
  return process.platform === "win32" || (info.uid === process.getuid?.() && (info.mode & 0o077) === 0);
}

function openPrivateDatabase(path: string, create: boolean, readOnly: boolean): Database | undefined {
  if (create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = stat(dirname(path));
  if (!directory) return;
  if (!directory.isDirectory() || !privateMode(directory)) throw new MaintenanceScheduleError("Maintenance schedules require a private directory.");
  if (create) {
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!stat(path)) return;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const entry = stat(path + suffix);
    if (entry && (!entry.isFile() || entry.nlink !== 1 || !privateMode(entry)))
      throw new MaintenanceScheduleError("Maintenance schedules require a private database file.");
  }
  ensureExtensionCapableSqlite();
  return readOnly ? new Database(path, { readonly: true, strict: true }) : new Database(path, { strict: true });
}

function openStore(path: string, create: boolean, readOnly: boolean): Database | undefined {
  const db = openPrivateDatabase(path, create, readOnly);
  if (!db) return;
  try {
    db.exec("PRAGMA busy_timeout=1000");
    if (create) db.exec(`PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS schedules (
        key TEXT PRIMARY KEY, path TEXT NOT NULL, brain TEXT,
        cadence TEXT NOT NULL, jobs TEXT NOT NULL, approvals TEXT,
        enabled INTEGER NOT NULL, next_at INTEGER, generation TEXT NOT NULL, last_status TEXT, last_run TEXT
      );`);
    else if (!readOnly) db.exec("PRAGMA secure_delete=ON");
    return db;
  } catch (error) { db.close(); throw error; }
}

function acquireSchedulerLease(path: string): Database | undefined {
  const db = openPrivateDatabase(path, true, false)!;
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    return db;
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") return;
    throw error;
  }
}

function lookup(db: Database, key: string): Row | null {
  using query = db.prepare<Row, [string]>("SELECT * FROM schedules WHERE key = ?");
  return query.get(key);
}

function finishedRun(startedAt: number, finishedAt: number, outcome: MaintenanceRunResult): MaintenanceRun {
  // Only runner summaries and job status metadata belong in the catalog.
  const jobs = outcome.jobs?.filter(({ name }) => maintenanceJobNames.some((job) => job === name)).slice(0, maintenanceJobNames.length)
    .map(({ name, status, ms }) => ({ name, status, ms: Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0)) }));
  const message = outcome.message?.replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, 256);
  return { startedAt, finishedAt: Math.max(startedAt, finishedAt), status: outcome.status,
    ...(jobs?.length ? { jobs } : {}), ...(message ? { message } : {}) };
}

/** Run only explicitly persisted maintenance, while an app runtime is open. */
export class MaintenanceScheduler {
  readonly #path: string;
  readonly #now: () => number;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<void> | undefined;
  #active: { key: string; control: AbortController } | undefined;
  #stopped = false;

  constructor(private readonly options: MaintenanceSchedulerOptions) {
    this.#path = options.path ?? join(dataDir(), "maintenance", "schedule.sqlite");
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? 60_000;
  }

  #withStore<T>(create: boolean, readOnly: boolean, read: (db: Database) => T): T | null {
    try {
      const db = openStore(this.#path, create, readOnly);
      if (!db) return null;
      try { return read(db); }
      finally { db.close(); }
    } catch (error) {
      if (error instanceof MaintenanceScheduleError) throw error;
      throw storeError(error);
    }
  }

  get(target: MaintenanceTarget): MaintenanceSchedule | null {
    return this.#withStore(false, true, (db) => {
      const row = lookup(db, keyOf(target.path));
      return row ? view(row) : null;
    });
  }

  save(target: MaintenanceTarget, input: MaintenanceScheduleInput): MaintenanceSchedule {
    this.#requireOpen();
    const key = keyOf(target.path);
    const next = this.#now() + cadenceMs[input.cadence];
    const schedule = this.#withStore(true, false, (db) => {
      using query = db.prepare(`INSERT INTO schedules(key,path,brain,cadence,jobs,approvals,enabled,next_at,generation,last_status,last_run)
        VALUES (?,?,?,?,?,?,1,?,?,NULL,NULL)
        ON CONFLICT(key) DO UPDATE SET path=excluded.path, brain=excluded.brain, cadence=excluded.cadence, jobs=excluded.jobs,
          approvals=excluded.approvals, enabled=1, next_at=excluded.next_at, generation=excluded.generation,
          last_status=CASE WHEN schedules.last_status='running' THEN NULL ELSE schedules.last_status END,
          last_run=CASE WHEN schedules.last_status='running' THEN NULL ELSE schedules.last_run END
        RETURNING *`);
      return view(query.get(key, target.path, target.brain, input.cadence, JSON.stringify(input.jobs),
        input.approvals ? JSON.stringify(input.approvals) : null, next, randomUUID()) as Row);
    });
    if (!schedule) throw storeError();
    this.#interrupt(key);
    return schedule;
  }

  pause(target: MaintenanceTarget): MaintenanceSchedule | null {
    this.#requireOpen();
    const key = keyOf(target.path);
    const schedule = this.#withStore(false, false, (db) => db.transaction(() => {
      const prior = lookup(db, key);
      if (!prior || !prior.enabled) return prior ? view(prior) : null;
      const run = view(prior).lastRun;
      const lastRun = run?.status === "running" ? {
        ...run, status: "interrupted", finishedAt: Math.max(run.startedAt, this.#now()), message: "The maintenance schedule was paused.",
      } as const : run;
      using query = db.prepare("UPDATE schedules SET enabled=0,next_at=NULL,generation=?,last_status=?,last_run=? WHERE key=? RETURNING *");
      return view(query.get(randomUUID(), lastRun?.status ?? null, lastRun ? JSON.stringify(lastRun) : null, key) as Row);
    }).immediate());
    this.#interrupt(key);
    return schedule;
  }

  remove(target: MaintenanceTarget): null {
    this.#requireOpen();
    const key = keyOf(target.path);
    this.#withStore(false, false, (db) => {
      using query = db.prepare("DELETE FROM schedules WHERE key=?");
      query.run(key);
    });
    this.#interrupt(key);
    return null;
  }

  #requireOpen() {
    if (this.#stopped) throw new MaintenanceScheduleError("The maintenance scheduler is shutting down.");
  }

  #interrupt(key: string) {
    if (this.#active?.key === key) this.#active.control.abort();
  }

  start(): void {
    if (this.#timer || (this.#stopped && this.#inFlight)) return;
    this.#stopped = false;
    const poll = () => void this.tick().catch(() => log.warn("Unable to check scheduled maintenance."));
    this.#timer = setInterval(poll, this.#intervalMs);
    this.#timer.unref?.();
    poll();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#active?.control.abort();
    await this.#inFlight?.catch(() => {});
  }

  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = Promise.resolve().then(() => this.#drain()).finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }

  async #drain() {
    if (this.#stopped) return;
    let db: Database | undefined;
    let lease: Database | undefined;
    try {
      db = openStore(this.#path, false, false);
      if (!db) return;
      using pending = db.prepare("SELECT 1 FROM schedules WHERE (enabled=1 AND next_at<=?) OR last_status='running' LIMIT 1");
      if (!pending.get(this.#now())) return;
      lease = acquireSchedulerLease(`${this.#path}.worker`);
      if (!lease) return; // Another app process owns scheduled maintenance.

      const tickAt = this.#now();
      this.#recoverRuns(db, tickAt);
      using due = db.prepare<Row, [number]>("SELECT * FROM schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at,key");
      for (const row of due.all(tickAt)) {
        if (this.#stopped) break;
        if (!this.#optionsAllow(targetOf(row))) continue;
        await this.#runDue(db, row);
      }
    } catch (error) {
      if (error instanceof MaintenanceScheduleError) throw error;
      throw storeError(error);
    } finally {
      try { db?.close(); }
      finally { lease?.close(true); }
    }
  }

  #optionsAllow(target: MaintenanceTarget): boolean {
    try { return this.options.allowed(target); }
    catch { return false; }
  }

  #recoverRuns(db: Database, now: number) {
    // The worker lease proves no live scheduler still owns these receipts.
    db.transaction(() => {
      using running = db.prepare<Row, []>("SELECT * FROM schedules WHERE last_status='running'");
      using update = db.prepare("UPDATE schedules SET last_status='interrupted',last_run=? WHERE key=? AND generation=? AND last_status='running'");
      for (const row of running.all()) {
        const startedAt = view(row).lastRun?.startedAt ?? now;
        update.run(JSON.stringify({ startedAt, finishedAt: Math.max(startedAt, now), status: "interrupted", message: interrupted }), row.key, row.generation);
      }
    }).immediate();
  }

  async #runDue(db: Database, row: Row) {
    const startedAt = this.#now();
    const nextAt = startedAt + cadenceMs[row.cadence];
    const running = JSON.stringify({ startedAt, status: "running" });
    let claimed: Row | null;
    {
      using claim = db.prepare<Row, [number, string, string, string, number]>(`UPDATE schedules
        SET next_at=?,last_status='running',last_run=? WHERE key=? AND generation=? AND enabled=1 AND next_at<=? RETURNING *`);
      claimed = claim.get(nextAt, running, row.key, row.generation, startedAt);
    }
    if (!claimed) return;

    const control = new AbortController();
    this.#active = { key: row.key, control };
    const isCurrent = () => {
      if (this.#stopped || control.signal.aborted) return false;
      try {
        const current = lookup(db, row.key);
        return current?.generation === row.generation && current.enabled === 1 && current.last_run === running;
      } catch { return false; }
    };
    let result: MaintenanceRun;
    try {
      let outcome: MaintenanceRunResult;
      if (!this.#optionsAllow(targetOf(claimed))) outcome = { status: "skipped", message: "The scheduled brain is unavailable or read-only." };
      else outcome = await this.options.run(view(claimed), control.signal, isCurrent);
      result = finishedRun(startedAt, this.#now(), outcome);
    } catch {
      result = finishedRun(startedAt, this.#now(), { status: "failed", message: "Scheduled maintenance could not finish." });
    } finally { this.#active = undefined; }
    if (control.signal.aborted) result = { ...result, status: "interrupted", message: interrupted };
    using finish = db.prepare("UPDATE schedules SET last_status=?,last_run=? WHERE key=? AND generation=? AND last_status='running'");
    finish.run(result.status, JSON.stringify(result), row.key, row.generation);
  }
}
