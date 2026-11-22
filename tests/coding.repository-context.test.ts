import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selectRepositoryContext } from "../src/core/coding/repository-context.ts";

let workspace: string;

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: workspace });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function write(path: string, content: string | Buffer): Promise<void> {
  const file = join(workspace, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "okb-repository-context-"));
  git("init", "--quiet");
});

afterEach(async () => { await rm(workspace, { force: true, recursive: true }); });

test("ranks worktree text only inside literal tracked project scopes", async () => {
  await write("apps/[auth]/router.ts", "first line\r\nexport function refreshToken() {}\r\nlast line\r\n");
  await write("apps/[auth]/guide.md", "Instructions for refresh.");
  await write("apps/[auth]/.env.local", "refresh token = secret_value");
  await write("apps/[auth]/build/refresh-token.ts", "generated work");
  await write("apps/[auth]/db_only/refresh-token.md", "private note");
  await write("apps/[auth]/refresh-token.bin", Buffer.from([0xff, 0xfe]));
  await write("apps/[auth]/unrelated.ts", "rebuild");
  await write("apps/a/refresh-token.ts", "outside literal scope");
  await write("packages/auth/refresh-token.ts", "outside sibling scope");
  git("-c", "core.autocrlf=false", "add", "--all");
  await write("apps/[auth]/untracked-refresh-token.ts", "untracked data");
  await write("apps/[auth]/guide.md", "Current instructions for refresh.");

  const { manifest, excerpts } = await selectRepositoryContext({ workspace, projects: ["apps/[auth]/"], query: "refresh token" });

  expect(manifest.projects).toEqual(["apps/[auth]"]);
  expect(manifest.files.map((file) => file.path)).toEqual(["apps/[auth]/router.ts", "apps/[auth]/guide.md"]);
  expect(excerpts[0]).toEqual({
    path: "apps/[auth]/router.ts", startLine: 1, endLine: 3,
    content: "first line\nexport function refreshToken() {}\nlast line",
  });
  expect(excerpts[1]?.content).toBe("Current instructions for refresh.");
  expect(JSON.stringify(manifest)).not.toContain("refreshToken()");
  expect(manifest.contextBytes).toBe(Buffer.byteLength(JSON.stringify(excerpts)));

  const nested = await selectRepositoryContext({ workspace: join(workspace, "apps", "[auth]"), projects: ["."], query: "refresh token" });
  expect(nested.manifest.files.map((file) => file.path)).toEqual(["router.ts", "guide.md"]);
});

test("budgets UTF-8 JSON, keeps exact line ranges, and binds the selected excerpt bytes", async () => {
  const path = "services/service.ts";
  const line = "export const needle = '東😀';";
  const source = (target: string) => [
    ...Array.from({ length: 20 }, () => "a".repeat(200)), target, ...Array.from({ length: 20 }, () => "b".repeat(200)),
  ].join("\n");
  await write(path, source(line));
  git("add", "--all");
  const options = { workspace, projects: ["services"], query: "needle", tokenBudget: 60 };
  const first = await selectRepositoryContext(options);
  const repeated = await selectRepositoryContext(options);

  expect(first).toEqual(repeated);
  expect(first.excerpts).toEqual([{ path, startLine: 21, endLine: 21, content: line }]);
  expect(first.manifest.estimatedTokens).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(first.excerpts)) / 2));
  expect(first.manifest.estimatedTokens).toBeLessThanOrEqual(options.tokenBudget);
  expect(first.manifest.limitsReached.tokenBudget).toBe(true);
  expect(first.manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);

  await write(path, source(line.replace("東", "京")));
  expect((await selectRepositoryContext(options)).manifest.id).not.toBe(first.manifest.id);
  const smallest = await selectRepositoryContext({ ...options, tokenBudget: 1 });
  expect(smallest.excerpts).toEqual([]);
  expect(smallest.manifest.estimatedTokens).toBe(1);
});

test("bounds candidate reads while considering separate project subdirectories", async () => {
  for (let index = 0; index < 260; index++) {
    await write(`packages/a/${String(index).padStart(3, "0")}.txt`, "irrelevant");
  }
  await write("packages/z/context.txt", `${"background\n".repeat(5000)}needle\n${"尾".repeat(4096)}`);
  git("add", "--all");

  const { manifest, excerpts } = await selectRepositoryContext({ workspace, projects: ["packages"], query: "needle" });
  expect(manifest.trackedPaths).toBe(261);
  expect(manifest.scannedFiles).toBe(256);
  expect(manifest.limitsReached.scannedFiles).toBe(true);
  expect(manifest.limitsReached.fileBytes).toBe(true);
  expect(excerpts).toHaveLength(1);
  expect(excerpts[0]?.path).toBe("packages/z/context.txt");
  expect(excerpts[0]?.endLine).toBe(5001);
  expect(excerpts[0]?.content).toContain("needle");
});

test("requires existing contained project directories and rejects an invalid budget", async () => {
  const options = { workspace, projects: ["."], query: "needle" };
  await expect(selectRepositoryContext({ ...options, projects: [] })).rejects.toThrow("workspace-relative project directories");
  await expect(selectRepositoryContext({ ...options, projects: ["../outside"] })).rejects.toThrow("workspace-relative directory");
  await expect(selectRepositoryContext({ ...options, projects: [workspace] })).rejects.toThrow("workspace-relative directory");
  await expect(selectRepositoryContext({ ...options, projects: ["missing"] })).rejects.toThrow("existing workspace directory");
  await expect(selectRepositoryContext({ ...options, tokenBudget: 16385 })).rejects.toThrow("token budget");
});

test("preserves the tracked filename when it begins with a byte order mark", async () => {
  const trackedPath = "\uFEFFneedle.ts";
  await write(trackedPath, "tracked source");
  git("add", "--all");
  await write("needle.ts", "needle untracked data");

  const { excerpts } = await selectRepositoryContext({ workspace, projects: ["."], query: "needle" });
  expect(excerpts).toEqual([{ path: trackedPath, startLine: 1, endLine: 1, content: "tracked source" }]);
});

test.skipIf(process.platform === "win32")("does not follow tracked symlinks or substituted worktree components", async () => {
  await write("project/swapped/needle.ts", "original target");
  await write("project/substituted.ts", "original target");
  await write("other/needle.ts", "needle outside the opted-in scope");
  await symlink(join(workspace, "other", "needle.ts"), join(workspace, "project", "tracked-link.ts"));
  git("add", "--all");
  await rename(join(workspace, "project", "swapped"), join(workspace, "original"));
  await symlink(join(workspace, "other"), join(workspace, "project", "swapped"));
  await rm(join(workspace, "project", "substituted.ts"));
  await symlink(join(workspace, "other", "needle.ts"), join(workspace, "project", "substituted.ts"));

  const options = { workspace, projects: ["project"], query: "needle" };
  expect((await selectRepositoryContext(options)).excerpts).toEqual([]);
  await expect(selectRepositoryContext({ ...options, projects: ["project/swapped"] })).rejects.toThrow("without symlinks");
});
