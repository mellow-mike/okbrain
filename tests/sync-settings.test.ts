import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBundle, syncSettings, syncStatus } from "../src/core/sync.ts";

const envKeys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
  "XDG_DATA_HOME", "LOCALAPPDATA"] as const;
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
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", XDG_DATA_HOME: base, LOCALAPPDATA: base });
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
}, 15_000);

test("replacing and disconnecting origin preserve refs, commits, and unrelated Git settings", async () => {
  const root = await brain("change-origin");
  await syncSettings(root, identity);
  await syncBundle(root);
  git(root, "remote", "add", "origin", "https://old-principal:old-secret@example.invalid/team/brain.git?token=old-query#old-fragment");
  git(root, "remote", "set-url", "--push", "origin", "old-push@example.invalid:team/write.git?token=old-scp-query#old-scp-fragment");
  git(root, "remote", "add", "backup", "https://backup.example.invalid/brain.git");
  git(root, "config", "okbrain.syncRemote", upstream);
  git(root, "config", "remote.origin.prune", "true");
  git(root, "config", "branch.main.remote", "origin");
  git(root, "config", "branch.main.merge", "refs/heads/main");
  git(root, "config", "branch.main.pushRemote", "origin");
  git(root, "config", "--add", "remote.pushDefault", "backup");
  git(root, "config", "--add", "remote.pushDefault", "origin");
  git(root, "config", "branch.backup.remote", "backup");
  git(root, "config", "branch.backup.merge", "refs/heads/backup");
  git(root, "config", "branch.backup.pushRemote", "backup");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "update-ref", "refs/remotes/backup/backup", "HEAD");
  const refs = git(root, "for-each-ref");
  const status = git(root, "status", "--porcelain");
  const replace = { action: "origin-preview", change: "replace", url: "https://github.com/example/new-brain" } as const;
  const to = "https://github.com/example/new-brain.git";
  const preview = await syncSettings(root, replace);
  expect(preview).toEqual({
    approval: expect.stringMatching(/^[a-f0-9]{64}$/u), change: "replace",
    current: { origin: upstream, fetch: upstream, push: "example.invalid:team/write.git" },
    proposed: { origin: to, fetch: to, push: to },
  });
  expect(JSON.stringify(preview)).not.toContain("old-");
  expect(await syncSettings(root, { ...replace, action: "origin-apply", approval: preview.approval }))
    .toMatchObject({ originConfigured: true, origin: to, fetch: to, push: to });
  expect(git(root, "config", "--get", "okbrain.syncRemote")).toBe(to);
  expect(git(root, "config", "--get", "remote.pushDefault")).toBe("backup");
  expect(git(root, "config", "--get", "branch.backup.remote")).toBe("backup");
  expect(git(root, "config", "--get", "branch.backup.merge")).toBe("refs/heads/backup");
  expect(git(root, "config", "--get", "branch.backup.pushRemote")).toBe("backup");
  expect(() => git(root, "config", "--get", "remote.origin.prune")).toThrow();
  expect(() => git(root, "config", "--get", "remote.origin.pushurl")).toThrow();
  expect(() => git(root, "config", "--get", "branch.main.pushRemote")).toThrow();
  expect(() => git(root, "rev-parse", "--symbolic-full-name", "@{upstream}")).toThrow();
  expect(git(root, "for-each-ref")).toBe(refs);
  expect(git(root, "status", "--porcelain")).toBe(status);

  const disconnect = { action: "origin-preview", change: "disconnect" } as const;
  const review = await syncSettings(root, disconnect);
  expect(review).toMatchObject({ change: "disconnect", proposed: null });
  expect(await syncSettings(root, { ...disconnect, action: "origin-apply", approval: review.approval }))
    .toMatchObject({ repository: "ready", identityReady: true, originConfigured: false, origin: null, fetch: null, push: null });
  expect(() => git(root, "config", "--get", "okbrain.syncRemote")).toThrow();
  expect(git(root, "remote")).toBe("backup");
  expect(git(root, "for-each-ref")).toBe(refs);
}, 15_000);

test("origin approval binds both the requested change and complete config and rechecks writes and recovery", async () => {
  const root = await brain("origin-approval");
  await syncSettings(root, origin);
  const previewInput = { action: "origin-preview", change: "replace", url: "https://example.invalid/replacement" } as const;
  const apply = (approval: string, overrides = {}, canWrite?: () => boolean) =>
    syncSettings(root, { ...previewInput, action: "origin-apply", approval, ...overrides }, canWrite);
  const first = await syncSettings(root, previewInput);
  await expect(apply(first.approval, { url: "https://example.invalid/different" })).rejects.toMatchObject({ status: 409 });
  git(root, "config", "core.logAllRefUpdates", "false");
  await expect(apply(first.approval)).rejects.toMatchObject({ status: 409 });
  const reviewed = await syncSettings(root, previewInput);
  const config = join(root, ".git", "config");
  const original = await readFile(config, "utf8");
  let checks = 0;
  await expect(apply(reviewed.approval, {}, () => ++checks === 1)).rejects.toMatchObject({ status: 403 });
  expect(checks).toBe(2);
  expect(await readFile(config, "utf8")).toBe(original);
  expect(existsSync(config + ".lock")).toBe(false);
  await mkdir(join(root, ".git", "rebase-merge"));
  await expect(syncSettings(root, previewInput)).rejects.toThrow("Finish or abort Sync recovery");
  await expect(apply(reviewed.approval)).rejects.toMatchObject({ status: 409 });
  await rm(join(root, ".git", "rebase-merge"), { recursive: true });
  await writeFile(config + ".lock", "external git config editor");
  await expect(apply(reviewed.approval)).rejects.toThrow("configuration cannot be locked");
  expect(await readFile(config + ".lock", "utf8")).toBe("external git config editor");
  await rm(config + ".lock");
  expect(await readFile(config, "utf8")).toBe(original);
});

test("origin changes reject active rewrites and inherited or dormant origin policy", async () => {
  const root = await brain("origin-git-policy");
  await syncSettings(root, origin);
  const replace = { action: "origin-preview", change: "replace", url: "https://other.example.invalid/team/brain.git" } as const;
  const disconnect = { action: "origin-preview", change: "disconnect" } as const;
  const key = "url.https://rewrite.example.invalid/.pushInsteadOf";
  git(root, "config", key, "https://other.example.invalid/");
  await expect(syncSettings(root, replace)).rejects.toThrow("changes the fetch or push destination");
  git(root, "config", "--replace-all", key, "https://example.invalid/");
  await expect(syncSettings(root, disconnect)).rejects.toThrow("changes the fetch or push destination");
  git(root, "config", "--unset", key);
  git(root, "config", "include.path", "extra-config");
  const included = join(root, ".git", "extra-config");
  await writeFile(included, '[remote "origin"]\n\tprune = true\n');
  await expect(syncSettings(root, disconnect)).rejects.toThrow("inherited Git settings");
  await writeFile(included, '[branch "main"]\n\tpushRemote = origin\n');
  await expect(syncSettings(root, disconnect)).rejects.toThrow("inherited Git settings");
  git(root, "config", "--unset", "include.path");
  git(root, "config", "includeIf.hasconfig:remote.*.url:https://other.example.invalid/**.path", "extra-config");
  await expect(syncSettings(root, replace)).rejects.toThrow("conditional on a remote URL");
  expect(git(root, "remote", "get-url", "origin")).toBe(upstream);
});

test("a directly configured push-only origin can be safely disconnected", async () => {
  const root = await brain("push-only-origin");
  await syncSettings(root, identity);
  git(root, "config", "remote.origin.pushurl", "https://credential@example.invalid/publish.git");
  const disconnect = { action: "origin-preview", change: "disconnect" } as const;
  const review = await syncSettings(root, disconnect);
  expect(review).toMatchObject({ current: { origin: null, fetch: "origin", push: "https://example.invalid/publish.git" }, proposed: null });
  expect(await syncSettings(root, { ...disconnect, action: "origin-apply", approval: review.approval }))
    .toMatchObject({ originConfigured: false });
});

test("separate CLI processes can preview and apply an origin change with the per-user approval key", async () => {
  const root = await brain("origin-cli");
  const appHome = join(base, "origin-cli-app-data");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, XDG_CONFIG_HOME: join(base, "origin-cli-config"), APPDATA: join(base, "origin-cli-config"),
    XDG_DATA_HOME: appHome, LOCALAPPDATA: appHome };
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", cli, "--bundle", root, "--json", "sync", "settings", ...args], {
      cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  run("origin", "--url", upstream);
  const url = "https://example.invalid/new-repository.git";
  const options = ["--change", "replace", "--url", url];
  const before = JSON.parse(run("origin-preview", ...options)) as { approval: string };
  const key = join(appHome, "okbrain", "sync-credentials", "origin-approval.key");
  expect((await stat(key)).size).toBe(32);
  if (process.platform !== "win32") expect((await stat(key)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(run("origin-apply", ...options, "--approval", before.approval))).toMatchObject({ origin: url, fetch: url, push: url });
  expect(git(root, "remote", "get-url", "origin")).toBe(url);
}, 15_000);
