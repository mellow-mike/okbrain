import { mkdirSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { AtlasLocation } from "./atlas/store.ts";
import { dockerWorkerStateDir, planDockerWorker, type DockerWorkerConfig } from "./docker-worker.ts";
import {
  canonicalWorkspace, CodingError, maxLiveAnswerLength, prepareCodingInput, runCodingSession,
  type CodingLiveAnswer, type CodingSessionOptions, type PreparedCodingInput,
} from "./durable.ts";
import { checkProviderModel, parseProviderCheckOutcome, type ProviderCheckInput, type ProviderCheckOutcome } from "./provider-check.ts";
import { parseCodingTaskProgress, type CodingTaskProgress } from "./task-progress.ts";

type Request = { stateDir: string; workspaceBinding: string; options: CodingSessionOptions; apiKey?: string };
/** What the server knows and the worker is never told: where the project's repository map is kept. */
type LaunchRequest = Request & { atlas?: AtlasLocation };
type WorkerRequest = Request & { type?: undefined; stateBinding?: string; preparedInput?: PreparedCodingInput };
type ProviderCheckRequest = ProviderCheckInput & { type: "provider-check" };
type Event = { type: "admitted" } | { type: "answer"; answer: CodingLiveAnswer | null }
  | { type: "task-progress"; progress: CodingTaskProgress | null }
  | { type: "settled"; status: "done" | "unanswered" } | { type: "error"; error: string }
  | { type: "provider-check"; outcome: ProviderCheckOutcome };
type WorkerCallbacks = {
  admitted: () => void;
  liveAnswer: (answer: CodingLiveAnswer | undefined) => void;
  taskProgress: (progress: CodingTaskProgress | undefined) => void;
};
const maxWorkerInputBytes = 512 * 1024; // Even doubly escaped explicit text must fit the pipe.
const maxProviderCheckInputBytes = 24 * 1024;
const maxProviderCheckOutputBytes = 1024;
const providerWorkerDeadline = 20_000;
export const projectWorkerArg = "--project-worker";
export class ProjectWorkerInterrupted extends Error {}
export class ProjectProviderCheckDisallowed extends Error {}

export async function runProjectWorker(): Promise<number> {
  if (process.stdin.isTTY || process.stdout.isTTY) return 2;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const controller = new AbortController();
  const send = (event: Event) => new Promise<void>((resolve) =>
    process.stdout.write(JSON.stringify(event) + "\n", () => resolve()));
  const finish = () => {
    input.close();
    process.stdin.pause();
  };
  let started = false;
  try {
    for await (const line of input) {
      if (started) {
        if (line === "cancel") controller.abort();
        continue;
      }
      if (Buffer.byteLength(line) > maxWorkerInputBytes) return 2;
      started = true;
      const request = JSON.parse(line) as WorkerRequest | ProviderCheckRequest;
      if (request.type === "provider-check") {
        if (Object.keys(request).length !== 4 || Buffer.byteLength(line) > maxProviderCheckInputBytes ||
            typeof request.provider !== "string" || typeof request.model !== "string" || typeof request.apiKey !== "string") return 2;
        void checkProviderModel(request, controller.signal).then(async (outcome) => {
          await send({ type: "provider-check", outcome });
          finish();
        }, () => {
          process.exitCode = 1;
          finish();
        });
        continue;
      }
      if (request.type !== undefined) return 2;
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
        liveAnswer: (answer) => send({ type: "answer", answer: answer ?? null }),
        taskProgress: (progress) => send({ type: "task-progress", progress: progress ?? null }),
      }).then(async (result) => {
        await send({ type: "settled", status: result.status });
        finish();
      }, async (error: unknown) => {
        if (error instanceof CodingError) await send({ type: "error", error: error.message });
        else process.exitCode = 1;
        finish();
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
const workerEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => workerEnvs.has(name.toUpperCase())));

function workerArgv() {
  // The standalone app starts its CLI entry again. Development runs the source module with Bun.
  return Bun.embeddedFiles.length > 0
    ? [process.execPath, projectWorkerArg]
    : [process.execPath, "--no-env-file", import.meta.path];
}

function launchPipe(request: WorkerRequest, signal: AbortSignal, callbacks: WorkerCallbacks, docker?: ReturnType<typeof planDockerWorker>) {
  const env = workerEnv();
  const argv = docker?.argv ?? workerArgv();
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
        if (event.type === "admitted") callbacks.admitted();
        else if (event.type === "answer") {
          if (event.answer === null) callbacks.liveAnswer(undefined);
          else if (typeof event.answer?.text === "string" && event.answer.text.length <= maxLiveAnswerLength
            && typeof event.answer.truncated === "boolean") {
            callbacks.liveAnswer({ text: event.answer.text, truncated: event.answer.truncated });
          }
        } else if (event.type === "task-progress") {
          if (event.progress === null) callbacks.taskProgress(undefined);
          else {
            const progress = parseCodingTaskProgress(event.progress);
            if (progress) callbacks.taskProgress(progress);
          }
        } else if (event.type === "settled" || event.type === "error") disposition = event;
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

function providerWorkerUnavailable() {
  return new ProjectWorkerInterrupted("The configured coding worker could not report a provider check result.");
}

/** Contact only the selected provider from a worker with no workspace or saved session. */
export async function launchProjectProviderCheck(
  { provider, model, apiKey }: ProviderCheckInput,
  options: { docker?: DockerWorkerConfig; signal: AbortSignal; canLaunch?: () => boolean },
): Promise<ProviderCheckOutcome> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(providerWorkerDeadline)]);
  const env = workerEnv();
  let directory: string | undefined;
  let docker: ReturnType<typeof planDockerWorker> | undefined;
  let completed = false;
  try {
    signal.throwIfAborted();
    const request: ProviderCheckRequest = { type: "provider-check", provider, model, apiKey };
    const line = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(line) > maxProviderCheckInputBytes) throw providerWorkerUnavailable();
    directory = await mkdtemp(join(await realpath(tmpdir()), "okb-provider-check-"));
    signal.throwIfAborted();
    if (options.canLaunch && !options.canLaunch()) throw new ProjectProviderCheckDisallowed();
    if (options.docker) docker = planDockerWorker(options.docker, directory, "provider-check");
    const child = Bun.spawn(docker?.argv ?? workerArgv(), {
      cwd: directory, env, stdin: "pipe", stdout: "pipe", stderr: "ignore", maxBuffer: maxProviderCheckOutputBytes,
    });
    const stop = () => {
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* the child may have exited */ }
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      // Only this private pipe carries the credential. Docker logging is disabled in the shared plan.
      await child.stdin.write(line);
      await child.stdin.flush();
      const bytes = Buffer.alloc(maxProviderCheckOutputBytes);
      let length = 0;
      for await (const chunk of child.stdout) {
        if (chunk.byteLength > bytes.length - length) throw providerWorkerUnavailable();
        bytes.set(chunk, length);
        length += chunk.byteLength;
      }
      if (await child.exited !== 0 || signal.aborted) throw providerWorkerUnavailable();
      const event: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      const outcome = event && typeof event === "object" && "type" in event && event.type === "provider-check" &&
        "outcome" in event && Object.keys(event).length === 2 ? parseProviderCheckOutcome(event.outcome) : undefined;
      if (!outcome) throw providerWorkerUnavailable();
      completed = true;
      return outcome;
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      try { await child.stdin.end(); } catch { /* the child may have already closed its pipe */ }
      await child.exited;
    }
  } catch (error) {
    if (error instanceof ProjectProviderCheckDisallowed) throw error;
    // Never attach raw process errors, paths, or child output to this diagnostic.
    throw providerWorkerUnavailable();
  } finally {
    if (docker && !completed) await docker.cleanup(env).catch(() => {});
    if (directory) {
      try { await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); }
      catch { throw providerWorkerUnavailable(); }
    }
  }
}

export function launchProjectWorker({ atlas, ...request }: LaunchRequest, signal: AbortSignal, callbacks: WorkerCallbacks, docker?: DockerWorkerConfig) {
  if (!docker) {
    mkdirSync(request.stateDir, { recursive: true, mode: 0o700 });
    const { options } = request;
    if (options.prompt === undefined || (!options.atlas && !options.orchestration)) return launchPipe(request, signal, callbacks);
    // The repository map lives in this server's application data, which the
    // worker's reduced environment does not locate. Select here and hand the
    // worker the approved input, as the Docker launcher does for every source.
    let worker: ReturnType<typeof launchPipe> | undefined;
    let stopped = false;
    const result = (async () => {
      const workspace = await canonicalWorkspace(options.workspace);
      if (workspace !== request.workspaceBinding) throw new CodingError("The authorized workspace path changed since this project was registered.");
      const preparedInput = await prepareCodingInput(options, workspace, {
        workspaceBinding: request.workspaceBinding, apiKey: request.apiKey, allowEnvKey: false, ...(atlas ? { atlas } : {}),
      });
      if (stopped) throw new ProjectWorkerInterrupted("The coding server stopped before launching the worker.");
      if (signal.aborted) throw new CodingError("The coding request was cancelled before admission.");
      worker = launchPipe({ ...request, preparedInput }, signal, callbacks);
      return worker.result;
    })();
    return { stop() { stopped = true; worker?.stop(); }, result };
  }

  let worker: ReturnType<typeof launchPipe> | undefined;
  let stopped = false;
  const result = (async () => {
    const { options, workspaceBinding, stateDir, apiKey } = request;
    let preparedInput: PreparedCodingInput | undefined;
    if (options.prompt !== undefined) {
      const workspace = await canonicalWorkspace(options.workspace);
      if (workspace !== workspaceBinding) throw new CodingError("The authorized workspace path changed since this project was registered.");
      preparedInput = await prepareCodingInput(options, workspace, { workspaceBinding, apiKey, allowEnvKey: false, ...(atlas ? { atlas } : {}) });
    }
    if (stopped) throw new ProjectWorkerInterrupted("The coding server stopped before launching the worker.");
    if (signal.aborted) throw new CodingError("The coding request was cancelled before admission.");
    const plan = planDockerWorker(docker, stateDir, options.branch?.parentSession ?? options.session);
    try {
      worker = launchPipe({
        stateDir: dockerWorkerStateDir, stateBinding: stateDir, workspaceBinding, preparedInput, apiKey,
        options: { session: options.session, requestId: options.requestId, workspace: options.workspace,
          provider: options.provider, model: options.model, thinkingLevel: options.thinkingLevel, branch: options.branch },
      }, signal, callbacks, plan);
    } catch (error) {
      if (error instanceof CodingError) throw error;
      throw new ProjectWorkerInterrupted("The Docker coding worker could not start. Check that Docker is installed and available to the server.", { cause: error });
    }
    return worker.result;
  })();
  return { stop() { stopped = true; worker?.stop(); }, result };
}

if (import.meta.main) process.exit(await runProjectWorker());
