import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { portablePathKey } from "../okf/paths.ts";
import { parseGitHubSyncCredential, syncGitHubRepository, type GitHubSyncCredential } from "../sync-credentials.ts";
import { managedGitTransport, originForSetup, runGit } from "../sync.ts";
import { GitHubError, githubBranch } from "./github.ts";

export interface CodingGitHubCheckoutInput { url: unknown; branch: unknown; login?: unknown; token?: unknown }
export interface CodingGitHubCheckoutOptions { directory: string; canWrite: () => boolean; signal: AbortSignal }
type CheckoutSource = { origin: string; repository: string; branch: string };
type CheckoutReceipt = CheckoutSource & { version: 1; commit: string };
export type CodingGitHubCheckout = CheckoutSource & { workspace: string; commit: string; reused: boolean };

const maxFiles = 10_000;
const maxFileBytes = 16 * 1024 * 1024;
const maxCheckoutBytes = 256 * 1024 * 1024;
const maxObjectBytes = 256 * 1024 * 1024;
const maxObjectEntries = 20_000;
const receiptName = "okbrain-checkout.json";
const gitSha = /^[a-f0-9]{40}$/u;
const active = new Set<string>();

const momentary = () => new GitHubError("The GitHub checkout stopped or ran out of time. Try again.", 409);
const pathChanged = () => new GitHubError("The managed checkout folder changed or is occupied. Check the workspace before retrying.", 409);
const checkoutTooLarge = () => new GitHubError("This branch exceeds the managed checkout limit of 10,000 files, 16 MiB per file, or 256 MiB total.", 409);

async function info(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function privateDirectory(stat: Stats | undefined): stat is Stats {
  return !!stat?.isDirectory() && (process.platform === "win32" || (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0));
}

async function intact(path: string, expected: Stats): Promise<boolean> {
  const current = await info(path);
  return privateDirectory(current) && current.dev === expected.dev && current.ino === expected.ino && await realpath(path) === path;
}

function sourceOf(input: CodingGitHubCheckoutInput): CheckoutSource & { credential: GitHubSyncCredential | null } {
  const { url, branch: rawBranch, login, token } = input;
  if (typeof url !== "string" || url !== url.trim() ||
      !/^https:\/\/github\.com\/[a-z0-9-]{1,39}\/[a-z0-9._-]{1,104}\/?$/i.test(url))
    throw new GitHubError("Enter a GitHub.com repository HTTPS URL without credentials, query, or fragment.");
  let repository: string | undefined;
  try { repository = syncGitHubRepository(originForSetup(url))?.toLowerCase(); }
  catch { /* Use the same user-facing error without returning the supplied URL. */ }
  if (!repository) throw new GitHubError("Enter a GitHub.com repository HTTPS URL without credentials, query, or fragment.");
  const origin = `https://github.com/${repository}.git`;
  const branch = githubBranch(rawBranch);
  if (branch === "HEAD" || branch !== branch.trim()) throw new GitHubError("Enter a valid GitHub branch name instead of HEAD.");
  if ((login !== undefined && typeof login !== "string") || (token !== undefined && typeof token !== "string"))
    throw new GitHubError("Enter both a GitHub login and a fine-grained token for a private repository.");
  const credentialGiven = Boolean(login?.trim() || token?.trim());
  let credential = null;
  if (credentialGiven) {
    try { credential = parseGitHubSyncCredential(origin, login, token); }
    catch { throw new GitHubError("Enter both a GitHub login and a fine-grained token for a private repository."); }
  }
  return { origin, repository, branch, credential };
}

function isolatedGit(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    if ((upper.startsWith("GIT_") && upper !== "GIT_SSL_CAINFO" && upper !== "GIT_SSL_CAPATH") ||
        upper === "OKB_SYNC_AUTH_HEADER" || upper === "SSH_ASKPASS" || upper === "SSLKEYLOGFILE") env[key] = undefined;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "https", GIT_LFS_SKIP_SMUDGE: "1", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_HTTP_LOW_SPEED_LIMIT: "1024", GIT_HTTP_LOW_SPEED_TIME: "10" };
}

function checkTree(listing: string): void {
  const paths = new Map<string, { path: string; file: boolean }>();
  const reserved = /^(?:\.git|\.okb|(?:\.git|git)~[0-9]+|(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?)$/iu;
  let bytes = 0;
  let count = 0;
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const match = /^100(?:644|755) blob [a-f0-9]{40} +([0-9]+)\t([^\t\r\n]+)$/u.exec(entry);
    const path = match?.[2];
    if (!match || !path) throw new GitHubError("Use a branch with regular files and no submodules or symlinks.", 409);
    const size = Number(match[1]);
    if (++count > maxFiles || size > maxFileBytes || (bytes += size) > maxCheckoutBytes) throw checkoutTooLarge();
    const parts = path.split("/");
    if (path.length > 4096 || parts.length > 64 || /[<>:"\\|?*\x00-\x1f\x7f\ufffd]/u.test(path))
      throw new GitHubError("The selected branch contains a path that cannot be checked out safely.", 409);
    let prefix = "";
    for (const [index, part] of parts.entries()) {
      if (!part || part.endsWith(".") || part.endsWith(" ") || reserved.test(part) || Buffer.byteLength(part) > 255)
        throw new GitHubError("The selected branch contains a path that cannot be checked out safely.", 409);
      prefix = prefix ? `${prefix}/${part}` : part;
      const key = portablePathKey(prefix);
      const before = paths.get(key);
      const file = index === parts.length - 1;
      if (before && (before.path !== prefix || before.file || file))
        throw new GitHubError("The selected branch has file paths that alias on another filesystem.", 409);
      if (!before) paths.set(key, { path: prefix, file });
    }
  }
}

async function withinObjectBudget(path: string, signal: AbortSignal): Promise<boolean> {
  const pending = [join(path, ".git", "objects")];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const current = pending.pop()!;
    const files = await readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    for (const entry of files) {
      signal.throwIfAborted();
      if (++entries > maxObjectEntries) return false;
      const child = join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) {
        const size = await info(child);
        // Git can rename a temporary pack during this scan.
        if (size && (bytes += size.size) > maxObjectBytes) return false;
      } else return false;
    }
  }
  return true;
}

async function fetchBranch(
  path: string, source: CheckoutSource, credential: GitHubSyncCredential | null, env: NodeJS.ProcessEnv,
  signal: AbortSignal, authorize: () => Promise<void>,
): Promise<void> {
  const budget = new AbortController();
  const bounded = AbortSignal.any([signal, budget.signal]);
  const inspect = async () => {
    try { if (!await withinObjectBudget(path, bounded)) budget.abort(); }
    catch { if (!bounded.aborted) budget.abort(); }
  };
  let scan: Promise<void> | undefined;
  const timer = setInterval(() => {
    scan ??= inspect().finally(() => { scan = undefined; });
  }, 150);
  try {
    const tracking = `refs/remotes/origin/${source.branch}`;
    const result = await managedGitTransport(path, source.origin, [
      "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-auto-gc",
      "origin", `refs/heads/${source.branch}:${tracking}`,
    ], credential, env, { signal: bounded, authorize });
    clearInterval(timer);
    await scan;
    await inspect();
    if (budget.signal.aborted) throw checkoutTooLarge();
    if (signal.aborted) throw momentary();
    if (result.code !== 0) throw new Error();
  } catch (error) {
    if (budget.signal.aborted) throw checkoutTooLarge();
    if (signal.aborted) throw momentary();
    if (error instanceof GitHubError) throw error;
    throw new GitHubError("Unable to fetch this GitHub branch. Check its name, repository access, and any credential permissions.", 409);
  } finally {
    clearInterval(timer);
    await scan;
  }
}

async function gitOutput(path: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  try {
    const result = await runGit(path, args, undefined, env, signal);
    if (result.code === 0) return result.stdout;
  } catch { /* Do not forward Git diagnostics, remote errors, or local paths. */ }
  if (signal.aborted) throw momentary();
  throw new GitHubError("Unable to prepare the managed Git checkout.", 409);
}

async function readCheckout(path: string, source: CheckoutSource, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  try {
    if (!privateDirectory(await info(path)) || await realpath(path) !== path || !(await info(join(path, ".git")))?.isDirectory())
      throw pathChanged();
    const file = join(path, ".git", receiptName);
    const stat = await info(file);
    if (!stat?.isFile() || stat.size > 2048 || stat.nlink !== 1) throw pathChanged();
    const saved = JSON.parse(await readFile(file, "utf8")) as CheckoutReceipt;
    if (saved.version !== 1 || saved.origin !== source.origin || saved.repository !== source.repository || saved.branch !== source.branch ||
        typeof saved.commit !== "string" || saved.commit.length !== 40 || !gitSha.test(saved.commit)) throw pathChanged();
    const configured = await gitOutput(path, ["config", "--null", "--local", "--no-includes", "--get-all", "remote.origin.url"], env, signal);
    const head = await gitOutput(path, ["symbolic-ref", "--quiet", "HEAD"], env, signal);
    const upstream = await gitOutput(path, ["rev-parse", "--symbolic-full-name", "@{upstream}"], env, signal);
    if (configured !== source.origin + "\0" || head.trim() !== `refs/heads/${source.branch}` ||
        upstream.trim() !== `refs/remotes/origin/${source.branch}`) throw pathChanged();
    return saved.commit;
  } catch {
    if (signal.aborted) throw momentary();
    throw pathChanged();
  }
}

/** Prepare an isolated, shallow checkout or reopen the same completed import without modifying it. */
export async function createCodingGitHubCheckout(
  input: CodingGitHubCheckoutInput, options: CodingGitHubCheckoutOptions,
): Promise<CodingGitHubCheckout> {
  const { credential, ...source } = sourceOf(input);
  const { directory, signal, canWrite } = options;
  const authorize = () => {
    if (signal.aborted) throw momentary();
    if (!canWrite()) throw new GitHubError("Open a writable brain to check out a repository.", 403);
  };
  authorize();
  let stage: string | undefined;
  let identity: Stats | undefined;
  let destination: string | undefined;
  try {
    if (!isAbsolute(directory)) throw pathChanged();
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const root = await realpath(directory);
    const rootIdentity = await info(directory);
    if (!privateDirectory(rootIdentity) || !await intact(root, rootIdentity)) throw pathChanged();
    const key = createHash("sha256").update(JSON.stringify([source.origin, source.branch])).digest("hex");
    const path = join(root, `checkout-${key}`);
    if (active.has(path)) throw new GitHubError("This GitHub checkout is in progress. Try again when it finishes.", 409);
    active.add(path);
    destination = path;
    const env = isolatedGit();
    if (await info(path)) {
      const commit = await readCheckout(path, source, env, signal);
      authorize();
      return { workspace: path, ...source, commit, reused: true };
    }

    authorize();
    stage = await mkdtemp(join(root, ".staging-"));
    identity = await lstat(stage);
    const scratch = stage;
    const git = (...args: string[]) => gitOutput(scratch, args, env, signal);
    const checkStage = async () => {
      if (!await intact(root, rootIdentity) || !await intact(scratch, identity!)) throw pathChanged();
      authorize();
    };
    await checkStage();
    await git("init", "--quiet", "--template=");
    const dotGit = join(scratch, ".git");
    const home = join(dotGit, "info");
    const hooks = join(dotGit, "okbrain-empty-hooks");
    await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(hooks, { mode: 0o700 })]);
    await writeFile(join(home, "attributes"), "* -filter -text -eol -ident -working-tree-encoding\n", { flag: "wx", mode: 0o600 });
    await git("config", "--local", "remote.origin.url", source.origin);
    const tracking = `refs/remotes/origin/${source.branch}`;
    await git("config", "--local", "remote.origin.fetch", `+refs/heads/${source.branch}:${tracking}`);
    await checkStage();
    await fetchBranch(scratch, source, credential, env, signal, checkStage);
    await checkStage();
    const commit = (await git("rev-parse", "--verify", `${tracking}^{commit}`)).trim();
    if (commit.length !== 40 || !gitSha.test(commit)) throw new GitHubError("Unable to verify the selected Git branch.", 409);
    checkTree(await git("ls-tree", "--full-tree", "-r", "-l", "-z", commit));
    await checkStage();
    await git("-c", `core.hooksPath=${hooks}`, "-c", "core.protectHFS=true", "-c", "core.protectNTFS=true", "-c", "core.autocrlf=false",
      "checkout", "--quiet", "--no-recurse-submodules", "-b", source.branch, "--track", tracking);
    const head = (await git("rev-parse", "--verify", "HEAD")).trim();
    const upstream = (await git("rev-parse", "--symbolic-full-name", "@{upstream}")).trim();
    if (head !== commit || upstream !== tracking) throw new GitHubError("Unable to verify the selected Git branch and its upstream.", 409);
    const receipt = { version: 1, ...source, commit } satisfies CheckoutReceipt;
    await writeFile(join(dotGit, receiptName), JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
    await checkStage();
    if (await info(path)) throw pathChanged();
    authorize();
    await rename(scratch, path);
    stage = undefined;
    return { workspace: path, ...source, commit, reused: false };
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    if (signal.aborted) throw momentary();
    throw new GitHubError("Unable to create the managed GitHub checkout. Check Git and the app data folder.", 409);
  } finally {
    if (stage && identity && await intact(stage, identity).catch(() => false))
      await rm(stage, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(() => {});
    if (destination) active.delete(destination);
  }
}
