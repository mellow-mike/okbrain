// Git-backed sync (Stage 1.5): the bundle is its own git repo; multi-device
// sync IS git. Every invocation spawns git by argv (no shell strings, per
// CLAUDE.md), seeds the bundle's .gitignore (derived + private paths) and
// .gitattributes (LF pinning — Windows autocrlf must never rewrite bundle
// bytes, or Stage-2 content-hashes silently churn), commits local changes,
// and pulls/pushes when an `origin` remote is configured.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { listConcepts, readConceptPermissive } from "./okf/bundle.ts";
import { OkfParseError, parse } from "./okf/document.ts";
import { regenerateIndexBranches } from "./okf/indexmd.ts";
import { removePrivateLogEntries } from "./okf/logmd.ts";
import { inDbOnlyDir } from "./okf/paths.ts";
import { checkPrivacyPath } from "./okf/privacy.ts";
import { nowTimestamp } from "./okf/write.ts";

export class SyncError extends Error {}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn git by argv. Never throws on nonzero exit — callers decide. */
function runGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((done, fail) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        // Never hang on a credential prompt; fail fast so the CLI stays usable.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const r = await runGit(cwd, args, input);
  if (r.code !== 0)
    throw new SyncError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** Toplevel of the repo containing `dir`, or null when not in one. */
async function repoRoot(dir: string): Promise<string | null> {
  const r = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

// Symlinks (macOS /tmp) and 8.3 short names (Windows temp) make naive string
// comparison lie; realpath both sides and fold case on win32.
function sameDir(a: string, b: string): boolean {
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

// Seeded into the bundle's git files on every sync (ensure, never remove).
const IGNORE_LINES = [".okb/", "/viz.html", "db_only/"];
const IGNORE_HEADER = "# okb sync keeps these entries present; add your own freely.";
const ATTR_LINES = ["* text=auto eol=lf"];
const ATTR_HEADER = "# Normalize to LF so diffs and content hashes are stable across OSes.";

const privatePath = (id: string) => `${id}.md`;
const gitPathEquals = (path: string) => process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;

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

async function privateNotesForSync(root: string): Promise<Set<string>> {
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

async function verifyPrivatePaths(root: string, marked: ReadonlySet<string>): Promise<void> {
  const privatePaths = new Set([...marked].map((id) => gitPathEquals(privatePath(id))));
  const tracked = (await git(root, ["ls-files", "-z"])).split("\0");
  if (tracked.some((path) => inDbOnlyDir(path.toLowerCase()) || privatePaths.has(gitPathEquals(path))))
    throw new SyncError("Git tracks a private path. Review the repository before syncing. okbrain kept its Git staging and history intact.");
  if (await notePathsHaveHistory(root, [...marked].map(privatePath)))
    throw new SyncError("Git history contains a private note path. Review the repository before syncing.");
}

async function verifyNoPrivateStagedNotes(root: string): Promise<void> {
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
    remote: remoteR.code === 0 ? remoteR.stdout.trim() : null,
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
export async function syncBundle(root: string, message?: string): Promise<SyncResult> {
  const top = await repoRoot(root);
  if (top !== null && !sameDir(top, root))
    throw new SyncError(
      `bundle is inside another git repository (${top}); okb sync manages the bundle as its own repo — move the bundle out or sync it with that repo's own workflow`,
    );
  const initialized = top === null;
  if (initialized) {
    await git(root, ["init"]);
    // Portable default-branch name (git init -b needs ≥2.28).
    await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }

  const marked = await privateNotesForSync(root);
  const privatePaths = new Set([...marked].map((id) => gitPathEquals(privatePath(id))));
  await verifyPrivatePaths(root, marked);
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
    if ((await runGit(root, ["var", "GIT_COMMITTER_IDENT"])).code !== 0)
      throw new SyncError(
        'git identity is not configured — set it once with `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`',
      );
    await git(root, ["commit", "-m", message ?? `okb sync ${nowTimestamp()}`]);
    committed = (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
  }

  const remoteR = await runGit(root, ["remote", "get-url", "origin"]);
  const remote = remoteR.code === 0 ? remoteR.stdout.trim() : null;
  const branch = (await runGit(root, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  let pulled = false;
  let pushed = false;
  if (remote !== null && branch !== "") {
    const hasUpstream =
      (await runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"])).code === 0;
    if (hasUpstream) {
      if (marked.size) {
        await git(root, ["fetch"]);
        const upstream = (await git(root, ["ls-tree", "-r", "--name-only", "-z", "@{upstream}"])).split("\0");
        if (upstream.some((path) => inDbOnlyDir(path.toLowerCase()) || privatePaths.has(gitPathEquals(path))))
          throw new SyncError("An upstream file conflicts with a local private note. Review the repository before syncing.");
      }
      const pull = await runGit(root, marked.size ? ["rebase", "@{upstream}"] : ["pull", "--rebase"]);
      if (pull.code !== 0)
        throw new SyncError(
          `git pull --rebase failed (local commits are safe): ${(pull.stderr || pull.stdout).trim()}\nresolve in the bundle with git, then rerun okb sync`,
        );
      pulled = true;
    }
    await verifyPrivatePaths(root, await privateNotesForSync(root));
    const push = await runGit(root, hasUpstream ? ["push"] : ["push", "-u", "origin", branch]);
    if (push.code !== 0)
      throw new SyncError(
        `git push failed (changes are committed locally): ${(push.stderr || push.stdout).trim()}`,
      );
    pushed = true;
  }
  return { initialized, seeded, committed, pulled, pushed, remote };
}
