import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BrainMountError } from "./brain-mounts.ts";
import { githubBranch } from "./coding/github.ts";
import { listBrains, loadConfig } from "./config.ts";
import { runDoctor } from "./okf/doctor.ts";
import { OkfParseError, parse } from "./okf/document.ts";
import { inDbOnlyDir, portablePathKey } from "./okf/paths.ts";
import { parseGitHubSyncCredential, syncGitHubRepository } from "./sync-credentials.ts";
import { managedGitTransport, managedOriginConfig, originForSetup, runGit, SyncError, verifyPrivateDirectoryHistory } from "./sync.ts";

export interface RestoreGitHubBrainInput {
  name: string;
  parent: string;
  url: string;
  branch: string;
  login?: string;
  token?: string;
}

export interface RestoredGitHubBrain { path: string; origin: string; branch: string; commit: string }

const gitSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const maxFiles = 10_000;
const maxFileBytes = 16 * 1024 * 1024;
const maxTreeBytes = 256 * 1024 * 1024;
const reservedFile = /^(?:(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)|(?:\.git|git)~[0-9]+$)/iu;

async function info(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function isInside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return !isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`);
}

function isolatedGit(config: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    if ((upper.startsWith("GIT_") && upper !== "GIT_SSL_CAINFO" && upper !== "GIT_SSL_CAPATH") ||
        upper === "OKB_SYNC_AUTH_HEADER" || upper === "SSH_ASKPASS" || upper === "SSLKEYLOGFILE") env[key] = undefined;
  }
  return { ...env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "https" };
}

async function destinationParent(value: string): Promise<string> {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/u.test(value) || !isAbsolute(value) ||
      /^[/\\]{2}/u.test(value) || (process.platform === "win32" && !/^[a-z]:[/\\]/iu.test(value)))
    throw new SyncError("Choose the absolute path of an existing local destination folder.");
  const parent = await realpath(value).catch(() => undefined);
  if (!parent || !(await info(parent))?.isDirectory()) throw new SyncError("Choose an existing local destination folder.");
  const registered = [...listBrains().map(({ path }) => path), loadConfig().defaultBundle].filter((path): path is string => Boolean(path));
  for (const path of registered) {
    const canonical = await realpath(path).catch(() => resolve(path));
    if (isInside(canonical, parent)) throw new SyncError("Choose a destination outside your existing brains.");
  }
  let ancestor = parent;
  for (;;) {
    if (await info(join(ancestor, ".git"))) throw new SyncError("Choose a destination outside an existing Git worktree.");
    const above = dirname(ancestor);
    if (above === ancestor) break;
    ancestor = above;
  }
  const repository = await runGit(parent, ["rev-parse", "--is-bare-repository"], undefined, isolatedGit(""));
  if (repository.code === 0) throw new SyncError("Choose a destination outside an existing Git repository.");
  return parent;
}

function validateTree(tree: string): string[] {
  const paths = new Map<string, { name: string; file: boolean }>();
  const markdown: string[] = [];
  let count = 0;
  let size = 0;
  let rootIndex = false;
  for (const entry of tree.split("\0")) {
    if (!entry) continue;
    const record = /^100(?:644|755) blob [0-9a-f]{40}(?:[0-9a-f]{24})? +([0-9]+)\t([^\t\r\n]+)$/u.exec(entry);
    if (!record || !record[2]) throw new SyncError("The selected branch must contain ordinary files without symlinks or submodules.");
    const path = record[2];
    if (path.length > 4096 || /[<>:"\\|?*\x00-\x1f\x7f\ufffd]/u.test(path) || inDbOnlyDir(path.toLowerCase()))
      throw new SyncError("The selected branch contains a private or unsupported file path.");
    let prefix = "";
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      const folded = portablePathKey(part);
      if (!part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ") || folded === ".git" ||
          folded === ".okb" || reservedFile.test(part) || Buffer.byteLength(part) > 255)
        throw new SyncError("The selected branch contains a private or unsupported file path.");
      prefix = prefix ? `${prefix}/${part}` : part;
      const key = portablePathKey(prefix);
      const previous = paths.get(key);
      const file = index === parts.length - 1;
      if (previous && (previous.name !== prefix || previous.file || file))
        throw new SyncError("The selected branch contains paths that alias on another filesystem.");
      if (!previous) paths.set(key, { name: prefix, file });
    }
    const bytes = Number(record[1]);
    size += bytes;
    if (++count > maxFiles || bytes > maxFileBytes || size > maxTreeBytes)
      throw new SyncError("Restore supports up to 10,000 tracked files, 16 MiB per file, and 256 MiB of checked-out data.");
    rootIndex ||= path === "index.md";
    if (path.toLowerCase().endsWith(".md")) markdown.push(path);
  }
  if (!rootIndex) throw new SyncError("The selected branch is missing the brain's root index.md.");
  return markdown;
}

function requireWrite(canWrite: () => boolean): void {
  if (!canWrite()) throw new SyncError("The selected brain is no longer writable.");
}

async function stageIntact(path: string, identity: Stats) {
  const current = await info(path);
  return current?.isDirectory() && current.dev === identity.dev && current.ino === identity.ino && await realpath(path) === path;
}

async function checkStage(path: string, identity: Stats, canWrite: () => boolean) {
  if (!await stageIntact(path, identity)) throw new SyncError("The restore folder changed while Git was working.");
  requireWrite(canWrite);
}

async function restoreGit(path: string, args: string[], env: NodeJS.ProcessEnv, message: string): Promise<string> {
  try {
    const result = await runGit(path, args, undefined, env);
    if (result.code === 0) return result.stdout;
  } catch { /* Leave Git diagnostics out of restore responses. */ }
  throw new SyncError(message);
}

async function verifyCheckout(path: string, markdown: string[]) {
  try { new TextDecoder("utf-8", { fatal: true }).decode(await readFile(join(path, "index.md"))); }
  catch { throw new SyncError("The selected branch needs a readable UTF-8 root index.md."); }
  const report = await runDoctor(path);
  if (!report.ok || (report.okfVersion !== null && report.okfVersion !== "0.2" && report.okfVersion !== "0.1") ||
      (report.okfVersion === null && report.concepts === 0))
    throw new SyncError("The selected branch does not contain a recognizable OKF brain. Check its index and note frontmatter.");
  // Scan all tracked Markdown, including files outside the normal visible-note walk.
  for (const file of markdown) {
    const raw = await readFile(join(path, ...file.split("/")), "utf8");
    try {
      if (parse(raw).frontmatter.db_only === true)
        throw new SyncError("The selected branch tracks private notes. Review the remote before restoring it.");
    } catch (error) { if (!(error instanceof OkfParseError)) throw error; }
  }
}

/** Fetch into a new private checkout. Its caller is responsible for registering a successful restore. */
export async function restoreGitHubBrain(
  input: RestoreGitHubBrainInput, canWrite: () => boolean,
): Promise<RestoredGitHubBrain> {
  let path: string | undefined;
  let identity: Stats | undefined;
  try {
    if (typeof input.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(input.name))
      throw new SyncError("Choose a brain name using 1–64 letters, digits, periods, hyphens, or underscores.");
    const origin = originForSetup(input.url);
    if (!syncGitHubRepository(origin)) throw new SyncError("Choose a GitHub.com repository HTTPS URL.");
    let branch: string;
    try { branch = githubBranch(input.branch); }
    catch { throw new SyncError("Enter a valid GitHub branch name."); }
    if (branch === "HEAD") throw new SyncError("Enter the repository branch name instead of HEAD.");
    const credential = input.login || input.token ? parseGitHubSyncCredential(origin, input.login, input.token) : null;
    requireWrite(canWrite);
    const parent = await destinationParent(input.parent);
    requireWrite(canWrite);
    path = await mkdtemp(join(parent, `okbrain-${input.name}-`));
    identity = await lstat(path);
    const dotGit = join(path, ".git");
    const config = join(dotGit, "okbrain-restore-empty-config");
    await mkdir(dotGit, { mode: 0o700 });
    await writeFile(config, "", { flag: "wx", mode: 0o600 });
    const env = isolatedGit(config);
    const setupFailure = "Unable to initialize a private local Git checkout.";
    const restoreFailure = "Unable to check out the verified GitHub branch.";
    await restoreGit(path, ["init", "--quiet", "--template="], env, setupFailure);
    for (const [key, value] of managedOriginConfig(origin))
      await restoreGit(path, ["config", "--local", "--replace-all", key, value], env, setupFailure);
    const infoFolder = join(dotGit, "info");
    await mkdir(infoFolder, { recursive: true, mode: 0o700 });
    await writeFile(join(infoFolder, "exclude"), "/.okb/\n", { mode: 0o600 });

    const tracking = `refs/remotes/origin/${branch}`;
    await checkStage(path, identity, canWrite);
    try {
      const fetched = await managedGitTransport(path, origin, [
        "fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-gc", "origin", `refs/heads/${branch}:${tracking}`,
      ], credential, env);
      if (fetched.code !== 0) throw new SyncError("GitHub fetch failed.");
    } catch {
      throw new SyncError("Unable to fetch this GitHub branch. Check the repository, branch name, and any credential permissions.");
    }

    const inspectFailure = "Unable to verify the selected GitHub branch commit or its files.";
    const commit = (await restoreGit(path, ["rev-parse", "--verify", `${tracking}^{commit}`], env, inspectFailure)).trim();
    if (!gitSha.test(commit)) throw new SyncError("Unable to verify the selected GitHub branch commit.");
    const markdown = validateTree(await restoreGit(path, ["ls-tree", "--full-tree", "-r", "-l", "-z", commit], env, inspectFailure));
    await verifyPrivateDirectoryHistory(path, env);
    await checkStage(path, identity, canWrite);
    await restoreGit(path, ["-c", "core.protectHFS=true", "-c", "core.protectNTFS=true", "-c", "core.autocrlf=false", "checkout", "--quiet",
      "--no-recurse-submodules", "-b", branch, "--track", tracking], env, restoreFailure);
    const head = (await restoreGit(path, ["rev-parse", "--verify", "HEAD"], env, restoreFailure)).trim();
    const upstream = (await restoreGit(path, ["rev-parse", "--symbolic-full-name", "@{upstream}"], env, restoreFailure)).trim();
    if (head !== commit || upstream !== tracking) throw new SyncError("Unable to establish the restored branch's GitHub tracking information.");
    await verifyCheckout(path, markdown);
    await checkStage(path, identity, canWrite);
    await unlink(config);
    return { path, origin, branch, commit };
  } catch (error) {
    if (path && identity && await stageIntact(path, identity).catch(() => false))
      await rm(path, { recursive: true, force: true }).catch(() => {});
    if (error instanceof SyncError || error instanceof BrainMountError) throw error;
    if (error instanceof TypeError && /^Enter (?:your GitHub login|a fine-grained GitHub personal access token)\.$/u.test(error.message))
      throw new SyncError(error.message);
    throw new SyncError("Unable to restore this brain. Check Git, the destination folder, and the selected branch.");
  }
}
