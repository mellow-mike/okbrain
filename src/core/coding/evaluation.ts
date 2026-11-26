import type { Usage } from "@earendil-works/pi-ai";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { pinnedEvaluationTask } from "./evaluation-rubric.ts";
import { profilePath } from "./project-profile.ts";
import { excludedPath, type RepositoryContextOptions } from "./repository-context.ts";

const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
type Tokens = Pick<Usage, typeof tokenFields[number]>;
export type EvaluationStrategy = "files" | "lexical" | "indexed" | "packages" | "atlas";
type Origin = "provider" | "injected";
type Decision = "accepted" | "changes_requested";
export interface EvidenceTarget {
  path: string;
  startLine: number;
  endLine: number;
}
export interface EvaluationSource extends EvidenceTarget { content: string }
export interface EvaluationInput { task: string; sources: EvaluationSource[] }
export interface EvaluationCase { series: string; task: string; evidence: EvidenceTarget[] }

type Attempt = { project: string; session: string; requestId: string };
type Stored = {
  session: string; request_id: string; series: string; task: string; evidence: string;
  strategy: EvaluationStrategy; origin: Origin; preview_ms: number | null;
  preview_id: string; reviewer: string | null; decision: Decision | null; verified: string | null;
  reviewed: string | null; usage: string | null; source_bytes: number | null; actor: string; status: string;
};

export class CodingEvaluationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value))
    throw new CodingEvaluationError(`Use a 1–64 character lowercase evaluation ${field} ID with letters, digits, periods, underscores, or hyphens.`);
  return value;
}

function evidenceTarget(value: unknown, scopes: string[]): EvidenceTarget {
  const match = typeof value === "string" && Buffer.byteLength(value) <= 1024
    ? /^(.+):([1-9][0-9]{0,6})(?:-([1-9][0-9]{0,6}))?$/u.exec(value.trim())
    : null;
  const path = match && profilePath(match[1]!);
  const startLine = Number(match?.[2]);
  const endLine = Number(match?.[3] ?? startLine);
  if (!path || path === "." || startLine > endLine)
    throw new CodingEvaluationError("Enter each evidence target as a workspace-relative path with a line or inclusive range, such as src/index.ts:12-15.");
  if (excludedPath(path) || !scopes.some((scope) => scope === "." || path.startsWith(`${scope}/`)))
    throw new CodingEvaluationError("Choose evidence files within this project's permitted directories.", 403);
  return { path, startLine, endLine };
}

/** Evaluation metadata is deliberately separate from the model input. */
export function parseEvaluation(value: unknown, scopes: string[]): EvaluationCase | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodingEvaluationError("Choose an evaluation series, task, and evidence targets.");
  const { series, task, evidence } = value as Record<string, unknown>;
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 24)
    throw new CodingEvaluationError("Enter between 1 and 24 expected evidence targets.");
  const targets = evidence.map((target) => evidenceTarget(target, scopes))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine || a.endLine - b.endLine);
  if (new Set(targets.map(({ path, startLine, endLine }) => `${path}:${startLine}-${endLine}`)).size !== targets.length)
    throw new CodingEvaluationError("List each evidence target once.");
  return { series: identifier(series, "series"), task: identifier(task, "task"), evidence: targets };
}

function samePaths(actual: readonly string[] | undefined, expected: readonly string[]) {
  return JSON.stringify([...(actual ?? [])].sort()) === JSON.stringify([...expected].sort());
}

/** Reserve the published series for the exact task, evidence, and retrieval recipe. */
export function pinnedEvaluationBinding(evaluation: EvaluationCase | undefined, prompt: string | undefined,
  selection: { files?: string[]; repository?: Omit<RepositoryContextOptions, "workspace"> }, approvedSourceLookup: boolean): string | undefined {
  if (!evaluation?.series.startsWith("pinned-vite-")) return;
  const pin = pinnedEvaluationTask(evaluation.series, evaluation.task);
  if (!pin) throw new CodingEvaluationError("Load a published case from Pinned Vite benchmark, or choose another series ID.", 409);
  const { study, task } = pin;
  const expected = parseEvaluation({ series: study.series, task: task.id, evidence: task.evidence }, ["."]);
  if (prompt !== task.prompt || JSON.stringify(evaluation.evidence) !== JSON.stringify(expected?.evidence)) {
    throw new CodingEvaluationError("Reload the pinned case to restore its exact task and citations, or choose another series ID.", 409);
  }
  const repository = selection.repository;
  const profile = repository?.profile;
  const canonicalSource = selection.files
    ? JSON.stringify(selection.files) === JSON.stringify(task.files)
    : repository?.query === task.query && (profile
      ? samePaths(profile.projects, task.projects) && samePaths(profile.sharedProjects, task.sharedProjects) &&
        profile.tokenBudget === study.tokenBudget && !profile.guidance && !profile.exclude?.length
      : samePaths(repository.projects, [...new Set([...task.projects, ...task.sharedProjects])]) && repository.tokenBudget === study.tokenBudget);
  if (!canonicalSource || approvedSourceLookup) {
    throw new CodingEvaluationError("Use a published source strategy for this pinned case, or choose another series ID.", 409);
  }
  return JSON.stringify([study.series, task.id]);
}

export function evaluationInput(content: string): EvaluationInput | undefined {
  try {
    const saved = JSON.parse(content) as {
      task?: unknown;
      excerpts?: EvaluationSource[];
      files?: Array<Pick<EvaluationSource, "path" | "content">>;
    } | null;
    if (typeof saved?.task !== "string") return;
    if (Array.isArray(saved.excerpts)) return { task: saved.task, sources: saved.excerpts };
    if (Array.isArray(saved.files)) {
      return {
        task: saved.task,
        sources: saved.files.map(({ path, content }) => ({
          path, content, startLine: 1, endLine: content.split("\n").length - Number(content.endsWith("\n")),
        })),
      };
    }
  } catch {
    // Older transcripts may carry a different user message shape.
  }
}

function reviewable(status: string) { return status === "done" || status === "unanswered"; }

function canReview(row: Stored, actor: string) {
  return reviewable(row.status) && row.actor.toLowerCase() !== actor.toLowerCase()
    && (row.reviewer === null || row.reviewer === actor);
}

function view(row: Stored, actor: string) {
  return {
    session: row.session, requestId: row.request_id, series: row.series, task: row.task,
    evidence: JSON.parse(row.evidence) as EvidenceTarget[], strategy: row.strategy, origin: row.origin,
    previewMs: row.preview_ms, previewId: row.preview_id, submitter: row.actor, status: row.status,
    canReview: canReview(row, actor), reviewer: row.reviewer, decision: row.decision,
    verified: row.verified ? JSON.parse(row.verified) as number[] : [],
    reviewedAt: row.reviewed, usage: row.usage ? JSON.parse(row.usage) as Tokens : null, sourceBytes: row.source_bytes,
  };
}

export function presentEvidence(evidence: EvidenceTarget[], sources: EvaluationSource[]): number[] {
  return evidence.flatMap(({ path, startLine, endLine }, index) => sources.some((source) =>
    path === source.path && startLine >= source.startLine && endLine <= source.endLine) ? [index] : []);
}

function usageTokens(usage: Usage | undefined): Tokens | null {
  if (!usage || tokenFields.some((key) => !Number.isFinite(usage[key]) || usage[key] < 0)) return null;
  const { input, output, cacheRead, cacheWrite, totalTokens } = usage;
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1]!;
}

function summarize(attempts: ReturnType<typeof view>[]) {
  const groups = new Map<string, ReturnType<typeof view>[]>();
  for (const attempt of attempts) {
    const key = JSON.stringify([attempt.series, attempt.strategy, attempt.origin]);
    const group = groups.get(key);
    if (group) group.push(attempt);
    else groups.set(key, [attempt]);
  }
  return Array.from(groups.values(), (group) => {
    const { series, strategy, origin } = group[0]!;
    const reviewed = group.filter(({ decision }) => decision !== null);
    const accepted = reviewed.filter(({ decision }) => decision === "accepted").length;
    const measured = reviewed.flatMap(({ usage }) => usage ? [usage] : []);
    const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    for (const usage of measured) for (const key of tokenFields) tokens[key] += usage[key];
    const previewTimes = group.flatMap(({ previewMs }) => previewMs === null ? [] : [previewMs]);
    const knownSource = reviewed.flatMap(({ sourceBytes }) => sourceBytes === null ? [] : [sourceBytes]);
    return {
      series, strategy, origin, attempts: group.length, cases: new Set(group.map((attempt) => attempt.task)).size,
      reviewed: reviewed.length, accepted,
      usageRecorded: measured.length, tokens, previewCount: previewTimes.length,
      previewP50: percentile(previewTimes, 0.5), previewP95: percentile(previewTimes, 0.95),
      meanSourceBytes: knownSource.length ? Math.round(knownSource.reduce((sum, bytes) => sum + bytes, 0) / knownSource.length) : null,
      evidenceVerified: reviewed.reduce((count, attempt) => count + attempt.verified.length, 0),
      evidenceExpected: reviewed.reduce((count, attempt) => count + attempt.evidence.length, 0),
      tokensPerAccepted: accepted && measured.length === reviewed.length ? Math.round(tokens.totalTokens / accepted) : null,
    };
  });
}

/** Lives in the coding catalog and follows the lifetime of each transcript. */
export class CodingEvaluations {
  readonly #previews = new Map<string, { milliseconds: number; observedAt: number }>();

  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coding_evaluations (
        project TEXT NOT NULL, session TEXT NOT NULL, request_id TEXT NOT NULL,
        series TEXT NOT NULL, task TEXT NOT NULL, definition TEXT NOT NULL, evidence TEXT NOT NULL,
        strategy TEXT NOT NULL, origin TEXT NOT NULL, preview_id TEXT NOT NULL, preview_ms INTEGER,
        reviewer TEXT, decision TEXT, verified TEXT, reviewed TEXT, usage TEXT, source_bytes INTEGER,
        PRIMARY KEY (project, session, request_id),
        FOREIGN KEY (project, session, request_id) REFERENCES runs(project, session, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS coding_evaluations_series ON coding_evaluations(project, series, task);
    `);
  }

  preview(project: string, actor: string, id: string, milliseconds: number, binding?: string) {
    const key = JSON.stringify([project, actor, id, binding]);
    this.#previews.delete(key);
    this.#previews.set(key, { milliseconds: Math.round(milliseconds), observedAt: Date.now() });
    if (this.#previews.size > 200) this.#previews.delete(this.#previews.keys().next().value!);
  }

  enroll(attempt: Attempt, actor: string, evaluation: EvaluationCase | undefined, prompt: string,
    strategy: EvaluationStrategy, origin: Origin, previewId: string, binding?: string) {
    const { project, session, requestId } = attempt;
    using remove = this.db.prepare("DELETE FROM coding_evaluations WHERE project = ? AND session = ? AND request_id = ?");
    remove.run(project, session, requestId);
    if (!evaluation) return;
    const { series, task, evidence } = evaluation;
    const definition = createHash("sha256").update(JSON.stringify([prompt, evidence])).digest("hex");
    using prior = this.db.prepare<{ definition: string }, [string, string, string]>(
      "SELECT definition FROM coding_evaluations WHERE project = ? AND series = ? AND task = ? LIMIT 1",
    );
    const existing = prior.get(project, series, task);
    if (existing && existing.definition !== definition)
      throw new CodingEvaluationError("This series and task ID already use a different prompt or evidence list. Use a new task ID.", 409);
    const previewKey = JSON.stringify([project, actor, previewId, binding]);
    const preview = this.#previews.get(previewKey);
    const previewMs = preview && Date.now() - preview.observedAt <= 15 * 60_000 ? preview.milliseconds : null;
    if (binding && previewMs === null) throw new CodingEvaluationError("Preview the pinned case again before sending this trial.", 409);
    using insert = this.db.prepare(`
      INSERT INTO coding_evaluations(project, session, request_id, series, task, definition, evidence, strategy, origin, preview_id, preview_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(project, session, requestId, series, task, definition, JSON.stringify(evidence), strategy, origin, previewId, previewMs);
    this.#previews.delete(previewKey);
  }

  #get({ project, session, requestId }: Attempt): Stored | null {
    using statement = this.db.prepare<Stored, [string, string, string]>(`
      SELECT e.*, r.actor, r.status FROM coding_evaluations e
      JOIN runs r ON r.project = e.project AND r.session = e.session AND r.id = e.request_id
      WHERE e.project = ? AND e.session = ? AND e.request_id = ?
    `);
    return statement.get(project, session, requestId);
  }

  get(attempt: Attempt, actor: string) {
    const row = this.#get(attempt);
    return row && view(row, actor);
  }

  report(project: string, actor: string) {
    using statement = this.db.prepare<Stored, [string]>(`
      SELECT e.*, r.actor, r.status FROM coding_evaluations e
      JOIN runs r ON r.project = e.project AND r.session = e.session AND r.id = e.request_id
      WHERE e.project = ? ORDER BY r.updated DESC, r.id LIMIT 201
    `);
    const rows = statement.all(project);
    const attempts = rows.slice(0, 200).map((row) => view(row, actor));
    return { attempts, groups: summarize(attempts), truncated: rows.length > attempts.length };
  }

  save(attempt: Attempt, actor: string, choice: unknown, checked: unknown, admitted: EvaluationSource[], usage: Usage | undefined) {
    const row = this.#get(attempt);
    if (!row) throw new CodingEvaluationError("This request was not enrolled in an evaluation.", 404);
    if (!canReview(row, actor))
      throw new CodingEvaluationError("An independent project member can evaluate a finished run. An existing evaluation belongs to its reviewer.", 403);
    if (choice !== "accepted" && choice !== "changes_requested")
      throw new CodingEvaluationError("Select an evaluation decision.");
    const evidence = view(row, actor).evidence;
    const present = new Set(presentEvidence(evidence, admitted));
    if (!Array.isArray(checked) || checked.length > evidence.length ||
      checked.some((index) => !Number.isInteger(index) || !present.has(index)))
      throw new CodingEvaluationError("Verify only targets covered by the saved source preview.");
    const verified = [...new Set(checked as number[])].sort((a, b) => a - b);
    if (choice === "accepted" && (row.status !== "done" || verified.length !== evidence.length))
      throw new CodingEvaluationError("Accept a complete result after verifying all expected citations.");
    const verifiedJson = JSON.stringify(verified);
    if (row.decision === choice && row.verified === verifiedJson) return { result: view(row, actor), changed: false };
    const { project, session, requestId } = attempt;
    const recorded = usageTokens(usage);
    using update = this.db.prepare(`
      UPDATE coding_evaluations SET reviewer = ?, decision = ?, verified = ?, reviewed = ?, usage = ?, source_bytes = ?
      WHERE project = ? AND session = ? AND request_id = ?
    `);
    update.run(actor, choice, verifiedJson, new Date().toISOString(), recorded ? JSON.stringify(recorded) : null,
      Buffer.byteLength(JSON.stringify(admitted)), project, session, requestId);
    return { result: view(this.#get(attempt)!, actor), changed: true };
  }
}
