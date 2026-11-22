import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { excludedPath } from "./repository-context.ts";

export class ApprovedPatchError extends Error {}

export const approvedPatchBytes = 48 * 1024;
export const approvedPatchFileLimit = 8;
export const approvedPatchFileBytes = 256 * 1024;
const maxOutputBytes = 64 * 1024;
const pathPattern = /^[a-zA-Z0-9_.@/+\-]+$/u;
const reservedComponent = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface PatchFileReceipt {
  path: string;
  mode: string;
  before: string;
  after: string;
}

export type ApprovedPatchFile = PatchFileReceipt & {
  mode: "100644" | "100755";
  bytes: Uint8Array;
};

interface PatchFileState {
  path: string;
  mode: string;
  bytes: Buffer;
  sha256: string;
}

export function patchDigest(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isApprovedPatchPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 512 && pathPattern.test(path) && !excludedPath(path) && path.split("/").every((part) =>
    part && part !== "." && part !== ".." && !part.endsWith(".") && !reservedComponent.test(part));
}

/** Accept only ordinary same-path file edits with canonical Git diff headers. */
export function patchPaths(diff: string): string[] {
  if (!diff || Buffer.byteLength(diff) > approvedPatchBytes || !diff.endsWith("\n") || /[\x00-\x08\x0b-\x1f\x7f]/u.test(diff)) {
    throw new ApprovedPatchError("Paste a Git unified diff ending in a newline, up to 48 KiB.");
  }
  const lines = diff.slice(0, -1).split("\n");
  const seen = new Set<string>();
  const paths: string[] = [];
  let line = 0;
  const shapeError = () => new ApprovedPatchError("Use a Git unified diff that edits existing files without renames, mode changes, or binary content.");
  while (line < lines.length) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(lines[line++]!);
    const path = header?.[1];
    if (!path || path !== header?.[2] || !isApprovedPatchPath(path)) throw shapeError();
    if (seen.has(path.toLowerCase()) || paths.length === approvedPatchFileLimit) throw new ApprovedPatchError("Include at most eight different files in a patch.");
    seen.add(path.toLowerCase());
    paths.push(path);
    if (/^index [0-9a-f]{4,64}\.\.[0-9a-f]{4,64}(?: 100(?:644|755))?$/u.test(lines[line] ?? "")) line++;
    if (lines[line++] !== `--- a/${path}` || lines[line++] !== `+++ b/${path}`) throw shapeError();

    let touched = false;
    do {
      const hunk = /^@@ -\d{1,8}(?:,(\d{1,8}))? \+\d{1,8}(?:,(\d{1,8}))? @@(?: .*)?$/u.exec(lines[line++] ?? "");
      if (!hunk) throw shapeError();
      let original = Number(hunk[1] ?? 1);
      let changed = Number(hunk[2] ?? 1);
      while (original > 0 || changed > 0) {
        const marker = lines[line++]?.[0];
        if (marker !== " " && marker !== "-" && marker !== "+") throw shapeError();
        if (marker !== "+") original--;
        if (marker !== "-") changed--;
        if (original < 0 || changed < 0) throw shapeError();
        if (lines[line] === "\\ No newline at end of file") line++;
        touched ||= marker !== " ";
      }
    } while (lines[line]?.startsWith("@@ "));
    if (!touched) throw shapeError();
  }
  return paths;
}

function stamp(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(":");
}

async function readPatchFile(workspace: string, path: string, mode: string): Promise<PatchFileState> {
  try {
    const absolute = join(workspace, path);
    if (await realpath(absolute) !== absolute) throw new Error();
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > approvedPatchFileBytes ||
        (process.platform !== "win32" && (info.mode & 0o7777) !== Number.parseInt(mode.slice(-3), 8))) throw new Error();
      const bytes = Buffer.alloc(info.size + 1);
      let read = 0;
      while (read < bytes.length) {
        const step = await file.read(bytes, read, bytes.length - read, read);
        if (!step.bytesRead) break;
        read += step.bytesRead;
      }
      if (read !== info.size || await realpath(absolute) !== absolute || stamp(info) !== stamp(await stat(absolute))) throw new Error();
      const data = bytes.subarray(0, read);
      if (data.includes(0)) throw new Error();
      decoder.decode(data);
      return { path, mode, bytes: data, sha256: patchDigest(data) };
    } finally {
      await file.close();
    }
  } catch (error) {
    throw new ApprovedPatchError(`Use an existing, ordinary tracked UTF-8 file with its Git permissions and at most 256 KiB. Check ${path}.`, { cause: error });
  }
}

function gitEnvironment(emptyConfig: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: "0" };
}

async function git(workspace: string, args: string[], env: ReturnType<typeof gitEnvironment>, input?: string): Promise<string> {
  let child;
  try {
    child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "--literal-pathspecs", ...args], {
      cwd: workspace, env, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "ignore",
    });
  } catch (error) {
    throw new ApprovedPatchError("Git is required to check and apply this patch.", { cause: error });
  }
  const reader = child.stdout.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxOutputBytes) throw new ApprovedPatchError("Git returned too much output for this patch check.");
      chunks.push(Buffer.from(value));
    }
    if (await child.exited !== 0 || timedOut) throw new ApprovedPatchError("Git could not apply the patch exactly to the current tracked worktree files.");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    reader.releaseLock();
  }
}

async function snapshot(workspace: string, paths: string[], scopes: string[], env: ReturnType<typeof gitEnvironment>): Promise<PatchFileState[]> {
  const files: PatchFileState[] = [];
  for (const path of paths) {
    if (!isApprovedPatchPath(path) || !scopes.some((scope) => scope === "." || path.startsWith(`${scope}/`))) {
      throw new ApprovedPatchError(`File ${path} is outside the permitted patch scope.`);
    }
  }
  const entries = await git(workspace, ["ls-files", "--cached", "--stage", "-z", "--", ...paths], env);
  const modes = new Map<string, string>();
  for (const entry of entries.split("\0")) {
    if (!entry) continue;
    const record = /^(100(?:644|755)) [0-9a-f]+ 0\t(.+)$/u.exec(entry);
    if (!record) throw new ApprovedPatchError("Patch files must be tracked with a resolved Git index entry.");
    modes.set(record[2]!, record[1]!);
  }
  for (const path of paths) {
    const mode = modes.get(path);
    if (!mode) throw new ApprovedPatchError(`Patch file ${path} must be tracked in the workspace.`);
    files.push(await readPatchFile(workspace, path, mode));
  }
  return files;
}

async function scratch<T>(action: (directory: string, env: ReturnType<typeof gitEnvironment>) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), "okb-patch-"));
  try {
    const dir = await realpath(temporary);
    const emptyConfig = join(dir, "empty-config");
    await writeFile(emptyConfig, "", { mode: 0o600 });
    return await action(dir, gitEnvironment(emptyConfig));
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export async function approvedPatchState(workspace: string, scopes: string[], files: PatchFileReceipt[]): Promise<"before" | "after" | "different"> {
  return scratch(async (_dir, env) => {
    const current = await snapshot(workspace, files.map(({ path }) => path), scopes, env);
    const matches = (version: "before" | "after") => current.every((file, i) => file.mode === files[i]!.mode && file.sha256 === files[i]![version]);
    return matches("after") ? "after" : matches("before") ? "before" : "different";
  });
}

/** Capture the exact, still-tracked bytes approved by an applied patch. */
export async function approvedPatchFiles(workspace: string, scopes: string[], files: readonly PatchFileReceipt[]): Promise<ApprovedPatchFile[]> {
  const invalid = () => new ApprovedPatchError("The applied patch receipt is invalid.");
  if (!Array.isArray(files) || !files.length || files.length > approvedPatchFileLimit) throw invalid();
  const hashes = /^[0-9a-f]{64}$/u;
  const seen = new Set<string>();
  const receipts: Omit<ApprovedPatchFile, "bytes">[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") throw invalid();
    const { path, mode, before, after } = file as PatchFileReceipt;
    if (!isApprovedPatchPath(path) || seen.has(path.toLowerCase())
      || (mode !== "100644" && mode !== "100755")
      || typeof before !== "string" || !hashes.test(before)
      || typeof after !== "string" || !hashes.test(after) || before === after) throw invalid();
    seen.add(path.toLowerCase());
    receipts.push({ path, mode, before, after });
  }
  return scratch(async (_dir, env) => {
    const captured = await snapshot(workspace, receipts.map(({ path }) => path), scopes, env);
    return captured.map(({ mode, bytes, sha256 }, index) => {
      const receipt = receipts[index]!;
      if (mode !== receipt.mode || sha256 !== receipt.after)
        throw new ApprovedPatchError("The worktree no longer matches the applied patch. Restore the approved files before publishing.");
      return { ...receipt, bytes };
    });
  });
}

export async function withPreparedPatch<T>(workspace: string, scopes: string[], diff: string, action: (preview: {
  files: PatchFileReceipt[];
  apply: () => Promise<void>;
}) => Promise<T>): Promise<T> {
  const paths = patchPaths(diff);
  return scratch(async (dir, env) => {
    const before = await snapshot(workspace, paths, scopes, env);
    const draft = join(dir, "worktree");
    await mkdir(draft);
    await git(draft, ["init", "--quiet", "--template="], env);
    for (const file of before) {
      const target = join(draft, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
      if (process.platform !== "win32") await chmod(target, Number.parseInt(file.mode.slice(-3), 8));
    }
    const config = ["-c", "core.autocrlf=false", "-c", "core.attributesFile=" + env.GIT_CONFIG_GLOBAL];
    await git(draft, [...config, "add", "-f", "--", ...paths], env);
    const tree = (await git(draft, ["write-tree"], env)).trim();
    const pinnedEnv = { ...env, GIT_INDEX_FILE: join(dir, "approved-index") };
    // The fresh index has no worktree stat cache and points to the approved bytes.
    await git(draft, ["read-tree", tree], pinnedEnv);
    const args = [...config, "apply", "--index", "--whitespace=nowarn", "-"];
    await git(draft, args, env, diff);
    const files = await Promise.all(before.map(async ({ path, mode, sha256 }) => ({
      path, mode, before: sha256, after: (await readPatchFile(draft, path, mode)).sha256,
    })));
    if (files.some((file) => file.before === file.after)) throw new ApprovedPatchError("Each file in an approved patch must change.");

    return action({ files, apply: async () => {
      const current = await snapshot(workspace, paths, scopes, env);
      if (current.some((file, i) => file.mode !== files[i]!.mode || file.sha256 !== files[i]!.before)) {
        throw new ApprovedPatchError("The worktree changed. Preview the patch again before applying it.");
      }
      const currentRepo = ["--git-dir=" + join(draft, ".git"), "--work-tree=" + workspace];
      await git(workspace, [...currentRepo, ...config, "update-index", "--really-refresh", "--", ...paths], pinnedEnv);
      await git(workspace, [...currentRepo, ...args], pinnedEnv, diff);
      const updated = await snapshot(workspace, paths, scopes, env);
      if (updated.some((file, i) => file.mode !== files[i]!.mode || file.sha256 !== files[i]!.after)) {
        throw new ApprovedPatchError("The worktree differs from the approved result. Inspect the changed files before continuing.");
      }
    } });
  });
}
