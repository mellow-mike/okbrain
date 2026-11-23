import { realpath } from "node:fs/promises";
import { runGit } from "../sync.ts";
import { previewCodingAttachments } from "./durable.ts";
import {
  pinnedEvaluationRubric, pinnedViteBenchmarkTasks, verifyPinnedEvaluationWorkspace,
  type PinnedEvaluationStudy, type ViteBenchmarkTask,
} from "./evaluation-rubric.ts";
import { maxProfileTokens, type CodingProjectProfile } from "./project-profile.ts";
import { selectRepositoryContext } from "./repository-context.ts";

export type ViteRetrievalStudy = PinnedEvaluationStudy["id"];
type Scope = Pick<ViteBenchmarkTask, "projects" | "sharedProjects">;
const strategies = ["explicit", "lexical", "indexed"] as const;
type Strategy = typeof strategies[number];
const { repository, tag, revision } = pinnedEvaluationRubric;

export interface PinnedViteRetrievalOptions {
  workspace: string;
  study: ViteRetrievalStudy;
  repetitions: number;
  tokenBudget: number;
  allowedScopes?: readonly string[];
  signal?: AbortSignal;
  progress?: (completed: number, total: number) => void;
}

export class RetrievalBenchmarkError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409) { super(message); }
}

interface Preview {
  files: { path: string; content: string }[];
  estimatedTokens?: number;
  limited: string[];
}

interface Measurement {
  task: string;
  ms: number;
  paths: string[];
  evidence: string[];
  expected: number;
  bytes: number;
  estimatedTokens?: number;
  limited: string[];
}

function studyOf(id: ViteRetrievalStudy): PinnedEvaluationStudy {
  const study = pinnedEvaluationRubric.studies.find((entry) => entry.id === id);
  if (!study) throw new RetrievalBenchmarkError("Choose a pinned Vite retrieval study.", 400);
  return study;
}

/** Check all fixed recipe roots and explicitly read evidence paths before opening the checkout. */
export function requirePinnedViteRetrievalScope(study: ViteRetrievalStudy, allowedScopes: readonly string[]): void {
  const required = studyOf(study).tasks.flatMap(({ projects, sharedProjects, files }) => [...projects, ...sharedProjects, ...files]);
  if (!required.every((path) => allowedScopes.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`))))
    throw new RetrievalBenchmarkError("This project's source scope does not cover the pinned Vite study.", 403);
}

async function preview(
  workspace: string, task: ViteBenchmarkTask, strategy: Strategy, scope: Scope, tokenBudget: number,
): Promise<Preview> {
  const allowed = [...scope.projects, ...scope.sharedProjects];
  if (strategy === "explicit") {
    const result = await previewCodingAttachments(workspace, task.expected.map(({ path }) => path), allowed);
    return { files: result.files, limited: [] };
  }
  const profile: CodingProjectProfile = { version: 1, name: task.id, projects: scope.projects, sharedProjects: scope.sharedProjects };
  const args = strategy === "indexed" ? { profile } : { projects: allowed };
  const { excerpts, manifest } = await selectRepositoryContext({ workspace, query: task.query, tokenBudget, ...args });
  return {
    files: excerpts,
    estimatedTokens: manifest.estimatedTokens,
    limited: Object.entries(manifest.limitsReached).filter(([, reached]) => reached).map(([name]) => name),
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1]!.toFixed(2));
}

function summarize(results: Measurement[]) {
  const sum = (measure: (value: Measurement) => number) => results.reduce((total, result) => total + measure(result), 0);
  const expected = sum((value) => value.expected);
  const relevant = sum((value) => value.paths.length);
  const exact = sum((value) => value.evidence.length);
  return {
    samples: results.length,
    firstPreviewMs: Number(results[0]!.ms.toFixed(2)),
    p50PreviewMs: percentile(results.map(({ ms }) => ms), 0.5),
    p95PreviewMs: percentile(results.map(({ ms }) => ms), 0.95),
    relevantFiles: relevant,
    exactEvidence: exact,
    expectedEvidence: expected,
    fileRecall: Number((relevant / expected).toFixed(3)),
    evidenceRecall: Number((exact / expected).toFixed(3)),
    completeTasks: results.filter((value) => value.evidence.length === value.expected).length,
    meanContextBytes: Math.round(sum(({ bytes }) => bytes) / results.length),
    meanEstimatedExcerptTokens: results.every(({ estimatedTokens }) => estimatedTokens !== undefined) ?
      Math.round(sum(({ estimatedTokens }) => estimatedTokens!) / results.length) : null,
    cappedPreviews: results.filter(({ limited }) => limited.length).length,
  };
}

function byStrategy<T>(measure: (strategy: Strategy) => T): Record<Strategy, T> {
  return { explicit: measure("explicit"), lexical: measure("lexical"), indexed: measure("indexed") };
}

async function trackedPathCount(workspace: string, signal?: AbortSignal): Promise<number> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(process.env)) if (name.toUpperCase().startsWith("GIT_")) env[name] = undefined;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0" });
  try {
    const result = await runGit(workspace, ["-c", "core.fsmonitor=false", "ls-files", "-z"], undefined, env, signal);
    if (result.code === 0 && result.stdout.endsWith("\0")) return result.stdout.split("\0").length - 1;
  } catch { /* Keep local paths and Git output out of benchmark failures. */ }
  signal?.throwIfAborted();
  throw new RetrievalBenchmarkError("Could not count the tracked files in the pinned Vite workspace.", 409);
}

/** Measure the shipping retrieval strategies. Reports carry evidence paths, timing, and sizes only. */
export async function measurePinnedViteRetrieval(options: PinnedViteRetrievalOptions) {
  const { repetitions, tokenBudget, signal, progress, allowedScopes } = options;
  const study = studyOf(options.study);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 50)
    throw new RetrievalBenchmarkError("Choose an integer from 1 to 50 repetitions.", 400);
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > maxProfileTokens)
    throw new RetrievalBenchmarkError(`Choose an integer token budget from 1 to ${maxProfileTokens}.`, 400);
  if (allowedScopes !== undefined) requirePinnedViteRetrievalScope(study.id, allowedScopes);
  signal?.throwIfAborted();
  const workspace = await realpath(options.workspace).catch(() => undefined);
  if (!workspace) throw new RetrievalBenchmarkError("Choose an existing pinned Vite workspace.", 409);
  const verifyWorkspace = async () => {
    signal?.throwIfAborted();
    try { await verifyPinnedEvaluationWorkspace(workspace, revision, signal); }
    catch (error) { signal?.throwIfAborted(); throw error; }
    signal?.throwIfAborted();
  };
  await verifyWorkspace();
  const scopeOf = (task: ViteBenchmarkTask) => study.id === "subsystem" ? task.narrow : task;
  const tasks = pinnedViteBenchmarkTasks;
  for (const task of tasks) {
    signal?.throwIfAborted();
    const { projects, sharedProjects } = scopeOf(task);
    const { files } = await previewCodingAttachments(workspace, task.expected.map(({ path }) => path), [...projects, ...sharedProjects]);
    for (const { path, line, text } of task.expected) {
      const source = files.find((file) => file.path === path)?.content ?? "";
      const offset = source.indexOf(text);
      if (offset < 0 || source.slice(0, offset).split("\n").length !== line)
        throw new RetrievalBenchmarkError(`Missing pinned evidence for ${task.id}: ${path}:${line}`, 409);
    }
  }

  const measured = byStrategy<Measurement[]>(() => []);
  const total = repetitions * tasks.length * strategies.length;
  let completed = 0;
  progress?.(completed, total);
  for (let round = 0; round < repetitions; round++) {
    for (const [index, task] of tasks.entries()) {
      for (let offset = 0; offset < strategies.length; offset++) {
        signal?.throwIfAborted();
        const strategy = strategies[(round + index + offset) % strategies.length]!;
        const started = performance.now();
        const { files, estimatedTokens, limited } = await preview(workspace, task, strategy, scopeOf(task), tokenBudget);
        const ms = performance.now() - started;
        signal?.throwIfAborted();
        measured[strategy].push({
          task: task.id, ms, estimatedTokens, limited, expected: task.expected.length,
          paths: task.expected.filter(({ path }) => files.some((file) => file.path === path)).map(({ path }) => path),
          evidence: task.expected.filter(({ path, text }) =>
            files.some((file) => file.path === path && file.content.includes(text))).map(({ path }) => path),
          bytes: Buffer.byteLength(JSON.stringify(files)),
        });
        completed++;
        progress?.(completed, total);
      }
    }
  }
  const trackedPaths = await trackedPathCount(workspace, signal);
  await verifyWorkspace();
  return {
    repository, tag, revision,
    evaluationSeries: `vite-${revision.slice(0, 7)}-${study.id}-${tokenBudget}`,
    trackedPaths,
    repetitions, tokenBudget, scope: study.id === "subsystem" ? "subsystem directories" : "package directories",
    accounting: "Real repository previews with pinned evidence. Explicit paths are an oracle with advance knowledge. No model or human acceptance measurements.",
    strategies: byStrategy((strategy) => summarize(measured[strategy])),
    tasks: study.tasks.map((task) => ({
      id: task.id, description: task.description, query: task.query,
      projects: task.projects, sharedProjects: task.sharedProjects, expectedFiles: task.files,
      evaluation: { prompt: task.prompt, evidence: task.evidence },
      results: byStrategy((strategy) => {
        const results = measured[strategy].filter((result) => result.task === task.id);
        const retrieved = results[0]!;
        return {
          ...summarize(results), firstRetrievedFiles: retrieved.paths, firstExactEvidence: retrieved.evidence, firstLimits: retrieved.limited,
        };
      }),
    })),
  };
}

export type BenchmarkReport = Awaited<ReturnType<typeof measurePinnedViteRetrieval>>;
