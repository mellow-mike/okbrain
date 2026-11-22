import { isAbsolute } from "node:path";
import { gatewayEnvironment, providerKeyStatus } from "../ai/local-keys.ts";
import {
  cancelCodingRequest, canonicalWorkspace, CodingError, CodingSessionBusyError, CodingSessionDeletingError, CodingSessionMissingError,
  deleteStandaloneCodingSession, inspectStandaloneCodingSession,
  listCodingModels, listStandaloneCodingRequests, listStandaloneCodingSessions, prepareCodingInput,
  previewCodingAttachments, previewStandaloneCodingContextReset, resetStandaloneCodingContext, runCodingSession,
  type CodingDependencies, type CodingLiveAnswer, type CodingProvider, type CodingSessionOptions, type CodingSessionResult,
} from "./durable.ts";
import { validateCodingProjectProfile } from "./project-profile.ts";
import { selectRepositoryContext, type RepositoryContextOptions } from "./repository-context.ts";
import type { CodingTaskProgress } from "./task-progress.ts";

type Input = Record<string, unknown>;
type Dependencies = Pick<CodingDependencies, "models" | "stateDir">;
type SessionRequest = { session: string; requestId: string };
type Selection =
  | { source: "files"; files: string[] }
  | { source: "repository"; repository: Omit<RepositoryContextOptions, "workspace"> };

interface ActiveRun extends SessionRequest {
  status: "running" | "done" | "unanswered" | "failed";
  admitted: boolean;
  cancelled?: boolean;
  error?: string;
  liveAnswer?: CodingLiveAnswer;
  taskProgress?: CodingTaskProgress;
}

const providerKey = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY" };
const personalKeyProvider = { openai: "openai", anthropic: "anthropic", google: "gemini" };
const sessionName = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const requestName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export class StandaloneControlError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function string(input: Input, key: string, limit: number): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit)
    throw new StandaloneControlError(`Enter a valid ${key}.`);
  return value;
}

function names(input: Input, key: string, limit: number): string[] {
  const value = input[key] ?? [];
  if (!Array.isArray(value) || value.length > limit ||
      !value.every((part) => typeof part === "string" && part.trim() && Buffer.byteLength(part) <= 4096))
    throw new StandaloneControlError(`Choose up to ${limit} valid ${key}.`);
  return value;
}

function sourceOf(input: Input): Selection {
  if (input.source === "files") return { source: "files", files: names(input, "files", 12) };
  if (input.source !== "repository") throw new StandaloneControlError("Choose files or tracked repository excerpts for this request.");
  const query = string(input, "query", 1024);
  const projects = names(input, "projects", 8);
  const profile = input.profile === undefined ? undefined : validateCodingProjectProfile(input.profile);
  if (!projects.length && !profile) throw new StandaloneControlError("Choose at least one tracked project directory or provide a repository profile.");
  const budget = input.contextTokens;
  if (budget !== undefined && (typeof budget !== "number" || !Number.isInteger(budget) || budget < 1 || budget > 16384))
    throw new StandaloneControlError("Choose a context budget between 1 and 16,384 tokens.");
  return { source: "repository", repository: { query, ...(projects.length ? { projects } : {}), profile, tokenBudget: budget } };
}

async function workspaceOf(input: Input): Promise<string> {
  const workspace = string(input, "workspace", 4096);
  if (!isAbsolute(workspace)) throw new StandaloneControlError("Enter the absolute path of the workspace.");
  return canonicalWorkspace(workspace);
}

function sessionOf(input: Input): string {
  const session = string(input, "session", 64);
  if (!sessionName.test(session)) throw new StandaloneControlError("Use 1–64 lowercase letters, digits, underscores or hyphens for the session name.");
  return session;
}

function requestOf(input: Input): string {
  const requestId = string(input, "requestId", 128);
  if (!requestName.test(requestId)) throw new StandaloneControlError("Enter a valid request ID.");
  return requestId;
}

/** Local browser lifecycle for the same private Pi stores used by `okb code`. */
export class StandaloneCodingControl {
  #runs = new Map<string, { view: ActiveRun; abort: AbortController; done: Promise<void> }>();
  #gates = new Map<string, Promise<void>>();
  #closed = false;
  constructor(private readonly dependencies: Dependencies = {}) {}

  async close(): Promise<void> {
    this.#closed = true;
    const current = [...this.#runs.values()];
    for (const run of current) if (run.view.status === "running") run.abort.abort();
    await Promise.allSettled([...this.#gates.values(), ...current.map(({ done }) => done)]);
    this.#runs.clear();
  }

  async dispatch(method: "GET" | "POST", path: string, input: Input, canWrite: () => boolean): Promise<unknown> {
    if (method === "GET" && path === "") return this.#catalog();
    if (method !== "POST") throw new StandaloneControlError("Standalone coding route not found.", 404);
    if (path === "/preview") {
      const workspace = await workspaceOf(input);
      const source = sourceOf(input);
      if (source.source === "files")
        return { source: "files", ...await previewCodingAttachments(workspace, source.files) };
      const selected = await selectRepositoryContext({ workspace, ...source.repository });
      return { source: "repository", id: selected.manifest.id, ...selected };
    }
    if (!["/inspect", "/run", "/resume", "/cancel", "/delete-session", "/reset-context-preview", "/reset-context"].includes(path))
      throw new StandaloneControlError("Standalone coding route not found.", 404);
    const session = sessionOf(input);
    if (path === "/inspect") return this.#inspect(session, input.requestId === undefined ? undefined : requestOf(input));
    return this.#withSession(session, () => this.#changeSession(session, path, input, canWrite));
  }

  #withSession<T>(session: string, change: () => Promise<T>): Promise<T> {
    const result = (this.#gates.get(session) ?? Promise.resolve()).then(change);
    const gate = result.then(() => {}, () => {});
    this.#gates.set(session, gate);
    return result.finally(() => { if (this.#gates.get(session) === gate) this.#gates.delete(session); });
  }

  async #changeSession(session: string, path: string, input: Input, canWrite: () => boolean) {
    this.#checkWrite(canWrite);
    const current = this.#runs.get(session);
    if (path === "/reset-context-preview" || path === "/reset-context") {
      if (current?.view.status === "running")
        throw new StandaloneControlError("Wait for this session to finish or cancel its run before starting fresh context.", 409);
      if (path === "/reset-context-preview") return previewStandaloneCodingContextReset(session, this.dependencies);
      const version = string(input, "version", 64);
      if (!/^[a-f0-9]{64}$/u.test(version)) throw new StandaloneControlError("Preview the active context before confirming a reset.");
      return resetStandaloneCodingContext(session, version, this.dependencies, () => this.#checkWrite(canWrite));
    }
    if (path === "/delete-session") {
      if (input.confirm !== session) throw new StandaloneControlError("Type the session name to confirm transcript deletion.");
      if (current?.view.status === "running")
        throw new StandaloneControlError("Wait for this session to finish or cancel its run before deleting it.", 409);
      const deleted = await deleteStandaloneCodingSession(session, this.dependencies, () => {
        this.#checkWrite(canWrite);
        this.#runs.delete(session);
      });
      this.#runs.delete(session);
      return { session, deleted };
    }
    const requestId = requestOf(input);
    const identity = { session, requestId };
    if (path === "/cancel" && current?.view.status === "running") {
      if (current.view.requestId !== requestId) throw new StandaloneControlError("Another request is active in this session.", 409);
      current.abort.abort();
      return current.view;
    }
    if (input.approved !== true && path !== "/cancel")
      throw new StandaloneControlError(path === "/resume" ? "Approve resuming the saved request." : "Approve the preview before sending.");
    if (current?.view.status === "running") {
      if (current.view.requestId === requestId) return current.view;
      throw new StandaloneControlError("Another request is active in this session.", 409);
    }
    if (path === "/run") {
      const workspace = await workspaceOf(input);
      const choice = listCodingModels(this.dependencies.models).find(({ provider }) => provider === input.provider);
      const model = choice?.models.find(({ id }) => id === input.model);
      if (!choice || !model) throw new StandaloneControlError("Choose an available Pi provider and model.");
      const thinkingLevel = model.thinkingLevels.find((level) => level === input.thinkingLevel);
      if (input.thinkingLevel !== undefined && !thinkingLevel) throw new StandaloneControlError("Choose a supported reasoning level.");
      const source = sourceOf(input);
      const previewId = string(input, "previewId", 64);
      if (!/^[a-f0-9]{64}$/u.test(previewId)) throw new StandaloneControlError("Preview the source before sending.");
      const options: CodingSessionOptions = {
        ...identity, workspace, provider: choice.provider, model: model.id, thinkingLevel,
        prompt: string(input, "prompt", 16_384),
        ...(input.approvedSourceLookup === true ? { approvedSourceLookup: true } : {}),
        ...(source.source === "files" ? { files: source.files, filePreviewId: previewId } : { repository: { ...source.repository, id: previewId } }),
      };
      const preparedInput = await prepareCodingInput(options, workspace);
      this.#checkWrite(canWrite);
      return this.#launch(identity, (signal, updates) => runCodingSession(options, {
        ...this.#runner(choice.provider, workspace), preparedInput, requireNewRequest: true, signal, ...updates,
      }));
    }
    const saved = await listStandaloneCodingRequests(session, this.dependencies);
    const chosen = saved.requests.find((request) => request.requestId === requestId);
    if (!chosen) throw new StandaloneControlError("That request is missing from this session.", 404);
    const options = { ...saved.identity, requestId };
    this.#checkWrite(canWrite);
    if (path === "/cancel") {
      if (chosen.status === "done" || chosen.status === "unanswered")
        throw new StandaloneControlError("That request has already settled.", 409);
      const receipt = await cancelCodingRequest(options, { ...this.dependencies, workspaceBinding: options.workspace });
      return { ...identity, admitted: true, status: receipt.status, receipt, cancelled: receipt.status === "unanswered" };
    }
    return this.#launch(identity, (signal, updates) => runCodingSession(options, {
      ...this.#runner(saved.identity.provider, options.workspace), signal, ...updates,
    }));
  }

  #checkWrite(canWrite: () => boolean): void {
    if (this.#closed || !canWrite()) throw new StandaloneControlError("Open a writable brain to change local coding sessions.", 403);
  }

  async #catalog() {
    const status = providerKeyStatus();
    const models = listCodingModels(this.dependencies.models).map((model) => {
      const key = status.find(({ provider }) => provider === personalKeyProvider[model.provider]);
      return { ...model, credential: key?.environment ? "environment" : key?.saved ? "saved" : "missing" };
    });
    return { models, sessions: await listStandaloneCodingSessions(this.dependencies) };
  }

  #runner(provider: CodingProvider, workspace: string): CodingDependencies {
    return {
      ...this.dependencies,
      workspaceBinding: workspace,
      apiKey: gatewayEnvironment()[providerKey[provider]],
      allowEnvKey: false,
    };
  }

  async #inspect(session: string, requestId?: string) {
    const active = this.#runs.get(session)?.view;
    if (active?.status === "running") return { active, requests: [] };
    const relevant = active && (!requestId || active.requestId === requestId) ? active : undefined;
    const refused = relevant?.status === "failed" && !relevant.admitted;
    try {
      const { identity, requests } = await listStandaloneCodingRequests(session, this.dependencies);
      const selected = requestId && requests.some((request) => request.requestId === requestId) ? requestId : undefined;
      const pi = await inspectStandaloneCodingSession(session, selected, this.dependencies);
      const hasCurrentRequest = relevant && requests.some((request) => request.requestId === relevant.requestId);
      return { identity, requests, pi, ...(refused || hasCurrentRequest ? { active: relevant } : {}) };
    } catch (error) {
      if (error instanceof CodingSessionDeletingError) {
        if (this.#runs.get(session)?.view === active) this.#runs.delete(session);
        return { state: "deleting", requests: [] };
      }
      if (error instanceof CodingSessionBusyError) return { state: "busy", requests: [] };
      if (refused) return { active: relevant, requests: [] };
      if (error instanceof CodingSessionMissingError && this.#runs.get(session)?.view === active) this.#runs.delete(session);
      throw error;
    }
  }

  #launch(identity: SessionRequest, run: (signal: AbortSignal, updates: Pick<CodingDependencies, "admitted" | "liveAnswer" | "taskProgress">) => Promise<CodingSessionResult>) {
    const existing = this.#runs.get(identity.session);
    if (existing?.view.status === "running") {
      if (existing.view.requestId === identity.requestId) return existing.view;
      throw new StandaloneControlError("Another request is active in this session.", 409);
    }
    const abort = new AbortController();
    const view: ActiveRun = { ...identity, status: "running", admitted: false };
    const done = Promise.resolve().then(async () => {
      try {
        const receipt = await run(abort.signal, {
          admitted: () => { view.admitted = true; },
          liveAnswer: (answer) => { view.liveAnswer = answer; },
          taskProgress: (progress) => { view.taskProgress = progress; },
        });
        view.status = receipt.status;
      } catch (error) {
        view.status = "failed";
        view.error = abort.signal.aborted ? "Cancelled before the request could finish." :
          error instanceof CodingError ? error.message : "The local Pi request could not finish.";
      } finally {
        view.liveAnswer = undefined;
        view.taskProgress = undefined;
        if (abort.signal.aborted) view.cancelled = true;
        // Keep recent failures available for polling. Settled requests are also in Pi storage.
        if (this.#runs.size > 64) {
          for (const [session, run] of this.#runs) {
            if (run.view.status !== "running" && session !== identity.session) this.#runs.delete(session);
            if (this.#runs.size <= 64) break;
          }
        }
      }
    });
    this.#runs.delete(identity.session);
    this.#runs.set(identity.session, { view, abort, done });
    return view;
  }
}
