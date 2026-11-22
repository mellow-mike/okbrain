import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { CodingError, runCodingSession, type CodingSessionOptions } from "./durable.ts";

type Request = { stateDir: string; workspaceBinding: string; options: CodingSessionOptions; apiKey?: string };
type Event = { type: "admitted" } | { type: "settled"; status: "done" | "unanswered" } | { type: "error"; error: string };
export const projectWorkerArg = "--project-worker";
export class ProjectWorkerInterrupted extends Error {}

export async function runProjectWorker(): Promise<number> {
  if (process.stdin.isTTY || process.stdout.isTTY) return 2;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const controller = new AbortController();
  const send = (event: Event) => new Promise<void>((resolve) =>
    process.stdout.write(JSON.stringify(event) + "\n", () => resolve()));
  let started = false;
  try {
    for await (const line of input) {
      if (started) {
        if (line === "cancel") controller.abort();
        continue;
      }
      if (Buffer.byteLength(line) > 160 * 1024) return 2;
      started = true;
      const request = JSON.parse(line) as Request;
      void runCodingSession(request.options, {
        stateDir: request.stateDir,
        workspaceBinding: request.workspaceBinding,
        apiKey: request.apiKey,
        allowEnvKey: false,
        signal: controller.signal,
        admitted: () => { void send({ type: "admitted" }); },
      }).then(async (result) => {
        await send({ type: "settled", status: result.status });
        input.close();
        process.stdin.pause();
      }, async (error: unknown) => {
        if (error instanceof CodingError) await send({ type: "error", error: error.message });
        else process.exitCode = 1;
        input.close();
        process.stdin.pause();
      });
    }
  } catch {
    return 2;
  }
  // An EOF while work is active means the supervisor disappeared. Exit without
  // withdrawing admitted work so the next server can recover it from Pi.
  return process.exitCode === 1 ? 1 : started ? 0 : 2;
}

const workerEnvs = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "OKB_SQLITE_LIB"]);

export function launchProjectWorker(request: Request, signal: AbortSignal, admitted: () => void) {
  mkdirSync(request.stateDir, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => workerEnvs.has(name.toUpperCase())));
  // The standalone app starts its CLI entry again. Development and tests run
  // the source module with Bun. A compiled source path exists but has size 0.
  const standalone = Bun.embeddedFiles.length > 0;
  const argv = standalone
    ? [process.execPath, projectWorkerArg]
    : [process.execPath, "--no-env-file", import.meta.path];
  const child = Bun.spawn(argv, { cwd: request.stateDir, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const stop = () => { child.kill(); };
  const cancel = () => {
    void Promise.resolve().then(async () => {
      await child.stdin.write("cancel\n");
      await child.stdin.flush();
    }).catch(stop);
  };
  const result = (async () => {
    let disposition: Extract<Event, { type: "settled" | "error" }> | undefined;
    const reader = createInterface({ input: Readable.fromWeb(child.stdout), crlfDelay: Infinity });
    try {
      // The credential and selected task are sent over the private child
      // process pipe. Neither belongs on the command line or in the log.
      await child.stdin.write(JSON.stringify(request) + "\n");
      await child.stdin.flush();
      if (signal.aborted) cancel();
      signal.addEventListener("abort", cancel, { once: true });
      for await (const line of reader) {
        const event = JSON.parse(line) as Event;
        if (event.type === "admitted") admitted();
        else if (event.type === "settled" || event.type === "error") disposition = event;
      }
      const code = await child.exited;
      if (code === 0 && disposition?.type === "settled") return disposition.status;
      if (code === 0 && disposition?.type === "error") throw new CodingError(disposition.error);
      throw new ProjectWorkerInterrupted("The coding worker exited before reporting its result. Inspect the saved request to recover it.");
    } catch (error) {
      if (error instanceof CodingError || error instanceof ProjectWorkerInterrupted) throw error;
      throw new ProjectWorkerInterrupted("The coding worker lost its connection to the server.", { cause: error });
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.close();
      try { await child.stdin.end(); } catch { /* the worker may have already closed its pipe */ }
      if (child.exitCode === null) stop();
      await child.exited;
    }
  })();
  return { stop, result };
}

if (import.meta.main) process.exit(await runProjectWorker());
