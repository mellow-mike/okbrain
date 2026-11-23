import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { portablePathKey } from "../okf/paths.ts";
import { parseGitHubSyncCredential, syncGitHubRepository, type GitHubSyncCredential } from "../sync-credentials.ts";
import { managedGitTransport, originForSetup, runGit } from "../sync.ts";
import { GitHubError, githubBranch } from "./github.ts";

export interface CodingGitHubCheckoutInput { url: unknown; branch?: unknown; tag?: unknown; login?: unknown; token?: unknown }
export interface CodingGitHubCheckoutOptions { directory: string; canWrite: () => boolean; signal: AbortSignal }
type CheckoutSource = { origin: string; repository: string } & ({ branch: string; tag?: never } | { tag: string; branch?: never });
type CheckoutReceipt = CheckoutSource & { version: 1; commit: string };
export type CodingGitHubCheckout = CheckoutSource & { workspace: string; commit: string; reused: boolean };

const maxFiles = 10_000;
const maxFileBytes = 16 * 1024 * 1024;
const maxLinkBytes = 4096;
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

function isCommit(value: unknown): value is string {
  return typeof value === "string" && value.length === 40 && gitSha.test(value);
}

function pinnedTag(input: unknown): { tag: string; expectedCommit: string } {
  const invalid = () => new GitHubError("Enter a GitHub tag name and its full pinned commit ID.");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2) throw invalid();
  const { name, commit } = input as Record<string, unknown>;
  if (!isCommit(commit) || typeof name !== "string" || name === "HEAD" || name !== name.trim()) throw invalid();
  try { return { tag: githubBranch(name), expectedCommit: commit }; }
  catch { throw invalid(); }
}

function sourceOf(input: CodingGitHubCheckoutInput): CheckoutSource & { credential: GitHubSyncCredential | null; expectedCommit?: string } {
  const { url, branch: rawBranch, tag, login, token } = input;
  if (typeof url !== "string" || url !== url.trim() ||
      !/^https:\/\/github\.com\/[a-z0-9-]{1,39}\/[a-z0-9._-]{1,104}\/?$/i.test(url))
    throw new GitHubError("Enter a GitHub.com repository HTTPS URL without credentials, query, or fragment.");
  let repository: string | undefined;
  try { repository = syncGitHubRepository(originForSetup(url))?.toLowerCase(); }
  catch { /* Use the same user-facing error without returning the supplied URL. */ }
  if (!repository) throw new GitHubError("Enter a GitHub.com repository HTTPS URL without credentials, query, or fragment.");
  const origin = `https://github.com/${repository}.git`;
  if ((rawBranch === undefined) === (tag === undefined)) throw new GitHubError("Choose one GitHub branch or one pinned tag.");
  if ((login !== undefined && typeof login !== "string") || (token !== undefined && typeof token !== "string"))
    throw new GitHubError("Enter both a GitHub login and a fine-grained token for a private repository.");
  const credentialGiven = Boolean(login?.trim() || token?.trim());
  let credential = null;
  if (credentialGiven) {
    try { credential = parseGitHubSyncCredential(origin, login, token); }
    catch { throw new GitHubError("Enter both a GitHub login and a fine-grained token for a private repository."); }
  }
  if (tag !== undefined) return { origin, repository, credential, ...pinnedTag(tag) };
  const branch = githubBranch(rawBranch);
  if (branch === "HEAD" || branch !== branch.trim()) throw new GitHubError("Enter a valid GitHub branch name instead of HEAD.");
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
    GIT_ATTR_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "", GIT_LFS_SKIP_SMUDGE: "1", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_HTTP_LOW_SPEED_LIMIT: "1024", GIT_HTTP_LOW_SPEED_TIME: "10" };
}

function checkTree(listing: string, pinned: boolean): string[] {
  const paths = new Map<string, { path: string; file: boolean }>();
  const reserved = /^(?:\.git|\.okb|(?:\.git|git)~[0-9]+|(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?)$/iu;
  const links: string[] = [];
  let bytes = 0;
  let count = 0;
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const match = /^(100644|100755|120000) blob [a-f0-9]{40} +([0-9]+)\t([^\t\r\n]+)$/u.exec(entry);
    const path = match?.[3];
    const link = match?.[1] === "120000";
    if (!match || !path || (link && !pinned))
      throw new GitHubError(pinned ? "Use a pinned tag with regular files or link text and no submodules."
        : "Use a branch with regular files and no submodules or symlinks.", 409);
    const size = Number(match[2]);
    if (++count > maxFiles || size > maxFileBytes || (bytes += size) > maxCheckoutBytes) throw checkoutTooLarge();
    if (link && size > maxLinkBytes) throw new GitHubError("The pinned tag contains oversized symbolic link text.", 409);
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
    if (link) links.push(path);
  }
  return links;
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

function checkoutRefs(source: CheckoutSource) {
  if (source.tag !== undefined) {
    const tag = `refs/tags/${source.tag}`;
    return { remote: tag, local: tag };
  }
  return { remote: `refs/heads/${source.branch}`, local: `refs/remotes/origin/${source.branch}` };
}

async function fetchSource(
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
    const { remote, local } = checkoutRefs(source);
    const result = await managedGitTransport(path, source.origin, [
      "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-auto-gc",
      "origin", `${remote}:${local}`,
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
    const kind = source.tag === undefined ? "branch" : "tag";
    throw new GitHubError(`Unable to fetch this GitHub ${kind}. Check its name, repository access, and any credential permissions.`, 409);
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

async function readCheckout(
  path: string, source: CheckoutSource, env: NodeJS.ProcessEnv, signal: AbortSignal, expectedCommit?: string,
): Promise<string> {
  try {
    if (!privateDirectory(await info(path)) || await realpath(path) !== path || !(await info(join(path, ".git")))?.isDirectory())
      throw pathChanged();
    const file = join(path, ".git", receiptName);
    const stat = await info(file);
    if (!stat?.isFile() || stat.size > 2048 || stat.nlink !== 1) throw pathChanged();
    const saved = JSON.parse(await readFile(file, "utf8")) as CheckoutReceipt;
    if (saved.version !== 1 || saved.origin !== source.origin || saved.repository !== source.repository ||
        saved.branch !== source.branch || saved.tag !== source.tag || !isCommit(saved.commit)) throw pathChanged();
    const git = (...args: string[]) => gitOutput(path, args, env, signal);
    const configured = await git("config", "--null", "--local", "--no-includes", "--get-all", "remote.origin.url");
    if (configured !== source.origin + "\0") throw pathChanged();
    const refs = checkoutRefs(source);
    if (source.tag !== undefined) {
      const tagged = await git("rev-parse", "--verify", `${refs.local}^{commit}`);
      const head = await git("rev-parse", "--verify", "HEAD");
      const headRef = await git("rev-parse", "--abbrev-ref", "HEAD");
      if (saved.commit !== expectedCommit || tagged.trim() !== saved.commit || head.trim() !== saved.commit || headRef.trim() !== "HEAD")
        throw pathChanged();
    } else {
      const head = await git("symbolic-ref", "--quiet", "HEAD");
      const upstream = await git("rev-parse", "--symbolic-full-name", "@{upstream}");
      if (head.trim() !== refs.remote || upstream.trim() !== refs.local) throw pathChanged();
    }
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
  const { credential, expectedCommit, ...source } = sourceOf(input);
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
    const identityKey = source.tag === undefined ? [source.origin, source.branch] : ["tag", source.origin, source.tag, expectedCommit];
    const key = createHash("sha256").update(JSON.stringify(identityKey)).digest("hex");
    const path = join(root, `checkout-${key}`);
    if (active.has(path)) throw new GitHubError("This GitHub checkout is in progress. Try again when it finishes.", 409);
    active.add(path);
    destination = path;
    const env = isolatedGit();
    if (await info(path)) {
      const commit = await readCheckout(path, source, env, signal, expectedCommit);
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
    const refs = checkoutRefs(source);
    if (source.tag === undefined) await git("config", "--local", "remote.origin.fetch", `+${refs.remote}:${refs.local}`);
    else await git("config", "--local", "core.symlinks", "false");
    await checkStage();
    await fetchSource(scratch, source, credential, env, signal, checkStage);
    await checkStage();
    const commit = (await git("rev-parse", "--verify", `${refs.local}^{commit}`)).trim();
    if (!isCommit(commit) || (expectedCommit !== undefined && commit !== expectedCommit))
      throw new GitHubError(expectedCommit ? "The GitHub tag does not match its pinned commit." : "Unable to verify the selected Git branch.", 409);
    const links = checkTree(await git("ls-tree", "--full-tree", "-r", "-l", "-z", commit), source.tag !== undefined);
    await checkStage();
    const checkout = source.tag === undefined ? ["-b", source.branch, "--track", refs.local] : ["--detach", commit];
    await git("-c", `core.hooksPath=${hooks}`, "-c", "core.protectHFS=true", "-c", "core.protectNTFS=true", "-c", "core.autocrlf=false",
      "checkout", "--quiet", "--no-recurse-submodules", ...checkout);
    const head = (await git("rev-parse", "--verify", "HEAD")).trim();
    if (source.tag === undefined) {
      const upstream = (await git("rev-parse", "--symbolic-full-name", "@{upstream}")).trim();
      if (head !== commit || upstream !== refs.local) throw new GitHubError("Unable to verify the selected Git branch and its upstream.", 409);
    } else {
      if (head !== commit || (await git("rev-parse", "--abbrev-ref", "HEAD")).trim() !== "HEAD")
        throw new GitHubError("Unable to verify the detached checkout of the pinned commit.", 409);
      for (const link of links) {
        if (!(await info(join(scratch, ...link.split("/"))))?.isFile())
          throw new GitHubError("Unable to materialize a pinned link as a regular file.", 409);
      }
    }
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
