import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pinnedEvaluationRubric } from "../src/core/coding/evaluation-rubric.ts";
import { maxProfileTokens } from "../src/core/coding/project-profile.ts";
import { measurePinnedViteRetrieval } from "../src/core/coding/retrieval-benchmark.ts";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdin: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Git command failed.");
  return result.stdout.toString();
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
    const { repository, tag } = pinnedEvaluationRubric;
    git(root, "-c", `core.hooksPath=${hooks}`, "clone", "--quiet", "--depth=1", "--single-branch", "--branch", tag, repository, workspace);
  }
  const { repository, tag, revision, evaluationSeries, ...measured } = await measurePinnedViteRetrieval({
    workspace, repetitions, tokenBudget, study: args.narrow ? "subsystem" : "package",
  });
  console.log(JSON.stringify({
    repository, tag, revision, evaluationSeries,
    runtime: { platform: platform(), arch: arch(), bun: Bun.version, cpu: cpus()[0]?.model },
    ...measured,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
