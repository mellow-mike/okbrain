import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { previewCodingAttachments } from "../src/core/coding/durable.ts";
import { pinnedEvaluationRubric, pinnedViteBenchmarkTasks as tasks, verifyPinnedEvaluationWorkspace,
  type ViteBenchmarkTask } from "../src/core/coding/evaluation-rubric.ts";
import { maxProfileTokens, type CodingProjectProfile } from "../src/core/coding/project-profile.ts";
import { selectRepositoryContext } from "../src/core/coding/repository-context.ts";

const { repository, tag, revision } = pinnedEvaluationRubric;
type Scope = Pick<ViteBenchmarkTask, "projects" | "sharedProjects">;

const strategies = ["explicit", "lexical", "indexed"] as const;
type Strategy = typeof strategies[number];
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

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdin: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Git command failed.");
  return result.stdout.toString();
}

async function preview(workspace: string, task: ViteBenchmarkTask, strategy: Strategy, scope: Scope, tokenBudget: number): Promise<Preview> {
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

function report(results: Measurement[]) {
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

async function benchmark(workspace: string, repetitions: number, tokenBudget: number, narrow: boolean) {
  await verifyPinnedEvaluationWorkspace(workspace);
  const study = pinnedEvaluationRubric.studies.find(({ id }) => id === (narrow ? "subsystem" : "package"))!;
  const evaluationSeries = `vite-${revision.slice(0, 7)}-${study.id}-${tokenBudget}`;
  for (const task of tasks) {
    for (const { path, line, text } of task.expected) {
      const source = await readFile(join(workspace, path), "utf8");
      const offset = source.indexOf(text);
      if (offset < 0 || source.slice(0, offset).split("\n").length !== line) {
        throw new Error(`Missing pinned evidence for ${task.id}: ${path}:${line}`);
      }
    }
  }
  const measured: Record<Strategy, Measurement[]> = { explicit: [], lexical: [], indexed: [] };
  for (let round = 0; round < repetitions; round++) {
    for (const [index, task] of tasks.entries()) {
      for (let offset = 0; offset < strategies.length; offset++) {
        const strategy = strategies[(round + index + offset) % strategies.length]!;
        const started = performance.now();
        const { files, estimatedTokens, limited } = await preview(workspace, task, strategy, narrow ? task.narrow : task, tokenBudget);
        const ms = performance.now() - started;
        measured[strategy].push({
          task: task.id, ms, estimatedTokens, limited, expected: task.expected.length,
          paths: task.expected.filter(({ path }) => files.some((file) => file.path === path)).map(({ path }) => path),
          evidence: task.expected.filter(({ path, text }) =>
            files.some((file) => file.path === path && file.content.includes(text))).map(({ path }) => path),
          bytes: Buffer.byteLength(JSON.stringify(files)),
        });
      }
    }
  }

  console.log(JSON.stringify({
    repository, tag, revision,
    evaluationSeries,
    runtime: { platform: platform(), arch: arch(), bun: Bun.version, cpu: cpus()[0]?.model },
    trackedPaths: git(workspace, "ls-files", "-z").split("\0").length - 1,
    repetitions, tokenBudget, scope: narrow ? "subsystem directories" : "package directories",
    accounting: "Real repository previews with pinned evidence. Explicit paths are an oracle with advance knowledge. No model or human acceptance measurements.",
    strategies: Object.fromEntries(strategies.map((strategy) => [strategy, report(measured[strategy])])),
    tasks: study.tasks.map((task) => ({
      id: task.id, description: task.description, query: task.query,
      projects: task.projects, sharedProjects: task.sharedProjects, expectedFiles: task.files,
      evaluation: { prompt: task.prompt, evidence: task.evidence },
      results: Object.fromEntries(strategies.map((strategy) => {
        const results = measured[strategy].filter((result) => result.task === task.id);
        const retrieved = results[0]!;
        return [strategy, {
          ...report(results), firstRetrievedFiles: retrieved.paths, firstExactEvidence: retrieved.evidence, firstLimits: retrieved.limited,
        }];
      })),
    })),
  }, null, 2));
}

const { values: args } = parseArgs({ options: {
  workspace: { type: "string" },
  repetitions: { type: "string", default: "8" },
  "token-budget": { type: "string", default: "4096" },
  narrow: { type: "boolean", default: false },
} });
const repetitions = Number(args.repetitions);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 50)
  throw new Error("Use --repetitions with an integer from 1 to 50.");
const tokenBudget = Number(args["token-budget"]);
if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > maxProfileTokens)
  throw new Error(`Use --token-budget with an integer from 1 to ${maxProfileTokens}.`);
const root = await mkdtemp(join(tmpdir(), "okb-vite-benchmark-"));
try {
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.LOCALAPPDATA = join(root, "data");
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = join(root, "empty-git-config");
  await writeFile(process.env.GIT_CONFIG_GLOBAL, "");
  const hooks = join(root, "empty-hooks");
  await mkdir(hooks);
  const workspace = args.workspace ? await realpath(args.workspace) : join(root, "worktree");
  if (!args.workspace) {
    git(root, "-c", `core.hooksPath=${hooks}`, "clone", "--quiet", "--depth=1", "--single-branch", "--branch", tag, repository, workspace);
  }
  await benchmark(workspace, repetitions, tokenBudget, args.narrow);
} finally {
  await rm(root, { recursive: true, force: true });
}
