// Jobs worker (4.5): the lock (exclusive, stale-reclaim, release), the
// sequential runner (failures captured, later jobs still run), and the CLI
// op end-to-end (index/review/doctor run; embed/rss skip with reasons; a
// held lock refuses; runs are idempotent).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireJobsLock, JobLockError, runJobs } from "../src/core/jobs/worker.ts";
import { okb } from "./helpers.ts";

function tempBundle(): string {
  return mkdtempSync(join(tmpdir(), "okb-jobs-"));
}

const lockFile = (root: string): string => join(root, ".okb", "jobs.lock");

describe("jobs lock", () => {
  test("exclusive while held; released lock can be re-acquired", () => {
    const root = tempBundle();
    try {
      const release = acquireJobsLock(root);
      expect(() => acquireJobsLock(root)).toThrow(JobLockError);
      release();
      const again = acquireJobsLock(root);
      again();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stale locks are reclaimed: dead pid, unreadable file", () => {
    const root = tempBundle();
    try {
      mkdirSync(join(root, ".okb"), { recursive: true });
      // 2^30 is far beyond any real pid space on CI machines.
      writeFileSync(lockFile(root), JSON.stringify({ pid: 2 ** 30, startedAt: new Date().toISOString() }));
      acquireJobsLock(root)();

      writeFileSync(lockFile(root), "not json");
      acquireJobsLock(root)();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a live recent lock is honored, not reclaimed", () => {
    const root = tempBundle();
    try {
      mkdirSync(join(root, ".okb"), { recursive: true });
      writeFileSync(
        lockFile(root),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
      expect(() => acquireJobsLock(root)).toThrow(JobLockError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runJobs", () => {
  test("failures are captured, later jobs still run, lock is released", async () => {
    const root = tempBundle();
    try {
      const order: string[] = [];
      const results = await runJobs(root, [
        { name: "a", run: async () => (order.push("a"), "did a") },
        { name: "boom", run: async () => { throw new Error("kaput"); } },
        { name: "b", skip: "not applicable", run: async () => "never" },
        { name: "c", run: async () => (order.push("c"), "did c") },
      ]);
      expect(order).toEqual(["a", "c"]);
      expect(results.map((r) => [r.name, r.ok, r.skipped])).toEqual([
        ["a", true, false],
        ["boom", false, false],
        ["b", true, true],
        ["c", true, false],
      ]);
      expect(results[1]!.detail).toBe("kaput");
      expect(existsSync(lockFile(root))).toBe(false); // released
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("okb jobs (CLI)", () => {
  test("runs index/review/doctor; embed and rss skip with reasons; idempotent", async () => {
    const root = tempBundle();
    try {
      await okb(["write", "notes/a", "--type", "note", "--title", "A", "--description", "d", "--bundle", root]);
      const r1 = await okb(["jobs", "--bundle", root]);
      expect(r1.code).toBe(0);
      expect(r1.stdout).toContain("[ ok ] index");
      expect(r1.stdout).toContain("[skip] embed — no vector store");
      expect(r1.stdout).toContain("[skip] rss — no rss.feeds");
      expect(r1.stdout).toContain("[ ok ] review");
      expect(r1.stdout).toContain("[ ok ] doctor");
      expect(existsSync(join(root, ".okb", "index.db"))).toBe(true);

      const r2 = await okb(["jobs", "--bundle", root]);
      expect(r2.code).toBe(0);
      expect(r2.stdout).toContain("skipped 1"); // index run 2: content-hash skip
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("held lock refuses the run; unknown --only is a usage error", async () => {
    const root = tempBundle();
    try {
      mkdirSync(join(root, ".okb"), { recursive: true });
      writeFileSync(
        lockFile(root),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
      const r = await okb(["jobs", "--bundle", root]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("lock");
      rmSync(lockFile(root));

      const bad = await okb(["jobs", "--only", "index,nonsense", "--bundle", root]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("unknown job: nonsense");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--only restricts the run", async () => {
    const root = tempBundle();
    try {
      await okb(["write", "notes/a", "--type", "note", "--title", "A", "--description", "d", "--bundle", root]);
      const r = await okb(["jobs", "--only", "doctor", "--bundle", root]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("doctor");
      expect(r.stdout).not.toContain("index (");
      expect(existsSync(join(root, ".okb", "index.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
