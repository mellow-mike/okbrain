// Jobs worker (4.5): one sequential maintenance run guarded by a lock file —
// no queue infra, per the lightweight-core invariant; scheduling belongs to
// the OS (cron / launchd / Task Scheduler invoking `okb jobs`). The lock is
// `.okb/jobs.lock`, created exclusively; a stale lock (dead pid, or older
// than a day) is reclaimed so one crash can't wedge the nightly run forever.
// Jobs run in order, each failure is captured (later jobs still run), and
// SIGINT/SIGTERM stop cleanly between jobs.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";

export class JobLockError extends Error {}

const MAX_LOCK_AGE_MS = 24 * 3600_000;

const lockPath = (bundle: string): string => join(bundle, ".okb", "jobs.lock");

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** True when the lock file names a live, recent worker. */
function lockHeld(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false; // vanished — free
  }
  try {
    const { pid, startedAt } = JSON.parse(raw) as { pid: number; startedAt: string };
    if (!pidAlive(pid)) return false;
    return Date.now() - Date.parse(startedAt) <= MAX_LOCK_AGE_MS;
  } catch {
    return false; // unreadable lock = stale
  }
}

/** Acquire the per-bundle jobs lock; returns the release function. */
export function acquireJobsLock(bundle: string): () => void {
  const path = lockPath(bundle);
  mkdirSync(join(bundle, ".okb"), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, payload, { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (attempt > 0 || lockHeld(path))
        throw new JobLockError(
          `another okb jobs run holds the lock (${path}); if none is running, delete it`,
        );
      rmSync(path, { force: true }); // stale — reclaim and retry once
    }
  }
}

export interface Job {
  name: string;
  /** Human reason to skip (returned, not run) — e.g. "no vector store". */
  skip?: string;
  run(): Promise<string>;
}

export interface JobResult {
  name: string;
  ok: boolean;
  /** Success detail or error message; skip reason for skipped jobs. */
  detail: string;
  skipped: boolean;
  ms: number;
}

/**
 * Run jobs in order under the bundle lock. Each failure is captured so later
 * jobs still run; SIGINT/SIGTERM finish the current job, then stop.
 */
export async function runJobs(bundle: string, jobs: Job[]): Promise<JobResult[]> {
  const release = acquireJobsLock(bundle);
  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
    log.warn("stopping after the current job (signal received)");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results: JobResult[] = [];
  try {
    for (const job of jobs) {
      if (job.skip !== undefined) {
        results.push({ name: job.name, ok: true, detail: job.skip, skipped: true, ms: 0 });
        continue;
      }
      if (stopping) {
        results.push({ name: job.name, ok: false, detail: "skipped: shutting down", skipped: true, ms: 0 });
        continue;
      }
      log.info(`job ${job.name}…`);
      const t0 = Date.now();
      try {
        const detail = await job.run();
        results.push({ name: job.name, ok: true, detail, skipped: false, ms: Date.now() - t0 });
      } catch (e) {
        const detail = (e as Error).message;
        log.warn(`job ${job.name} failed`, { error: detail });
        results.push({ name: job.name, ok: false, detail, skipped: false, ms: Date.now() - t0 });
      }
    }
    return results;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    release();
  }
}
