import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../src/core/config.ts";
import { gitHubSyncTransport, savedGitHubSyncCredential } from "../src/core/sync-credentials.ts";
import { managedGitTransport, syncBundle, syncGitHubCredential, syncSettings } from "../src/core/sync.ts";

// Each test here starts dozens of Git processes, which take far longer to start on Windows runners.
setDefaultTimeout(30_000);

const origin = "https://github.com/alpha/example.git";
const login = "alpha-user";
const token = "github_pat_fixtureOnly_0123456789abcdef";

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, env: { ...process.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("stores GitHub sync credentials outside the brain and removes them even after origin drift", async () => {
  const parent = await mkdtemp(join(tmpdir(), "okb-sync-github-"));
  const root = join(parent, "brain");
  const other = join(parent, "other");
  const save = { action: "save", login, token } as const;
  const status = { action: "status" } as const;
  await Promise.all([mkdir(root), mkdir(other)]);
  try {
    expect(await syncGitHubCredential(root, status)).toEqual({ repository: null, hasToken: false, savedFor: null });
    await expect(syncGitHubCredential(root, save)).rejects.toThrow("Save a managed GitHub HTTPS origin");
    expect(await syncSettings(root, { action: "origin", url: "https://github.com/alpha/example" }))
      .toMatchObject({ origin, fetch: origin, push: origin });
    expect(await syncGitHubCredential(root, status)).toEqual({ repository: "alpha/example", hasToken: false, savedFor: null });
    await expect(syncGitHubCredential(root, { ...save, token: "invalid-secret-input" })).rejects.toThrow("Enter a fine-grained GitHub personal access token.");
    await expect(syncGitHubCredential(root, save, () => false)).rejects.toThrow("selected brain is no longer writable");
    expect(await syncGitHubCredential(root, status)).toMatchObject({ hasToken: false });
    const saved = await syncGitHubCredential(root, save);
    expect(saved).toEqual({ repository: "alpha/example", hasToken: true, savedFor: "alpha/example" });
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(JSON.stringify(saved)).not.toContain(login);
    expect((await readFile(join(root, ".git", "config"), "utf8"))).not.toContain(token);
    expect(git(root, "ls-files")).toBe("");
    expect(await syncGitHubCredential(other, status)).toEqual({ repository: null, hasToken: false, savedFor: null });
    if (process.platform !== "win32") {
      const directory = join(dataDir(), "sync-credentials");
      expect((await lstat(directory)).mode & 0o077).toBe(0);
      expect((await lstat(join(directory, "github.sqlite"))).mode & 0o077).toBe(0);
    }

    git(root, "config", "remote.origin.pushurl", "https://github.com/other/example.git");
    expect(await syncGitHubCredential(root, status)).toEqual({ repository: null, hasToken: true, savedFor: "alpha/example" });
    await expect(syncGitHubCredential(root, save)).rejects.toThrow("verify its Git destinations first");
    await expect(syncGitHubCredential(root, { action: "remove" }, () => false)).rejects.toThrow("selected brain is no longer writable");
    expect(await syncGitHubCredential(root, { action: "remove" }, () => true)).toEqual({ repository: null, hasToken: false, savedFor: null });
    expect(savedGitHubSyncCredential(root)).toBeNull();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("secret Git configuration is child-only and a changed remote fails before delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-sync-github-env-"));
  const before = process.env.OKB_SYNC_AUTH_HEADER;
  try {
    expect(await syncSettings(root, { action: "origin", url: `${origin}/` })).toMatchObject({ origin });
    const credential = { origin, login, token };
    const { args, env } = gitHubSyncTransport(credential, root);
    const encoded = Buffer.from(`${login}:${token}`).toString("base64");
    expect(args.join("\n")).not.toContain(token);
    expect(args.join("\n")).not.toContain(encoded);
    expect(args).toContain(`--config-env=http.${origin}.extraHeader=OKB_SYNC_AUTH_HEADER`);
    expect(env.OKB_SYNC_AUTH_HEADER).toBe(`Authorization: Basic ${encoded}`);
    expect(process.env.OKB_SYNC_AUTH_HEADER).toBe(before);
    expect(env.GIT_TRACE2_EVENT).toBe("0");
    git(root, "config", "remote.origin.pushurl", "https://github.com/other/example.git");
    await expect(managedGitTransport(root, origin, ["push", "--no-recurse-submodules", "origin"], credential))
      .rejects.toThrow("changes the fetch or push destination");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync cannot stage credentials when the selected brain encloses per-user app data", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-sync-github-enclosure-"));
  const variable = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
  const previous = process.env[variable];
  try {
    process.env[variable] = join(root, "app-data");
    await syncSettings(root, { action: "origin", url: origin });
    expect(await syncGitHubCredential(root, { action: "status" })).toEqual({ repository: null, hasToken: false, savedFor: null });
    await expect(syncGitHubCredential(root, { action: "save", login, token })).rejects.toThrow("contains the local GitHub credential directory");
    await expect(syncBundle(root)).rejects.toThrow("contains the local GitHub credential directory");
    expect(git(root, "ls-files")).toBe("");
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
