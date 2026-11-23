import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvaluation } from "../src/core/coding/evaluation.ts";
import {
  pinnedEvaluationRubric, pinnedEvaluationTask, pinnedViteRevision, verifyPinnedEvaluationWorkspace,
} from "../src/core/coding/evaluation-rubric.ts";

test("the bundled Vite studies have distinct reserved series and the same pinned citations", () => {
  expect(pinnedEvaluationRubric).toMatchObject({ version: 1, revision: pinnedViteRevision, tag: "v7.0.0" });
  const [wide, narrow] = pinnedEvaluationRubric.studies;
  expect(wide).toMatchObject({ id: "package", series: "pinned-vite-b85f322-package-4096", tokenBudget: 4096 });
  expect(narrow).toMatchObject({ id: "subsystem", series: "pinned-vite-b85f322-subsystem-12288", tokenBudget: 12288 });
  expect(wide?.tasks).toHaveLength(6);
  expect(narrow?.tasks).toHaveLength(6);
  for (const { series, tasks } of pinnedEvaluationRubric.studies) {
    expect(new Set(tasks.map(({ id }) => id)).size).toBe(tasks.length);
    expect(tasks.reduce((sum, task) => sum + task.evidence.length, 0)).toBe(15);
    for (const task of tasks) {
      expect(pinnedEvaluationTask(series, task.id)?.task).toEqual(task);
      const parsed = parseEvaluation({ series, task: task.id, evidence: task.evidence }, task.projects.concat(task.sharedProjects));
      expect(parsed?.evidence.map(({ path }) => path).sort()).toEqual([...task.files].sort());
      expect(task).not.toHaveProperty("expected");
    }
  }
  const expected = ["packages/vite/src/client/client.ts:177", "packages/vite/src/shared/hmr.ts:191", "docs/guide/api-hmr.md:208"];
  expect(pinnedEvaluationTask(wide!.series, "hmr-lifecycle")?.task.evidence).toEqual(expected);
  expect(pinnedEvaluationTask(narrow!.series, "hmr-lifecycle")?.task.evidence).toEqual(expected);
  expect(pinnedEvaluationTask("vite-b85f322-package-4096", "hmr-lifecycle")).toBeUndefined();
  expect(pinnedEvaluationTask(wide!.series, "unknown")).toBeUndefined();
});

test("the pinned checkout check rejects nested, moved, dirty, staged and hidden Git state", async () => {
  const base = await mkdtemp(join(tmpdir(), "okb-pinned-evaluation-"));
  const workspace = join(base, "with spaces");
  const nested = join(workspace, "src");
  const path = join(nested, "app.ts");
  const original = "export const pinned = 1;\n";
  const changed = "export const pinned = 2;\n";
  const git = (...args: string[]) => {
    const environment = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    };
    const result = Bun.spawnSync(["git", ...args], { cwd: workspace, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(path, original);
    git("init", "--quiet");
    git("config", "core.autocrlf", "false");
    git("add", "--", "src/app.ts");
    git("-c", "user.name=Evaluation Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Pin fixture");
    const revision = git("rev-parse", "HEAD");
    await expect(verifyPinnedEvaluationWorkspace(workspace, revision)).resolves.toBeUndefined();
    await expect(verifyPinnedEvaluationWorkspace(workspace)).rejects.toThrow("Check out commit");
    await expect(verifyPinnedEvaluationWorkspace(nested, revision)).rejects.toThrow("repository root");
    await writeFile(join(workspace, "untracked.txt"), "A separate untracked note.");
    await expect(verifyPinnedEvaluationWorkspace(workspace, revision)).resolves.toBeUndefined();

    await writeFile(path, changed);
    await expect(verifyPinnedEvaluationWorkspace(workspace, revision)).rejects.toThrow("clean tracked worktree and index");
    git("add", "--", "src/app.ts");
    await expect(verifyPinnedEvaluationWorkspace(workspace, revision)).rejects.toThrow("clean tracked worktree and index");
    await writeFile(path, original);
    git("add", "--", "src/app.ts");

    for (const flag of ["assume-unchanged", "skip-worktree"]) {
      git("update-index", `--${flag}`, "--", "src/app.ts");
      await writeFile(path, changed);
      await expect(verifyPinnedEvaluationWorkspace(workspace, revision)).rejects.toThrow("hidden or unresolved index entries");
      git("update-index", `--no-${flag}`, "--", "src/app.ts");
      await writeFile(path, original);
    }

    git("config", "filter.fixture.clean", "fixture-no-execution");
    await expect(verifyPinnedEvaluationWorkspace(workspace, revision)).rejects.toThrow("without external Git clean filters");
    git("config", "--unset", "filter.fixture.clean");
    await expect(verifyPinnedEvaluationWorkspace(workspace, revision)).resolves.toBeUndefined();
  } finally { await rm(base, { force: true, recursive: true }); }
}, 15_000);
