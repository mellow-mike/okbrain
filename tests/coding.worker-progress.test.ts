import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { parseCodingTaskProgress, type CodingTaskProgress } from "../src/core/coding/task-progress.ts";

test("the Bun worker pipe emits only bounded stages and clears them after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-worker-progress-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  await mkdir(workspace);
  await mkdir(stateDir);
  const script = `
    // Hold the real SDK call at the transport boundary. No network requests leave the fixture.
    globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
      const stop = () => reject(new DOMException("Stopped", "AbortError"));
      const signal = init?.signal ?? input?.signal;
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    });
    const { runProjectWorker } = await import("./src/core/coding/project-worker.ts");
    process.exit(await runProjectWorker());
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: resolve(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const lines = createInterface({ input: Readable.fromWeb(child.stdout), crlfDelay: Infinity });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
  try {
    const workspaceBinding = await realpath(workspace);
    await child.stdin.write(JSON.stringify({
      stateDir, workspaceBinding, apiKey: "private-fixture-credential",
      options: {
        workspace: workspaceBinding, session: "main", requestId: "held", model: "gpt-5-mini", provider: "openai",
        prompt: "private-fixture-task",
      },
    }) + "\n");
    await child.stdin.flush();
    const snapshots: CodingTaskProgress[] = [];
    let cancelled = false;
    let settled: string | undefined;
    for await (const line of lines) {
      const event = JSON.parse(line) as { type?: string; status?: string; progress?: unknown };
      if (event.type === "settled") settled = event.status;
      if (event.type !== "task-progress" || event.progress === null) continue;
      const progress = parseCodingTaskProgress(event.progress);
      expect(JSON.stringify(progress)).toBe(JSON.stringify(event.progress));
      expect(line).not.toContain("private-fixture");
      expect(line).not.toContain(workspaceBinding);
      snapshots.push(progress!);
      if (!cancelled && progress?.stages.some(({ kind, running }) => kind === "model" && running)) {
        cancelled = true;
        await child.stdin.write("cancel\n");
        await child.stdin.flush();
      }
    }
    expect(await child.exited).toBe(0);
    expect(cancelled).toBe(true);
    expect(settled).toBe("unanswered");
    expect(snapshots.at(-1)).toEqual({ stages: [] });
  } finally {
    clearTimeout(timeout);
    lines.close();
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
