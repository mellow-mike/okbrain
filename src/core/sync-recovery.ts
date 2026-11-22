import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { OkfParseError, parse } from "./okf/document.ts";
import { inDbOnlyDir } from "./okf/paths.ts";
import { publishConcept } from "./okf/write.ts";
import {
  SyncError, git, gitPathEquals, privateNotesForSync, privatePath, repoRoot, runGit, sameDir, syncRebaseInProgress,
  verifyNoPrivateStagedNotes, verifyPrivateDirectoryHistory, verifyPrivatePaths, withSyncRepository,
} from "./sync.ts";

const conflictBytes = 256 * 1024;
const conflictLimit = 100;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

type Side = { kind: "text"; text: string } | { kind: "deleted" } | { kind: "unavailable" };
type Mode = "100644" | "100755";
interface Entry { mode: string; oid: string; stage: number }
type Worktree = (Extract<Side, { kind: "text" }> & { mode: number } | Exclude<Side, { kind: "text" }>) & { stamp: string };

export interface SyncRecoveryInput {
  action: "status" | "preview" | "resolve" | "continue" | "abort";
  confirm?: boolean;
  path?: string;
  approval?: string;
  choice?: "local" | "upstream" | "manual";
  text?: string;
}

export interface SyncRecoveryPreview {
  path: string;
  approval: string;
  base: Side;
  local: Side;
  upstream: Side;
  worktree: Side;
  canManual: boolean;
}

export interface SyncRecoveryResult {
  inProgress: boolean;
  conflicts: string[];
  canContinue: boolean;
  canAbort: boolean;
  notice?: string;
  preview?: SyncRecoveryPreview;
}

const idle = (): SyncRecoveryResult => ({ inProgress: false, conflicts: [], canContinue: false, canAbort: false });
const unavailable: Side = { kind: "unavailable" };
const deleted: Side = { kind: "deleted" };
const changed = () => new SyncError("The conflict changed. Preview the current versions before resolving it.");
const publicPath = (path: string, privatePaths: ReadonlySet<string>) => !inDbOnlyDir(path.toLowerCase()) && !privatePaths.has(gitPathEquals(path));
const regularMode = (mode: string): mode is Mode => mode === "100644" || mode === "100755";

function safePath(path: unknown): path is string {
  return typeof path === "string" && Buffer.byteLength(path) <= 512 && !/[\x00-\x1f\x7f\ufffd\\:<>*?"|]/u.test(path) &&
    path.split("/").every((part) => part && !/[. ]$/u.test(part) &&
      !/^(?:\.git(?:$|~[1-9]$)|git~[1-9]$|(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$))/iu.test(part));
}

function checkPublicText(path: string, side: Side): void {
  if (!/\.md$/iu.test(path) || side.kind !== "text") return;
  try {
    if (parse(side.text).frontmatter.db_only === true) throw new SyncError("A private note cannot be resolved or staged through Git sync.");
  } catch (error) {
    if (!(error instanceof OkfParseError)) throw error;
    if (/\bdb_only\b/u.test(side.text)) throw new SyncError("Review this note’s privacy metadata before resolving the Git conflict.");
  }
}

async function conflictIndex(root: string) {
  const raw = await git(root, ["ls-files", "--unmerged", "-z"]);
  const paths = new Map<string, Entry[]>();
  for (const row of raw.split("\0").filter(Boolean)) {
    const record = /^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/u.exec(row);
    if (!record || !objectId.test(record[2]!)) throw new SyncError("Git returned an unsupported conflict index.");
    const [, mode, oid, stage, path] = record;
    const entries = paths.get(path!) ?? [];
    entries.push({ mode: mode!, oid: oid!, stage: Number(stage) });
    paths.set(path!, entries);
  }
  return { raw, paths };
}

const indexPrivatePaths = (ids: ReadonlySet<string>) => new Set([...ids].map((id) => gitPathEquals(privatePath(id))));

async function recoveryStatus(root: string, notice?: string): Promise<SyncRecoveryResult> {
  if (!await syncRebaseInProgress(root)) return notice ? { ...idle(), notice } : idle();
  const { paths } = await conflictIndex(root);
  const privatePaths = paths.size ? indexPrivatePaths(await privateNotesForSync(root)) : new Set<string>();
  const available = [...paths.keys()].filter((path) => safePath(path) && publicPath(path, privatePaths));
  const canContinue = !paths.size && (await runGit(root, ["diff", "--quiet", "--no-ext-diff", "--"])).code === 0;
  if (!notice && available.length < paths.size) notice = "Some conflict paths cannot be opened through Git sync.";
  if (!notice && available.length > conflictLimit) notice = "Showing the first 100 conflicts. Resolve these to see the remaining files.";
  if (!notice && !paths.size && !canContinue) notice = "Tracked files still contain unstaged edits. Review the files before continuing.";
  return { inProgress: true, conflicts: available.slice(0, conflictLimit), canContinue, canAbort: true, ...(notice && { notice }) };
}

function fileStamp(info: Stats) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

async function readWorktree(root: string, path: string): Promise<Worktree> {
  const parts = path.split("/");
  const absolute = join(root, ...parts);
  const failed: Worktree = { kind: "unavailable", stamp: "unavailable" };
  try {
    let parent = root;
    for (const segment of parts.slice(0, -1)) {
      parent = join(parent, segment);
      if (!(await lstat(parent)).isDirectory()) return failed;
    }
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return { kind: "deleted", stamp: "deleted" };
    if (!info.isFile() || info.nlink !== 1 || info.size > conflictBytes || (info.mode & 0o7000)) return failed;
    const actual = await realpath(absolute);
    const normalize = (value: string) => {
      if (process.platform === "win32") return value.toLowerCase();
      return process.platform === "darwin" ? value.normalize("NFC") : value;
    };
    if (normalize(actual) !== normalize(absolute)) return failed;
    const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (fileStamp(await fd.stat()) !== fileStamp(info)) return failed;
      const buffer = Buffer.alloc(info.size + 1);
      let read = 0;
      while (read < buffer.length) {
        const result = await fd.read(buffer, read, buffer.length - read, read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      if (read !== info.size || fileStamp(await lstat(absolute)) !== fileStamp(info) || buffer.subarray(0, read).includes(0)) return failed;
      const bytes = buffer.subarray(0, read);
      return { kind: "text", text: utf8.decode(bytes), mode: info.mode & 0o777,
        stamp: fileStamp(info) + ":" + createHash("sha256").update(bytes).digest("hex") };
    } finally { await fd.close(); }
  } catch { return failed; }
}

async function gitSide(root: string, entry?: Entry): Promise<Side> {
  if (!entry) return deleted;
  if (!regularMode(entry.mode)) return unavailable;
  const size = Number((await git(root, ["cat-file", "-s", entry.oid])).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > conflictBytes) return unavailable;
  const text = await git(root, ["cat-file", "blob", entry.oid]);
  // execFile decodes stdout. Check the blob hash after re-encoding to reject lossy UTF-8 decoding.
  const actual = createHash(entry.oid.length === 40 ? "sha1" : "sha256").update(`blob ${size}\0`).update(text, "utf8").digest("hex");
  return actual === entry.oid && !text.includes("\0") ? { kind: "text", text } : unavailable;
}

async function inspectConflict(root: string, path: string) {
  const index = await conflictIndex(root);
  const entries = index.paths.get(path);
  if (!entries?.length) throw changed();
  if (!publicPath(path, indexPrivatePaths(await privateNotesForSync(root)))) throw new SyncError("A private path cannot be opened through Git sync.");
  const [baseEntry, upstreamEntry, localEntry] = [1, 2, 3].map((stage) => entries.find((entry) => entry.stage === stage));
  // On rebase, stage 2 is the checked-out upstream and stage 3 is the local commit being replayed.
  const [base, upstream, local, worktree, commit] = await Promise.all([
    gitSide(root, baseEntry), gitSide(root, upstreamEntry), gitSide(root, localEntry), readWorktree(root, path),
    git(root, ["rev-parse", "--verify", "REBASE_HEAD"]),
  ]);
  for (const side of [base, local, upstream, worktree]) checkPublicText(path, side);
  const approval = createHash("sha256").update(JSON.stringify(["okb-sync-conflict-1", root, path, commit, index.raw, worktree.stamp])).digest("hex");
  const manualMode = localEntry?.mode ?? upstreamEntry?.mode;
  const canManual = [base, upstream, local, worktree].every((side) => side.kind !== "unavailable") &&
    manualMode !== undefined && regularMode(manualMode);
  const worktreeSide: Side = worktree.kind === "text" ? { kind: "text", text: worktree.text } : { kind: worktree.kind };
  const preview: SyncRecoveryPreview = { path, approval, base, local, upstream, worktree: worktreeSide, canManual };
  return { preview, localEntry, upstreamEntry, manualMode, worktree, index: index.raw, entries, commit };
}

type ResolvedFile = { kind: "text"; text: string; mode: number } | { kind: "deleted" };

async function putWorktree(root: string, path: string, next: ResolvedFile, expected: Exclude<Worktree, { kind: "unavailable" }>) {
  const absolute = join(root, ...path.split("/"));
  const matches = async () => (await readWorktree(root, path)).stamp === expected.stamp;
  if (next.kind === "text") {
    const published = await publishConcept(absolute, next.text, next.mode, expected.kind === "text" ? expected.text : undefined, matches);
    if (!published) throw changed();
  } else {
    if (!await matches()) throw changed();
    if (expected.kind === "text") await unlink(absolute);
  }
}

async function resolveConflict(root: string, path: string, input: SyncRecoveryInput) {
  const conflict = await inspectConflict(root, path);
  const { preview, worktree } = conflict;
  if (input.approval !== preview.approval) throw changed();
  if (worktree.kind === "unavailable") throw new SyncError("Only regular UTF-8 conflict files up to 256 KiB can be changed through Git sync.");

  let text: Side;
  let entry: Entry | undefined;
  if (input.choice === "manual") {
    if (!preview.canManual || typeof input.text !== "string" || Buffer.byteLength(input.text) > conflictBytes ||
      input.text.includes("\0") || utf8.decode(Buffer.from(input.text)) !== input.text) {
      throw new SyncError("Enter merged UTF-8 text up to 256 KiB for the selected conflict.");
    }
    text = { kind: "text", text: input.text };
    checkPublicText(path, text);
  } else if (input.choice === "local" || input.choice === "upstream") {
    text = preview[input.choice];
    entry = input.choice === "local" ? conflict.localEntry : conflict.upstreamEntry;
  } else throw new SyncError("Choose the local, upstream, or merged version.");
  if (text.kind === "unavailable" || (entry && !regularMode(entry.mode))) throw new SyncError("That version is unavailable for browser recovery.");

  const ids = await privateNotesForSync(root);
  if (!publicPath(path, indexPrivatePaths(ids))) throw new SyncError("A private path cannot be staged through Git sync.");
  await verifyPrivatePaths(root, ids);
  await verifyNoPrivateStagedNotes(root);
  const stillConflicted = async () => await syncRebaseInProgress(root) &&
    (await git(root, ["rev-parse", "--verify", "REBASE_HEAD"])) === conflict.commit &&
    (await conflictIndex(root)).raw === conflict.index;
  if (!await stillConflicted()) throw changed();
  if (input.choice === "manual" && text.kind === "text") {
    const oid = (await git(root, ["hash-object", "-w", "--stdin"], text.text)).trim();
    if (!objectId.test(oid)) throw new SyncError("Git could not save the merged file.");
    entry = { oid, mode: conflict.manualMode!, stage: 0 };
  }
  const next: ResolvedFile = text.kind === "text" ? { ...text, mode: Number.parseInt(entry!.mode.slice(-3), 8) } : text;
  await putWorktree(root, path, next, worktree);
  const written = await readWorktree(root, path);
  const stillWritten = written.kind === "deleted" ? next.kind === "deleted" :
    written.kind === "text" && next.kind === "text" && written.text === next.text;
  if (!stillWritten || written.kind === "unavailable") throw changed();
  try {
    if (!await stillConflicted()) throw changed();
    const zeros = "0".repeat(conflict.entries[0]!.oid.length);
    const clear = `0 ${zeros}\t${path}\0`;
    const replace = entry ? `${entry.mode} ${entry.oid}\t${path}\0` : "";
    await git(root, ["update-index", "-z", "--index-info"], clear + replace);
  } catch (error) {
    // Restore only the bytes just installed, leaving any subsequent editor changes in place.
    await putWorktree(root, path, worktree, written).catch(() => {});
    throw new SyncError("Git did not stage the resolution. Preview the current file before retrying.", { cause: error });
  }
}

export async function syncRecovery(root: string, input: SyncRecoveryInput): Promise<SyncRecoveryResult> {
  return withSyncRepository(root, async (root) => {
    const top = await repoRoot(root);
    const active = top !== null && sameDir(top, root) && await syncRebaseInProgress(root);
    if (input.action === "status") return active ? recoveryStatus(root) : idle();
    if (!active) throw new SyncError("There is no Git rebase in progress for this brain.");
    if (input.action === "preview" || input.action === "resolve") {
      if (!safePath(input.path) || inDbOnlyDir(input.path.toLowerCase())) throw new SyncError("Choose a supported conflict path in this brain.");
      if (input.action === "preview") return { ...await recoveryStatus(root), preview: (await inspectConflict(root, input.path)).preview };
      await resolveConflict(root, input.path, input);
      return recoveryStatus(root);
    }
    if (input.action !== "continue" && input.action !== "abort") throw new SyncError("Choose a Git recovery action.");
    if (input.confirm !== true) throw new SyncError("Confirm the Git recovery action before proceeding.");
    if (input.action === "continue") {
      const status = await recoveryStatus(root);
      if (!status.canContinue) throw new SyncError("Resolve all conflicts and review unstaged edits before continuing.");
      await verifyPrivatePaths(root, await privateNotesForSync(root));
      await verifyPrivateDirectoryHistory(root);
      await verifyNoPrivateStagedNotes(root);
    }
    if (!await syncRebaseInProgress(root)) throw new SyncError("There is no Git rebase in progress for this brain.");
    const result = await runGit(root, ["rebase", `--${input.action}`], undefined, { GIT_EDITOR: "true" });
    if (result.code === 0) return recoveryStatus(root, input.action === "abort" ? "Git rebase aborted." : "Git rebase continued without pushing.");
    const status = await recoveryStatus(root);
    if (input.action === "continue" && status.inProgress && (await conflictIndex(root)).paths.size) {
      return { ...status, notice: status.notice ?? "Git stopped on the next commit. Review the new conflicts." };
    }
    throw new SyncError(`Git could not ${input.action} the rebase. Review the current repository status before retrying.`);
  });
}
