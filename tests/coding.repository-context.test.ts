import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCodingProjectProfile, type CodingProjectProfile } from "../src/core/coding/project-profile.ts";
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

test("indexes exact symbols beyond the preview scan and invalidates a worktree edit", async () => {
  for (let index = 0; index < 258; index++) {
    await write(`apps/admin/lib/case-${String(index).padStart(3, "0")}.ts`, "export const fixture = 'unrelated';\n");
  }
  const path = "apps/admin/lib/target.ts";
  await write(path, "export function resolveTenant() {}\n");
  git("add", "--all");
  git("-c", "user.email=repo@example.test", "-c", "user.name=Test Repository", "commit", "--quiet", "-m", "Fixture");
  const options = { workspace, query: "resolveTenant" };
  expect((await selectRepositoryContext({ ...options, projects: ["apps/admin"] })).excerpts).toEqual([]);

  const profile: CodingProjectProfile = { version: 1, name: "Admin", projects: ["apps/admin"], tokenBudget: 200 };
  const before = await selectRepositoryContext({ ...options, profile });
  expect(before.manifest.workspaceRevision).toMatch(/^[0-9a-f]{40,64}$/u);
  expect(before.manifest).toMatchObject({
    tokenBudget: 200,
    index: { indexedFiles: 259, limited: false, expandedFiles: 0 },
    files: [{ path, reason: "Declares resolveTenant" }],
  });
  expect(await selectRepositoryContext({ ...options, profile })).toEqual(before);
  await write(path, "export function refreshTenant() {}\n");
  expect((await selectRepositoryContext({ ...options, profile })).excerpts).toEqual([]);
  const changed = await selectRepositoryContext({ ...options, query: "refreshTenant", profile });
  expect(changed.manifest.files).toMatchObject([{ path, reason: "Declares refreshTenant" }]);
  expect(changed.manifest.workspaceRevision).toBe(before.manifest.workspaceRevision);
  git("add", "--all");
  git("-c", "user.email=repo@example.test", "-c", "user.name=Test Repository", "commit", "--quiet", "-m", "Change fixture");
  const committed = await selectRepositoryContext({ ...options, query: "refreshTenant", profile });
  expect(committed.manifest.workspaceRevision).not.toBe(changed.manifest.workspaceRevision);
  expect(committed.manifest.id).not.toBe(changed.manifest.id);
});

test("expands only direct imports inside a profile's selected and permitted roots", async () => {
  const router = "apps/web/src/router.ts";
  const dependency = "packages/contracts/src/index.ts";
  await write(router, [
    'import { schema } from "@test/contracts";',
    'import { ignored } from "../../../packages/contracts/src/excluded.js";',
    'import { outside } from "../../../packages/outside/index.js";',
    "export function refreshSession() { return schema; }",
  ].join("\n"));
  await write("packages/contracts/package.json", '{"name":"@test/contracts","exports":{".":{"import":"./src/index.ts"}}}');
  await write(dependency, 'export { ownSchema as schema } from "./nested.ts";\n');
  await write("packages/contracts/src/nested.ts", "export const ownSchema = 1;\n");
  await write("packages/contracts/src/excluded.ts", "export const ignored = 2;\n");
  await write("packages/contracts/src/decoy.ts", "export function refreshSession() {}\n");
  await write("packages/outside/index.ts", "export const outside = 3;\n");
  git("add", "--all");

  const profile = parseCodingProjectProfile(JSON.stringify({
    version: 1, name: " Web ", projects: ["apps\\web/"], sharedProjects: ["packages/contracts"],
    exclude: ["packages/contracts/src/excluded.ts"], guidance: "Check schema behavior before drafting changes.",
  }));
  const selection = await selectRepositoryContext({ workspace, profile, query: `${router}:4` });
  expect(selection.guidance).toBe(profile.guidance!);
  expect(selection.manifest.profile).toMatchObject({ version: 1, name: "Web", sharedProjects: ["packages/contracts"] });
  expect(selection.manifest.files).toMatchObject([{ path: router, reason: "Exact workspace path" }, { path: dependency, reason: `Direct import from ${router}` }]);
  expect(JSON.stringify(selection.manifest)).not.toContain(profile.guidance!);
  const changed = await selectRepositoryContext({ workspace, profile: { ...profile, guidance: "Different reviewed guidance" }, query: `${router}:4` });
  expect(changed.manifest.files).toEqual(selection.manifest.files);
  expect(changed.manifest.id).not.toBe(selection.manifest.id);
  expect(() => parseCodingProjectProfile('{"version":2,"projects":["."]}')).toThrow("version 1");
  expect(() => parseCodingProjectProfile('{"version":1,"name":"Broken","projects":["../outside"]}')).toThrow("workspace-relative");
});

test("in a multi-word profile query, favored identifiers anchor source and documentation without promoting unrelated imports", async () => {
  const client = "apps/web/client.ts";
  const policy = "apps/web/policy.ts";
  const guide = "apps/web/settings.md";
  const unrelated = "packages/common/noise.ts";
  const spacer = "// spacer\n".repeat(28);
  await write(client, `import { log } from "../../packages/common/noise";\nexport const timeout = 1;\n${spacer}export const delay = policy.planRetry(timeout);\n`);
  await write(policy, `export const retry = 1;\n${spacer}class Policy {\n  public async planRetry(timeout: number) {\n    return timeout * 2;\n  }\n}\n`);
  await write(guide, `# Retry timeout\n${spacer}### \`planRetry\`\n\nReturns the next delay.\n`);
  await write(unrelated, "export const log = 'unrelated import';\n");
  git("add", "--all");

  const result = await selectRepositoryContext({ workspace, query: "retry timeout planRetry", profile: {
    version: 1, name: "Retry work", projects: ["apps/web"], sharedProjects: ["packages/common"],
  } });
  const selected = result.manifest.files;
  expect(selected.find(({ path }) => path === policy)?.reason).toBe("Declares planRetry");
  expect(selected.find(({ path }) => path === guide)?.reason).toBe("Documentation heading matches the query");
  expect(result.excerpts.find(({ path }) => path === policy)?.content).toContain("return timeout * 2");
  expect(result.excerpts.find(({ path }) => path === client)?.content).toContain("policy.planRetry(timeout)");
  expect(result.excerpts.find(({ path }) => path === guide)?.content).toContain("Returns the next delay");
  expect(selected.at(-1)).toMatchObject({ path: unrelated, reason: `Direct import from ${client}` });
});

test("a longer specific identifier gets its full query match ahead of a shorter shared prefix", async () => {
  const path = "apps/web/workflow.ts";
  const shorter = "const existing = config.open_export; // task\n";
  await write("apps/web/a.ts", shorter);
  await write(path, `${shorter}\nconst next = config.open_export_task();\n`);
  git("add", "--all");
  const { excerpts } = await selectRepositoryContext({ workspace, query: "open_export open_export_task", profile: {
    version: 1, name: "Export tasks", projects: ["apps/web"],
  } });
  expect(excerpts[0]?.path).toBe(path);
  expect(excerpts[0]?.content).toContain("config.open_export_task()");
});
