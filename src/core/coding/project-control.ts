import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { dataDir, resolveActor } from "../config.ts";
import { ensureExtensionCapableSqlite } from "../engine/custom-sqlite.ts";
import { log } from "../log.ts";
import {
  ApprovedPatchError, approvedPatchBytes, approvedPatchFiles, approvedPatchState, patchDigest, withPreparedPatch, type PatchFileReceipt,
} from "./approved-patch.ts";
import {
  cancelCodingRequest, canonicalWorkspace, codingCredential, codingProviderLabel, CodingError, compactCodingContext, createCodingBranch,
  getCodingRunComparison, getCodingSessionStatus, getSavedCodingRequestInput, hasCodingCredential, listCodingModels, parseCodingHandoff,
  previewCodingAttachments, previewCodingBranch, previewCodingBranchContext, previewCodingContextCompaction, previewCodingContextReset, requireNoPendingCodingContextCompaction,
  resetCodingContext, runCodingSession,
  type CodingDependencies, type CodingLiveAnswer, type CodingProvider, type CodingSessionOptions, type CodingSessionStatusResult,
} from "./durable.ts";
import { CodingEvaluationError, CodingEvaluations, parseEvaluation, pinnedEvaluationBinding, presentEvidence } from "./evaluation.ts";
import { pinnedEvaluationRubric, PinnedEvaluationWorkspaceError, verifyPinnedEvaluationWorkspace } from "./evaluation-rubric.ts";
import { codingRunReport } from "./run-report.ts";
import { dockerWorkerConfig, type DockerWorkerConfig } from "./docker-worker.ts";
import { PackageReviewError, previewPackageReviews, validatePackageReviews } from "./package-review.ts";
import { codingPatchProposals } from "./patch-proposals.ts";
import {
  githubActivity, githubBranch, githubCommitComparison, githubComparison, githubCreatePull, githubFindPull, githubIssue, githubIssueNumber,
  githubPullBody, githubPullDraft,
  GitHubError, githubRemotes, githubToken, githubUrl, type GitHubFetch, type GitHubPullReceipt,
} from "./github.ts";
import { githubBranchRef, githubCreatePatchCommit, githubCreatePatchRef, githubPreparePatchBranch } from "./github-branch.ts";
import { excludedPath, selectRepositoryContext } from "./repository-context.ts";
import { validateCodingProjectProfile, type CodingProjectProfile } from "./project-profile.ts";
import { launchProjectProviderCheck, launchProjectWorker, ProjectProviderCheckDisallowed, ProjectWorkerInterrupted } from "./project-worker.ts";
import { checkProviderModel, type ProviderCheckOutcome } from "./provider-check.ts";
import type { CodingTaskProgress } from "./task-progress.ts";
import type { TeamStartup } from "./team-listener.ts";
import { runCodingWorkerCheck } from "./worker-check.ts";

type Json = Record<string, unknown>;
type Actor = { id: string; owner: boolean; project?: string; memberId?: string };
type ProjectRow = {
  id: string; title: string; workspace: string; scopes: string; provider: CodingProvider; model: string;
  thinking: ModelThinkingLevel | null; api_key: string | null; created: string;
};
type PresetRow = { id: string; name: string; prompt: string; query: string; profile: string };
type RunStatus = "running" | "interrupted" | "done" | "unanswered" | "failed" | "cancelled";
type ReviewDecision = "accepted" | "changes_requested";
type RunRow = {
  project: string; session: string; id: string; actor: string; status: RunStatus; signature: string;
  admitted: number; created: string; updated: string; error: string | null;
  review: ReviewDecision | null; reviewer: string | null; reviewed: string | null;
};
type RunReviewRow = {
  id: string; decision: ReviewDecision; reviewer: string; reviewed: string; note: string | null;
  session: string; request_id: string; expected_id: string | null; member_id: string | null;
};
type BranchRow = {
  session: string; parent_session: string; parent_request: string; version: string;
  status: "pending" | "ready"; created: string;
};
type PatchRow = {
  preview_id: string; diff_hash: string; files: string; status: "prepared" | "applied"; applied: string | null;
};
type AuditRow = { kind: string; actor: string; session: string | null; request_id: string | null; at: string };
type GitHubRow = { remote: string; repository: string; token: string | null };
type GitHubPublication = {
  approval: string; repository: string; base: string; head: string; approved: string; created: string | null;
  pull_id: number | null; pull_number: number | null; draft: number | null; api_request_id: string | null;
};
type GitHubBranchPublication = {
  approval: string; repository: string; base: string; head: string; base_sha: string; base_tree: string;
  commit_sha: string | null; created: string | null;
};
type RunIdentity = Pick<RunRow, "session" | "id">;
type Running = {
  cancel: AbortController;
  promise: Promise<void>;
  stop?: () => void;
  progress?: { session: string; requestId: string; answer?: CodingLiveAnswer; tasks?: CodingTaskProgress };
};

export class ProjectControlError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function teamListenConfiguration(port: unknown, publicOrigin: unknown, allowEphemeral = false): TeamStartup {
  if (typeof port !== "number" || !Number.isInteger(port) || port < (allowEphemeral ? 0 : 1) || port > 65535) {
    throw new ProjectControlError(allowEphemeral ? "Enter a local TCP port from 0 to 65535."
      : "Choose a fixed local TCP port from 1 to 65535 for Team workspace startup.");
  }
  if (publicOrigin === null || publicOrigin === undefined || publicOrigin === "") return { port, publicOrigin: null };
  if (typeof publicOrigin === "string" && publicOrigin.length <= 256) {
    try {
      const url = new URL(publicOrigin);
      const withoutSlash = publicOrigin.endsWith("/") ? publicOrigin.slice(0, -1) : publicOrigin;
      const suppliedOrigin = withoutSlash.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
      const explicitDefaultPort = !url.port && suppliedOrigin === `${url.origin}:443`;
      if (url.protocol === "https:" && (suppliedOrigin === url.origin || explicitDefaultPort)) return { port, publicOrigin: url.origin };
    } catch { /* Report invalid input without echoing it. */ }
  }
  throw new ProjectControlError("Enter an HTTPS origin without a path, credentials, query, or fragment.");
}

const sessionPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const branchSessionPattern = /^alt-[a-f0-9]{60}$/u;
const branchVersionPattern = /^[a-f0-9]{64}$/u;
const requestPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const presetPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const maxProjectPresets = 24;
const reviewHistoryLimit = 20;
const now = () => new Date().toISOString();
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const retentionActor = "system:transcript-retention";
const retentionBatchSize = 24;
const maxComparisonAnswerLength = 64_000;
const retentionSweepInterval = 60 * 60 * 1000;
const githubPullActions = ["github-pr-inspect", "github-pr-recover", "github-pr-preview", "github-pr-publish"];
const githubBranchActions = ["github-branch-inspect", "github-branch-recover", "github-branch-preview", "github-branch-publish"];

function field(body: Json, name: string, max = 256): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max)
    throw new ProjectControlError(`Enter a value for ${name} up to ${max} UTF-8 bytes.`);
  return value.trim();
}

function isReviewId(value: unknown): value is string {
  return typeof value === "string" && value.length === 32 && /^[a-f0-9]+$/u.test(value);
}

function reviewSubmission(body: Json): { id: string; expected: string | null; note: string | null } | undefined {
  if (!Object.hasOwn(body, "reviewId") && !Object.hasOwn(body, "expectedReviewId") && !Object.hasOwn(body, "note")) return;
  const { reviewId, expectedReviewId, note } = body;
  if (!isReviewId(reviewId) || (expectedReviewId !== null && !isReviewId(expectedReviewId)))
    throw new ProjectControlError("Use a valid review ID and the latest review ID from inspection.");
  if (note === undefined) return { id: reviewId, expected: expectedReviewId, note: null };
  if (typeof note !== "string")
    throw new ProjectControlError("Enter an optional plain-text review note up to 4096 UTF-8 bytes.");
  const text = note.replaceAll("\r\n", "\n");
  if (Buffer.byteLength(text) > 4096 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text) || !text.isWellFormed())
    throw new ProjectControlError("Enter an optional plain-text review note up to 4096 UTF-8 bytes.");
  return { id: reviewId, expected: expectedReviewId, note: text.trim() ? text : null };
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

function profileInProject(project: ProjectRow, input: unknown): CodingProjectProfile {
  const profile = validateCodingProjectProfile(input);
  pathsInProject(project, [...profile.projects, ...(profile.sharedProjects ?? [])]);
  return profile;
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
    const profile = profileInProject(project, body.profile);
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
  providerCheckFetch?: typeof fetch;
  workerImage?: string;
  workerNetwork?: string;
  retentionAllowed?: () => boolean;
}

type ProviderDiagnosticCode = ProviderCheckOutcome["code"] | "worker-unavailable";
const providerCheckMessages: Record<ProviderDiagnosticCode, string> = {
  ready: "The configured model lookup succeeded.",
  denied: "The provider declined the lookup. Check the active credential and its model read permissions.",
  "model-unavailable": "The provider could not find the configured model for this credential.",
  "rate-limited": "The provider limited the lookup. Try again when requests are available.",
  redirected: "The provider lookup redirected. Check the worker's network and proxy configuration.",
  unreachable: "The worker could not reach the provider. Check its network and outbound HTTPS access.",
  "timed-out": "The provider check ran out of time. Check the worker's network and try again.",
  "invalid-response": "The lookup returned an unexpected response. Check the configured model and the worker's proxy settings.",
  "provider-error": "The provider returned an error during model lookup. Check the HTTP status and try again.",
  "worker-unavailable": "The configured worker could not complete the check. Check the server's worker setup.",
};

export function codingProjectCatalogPath(stateDir = join(dataDir(), "coding-projects")) {
  return join(stateDir, "projects.sqlite");
}

const readTeamStartupSql = "SELECT port, public_origin AS publicOrigin FROM team_startup WHERE singleton = 1";

/** Read saved Team preferences without taking the catalog lease or migrating older catalogs. */
export function readCodingTeamStartup(stateDir?: string): TeamStartup | null {
  const catalog = codingProjectCatalogPath(stateDir);
  if (!existsSync(catalog)) return null;
  try {
    ensureExtensionCapableSqlite();
    const db = new Database(catalog, { readonly: true, strict: true });
    try {
      using statement = db.prepare<TeamStartup, []>(readTeamStartupSql);
      const row = statement.get();
      return row && teamListenConfiguration(row.port, row.publicOrigin);
    } finally { db.close(true); }
  } catch {
    return null;
  }
}

/** Reserve a saved Team port before opening the owner listener, including from a read-only server. */
export function readCodingTeamStartupPort(stateDir?: string): number | null {
  return readCodingTeamStartup(stateDir)?.port ?? null;
}

export class CodingProjectControl {
  readonly #directory: string;
  readonly #db: Database;
  readonly #lease: Database;
  readonly #evaluations: CodingEvaluations;
  readonly #models: CodingDependencies["models"];
  readonly #githubFetch: GitHubFetch;
  readonly #providerCheckFetch: typeof fetch | undefined;
  readonly #providerCheckSecret = randomBytes(32);
  readonly #dockerWorker: DockerWorkerConfig | undefined;
  readonly #retentionAllowed: () => boolean;
  readonly #active = new Map<string, Running>();
  #patchInFlight = false;
  #workerCheckInFlight = false;
  #providerCheckInFlight: AbortController | undefined;
  readonly #gates = new Map<string, Promise<void>>();
  readonly #requests = new Set<Promise<unknown>>();
  #retentionTimer: ReturnType<typeof setInterval> | undefined;
  #retentionSweep: Promise<number> | undefined;
  #closing = false;

  constructor(options: ProjectControlOptions = {}) {
    this.#models = options.models;
    this.#githubFetch = options.githubFetch ?? fetch;
    this.#providerCheckFetch = options.providerCheckFetch;
    this.#retentionAllowed = options.retentionAllowed ?? (() => true);
    try {
      this.#dockerWorker = dockerWorkerConfig(
        options.workerImage ?? process.env.OKB_CODING_WORKER_IMAGE,
        options.workerNetwork ?? process.env.OKB_CODING_WORKER_NETWORK,
      );
    } catch (error) {
      if (error instanceof CodingError) throw new ProjectControlError(error.message, 409);
      throw error;
    }
    if (this.#dockerWorker && this.#models) throw new ProjectControlError("Injected providers cannot run in a Docker worker.", 409);
    if (this.#dockerWorker && this.#providerCheckFetch) throw new ProjectControlError("Injected provider checks cannot run in a Docker worker.", 409);
    const catalog = codingProjectCatalogPath(options.stateDir);
    this.#directory = dirname(catalog);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const directoryInfo = lstatSync(this.#directory);
    if (!directoryInfo.isDirectory()) throw new ProjectControlError("Coding project data must be a directory.", 409);
    if (process.platform !== "win32" && (directoryInfo.mode & 0o077) !== 0) chmodSync(this.#directory, 0o700);
    ensureExtensionCapableSqlite();
    this.#lease = new Database(join(this.#directory, "owner.sqlite"));
    let db: Database | undefined;
    try {
      this.#lease.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      db = new Database(catalog, { strict: true });
      db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS projects(
          id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL, scopes TEXT NOT NULL,
          provider TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT, api_key TEXT, created TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_startup(
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          port INTEGER NOT NULL CHECK(typeof(port) = 'integer' AND port BETWEEN 1 AND 65535),
          public_origin TEXT
        );
        CREATE TABLE IF NOT EXISTS project_presets(
          project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
          name TEXT COLLATE NOCASE NOT NULL, prompt TEXT NOT NULL, query TEXT NOT NULL, profile TEXT NOT NULL,
          PRIMARY KEY(project, id), UNIQUE(project, name)
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
        CREATE TABLE IF NOT EXISTS run_reviews(
          seq INTEGER PRIMARY KEY,
          project TEXT NOT NULL, session TEXT NOT NULL, request_id TEXT NOT NULL, id TEXT NOT NULL,
          decision TEXT NOT NULL CHECK(decision IN ('accepted','changes_requested')),
          reviewer TEXT NOT NULL, reviewed TEXT NOT NULL, note TEXT, expected_id TEXT, member_id TEXT,
          UNIQUE(project, id),
          FOREIGN KEY(project, session, request_id) REFERENCES runs(project, session, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS run_reviews_latest ON run_reviews(project, session, request_id, seq DESC);
        INSERT INTO run_reviews(project, session, request_id, id, decision, reviewer, reviewed)
          SELECT project, session, id, lower(hex(randomblob(16))), review, reviewer, reviewed FROM runs
          WHERE review IN ('accepted','changes_requested') AND reviewer IS NOT NULL AND reviewed IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM run_reviews
              WHERE run_reviews.project = runs.project AND run_reviews.session = runs.session AND run_reviews.request_id = runs.id);
        CREATE TABLE IF NOT EXISTS conversation_branches(
          project TEXT NOT NULL REFERENCES projects(id), session TEXT NOT NULL,
          parent_session TEXT NOT NULL, parent_request TEXT NOT NULL, version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','ready')), created TEXT NOT NULL,
          PRIMARY KEY(project, session), UNIQUE(project, parent_session, parent_request)
        );
        CREATE TABLE IF NOT EXISTS audit(
          seq INTEGER PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL,
          actor TEXT NOT NULL, session TEXT, request_id TEXT, at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_project_seq ON audit(project, seq DESC);
        CREATE TABLE IF NOT EXISTS session_deletions(
          project TEXT NOT NULL REFERENCES projects(id), session TEXT NOT NULL, actor TEXT NOT NULL, automatic INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (project, session)
        );
        CREATE TABLE IF NOT EXISTS transcript_retention(
          project TEXT PRIMARY KEY REFERENCES projects(id), days INTEGER NOT NULL CHECK(days BETWEEN 1 AND 365)
        );
        CREATE TABLE IF NOT EXISTS expired_requests(
          project TEXT NOT NULL REFERENCES projects(id), session TEXT NOT NULL, id TEXT NOT NULL,
          PRIMARY KEY(project, session, id)
        );
        CREATE TABLE IF NOT EXISTS github_projects(
          project TEXT PRIMARY KEY REFERENCES projects(id), remote TEXT NOT NULL, repository TEXT NOT NULL, token TEXT
        );
        CREATE TABLE IF NOT EXISTS github_pr_credentials(
          project TEXT PRIMARY KEY REFERENCES github_projects(project) ON DELETE CASCADE, token TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS github_contents_credentials(
          project TEXT PRIMARY KEY REFERENCES github_projects(project) ON DELETE CASCADE, token TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS github_publications(
          project TEXT NOT NULL REFERENCES projects(id), session TEXT NOT NULL, request_id TEXT NOT NULL,
          approval TEXT NOT NULL, repository TEXT NOT NULL, base TEXT NOT NULL, head TEXT NOT NULL,
          approved TEXT NOT NULL, created TEXT, pull_id INTEGER, pull_number INTEGER, draft INTEGER, api_request_id TEXT,
          PRIMARY KEY(project, session, request_id)
        );
        CREATE TABLE IF NOT EXISTS github_branch_publications(
          project TEXT NOT NULL REFERENCES projects(id), session TEXT NOT NULL, request_id TEXT NOT NULL,
          approval TEXT NOT NULL, repository TEXT NOT NULL, base TEXT NOT NULL, head TEXT NOT NULL,
          base_sha TEXT NOT NULL, base_tree TEXT NOT NULL, commit_sha TEXT, created TEXT,
          PRIMARY KEY(project, session, request_id)
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
      this.#evaluations = new CodingEvaluations(db);
      if (!this.#all<{ name: string }>("PRAGMA table_info(members)").some((column) => column.name === "expires"))
        db.exec("ALTER TABLE members ADD COLUMN expires TEXT");
      if (!this.#all<{ name: string }>("PRAGMA table_info(session_deletions)").some((column) => column.name === "automatic"))
        db.exec("ALTER TABLE session_deletions ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0");
      for (const deletion of this.#all<{ project: string; session: string; actor: string; automatic: number }>("SELECT * FROM session_deletions")) {
        if (deletion.automatic && !this.#retentionAllowed()) continue;
        rmSync(this.#sessionDirectory(deletion.project, deletion.session), { recursive: true, force: true });
        this.#finishDeletion(deletion.project, deletion.session, deletion.actor, Boolean(deletion.automatic));
      }
      this.#retentionTimer = setInterval(() => this.#startRetentionSweep(), retentionSweepInterval);
      this.#retentionTimer.unref();
      this.#startRetentionSweep();
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
    clearInterval(this.#retentionTimer);
    this.#providerCheckInFlight?.abort();
    const active = [...this.#active.values()];
    for (const { stop } of active) stop?.();
    await Promise.allSettled([...active.map(({ promise }) => promise), ...this.#requests, this.#retentionSweep]);
    try {
      this.#db.close(true);
    } finally {
      this.#lease.close(true);
    }
  }

  getTeamStartup(): TeamStartup | null {
    if (this.#closing) throw new ProjectControlError("The coding server is shutting down.", 409);
    const row = this.#get<TeamStartup>(readTeamStartupSql);
    return row && teamListenConfiguration(row.port, row.publicOrigin);
  }

  saveTeamStartup(value: TeamStartup | null): void {
    if (this.#closing) throw new ProjectControlError("The coding server is shutting down.", 409);
    if (value === null) {
      this.#write("DELETE FROM team_startup WHERE singleton = 1");
      return;
    }
    const binding = teamListenConfiguration(value.port, value.publicOrigin);
    this.#write(`INSERT INTO team_startup (singleton, port, public_origin) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET port = excluded.port, public_origin = excluded.public_origin`, binding.port, binding.publicOrigin);
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
    if (!row) {
      this.#checkExpiredRequest(project, session, id);
      throw new ProjectControlError("No coding request with that ID exists in this session.", 404);
    }
    return row;
  }

  #checkExpiredRequest(project: string, session: string, id: string) {
    if (this.#get("SELECT 1 FROM expired_requests WHERE project = ? AND session = ? AND id = ?", project, session, id)) {
      throw new ProjectControlError("This request's transcript expired. Use a new request ID to start new work.", 410);
    }
  }

  #runView({ signature: _signature, ...row }: RunRow) {
    const branch = this.#branch(row.project, row.session);
    return { ...row, admitted: Boolean(row.admitted),
      ...(branch ? { branch: { session: branch.parent_session, requestId: branch.parent_request } } : {}),
    };
  }

  #projectView(row: ProjectRow, actor: Actor) {
    const { api_key, scopes, workspace, ...settings } = row;
    return {
      ...settings,
      providerLabel: codingProviderLabel(row.provider),
      ...(actor.owner ? { workspace } : {}),
      scopes: JSON.parse(scopes) as string[],
      workerIsolation: this.#dockerWorker ? "docker" : "process",
      credential: this.#credentialSource(row, actor),
    };
  }

  #credentialSource(project: ProjectRow, actor: Actor) {
    if (project.api_key) return "project";
    return actor.owner && hasCodingCredential(project.provider, { models: this.#models }) ? "environment" : "missing";
  }

  #identity(owner: boolean, token: string | null): Actor {
    if (owner) return { id: resolveActor(), owner };
    if (token?.startsWith("okbp_") && token.length === 48) {
      const member = this.#get<{ id: string; project: string; actor: string }>(
        "SELECT id, project, actor FROM members WHERE secret = ? AND expires > ?", digest(token), now(),
      );
      if (member) return { id: member.actor, owner: false, project: member.project, memberId: member.id };
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

  #presets(project: ProjectRow, method: "GET" | "POST", body: Json, actor: Actor) {
    if (method === "POST") {
      this.#requireOwner(actor);
      const action = body.action;
      if (action !== "save" && action !== "remove") throw new ProjectControlError("Choose whether to save or remove a project preset.");
      const id = body.id === undefined && action === "save" ? undefined : field(body, "id", 36);
      if (id !== undefined && !presetPattern.test(id)) throw new ProjectControlError("Choose a valid project preset ID.");
      if (action === "save") {
        const name = field(body, "name", 120);
        const prompt = field(body, "prompt", 16384);
        const query = field(body, "query", 1024);
        if (/[\x00-\x1f\x7f]/u.test(name) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(prompt + query))
          throw new ProjectControlError("Use a single-line preset name and plain task and query text.");
        const profile = JSON.stringify(profileInProject(project, body.profile));
        this.#db.transaction(() => {
          if (id !== undefined) this.#requirePreset(project.id, id);
          if (this.#get("SELECT 1 FROM project_presets WHERE project = ? AND name = ? AND id IS NOT ?", project.id, name, id ?? null))
            throw new ProjectControlError("A preset in this project already uses that name.", 409);
          if (id === undefined) {
            const count = this.#get<{ count: number }>("SELECT count(*) AS count FROM project_presets WHERE project = ?", project.id)?.count ?? 0;
            if (count >= maxProjectPresets) throw new ProjectControlError(`Save up to ${maxProjectPresets} presets per project.`, 409);
            this.#write("INSERT INTO project_presets(project, id, name, prompt, query, profile) VALUES (?, ?, ?, ?, ?, ?)",
              project.id, randomUUID(), name, prompt, query, profile);
          } else {
            this.#write("UPDATE project_presets SET name = ?, prompt = ?, query = ?, profile = ? WHERE project = ? AND id = ?",
              name, prompt, query, profile, project.id, id);
          }
          this.#audit(project.id, "preset_saved", actor.id);
        })();
      } else {
        this.#db.transaction(() => {
          this.#requirePreset(project.id, id!);
          this.#write("DELETE FROM project_presets WHERE project = ? AND id = ?", project.id, id!);
          this.#audit(project.id, "preset_removed", actor.id);
        })();
      }
    }
    const rows = this.#all<PresetRow>("SELECT id, name, prompt, query, profile FROM project_presets WHERE project = ? ORDER BY name COLLATE NOCASE, id", project.id);
    return { presets: rows.map(({ profile, ...preset }) => ({ ...preset, profile: JSON.parse(profile) as CodingProjectProfile })) };
  }

  #requirePreset(project: string, id: string) {
    if (!this.#get("SELECT 1 FROM project_presets WHERE project = ? AND id = ?", project, id))
      throw new ProjectControlError("Coding preset not found in this project.", 404);
  }

  async #preview(project: ProjectRow, body: Json, actor: Actor) {
    const started = performance.now();
    const source = sourceOptions(project, body);
    const workspace = await this.#workspace(project);
    const evaluation = parseEvaluation(body.evaluation, JSON.parse(project.scopes));
    const branchSession = typeof body.session === "string" && branchSessionPattern.test(body.session) ? body.session : undefined;
    const branchContext = branchSession
      ? await this.#branchSendPreview(project, branchSession, actor, Boolean(source.packages || evaluation || body.measurePreview)) : undefined;
    const binding = pinnedEvaluationBinding(evaluation, typeof body.prompt === "string" ? body.prompt : undefined, source, body.approvedSourceLookup === true);
    if (binding) await verifyPinnedEvaluationWorkspace(workspace);
    const measuredFrom = binding ? performance.now() : started;
    const result = source.packages
      ? { source: "packages", ...await previewPackageReviews(workspace, source.packages) }
      : source.repository
        ? { source: "repository", ...await selectRepositoryContext({ workspace, ...source.repository }) }
        : { source: "files", ...await previewCodingAttachments(workspace, source.files, JSON.parse(project.scopes)) };
    const milliseconds = performance.now() - measuredFrom;
    if (binding) await verifyPinnedEvaluationWorkspace(workspace);
    if (binding || body.measurePreview === true) {
      const id = "manifest" in result ? result.manifest.id : result.id;
      this.#evaluations.preview(project.id, actor.id, id, milliseconds, binding);
    }
    return { ...result, ...(branchContext ? { branchContext } : {}) };
  }

  #runParts(body: Json) {
    const session = field(body, "session", 64);
    const requestId = field(body, "requestId", 128);
    if (!sessionPattern.test(session) || !requestPattern.test(requestId))
      throw new ProjectControlError("Use a lowercase session name and a request ID made of letters, digits, periods, hyphens, or underscores.");
    return { session, requestId };
  }

  #session<T extends { session: string }>(project: ProjectRow, run: T) {
    const branch = this.#branch(project.id, run.session);
    if (branch?.status === "pending") throw new ProjectControlError("Finish creating the approved alternative branch before using it.", 409);
    if (!branch && branchSessionPattern.test(run.session) &&
      !this.#get("SELECT 1 FROM runs WHERE project = ? AND session = ? LIMIT 1", project.id, run.session))
      throw new ProjectControlError("This alternative branch is unavailable. Select a saved branch in Run history.", 404);
    return {
      ...run, workspace: project.workspace, provider: project.provider, model: project.model,
      thinkingLevel: project.thinking ?? undefined,
      ...(branch ? { branch: { parentSession: branch.parent_session, id: branch.version } } : {}),
    };
  }

  #branch(project: string, session: string) {
    if (!branchSessionPattern.test(session)) return null;
    return this.#get<BranchRow>("SELECT * FROM conversation_branches WHERE project = ? AND session = ?", project, session);
  }

  #physicalSession(project: string, session: string) {
    return this.#branch(project, session)?.parent_session ?? session;
  }

  #sessionKey(project: string, session: string) {
    return `${project}/${this.#physicalSession(project, session)}`;
  }

  #sessionDeleting(project: string, session: string) {
    return this.#get("SELECT 1 FROM session_deletions WHERE project = ? AND session = ?", project, this.#physicalSession(project, session));
  }

  #unfinishedRun(project: string, session: string, exceptRequest?: string) {
    return this.#get<{ id: string }>(`SELECT runs.id FROM runs
      LEFT JOIN conversation_branches b ON b.project = runs.project AND b.session = runs.session
      WHERE runs.project = ? AND COALESCE(b.parent_session, runs.session) = ?
        AND runs.status IN ('running', 'interrupted') AND NOT (runs.session = ? AND runs.id = COALESCE(?, '')) LIMIT 1`,
      project, this.#physicalSession(project, session), session, exceptRequest ?? null);
  }

  #conversationBranchView(branch: BranchRow) {
    return {
      session: branch.parent_session, requestId: branch.parent_request, branchSession: branch.session,
      status: branch.status, createdAt: branch.created,
      ...(branch.status === "pending" ? { previewId: branch.version } : {}),
    };
  }

  #requireBranchIdle(project: ProjectRow, session: string) {
    if (this.#active.has(this.#sessionKey(project.id, session)) || this.#unfinishedRun(project.id, session))
      throw new ProjectControlError("Finish, resume, or cancel active work in this transcript before branching or previewing branch context.", 409);
    if (this.#sessionDeleting(project.id, session)) throw new ProjectControlError("This transcript is being deleted.", 409);
  }

  async #branchSendPreview(project: ProjectRow, session: string, actor: Actor, unsupported: boolean) {
    this.#requireOwner(actor);
    const identity = this.#session(project, { session });
    if (!identity.branch) return;
    if (unsupported) throw new ProjectControlError("Choose an ordinary files or repository review for an alternative branch.", 409);
    this.#requireBranchIdle(project, session);
    const { version, estimatedTokens, activeEntries, history, providerContinuity } = await previewCodingBranchContext(identity, this.#dependencies(project, actor));
    return { id: version, estimatedTokens, inheritedEntries: activeEntries, history, providerContinuity };
  }

  async #changeBranch(project: ProjectRow, body: Json, actor: Actor, preview: boolean, canWrite: () => boolean) {
    this.#requireOwner(actor);
    const run = this.#runParts(body);
    const authorize = () => {
      if (this.#closing || !canWrite()) throw new ProjectControlError("Open a writable brain to create an alternative branch.", 403);
    };
    authorize();
    const row = this.#readRun(project.id, run.session, run.requestId);
    const prior = this.#get<BranchRow>(`SELECT * FROM conversation_branches
      WHERE project = ? AND parent_session = ? AND parent_request = ?`, project.id, run.session, run.requestId);
    const requireAcceptedParent = () => {
      if (this.#branch(project.id, run.session) || row.status !== "done" || row.review !== "accepted")
        throw new ProjectControlError("Accept a completed result in the parent session before creating an alternative branch.", 409);
    };
    if (preview || !prior) requireAcceptedParent();
    const identity = this.#session(project, run);
    const dependencies = this.#dependencies(project, actor);
    if (preview) {
      if (prior) throw new ProjectControlError("This result already has an alternative branch. Open it from Run history.", 409);
      this.#requireBranchIdle(project, run.session);
      const { version, estimatedTokens, activeEntries, history, providerContinuity } = await previewCodingBranch(identity, run.requestId, dependencies);
      return {
        ...run, branchSession: `alt-${version.slice(0, 60)}`, previewId: version, provider: project.provider, model: project.model,
        estimatedTokens, inheritedEntries: activeEntries, history, providerContinuity,
      };
    }

    const previewId = field(body, "previewId", 64);
    if (!branchVersionPattern.test(previewId) || (prior && prior.version !== previewId))
      throw new ProjectControlError("Preview the inherited context before creating the branch.", 409);
    const branchSession = `alt-${previewId.slice(0, 60)}`;
    if (prior?.status === "ready") return { ...run, branchSession, created: true, replayed: true };
    this.#requireBranchIdle(project, run.session);
    const approve = () => {
      authorize();
      requireAcceptedParent();
      if (prior) return;
      this.#db.transaction(() => {
        if (this.#branch(project.id, branchSession) || this.#get("SELECT 1 FROM runs WHERE project = ? AND session = ? LIMIT 1", project.id, branchSession))
          throw new ProjectControlError("The alternative branch name is already in use.", 409);
        this.#write(`INSERT INTO conversation_branches(project, session, parent_session, parent_request, version, status, created)
          VALUES (?, ?, ?, ?, ?, 'pending', ?)`, project.id, branchSession, run.session, run.requestId, previewId, now());
        this.#audit(project.id, "alternative_branch_approved", actor.id, run.session, run.requestId);
      })();
    };
    const receipt = await createCodingBranch(identity, run.requestId, previewId, dependencies, approve);
    if (!this.#branch(project.id, branchSession)) throw new ProjectControlError("The saved branch approval could not be found.", 409);
    this.#db.transaction(() => {
      this.#write("UPDATE conversation_branches SET status = 'ready' WHERE project = ? AND session = ?", project.id, branchSession);
      this.#audit(project.id, "alternative_branch_created", actor.id, run.session, run.requestId);
    })();
    return { ...run, branchSession, created: true, ...(receipt.replayed ? { replayed: true } : {}) };
  }

  #dependencies(project: ProjectRow, actor: Actor): CodingDependencies & { workspaceBinding: string } {
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
    const key = this.#sessionKey(project.id, run.session);
    const cancel = new AbortController();
    const dependencies = this.#dependencies(project, actor);
    const progress: NonNullable<Running["progress"]> = { session: run.session, requestId: run.requestId };
    const admitted = () => this.#auditAdmitted(project.id, run, actor);
    const liveAnswer = (answer: CodingLiveAnswer | undefined) => { progress.answer = answer; };
    const taskProgress = (tasks: CodingTaskProgress | undefined) => { progress.tasks = tasks; };
    let stop: (() => void) | undefined;
    let result: Promise<"done" | "unanswered">;
    try {
      if (dependencies.models) {
        stop = () => cancel.abort();
        result = runCodingSession(run, { ...dependencies, signal: cancel.signal, admitted, liveAnswer, taskProgress }).then((receipt) => receipt.status);
      } else {
        const worker = launchProjectWorker({
          options: run, stateDir: dependencies.stateDir!, workspaceBinding: project.workspace,
          apiKey: codingCredential(project.provider, dependencies),
        }, cancel.signal, { admitted, liveAnswer, taskProgress }, this.#dockerWorker);
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
    this.#active.set(key, { cancel, promise, stop, progress });
  }

  #canSchedule(project: ProjectRow, run: { session: string; requestId: string }) {
    if (this.#closing || this.#active.size >= 4) throw new ProjectControlError("The server is busy. Try again after a run finishes.", 409);
    if (this.#active.has(this.#sessionKey(project.id, run.session)))
      throw new ProjectControlError("Another request in this session is currently running.", 409);
    if (this.#sessionDeleting(project.id, run.session))
      throw new ProjectControlError("Finish deleting this session before starting another request.", 409);
  }

  async #start(project: ProjectRow, body: Json, actor: Actor, canWrite: () => boolean) {
    const run = this.#runParts(body);
    this.#checkExpiredRequest(project.id, run.session, run.requestId);
    const identity = this.#session(project, run);
    const branch = identity.branch;
    if (branch) this.#requireOwner(actor);
    const prompt = field(body, "prompt", 16384);
    if (body.approved !== true) throw new ProjectControlError("Review the preview and confirm the content to send.");
    const previewId = field(body, "previewId", 128);
    const selection = sourceOptions(project, body);
    if (body.approvedSourceLookup !== undefined && typeof body.approvedSourceLookup !== "boolean")
      throw new ProjectControlError("Choose whether to allow lookups in approved source.");
    const approvedSourceLookup = body.approvedSourceLookup === true;
    if (approvedSourceLookup && (selection.packages || (!selection.repository && !selection.files?.length)))
      throw new ProjectControlError("Choose explicit files or repository excerpts to allow approved source lookup.");
    const capabilities = approvedSourceLookup ? { approvedSourceLookup: true as const } : {};
    const evaluation = parseEvaluation(body.evaluation, JSON.parse(project.scopes));
    if (branch && (evaluation || selection.packages))
      throw new ProjectControlError("Choose an ordinary files or repository review for an alternative branch.", 409);
    const branchContextId = branch ? field(body, "branchContextId", 64) : undefined;
    if (branchContextId !== undefined && !branchVersionPattern.test(branchContextId))
      throw new ProjectControlError("Preview and approve the current alternative branch context before sending.", 409);
    const binding = pinnedEvaluationBinding(evaluation, prompt, selection, approvedSourceLookup);
    const signature = digest(JSON.stringify({ prompt, previewId, selection, ...(evaluation ? { evaluation } : {}), ...capabilities,
      ...(branchContextId ? { branchContextId } : {}),
    }));
    const workspace = await this.#workspace(project);
    const prior = this.#get<RunRow>("SELECT * FROM runs WHERE project = ? AND session = ? AND id = ?", project.id, run.session, run.requestId);
    if (prior && prior.status !== "failed") {
      if (prior.signature !== signature) throw new ProjectControlError("This request ID is bound to a different task or source selection.", 409);
      return this.#runView(prior);
    }
    if (prior?.admitted) throw new ProjectControlError("This request was already admitted. Inspect it and use Resume to recover its saved input.", 409);
    if (!hasCodingCredential(project.provider, this.#dependencies(project, actor)))
      throw new ProjectControlError("Add a provider API key for this project before sending requests.", 409);
    this.#canSchedule(project, run);
    const blocking = this.#unfinishedRun(project.id, run.session, run.requestId);
    if (blocking) throw new ProjectControlError(`Resume or cancel interrupted request ${blocking.id} before starting another in this session.`, 409);
    if (binding) {
      if (this.#get("SELECT 1 FROM runs WHERE project = ? AND session = ? AND id <> ? LIMIT 1", project.id, run.session, run.requestId))
        throw new ProjectControlError("Use a fresh session for each pinned evaluation trial.", 409);
      await verifyPinnedEvaluationWorkspace(workspace);
    }
    const { stateDir, models, workspaceBinding } = this.#dependencies(project, actor);
    if (branch) {
      if ((await previewCodingBranchContext(identity, this.#dependencies(project, actor))).version !== branchContextId)
        throw new ProjectControlError("The branch context changed. Preview it again before sending.", 409);
      if (this.#closing || !canWrite()) throw new ProjectControlError("Open a writable brain to send from this branch.", 403);
    } else await requireNoPendingCodingContextCompaction(identity, { stateDir, models, workspaceBinding, allowEnvKey: false });
    this.#db.transaction(() => {
      if (prior) {
        this.#write("UPDATE runs SET status = 'running', signature = ?, actor = ?, updated = ?, error = NULL WHERE project = ? AND session = ? AND id = ?",
          signature, actor.id, now(), project.id, run.session, run.requestId);
      } else {
        const time = now();
        this.#write("INSERT INTO runs(project, session, id, actor, status, signature, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          project.id, run.session, run.requestId, actor.id, "running", signature, time, time);
      }
      if (evaluation || prior) {
        const strategy = selection.packages ? "packages" : selection.repository?.profile ? "indexed" : selection.repository ? "lexical" : "files";
        this.#evaluations.enroll({ project: project.id, ...run }, actor.id, evaluation, prompt,
          strategy, this.#models ? "injected" : "provider", previewId, binding);
      }
      this.#audit(project.id, "submitted", actor.id, run.session, run.requestId);
    })();
    this.#schedule(project, {
      ...identity, prompt, ...capabilities,
      ...(branch ? { branch: { ...branch, contextVersion: branchContextId } } : {}),
      ...(selection.packages ? { packageReviews: { packages: selection.packages, id: previewId } } : selection.repository
        ? { repository: { ...selection.repository, id: previewId } }
        : { files: selection.files, filePreviewId: previewId, allowedAttachmentScopes: JSON.parse(project.scopes) as string[] }),
    }, actor);
    return this.#runView(this.#readRun(project.id, run.session, run.requestId));
  }

  async #inspect(project: ProjectRow, body: Json, actor: Actor, canWrite: () => boolean = () => false) {
    const run = this.#runParts(body);
    const row = this.#readRun(project.id, run.session, run.requestId);
    if (this.#sessionDeleting(project.id, run.session))
      throw new ProjectControlError("This transcript is being deleted.", 409);
    const value = this.#runView(row);
    const active = this.#active.get(this.#sessionKey(project.id, run.session));
    if (active || (row.status !== "interrupted" && !row.admitted)) {
      const progress = row.status === "running" && active?.progress?.session === run.session && active.progress.requestId === run.requestId
        && !active.cancel.signal.aborted ? active.progress : undefined;
      return {
        run: value,
        ...(progress?.answer && { liveAnswer: progress.answer }),
        ...(progress?.tasks && { taskProgress: progress.tasks }),
      };
    }
    try {
      const pi = await getCodingSessionStatus(
        { ...this.#session(project, run), includeReceipt: true, includeSourcePaths: true },
        this.#dependencies(project, actor),
      );
      let inspected = value;
      if (row.status === "interrupted" && pi.request?.receipt) {
        this.#auditAdmitted(project.id, run, actor);
        this.#setRun(project.id, run, actor, pi.request.receipt.status);
        inspected = this.#runView(this.#readRun(project.id, run.session, run.requestId));
      }
      const report = codingRunReport(pi, { requestId: run.requestId, status: inspected.status, projectId: project.id, review: inspected.review });
      let alternativeBranchEligible = false;
      let alternativeBranchReason: string | undefined;
      if (actor.owner && canWrite() && !inspected.branch && inspected.review === "accepted" && pi.request?.receipt?.status === "done" &&
        !pi.request.receipt.packageReviews && !this.#unfinishedRun(project.id, run.session) && !this.#get(
          "SELECT 1 FROM conversation_branches WHERE project = ? AND parent_session = ? AND parent_request = ?", project.id, run.session, run.requestId,
        )) {
        try {
          await previewCodingBranch(this.#session(project, run), run.requestId, this.#dependencies(project, actor));
          alternativeBranchEligible = canWrite();
        } catch (error) {
          if (!(error instanceof CodingError)) throw error;
          alternativeBranchReason = error.message;
        }
      }
      return { run: inspected, pi, report, ...(alternativeBranchEligible ? { alternativeBranchEligible } : {}),
        ...(alternativeBranchReason ? { alternativeBranchReason } : {}),
      };
    } catch (error) {
      if (row.status === "interrupted" && !row.admitted && error instanceof CodingError && error.message.startsWith("No "))
        return { run: value, admissionMissing: true };
      throw error;
    }
  }

  async #sourceInspect(project: ProjectRow, body: Json, actor: Actor) {
    const run = this.#runParts(body);
    const row = this.#readRun(project.id, run.session, run.requestId);
    if (this.#sessionDeleting(project.id, run.session))
      throw new ProjectControlError("This transcript is being deleted.", 409);
    if (row.status === "running" || this.#active.has(this.#sessionKey(project.id, run.session)))
      throw new ProjectControlError("Wait for the active request in this session before opening saved source.", 409);
    // Pi can save its admission before the catalog receives the worker event.
    if (!row.admitted && row.status !== "interrupted") return null;
    return getSavedCodingRequestInput(this.#session(project, run), this.#dependencies(project, actor));
  }

  async #compareBranch(project: ProjectRow, body: Json, actor: Actor) {
    const run = this.#runParts(body);
    const alternative = this.#readRun(project.id, run.session, run.requestId);
    const branch = this.#branch(project.id, run.session);
    if (branch?.status !== "ready" || alternative.status !== "done" || !alternative.admitted)
      throw new ProjectControlError("Choose a finished alternative review to compare with its original result.", 409);
    const original = this.#readRun(project.id, branch.parent_session, branch.parent_request);
    if (original.status !== "done" || !original.admitted)
      throw new ProjectControlError("The original saved result is unavailable.", 409);
    if (this.#sessionDeleting(project.id, run.session)) throw new ProjectControlError("This transcript is being deleted.", 409);
    if (this.#active.has(this.#sessionKey(project.id, run.session)))
      throw new ProjectControlError("Wait for the active request in this transcript before comparing saved answers.", 409);

    const views = await getCodingRunComparison(
      this.#session(project, { session: original.session, requestId: original.id }),
      this.#session(project, run), this.#dependencies(project, actor),
    );
    const comparison = (row: RunRow, pi: CodingSessionStatusResult) => {
      const receipt = pi.request?.receipt;
      const report = codingRunReport(pi, { projectId: project.id, requestId: row.id, status: row.status, review: row.review });
      if (receipt?.status !== "done" || !report)
        throw new ProjectControlError("A saved answer could not be loaded for comparison.", 409);
      return {
        session: row.session, requestId: row.id, review: row.review, status: row.status,
        task: pi.request?.savedPrompt,
        answer: { text: receipt.text.slice(0, maxComparisonAnswerLength).toWellFormed(), truncated: receipt.text.length > maxComparisonAnswerLength },
        report,
      };
    };
    return { original: comparison(original, views[0]), alternative: comparison(alternative, views[1]) };
  }

  async #changeContext(project: ProjectRow, body: Json, actor: Actor, compact: boolean, preview: boolean, canWrite: () => boolean) {
    const session = field(body, "session", 64);
    if (this.#branch(project.id, session)) throw new ProjectControlError("Manual context changes are available in the parent session.", 409);
    const authorize = () => {
      if (this.#closing || !canWrite()) throw new ProjectControlError("Open a writable brain to change the session context.", 403);
    };
    authorize();
    if (this.#active.has(this.#sessionKey(project.id, session)) || this.#unfinishedRun(project.id, session))
      throw new ProjectControlError("Finish, resume, or cancel active work in this session before changing its context.", 409);
    if (this.#sessionDeleting(project.id, session))
      throw new ProjectControlError("This session is being deleted.", 409);
    const identity = this.#session(project, { session });
    const { stateDir, models, workspaceBinding } = this.#dependencies(project, actor);
    const dependencies = { stateDir, models, workspaceBinding, allowEnvKey: false };
    const handoff = compact ? undefined : parseCodingHandoff(body.handoff);
    if (preview) return compact ? previewCodingContextCompaction(identity, dependencies) : previewCodingContextReset({ ...identity, handoff }, dependencies);

    const version = field(body, "version", 64);
    if (!/^[a-f0-9]{64}$/u.test(version)) throw new ProjectControlError("Preview the active context before confirming the change.");
    const receiptId = `context-${compact ? "compaction" : "reset"}-${version}`;
    const approvedKind = compact ? "context_compaction_approved" : "context_reset_approved";
    const auditActor = (kind: string) => this.#get<{ actor: string }>(
      "SELECT actor FROM audit WHERE project = ? AND session = ? AND request_id = ? AND kind = ? LIMIT 1",
      project.id, session, receiptId, kind,
    )?.actor;
    const approve = () => {
      authorize();
      if (!auditActor(approvedKind)) this.#audit(project.id, approvedKind, actor.id, session, receiptId);
    };
    const result = compact ? await compactCodingContext({ ...identity, version }, dependencies, approve)
      : await resetCodingContext({ ...identity, version, handoff }, dependencies, approve);
    const resultKind = "compacted" in result ? result.compacted ? "context_compaction" : "context_compaction_skipped" : "context_reset";
    const approvedBy = auditActor(approvedKind);
    if (approvedBy && !auditActor(resultKind)) this.#audit(project.id, resultKind, approvedBy, session, receiptId);
    return result;
  }

  async #evaluate(project: ProjectRow, body: Json, actor: Actor, save: boolean) {
    const run = this.#runParts(body);
    const identity = { project: project.id, ...run };
    const attempt = this.#evaluations.get(identity, actor.id);
    if (!attempt) throw new ProjectControlError("This request was not enrolled in an evaluation.", 404);
    if (save && !attempt.canReview)
      throw new ProjectControlError("An independent project member can evaluate a finished run. An existing evaluation belongs to its reviewer.", 403);
    if (attempt.status !== "done" && attempt.status !== "unanswered")
      throw new ProjectControlError("Wait for the run to finish before opening its evaluation.", 409);
    if (this.#active.has(this.#sessionKey(project.id, run.session)))
      throw new ProjectControlError("Wait for the active request in this session before opening the evaluation.", 409);
    if (this.#get("SELECT session FROM session_deletions WHERE project = ? AND session = ?", project.id, run.session))
      throw new ProjectControlError("This session is being deleted.", 409);
    const { request } = await getCodingSessionStatus({
      ...this.#session(project, run), includeReceipt: !save, includeEvaluationInput: true,
    }, this.#dependencies(project, actor));
    if (!request?.evaluationInput) throw new ProjectControlError("The saved evaluation source could not be read.", 409);
    const { sources, task } = request.evaluationInput;
    if (!save) return {
      attempt, task, sources, evidencePresent: presentEvidence(attempt.evidence, sources),
      response: request.receipt?.status === "done" ? request.receipt.text : null,
      unansweredReason: request.reason ?? null,
    };
    return this.#db.transaction(() => {
      const { result, changed } = this.#evaluations.save(identity, actor.id, body.decision, body.verified, sources, request.usage);
      if (changed) this.#audit(project.id, "evaluation_" + result.decision, actor.id, run.session, run.requestId);
      return result;
    })();
  }

  async #resume(project: ProjectRow, body: Json, actor: Actor) {
    const run = this.#runParts(body);
    if (this.#branch(project.id, run.session)) this.#requireOwner(actor);
    const inspected = await this.#inspect(project, body, actor);
    if (inspected.run.status !== "interrupted") return inspected.run;
    if (inspected.admissionMissing) {
      this.#setRun(project.id, run, actor, "failed", "The server stopped before this request was admitted. Preview and submit it again with the same request ID.");
      return this.#runView(this.#readRun(project.id, run.session, run.requestId));
    }
    if ("pi" in inspected && inspected.pi?.context.compactionPending)
      throw new ProjectControlError("Recover the pending context compaction before resuming work in this session.", 409);
    if (!hasCodingCredential(project.provider, this.#dependencies(project, actor)))
      throw new ProjectControlError("Add a provider API key for this project before resuming requests.", 409);
    this.#canSchedule(project, run);
    if (this.#unfinishedRun(project.id, run.session, run.requestId))
      throw new ProjectControlError("Resume or cancel the other pending request in this transcript first.", 409);
    this.#setRun(project.id, run, actor, "running");
    this.#schedule(project, this.#session(project, run), actor);
    return this.#runView(this.#readRun(project.id, run.session, run.requestId));
  }

  async #cancel(project: ProjectRow, body: Json, actor: Actor) {
    const run = this.#runParts(body);
    if (this.#branch(project.id, run.session)) this.#requireOwner(actor);
    const row = this.#readRun(project.id, run.session, run.requestId);
    if (row.status === "running") {
      const active = this.#active.get(this.#sessionKey(project.id, run.session));
      if (!active || active.progress?.session !== run.session || active.progress.requestId !== run.requestId)
        throw new ProjectControlError("The running session could not be found. Refresh run status.", 409);
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

  #reviewHistory(project: string, session: string, requestId: string) {
    const rows = this.#all<Pick<RunReviewRow, "id" | "decision" | "reviewer" | "reviewed" | "note">>(`
      SELECT id, decision, reviewer, reviewed, note FROM run_reviews
      WHERE project = ? AND session = ? AND request_id = ? ORDER BY seq DESC LIMIT ?`,
      project, session, requestId, reviewHistoryLimit + 1);
    return {
      latestId: rows[0]?.id ?? null,
      entries: rows.slice(0, reviewHistoryLimit).map(({ id, decision, reviewer, reviewed, note }) => ({
        id, decision, reviewer, reviewed, ...(note !== null ? { note } : {}),
      })),
      ...(rows.length > reviewHistoryLimit ? { hasEarlier: true } : {}),
    };
  }

  #review(project: ProjectRow, body: Json, actor: Actor, canWrite: () => boolean) {
    const run = this.#runParts(body);
    const row = this.#readRun(project.id, run.session, run.requestId);
    if (this.#sessionDeleting(project.id, run.session))
      throw new ProjectControlError("This transcript is being deleted.", 409);
    const decision = body.decision;
    if (row.status !== "done" || (decision !== "accepted" && decision !== "changes_requested"))
      throw new ProjectControlError("Choose a review decision for a finished result.", 409);
    const submission = reviewSubmission(body);
    if (!submission && row.review === decision && row.reviewer === actor.id) return this.#runView(row);
    const memberId = actor.memberId ?? null;
    const latestId = this.#get<{ id: string }>(`SELECT id FROM run_reviews
      WHERE project = ? AND session = ? AND request_id = ? ORDER BY seq DESC LIMIT 1`, project.id, run.session, run.requestId)?.id ?? null;
    if (submission) {
      const prior = this.#get<RunReviewRow>(`SELECT id, decision, reviewer, reviewed, note, session, request_id, expected_id, member_id
        FROM run_reviews WHERE project = ? AND id = ?`, project.id, submission.id);
      if (prior) {
        if (prior.session !== run.session || prior.request_id !== run.requestId || prior.decision !== decision ||
            prior.reviewer !== actor.id || prior.member_id !== memberId || prior.note !== submission.note || prior.expected_id !== submission.expected)
          throw new ProjectControlError("This review ID already belongs to a different review. Refresh before submitting.", 409);
        return this.#runView(row);
      }
      if (submission.expected !== latestId)
        throw new ProjectControlError("The review changed. Refresh the result before submitting your review.", 409);
    }
    const previous = Date.parse(row.reviewed ?? "");
    // Patch and GitHub approvals use this timestamp to bind the latest decision.
    const reviewed = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    if (this.#closing || !canWrite()) throw new ProjectControlError("Open a writable brain to save this review.", 403);
    this.#db.transaction(() => {
      this.#write(`INSERT INTO run_reviews(project, session, request_id, id, decision, reviewer, reviewed, note, expected_id, member_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, project.id, run.session, run.requestId, submission?.id ?? randomBytes(16).toString("hex"),
        decision, actor.id, reviewed, submission?.note ?? null, latestId, memberId);
      this.#write("UPDATE runs SET review = ?, reviewer = ?, reviewed = ? WHERE project = ? AND session = ? AND id = ?",
        decision, actor.id, reviewed, project.id, run.session, run.requestId);
      this.#audit(project.id, decision, actor.id, run.session, run.requestId);
    })();
    return this.#runView(this.#readRun(project.id, run.session, run.requestId));
  }

  #finishPatch(project: ProjectRow, row: RunRow, actor: Actor) {
    const applied = now();
    this.#db.transaction(() => {
      this.#write("UPDATE applied_patches SET status = 'applied', applied = ? WHERE project = ? AND session = ? AND request_id = ?",
        applied, project.id, row.session, row.id);
      this.#write("UPDATE runs SET updated = ? WHERE project = ? AND session = ? AND id = ?", applied, project.id, row.session, row.id);
      this.#audit(project.id, "patch_applied", actor.id, row.session, row.id);
    })();
    return applied;
  }

  #acceptedPatchRun(project: ProjectRow, run: { session: string; requestId: string }) {
    const row = this.#readRun(project.id, run.session, run.requestId);
    if (row.status !== "done" || row.review !== "accepted")
      throw new ProjectControlError("Accept the finished result before reviewing a patch.", 409);
    return row;
  }

  #requirePatchSlot(project: ProjectRow, session: string) {
    if (this.#sessionDeleting(project.id, session)) throw new ProjectControlError("This transcript is being deleted.", 409);
    if (this.#active.has(this.#sessionKey(project.id, session)))
      throw new ProjectControlError("Wait for the active request in this transcript before reviewing a patch.", 409);
  }

  async #patchProposals(project: ProjectRow, body: Json, actor: Actor) {
    this.#requireOwner(actor);
    const run = this.#runParts(body);
    this.#acceptedPatchRun(project, run);
    this.#requirePatchSlot(project, run.session);
    const saved = await getCodingSessionStatus({ ...this.#session(project, run), includeReceipt: true }, this.#dependencies(project, actor));
    const receipt = saved.request?.receipt;
    return { proposals: receipt?.status === "done" ? codingPatchProposals(receipt.text, JSON.parse(project.scopes) as string[]) : [] };
  }

  async #patch(project: ProjectRow, body: Json, actor: Actor, apply: boolean, canWrite: () => boolean) {
    this.#requireOwner(actor);
    const run = this.#runParts(body);
    const row = this.#acceptedPatchRun(project, run);
    this.#requirePatchSlot(project, run.session);
    const authorize = () => {
      if (this.#closing || !canWrite()) throw new ProjectControlError("Open a writable brain to apply the patch.", 403);
    };
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
          if (apply) authorize();
          return { id: prior.preview_id, files, applied: apply ? this.#finishPatch(project, row, actor) : null, reused: true };
        }
      }
      return await withPreparedPatch(workspace, scopes, diff, async (prepared) => {
        const files = prepared.files;
        const id = digest(JSON.stringify([1, project.id, row.session, row.id, row.reviewed, diffHash, files]));
        if (!apply) return { id, files, applied: null, reused: false };
        if (id !== approval) throw new ProjectControlError("The patch or worktree changed. Preview it again before applying.", 409);
        authorize();
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

  #finishDeletion(project: string, session: string, actor: string, automatic: boolean) {
    this.#db.transaction(() => {
      const family = `project = ? AND (session = ? OR session IN
        (SELECT session FROM conversation_branches WHERE project = ? AND parent_session = ?))`;
      const bindings = [project, session, project, session];
      if (automatic) this.#write(`INSERT OR IGNORE INTO expired_requests(project, session, id)
        SELECT project, session, id FROM runs WHERE ${family}`, ...bindings);
      for (const table of ["applied_patches", "github_branch_publications", "github_publications"]) {
        this.#write(`DELETE FROM ${table} WHERE project = ? AND session IN
          (SELECT session FROM conversation_branches WHERE project = ? AND parent_session = ?)`, project, project, session);
      }
      this.#write(`DELETE FROM runs WHERE ${family}`, ...bindings);
      this.#write("DELETE FROM conversation_branches WHERE project = ? AND parent_session = ?", project, session);
      this.#write("DELETE FROM session_deletions WHERE project = ? AND session = ?", project, session);
      this.#audit(project, automatic ? "session_expired" : "session_deleted", actor, session);
    })();
  }

  async #removeSession(project: string, session: string, actor: string, automatic: boolean) {
    const key = `${project}/${session}`;
    if (this.#active.has(key)) throw new ProjectControlError("Wait for this session to finish or cancel its run before deleting it.", 409);
    const deletion = this.#db.transaction(() => {
      const pending = this.#get<{ actor: string; automatic: number }>(
        "SELECT actor, automatic FROM session_deletions WHERE project = ? AND session = ?", project, session,
      );
      if (pending) return pending;
      this.#write("INSERT INTO session_deletions(project, session, actor, automatic) VALUES (?, ?, ?, ?)", project, session, actor, Number(automatic));
      this.#audit(project, "session_deletion_requested", actor, session);
      return { actor, automatic: Number(automatic) };
    })();
    const cancel = new AbortController();
    const promise = rm(this.#sessionDirectory(project, session), { recursive: true, force: true })
      .then(() => this.#finishDeletion(project, session, deletion.actor, Boolean(deletion.automatic)))
      .finally(() => this.#active.delete(key));
    this.#active.set(key, { cancel, promise });
    await promise;
  }

  async #deleteSession(project: ProjectRow, body: Json, actor: Actor) {
    this.#requireOwner(actor);
    const session = field(body, "session", 64);
    if (!sessionPattern.test(session) || body.confirm !== session)
      throw new ProjectControlError("Type the session name to confirm transcript deletion.");
    if (this.#branch(project.id, session)) throw new ProjectControlError("Delete the parent transcript to remove it and its alternative branches.", 409);
    await this.#removeSession(project.id, session, actor.id, false);
    return { session, deleted: true };
  }

  #retentionCandidates(project: string | null, session: string | null = null) {
    return this.#all<{ project: string; session: string }>(`
      SELECT runs.project, COALESCE(b.parent_session, runs.session) AS session FROM runs
      JOIN transcript_retention ON transcript_retention.project = runs.project
      LEFT JOIN conversation_branches b ON b.project = runs.project AND b.session = runs.session
      LEFT JOIN coding_evaluations ON coding_evaluations.project = runs.project
        AND coding_evaluations.session = runs.session AND coding_evaluations.request_id = runs.id
      WHERE (? IS NULL OR runs.project = ?) AND (? IS NULL OR COALESCE(b.parent_session, runs.session) = ?)
      GROUP BY runs.project, COALESCE(b.parent_session, runs.session)
      HAVING MAX(runs.status IN ('running', 'interrupted')) = 0
        AND MAX(julianday(MAX(runs.updated, COALESCE(runs.reviewed, runs.updated), COALESCE(coding_evaluations.reviewed, runs.updated))))
          <= julianday(?) - transcript_retention.days
        AND NOT EXISTS (SELECT 1 FROM applied_patches p
          LEFT JOIN conversation_branches pb ON pb.project = p.project AND pb.session = p.session
          WHERE p.project = runs.project AND p.status = 'prepared'
          AND COALESCE(pb.parent_session, p.session) = COALESCE(b.parent_session, runs.session))
        AND NOT EXISTS (SELECT 1 FROM conversation_branches recent WHERE recent.project = runs.project
          AND recent.parent_session = COALESCE(b.parent_session, runs.session) AND julianday(recent.created) > julianday(?) - transcript_retention.days)
      ORDER BY MAX(runs.updated), runs.project, session LIMIT ?
    `, project, project, session, session, now(), now(), retentionBatchSize);
  }

  async #expireTranscripts(projectId: string | null) {
    if (this.#closing || !this.#retentionAllowed()) return 0;
    let removed = 0;
    for (const { project, session } of this.#retentionCandidates(projectId)) {
      const row = this.#get<ProjectRow>("SELECT * FROM projects WHERE id = ?", project);
      if (!row) continue;
      try {
        const expired = await this.#withSession(row, { session }, async () => {
          if (this.#closing || !this.#retentionAllowed() || this.#active.has(`${project}/${session}`)
              || !this.#retentionCandidates(project, session).length) return false;
          await this.#removeSession(project, session, retentionActor, true);
          return true;
        });
        if (expired) removed++;
      } catch {
        log.warn("Coding transcript could not be expired. The server will retry the deletion.", { project, session });
      }
    }
    return removed;
  }

  #startRetentionSweep() {
    if (this.#retentionSweep || this.#closing) return;
    this.#retentionSweep = this.#expireTranscripts(null);
    void this.#retentionSweep.catch(() => log.warn("The coding transcript retention sweep failed. It will run again in an hour."))
      .finally(() => { this.#retentionSweep = undefined; });
  }

  #retentionSettings(project: string) {
    return { days: this.#get<{ days: number }>("SELECT days FROM transcript_retention WHERE project = ?", project)?.days ?? null,
      active: this.#retentionAllowed() };
  }

  async #deploymentCheck(project: ProjectRow, method: string, body: Json, actor: Actor, canWrite: () => boolean) {
    if (!actor.owner) throw new ProjectControlError("Deployment checks are available to the local okbrain operator.", 403);
    const worker = this.#dockerWorker;
    if (method === "GET") {
      const apiKey = codingCredential(project.provider, this.#dependencies(project, actor));
      return {
        worker: worker ? { mode: "docker", image: worker.image, network: worker.network } : { mode: "process" },
        retention: this.#retentionSettings(project.id),
        provider: project.provider,
        model: project.model,
        credential: apiKey ? (project.api_key ? "project" : "environment") : "missing",
        providerCheckBinding: apiKey && worker?.network !== "none" && canWrite() ? this.#providerCheckBinding(project, apiKey) : null,
      };
    }
    if (!canWrite()) throw new ProjectControlError("Open a writable brain to run the offline worker check.", 403);
    if (Object.keys(body).length) throw new ProjectControlError("The offline worker check uses the server's configured Docker worker. Send an empty object.");
    if (!worker) throw new ProjectControlError("Configure a Linux Docker worker to run the offline worker check.", 409);
    if (this.#workerCheckInFlight || this.#providerCheckInFlight)
      throw new ProjectControlError("A deployment check is in progress. Try again when it finishes.", 409);
    this.#workerCheckInFlight = true;
    try { return await runCodingWorkerCheck(worker); }
    finally { this.#workerCheckInFlight = false; }
  }

  #providerCheckBinding(project: ProjectRow, apiKey: string) {
    const worker = this.#dockerWorker;
    const settings = [project.id, project.provider, project.model, worker?.image, worker?.network, Boolean(project.api_key), apiKey];
    return createHmac("sha256", this.#providerCheckSecret).update(JSON.stringify(settings)).digest("hex");
  }

  async #providerCheck(project: ProjectRow, body: Json, actor: Actor, canWrite: () => boolean) {
    this.#requireOwner(actor);
    if (!canWrite()) throw new ProjectControlError("Open a writable brain to test the provider connection.", 403);
    const binding = body.binding;
    if (Object.keys(body).length !== 2 || body.approved !== true || typeof binding !== "string" ||
        binding.length !== 64 || !/^[a-f0-9]+$/.test(binding))
      throw new ProjectControlError("Confirm the configured provider and model before testing the connection.");
    if (this.#dockerWorker?.network === "none")
      throw new ProjectControlError("Choose a Docker worker network with provider access to test the connection.", 409);
    const apiKey = codingCredential(project.provider, this.#dependencies(project, actor));
    if (!apiKey) throw new ProjectControlError("Save a project credential or configure the local provider key first.", 409);
    if (!timingSafeEqual(Buffer.from(binding, "hex"), Buffer.from(this.#providerCheckBinding(project, apiKey), "hex")))
      throw new ProjectControlError("The provider settings changed. Reopen Deployment checks and confirm the current settings.", 409);
    if (this.#workerCheckInFlight || this.#providerCheckInFlight)
      throw new ProjectControlError("A deployment check is in progress. Try again when it finishes.", 409);

    const cancel = new AbortController();
    const deadline = AbortSignal.timeout(18_000);
    const signal = AbortSignal.any([cancel.signal, deadline]);
    this.#providerCheckInFlight = cancel;
    const { provider, model } = project;
    const input = { provider, model, apiKey };
    let code: ProviderDiagnosticCode;
    let httpStatus: number | undefined;
    try {
      const outcome = this.#providerCheckFetch
        ? await checkProviderModel(input, signal, this.#providerCheckFetch)
        : await launchProjectProviderCheck(input, { signal, docker: this.#dockerWorker, canLaunch: canWrite });
      ({ code, httpStatus } = outcome);
    } catch (error) {
      if (error instanceof ProjectProviderCheckDisallowed)
        throw new ProjectControlError("The brain mount changed or is read-only.", 403);
      code = deadline.aborted ? "timed-out" : "worker-unavailable";
    } finally {
      this.#providerCheckInFlight = undefined;
    }
    return {
      provider, model, worker: this.#dockerWorker ? "docker" : "process", network: this.#dockerWorker?.network ?? null,
      origin: this.#providerCheckFetch ? "fixture" : "worker", status: code === "ready" ? "passed" : "failed",
      code, ...(httpStatus === undefined ? {} : { httpStatus }), checkedAt: now(), message: providerCheckMessages[code],
    };
  }

  async #retention(project: ProjectRow, method: string, body: Json, actor: Actor) {
    this.#requireOwner(actor);
    if (method === "GET") return this.#retentionSettings(project.id);
    const days = body.days;
    if (days !== null && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365)) {
      throw new ProjectControlError("Choose 1–365 days or keep transcripts until you delete them.");
    }
    if (!this.#retentionAllowed()) throw new ProjectControlError("Automatic transcript retention is unavailable on this server.", 403);
    this.#db.transaction(() => {
      if (days === null) this.#write("DELETE FROM transcript_retention WHERE project = ?", project.id);
      else this.#write(`INSERT INTO transcript_retention(project, days) VALUES (?, ?)
        ON CONFLICT(project) DO UPDATE SET days = excluded.days`, project.id, days);
      this.#audit(project.id, days === null ? "retention_disabled" : "retention_enabled", actor.id);
    })();
    return { days, active: true, removed: days === null ? 0 : await this.#expireTranscripts(project.id) };
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

  #githubPublishToken(project: string) {
    return this.#get<{ token: string }>("SELECT token FROM github_pr_credentials WHERE project = ?", project)?.token ?? null;
  }

  #githubContentsToken(project: string) {
    return this.#get<{ token: string }>("SELECT token FROM github_contents_credentials WHERE project = ?", project)?.token ?? null;
  }

  async #checkGitHubRemote(project: ProjectRow, bound: GitHubRow) {
    const remotes = await githubRemotes(await this.#workspace(project));
    if (!remotes.some((remote) => remote.remote === bound.remote && remote.repository === bound.repository))
      throw new ProjectControlError("This Git remote changed. Reconnect it before continuing.", 409);
  }

  #publication(project: string, run: Pick<RunRow, "session" | "id">) {
    return this.#get<GitHubPublication>("SELECT * FROM github_publications WHERE project = ? AND session = ? AND request_id = ?",
      project, run.session, run.id);
  }

  #publicationView(row: GitHubPublication) {
    return {
      approval: row.approval, repository: row.repository, base: row.base, head: row.head, approvedAt: row.approved,
      receipt: row.pull_number === null ? null : {
        id: row.pull_id, number: row.pull_number, draft: Boolean(row.draft), apiRequestId: row.api_request_id,
        url: `${githubUrl(row.repository)}/pull/${row.pull_number}`, recordedAt: row.created,
      },
    };
  }

  #finishPublication(project: string, run: RunRow, actor: Actor, pull: GitHubPullReceipt, recovered: boolean) {
    this.#db.transaction(() => {
      const time = now();
      this.#write(`UPDATE github_publications SET created = ?, pull_id = ?, pull_number = ?, draft = ?, api_request_id = ?
        WHERE project = ? AND session = ? AND request_id = ?`,
      time, pull.id, pull.number, Number(pull.draft), pull.apiRequestId, project, run.session, run.id);
      this.#write("UPDATE runs SET updated = ? WHERE project = ? AND session = ? AND id = ?", time, project, run.session, run.id);
      this.#audit(project, recovered ? "github_pr_recovered" : "github_pr_created", actor.id, run.session, run.id);
    })();
    return this.#publicationView(this.#publication(project, run)!);
  }

  #publishedAlternativeCommits(project: ProjectRow, run: RunRow, repository: string, base: string, head: string) {
    if (!this.#branch(project.id, run.session)) return undefined;
    const published = this.#branchPublication(project.id, run);
    if (!published?.created || !published.commit_sha)
      throw new ProjectControlError("Publish the applied patch from this alternative run before preparing its GitHub review.", 409);
    if (published.repository !== repository || published.base !== base || published.head !== head)
      throw new ProjectControlError("Use the GitHub repository and branches recorded for this alternative run.", 409);
    return { baseCommit: published.base_sha, headCommit: published.commit_sha };
  }

  async #verifyAlternativeHead(project: ProjectRow, repository: string, head: string, expectedCommit: string) {
    const token = this.#githubContentsToken(project.id);
    if (!token) throw new ProjectControlError("Restore the branch publishing token to verify this alternative's GitHub commit.", 409);
    if (await githubBranchRef(repository, head, token, this.#githubFetch) !== expectedCommit)
      throw new ProjectControlError("The published head no longer points to this alternative's recorded commit. Review the branch on GitHub.", 409);
  }

  async #publishGitHub(project: ProjectRow, run: RunRow, bound: GitHubRow, action: string, body: Json, actor: Actor, authorize: () => void) {
    const saved = this.#publication(project.id, run);
    const currentBinding = this.#get<GitHubRow>("SELECT remote, repository, token FROM github_projects WHERE project = ?", project.id);
    if (currentBinding?.remote !== bound.remote || currentBinding.repository !== bound.repository)
      throw new ProjectControlError("The GitHub connection changed. Review the preview again.", 409);
    const token = this.#githubPublishToken(project.id);
    if (!token) throw new ProjectControlError("Set a separate GitHub pull request publishing token first.", 409);
    if (action === "github-pr-recover") {
      if (!saved) throw new ProjectControlError("Confirm the pull request preview before attempting recovery.", 409);
      if (saved.repository !== bound.repository) throw new ProjectControlError("Reconnect the approved repository to recover this pull request.", 409);
      if (saved.pull_number !== null) return this.#publicationView(saved);
      const expectedHead = this.#publishedAlternativeCommits(project, run, saved.repository, saved.base, saved.head)?.headCommit;
      const found = await githubFindPull(saved.repository, saved.base, saved.head, saved.approval, token, this.#githubFetch, expectedHead);
      if (found.pull) authorize();
      return found.pull ? this.#finishPublication(project.id, run, actor, found.pull, true) : this.#publicationView(saved);
    }

    const draft = githubPullDraft(body);
    const commits = this.#publishedAlternativeCommits(project, run, bound.repository, draft.base, draft.head);
    const expectedHead = commits?.headCommit;
    const approval = digest(JSON.stringify([1, project.id, bound.repository, run.session, run.id, run.signature, run.reviewed, draft,
      ...(expectedHead ? [expectedHead] : []),
    ]));
    const approvedDraft = { ...draft, body: githubPullBody(draft.body, approval) };
    if (action === "github-pr-preview") {
      if (expectedHead) await this.#verifyAlternativeHead(project, bound.repository, draft.head, expectedHead);
      const comparison = commits ? githubCommitComparison(bound.repository, commits.baseCommit, commits.headCommit)
        : githubComparison(bound.repository, draft.base, draft.head);
      return { approval, repository: bound.repository, ...approvedDraft, comparison, ...commits,
      };
    }
    if (body.approved !== true || body.approval !== approval)
      throw new ProjectControlError("Review the exact pull request and confirm creation again.", 409);
    if (saved && saved.approval !== approval)
      throw new ProjectControlError("This run already has a different publishing approval. Recover its receipt or retry the original approval.", 409);
    if (saved?.pull_number != null) return this.#publicationView(saved);

    const found = await githubFindPull(bound.repository, draft.base, draft.head, approval, token, this.#githubFetch, expectedHead);
    if (found.pull) {
      if (!saved) throw new ProjectControlError("GitHub already has a pull request with this receipt marker. Review it before continuing.", 409);
      authorize();
      return this.#finishPublication(project.id, run, actor, found.pull, true);
    }
    if (found.existing)
      throw new ProjectControlError("An open pull request already uses those branches. Review it on GitHub.", 409);

    await this.#checkGitHubRemote(project, bound);
    if (expectedHead) await this.#verifyAlternativeHead(project, bound.repository, draft.head, expectedHead);
    const current = this.#get<GitHubRow>("SELECT remote, repository, token FROM github_projects WHERE project = ?", project.id);
    if (current?.remote !== bound.remote || current.repository !== bound.repository || this.#githubPublishToken(project.id) !== token)
      throw new ProjectControlError("The GitHub connection or publishing token changed. Review the preview again.", 409);
    authorize();
    if (!saved) this.#db.transaction(() => {
      const time = now();
      this.#write(`INSERT INTO github_publications(project, session, request_id, approval, repository, base, head, approved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, project.id, run.session, run.id, approval, bound.repository, draft.base, draft.head, time);
      this.#write("UPDATE runs SET updated = ? WHERE project = ? AND session = ? AND id = ?", time, project.id, run.session, run.id);
      this.#audit(project.id, "github_pr_approved", actor.id, run.session, run.id);
    })();
    const pull = await githubCreatePull(bound.repository, approvedDraft, token, this.#githubFetch, expectedHead);
    return this.#finishPublication(project.id, run, actor, pull, false);
  }

  #branchPublication(project: string, run: RunIdentity) {
    return this.#get<GitHubBranchPublication>(
      "SELECT * FROM github_branch_publications WHERE project = ? AND session = ? AND request_id = ?", project, run.session, run.id,
    );
  }

  #branchView(row: GitHubBranchPublication) {
    const { approval, repository, base, head, base_sha: baseSha, commit_sha: commitSha, created } = row;
    return {
      approval, repository, base, head, baseSha,
      receipt: created && commitSha ? { url: `${githubUrl(repository)}/tree/${encodeURIComponent(head)}`,
        head, base, commitSha, recordedAt: created } : null,
    };
  }

  #finishBranch(project: string, run: RunIdentity, actor: Actor, recovered: boolean) {
    this.#db.transaction(() => {
      const time = now();
      this.#write("UPDATE github_branch_publications SET created = ? WHERE project = ? AND session = ? AND request_id = ?",
        time, project, run.session, run.id);
      this.#write("UPDATE runs SET updated = ? WHERE project = ? AND session = ? AND id = ?", time, project, run.session, run.id);
      this.#audit(project, recovered ? "github_branch_recovered" : "github_branch_created", actor.id, run.session, run.id);
    })();
    return this.#branchView(this.#branchPublication(project, run)!);
  }

  async #verifyBranchConnection(project: ProjectRow, bound: GitHubRow, token: string) {
    await this.#checkGitHubRemote(project, bound);
    const current = this.#get<GitHubRow>("SELECT remote, repository, token FROM github_projects WHERE project = ?", project.id);
    if (current?.remote !== bound.remote || current.repository !== bound.repository || this.#githubContentsToken(project.id) !== token)
      throw new ProjectControlError("The GitHub connection or branch publishing token changed. Review the branch preview again.", 409);
  }

  async #githubPatchBranch(project: ProjectRow, bound: GitHubRow | null, action: string, body: Json, actor: Actor, authorize: () => void) {
    this.#requireOwner(actor);
    const request = this.#runParts(body);
    const runId = { session: request.session, id: request.requestId };
    if (branchSessionPattern.test(runId.session)) this.#readRun(project.id, runId.session, runId.id);
    const saved = this.#branchPublication(project.id, runId);
    if (action === "github-branch-inspect") return saved ? this.#branchView(saved) : null;
    this.#requirePatchSlot(project, runId.session);
    if (!bound) throw new ProjectControlError("Connect a local GitHub remote for this project first.", 409);
    if (saved && saved.repository !== bound.repository)
      throw new ProjectControlError("Reconnect the approved repository to recover this branch.", 409);
    const token = this.#githubContentsToken(project.id);
    if (!token) throw new ProjectControlError("Set a separate GitHub branch publishing token with Contents write access first.", 409);
    const deadline = AbortSignal.timeout(55_000);
    await this.#verifyBranchConnection(project, bound, token);
    const transport: GitHubFetch = (url, options) => this.#githubFetch(url, {
      ...options, signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
    });
    const repository = bound.repository;
    const remoteHead = async (head: string, expected: string | null) => {
      const actual = await githubBranchRef(repository, head, token, transport);
      if (actual && actual !== expected)
        throw new ProjectControlError("That head branch already exists or now points to a different commit. Choose a new branch.", 409);
      return actual;
    };
    const createRef = async (head: string, commitSha: string) => {
      await this.#verifyBranchConnection(project, bound, token);
      authorize();
      await githubCreatePatchRef(repository, head, commitSha, token, transport);
      return this.#finishBranch(project.id, runId, actor, false);
    };
    if (action === "github-branch-recover") {
      if (!saved) throw new ProjectControlError("Confirm a branch preview before attempting recovery.", 409);
      if (saved.created || !saved.commit_sha) return this.#branchView(saved);
      if (!await remoteHead(saved.head, saved.commit_sha)) return this.#branchView(saved);
      authorize();
      return this.#finishBranch(project.id, runId, actor, true);
    }

    const run = this.#readRun(project.id, runId.session, runId.id);
    if (run.status !== "done" || run.review !== "accepted")
      throw new ProjectControlError("Accept the coding request in Review before publishing its patch.", 409);
    const patch = this.#get<PatchRow>("SELECT * FROM applied_patches WHERE project = ? AND session = ? AND request_id = ?",
      project.id, run.session, run.id);
    if (patch?.status !== "applied")
      throw new ProjectControlError("Apply the approved patch to the worktree before preparing a GitHub branch.", 409);
    const base = githubBranch(body.base);
    const head = githubBranch(body.head);
    if (base === head) throw new ProjectControlError("Choose a new branch with a different name from the base.");
    const message = field(body, "message", 512);
    if (/[\x00-\x1f\x7f]/u.test(message)) throw new ProjectControlError("Enter a single-line commit message.");
    const approvalOf = (baseSha: string, baseTree: string) => digest(JSON.stringify([
      1, project.id, repository, run.session, run.id, run.signature, run.reviewed, patch.preview_id, base, head, message, baseSha, baseTree,
    ]));
    const preview = action === "github-branch-preview";
    if (!preview && (body.approved !== true || typeof body.approval !== "string" || !/^[a-f0-9]{64}$/u.test(body.approval)))
      throw new ProjectControlError("Review the exact branch and confirm publication again.", 409);
    if (saved?.commit_sha && saved.approval !== approvalOf(saved.base_sha, saved.base_tree))
      throw new ProjectControlError("This run already has a different branch approval. Recover the saved branch or retry its original details.", 409);
    if (!preview && saved?.commit_sha) {
      if (body.approval !== saved.approval)
        throw new ProjectControlError("Review the exact branch and confirm publication again.", 409);
      if (saved.created) return this.#branchView(saved);
      if (await remoteHead(saved.head, saved.commit_sha)) {
        authorize();
        return this.#finishBranch(project.id, runId, actor, true);
      }
      // A prior attempt saved the exact commit before trying to expose the ref.
      return createRef(saved.head, saved.commit_sha);
    }

    const files = await approvedPatchFiles(await this.#workspace(project), JSON.parse(project.scopes) as string[],
      JSON.parse(patch.files) as PatchFileReceipt[]);
    const { baseSha, baseTree } = await githubPreparePatchBranch(repository, base, files, token, transport);
    const approval = approvalOf(baseSha, baseTree);
    if (saved?.commit_sha && saved.approval !== approval)
      throw new ProjectControlError("The base moved after the approved commit was saved. Recover the saved branch.", 409);
    await remoteHead(head, saved?.commit_sha ?? null);
    if (preview) return { approval, repository, base, head, baseSha, message, files: files.map(({ bytes, ...file }) => ({
      ...file, content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    })) };
    if (body.approval !== approval)
      throw new ProjectControlError("The GitHub base, patch, or requested branch changed. Preview it again before publishing.", 409);

    await this.#verifyBranchConnection(project, bound, token);
    authorize();
    if (saved?.approval !== approval) this.#db.transaction(() => {
      // Until a commit is saved, no create-ref request can have been sent.
      this.#write(`INSERT INTO github_branch_publications(project, session, request_id, approval, repository, base, head, base_sha, base_tree)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, session, request_id) DO UPDATE SET
          approval = excluded.approval, base = excluded.base, head = excluded.head,
          base_sha = excluded.base_sha, base_tree = excluded.base_tree`,
      project.id, run.session, run.id, approval, repository, base, head, baseSha, baseTree);
      this.#write("UPDATE runs SET updated = ? WHERE project = ? AND session = ? AND id = ?", now(), project.id, run.session, run.id);
      this.#audit(project.id, "github_branch_approved", actor.id, run.session, run.id);
    })();
    const commitSha = await githubCreatePatchCommit(repository, { baseSha, baseTree, message, files }, token, transport);
    this.#write("UPDATE github_branch_publications SET commit_sha = ? WHERE project = ? AND session = ? AND request_id = ?",
      commitSha, project.id, run.session, run.id);
    return createRef(head, commitSha);
  }

  async #github(project: ProjectRow, action: string, method: string, body: Json, actor: Actor, canWrite: () => boolean) {
    const authorize = () => {
      if (this.#closing || !canWrite()) throw new ProjectControlError("Open a writable brain to update the GitHub review.", 403);
    };
    const bound = this.#get<GitHubRow>("SELECT remote, repository, token FROM github_projects WHERE project = ?", project.id);
    const status = (row: GitHubRow | null) => ({
      canConfigure: actor.owner,
      connection: row ? {
        remote: row.remote, repository: row.repository, url: githubUrl(row.repository), hasToken: row.token !== null,
        ...(actor.owner ? {
          hasPublishToken: this.#githubPublishToken(project.id) !== null,
          hasContentsToken: this.#githubContentsToken(project.id) !== null,
        } : {}),
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
          const latest = this.#get<GitHubRow>("SELECT remote, repository, token FROM github_projects WHERE project = ?", project.id);
          if (option.repository === latest?.repository && token
              && [this.#githubPublishToken(project.id), this.#githubContentsToken(project.id)].includes(token))
            throw new ProjectControlError("Use different GitHub activity and publishing tokens.");
          this.#write(`INSERT INTO github_projects VALUES (?, ?, ?, ?)
            ON CONFLICT(project) DO UPDATE SET remote = excluded.remote, repository = excluded.repository, token = excluded.token`,
          project.id, option.remote, option.repository, token);
          if (latest && latest.repository !== option.repository) {
            this.#write("DELETE FROM github_pr_credentials WHERE project = ?", project.id);
            this.#write("DELETE FROM github_contents_credentials WHERE project = ?", project.id);
          }
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
      if (method === "POST" && (action === "github-pr-credential" || action === "github-branch-credential")) {
        this.#requireOwner(actor);
        if (!bound) throw new ProjectControlError("Connect a local GitHub remote for this project first.", 409);
        const token = githubToken(body.token);
        const isBranch = action === "github-branch-credential";
        const table = isBranch ? "github_contents_credentials" : "github_pr_credentials";
        const auditKind = isBranch ? "github_contents_token" : "github_pr_token";
        await this.#checkGitHubRemote(project, bound);
        const current = this.#get<GitHubRow>("SELECT remote, repository, token FROM github_projects WHERE project = ?", project.id);
        if (current?.remote !== bound.remote || current.repository !== bound.repository || current.token !== bound.token)
          throw new ProjectControlError("The GitHub connection changed. Refresh it before saving the publishing token.", 409);
        this.#db.transaction(() => {
          const other = isBranch ? this.#githubPublishToken(project.id) : this.#githubContentsToken(project.id);
          if (token && (token === bound.token || token === other))
            throw new ProjectControlError("Use separate GitHub tokens for activity, branch publication, and pull requests.");
          if (token) this.#write(`INSERT INTO ${table} VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET token = excluded.token`, project.id, token);
          else this.#write(`DELETE FROM ${table} WHERE project = ?`, project.id);
          this.#audit(project.id, token ? `${auditKind}_saved` : `${auditKind}_removed`, actor.id);
        })();
        return status(bound);
      }
      if (method === "POST" && githubBranchActions.includes(action))
        return await this.#githubPatchBranch(project, bound, action, body, actor, authorize);
      if (method === "POST" && githubPullActions.includes(action)) {
        this.#requireOwner(actor);
        const request = this.#runParts(body);
        if (action === "github-pr-inspect") {
          if (branchSessionPattern.test(request.session)) this.#readRun(project.id, request.session, request.requestId);
          const saved = this.#publication(project.id, { session: request.session, id: request.requestId });
          return saved ? this.#publicationView(saved) : null;
        }
        if (!bound) throw new ProjectControlError("Connect a local GitHub remote for this project first.", 409);
        await this.#checkGitHubRemote(project, bound);
        const run = this.#readRun(project.id, request.session, request.requestId);
        if (run.status !== "done" || run.review !== "accepted")
          throw new ProjectControlError("Accept the coding request in Review before publishing a GitHub pull request.", 409);
        this.#requirePatchSlot(project, run.session);
        return await this.#publishGitHub(project, run, bound, action, body, actor, authorize);
      }
      if (method === "POST" && action === "github-issue") {
        if (Object.keys(body).length !== 1) throw new GitHubError("Enter a positive integer GitHub issue number.");
        const number = githubIssueNumber(body.number);
        if (!bound) throw new ProjectControlError("Connect a local GitHub remote for this project first.", 409);
        const checkConnection = async () => {
          await this.#checkGitHubRemote(project, bound);
          const current = this.#get<GitHubRow>("SELECT remote, repository, token FROM github_projects WHERE project = ?", project.id);
          if (current?.remote !== bound.remote || current.repository !== bound.repository || current.token !== bound.token)
            throw new ProjectControlError("The GitHub connection changed. Refresh the issue preview.", 409);
        };
        await checkConnection();
        const issue = await githubIssue(bound.repository, number, bound.token, this.#githubFetch);
        await checkConnection();
        return issue;
      }
      if ((method === "GET" && action === "github-activity") || (method === "POST" && action === "github-handoff")) {
        if (!bound) throw new ProjectControlError("Connect a local GitHub remote for this project first.", 409);
        await this.#checkGitHubRemote(project, bound);
        if (action === "github-activity") return await githubActivity(bound.repository, bound.token, this.#githubFetch);
        const request = this.#runParts(body);
        const run = this.#readRun(project.id, request.session, request.requestId);
        if (run.status !== "done" || run.review !== "accepted")
          throw new ProjectControlError("Accept the coding request in Review before preparing a GitHub handoff.", 409);
        const base = githubBranch(body.base);
        const head = githubBranch(body.head);
        const commits = this.#publishedAlternativeCommits(project, run, bound.repository, base, head);
        const url = commits ? githubCommitComparison(bound.repository, commits.baseCommit, commits.headCommit)
          : githubComparison(bound.repository, base, head);
        this.#audit(project.id, "github_handoff", actor.id, run.session, run.id);
        return { url, repository: bound.repository, session: run.session, requestId: run.id };
      }
    } catch (error) {
      if (error instanceof GitHubError) throw new ProjectControlError(error.message, error.status);
      if (error instanceof ApprovedPatchError) throw new ProjectControlError(error.message, 409);
      throw error;
    }
    throw new ProjectControlError("GitHub endpoint not found.", 404);
  }

  #withSession<T>(project: ProjectRow, body: Json, action: () => Promise<T>): Promise<T> {
    const session = field(body, "session", 64);
    if (!sessionPattern.test(session)) throw new ProjectControlError("Enter a valid lowercase session name.");
    const key = this.#sessionKey(project.id, session);
    const result = (this.#gates.get(key) ?? Promise.resolve()).then(action);
    const gate = result.then(() => {}, () => {});
    this.#gates.set(key, gate);
    return result.finally(() => { if (this.#gates.get(key) === gate) this.#gates.delete(key); });
  }

  dispatch(
    method: string, path: string, body: Json, localOwner: boolean, token: string | null, readonly: boolean,
    canWrite: () => boolean = () => !readonly,
  ): Promise<unknown> {
    if (this.#closing) throw new ProjectControlError("The coding server is shutting down.", 409);
    const request = this.#dispatch(method, path, body, localOwner, token, readonly, canWrite).catch((error: unknown) => {
      if (error instanceof CodingEvaluationError) throw new ProjectControlError(error.message, error.status);
      if (error instanceof PinnedEvaluationWorkspaceError) throw new ProjectControlError(error.message, 409);
      throw error;
    });
    this.#requests.add(request);
    return request.finally(() => { this.#requests.delete(request); });
  }

  async #dispatch(
    method: string, path: string, body: Json, localOwner: boolean, token: string | null, readonly: boolean,
    canWrite: () => boolean,
  ): Promise<unknown> {
    const actor = this.#identity(localOwner, token);
    if (path === "/models" && method === "GET") return listCodingModels(this.#models);
    if (path === "/projects" && method === "GET") {
      const projects = actor.owner ? this.#all<ProjectRow>("SELECT * FROM projects ORDER BY created DESC") : [this.#project(actor.project!, actor)];
      return projects.map((row) => this.#projectView(row, actor));
    }
    if (method === "POST" && readonly && !path.endsWith("/preview") && !path.endsWith("/inspect") &&
        !path.endsWith("/evaluation-inspect") && !path.endsWith("/source-inspect") && !path.endsWith("/branch-comparison-inspect") &&
        !path.endsWith("/github-issue"))
      throw new ProjectControlError("This server is attached to a read-only brain mount.", 403);
    if (path === "/projects" && method === "POST") return this.#addProject(body, actor);
    const match = /^\/projects\/([a-f0-9-]{36})\/([a-z-]+)$/.exec(path);
    if (!match) throw new ProjectControlError("Coding endpoint not found.", 404);
    const project = this.#project(match[1]!, actor);
    const action = match[2];
    if (action === "deployment-check" && (method === "GET" || method === "POST"))
      return this.#deploymentCheck(project, method, body, actor, canWrite);
    if (action === "provider-check" && method === "POST") return this.#providerCheck(project, body, actor, canWrite);
    if (action === "retention" && (method === "GET" || method === "POST")) return this.#retention(project, method, body, actor);
    if (action === "presets" && (method === "GET" || method === "POST")) return this.#presets(project, method, body, actor);
    if (action && method === "POST" && (githubPullActions.includes(action) || githubBranchActions.includes(action)))
      return this.#withSession(project, body, () => this.#github(project, action, method, body, actor, canWrite));
    if (action?.startsWith("github-")) return this.#github(project, action, method, body, actor, canWrite);
    if (method === "GET") {
      if (action === "evaluation-rubric") return pinnedEvaluationRubric;
      if (action === "evaluations") return { provider: project.provider, model: project.model, ...this.#evaluations.report(project.id, actor.id) };
      if (action === "runs") return this.#all<RunRow>("SELECT * FROM runs WHERE project = ? ORDER BY updated DESC LIMIT 200", project.id).map((row) => this.#runView(row));
      if (action === "audit") return this.#all<AuditRow>("SELECT kind, actor, session, request_id, at FROM audit WHERE project = ? ORDER BY seq DESC LIMIT 200", project.id);
      if (action === "members") return this.#members(project, method, body, actor);
      if (action === "branches") {
        this.#requireOwner(actor);
        return this.#all<BranchRow>("SELECT * FROM conversation_branches WHERE project = ? ORDER BY created DESC LIMIT 200", project.id)
          .map((branch) => this.#conversationBranchView(branch));
      }
    }
    if (method === "POST") {
      if (action === "preview") return typeof body.session === "string" && branchSessionPattern.test(body.session)
        ? this.#withSession(project, body, () => this.#preview(project, body, actor)) : this.#preview(project, body, actor);
      if (action === "branches-preview" || action === "branches")
        return this.#withSession(project, body, () => this.#changeBranch(project, body, actor, action === "branches-preview", canWrite));
      if (action === "evaluation-inspect" || action === "evaluation-review")
        return this.#withSession(project, body, () => this.#evaluate(project, body, actor, action === "evaluation-review"));
      if (action === "run") return this.#withSession(project, body, () => this.#start(project, body, actor, canWrite));
      if (action === "inspect") return this.#withSession(project, body, async () => {
        const inspected = await this.#inspect(project, body, actor, canWrite);
        return { ...inspected, reviewHistory: this.#reviewHistory(project.id, inspected.run.session, inspected.run.id) };
      });
      if (action === "source-inspect") return this.#withSession(project, body, () => this.#sourceInspect(project, body, actor));
      if (action === "branch-comparison-inspect") return this.#withSession(project, body, () => this.#compareBranch(project, body, actor));
      if (action === "reset-context-preview" || action === "reset-context" || action === "compact-context-preview" || action === "compact-context") {
        this.#requireOwner(actor);
        return this.#withSession(project, body, () => this.#changeContext(project, body, actor,
          action.startsWith("compact-"), action.endsWith("-preview"), canWrite));
      }
      if (action === "resume") return this.#withSession(project, body, () => this.#resume(project, body, actor));
      if (action === "cancel") return this.#withSession(project, body, () => this.#cancel(project, body, actor));
      if (action === "review") return this.#withSession(project, body, async () => {
        const currentActor = this.#identity(localOwner, token);
        return this.#review(this.#project(project.id, currentActor), body, currentActor, canWrite);
      });
      if (action === "patch-proposals") return this.#withSession(project, body, () => this.#patchProposals(project, body, actor));
      if (action === "patch-preview" || action === "patch-apply")
        return this.#withSession(project, body, () => this.#patch(project, body, actor, action === "patch-apply", canWrite));
      if (action === "delete-session") return this.#withSession(project, body, () => this.#deleteSession(project, body, actor));
      if (action === "credential") return this.#credentials(project, body, actor);
      if (action === "members") return this.#members(project, method, body, actor);
    }
    throw new ProjectControlError("Coding endpoint not found.", 404);
  }
}
