import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, realpath, rm, stat, writeFile } from "node:fs/promises";
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
const emptyBlobIds = ["sha1", "sha256"].map((algorithm) => createHash(algorithm).update("blob 0\0").digest("hex"));

export interface PatchFileReceipt {
  path: string;
  mode: string;
  before: string | null;
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

type PatchMode = ApprovedPatchFile["mode"];
type PatchTarget = { path: string; newMode?: PatchMode };

export function patchDigest(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isApprovedPatchPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 512 && pathPattern.test(path) && !excludedPath(path) && path.split("/").every((part) =>
    part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !part.endsWith(".") && !reservedComponent.test(part));
}

function ancestorPaths(path: string): string[] {
  return [...path.matchAll(/\//gu)].map(({ index }) => path.slice(0, index));
}

function checkNewParents(targets: PatchTarget[]) {
  const parents = new Map<string, string>();
  for (const target of targets) {
    for (const prefix of ancestorPaths(target.path)) {
      const folded = prefix.toLowerCase();
      const prior = parents.get(folded);
      if (prior !== undefined && prior !== prefix)
        throw new ApprovedPatchError("New patch paths must use a single spelling for each parent directory.");
      parents.set(folded, prefix);
    }
  }
}

function patchTargets(diff: string): PatchTarget[] {
  if (!diff || Buffer.byteLength(diff) > approvedPatchBytes || !diff.endsWith("\n") || /[\x00-\x08\x0b-\x1f\x7f]/u.test(diff)) {
    throw new ApprovedPatchError("Paste a Git unified diff ending in a newline, up to 48 KiB.");
  }
  const lines = diff.slice(0, -1).split("\n");
  const seen = new Set<string>();
  const targets: PatchTarget[] = [];
  let line = 0;
  const shapeError = () => new ApprovedPatchError("Use a Git unified diff that edits or adds ordinary text files.");
  while (line < lines.length) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(lines[line++]!);
    const path = header?.[1];
    if (!path || path !== header?.[2] || !isApprovedPatchPath(path)) throw shapeError();
    const folded = path.toLowerCase();
    if (seen.has(folded) || targets.length === approvedPatchFileLimit) throw new ApprovedPatchError("Include at most eight different files in a patch.");
    if ([...seen].some((other) => folded.startsWith(other + "/") || other.startsWith(folded + "/"))) throw shapeError();
    seen.add(folded);
    const newMode = /^new file mode (100(?:644|755))$/u.exec(lines[line] ?? "")?.[1] as PatchMode | undefined;
    if (newMode) line++;
    targets.push(newMode ? { path, newMode } : { path });
    const index = /^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})(?: (100(?:644|755)))?$/u.exec(lines[line] ?? "");
    if (index) {
      if (newMode && (!/^0+$/u.test(index[1]!) || (index[3] && index[3] !== newMode))) throw shapeError();
      line++;
      if (newMode && (line === lines.length || lines[line]?.startsWith("diff --git "))
          && emptyBlobIds.some((id) => id.startsWith(index[2]!))) continue;
    }
    if (lines[line++] !== (newMode ? "--- /dev/null" : `--- a/${path}`) || lines[line++] !== `+++ b/${path}`) throw shapeError();

    let touched = false;
    do {
      const hunk = /^@@ -(\d{1,8})(?:,(\d{1,8}))? \+(\d{1,8})(?:,(\d{1,8}))? @@(?: .*)?$/u.exec(lines[line++] ?? "");
      if (!hunk) throw shapeError();
      let original = Number(hunk[2] ?? 1);
      let changed = Number(hunk[4] ?? 1);
      if (newMode && (touched || hunk[1] !== "0" || original !== 0 || hunk[3] !== "1" || changed < 1)) throw shapeError();
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
  if (targets.some(({ newMode }) => newMode)) checkNewParents(targets);
  return targets;
}

/** Accept only ordinary same-path edits and new regular files with canonical Git diff headers. */
export function patchPaths(diff: string): string[] {
  return patchTargets(diff).map(({ path }) => path);
}

function stamp(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(":");
}

async function readPatchFile(workspace: string, path: string, mode: string, newFile = false): Promise<PatchFileState> {
  try {
    const absolute = join(workspace, path);
    if (await realpath(absolute) !== absolute) throw new Error();
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      // Git records only whether the owner can execute a file. The other
      // permission bits follow the umask of whoever checked the file out.
      const matchesMode = (info.mode & 0o7000) === 0 && Boolean(info.mode & 0o100) === (mode === "100755");
      if (!info.isFile() || info.nlink !== 1 || info.size > approvedPatchFileBytes ||
        (process.platform !== "win32" && !matchesMode)) throw new Error();
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
    const kind = newFile ? "untracked" : "tracked";
    throw new ApprovedPatchError(`Use an ordinary ${kind} UTF-8 file with its Git permissions and at most 256 KiB. Check ${path}.`, { cause: error });
  }
}

function gitEnvironment(emptyConfig: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: "0" };
}

async function git(workspace: string, args: string[], env: ReturnType<typeof gitEnvironment>, input?: string, literal = true): Promise<string> {
  let child;
  try {
    child = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...(literal ? ["--literal-pathspecs"] : []), ...args], {
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
    if (await child.exited !== 0 || timedOut) throw new ApprovedPatchError("Git could not apply the patch exactly to the current worktree.");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    reader.releaseLock();
  }
}

async function pathInfo(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Verify component spelling, parent directories, and absence on disk. */
async function newWorkspaceFileExists(workspace: string, path: string): Promise<boolean> {
  const parts = path.split("/");
  let current = workspace;
  if (await realpath(workspace) !== workspace) throw new ApprovedPatchError("The patch workspace path changed.");
  for (const [index, part] of parts.entries()) {
    const folded = part.toLowerCase();
    const target = join(current, part);
    let exact = false;
    for await (const entry of await opendir(current)) {
      if (entry.name.toLowerCase() === folded) {
        if (entry.name !== part) throw new ApprovedPatchError(`A path with different letter case conflicts with ${path}.`);
        exact = true;
      }
    }
    const info = await pathInfo(target);
    if (!exact && !info) {
      if (await realpath(current) !== current) throw new ApprovedPatchError(`A changed parent conflicts with ${path}.`);
      return false;
    }
    if (!exact || !info || info.isSymbolicLink() || await realpath(target) !== target)
      throw new ApprovedPatchError(`A symlink or changed path conflicts with ${path}.`);
    if (index === parts.length - 1) return true;
    if (!info.isDirectory() || await pathInfo(join(target, ".git")))
      throw new ApprovedPatchError(`A file or nested Git workspace conflicts with a parent of ${path}.`);
    current = target;
  }
  return false;
}

async function indexEntries(workspace: string, targets: PatchTarget[], env: ReturnType<typeof gitEnvironment>) {
  const specs = new Set<string>();
  for (const { path, newMode } of targets) {
    specs.add(newMode ? `:(icase,literal)${path}` : `:(literal)${path}`);
    if (!newMode) continue;
    for (const parent of ancestorPaths(path)) {
      // A glob matching the final character exactly finds an indexed file
      // at the parent without listing every tracked file below a directory.
      specs.add(`:(icase,glob)${parent.slice(0, -1)}[${parent.at(-1)}]`);
    }
  }
  const entries = new Set<string>();
  let group: string[] = [];
  let bytes = 0;
  const load = async () => {
    const listed = await git(workspace, ["ls-files", "--cached", "--stage", "-z", "--", ...group], env, undefined, false);
    for (const entry of listed.split("\0")) if (entry) entries.add(entry);
  };
  for (const spec of specs) {
    if (bytes + spec.length > 8000) { await load(); group = []; bytes = 0; }
    group.push(spec);
    bytes += spec.length + 1;
  }
  if (group.length) await load();
  return [...entries].map((entry) => {
    const record = /^([0-7]{6}) [0-9a-f]+ ([0-3])\t([\s\S]+)$/u.exec(entry);
    if (!record) throw new ApprovedPatchError("Git returned an invalid index entry for this patch.");
    return { mode: record[1]!, stage: record[2]!, path: record[3]! };
  });
}

type PatchSnapshot = { path: string; mode: string; file: PatchFileState | null };

async function snapshot(workspace: string, targets: PatchTarget[], scopes: string[], env: ReturnType<typeof gitEnvironment>, preview = false): Promise<PatchSnapshot[]> {
  for (const { path } of targets) {
    if (!isApprovedPatchPath(path) || !scopes.some((scope) => scope === "." || path.startsWith(`${scope}/`)))
      throw new ApprovedPatchError(`File ${path} is outside the permitted patch scope.`);
  }
  const entries = await indexEntries(workspace, targets, env);
  return Promise.all(targets.map(async ({ path, newMode }) => {
    if (newMode) {
      const wanted = path.toLowerCase();
      if (entries.some(({ path: tracked }) => {
        const folded = tracked.toLowerCase();
        return folded === wanted || folded.startsWith(wanted + "/") || wanted.startsWith(folded + "/");
      })) throw new ApprovedPatchError(`New patch file ${path} conflicts with the Git index.`);
      const exists = await newWorkspaceFileExists(workspace, path).catch((error: unknown) => {
        if (error instanceof ApprovedPatchError) throw error;
        throw new ApprovedPatchError(`Unable to verify the worktree path for ${path}.`, { cause: error });
      });
      if (preview && exists) throw new ApprovedPatchError(`New patch file ${path} already exists in the worktree.`);
      return { path, mode: newMode, file: exists ? await readPatchFile(workspace, path, newMode, true) : null };
    }
    const matches = entries.filter((entry) => entry.path === path);
    if (!matches.length) throw new ApprovedPatchError(`Patch file ${path} must be tracked in the workspace.`);
    const [record] = matches;
    if (matches.length !== 1 || !record || record.stage !== "0" || (record.mode !== "100644" && record.mode !== "100755"))
      throw new ApprovedPatchError("Patch files must be tracked with a resolved Git index entry.");
    return { path, mode: record.mode, file: await readPatchFile(workspace, path, record.mode) };
  }));
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

function validatedReceipts(files: readonly PatchFileReceipt[]): Omit<ApprovedPatchFile, "bytes">[] {
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
      || (before !== null && (typeof before !== "string" || !hashes.test(before)))
      || typeof after !== "string" || !hashes.test(after) || before === after) throw invalid();
    seen.add(path.toLowerCase());
    receipts.push({ path, mode, before, after });
  }
  return receipts;
}

function receiptTargets(receipts: Omit<ApprovedPatchFile, "bytes">[]): PatchTarget[] {
  return receipts.map(({ path, before, mode }) => before === null ? { path, newMode: mode } : { path });
}

function matchesReceipt(observed: PatchSnapshot, receipt: PatchFileReceipt, phase: "before" | "after"): boolean {
  return observed.mode === receipt.mode && (observed.file?.sha256 ?? null) === receipt[phase];
}

export async function approvedPatchState(workspace: string, scopes: string[], files: readonly PatchFileReceipt[]): Promise<"before" | "after" | "different"> {
  const receipts = validatedReceipts(files);
  return scratch(async (_dir, env) => {
    const current = await snapshot(workspace, receiptTargets(receipts), scopes, env);
    const matches = (version: "before" | "after") => current.every((file, i) => matchesReceipt(file, receipts[i]!, version));
    return matches("after") ? "after" : matches("before") ? "before" : "different";
  });
}

/** Capture the exact bytes of an applied patch with creation paths still untracked. */
export async function approvedPatchFiles(workspace: string, scopes: string[], files: readonly PatchFileReceipt[]): Promise<ApprovedPatchFile[]> {
  const receipts = validatedReceipts(files);
  return scratch(async (_dir, env) => {
    const captured = await snapshot(workspace, receiptTargets(receipts), scopes, env);
    return captured.map((observed, index) => {
      const receipt = receipts[index]!;
      if (!observed.file || !matchesReceipt(observed, receipt, "after"))
        throw new ApprovedPatchError("The worktree no longer matches the applied patch. Restore the approved files before publishing.");
      return { ...receipt, bytes: observed.file.bytes };
    });
  });
}

export async function withPreparedPatch<T>(workspace: string, scopes: string[], diff: string, action: (preview: {
  files: PatchFileReceipt[];
  apply: () => Promise<void>;
}) => Promise<T>): Promise<T> {
  const targets = patchTargets(diff);
  const existing = targets.filter(({ newMode }) => !newMode).map(({ path }) => path);
  return scratch(async (dir, env) => {
    const before = await snapshot(workspace, targets, scopes, env, true);
    const draft = join(dir, "worktree");
    await mkdir(draft);
    await git(draft, ["init", "--quiet", "--template="], env);
    for (const { file, path, mode } of before) {
      if (!file) continue;
      const target = join(draft, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
      if (process.platform !== "win32") await chmod(target, Number.parseInt(mode.slice(-3), 8));
    }
    const config = ["-c", "core.autocrlf=false", "-c", "core.attributesFile=" + env.GIT_CONFIG_GLOBAL];
    if (existing.length) await git(draft, [...config, "add", "-f", "--", ...existing], env);
    const tree = (await git(draft, ["write-tree"], env)).trim();
    const pinnedEnv = { ...env, GIT_INDEX_FILE: join(dir, "approved-index") };
    // The fresh index has no worktree stat cache and points to the approved bytes.
    await git(draft, ["read-tree", tree], pinnedEnv);
    const args = [...config, "apply", "--index", "--whitespace=nowarn", "-"];
    await git(draft, args, env, diff);
    const files = await Promise.all(before.map(async ({ path, mode, file }) => ({
      path, mode, before: file?.sha256 ?? null, after: (await readPatchFile(draft, path, mode, !file)).sha256,
    })));
    if (files.some((file) => file.before === file.after)) throw new ApprovedPatchError("Each file in an approved patch must change.");

    return action({ files, apply: async () => {
      const current = await snapshot(workspace, targets, scopes, env);
      if (current.some((file, i) => !matchesReceipt(file, files[i]!, "before"))) {
        throw new ApprovedPatchError("The worktree changed. Preview the patch again before applying it.");
      }
      const currentRepo = ["--git-dir=" + join(draft, ".git"), "--work-tree=" + workspace];
      if (existing.length) await git(workspace, [...currentRepo, ...config, "update-index", "--really-refresh", "--", ...existing], pinnedEnv);
      await git(workspace, [...currentRepo, ...args], pinnedEnv, diff);
      const updated = await snapshot(workspace, targets, scopes, env);
      if (updated.some((file, i) => !matchesReceipt(file, files[i]!, "after"))) {
        throw new ApprovedPatchError("The worktree differs from the approved result. Inspect the changed files before continuing.");
      }
    } });
  });
}
