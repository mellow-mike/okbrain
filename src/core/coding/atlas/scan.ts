// Git-backed discovery for the repository atlas. The index lists what is
// tracked, the worktree supplies current bytes, and the log supplies change
// coupling. Every subprocess takes an argument array and has a deadline.

import { gitEnvironment, invalidPathCharacters } from "../repository-context.ts";

export class AtlasScanError extends Error {}

export interface TrackedListing {
  /** Tracked regular files with portable paths, in Git index order. */
  paths: string[];
  limited: boolean;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const defaultMaxTrackedPaths = 1_000_000;

function validPath(path: string): boolean {
  if (!path || path.length > 1024 || invalidPathCharacters.test(path)) return false;
  for (const part of path.split("/")) if (part === "" || part === "." || part === "..") return false;
  return true;
}

/**
 * Stream the Git index instead of buffering it, so a monorepo with hundreds
 * of thousands of files is listed without a fixed output cap.
 */
export async function listTrackedPaths(
  workspace: string, scopes: readonly string[] = ["."], options: { maxPaths?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<TrackedListing> {
  const maxPaths = options.maxPaths ?? defaultMaxTrackedPaths;
  let child;
  try {
    child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "--literal-pathspecs", "ls-files", "--cached", "--stage", "-z", "--", ...scopes], {
      cwd: workspace, env: gitEnvironment(), stdout: "pipe", stderr: "ignore",
    });
  } catch (error) {
    throw new AtlasScanError("Could not start Git to list tracked workspace files.", { cause: error });
  }
  const paths: string[] = [];
  let limited = false;
  let timedOut = false;
  let exited = false;
  const stop = () => child.kill();
  const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 120_000);
  options.signal?.addEventListener("abort", stop, { once: true });
  const reader = child.stdout.getReader();
  let carry: Uint8Array = new Uint8Array(0);
  const take = (entry: Uint8Array) => {
    const tab = entry.indexOf(9);
    if (tab < 0) return;
    // Regular files at stage zero only: no links, submodules, or unmerged entries.
    const header = Buffer.from(entry.buffer, entry.byteOffset, tab).toString("ascii");
    if (!/^100(?:644|755) [0-9a-f]+ 0$/u.test(header)) return;
    let path: string;
    try { path = decoder.decode(entry.subarray(tab + 1)); } catch { return; }
    if (validPath(path)) paths.push(path);
  };
  try {
    while (!limited) {
      const { value, done } = await reader.read();
      if (done) break;
      let chunk: Uint8Array = value;
      if (carry.length) {
        const joined = new Uint8Array(carry.length + value.length);
        joined.set(carry);
        joined.set(value, carry.length);
        chunk = joined;
      }
      let start = 0;
      for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
        if (paths.length >= maxPaths) { limited = true; break; }
        take(chunk.subarray(start, end));
        start = end + 1;
      }
      carry = chunk.subarray(start);
    }
    if (limited) stop();
    const status = await child.exited;
    exited = true;
    if (options.signal?.aborted) throw new AtlasScanError("The repository import was cancelled.");
    if (timedOut) throw new AtlasScanError("Git timed out listing tracked files. Import narrower directories.");
    if (!limited && status !== 0) throw new AtlasScanError("Repository import requires a workspace inside a Git checkout.");
    return { paths, limited };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", stop);
    if (!exited) stop();
    reader.releaseLock();
  }
}

/**
 * Which of these paths are regular files in the Git index right now. The map
 * records the index as it stood at import, and a file can leave it afterwards
 * while staying on disk. Paths go to Git in small groups, so the argument list
 * stays within every platform's limit.
 */
export async function trackedAmong(workspace: string, paths: readonly string[], options: { signal?: AbortSignal } = {}): Promise<Set<string>> {
  const groups: string[][] = [];
  let group: string[] = [];
  let bytes = 0;
  for (const path of new Set(paths)) {
    if (!validPath(path)) continue;
    const size = Buffer.byteLength(path) + 1;
    if (group.length >= 96 || bytes + size > 12_000) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(path);
    bytes += size;
  }
  if (group.length) groups.push(group);
  const wanted = new Set(paths);
  const tracked = new Set<string>();
  // A literal pathspec that names a file lists that file alone.
  const listings = await Promise.all(groups.map((entry) => listTrackedPaths(workspace, entry, { ...(options.signal ? { signal: options.signal } : {}), timeoutMs: 20_000 })));
  for (const { paths: listed } of listings) for (const path of listed) if (wanted.has(path)) tracked.add(path);
  return tracked;
}

async function gitText(workspace: string, args: string[], maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  let child;
  try {
    child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args], {
      cwd: workspace, env: gitEnvironment(), stdout: "pipe", stderr: "ignore",
    });
  } catch { return undefined; }
  const stop = () => child.kill();
  const timeout = setTimeout(stop, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) { stop(); break; }
      chunks.push(value);
      size += value.byteLength;
    }
    await child.exited;
    // Truncated or failed history is still usable: every complete record is true.
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks, size));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", stop);
    stop();
    reader.releaseLock();
  }
}

export interface ChangeCoupling {
  commits: number;
  /** Symmetric pairs `[a, b, weight]` with `a < b`, strongest first. */
  pairs: [string, string, number][];
}

const maxCommitFiles = 40;
const maxPartnersPerFile = 8;

/**
 * Files that change in the same commits. A commit touching n files adds
 * 1/(n-1) to each pair, so a sweeping change says little and a focused one
 * says a lot. Bulk commits are ignored outright.
 */
export async function mineChangeCoupling(
  workspace: string, known: ReadonlySet<string>, options: { commits?: number; signal?: AbortSignal } = {},
): Promise<ChangeCoupling> {
  const count = Math.max(0, Math.min(options.commits ?? 2000, 20_000));
  if (count === 0) return { commits: 0, pairs: [] };
  const text = await gitText(workspace, ["log", "--no-merges", "--no-renames", `-n${count}`, "--name-only", "--format=format:%x1e%H"],
    48 * 1024 * 1024, 60_000, options.signal);
  if (!text) return { commits: 0, pairs: [] };
  const weights = new Map<string, number>();
  const support = new Map<string, number>();
  let commits = 0;
  for (const record of text.split("\x1e")) {
    const lines = record.split("\n");
    if (!/^[0-9a-f]{40,64}$/u.test(lines[0]?.trim() ?? "")) continue;
    commits++;
    const files = [...new Set(lines.slice(1).map((line) => line.trim()).filter((line) => known.has(line)))].sort();
    if (files.length < 2 || files.length > maxCommitFiles) continue;
    const share = 1 / (files.length - 1);
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
      const key = `${files[i]}\0${files[j]}`;
      weights.set(key, (weights.get(key) ?? 0) + share);
      support.set(key, (support.get(key) ?? 0) + 1);
    }
  }
  const partners = new Map<string, number>();
  const pairs: [string, string, number][] = [];
  const ranked = [...weights.entries()].filter(([key]) => (support.get(key) ?? 0) >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [key, weight] of ranked) {
    const [a, b] = key.split("\0") as [string, string];
    const countA = partners.get(a) ?? 0;
    const countB = partners.get(b) ?? 0;
    if (countA >= maxPartnersPerFile || countB >= maxPartnersPerFile) continue;
    partners.set(a, countA + 1);
    partners.set(b, countB + 1);
    pairs.push([a, b, Number(weight.toFixed(4))]);
  }
  return { commits, pairs };
}

/** Owners for directory prefixes, from the first CODEOWNERS file Git tracks. Later rules win, as on GitHub. */
export function parseCodeOwners(text: string): { prefix: string; owners: string[] }[] {
  const rules: { prefix: string; owners: string[] }[] = [];
  for (const raw of text.split(/\r?\n/u).slice(0, 4000)) {
    const line = raw.replace(/\s+#.*$/u, "").trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/u);
    const names = owners.filter((owner) => /^@[\w./-]{1,100}$/u.test(owner)).slice(0, 8);
    if (!pattern || !names.length) continue;
    // Only directory prefixes are mapped; file globs stay with their package's owners.
    const prefix = pattern.replace(/^\//u, "").replace(/\/\*\*?$/u, "").replace(/\/$/u, "");
    if (pattern === "*") rules.push({ prefix: ".", owners: names });
    else if (prefix && !/[*?[\]!]/u.test(prefix)) rules.push({ prefix, owners: names });
  }
  return rules;
}

export function ownersOf(root: string, rules: readonly { prefix: string; owners: string[] }[]): string[] {
  let owners: string[] = [];
  for (const rule of rules) {
    if (rule.prefix === "." || root === rule.prefix || root.startsWith(`${rule.prefix}/`)) owners = rule.owners;
  }
  return owners;
}
