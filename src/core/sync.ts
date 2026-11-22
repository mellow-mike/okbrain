// Git-backed sync (Stage 1.5): the bundle is its own git repo; multi-device
// sync IS git. Every invocation spawns git by argv (no shell strings, per
// CLAUDE.md), seeds the bundle's .gitignore (derived + private paths) and
// .gitattributes (LF pinning — Windows autocrlf must never rewrite bundle
// bytes, or Stage-2 content-hashes silently churn), commits local changes,
// and pulls/pushes when an `origin` remote is configured.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { listConcepts, readConceptPermissive } from "./okf/bundle.ts";
import { OkfParseError, parse } from "./okf/document.ts";
import { regenerateIndexBranches } from "./okf/indexmd.ts";
import { removePrivateLogEntries } from "./okf/logmd.ts";
import { inDbOnlyDir } from "./okf/paths.ts";
import { checkPrivacyPath } from "./okf/privacy.ts";
import { nowTimestamp } from "./okf/write.ts";
import {
  brainEnclosesGitHubSyncStore, gitHubSyncTransport, parseGitHubSyncCredential, savedGitHubSyncCredential, syncGitHubRepository,
  updateGitHubSyncCredential, type GitHubSyncCredential,
} from "./sync-credentials.ts";

export class SyncError extends Error {}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runAbortableGit(cwd: string, args: string[], input: string | undefined, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<GitResult> {
  signal.throwIfAborted();
  const group = process.platform !== "win32";
  const child = Bun.spawn(["git", ...args], {
    cwd, env, detached: group, stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe", stderr: "pipe", maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL",
  });
  let stopping: Promise<void> | undefined;
  const kill = () => {
    try { if (child.exitCode === null) child.kill("SIGKILL"); } catch { /* Git already exited. */ }
  };
  const stop = () => {
    if (group) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { kill(); }
    } else if (child.exitCode === null) {
      stopping ??= (async () => {
        try {
          const system = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? env.windir;
          if (system) {
            const command = Bun.spawn([join(system, "System32", "taskkill.exe"), "/PID", String(child.pid), "/T", "/F"], {
              stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 3000, killSignal: "SIGKILL",
            });
            await command.exited;
          }
        } catch { /* Fall back to the known child handle. */ }
        finally { kill(); }
      })();
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
    signal.throwIfAborted();
    return { code, stdout, stderr };
  } catch (error) {
    stop();
    await stopping;
    await child.exited;
    throw error;
  } finally { signal.removeEventListener("abort", stop); }
}

/** Spawn git by argv. Never throws on nonzero exit — callers decide. */
export function runGit(cwd: string, args: string[], input?: string, extraEnv?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  // The selected brain, rather than inherited Git plumbing, determines the repository.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CONFIG"]) delete env[key];
  if (signal) return runAbortableGit(cwd, args, input, env, signal);
  return new Promise((done, fail) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (e && typeof e.code === "string" && e.code === "ENOENT")
          return fail(new SyncError("git not found on PATH — install git to use okb sync"));
        if (e?.killed) return fail(new SyncError(`git ${args[0]} timed out`));
        done({
          code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          stdout: stdout as string,
          stderr: stderr as string,
        });
      },
    );
    if (input !== undefined) {
      child.stdin?.on("error", () => { /* Git errors are reported by execFile. */ });
      child.stdin?.end(input);
    }
  });
}

/** Run git and throw a SyncError (with git's own message) on failure. */
export async function git(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await runGit(cwd, args, input, env);
  if (r.code !== 0)
    throw new SyncError(`git ${args[0]} failed: ${gitDiagnostic(r)}`);
  return r.stdout;
}

/** Toplevel of the repo containing `dir`, or null when not in one. */
export async function repoRoot(dir: string): Promise<string | null> {
  const r = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

// Symlinks (macOS /tmp) and 8.3 short names (Windows temp) make naive string
// comparison lie; realpath both sides and fold case on win32.
export function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let r: string;
    try {
      r = realpathSync.native(p);
    } catch {
      r = resolve(p);
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

const repositoryGates = new Map<string, Promise<void>>();

/** Serialize app mutations of the same brain, including alternate spellings of its path. */
export async function withSyncRepository<T>(root: string, work: (canonicalRoot: string) => Promise<T>): Promise<T> {
  const canonical = await realpath(root);
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const previous = repositoryGates.get(key) ?? Promise.resolve();
  const result = previous.then(() => work(canonical));
  const gate = result.then(() => {}, () => {});
  repositoryGates.set(key, gate);
  try { return await result; }
  finally { if (repositoryGates.get(key) === gate) repositoryGates.delete(key); }
}

export async function syncRebaseInProgress(root: string): Promise<boolean> {
  const paths = await Promise.all(["rebase-merge", "rebase-apply"].map(async (part) =>
    resolve(root, (await git(root, ["rev-parse", "--git-path", part])).trimEnd())));
  return existsSync(paths[0]!) || (existsSync(paths[1]!) && !existsSync(join(paths[1]!, "applying")));
}

function displayRemote(value: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    const url = URL.parse(value);
    if (!url) return "Configured Git remote";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  }
  return value.replace(/^[^/\\\s@]+@(?=[^/\\\s:]+:)/u, "");
}

function gitDiagnostic(result: GitResult): string {
  return (result.stderr || result.stdout).trim().replace(/[a-z][a-z\d+.-]*:\/\/[^\s'"<>]+/giu, displayRemote);
}

type SyncSettingsInput = { action: "status" | "identity" | "origin"; name?: string; email?: string; url?: string };

export interface SyncSettings {
  repository: "new" | "ready" | "unavailable";
  reason?: string;
  identityReady: boolean;
  name: string | null;
  email: string | null;
  originConfigured: boolean;
  origin: string | null;
  fetch: string | null;
  push: string | null;
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function standaloneRepository(root: string): Promise<Pick<SyncSettings, "repository" | "reason">> {
  const unavailable = (reason: string) => ({ repository: "unavailable" as const, reason });
  try {
    const top = await repoRoot(root);
    if (top && !sameDir(top, root)) return unavailable("This brain is inside another Git repository.");
    const directory = join(root, ".git");
    const marker = await lstat(directory).catch((error: unknown) => {
      if (!absent(error)) throw error;
    });
    if (marker && !marker.isDirectory()) return unavailable("Git setup needs a standalone repository. Linked worktrees and submodules share Git configuration.");
    if (top && marker) {
      const config = await lstat(join(directory, "config"));
      if (config.isFile() && config.nlink === 1) return { repository: "ready" };
    }
    if (top || marker || (await runGit(root, ["rev-parse", "--is-bare-repository"])).stdout.trim() === "true")
      return unavailable("This brain does not have a writable standalone Git configuration.");
    // A repository rejected by Git (for example ownership) must not be treated as a fresh brain.
    for (let parent = dirname(root); parent !== root; parent = dirname(root)) {
      if (await lstat(join(parent, ".git")).then(() => true, (error: unknown) => {
        if (!absent(error)) throw error;
        return false;
      })) return unavailable("This brain is inside another Git repository.");
      root = parent;
    }
    return { repository: "new" };
  } catch (error) {
    return unavailable(error instanceof SyncError ? error.message : "Unable to inspect this brain's Git configuration.");
  }
}

async function gitIdentity(root: string) {
  const [author, committer] = await Promise.all(["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"].map((id) => runGit(root, ["var", id])));
  const effective = /^(.+) <([^<>]+)> /u.exec(author!.stdout);
  return { identityReady: author!.code === 0 && committer!.code === 0, name: effective?.[1] ?? null, email: effective?.[2] ?? null };
}

async function configValues(root: string, key: string, local = false): Promise<string[]> {
  const result = await runGit(root, ["config", ...(local ? ["--local"] : []), "--null", "--get-all", key]);
  if (result.code === 1) return [];
  if (result.code !== 0) throw new SyncError("Unable to inspect this brain's Git configuration.");
  return result.stdout.split("\0").slice(0, -1);
}

async function originURLs(root: string, push = false, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string[]> {
  const result = await runGit(root, ["remote", "get-url", "--all", ...(push ? ["--push"] : []), "origin"], undefined, env, signal);
  return result.code === 0 ? result.stdout.trimEnd().split(/\r?\n/u) : [];
}

async function readSyncSettings(root: string): Promise<SyncSettings> {
  const status = await standaloneRepository(root);
  const empty = { ...status, identityReady: false, name: null, email: null, originConfigured: false, origin: null, fetch: null, push: null };
  if (status.repository === "unavailable") return empty;
  const identity = await gitIdentity(root);
  if (status.repository === "new") {
    const [configured, pushURL] = await Promise.all([configValues(root, "remote.origin.url"), configValues(root, "remote.origin.pushurl")]);
    return { ...empty, ...identity, originConfigured: Boolean(configured.length || pushURL.length),
      origin: configured.length ? configured.map(displayRemote).join(", ") : null };
  }
  const [names, emails, configured, fetch, push, remotes] = await Promise.all([
    configValues(root, "user.name", true), configValues(root, "user.email", true), configValues(root, "remote.origin.url"),
    originURLs(root), originURLs(root, true), git(root, ["remote"]),
  ]);
  const display = (urls: string[]) => urls.length ? urls.map(displayRemote).join(", ") : null;
  return {
    ...status, ...identity, name: names.at(-1) ?? identity.name, email: emails.at(-1) ?? identity.email,
    originConfigured: Boolean(configured.length || fetch.length || push.length || remotes.split(/\r?\n/u).includes("origin")),
    origin: display(configured), fetch: display(fetch), push: display(push),
  };
}

function identityField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 256 || /[\x00-\x1f\x7f<>]/u.test(value))
    throw new SyncError(`Enter a valid Git ${label}.`);
  return value.trim();
}

function newOrigin(value: unknown): string {
  const url = typeof value === "string" && Buffer.byteLength(value) <= 2048 &&
    /^https:\/\/[^@/?#\\\s]+\/[^?#\\\s]+$/iu.test(value) ? URL.parse(value) : null;
  if (!url || !url.hostname || url.username || url.password || url.pathname === "/" || url.pathname.includes("%00"))
    throw new SyncError("Enter a Git repository HTTPS URL without credentials, query parameters, or a fragment.");
  return url.href;
}

export function originForSetup(value: unknown): string {
  const origin = newOrigin(value);
  const page = origin.replace(/\/$/u, "");
  if (syncGitHubRepository(page)) return page;
  const clone = page + ".git";
  return syncGitHubRepository(clone) ? clone : origin;
}

export function managedOriginConfig(origin: string): [string, string][] {
  return [["remote.origin.url", origin], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], ["okbrain.syncRemote", origin]];
}

const changedOriginError = () => new SyncError("Git configuration changes the fetch or push destination. Review the Git URL rules before connecting this remote.");

async function verifyOriginDestination(root: string, url: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  const endpoints = await Promise.all([originURLs(root, false, env, signal), originURLs(root, true, env, signal)]);
  if (endpoints.some((values) => values.length !== 1 || values[0] !== url))
    throw changedOriginError();
}

async function verifyProposedOrigin(root: string, url: string): Promise<void> {
  // --get-url expands fetch rewriting without contacting the remote. Git 2.x
  // cannot use `remote get-url` against a command-only proposed remote.
  const [fetch, rules] = await Promise.all([
    runGit(root, ["ls-remote", "--get-url", "--", url]),
    runGit(root, ["config", "--null", "--get-regexp", "^url\\..*\\.pushinsteadof$"]),
  ]);
  if (fetch.code !== 0 || fetch.stdout.trimEnd() !== url || (rules.code !== 0 && rules.code !== 1))
    throw changedOriginError();
  let bestLength = -1;
  let destination = url;
  for (const rule of rules.stdout.split("\0")) {
    const separator = rule.indexOf("\n");
    if (separator === -1) continue;
    const prefix = rule.slice(separator + 1);
    if (prefix.length > bestLength && url.startsWith(prefix)) {
      bestLength = prefix.length;
      destination = rule.slice("url.".length, separator - ".pushinsteadof".length) + url.slice(prefix.length);
    }
  }
  if (destination !== url) throw changedOriginError();
}

async function initializeRepository(root: string): Promise<void> {
  await git(root, ["init"]);
  // `git init -b` is unavailable on older Git releases.
  await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
}

/** Update both fields with Git's parser under the normal external Git config lock. */
async function saveRepositoryConfig(root: string, entries: readonly [string, string][], verify?: () => Promise<void>): Promise<void> {
  const config = join(root, ".git", "config");
  const info = await lstat(config);
  if (!info.isFile() || info.nlink !== 1) throw new SyncError("This brain does not have a writable standalone Git configuration.");
  const lockPath = config + ".lock";
  const lock = await open(lockPath, "wx", info.mode & 0o777).catch(() => {
    throw new SyncError("Git configuration cannot be locked. Close any other Git settings editor and try again.");
  });
  let scratch: string | undefined;
  let installed = false;
  try {
    await verify?.();
    scratch = await mkdtemp(join(root, ".git", "okbrain-config-"));
    const edited = join(scratch, "config");
    await writeFile(edited, await readFile(config), { mode: 0o600 });
    for (const [name, value] of entries)
      await git(root, ["config", "--file", edited, "--replace-all", "--", name, value]);
    await lock.writeFile(await readFile(edited));
    await lock.sync();
    await lock.close();
    await rename(lockPath, config);
    installed = true;
  } finally {
    await lock.close().catch(() => {});
    if (!installed) await rm(lockPath, { force: true }).catch(() => {});
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Inspect or save local Git settings. This operation never contacts a remote. */
export async function syncSettings(root: string, input: SyncSettingsInput): Promise<SyncSettings> {
  if (input.action === "status") return readSyncSettings(root);
  return withSyncRepository(root, async (canonical) => {
    const current = await readSyncSettings(canonical);
    if (current.repository === "unavailable") throw new SyncError(current.reason!);
    let entries: [string, string][];
    if (input.action === "identity") {
      const name = identityField(input.name, "name");
      const email = identityField(input.email, "email");
      if (!/^[^\s@]+@[^\s@]+$/u.test(email)) throw new SyncError("Enter a valid Git email address.");
      entries = [["user.name", name], ["user.email", email]];
    } else if (input.action === "origin") {
      if (current.originConfigured) throw new SyncError("This brain already has an origin. Change an existing remote with Git.");
      const url = originForSetup(input.url);
      entries = managedOriginConfig(url);
      if (current.repository === "new") await verifyProposedOrigin(canonical, url);
    } else {
      throw new SyncError("Choose a Git settings action.");
    }
    if (current.repository === "new") await initializeRepository(canonical);
    if ((await standaloneRepository(canonical)).repository !== "ready")
      throw new SyncError("This brain does not have a writable standalone Git configuration.");
    await saveRepositoryConfig(canonical, entries, input.action === "origin" ? async () => {
      const registered = await readSyncSettings(canonical);
      if (registered.originConfigured) throw new SyncError("This brain already has an origin. Change an existing remote with Git.");
      const url = entries[0]![1];
      await verifyProposedOrigin(canonical, url);
    } : undefined);
    return readSyncSettings(canonical);
  });
}

type SyncGitHubCredentialInput = { action: "status" | "save" | "remove"; login?: string; token?: string };

function readGitHubCredential(root: string) {
  try { return savedGitHubSyncCredential(root); }
  catch { throw new SyncError("Unable to read the private GitHub sync credential store."); }
}

async function managedGitHubOrigin(root: string) {
  if ((await standaloneRepository(root)).repository !== "ready") return null;
  const origin = (await configValues(root, "okbrain.syncRemote", true)).at(-1);
  if (!origin) return null;
  const repository = syncGitHubRepository(origin);
  if (!repository) return null;
  try { await verifyOriginDestination(root, origin); }
  catch (error) {
    if (error instanceof SyncError) return null;
    throw error;
  }
  return { origin, repository };
}

/** Only the local owner adapter may call this with credential material. */
export async function syncGitHubCredential(root: string, input: SyncGitHubCredentialInput, canWrite?: () => boolean) {
  return withSyncRepository(root, async (canonical) => {
    const enclosesStore = brainEnclosesGitHubSyncStore(canonical);
    const managed = enclosesStore ? null : await managedGitHubOrigin(canonical);
    if (input.action === "save" || input.action === "remove") {
      let value: GitHubSyncCredential | null = null;
      if (input.action === "save") {
        if (enclosesStore) throw new SyncError("This brain contains the local GitHub credential directory. Choose a separate brain folder.");
        if (!managed) throw new SyncError("Save a managed GitHub HTTPS origin ending in .git and verify its Git destinations first.");
        value = parseGitHubSyncCredential(managed.origin, input.login, input.token);
      }
      if (canWrite && !canWrite()) throw new SyncError("The selected brain is no longer writable.");
      try { updateGitHubSyncCredential(canonical, value); }
      catch { throw new SyncError("Unable to update the private GitHub sync credential store."); }
    } else if (input.action !== "status") {
      throw new SyncError("Choose a GitHub sync credential action.");
    }
    const saved = readGitHubCredential(canonical);
    return { repository: managed?.repository ?? null, hasToken: saved !== null, savedFor: saved ? syncGitHubRepository(saved.origin) : null };
  });
}

/** Run a managed fetch or push against its approved origin. */
export async function managedGitTransport(
  root: string, origin: string, args: ["fetch" | "push", ...string[]], credential: GitHubSyncCredential | null,
  processOptions: NodeJS.ProcessEnv = {},
  options: { signal?: AbortSignal; authorize?: () => void | Promise<void> } = {},
): Promise<GitResult> {
  const protocol = { ...processOptions, GIT_ALLOW_PROTOCOL: "https" };
  if (!credential) {
    await verifyOriginDestination(root, origin, protocol, options.signal);
    if (options.authorize) await options.authorize();
    return runGit(root, ["-c", `http.${origin}.followRedirects=false`, ...args], undefined, protocol, options.signal);
  }
  if (credential.origin !== origin) throw new SyncError("The saved GitHub credential belongs to a different origin.");
  const hooks = await mkdtemp(join(tmpdir(), "okb-sync-hooks-"));
  try {
    const { args: authArgs, env } = gitHubSyncTransport(credential, hooks);
    // Check the destinations using the same configuration environment as the
    // transport, with no credential present in the verification processes.
    await verifyOriginDestination(root, origin, { ...protocol, ...env, GIT_ALLOW_PROTOCOL: "https", OKB_SYNC_AUTH_HEADER: undefined }, options.signal);
    if (options.authorize) await options.authorize();
    try {
      const result = await runGit(root, [...authArgs, ...args], undefined, { ...protocol, ...env, GIT_ALLOW_PROTOCOL: "https" }, options.signal);
      if (result.code === 0) return { code: 0, stdout: "", stderr: "" };
    } catch { /* A child error can contain request diagnostics. */ }
    const action = args[0] === "push" ? "push failed (changes are committed locally)" : "fetch failed";
    throw new SyncError(`GitHub ${action}. Check repository access and the saved token's permissions and expiration.`);
  } finally {
    await rmdir(hooks).catch(() => {});
  }
}

// Seeded into the bundle's git files on every sync (ensure, never remove).
const IGNORE_LINES = [".okb/", "/viz.html", "db_only/"];
const IGNORE_HEADER = "# okb sync keeps these entries present; add your own freely.";
const ATTR_LINES = ["* text=auto eol=lf"];
const ATTR_HEADER = "# Normalize to LF so diffs and content hashes are stable across OSes.";

export const privatePath = (id: string) => `${id}.md`;
export const gitPathEquals = (path: string) => process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;

async function notePathsHaveHistory(root: string, paths: string[]): Promise<boolean> {
  for (let index = 0; index < paths.length; index += 32) {
    const pathsInHistory = await git(root, ["--literal-pathspecs", "log", "--all", "-1", "--format=%H", "--", ...paths.slice(index, index + 32)]);
    if (pathsInHistory.trim()) return true;
  }
  return false;
}

async function localExcludes(root: string, ids: ReadonlySet<string>): Promise<void> {
  if (!ids.size) return;
  const path = resolve(root, (await git(root, ["rev-parse", "--git-path", "info/exclude"])).trimEnd());
  const lines = [...ids].map((id) => `/${privatePath(id).replace(/[\\!*[\]? ]/g, "\\$&")}`);
  await ensureLines(dirname(path), posix.basename(path.replaceAll("\\", "/")), "# Local Git excludes", lines);
}

/** An owner can mark unpublished notes only. Existing tracked content needs an explicit Git workflow. */
export async function protectUnsharedNote(root: string, id: string): Promise<void> {
  await checkPrivacyPath(root, id);
  let ancestor = realpathSync(root);
  while (!existsSync(join(ancestor, ".git"))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
  const top = await repoRoot(root);
  if (top === null || !sameDir(top, root))
    throw new SyncError("This note is inside a different Git repository. Use a separate brain for private notes.");
  const path = privatePath(id);
  const tracked = await git(root, ["--literal-pathspecs", "ls-files", "-z", "--", path]);
  if (tracked || await notePathsHaveHistory(root, [path]))
    throw new SyncError("Git already tracks this note or has it in history. Its Git history needs explicit review before changing privacy.");
  await localExcludes(root, new Set([id]));
}

export async function privateNotesForSync(root: string): Promise<Set<string>> {
  const marked = new Set<string>();
  for (const id of await listConcepts(root)) {
    if (inDbOnlyDir(id.toLowerCase())) continue;
    const { doc } = await readConceptPermissive(root, id);
    if (doc.frontmatter.db_only === true) {
      if (/[\x00-\x1f\x7f]/.test(id)) throw new SyncError("A private note has an unsupported path. Review it before syncing.");
      marked.add(id);
    }
  }
  return marked;
}

export async function verifyPrivatePaths(root: string, marked: ReadonlySet<string>): Promise<void> {
  const privatePaths = new Set([...marked].map((id) => gitPathEquals(privatePath(id))));
  const tracked = (await git(root, ["ls-files", "-z"])).split("\0");
  if (tracked.some((path) => inDbOnlyDir(path.toLowerCase()) || privatePaths.has(gitPathEquals(path))))
    throw new SyncError("Git tracks a private path. Review the repository before syncing. okbrain kept its Git staging and history intact.");
  if (await notePathsHaveHistory(root, [...marked].map(privatePath)))
    throw new SyncError("Git history contains a private note path. Review the repository before syncing.");
}

export async function verifyPrivateDirectoryHistory(root: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const found = await runGit(root, ["log", "--all", "--full-history", "-1", "--format=%H", "--", ":(glob,icase)**/db_only/**"], undefined, env);
  if (found.code !== 0) throw new SyncError("Unable to check the repository history for private paths.");
  if (found.stdout.trim()) throw new SyncError("Git history contains a db_only directory. Review the repository history before syncing.");
}

export async function verifyNoPrivateStagedNotes(root: string): Promise<void> {
  const changed = await git(root, ["diff", "--cached", "--text", "-G", "db_only", "--name-only", "-z", "--diff-filter=ACMR", "--", "*.md"]);
  for (const path of changed.split("\0").filter(Boolean)) {
    const text = await git(root, ["show", `:${path}`]);
    try {
      if (parse(text).frontmatter.db_only === true)
        throw new SyncError("Git stages a private note. Review the index before syncing. okbrain kept its Git staging and history intact.");
    } catch (error) { if (!(error instanceof OkfParseError)) throw error; }
  }
}

/** Stage explicit eligible paths so repository ignore negations cannot expose private notes. */
async function stagePublicPaths(root: string, privatePaths: ReadonlySet<string>): Promise<void> {
  const candidates = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const selected = [...new Set(candidates.split("\0").filter((path) => path &&
    !inDbOnlyDir(path.toLowerCase()) && !privatePaths.has(gitPathEquals(path))))];
  if (selected.length)
    await git(root, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
      selected.map((path) => `:(top,literal)${path}`).join("\0") + "\0");
}

/** Append any missing `lines` to `<root>/<name>` (created with `header`). */
async function ensureLines(
  root: string,
  name: string,
  header: string,
  lines: string[],
): Promise<boolean> {
  const path = join(root, name);
  let text = "";
  try {
    text = (await readFile(path, "utf8")).replace(/\r\n?/g, "\n");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const have = new Set(text.split("\n").map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (missing.length === 0) return false;
  const head = text === "" ? header + "\n" : text.endsWith("\n") ? text : text + "\n";
  await writeFile(path, head + missing.join("\n") + "\n", "utf8");
  return true;
}

export interface SyncStatus {
  repo: boolean;
  branch: string | null;
  /** Changed + untracked paths (`git status --porcelain` lines). */
  dirty: number;
  remote: string | null;
  /** Commits vs upstream; null when no upstream is configured. */
  ahead: number | null;
  behind: number | null;
}

export async function syncStatus(root: string): Promise<SyncStatus> {
  const top = await repoRoot(root);
  if (top === null || !sameDir(top, root))
    return { repo: false, branch: null, dirty: 0, remote: null, ahead: null, behind: null };
  const branch = (await runGit(root, ["symbolic-ref", "--short", "HEAD"])).stdout.trim() || null;
  const dirty = (await git(root, ["status", "--porcelain"]))
    .split("\n")
    .filter((l) => l !== "").length;
  const remoteR = await runGit(root, ["remote", "get-url", "origin"]);
  const lr = await runGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  const counts = lr.code === 0 ? lr.stdout.trim().split(/\s+/).map(Number) : null;
  return {
    repo: true,
    branch,
    dirty,
    remote: remoteR.code === 0 ? displayRemote(remoteR.stdout.trim()) : null,
    ahead: counts?.[0] ?? null,
    behind: counts?.[1] ?? null,
  };
}

export interface SyncResult {
  initialized: boolean;
  /** Seed files created or amended this run (.gitignore / .gitattributes). */
  seeded: string[];
  /** Short hash of the commit made, or null when the tree was clean. */
  committed: string | null;
  pulled: boolean;
  pushed: boolean;
  remote: string | null;
}

/** Init if needed, seed ignore/attribute lines, commit, then pull+push if a remote is set. */
export function syncBundle(root: string, message?: string, useSavedGitHubCredential = false): Promise<SyncResult> {
  return withSyncRepository(root, (canonical) => syncRepository(canonical, message, useSavedGitHubCredential));
}

async function syncRepository(root: string, message: string | undefined, useSavedGitHubCredential: boolean): Promise<SyncResult> {
  if (brainEnclosesGitHubSyncStore(root))
    throw new SyncError("This brain contains the local GitHub credential directory. Sync a separate brain folder to keep credentials private.");
  const top = await repoRoot(root);
  if (top !== null && !sameDir(top, root))
    throw new SyncError(
      `bundle is inside another git repository (${top}); okb sync manages the bundle as its own repo — move the bundle out or sync it with that repo's own workflow`,
    );
  const initialized = top === null;
  if (!initialized && await syncRebaseInProgress(root))
    throw new SyncError("A Git rebase is in progress. Open Sync recovery in Settings before syncing again.");
  if (!(await gitIdentity(root)).identityReady)
    throw new SyncError("Git author and committer are unavailable. Save Git identity in Settings before syncing.");
  if (initialized) await initializeRepository(root);
  const managed = (await configValues(root, "okbrain.syncRemote", true)).at(-1);
  if (managed) await verifyOriginDestination(root, newOrigin(managed));
  const saved = useSavedGitHubCredential && managed && syncGitHubRepository(managed) ? readGitHubCredential(root) : null;
  const credential = saved?.origin === managed ? saved : null;

  const marked = await privateNotesForSync(root);
  const privatePaths = new Set([...marked].map((id) => gitPathEquals(privatePath(id))));
  await verifyPrivatePaths(root, marked);
  if ((await runGit(root, ["remote", "get-url", "origin"])).code === 0)
    await verifyPrivateDirectoryHistory(root);
  await verifyNoPrivateStagedNotes(root);
  await localExcludes(root, marked);
  if (marked.size) {
    await regenerateIndexBranches(root, [...marked].map((id) => posix.dirname(id) === "." ? "" : posix.dirname(id)));
    await removePrivateLogEntries(root, marked);
  }

  const seeded: string[] = [];
  if (await ensureLines(root, ".gitignore", IGNORE_HEADER, IGNORE_LINES))
    seeded.push(".gitignore");
  if (await ensureLines(root, ".gitattributes", ATTR_HEADER, ATTR_LINES))
    seeded.push(".gitattributes");

  await stagePublicPaths(root, privatePaths);
  await verifyPrivatePaths(root, await privateNotesForSync(root));
  await verifyNoPrivateStagedNotes(root);
  let committed: string | null = null;
  const staged = (await git(root, ["diff", "--cached", "--name-only", "-z"])).length > 0;
  if (staged) {
    await git(root, ["commit", "-m", message ?? `okb sync ${nowTimestamp()}`]);
    committed = (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
  }

  const remoteR = await runGit(root, ["remote", "get-url", "origin"]);
  const remote = remoteR.code === 0 ? displayRemote(remoteR.stdout.trim()) : null;
  const branch = (await runGit(root, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  let pulled = false;
  let pushed = false;
  if (remote !== null && branch !== "") {
    const hasUpstream =
      (await runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"])).code === 0;
    const managedNetwork = (args: ["fetch" | "push", ...string[]]) => managedGitTransport(root, managed!, args, credential);
    if (hasUpstream) {
      let upstream = "@{upstream}";
      if (managed) {
        upstream = (await git(root, ["rev-parse", "--symbolic-full-name", upstream])).trim();
        if ((await configValues(root, `branch.${branch}.remote`)).at(-1) !== "origin" || upstream !== `refs/remotes/origin/${branch}`)
          throw new SyncError("The current branch tracks a different destination. Review the branch's Git configuration before syncing.");
        const fetched = await managedNetwork(["fetch", "--no-recurse-submodules", "origin"]);
        if (fetched.code !== 0) throw new SyncError(`git fetch failed: ${gitDiagnostic(fetched)}`);
      } else if (marked.size) {
        await git(root, ["fetch"]);
      }
      if (marked.size) {
        const paths = (await git(root, ["ls-tree", "-r", "--name-only", "-z", upstream])).split("\0");
        if (paths.some((path) => inDbOnlyDir(path.toLowerCase()) || privatePaths.has(gitPathEquals(path))))
          throw new SyncError("An upstream file conflicts with a local private note. Review the repository before syncing.");
      }
      const pull = await runGit(root, managed || marked.size ? ["rebase", upstream] : ["pull", "--rebase"]);
      if (pull.code !== 0)
        throw new SyncError(
          `git pull --rebase failed (local commits are safe): ${gitDiagnostic(pull)}\nOpen Sync recovery in Settings, then rerun sync.`,
        );
      pulled = true;
    }
    await verifyPrivatePaths(root, await privateNotesForSync(root));
    await verifyPrivateDirectoryHistory(root);
    const push = managed
      ? await managedNetwork(["push", "--no-recurse-submodules", ...(hasUpstream ? [] : ["-u"]), "origin", `refs/heads/${branch}:refs/heads/${branch}`])
      : await runGit(root, hasUpstream ? ["push"] : ["push", "-u", "origin", `refs/heads/${branch}`]);
    if (push.code !== 0)
      throw new SyncError(
        `git push failed (changes are committed locally): ${gitDiagnostic(push)}`,
      );
    pushed = true;
  }
  return { initialized, seeded, committed, pulled, pushed, remote };
}
