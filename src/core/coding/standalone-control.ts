import { isAbsolute, join } from "node:path";
import { gatewayEnvironment, providerKeyStatus } from "../ai/local-keys.ts";
import { resolveActor } from "../config.ts";
import { browserImportOptions, browserRepositoryFiles, RepositoryImports } from "./atlas/browser.ts";
import { addLesson, AtlasBusyError, AtlasError, atlasStatus, forgetLearning } from "./atlas/context.ts";
import { normalizeScopes } from "./atlas/import.ts";
import { Learning } from "./atlas/learn.ts";
import { listSkills } from "./atlas/skills.ts";
import { Atlas, type AtlasLocation } from "./atlas/store.ts";
import {
  cancelCodingRequest, canonicalWorkspace, CodingError, codingProviders, CodingSessionBusyError, CodingSessionDeletingError, CodingSessionMissingError,
  compactStandaloneCodingContext, deleteStandaloneCodingSession, inspectStandaloneCodingSession,
  getStandaloneCodingIdentity, listCodingModels, listStandaloneCodingRequests, listStandaloneCodingSessions, parseCodingHandoff, prepareCodingInput,
  previewAtlasContext, previewCodingOrchestration,
  previewCodingAttachments, previewStandaloneCodingContextCompaction, previewStandaloneCodingContextReset,
  requireNoPendingCodingContextCompaction, resetStandaloneCodingContext, runCodingSession,
  type CodingDependencies, type CodingLiveAnswer, type CodingProvider, type CodingSessionOptions, type CodingSessionResult,
} from "./durable.ts";
import { maxWorkers } from "./orchestrator.ts";
import { recordCodingOutcome } from "./outcomes.ts";
import { validateCodingProjectProfile } from "./project-profile.ts";
import { selectRepositoryContext, type RepositoryContextOptions } from "./repository-context.ts";
import { RoutingError, validateRoutingPolicy } from "./router.ts";
import { codingRunReport } from "./run-report.ts";
import { codingSourceManifest } from "./source-manifest.ts";
import type { CodingTaskProgress } from "./task-progress.ts";

type Input = Record<string, unknown>;
type Dependencies = Pick<CodingDependencies, "models" | "stateDir">;
type SessionRequest = { session: string; requestId: string };
type Selection =
  | { source: "files"; files: string[] }
  | { source: "repository"; repository: Omit<RepositoryContextOptions, "workspace"> }
  | { source: "atlas"; atlas: Omit<NonNullable<CodingSessionOptions["atlas"]>, "id"> }
  | { source: "orchestrated"; orchestration: Omit<NonNullable<CodingSessionOptions["orchestration"]>, "id"> };

interface ActiveRun extends SessionRequest {
  status: "running" | "done" | "unanswered" | "failed";
  admitted: boolean;
  cancelled?: boolean;
  error?: string;
  liveAnswer?: CodingLiveAnswer;
  taskProgress?: CodingTaskProgress;
}

const providerKey = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const personalKeyProvider = { openai: "openai", anthropic: "anthropic", google: "gemini", openrouter: "openrouter" };
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
  if (input.source !== "repository" && input.source !== "atlas" && input.source !== "orchestrated")
    throw new StandaloneControlError("Choose files, repository excerpts, a repository map, or an orchestrated plan for this request.");
  const projects = names(input, "projects", 8);
  const tokenBudget = input.contextTokens;
  if (tokenBudget !== undefined && (typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 16384))
    throw new StandaloneControlError("Choose a context budget between 1 and 16,384 tokens.");
  const scope = { ...(projects.length ? { projects } : {}), ...(tokenBudget === undefined ? {} : { tokenBudget }) };
  if (input.source === "atlas") {
    const query = input.query === undefined || input.query === "" ? undefined : string(input, "query", 2048);
    if (input.deferred !== undefined && typeof input.deferred !== "boolean") throw new StandaloneControlError("Choose whether to approve excerpts for lookup.");
    return { source: "atlas", atlas: { ...scope, ...(query ? { query } : {}), exclude: names(input, "exclude", 8), ...(input.deferred === true ? { deferred: true } : {}) } };
  }
  if (input.source === "orchestrated") {
    const workers = input.workers;
    if (workers !== undefined && workers !== "auto" && (typeof workers !== "number" || !Number.isInteger(workers) || workers < 1 || workers > maxWorkers))
      throw new StandaloneControlError(`Choose auto or between 1 and ${maxWorkers} workers.`);
    const routing = input.routing === undefined ? undefined : validateRoutingPolicy(input.routing, codingProviders);
    return { source: "orchestrated", orchestration: { ...scope, ...(workers === undefined ? {} : { workers }), ...(routing ? { routing } : {}) } };
  }
  const query = string(input, "query", 1024);
  const profile = input.profile === undefined ? undefined : validateCodingProjectProfile(input.profile);
  if (!projects.length && !profile) throw new StandaloneControlError("Choose at least one tracked project directory or provide a repository profile.");
  return { source: "repository", repository: { ...scope, query, profile } };
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
  #imports = new RepositoryImports();
  #closed = false;
  constructor(private readonly dependencies: Dependencies = {}) {}

  async close(): Promise<void> {
    this.#closed = true;
    const current = [...this.#runs.values()];
    for (const run of current) if (run.view.status === "running") run.abort.abort();
    await Promise.allSettled([...this.#gates.values(), ...current.map(({ done }) => done), this.#imports.close()]);
    this.#runs.clear();
  }

  async dispatch(method: "GET" | "POST", path: string, input: Input, canWrite: () => boolean): Promise<unknown> {
    try { return await this.#dispatch(method, path, input, canWrite); }
    catch (error) {
      if (error instanceof AtlasBusyError) throw new StandaloneControlError(error.message, 409);
      if (error instanceof AtlasError || error instanceof RoutingError) throw new StandaloneControlError(error.message);
      throw error;
    }
  }

  async #dispatch(method: "GET" | "POST", path: string, input: Input, canWrite: () => boolean): Promise<unknown> {
    if (method === "GET" && path === "") return this.#catalog();
    if (method !== "POST") throw new StandaloneControlError("Standalone coding route not found.", 404);
    if (path === "/preview") {
      const workspace = await workspaceOf(input);
      const source = sourceOf(input);
      if (source.source === "files") {
        const preview = { source: "files" as const, ...await previewCodingAttachments(workspace, source.files) };
        return { ...preview, sourceManifest: codingSourceManifest(preview) };
      }
      if (source.source === "atlas") {
        const prompt = input.prompt === undefined ? source.atlas.query ?? "" : string(input, "prompt", 16_384);
        const selected = await previewAtlasContext(workspace, prompt, source.atlas, this.#atlas());
        const preview = { source: "atlas" as const, id: selected.manifest.id, ...selected };
        return { ...preview, sourceManifest: codingSourceManifest(preview) };
      }
      if (source.source === "orchestrated") {
        const model = this.#model(input);
        const { plan } = await previewCodingOrchestration({
          ...model, workspace, requestId: input.requestId === undefined ? "preview" : requestOf(input),
          prompt: string(input, "prompt", 16_384), orchestration: source.orchestration,
        }, this.#runner(model.provider, workspace));
        const preview = { source: "orchestrated" as const, id: plan.id, plan };
        return { ...preview, sourceManifest: codingSourceManifest(preview) };
      }
      const selected = await selectRepositoryContext({ workspace, ...source.repository });
      return { source: "repository", id: selected.manifest.id, ...selected,
        sourceManifest: codingSourceManifest({ source: "repository", manifest: selected.manifest }) };
    }
    if (path === "/repository") return this.#repository(input, canWrite);
    if (!["/inspect", "/run", "/resume", "/cancel", "/delete-session", "/reset-context-preview", "/reset-context",
      "/compact-context-preview", "/compact-context"].includes(path))
      throw new StandaloneControlError("Standalone coding route not found.", 404);
    const session = sessionOf(input);
    if (path === "/inspect") return this.#inspect(session, input.requestId === undefined ? undefined : requestOf(input));
    return this.#withSession(session, () => this.#changeSession(session, path, input, canWrite));
  }

  #model(input: Input) {
    const choice = listCodingModels(this.dependencies.models).find(({ provider }) => provider === input.provider);
    const model = choice?.models.find(({ id }) => id === input.model);
    if (!choice || !model) throw new StandaloneControlError("Choose an available Pi provider and model.");
    const thinkingLevel = model.thinkingLevels.find((level) => level === input.thinkingLevel);
    if (input.thinkingLevel !== undefined && !thinkingLevel) throw new StandaloneControlError("Choose a supported reasoning level.");
    return { provider: choice.provider, model: model.id, thinkingLevel };
  }

  #atlas(): AtlasLocation {
    return this.dependencies.stateDir ? { stateDir: join(this.dependencies.stateDir, "atlas") } : {};
  }

  async #repository(input: Input, canWrite: () => boolean) {
    const action = input.action;
    const writing = action !== "status" && action !== "files" && !(action === "skills" && input.id === undefined && input.state === undefined);
    if (writing) this.#checkWrite(canWrite);
    const workspace = await workspaceOf(input);
    const location = this.#atlas();
    if (writing) this.#checkWrite(canWrite);
    if (action === "files") return browserRepositoryFiles(workspace, normalizeScopes(names(input, "projects", 32)), location);
    if (action === "status" || action === "import" || action === "cancel") {
      if (action === "import") this.#imports.start(workspace, {
        workspace, scopes: normalizeScopes(names(input, "projects", 32)), ...browserImportOptions(input),
      }, location);
      if (action === "cancel") this.#imports.cancel(workspace);
      const status = await atlasStatus(workspace, location);
      return { ...status, ...this.#imports.view(workspace) };
    }
    if (action === "lesson") return addLesson({ workspace, text: string(input, "text", 600), anchors: names(input, "anchors", 8), actor: resolveActor() }, location);
    if (action === "skills") {
      if (!Atlas.exists(workspace, location)) throw new StandaloneControlError("Import the repository before managing its skills.", 409);
      const learning = Learning.open(workspace, location, writing);
      try {
        if (writing) {
          const id = string(input, "id", 200);
          const state = input.state;
          if (!/^[\w./-]{1,200}$/u.test(id) || (state !== "trial" && state !== "disabled")) throw new StandaloneControlError("Choose a valid skill and state.");
          learning!.setSkillState(id, state);
        }
        return await listSkills(workspace, learning?.skillRecords() ?? new Map(), location);
      } finally { learning?.close(); }
    }
    if (action === "forget") {
      if ([input.session !== undefined, input.rollback === true, input.everything === true].filter(Boolean).length !== 1)
        throw new StandaloneControlError("Choose a session, a parameter rollback, or all learned state.");
      if (input.rollback === true) {
        const learning = Learning.open(workspace, location);
        if (!learning) return { rollback: false };
        try { return { rollback: true, params: learning.rollback().version }; } finally { learning.close(); }
      }
      if (input.everything === true && input.confirm !== true) throw new StandaloneControlError("Confirm that you want to remove all learned state.");
      return forgetLearning(workspace, location, input.session === undefined ? undefined : sessionOf(input));
    }
    if (action === "learn") {
      const session = sessionOf(input);
      const requestId = requestOf(input);
      const { outcome } = input;
      if (outcome !== "accepted" && outcome !== "changes_requested") throw new StandaloneControlError("Choose Accepted or Changes requested.");
      const identity = await getStandaloneCodingIdentity(session, this.dependencies);
      if (identity.workspace !== workspace) throw new StandaloneControlError("This session belongs to a different workspace.", 409);
      const { request } = await inspectStandaloneCodingSession(session, requestId, this.dependencies);
      if (request?.receipt?.status !== "done") throw new StandaloneControlError("Only a finished request with an answer can be reviewed.", 409);
      this.#checkWrite(canWrite);
      return recordCodingOutcome({ workspace, session, requestId, outcome, receipt: request.receipt, appliedPaths: names(input, "used", 32) }, location);
    }
    throw new StandaloneControlError("Repository action not found.", 404);
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
    if (path === "/reset-context-preview" || path === "/reset-context" || path === "/compact-context-preview" || path === "/compact-context") {
      if (current?.view.status === "running")
        throw new StandaloneControlError("Wait for this session to finish or cancel its run before changing its context.", 409);
      if (path === "/compact-context-preview") return previewStandaloneCodingContextCompaction(session, this.dependencies);
      if (path === "/reset-context-preview")
        return previewStandaloneCodingContextReset(session, this.dependencies, parseCodingHandoff(input.handoff));
      const version = string(input, "version", 64);
      if (!/^[a-f0-9]{64}$/u.test(version)) throw new StandaloneControlError("Preview the active context before confirming the change.");
      const authorize = () => this.#checkWrite(canWrite);
      return path === "/compact-context" ? compactStandaloneCodingContext(session, version, this.dependencies, authorize)
        : resetStandaloneCodingContext(session, version, this.dependencies, authorize, parseCodingHandoff(input.handoff));
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
      const model = this.#model(input);
      const source = sourceOf(input);
      const previewId = string(input, "previewId", 64);
      if (!/^[a-f0-9]{64}$/u.test(previewId)) throw new StandaloneControlError("Preview the source before sending.");
      const options: CodingSessionOptions = {
        ...identity, workspace, ...model,
        prompt: string(input, "prompt", 16_384),
        ...(input.approvedSourceLookup === true ? { approvedSourceLookup: true } : {}),
        ...(source.source === "files" ? { files: source.files, filePreviewId: previewId } :
          source.source === "repository" ? { repository: { ...source.repository, id: previewId } } :
          source.source === "atlas" ? { atlas: { ...source.atlas, id: previewId } } :
          { orchestration: { ...source.orchestration, id: previewId } }),
      };
      const runner = this.#runner(model.provider, workspace);
      const preparedInput = await prepareCodingInput(options, workspace, runner);
      await requireNoPendingCodingContextCompaction(options, { ...this.dependencies, allowEnvKey: false, workspaceBinding: workspace });
      this.#checkWrite(canWrite);
      return this.#launch(identity, (signal, updates) => runCodingSession(options, {
        ...runner, preparedInput, requireNewRequest: true, signal, ...updates,
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
    await requireNoPendingCodingContextCompaction(options, { ...this.dependencies, allowEnvKey: false, workspaceBinding: options.workspace });
    this.#checkWrite(canWrite);
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
    const env = gatewayEnvironment();
    const routeKeys = Object.fromEntries(codingProviders.map((name) => [name, env[providerKey[name]]]));
    return {
      ...this.dependencies,
      workspaceBinding: workspace,
      atlas: this.#atlas(),
      apiKey: routeKeys[provider], routeKeys,
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
      const selected = requests.find((request) => request.requestId === requestId);
      const pi = await inspectStandaloneCodingSession(session, selected?.requestId, this.dependencies);
      const savedInput = pi.request?.savedInput;
      if (pi.request) delete pi.request.savedInput;
      const report = selected && codingRunReport(pi, { requestId: selected.requestId,
        status: relevant?.cancelled ? "cancelled" : relevant?.status ?? selected.status });
      const hasCurrentRequest = relevant && requests.some((request) => request.requestId === relevant.requestId);
      return { identity, requests, pi, report, ...(savedInput ? { savedInput } : {}), ...(refused || hasCurrentRequest ? { active: relevant } : {}) };
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
