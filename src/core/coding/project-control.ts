import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { dataDir, resolveActor } from "../config.ts";
import { ensureExtensionCapableSqlite } from "../engine/custom-sqlite.ts";
import {
  ApprovedPatchError, approvedPatchBytes, approvedPatchState, patchDigest, withPreparedPatch, type PatchFileReceipt,
} from "./approved-patch.ts";
import {
  cancelCodingRequest, canonicalWorkspace, codingCredential, CodingError, getCodingSessionStatus, hasCodingCredential,
  listCodingModels, previewCodingAttachments, runCodingSession,
  type CodingDependencies, type CodingProvider, type CodingSessionOptions,
} from "./durable.ts";
import { PackageReviewError, previewPackageReviews, validatePackageReviews } from "./package-review.ts";
import {
  githubActivity, githubComparison, GitHubError, githubRemotes, githubToken, githubUrl,
  type GitHubFetch,
} from "./github.ts";
import { excludedPath, selectRepositoryContext } from "./repository-context.ts";
import { validateCodingProjectProfile } from "./project-profile.ts";
import { launchProjectWorker, ProjectWorkerInterrupted } from "./project-worker.ts";

type Json = Record<string, unknown>;
type Actor = { id: string; owner: boolean; project?: string };
type ProjectRow = {
  id: string; title: string; workspace: string; scopes: string; provider: CodingProvider; model: string;
  thinking: ModelThinkingLevel | null; api_key: string | null; created: string;
};
type RunStatus = "running" | "interrupted" | "done" | "unanswered" | "failed" | "cancelled";
type RunRow = {
  project: string; session: string; id: string; actor: string; status: RunStatus; signature: string;
  admitted: number; created: string; updated: string; error: string | null;
  review: "accepted" | "changes_requested" | null; reviewer: string | null; reviewed: string | null;
};
type PatchRow = {
  preview_id: string; diff_hash: string; files: string; status: "prepared" | "applied"; applied: string | null;
};
type AuditRow = { kind: string; actor: string; session: string | null; request_id: string | null; at: string };
type GitHubRow = { remote: string; repository: string; token: string | null };
type Running = { cancel: AbortController; promise: Promise<void>; stop?: () => void };

export class ProjectControlError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const sessionPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const requestPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const now = () => new Date().toISOString();
const digest = (input: string) => createHash("sha256").update(input).digest("hex");

function field(body: Json, name: string, max = 256): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max)
    throw new ProjectControlError(`Enter a value for ${name} up to ${max} UTF-8 bytes.`);
  return value.trim();
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max
    || value.some((part) => typeof part !== "string" || !part.trim() || Buffer.byteLength(part) > 4096)) {
    throw new ProjectControlError(`Choose up to ${max} valid relative paths.`);
  }
  return value.map((part: string) => part.trim());
}

function relativeScope(scope: string): string {
  const normalized = scope.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /[:\x00-\x1f\x7f]/u.test(normalized) || normalized.split("/").includes(".."))
    throw new ProjectControlError("Project scopes must be workspace-relative directories.");
  return normalized.split("/").filter((part) => part && part !== ".").join("/") || ".";
}

function pathsInProject(project: ProjectRow, value: unknown): string[] {
  const allowed: string[] = JSON.parse(project.scopes);
  const roots = [...new Set(stringList(value, 8).map(relativeScope))];
  if (!roots.length || roots.some((path) => excludedPath(`${path}/source.txt`)
    || !allowed.some((root) => root === "." || path === root || path.startsWith(`${root}/`)))) {
    throw new ProjectControlError("Choose source paths within this project's permitted directories.", 403);
  }
  return roots;
}

function sourceOptions(project: ProjectRow, body: Json) {
  if (body.source === "files") return { files: stringList(body.files ?? [], 12) };
  if (body.source === "packages") {
    try {
      const packages = validatePackageReviews(body.packages);
      pathsInProject(project, packages.map(({ project }) => project));
      return { packages };
    } catch (error) {
      if (error instanceof PackageReviewError) throw new ProjectControlError(error.message);
      throw error;
    }
  }
  if (body.source !== "repository") throw new ProjectControlError("Choose repository excerpts, explicit files, or a package review.");
  const query = field(body, "query", 1024);
  if (body.profile !== undefined) {
    if (body.projects !== undefined || body.tokenBudget !== undefined)
      throw new ProjectControlError("Use the project profile or set directories and a budget explicitly.");
    const profile = validateCodingProjectProfile(body.profile);
    pathsInProject(project, [...profile.projects, ...(profile.sharedProjects ?? [])]);
    return { repository: { profile, query } };
  }
  const tokenBudget = body.tokenBudget;
  if (tokenBudget !== undefined && (typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget)
    || tokenBudget < 1 || tokenBudget > 16384)) throw new ProjectControlError("Enter a source budget of 1–16384 tokens.");
  return { repository: { projects: pathsInProject(project, body.projects ?? JSON.parse(project.scopes)), query, tokenBudget } };
}

export interface ProjectControlOptions {
  stateDir?: string;
  models?: CodingDependencies["models"];
  githubFetch?: GitHubFetch;
}

export class CodingProjectControl {
  readonly #directory: string;
  readonly #db: Database;
  readonly #lease: Database;
  readonly #models: CodingDependencies["models"];
  readonly #githubFetch: GitHubFetch;
  readonly #active = new Map<string, Running>();
  #patchInFlight = false;
  readonly #gates = new Map<string, Promise<void>>();
  readonly #requests = new Set<Promise<unknown>>();
  #closing = false;

  constructor(options: ProjectControlOptions = {}) {
    this.#models = options.models;
    this.#githubFetch = options.githubFetch ?? fetch;
    this.#directory = options.stateDir ?? join(dataDir(), "coding-projects");
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const directoryInfo = lstatSync(this.#directory);
    if (!directoryInfo.isDirectory()) throw new ProjectControlError("Coding project data must be a directory.", 409);
    if (process.platform !== "win32" && (directoryInfo.mode & 0o077) !== 0) chmodSync(this.#directory, 0o700);
    ensureExtensionCapableSqlite();
    this.#lease = new Database(join(this.#directory, "owner.sqlite"));
    let db: Database | undefined;
    try {
      this.#lease.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      db = new Database(join(this.#directory, "projects.sqlite"), { strict: true });
      db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS projects(
          id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL, scopes TEXT NOT NULL,
          provider TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT, api_key TEXT, created TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS members(
          id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), actor TEXT NOT NULL,
          secret TEXT NOT NULL UNIQUE, created TEXT NOT NULL, expires TEXT
        );
        CREATE TABLE IF NOT EXISTS runs(
          project TEXT NOT NULL REFERENCES projects(id), session TEXT NOT NULL, id TEXT NOT NULL,
          actor TEXT NOT NULL, status TEXT NOT NULL, signature TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0,
          created TEXT NOT NULL, updated TEXT NOT NULL, error TEXT, review TEXT, reviewer TEXT, reviewed TEXT,
          PRIMARY KEY (project, session, id)
        );
        CREATE INDEX IF NOT EXISTS runs_project_updated ON runs(project, updated DESC);
        CREATE TABLE IF NOT EXISTS audit(
          seq INTEGER PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL,
          actor TEXT NOT NULL, session TEXT, request_id TEXT, at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_project_seq ON audit(project, seq DESC);
        CREATE TABLE IF NOT EXISTS session_deletions(
          project TEXT NOT NULL REFERENCES projects(id), session TEXT NOT NULL, actor TEXT NOT NULL,
          PRIMARY KEY (project, session)
        );
        CREATE TABLE IF NOT EXISTS github_projects(
          project TEXT PRIMARY KEY REFERENCES projects(id), remote TEXT NOT NULL, repository TEXT NOT NULL, token TEXT
        );
        CREATE TABLE IF NOT EXISTS applied_patches(
          project TEXT NOT NULL, session TEXT NOT NULL, request_id TEXT NOT NULL,
          preview_id TEXT NOT NULL, diff_hash TEXT NOT NULL, files TEXT NOT NULL,
          status TEXT NOT NULL, applied TEXT,
          PRIMARY KEY (project, session, request_id),
          FOREIGN KEY (project, session, request_id) REFERENCES runs(project, session, id) ON DELETE CASCADE
        );
      `);
      // A prior process may have exited after either catalog or Pi committed.
      // An interrupted run can be inspected and resumed with the same ID.
      db.exec("UPDATE runs SET status = 'interrupted' WHERE status = 'running'");
      this.#db = db;
      if (!this.#all<{ name: string }>("PRAGMA table_info(members)").some((column) => column.name === "expires"))
        db.exec("ALTER TABLE members ADD COLUMN expires TEXT");
      for (const deletion of this.#all<{ project: string; session: string; actor: string }>("SELECT * FROM session_deletions")) {
        rmSync(this.#sessionDirectory(deletion.project, deletion.session), { recursive: true, force: true });
        this.#finishDeletion(deletion.project, deletion.session, deletion.actor);
      }
    } catch (error) {
      db?.close(true);
      this.#lease.close(true);
      if ((error as { code?: string }).code === "SQLITE_BUSY")
        throw new ProjectControlError("Coding projects are already open in another okbrain server.", 409);
      throw error;
    }
  }

  async close() {
    this.#closing = true;
    const active = [...this.#active.values()];
    for (const { stop } of active) stop?.();
    await Promise.allSettled([...active.map(({ promise }) => promise), ...this.#requests]);
    try {
      this.#db.close(true);
    } finally {
      this.#lease.close(true);
    }
  }

  #get<T>(sql: string, ...bindings: SQLQueryBindings[]): T | null {
    using statement = this.#db.prepare<T, SQLQueryBindings[]>(sql);
    return statement.get(...bindings);
  }

  #all<T>(sql: string, ...bindings: SQLQueryBindings[]): T[] {
    using statement = this.#db.prepare<T, SQLQueryBindings[]>(sql);
    return statement.all(...bindings);
  }

  #write(sql: string, ...bindings: SQLQueryBindings[]): void {
    using statement = this.#db.prepare(sql);
    statement.run(...bindings);
  }

  #audit(project: string, kind: string, actor: string, session?: string, requestId?: string) {
    this.#write("INSERT INTO audit(project, kind, actor, session, request_id, at) VALUES (?, ?, ?, ?, ?, ?)",
      project, kind, actor, session ?? null, requestId ?? null, now());
  }

  #readRun(project: string, session: string, id: string): RunRow {
    const row = this.#get<RunRow>("SELECT * FROM runs WHERE project = ? AND session = ? AND id = ?", project, session, id);
    if (!row) throw new ProjectControlError("No coding request with that ID exists in this session.", 404);
    return row;
  }

  #runView({ signature: _signature, ...row }: RunRow) {
    return { ...row, admitted: Boolean(row.admitted) };
  }

  #projectView(row: ProjectRow, actor: Actor) {
    const { api_key, scopes, workspace, ...settings } = row;
    return {
      ...settings,
      ...(actor.owner ? { workspace } : {}),
      scopes: JSON.parse(scopes) as string[],
      credential: api_key ? "project" : actor.owner && hasCodingCredential(row.provider, { models: this.#models }) ? "environment" : "missing",
    };
  }

  #identity(owner: boolean, token: string | null): Actor {
    if (owner) return { id: resolveActor(), owner };
    if (token?.startsWith("okbp_") && token.length === 48) {
      const member = this.#get<{ project: string; actor: string }>(
        "SELECT project, actor FROM members WHERE secret = ? AND expires > ?", digest(token), now(),
      );
      if (member) return { id: member.actor, owner: false, project: member.project };
    }
    throw new ProjectControlError("A valid coding project or local okbrain token is required.", 401);
  }

  #project(id: string, actor: Actor): ProjectRow {
    if (!actor.owner && actor.project !== id) throw new ProjectControlError("This token does not have access to that project.", 403);
    const project = this.#get<ProjectRow>("SELECT * FROM projects WHERE id = ?", id);
    if (!project) throw new ProjectControlError("Coding project not found.", 404);
    return project;
  }

  #requireOwner(actor: Actor) {
    if (!actor.owner) throw new ProjectControlError("Only the local okbrain operator can change project settings.", 403);
  }

  async #addProject(body: Json, actor: Actor) {
    this.#requireOwner(actor);
    const title = field(body, "title", 128);
    const path = field(body, "workspace", 4096);
    if (!isAbsolute(path)) throw new ProjectControlError("Enter the absolute path of the repository or workspace on this computer.");
    const workspace = await canonicalWorkspace(path);
    const scopes = [...new Set(stringList(body.scopes ?? ["."], 8).map(relativeScope))];
    if (!scopes.length) throw new ProjectControlError("Choose at least one permitted directory.");
    for (const scope of scopes) {
      const absolute = resolve(workspace, scope);
      const canonical = await realpath(absolute).catch(() => undefined);
      if (canonical !== absolute || !(await lstat(absolute)).isDirectory() || excludedPath(`${scope}/source.txt`))
        throw new ProjectControlError(`Permitted directory ${scope} must exist inside the workspace without symlinks.`);
    }
    const provider = field(body, "provider", 24);
    const model = field(body, "model");
    const catalog = listCodingModels(this.#models).find((entry) => entry.provider === provider)?.models.find((entry) => entry.id === model);
    if (!catalog) throw new ProjectControlError("Choose an available Pi model.");
    const thinking = body.thinking === undefined ? null : field(body, "thinking", 12) as ModelThinkingLevel;
    if (thinking !== null && !catalog.thinkingLevels.includes(thinking))
      throw new ProjectControlError("Choose a reasoning level supported by this model.");
    const apiKey = body.apiKey === undefined ? null : field(body, "apiKey", 4096);
    const id = randomUUID();
    this.#db.transaction(() => {
      this.#write("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, title, workspace, JSON.stringify(scopes), provider, model, thinking, apiKey, now());
      this.#audit(id, "project_created", actor.id);
    })();
    return this.#projectView(this.#project(id, actor), actor);
  }

  async #workspace(project: ProjectRow) {
    const actual = await canonicalWorkspace(project.workspace);
    if (actual !== project.workspace) throw new ProjectControlError("The project's workspace path changed. Register the intended workspace again.", 409);
    return actual;
  }

  async #preview(project: ProjectRow, body: Json) {
    const source = sourceOptions(project, body);
    const workspace = await this.#workspace(project);
    if (source.packages) return { source: "packages", ...await previewPackageReviews(workspace, source.packages) };
    if (source.repository) return { source: "repository", ...await selectRepositoryContext({ workspace, ...source.repository }) };
    return {
      source: "files",
      ...await previewCodingAttachments(workspace, source.files, JSON.parse(project.scopes)),
    };
  }

  #runParts(body: Json) {
    const session = field(body, "session", 64);
    const requestId = field(body, "requestId", 128);
    if (!sessionPattern.test(session) || !requestPattern.test(requestId))
      throw new ProjectControlError("Use a lowercase session name and a request ID made of letters, digits, periods, hyphens, or underscores.");
    return { session, requestId };
  }

  #session(project: ProjectRow, run: { session: string; requestId: string }) {
    return {
      ...run, workspace: project.workspace, provider: project.provider, model: project.model,
      thinkingLevel: project.thinking ?? undefined,
    };
  }

  #dependencies(project: ProjectRow, actor: Actor): CodingDependencies {
    return {
      stateDir: join(this.#directory, `project-${project.id}`),
      models: this.#models,
      workspaceBinding: project.workspace,
      apiKey: project.api_key ?? undefined,
      allowEnvKey: actor.owner,
    };
  }

  #setRun(project: string, run: { session: string; requestId: string }, actor: Actor, status: RunStatus, error: string | null = null) {
    this.#db.transaction(() => {
      this.#write("UPDATE runs SET status = ?, error = ?, updated = ? WHERE project = ? AND session = ? AND id = ?",
        status, error, now(), project, run.session, run.requestId);
      this.#audit(project, status, actor.id, run.session, run.requestId);
    })();
  }

  #auditAdmitted(project: string, run: { session: string; requestId: string }, actor: Actor) {
    this.#db.transaction(() => {
      const row = this.#readRun(project, run.session, run.requestId);
      if (row.admitted) return;
      this.#write("UPDATE runs SET admitted = 1, updated = ? WHERE project = ? AND session = ? AND id = ?",
        now(), project, run.session, run.requestId);
      this.#audit(project, "admitted", actor.id, run.session, run.requestId);
    })();
  }

  #schedule(project: ProjectRow, run: CodingSessionOptions, actor: Actor) {
    const key = `${project.id}/${run.session}`;
    const cancel = new AbortController();
    const dependencies = this.#dependencies(project, actor);
    const admitted = () => this.#auditAdmitted(project.id, run, actor);
    let stop: (() => void) | undefined;
    let result: Promise<"done" | "unanswered">;
    try {
      if (dependencies.models) {
        stop = () => cancel.abort();
        result = runCodingSession(run, { ...dependencies, signal: cancel.signal, admitted }).then((receipt) => receipt.status);
      } else {
        const worker = launchProjectWorker({
          options: run, stateDir: dependencies.stateDir!, workspaceBinding: project.workspace,
          apiKey: codingCredential(project.provider, dependencies),
        }, cancel.signal, admitted);
        stop = worker.stop;
        result = worker.result;
      }
    } catch (error) {
      result = Promise.reject(new ProjectWorkerInterrupted("The coding worker could not start.", { cause: error }));
    }
    const promise = result.then((status) => {
      this.#setRun(project.id, run, actor, cancel.signal.aborted && status === "unanswered" ? "cancelled" : status);
    }, (error: unknown) => {
      const row = this.#readRun(project.id, run.session, run.requestId);
      const status = row.admitted || error instanceof ProjectWorkerInterrupted ? "interrupted" : cancel.signal.aborted ? "cancelled" : "failed";
      const message = error instanceof CodingError || error instanceof ProjectWorkerInterrupted
        ? error.message : "The coding worker stopped before a result was saved.";
      this.#setRun(project.id, run, actor, status, message);
    }).finally(() => this.#active.delete(key));
    // Retain the status on disk even if catalog writes are interrupted. The
    // next server will reconcile the left-behind row with the Pi transcript.
    void promise.catch(() => {});
    this.#active.set(key, { cancel, promise, stop });
  }

  #canSchedule(project: ProjectRow, run: { session: string; requestId: string }) {
    if (this.#closing || this.#active.size >= 4) throw new ProjectControlError("The server is busy. Try again after a run finishes.", 409);
    if (this.#active.has(`${project.id}/${run.session}`))
      throw new ProjectControlError("Another request in this session is currently running.", 409);
    if (this.#get("SELECT session FROM session_deletions WHERE project = ? AND session = ?", project.id, run.session))
      throw new ProjectControlError("Finish deleting this session before starting another request.", 409);
  }

  async #start(project: ProjectRow, body: Json, actor: Actor) {
    const run = this.#runParts(body);
    const prompt = field(body, "prompt", 16384);
    if (body.approved !== true) throw new ProjectControlError("Review the preview and confirm the content to send.");
    const previewId = field(body, "previewId", 128);
    const selection = sourceOptions(project, body);
    const signature = digest(JSON.stringify({ prompt, previewId, selection }));
    await this.#workspace(project);
    const prior = this.#get<RunRow>("SELECT * FROM runs WHERE project = ? AND session = ? AND id = ?", project.id, run.session, run.requestId);
    if (prior && prior.status !== "failed") {
      if (prior.signature !== signature) throw new ProjectControlError("This request ID is bound to a different task or source selection.", 409);
      return this.#runView(prior);
    }
    if (prior?.admitted) throw new ProjectControlError("This request was already admitted. Inspect it and use Resume to recover its saved input.", 409);
    if (!hasCodingCredential(project.provider, this.#dependencies(project, actor)))
      throw new ProjectControlError("Add a provider API key for this project before sending requests.", 409);
    this.#canSchedule(project, run);
    const blocking = this.#get<{ id: string }>(
      "SELECT id FROM runs WHERE project = ? AND session = ? AND status = 'interrupted' AND id <> ? LIMIT 1", project.id, run.session, run.requestId,
    );
    if (blocking) throw new ProjectControlError(`Resume or cancel interrupted request ${blocking.id} before starting another in this session.`, 409);
    this.#db.transaction(() => {
      if (prior) {
        this.#write("UPDATE runs SET status = 'running', signature = ?, actor = ?, updated = ?, error = NULL WHERE project = ? AND session = ? AND id = ?",
          signature, actor.id, now(), project.id, run.session, run.requestId);
      } else {
        const time = now();
        this.#write("INSERT INTO runs(project, session, id, actor, status, signature, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          project.id, run.session, run.requestId, actor.id, "running", signature, time, time);
      }
      this.#audit(project.id, "submitted", actor.id, run.session, run.requestId);
    })();
    this.#schedule(project, {
      ...this.#session(project, run), prompt,
      ...(selection.packages ? { packageReviews: { packages: selection.packages, id: previewId } } : selection.repository
        ? { repository: { ...selection.repository, id: previewId } }
        : { files: selection.files, filePreviewId: previewId, allowedAttachmentScopes: JSON.parse(project.scopes) as string[] }),
    }, actor);
    return this.#runView(this.#readRun(project.id, run.session, run.requestId));
  }

  async #inspect(project: ProjectRow, body: Json, actor: Actor) {
    const run = this.#runParts(body);
    const row = this.#readRun(project.id, run.session, run.requestId);
    if (this.#get("SELECT session FROM session_deletions WHERE project = ? AND session = ?", project.id, run.session))
      throw new ProjectControlError("This transcript is being deleted.", 409);
    const value = this.#runView(row);
    if (this.#active.has(`${project.id}/${run.session}`) || (row.status !== "interrupted" && !row.admitted)) return { run: value };
    try {
      const pi = await getCodingSessionStatus(
        { ...this.#session(project, run), includeReceipt: true },
        this.#dependencies(project, actor),
      );
      if (row.status === "interrupted" && pi.request?.receipt) {
        this.#auditAdmitted(project.id, run, actor);
        this.#setRun(project.id, run, actor, pi.request.receipt.status);
        return { run: this.#runView(this.#readRun(project.id, run.session, run.requestId)), pi };
      }
      return { run: value, pi };
    } catch (error) {
      if (row.status === "interrupted" && !row.admitted && error instanceof CodingError && error.message.startsWith("No "))
        return { run: value, admissionMissing: true };
      throw error;
    }
  }

  async #resume(project: ProjectRow, body: Json, actor: Actor) {
    const run = this.#runParts(body);
    const inspected = await this.#inspect(project, body, actor);
    if (inspected.run.status !== "interrupted") return inspected.run;
    if (inspected.admissionMissing) {
      this.#setRun(project.id, run, actor, "failed", "The server stopped before this request was admitted. Preview and submit it again with the same request ID.");
      return this.#runView(this.#readRun(project.id, run.session, run.requestId));
    }
    if (!hasCodingCredential(project.provider, this.#dependencies(project, actor)))
      throw new ProjectControlError("Add a provider API key for this project before resuming requests.", 409);
    this.#canSchedule(project, run);
    this.#setRun(project.id, run, actor, "running");
    this.#schedule(project, this.#session(project, run), actor);
    return this.#runView(this.#readRun(project.id, run.session, run.requestId));
  }

  async #cancel(project: ProjectRow, body: Json, actor: Actor) {
    const run = this.#runParts(body);
    const row = this.#readRun(project.id, run.session, run.requestId);
    if (row.status === "running") {
      const active = this.#active.get(`${project.id}/${run.session}`);
      if (!active) throw new ProjectControlError("The running session could not be found. Refresh run status.", 409);
      if (!active.cancel.signal.aborted) {
        this.#audit(project.id, "cancel_requested", actor.id, run.session, run.requestId);
        active.cancel.abort();
      }
    } else if (row.status === "interrupted") {
      const inspected = await this.#inspect(project, body, actor);
      if (inspected.run.status !== "interrupted") return inspected.run;
      if (!inspected.admissionMissing) {
        const receipt = await cancelCodingRequest(this.#session(project, run), this.#dependencies(project, actor));
        this.#auditAdmitted(project.id, run, actor);
        this.#setRun(project.id, run, actor, receipt.status === "done" ? "done" : "cancelled");
      } else this.#setRun(project.id, run, actor, "cancelled");
    }
    return this.#runView(this.#readRun(project.id, run.session, run.requestId));
  }

  #review(project: ProjectRow, body: Json, actor: Actor) {
    const run = this.#runParts(body);
    const row = this.#readRun(project.id, run.session, run.requestId);
    const decision = body.decision;
    if (row.status !== "done" || (decision !== "accepted" && decision !== "changes_requested"))
      throw new ProjectControlError("Choose a review decision for a finished result.", 409);
    if (row.review !== decision || row.reviewer !== actor.id) {
      this.#db.transaction(() => {
        this.#write("UPDATE runs SET review = ?, reviewer = ?, reviewed = ? WHERE project = ? AND session = ? AND id = ?",
          decision, actor.id, now(), project.id, run.session, run.requestId);
        this.#audit(project.id, decision, actor.id, run.session, run.requestId);
      })();
    }
    return this.#runView(this.#readRun(project.id, run.session, run.requestId));
  }

  #finishPatch(project: ProjectRow, row: RunRow, actor: Actor) {
    const applied = now();
    this.#db.transaction(() => {
      this.#write("UPDATE applied_patches SET status = 'applied', applied = ? WHERE project = ? AND session = ? AND request_id = ?",
        applied, project.id, row.session, row.id);
      this.#audit(project.id, "patch_applied", actor.id, row.session, row.id);
    })();
    return applied;
  }

  async #patch(project: ProjectRow, body: Json, actor: Actor, apply: boolean) {
    this.#requireOwner(actor);
    const run = this.#runParts(body);
    const row = this.#readRun(project.id, run.session, run.requestId);
    if (row.status !== "done" || row.review !== "accepted")
      throw new ProjectControlError("Accept the finished result before reviewing a patch.", 409);
    const diff = body.diff;
    if (typeof diff !== "string" || Buffer.byteLength(diff) > approvedPatchBytes)
      throw new ProjectControlError("Paste a Git unified diff up to 48 KiB.");
    if (apply && body.approved !== true) throw new ProjectControlError("Confirm the previewed patch before applying it.");
    const approval = apply ? field(body, "previewId", 64) : undefined;
    const diffHash = patchDigest(diff);
    const prior = this.#get<PatchRow>("SELECT * FROM applied_patches WHERE project = ? AND session = ? AND request_id = ?", project.id, row.session, row.id);
    if (prior && (prior.diff_hash !== diffHash || (approval !== undefined && prior.preview_id !== approval))) {
      throw new ProjectControlError("This result already has a different approved patch.", 409);
    }
    if (prior?.status === "applied") {
      return { id: prior.preview_id, files: JSON.parse(prior.files) as PatchFileReceipt[], applied: prior.applied, reused: true };
    }
    if (apply && this.#patchInFlight) throw new ProjectControlError("Another patch is being applied. Try again when it finishes.", 409);
    if (apply) this.#patchInFlight = true;
    try {
      const workspace = await this.#workspace(project);
      const scopes = JSON.parse(project.scopes) as string[];
      if (prior) {
        const files = JSON.parse(prior.files) as PatchFileReceipt[];
        const state = await approvedPatchState(workspace, scopes, files);
        if (state === "different") throw new ProjectControlError("The worktree differs from both recorded patch states. Inspect the files before proceeding.", 409);
        if (!apply || state === "after") {
          return { id: prior.preview_id, files, applied: apply ? this.#finishPatch(project, row, actor) : null, reused: true };
        }
      }
      return await withPreparedPatch(workspace, scopes, diff, async (prepared) => {
        const files = prepared.files;
        const id = digest(JSON.stringify([1, project.id, row.session, row.id, row.reviewed, diffHash, files]));
        if (!apply) return { id, files, applied: null, reused: false };
        if (id !== approval) throw new ProjectControlError("The patch or worktree changed. Preview it again before applying.", 409);
        if (!prior) {
          this.#db.transaction(() => {
            this.#write("INSERT INTO applied_patches VALUES (?, ?, ?, ?, ?, ?, 'prepared', NULL)",
              project.id, row.session, row.id, id, diffHash, JSON.stringify(files));
            this.#audit(project.id, "patch_approved", actor.id, row.session, row.id);
          })();
        }
        await prepared.apply();
        return { id, files, applied: this.#finishPatch(project, row, actor), reused: Boolean(prior) };
      });
    } catch (error) {
      if (error instanceof ApprovedPatchError) throw new ProjectControlError(error.message, 409);
      throw error;
    } finally {
      if (apply) this.#patchInFlight = false;
    }
  }

  #sessionDirectory(project: string, session: string) {
    return join(this.#directory, `project-${project}`, `session-${session}`);
  }

  #finishDeletion(project: string, session: string, actor: string) {
    this.#db.transaction(() => {
      this.#write("DELETE FROM runs WHERE project = ? AND session = ?", project, session);
      this.#write("DELETE FROM session_deletions WHERE project = ? AND session = ?", project, session);
      this.#audit(project, "session_deleted", actor, session);
    })();
  }

  async #deleteSession(project: ProjectRow, body: Json, actor: Actor) {
    this.#requireOwner(actor);
    const session = field(body, "session", 64);
    if (!sessionPattern.test(session) || body.confirm !== session)
      throw new ProjectControlError("Type the session name to confirm transcript deletion.");
    const key = `${project.id}/${session}`;
    if (this.#active.has(key)) throw new ProjectControlError("Wait for this session to finish or cancel its run before deleting it.", 409);
    this.#db.transaction(() => {
      this.#write("INSERT OR IGNORE INTO session_deletions(project, session, actor) VALUES (?, ?, ?)", project.id, session, actor.id);
      this.#audit(project.id, "session_deletion_requested", actor.id, session);
    })();
    const cancel = new AbortController();
    const promise = rm(this.#sessionDirectory(project.id, session), { recursive: true, force: true })
      .then(() => this.#finishDeletion(project.id, session, actor.id))
      .finally(() => this.#active.delete(key));
    this.#active.set(key, { cancel, promise });
    await promise;
    return { session, deleted: true };
  }

  #credentials(project: ProjectRow, body: Json, actor: Actor) {
    this.#requireOwner(actor);
    const key = body.apiKey === null ? null : field(body, "apiKey", 4096);
    this.#db.transaction(() => {
      this.#write("UPDATE projects SET api_key = ? WHERE id = ?", key, project.id);
      this.#audit(project.id, key ? "credential_saved" : "credential_removed", actor.id);
    })();
    return this.#projectView(this.#project(project.id, actor), actor);
  }

  #members(project: ProjectRow, method: string, body: Json, actor: Actor) {
    this.#requireOwner(actor);
    if (method === "GET") {
      return this.#all<{ id: string; actor: string; created: string; expires: string | null }>(
        "SELECT id, actor, created, expires FROM members WHERE project = ? ORDER BY created DESC", project.id,
      );
    }
    if (body.revoke !== undefined) {
      const id = field(body, "revoke", 64);
      this.#db.transaction(() => {
        this.#write("DELETE FROM members WHERE project = ? AND id = ?", project.id, id);
        this.#audit(project.id, "member_revoked", actor.id);
      })();
      return { revoked: id };
    }
    const name = field(body, "name", 48);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))
      throw new ProjectControlError("Use letters, digits, underscores, or hyphens for the member name.");
    const member = `human:${name}`;
    const id = randomUUID();
    const token = "okbp_" + randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    this.#db.transaction(() => {
      this.#write("INSERT INTO members(id, project, actor, secret, created, expires) VALUES (?, ?, ?, ?, ?, ?)",
        id, project.id, member, digest(token), now(), expires);
      this.#audit(project.id, "member_added", actor.id);
    })();
    return { id, actor: member, token, expires };
  }

  async #github(project: ProjectRow, action: string, method: string, body: Json, actor: Actor) {
    const bound = this.#get<GitHubRow>("SELECT remote, repository, token FROM github_projects WHERE project = ?", project.id);
    const status = (row: GitHubRow | null) => ({
      canConfigure: actor.owner,
      connection: row ? {
        remote: row.remote, repository: row.repository, url: githubUrl(row.repository), hasToken: row.token !== null,
      } : null,
    });
    try {
      if (method === "GET" && action === "github-status") return status(bound);
      if (method === "GET" && action === "github-remotes") {
        this.#requireOwner(actor);
        return githubRemotes(await this.#workspace(project));
      }
      if (method === "POST" && action === "github-connect") {
        this.#requireOwner(actor);
        const token = githubToken(body.token);
        const remote = field(body, "remote", 128);
        const option = (await githubRemotes(await this.#workspace(project))).find((item) => item.remote === remote);
        if (!option || body.repository !== option.repository)
          throw new ProjectControlError("This Git remote changed. Detect the repository and confirm the connection again.", 409);
        this.#db.transaction(() => {
          this.#write(`INSERT INTO github_projects VALUES (?, ?, ?, ?)
            ON CONFLICT(project) DO UPDATE SET remote = excluded.remote, repository = excluded.repository, token = excluded.token`,
          project.id, option.remote, option.repository, token);
          this.#audit(project.id, "github_connected", actor.id);
        })();
        return status({ ...option, token });
      }
      if (method === "POST" && action === "github-disconnect") {
        this.#requireOwner(actor);
        if (bound) this.#db.transaction(() => {
          this.#write("DELETE FROM github_projects WHERE project = ?", project.id);
          this.#audit(project.id, "github_disconnected", actor.id);
        })();
        return status(null);
      }
      if ((method === "GET" && action === "github-activity") || (method === "POST" && action === "github-handoff")) {
        if (!bound) throw new ProjectControlError("Connect a local GitHub remote for this project first.", 409);
        const remotes = await githubRemotes(await this.#workspace(project));
        if (!remotes.some((remote) => remote.remote === bound.remote && remote.repository === bound.repository))
          throw new ProjectControlError("This Git remote changed. Reconnect it before continuing.", 409);
        if (action === "github-activity") return await githubActivity(bound.repository, bound.token, this.#githubFetch);
        const request = this.#runParts(body);
        const run = this.#readRun(project.id, request.session, request.requestId);
        if (run.status !== "done" || run.review !== "accepted")
          throw new ProjectControlError("Accept the coding request in Review before preparing a GitHub handoff.", 409);
        const url = githubComparison(bound.repository, body.base, body.head);
        this.#audit(project.id, "github_handoff", actor.id, run.session, run.id);
        return { url, repository: bound.repository, session: run.session, requestId: run.id };
      }
    } catch (error) {
      if (error instanceof GitHubError) throw new ProjectControlError(error.message, error.status);
      throw error;
    }
    throw new ProjectControlError("GitHub endpoint not found.", 404);
  }

  #withSession<T>(project: ProjectRow, body: Json, action: () => Promise<T>): Promise<T> {
    const session = field(body, "session", 64);
    if (!sessionPattern.test(session)) throw new ProjectControlError("Enter a valid lowercase session name.");
    const key = `${project.id}/${session}`;
    const result = (this.#gates.get(key) ?? Promise.resolve()).then(action);
    const gate = result.then(() => {}, () => {});
    this.#gates.set(key, gate);
    return result.finally(() => { if (this.#gates.get(key) === gate) this.#gates.delete(key); });
  }

  dispatch(
    method: string, path: string, body: Json, localOwner: boolean, token: string | null, readonly: boolean,
  ): Promise<unknown> {
    if (this.#closing) throw new ProjectControlError("The coding server is shutting down.", 409);
    const request = this.#dispatch(method, path, body, localOwner, token, readonly);
    this.#requests.add(request);
    return request.finally(() => { this.#requests.delete(request); });
  }

  async #dispatch(
    method: string, path: string, body: Json, localOwner: boolean, token: string | null, readonly: boolean,
  ): Promise<unknown> {
    const actor = this.#identity(localOwner, token);
    if (path === "/models" && method === "GET") return listCodingModels(this.#models);
    if (path === "/projects" && method === "GET") {
      const projects = actor.owner ? this.#all<ProjectRow>("SELECT * FROM projects ORDER BY created DESC") : [this.#project(actor.project!, actor)];
      return projects.map((row) => this.#projectView(row, actor));
    }
    if (method === "POST" && readonly && !path.endsWith("/preview") && !path.endsWith("/inspect"))
      throw new ProjectControlError("This server is attached to a read-only brain mount.", 403);
    if (path === "/projects" && method === "POST") return this.#addProject(body, actor);
    const match = /^\/projects\/([a-f0-9-]{36})\/([a-z-]+)$/.exec(path);
    if (!match) throw new ProjectControlError("Coding endpoint not found.", 404);
    const project = this.#project(match[1]!, actor);
    const action = match[2];
    if (action?.startsWith("github-")) return this.#github(project, action, method, body, actor);
    if (method === "GET") {
      if (action === "runs") return this.#all<RunRow>("SELECT * FROM runs WHERE project = ? ORDER BY updated DESC LIMIT 200", project.id).map((row) => this.#runView(row));
      if (action === "audit") return this.#all<AuditRow>("SELECT kind, actor, session, request_id, at FROM audit WHERE project = ? ORDER BY seq DESC LIMIT 200", project.id);
      if (action === "members") return this.#members(project, method, body, actor);
    }
    if (method === "POST") {
      if (action === "preview") return this.#preview(project, body);
      if (action === "run") return this.#withSession(project, body, () => this.#start(project, body, actor));
      if (action === "inspect") return this.#withSession(project, body, () => this.#inspect(project, body, actor));
      if (action === "resume") return this.#withSession(project, body, () => this.#resume(project, body, actor));
      if (action === "cancel") return this.#withSession(project, body, () => this.#cancel(project, body, actor));
      if (action === "review") return this.#withSession(project, body, async () => this.#review(project, body, actor));
      if (action === "patch-preview" || action === "patch-apply")
        return this.#withSession(project, body, () => this.#patch(project, body, actor, action === "patch-apply"));
      if (action === "delete-session") return this.#withSession(project, body, () => this.#deleteSession(project, body, actor));
      if (action === "credential") return this.#credentials(project, body, actor);
      if (action === "members") return this.#members(project, method, body, actor);
    }
    throw new ProjectControlError("Coding endpoint not found.", 404);
  }
}
