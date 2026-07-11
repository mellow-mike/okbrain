// Git-backed sync (Stage 1.5): the bundle is its own git repo; multi-device
// sync IS git. Every invocation spawns git by argv (no shell strings, per
// CLAUDE.md), seeds the bundle's .gitignore (derived + private paths) and
// .gitattributes (LF pinning — Windows autocrlf must never rewrite bundle
// bytes, or Stage-2 content-hashes silently churn), commits local changes,
// and pulls/pushes when an `origin` remote is configured.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nowTimestamp } from "./okf/write.ts";

export class SyncError extends Error {}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn git by argv. Never throws on nonzero exit — callers decide. */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((done, fail) => {
    execFile(
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
  });
}

/** Run git and throw a SyncError (with git's own message) on failure. */
async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
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

  const seeded: string[] = [];
  if (await ensureLines(root, ".gitignore", IGNORE_HEADER, IGNORE_LINES))
    seeded.push(".gitignore");
  if (await ensureLines(root, ".gitattributes", ATTR_HEADER, ATTR_LINES))
    seeded.push(".gitattributes");

  await git(root, ["add", "-A"]);
  let committed: string | null = null;
  const staged = (await git(root, ["status", "--porcelain"])).trim() !== "";
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
      const pull = await runGit(root, ["pull", "--rebase"]);
      if (pull.code !== 0)
        throw new SyncError(
          `git pull --rebase failed (local commits are safe): ${(pull.stderr || pull.stdout).trim()}\nresolve in the bundle with git, then rerun okb sync`,
        );
      pulled = true;
    }
    const push = await runGit(root, hasUpstream ? ["push"] : ["push", "-u", "origin", branch]);
    if (push.code !== 0)
      throw new SyncError(
        `git push failed (changes are committed locally): ${(push.stderr || push.stdout).trim()}`,
      );
    pushed = true;
  }
  return { initialized, seeded, committed, pulled, pushed, remote };
}
