import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncRecovery } from "../src/core/sync-recovery.ts";
import { syncBundle } from "../src/core/sync.ts";

const roots: string[] = [];
const note = (text: string) => `---\ntype: note\ntitle: Sample\ncustom: keep\n---\n${text}\n`;

function git(root: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "disabled-git-config"),
      GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" },
  });
}

function g(root: string, ...args: string[]) {
  const result = git(root, ...args);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  return result.stdout.toString();
}

async function repo(paths = ["note.md"], upstreamDeletes = false) {
  const root = await mkdtemp(join(tmpdir(), "okb-rebase-test-"));
  roots.push(root);
  g(root, "init", "--quiet", "-b", "main");
  g(root, "config", "user.name", "Test");
  g(root, "config", "user.email", "test@example.test");
  g(root, "config", "core.autocrlf", "false");
  g(root, "config", "commit.gpgsign", "false");
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), note("base"));
  }
  g(root, "add", "--all");
  g(root, "commit", "-qm", "Base");
  g(root, "branch", "upstream");
  for (const path of paths) await writeFile(join(root, path), note("local"));
  g(root, "commit", "-qam", "Local change");
  const localHead = g(root, "rev-parse", "HEAD").trim();
  g(root, "switch", "--quiet", "upstream");
  for (const path of paths) {
    if (upstreamDeletes) await rm(join(root, path));
    else await writeFile(join(root, path), note("upstream"));
  }
  g(root, "commit", "-qam", "Upstream change");
  const upstreamHead = g(root, "rev-parse", "HEAD").trim();
  g(root, "switch", "--quiet", "main");
  expect(git(root, "rebase", "upstream").exitCode).toBe(1);
  return { root, localHead, upstreamHead };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("previews the local commit and upstream by their rebase roles, then stages exact reviewed Markdown", async () => {
  const { root, upstreamHead } = await repo(["a folder/note.md"]);
  const origin = await mkdtemp(join(tmpdir(), "okb-rebase-origin-"));
  roots.push(origin);
  g(origin, "init", "--bare", "--quiet");
  g(root, "remote", "add", "origin", origin);
  g(root, "push", "origin", "upstream:main");
  g(root, "branch", "--set-upstream-to=origin/main", "main");
  const path = "a folder/note.md";
  const initial = await syncRecovery(root, { action: "status" });
  expect(initial).toEqual({ inProgress: true, conflicts: [path], canContinue: false, canAbort: true });
  await expect(syncRecovery(root, { action: "continue", confirm: true })).rejects.toThrow(/Resolve all conflicts/);
  const { preview } = await syncRecovery(root, { action: "preview", path });
  expect(preview).toMatchObject({ path, base: { kind: "text", text: note("base") }, local: { kind: "text", text: note("local") },
    upstream: { kind: "text", text: note("upstream") }, worktree: { kind: "text" }, canManual: true });
  const text = note("Merged (exact content)\n");
  const resolved = await syncRecovery(root, { action: "resolve", path, choice: "manual", approval: preview!.approval, text });
  expect(resolved).toEqual({ inProgress: true, conflicts: [], canContinue: true, canAbort: true });
  expect(g(root, "show", `:${path}`)).toBe(text);
  expect(await readFile(join(root, path), "utf8")).toBe(text);
  await expect(syncRecovery(root, { action: "continue" })).rejects.toThrow(/Confirm/);
  const continued = await syncRecovery(root, { action: "continue", confirm: true });
  expect(continued.inProgress).toBe(false);
  expect(continued.notice).toMatch(/without pushing/);
  expect(g(origin, "rev-parse", "refs/heads/main").trim()).toBe(upstreamHead);
  expect(g(root, "rev-parse", "HEAD^").trim()).toBe(upstreamHead);
  expect(g(root, "show", `HEAD:${path}`)).toBe(text);
});

test("rejects an edited worktree and a changed conflict index before replacing anything", async () => {
  const { root } = await repo(["first.md", "second.md"]);
  const path = "first.md";
  const original = (await syncRecovery(root, { action: "preview", path })).preview!;
  const edited = note("Unstaged edit after preview");
  await writeFile(join(root, path), edited);
  await expect(syncRecovery(root, { action: "resolve", path, choice: "upstream", approval: original.approval })).rejects.toThrow(/changed/);
  expect(await readFile(join(root, path), "utf8")).toBe(edited);
  const refreshed = (await syncRecovery(root, { action: "preview", path })).preview!;
  const other = (await syncRecovery(root, { action: "preview", path: "second.md" })).preview!;
  await syncRecovery(root, { action: "resolve", path: "second.md", choice: "local", approval: other.approval });
  await expect(syncRecovery(root, { action: "resolve", path, choice: "upstream", approval: refreshed.approval })).rejects.toThrow(/changed/);
  expect(await readFile(join(root, path), "utf8")).toBe(edited);
  expect(g(root, "show", ":second.md")).toBe(note("local"));
});

test("a missing upstream side removes the path and completes an empty local replay", async () => {
  const path = "note.md";
  const { root, upstreamHead } = await repo([path], true);
  const { preview } = await syncRecovery(root, { action: "preview", path });
  expect(preview?.upstream).toEqual({ kind: "deleted" });
  const resolved = await syncRecovery(root, { action: "resolve", path, choice: "upstream", approval: preview!.approval });
  expect(resolved.canContinue).toBe(true);
  expect(await Bun.file(join(root, path)).exists()).toBe(false);
  expect(g(root, "ls-files")).toBe("");
  expect((await syncRecovery(root, { action: "continue", confirm: true })).inProgress).toBe(false);
  expect(g(root, "rev-parse", "HEAD").trim()).toBe(upstreamHead);
});

test("sync will not stage a paused rebase, and explicit abort restores the original commits", async () => {
  const { root, localHead } = await repo();
  const oldIndex = g(root, "ls-files", "-u");
  const oldText = await readFile(join(root, "note.md"), "utf8");
  await expect(syncBundle(root)).rejects.toThrow(/rebase/i);
  await expect(syncRecovery(root, { action: "abort" })).rejects.toThrow(/Confirm/);
  expect(g(root, "ls-files", "-u")).toBe(oldIndex);
  expect(await readFile(join(root, "note.md"), "utf8")).toBe(oldText);
  expect(await syncRecovery(root, { action: "abort", confirm: true })).toMatchObject({ inProgress: false, notice: "Git rebase aborted." });
  expect(g(root, "rev-parse", "HEAD").trim()).toBe(localHead);
  expect(await readFile(join(root, "note.md"), "utf8")).toBe(note("local"));
});

test("private files and new private Markdown frontmatter cannot be staged by recovery", async () => {
  const { root } = await repo(["note.md", "db_only/private.md"]);
  const path = "note.md";
  const before = g(root, "ls-files", "-u");
  expect(await syncRecovery(root, { action: "status" })).toMatchObject({ conflicts: [path], canContinue: false });
  await expect(syncRecovery(root, { action: "preview", path: "db_only/private.md" })).rejects.toThrow(/supported conflict path/);
  const { preview } = await syncRecovery(root, { action: "preview", path });
  await expect(syncRecovery(root, { action: "resolve", path, choice: "manual", approval: preview!.approval,
    text: note("private").replace("custom: keep", "db_only: true") })).rejects.toThrow(/private note/);
  await writeFile(join(root, path), note("private").replace("custom: keep", "db_only: true"));
  expect((await syncRecovery(root, { action: "status" })).conflicts).toEqual([]);
  await expect(syncRecovery(root, { action: "preview", path })).rejects.toThrow(/private path/);
  expect(g(root, "ls-files", "-u")).toBe(before);
});

test("a failed Git stage restores the worktree and leaves conflict entries for retry", async () => {
  const { root } = await repo();
  const path = "note.md";
  const worktree = await readFile(join(root, path), "utf8");
  const index = g(root, "ls-files", "-u");
  const { preview } = await syncRecovery(root, { action: "preview", path });
  const lock = join(root, ".git", "index.lock");
  await writeFile(lock, "blocked");
  try {
    await expect(syncRecovery(root, { action: "resolve", path, choice: "local", approval: preview!.approval })).rejects.toThrow(/did not stage/);
  } finally { await rm(lock); }
  expect(await readFile(join(root, path), "utf8")).toBe(worktree);
  expect(g(root, "ls-files", "-u")).toBe(index);
});

test("the CLI can stage the selected side using a preview from a separate process", async () => {
  const { root } = await repo();
  const path = "note.md";
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "sync", "recovery", ...args,
      "--bundle", root, "--json"], { env: { ...process.env, XDG_CONFIG_HOME: root, APPDATA: root } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return JSON.parse(result.stdout.toString());
  };
  const { preview } = cli("preview", "--path", path);
  expect(cli("resolve", "--path", path, "--choice", "local", "--approval", preview.approval)).toMatchObject({ canContinue: true });
  expect(g(root, "show", `:${path}`)).toBe(note("local"));
});

test("an unavailable worktree is left intact even when an original side is printable", async () => {
  const { root } = await repo();
  const path = "note.md";
  const raw = Buffer.from([0, 128, 2]);
  await writeFile(join(root, path), raw);
  const { preview } = await syncRecovery(root, { action: "preview", path });
  expect(preview).toMatchObject({ local: { kind: "text" }, worktree: { kind: "unavailable" }, canManual: false });
  await expect(syncRecovery(root, { action: "resolve", path, choice: "local", approval: preview!.approval })).rejects.toThrow(/regular UTF-8/);
  expect(await readFile(join(root, path))).toEqual(raw);
});

test("continuing can stop on the next local commit with a fresh conflict preview", async () => {
  const { root } = await repo();
  const path = "note.md";
  g(root, "rebase", "--abort");
  await writeFile(join(root, path), note("Second local change"));
  g(root, "commit", "-qam", "Second change");
  expect(git(root, "rebase", "upstream").exitCode).toBe(1);
  const { preview } = await syncRecovery(root, { action: "preview", path });
  await syncRecovery(root, { action: "resolve", path, choice: "upstream", approval: preview!.approval });
  const next = await syncRecovery(root, { action: "continue", confirm: true });
  expect(next).toMatchObject({ inProgress: true, canAbort: true, canContinue: false, conflicts: [path] });
  expect(next.notice).toMatch(/next commit/);
  const nextPreview = (await syncRecovery(root, { action: "preview", path })).preview!;
  expect(nextPreview.local).toEqual({ kind: "text", text: note("Second local change") });
  expect(nextPreview.approval).not.toBe(preview!.approval);
});
