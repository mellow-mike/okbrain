import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBundle, syncSettings, syncStatus } from "../src/core/sync.ts";

const envKeys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
const upstream = "https://example.invalid/team/brain.git";
const identity = { action: "identity", name: "Brain Author", email: "brain@example.invalid" } as const;
const origin = { action: "origin", url: upstream } as const;
let base: string;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "okb-sync-settings-"));
  const config = join(base, "gitconfig");
  await writeFile(config, "[user]\n\tuseConfigOnly = true\n");
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" });
});

afterAll(async () => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(base, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: { ...process.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

async function brain(name: string): Promise<string> {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  return root;
}

test("identity settings initialize only on save and keep the values in the selected repository", async () => {
  const root = await brain("identity");
  const other = await brain("other-identity");
  expect(await syncSettings(root, { action: "status" })).toMatchObject({ repository: "new", identityReady: false, originConfigured: false });
  expect(existsSync(join(root, ".git"))).toBe(false);
  await expect(syncBundle(root)).rejects.toThrow("Git author and committer are unavailable");
  expect(existsSync(join(root, ".git"))).toBe(false);
  expect(existsSync(join(root, ".gitignore"))).toBe(false);
  await expect(syncSettings(root, { ...identity, email: "no email" })).rejects.toThrow("valid Git email");
  expect(existsSync(join(root, ".git"))).toBe(false);
  expect(await syncSettings(root, identity)).toMatchObject({ repository: "ready", identityReady: true, name: identity.name, email: identity.email });
  expect(git(root, "ls-files")).toBe("");
  expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await syncSettings(other, { action: "status" })).toMatchObject({ repository: "new", identityReady: false });
  expect(await syncBundle(root)).toMatchObject({ committed: expect.any(String) });
  expect(git(root, "log", "-1", "--format=%an <%ae> | %cn <%ce>")).toBe(
    "Brain Author <brain@example.invalid> | Brain Author <brain@example.invalid>",
  );
});

test("origin save does not contact the remote and refuses replacement, credential URLs, and Git rewrites", async () => {
  const root = await brain("origin");
  for (const url of ["https://token@example.invalid/team/brain.git", `${upstream}?access_token=secret`, `${upstream}#secret`, "file:///repository", "https://example.invalid/"]) {
    await expect(syncSettings(root, { action: "origin", url })).rejects.toThrow("HTTPS URL without credentials");
    expect(existsSync(join(root, ".git"))).toBe(false);
  }
  expect(await syncSettings(root, origin)).toMatchObject({ repository: "ready", originConfigured: true, origin: upstream, fetch: upstream, push: upstream });
  expect(git(root, "ls-files")).toBe("");
  expect(git(root, "for-each-ref")).toBe("");
  await expect(syncSettings(root, { ...origin, url: "https://example.invalid/other.git" })).rejects.toThrow("already has an origin");
  expect(git(root, "config", "--get", "remote.origin.url")).toBe(upstream);
  git(root, "config", "url.https://different.invalid/.pushInsteadOf", "https://example.invalid/");
  const changed = await syncSettings(root, { action: "status" });
  expect(changed).toMatchObject({ fetch: upstream, push: "https://different.invalid/team/brain.git" });
  await syncSettings(root, identity);
  await expect(syncBundle(root)).rejects.toThrow("changes the fetch or push destination");
  git(root, "config", "--unset", "url.https://different.invalid/.pushInsteadOf");
  git(root, "config", "remote.origin.pushurl", "https://example.invalid/team/other.git");
  await expect(syncBundle(root)).rejects.toThrow("changes the fetch or push destination");
  expect(git(root, "ls-files")).toBe("");
  expect(existsSync(join(root, ".gitignore"))).toBe(false);

  const rewritten = await brain("rewritten-origin");
  await syncSettings(rewritten, identity);
  git(rewritten, "config", "url.https://different.invalid/.insteadOf", "https://example.invalid/");
  await expect(syncSettings(rewritten, origin)).rejects.toThrow("changes the fetch or push destination");
  git(rewritten, "config", "--unset", "url.https://different.invalid/.insteadOf");
  git(rewritten, "config", "url.https://different.invalid/.pushInsteadOf", "https://example.invalid/");
  await expect(syncSettings(rewritten, origin)).rejects.toThrow("changes the fetch or push destination");
  expect(await syncSettings(rewritten, { action: "status" })).toMatchObject({ originConfigured: false });
}, 15_000);

test("a concurrent origin save keeps the first binding and an external Git lock protects config", async () => {
  const root = await brain("concurrent-origin");
  await syncSettings(root, identity);
  const configLock = join(root, ".git", "config.lock");
  await writeFile(configLock, "external Git writer\n", { flag: "wx" });
  await expect(syncSettings(root, origin)).rejects.toThrow("configuration cannot be locked");
  expect(await readFile(configLock, "utf8")).toBe("external Git writer\n");
  await rm(configLock);
  const results = await Promise.allSettled([
    syncSettings(root, origin), syncSettings(root, { ...origin, url: "https://example.invalid/other.git" }),
  ]);
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  const saved = results.find((result) => result.status === "fulfilled");
  expect(git(root, "config", "--get-all", "remote.origin.url")).toBe(saved?.value.origin!);
});

test("settings report only redacted legacy URLs and refuse a nested brain or linked worktree", async () => {
  const root = await brain("existing");
  await syncSettings(root, identity);
  await syncBundle(root);
  git(root, "remote", "add", "origin", "https://old-secret:password@example.invalid/team/brain.git?token=secret");
  git(root, "remote", "set-url", "--push", "origin", "https://push-secret@example.invalid/team/write.git");
  expect(await syncSettings(root, { action: "status" })).toMatchObject({
    origin: upstream, fetch: upstream, push: "https://example.invalid/team/write.git",
  });
  expect((await syncStatus(root)).remote).toBe(upstream);

  const nested = await brain("existing/nested");
  const worktree = join(base, "linked");
  git(root, "worktree", "add", "-b", "linked", worktree);
  const originalConfig = await readFile(join(root, ".git", "config"), "utf8");
  for (const directory of [nested, worktree]) {
    expect(await syncSettings(directory, { action: "status" })).toMatchObject({ repository: "unavailable" });
    await expect(syncSettings(directory, { ...identity, name: "Wrong author" })).rejects.toThrow(/inside another Git repository|needs a standalone repository/);
    await expect(syncSettings(directory, origin)).rejects.toThrow();
  }
  expect(await readFile(join(root, ".git", "config"), "utf8")).toBe(originalConfig);
});
