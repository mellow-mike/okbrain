import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { dockerWorkerStateDir, planDockerWorker, type DockerWorkerConfig } from "./docker-worker.ts";
import { canonicalWorkspace, CodingError, prepareCodingInput, runCodingSession, type CodingSessionOptions, type PreparedCodingInput } from "./durable.ts";

type Request = { stateDir: string; workspaceBinding: string; options: CodingSessionOptions; apiKey?: string };
type WorkerRequest = Request & { stateBinding?: string; preparedInput?: PreparedCodingInput };
type Event = { type: "admitted" } | { type: "settled"; status: "done" | "unanswered" } | { type: "error"; error: string };
const maxWorkerInputBytes = 512 * 1024; // Even doubly escaped explicit text must fit the pipe.
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
      if (Buffer.byteLength(line) > maxWorkerInputBytes) return 2;
      started = true;
      const request = JSON.parse(line) as WorkerRequest;
      if (request.stateBinding !== undefined && (request.stateDir !== dockerWorkerStateDir || request.options.prompt !== undefined)) return 2;
      void runCodingSession(request.options, {
        stateDir: request.stateDir,
        stateBinding: request.stateBinding,
        workspaceBinding: request.workspaceBinding,
        preparedInput: request.preparedInput,
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

function launchPipe(request: WorkerRequest, signal: AbortSignal, admitted: () => void, docker?: ReturnType<typeof planDockerWorker>) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => workerEnvs.has(name.toUpperCase())));
  const standalone = Bun.embeddedFiles.length > 0;
  // The standalone app starts its CLI entry again. Development runs the source module with Bun.
  const argv = docker?.argv ?? (standalone
    ? [process.execPath, projectWorkerArg]
    : [process.execPath, "--no-env-file", import.meta.path]);
  const line = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(line) > maxWorkerInputBytes) throw new CodingError("The approved coding request exceeds the worker input limit.");
  const child = Bun.spawn(argv, { cwd: request.stateBinding ?? request.stateDir, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const stop = () => { child.kill(docker ? "SIGKILL" : undefined); };
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
      await child.stdin.write(line);
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
      throw new ProjectWorkerInterrupted(docker && !disposition && code === 125
        ? "Docker could not start the configured coding worker. Check the local image, daemon and network."
        : "The coding worker exited before reporting its result. Inspect the saved request to recover it.");
    } catch (error) {
      if (error instanceof CodingError || error instanceof ProjectWorkerInterrupted) throw error;
      throw new ProjectWorkerInterrupted("The coding worker lost its connection to the server.", { cause: error });
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.close();
      try { await child.stdin.end(); } catch { /* the worker may have already closed its pipe */ }
      if (child.exitCode === null) stop();
      await child.exited;
      if (docker && !disposition) await docker.cleanup(env).catch(() => {});
    }
  })();
  return { stop, result };
}

export function launchProjectWorker(request: Request, signal: AbortSignal, admitted: () => void, docker?: DockerWorkerConfig) {
  if (!docker) {
    mkdirSync(request.stateDir, { recursive: true, mode: 0o700 });
    return launchPipe(request, signal, admitted);
  }

  let worker: ReturnType<typeof launchPipe> | undefined;
  let stopped = false;
  const result = (async () => {
    const { options, workspaceBinding, stateDir, apiKey } = request;
    let preparedInput: PreparedCodingInput | undefined;
    if (options.prompt !== undefined) {
      const workspace = await canonicalWorkspace(options.workspace);
      if (workspace !== workspaceBinding) throw new CodingError("The authorized workspace path changed since this project was registered.");
      preparedInput = await prepareCodingInput(options, workspace);
    }
    if (stopped) throw new ProjectWorkerInterrupted("The coding server stopped before launching the worker.");
    if (signal.aborted) throw new CodingError("The coding request was cancelled before admission.");
    const plan = planDockerWorker(docker, stateDir, options.session);
    try {
      worker = launchPipe({
        stateDir: dockerWorkerStateDir, stateBinding: stateDir, workspaceBinding, preparedInput, apiKey,
        options: { session: options.session, requestId: options.requestId, workspace: options.workspace,
          provider: options.provider, model: options.model, thinkingLevel: options.thinkingLevel },
      }, signal, admitted, plan);
    } catch (error) {
      if (error instanceof CodingError) throw error;
      throw new ProjectWorkerInterrupted("The Docker coding worker could not start. Check that Docker is installed and available to the server.", { cause: error });
    }
    return worker.result;
  })();
  return { stop() { stopped = true; worker?.stop(); }, result };
}

if (import.meta.main) process.exit(await runProjectWorker());
