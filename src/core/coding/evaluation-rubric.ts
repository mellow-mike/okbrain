import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";

export const pinnedViteRevision = "b85f32275b443bf6b647572a9209f1e078b5b4dd";
const repositorySlug = "vitejs/vite";
const repository = `https://github.com/${repositorySlug}.git`;
const tag = "v7.0.0";

export const pinnedEvaluationCheckout = { origin: repository, repository: repositorySlug, tag, commit: pinnedViteRevision } as const;

type Scope = { projects: string[]; sharedProjects: string[] };
export interface ViteBenchmarkTask extends Scope {
  id: string;
  description: string;
  query: string;
  narrow: Scope;
  expected: { path: string; line: number; text: string }[];
}

// Each anchor is checked against the pinned source by the benchmark. The app exposes only citation locations.
export const pinnedViteBenchmarkTasks: readonly ViteBenchmarkTask[] = [
  {
    id: "preload-error",
    description: "Trace how a failed dynamic import becomes a cancelable preload error.",
    query: "dynamic import preloadError preventDefault",
    projects: ["packages/vite"],
    sharedProjects: ["docs/guide"],
    narrow: { projects: ["packages/vite/src/node/plugins"], sharedProjects: ["docs/guide"] },
    expected: [
      { path: "packages/vite/src/node/plugins/importAnalysisBuild.ts", line: 159, text: "new Event('vite:preloadError'" },
      { path: "docs/guide/build.md", line: 73, text: "Vite emits `vite:preloadError` event" },
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
      { path: "packages/create-vite/src/index.ts", line: 404, text: "emptyDir(targetDir)" },
      { path: "packages/create-vite/README.md", line: 38, text: "npm create vite@latest my-vue-app -- --template vue" },
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
      { path: "packages/plugin-legacy/src/index.ts", line: 241, text: "config.build.target = browserslistToEsbuild(options.modernTargets)" },
      { path: "packages/plugin-legacy/src/types.ts", line: 9, text: "modernTargets?: string | string[]" },
      { path: "packages/plugin-legacy/README.md", line: 49, text: "### `modernTargets`" },
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
      { path: "packages/vite/src/client/client.ts", line: 177, text: "hmrClient.notifyListeners('vite:beforeUpdate', payload)" },
      { path: "packages/vite/src/shared/hmr.ts", line: 191, text: "this.customListenersMap.get(event)" },
      { path: "docs/guide/api-hmr.md", line: 208, text: "when an update is about to be applied" },
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
      { path: "packages/vite/src/node/plugins/manifest.ts", line: 113, text: "manifestChunk.css = [...chunk.viteMetadata.importedCss]" },
      { path: "playground/css-codesplit/__tests__/css-codesplit.spec.ts", line: 63, text: "expect(manifest['other.js'].css.length).toBe(1)" },
      { path: "docs/guide/backend-integration.md", line: 65, text: "a `.vite/manifest.json` file will be generated" },
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
      { path: "packages/vite/src/node/optimizer/scan.ts", line: 227, text: "const explicitEntryPatterns = environment.config.optimizeDeps.entries" },
      { path: "docs/config/dep-optimization-options.md", line: 13, text: "This will overwrite default entries inference." },
    ],
  },
];

export interface PinnedEvaluationTask extends Scope {
  id: string;
  description: string;
  prompt: string;
  evidence: string[];
  query: string;
  files: string[];
}

export interface PinnedEvaluationStudy {
  id: "package" | "subsystem";
  label: string;
  series: string;
  tokenBudget: number;
  tasks: PinnedEvaluationTask[];
}

export interface PinnedEvaluationRubric {
  version: 1;
  repository: string;
  revision: string;
  tag: string;
  studies: PinnedEvaluationStudy[];
}

function study(id: PinnedEvaluationStudy["id"], label: string, tokenBudget: number): PinnedEvaluationStudy {
  return {
    id, label, tokenBudget, series: `pinned-vite-${pinnedViteRevision.slice(0, 7)}-${id}-${tokenBudget}`,
    tasks: pinnedViteBenchmarkTasks.map((task) => {
      const { projects, sharedProjects } = id === "subsystem" ? task.narrow : task;
      return {
        id: task.id, description: task.description, query: task.query,
        prompt: task.description + " Cite supporting source by file path and line range.",
        projects: [...projects], sharedProjects: [...sharedProjects],
        evidence: task.expected.map(({ path, line }) => `${path}:${line}`),
        files: [...new Set(task.expected.map(({ path }) => path))],
      };
    }),
  };
}

export const pinnedEvaluationRubric: PinnedEvaluationRubric = {
  version: 1, repository, tag, revision: pinnedViteRevision,
  studies: [study("package", "Package directories · 4,096 tokens", 4096), study("subsystem", "Subsystem directories · 12,288 tokens", 12288)],
};

export function pinnedEvaluationTask(series: string, taskId: string): { study: PinnedEvaluationStudy; task: PinnedEvaluationTask } | undefined {
  const study = pinnedEvaluationRubric.studies.find((entry) => entry.series === series);
  const task = study?.tasks.find((entry) => entry.id === taskId);
  if (study && task) return { study, task };
}

export class PinnedEvaluationWorkspaceError extends Error { readonly status = 409; }

const execGit = promisify(execFile);
const commitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const indexEntry = /^H (?:100644|100755|120000) [0-9a-f]{40}(?:[0-9a-f]{24})? 0\t/u;

/** Verify a fixed Git checkout using local reads, including index flags that can hide tracked edits. */
export async function verifyPinnedEvaluationWorkspace(workspace: string, revision = pinnedViteRevision, signal?: AbortSignal): Promise<void> {
  if (!commitId.test(revision)) throw new PinnedEvaluationWorkspaceError("The evaluation needs a full Git commit ID.");
  try {
    const cwd = await realpath(workspace);
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "",
      GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
    };
    const git = async (...args: string[]) => (await execGit("git", ["-c", "core.fsmonitor=false", "-c", "core.trustctime=true",
      "-c", "core.checkStat=default", ...args], { cwd, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10_000, signal })).stdout;
    const root = await realpath((await git("rev-parse", "--show-toplevel")).replace(/\r?\n$/u, ""));
    if (relative(cwd, root) !== "") throw new PinnedEvaluationWorkspaceError("Register the repository root to use the pinned evaluation study.");
    if ((await git("rev-parse", "--verify", "HEAD^{commit}")).trim() !== revision) {
      throw new PinnedEvaluationWorkspaceError(`Check out commit ${revision} to use the pinned evaluation study.`);
    }
    const filters = await git("config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$").catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 1) return "";
      throw error;
    });
    if (filters) throw new PinnedEvaluationWorkspaceError("Use a checkout without external Git clean filters for the pinned evaluation study.");
    const index = await git("ls-files", "--stage", "-v", "-z", "--");
    if (!index.endsWith("\0") || index.slice(0, -1).split("\0").some((entry) => !indexEntry.test(entry))) {
      throw new PinnedEvaluationWorkspaceError("Use a complete checkout without hidden or unresolved index entries for the pinned evaluation study.");
    }
    if (await git("status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none")) {
      throw new PinnedEvaluationWorkspaceError("Use a clean tracked worktree and index for the pinned evaluation study.");
    }
  } catch (error) {
    if (error instanceof PinnedEvaluationWorkspaceError) throw error;
    throw new PinnedEvaluationWorkspaceError("Could not check the pinned Git checkout. Open the repository root and verify that Git can read it.");
  }
}
