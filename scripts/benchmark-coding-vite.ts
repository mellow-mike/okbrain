import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { previewCodingAttachments } from "../src/core/coding/durable.ts";
import { maxProfileTokens, type CodingProjectProfile } from "../src/core/coding/project-profile.ts";
import { selectRepositoryContext } from "../src/core/coding/repository-context.ts";

const repository = "https://github.com/vitejs/vite.git";
const tag = "v7.0.0";
const revision = "b85f32275b443bf6b647572a9209f1e078b5b4dd";

interface Scope {
  projects: string[];
  sharedProjects: string[];
}

interface Task extends Scope {
  id: string;
  description: string;
  query: string;
  narrow: Scope;
  expected: { path: string; text: string }[];
}

// Evidence targets are tied to the fixture revision. Each task needs both its
// implementation and its nearby contract, regression test, or collaborating code.
const tasks: Task[] = [
  {
    id: "preload-error",
    description: "Trace how a failed dynamic import becomes a cancelable preload error.",
    query: "dynamic import preloadError preventDefault",
    projects: ["packages/vite"],
    sharedProjects: ["docs/guide"],
    narrow: { projects: ["packages/vite/src/node/plugins"], sharedProjects: ["docs/guide"] },
    expected: [
      { path: "packages/vite/src/node/plugins/importAnalysisBuild.ts", text: "new Event('vite:preloadError'" },
      { path: "docs/guide/build.md", text: "Vite emits `vite:preloadError` event" },
    ],
  },
  {
    id: "scaffold-template",
    description: "Trace how create-vite chooses a template and handles an existing target directory.",
    query: "scaffold create vite template overwrite targetDir",
    projects: ["packages/create-vite"],
    sharedProjects: ["docs/guide"],
    narrow: { projects: ["packages/create-vite"], sharedProjects: [] },
    expected: [
      { path: "packages/create-vite/src/index.ts", text: "emptyDir(targetDir)" },
      { path: "packages/create-vite/README.md", text: "npm create vite@latest my-vue-app -- --template vue" },
    ],
  },
  {
    id: "plugin-legacy-target",
    description: "Trace how the legacy plugin overrides modern build targets.",
    query: "plugin legacy modernTargets build target browserslist",
    projects: ["packages/plugin-legacy"],
    sharedProjects: ["packages/vite", "docs/config"],
    narrow: { projects: ["packages/plugin-legacy"], sharedProjects: [] },
    expected: [
      { path: "packages/plugin-legacy/src/index.ts", text: "config.build.target = browserslistToEsbuild(options.modernTargets)" },
      { path: "packages/plugin-legacy/src/types.ts", text: "modernTargets?: string | string[]" },
      { path: "packages/plugin-legacy/README.md", text: "### `modernTargets`" },
    ],
  },
  {
    id: "hmr-lifecycle",
    description: "Trace browser HMR before-update events through the shared listener registry.",
    query: "hmr beforeUpdate notifyListeners update callback",
    projects: ["packages/vite"],
    sharedProjects: ["docs/guide"],
    narrow: { projects: ["packages/vite/src/client", "packages/vite/src/shared"], sharedProjects: ["docs/guide"] },
    expected: [
      { path: "packages/vite/src/client/client.ts", text: "hmrClient.notifyListeners('vite:beforeUpdate', payload)" },
      { path: "packages/vite/src/shared/hmr.ts", text: "this.customListenersMap.get(event)" },
      { path: "docs/guide/api-hmr.md", text: "when an update is about to be applied" },
    ],
  },
  {
    id: "split-css-manifest",
    description: "Trace how the build manifest reports CSS for an asynchronous entry.",
    query: "manifest async entry css importedCss code split",
    projects: ["packages/vite"],
    sharedProjects: ["docs/guide", "playground/css-codesplit"],
    narrow: { projects: ["packages/vite/src/node/plugins"], sharedProjects: ["docs/guide", "playground/css-codesplit/__tests__"] },
    expected: [
      { path: "packages/vite/src/node/plugins/manifest.ts", text: "manifestChunk.css = [...chunk.viteMetadata.importedCss]" },
      { path: "playground/css-codesplit/__tests__/css-codesplit.spec.ts", text: "expect(manifest['other.js'].css.length).toBe(1)" },
      { path: "docs/guide/backend-integration.md", text: "a `.vite/manifest.json` file will be generated" },
    ],
  },
  {
    id: "dependency-scan",
    description: "Trace how explicit entries replace inferred dependency optimizer scan inputs.",
    query: "optimizeDeps entries explicit dependency scan inputs",
    projects: ["packages/vite"],
    sharedProjects: ["docs/config"],
    narrow: { projects: ["packages/vite/src/node/optimizer"], sharedProjects: ["docs/config"] },
    expected: [
      { path: "packages/vite/src/node/optimizer/scan.ts", text: "const explicitEntryPatterns = environment.config.optimizeDeps.entries" },
      { path: "docs/config/dep-optimization-options.md", text: "This will overwrite default entries inference." },
    ],
  },
];

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

async function preview(workspace: string, task: Task, strategy: Strategy, scope: Scope, tokenBudget: number): Promise<Preview> {
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
  if (git(workspace, "rev-parse", "HEAD").trim() !== revision)
    throw new Error(`Use Vite ${tag} at ${revision}.`);
  if (git(workspace, "status", "--porcelain", "--untracked-files=no"))
    throw new Error("Use a clean Vite worktree to benchmark the pinned evidence.");
  const evaluationSeries = `vite-${revision.slice(0, 7)}-${narrow ? "subsystem" : "package"}-${tokenBudget}`;
  const evaluationCases = new Map<string, { prompt: string; evidence: string[] }>();
  for (const task of tasks) {
    const evidence: string[] = [];
    for (const expected of task.expected) {
      const content = await readFile(join(workspace, expected.path), "utf8");
      const index = content.indexOf(expected.text);
      if (index < 0) throw new Error(`Missing pinned evidence for ${task.id}: ${expected.path}`);
      const start = content.slice(0, index).split("\n").length;
      const end = start + expected.text.split("\n").length - 1;
      evidence.push(`${expected.path}:${start}${start === end ? "" : "-" + end}`);
    }
    evaluationCases.set(task.id, { prompt: task.description + " Cite supporting source by file path and line range.", evidence });
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
    tasks: tasks.map((task) => ({
      id: task.id, description: task.description, query: task.query,
      projects: (narrow ? task.narrow : task).projects,
      sharedProjects: (narrow ? task.narrow : task).sharedProjects,
      expectedFiles: task.expected.map(({ path }) => path),
      evaluation: evaluationCases.get(task.id),
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
