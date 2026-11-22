import { expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceScheduler, type MaintenanceSchedulerOptions, type MaintenanceTarget } from "../src/core/jobs/schedule.ts";

const hour = 3600_000;
const day = 24 * hour;

async function fixture(action: (path: string, target: MaintenanceTarget) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "okb-schedule-"));
  try { await action(join(root, "schedule.sqlite"), { path: join(root, "brain"), brain: "Research" }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("persisted maintenance is lazy, catches up once, and keeps the named target and job receipts", async () => {
  await fixture(async (path, target) => {
    let now = 100;
    let runs = 0;
    const options: MaintenanceSchedulerOptions = {
      path, now: () => now, allowed: () => true, intervalMs: 60_000,
      run: async (schedule) => {
        runs++;
        expect(schedule).toMatchObject({ target, nextAt: now + 6 * hour, lastRun: { status: "running", startedAt: now } });
        return { status: "completed", jobs: [{ name: "index", status: "completed", ms: 12 }] };
      },
    };
    const first = new MaintenanceScheduler(options);
    first.start();
    try {
      await first.tick();
      expect(first.get(target)).toBeNull();
      expect(first.pause(target)).toBeNull();
      expect(first.remove(target)).toBeNull();
      await expect(lstat(path)).rejects.toThrow();
      const saved = first.save(target, { cadence: "6h", jobs: ["index"] });
      expect(saved).toEqual({ target, cadence: "6h", jobs: ["index"], enabled: true, nextAt: now + 6 * hour });
      if (process.platform !== "win32") expect((await lstat(path)).mode & 0o077).toBe(0);
      await first.tick();
      expect(runs).toBe(0);
    } finally { await first.stop(); }

    const next = new MaintenanceScheduler(options);
    now += 4 * day;
    expect(next.get(target)?.target).toEqual(target);
    await next.tick();
    await next.tick();
    expect(runs).toBe(1);
    expect(next.get(target)).toMatchObject({ nextAt: now + 6 * hour, lastRun: {
      status: "completed", startedAt: now, finishedAt: now, jobs: [{ name: "index", status: "completed", ms: 12 }],
    } });
    expect(next.pause(target)).toMatchObject({ enabled: false, nextAt: null, lastRun: { status: "completed" } });
    now += day;
    await next.tick();
    expect(runs).toBe(1);
    expect(next.remove(target)).toBeNull();
    expect(next.get(target)).toBeNull();
  });
});

test("a live worker keeps its occurrence and a replacement generation keeps only its own results", async () => {
  await fixture(async (path, target) => {
    let now = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let current: (() => boolean) | undefined;
    const first = new MaintenanceScheduler({ path, now: () => now, allowed: () => true,
      run: async (_schedule, _signal, isCurrent) => {
        current = isCurrent;
        entered.resolve();
        await release.promise;
        return { status: "completed", message: "Old settings" };
      },
    });
    let nextRuns = 0;
    const next = new MaintenanceScheduler({ path, now: () => now, allowed: () => true,
      run: async () => { nextRuns++; return { status: "skipped", message: "New settings" }; },
    });
    first.save(target, { cadence: "daily", jobs: ["index"] });
    now = day;
    const running = first.tick();
    try {
      await entered.promise;
      await next.tick();
      expect(next.get(target)?.lastRun?.status).toBe("running");
      expect(current?.()).toBe(true);
      expect(next.save(target, { cadence: "weekly", jobs: ["doctor"], approvals: { embed: "test-receipt" } }))
        .toEqual({ target, cadence: "weekly", jobs: ["doctor"], approvals: { embed: "test-receipt" }, enabled: true, nextAt: 8 * day });
      expect(current?.()).toBe(false);
      now = 8 * day;
      await next.tick();
      expect(nextRuns).toBe(0);
    } finally { release.resolve(); await running; }
    expect(next.get(target)?.lastRun).toBeUndefined();
    await next.tick();
    expect(nextRuns).toBe(1);
    expect(next.get(target)?.lastRun).toMatchObject({ status: "skipped", message: "New settings" });
    expect(next.save(target, { cadence: "daily", jobs: ["index"] }).lastRun)
      .toMatchObject({ status: "skipped", message: "New settings" });
  });
});

test("a different process recovers an interrupted occurrence without resetting a live worker", async () => {
  await fixture(async (path, target) => {
    let now = 0;
    let runs = 0;
    const scheduler = new MaintenanceScheduler({ path, now: () => now, allowed: () => true,
      run: async () => { runs++; return { status: "completed" }; },
    });
    scheduler.save(target, { cadence: "daily", jobs: ["index"] });
    now = day;
    const script = `
      import { MaintenanceScheduler } from "./src/core/jobs/schedule.ts";
      const { path, now } = JSON.parse(process.argv.at(-1));
      const scheduler = new MaintenanceScheduler({ path, now: () => now, allowed: () => true,
        run: () => { process.stdout.write("running\\n"); return new Promise(() => {}); },
      });
      setInterval(() => {}, 10000);
      await scheduler.tick();
    `;
    const child = Bun.spawn([process.execPath, "-e", script, "--", JSON.stringify({ path, now })], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const reader = child.stdout.getReader();
      try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("running\n"); }
      finally { reader.releaseLock(); }
      await scheduler.tick();
      expect(scheduler.get(target)?.lastRun?.status).toBe("running");
      expect(runs).toBe(0);
    } finally { clearTimeout(timer); child.kill("SIGKILL"); await child.exited; }

    await scheduler.tick();
    expect(scheduler.get(target)).toMatchObject({ nextAt: 2 * day, lastRun: { status: "interrupted", startedAt: day, finishedAt: day } });
    expect(runs).toBe(0);
    now = 2 * day;
    await scheduler.tick();
    expect(runs).toBe(1);
  });
});

test("shutdown signals the runner, waits for its in-flight job, and records interruption", async () => {
  await fixture(async (path, target) => {
    let now = 0;
    const entered = Promise.withResolvers<void>();
    const signaled = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const scheduler = new MaintenanceScheduler({
      path, now: () => now, allowed: () => true, run: async (_schedule, signal) => {
        signal.addEventListener("abort", () => signaled.resolve(), { once: true });
        entered.resolve();
        await complete.promise;
        return { status: "completed", jobs: [{ name: "index", status: "completed", ms: 3 }] };
      },
    });
    scheduler.save(target, { cadence: "daily", jobs: ["index", "review"] });
    now = day;
    const running = scheduler.tick();
    try {
      await entered.promise;
      const stopped = scheduler.stop();
      await signaled.promise;
      expect(scheduler.get(target)?.lastRun?.status).toBe("running");
      complete.resolve();
      await stopped;
      expect(scheduler.get(target)?.lastRun).toMatchObject({ status: "interrupted", jobs: [{ name: "index", status: "completed", ms: 3 }] });
      expect(() => scheduler.save(target, { cadence: "daily", jobs: ["index"] })).toThrow("shutting down");
      expect(() => scheduler.pause(target)).toThrow("shutting down");
      expect(() => scheduler.remove(target)).toThrow("shutting down");
    } finally { complete.resolve(); await running; await scheduler.stop(); }
  });
});

test("an app instance that cannot write a target leaves it due for the eligible app", async () => {
  await fixture(async (path, target) => {
    let now = 0;
    const blocked = new MaintenanceScheduler({ path, now: () => now, allowed: () => false,
      run: async () => { throw new Error("This app cannot run a job on that brain."); },
    });
    blocked.save(target, { cadence: "daily", jobs: ["doctor"] });
    now = day;
    await blocked.tick();
    expect(blocked.get(target)).toMatchObject({ target, enabled: true, nextAt: day });
    expect(blocked.get(target)?.lastRun).toBeUndefined();
    const allowed = new MaintenanceScheduler({ path, now: () => now, allowed: (stored) => stored.brain === target.brain,
      run: async () => ({ status: "completed" }),
    });
    await allowed.tick();
    expect(allowed.get(target)?.lastRun?.status).toBe("completed");
  });
});
