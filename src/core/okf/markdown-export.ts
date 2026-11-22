import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { relativeConceptLinks } from "../graph/links.ts";
import { walkMarkdownFiles } from "./bundle.ts";
import { idToAbsPath, inDbOnlyDir, isReservedName, validateId } from "./paths.ts";

const maxNotes = 10_000;
const noteLimit = 16 * 1024 * 1024;
const totalLimit = 256 * 1024 * 1024;
const frontmatter = /^\uFEFF?---(?:\r\n|\n|\r)(?:[\s\S]*?(?:\r\n|\n|\r))?---[ \t]*(?:\r\n|\n|\r|$)/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class MarkdownExportError extends Error {}
export interface MarkdownExport {
  path: string;
  notes: number;
  includesPrivate: boolean;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function readNote(path: string, remaining: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new MarkdownExportError("A note changed during export. Review the brain and try again.");
    if (info.size > noteLimit || info.size > remaining)
      throw new MarkdownExportError("Export supports up to 16 MiB per note and 256 MiB in total.");
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new MarkdownExportError("A note changed during export. Review the brain and try again.");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function exportDestination(root: string, destination: string): Promise<string> {
  const choice = destination.trim();
  if (choice.length > 4096 || /[\x00-\x1f\x7f]/.test(choice) || !isAbsolute(choice) || /^[/\\]{2}/.test(choice) ||
      (process.platform === "win32" && !/^[a-z]:[/\\]/i.test(choice)))
    throw new MarkdownExportError("Enter an absolute local path for a new export folder.");
  const wanted = resolve(choice);
  const parent = await realpath(dirname(wanted)).catch(() => undefined);
  if (!parent || !(await stat(parent)).isDirectory())
    throw new MarkdownExportError("Choose a new folder inside an existing directory.");
  const target = join(parent, basename(wanted));
  if (isWithin(root, target)) throw new MarkdownExportError("Choose an export folder outside the current brain.");
  return target;
}

/** Export portable Markdown notes without creating or refreshing anything in the source brain. */
export async function exportMarkdown(bundle: string, destination: string, includePrivate: boolean): Promise<MarkdownExport> {
  const root = await realpath(bundle);
  const target = await exportDestination(root, destination);
  const selected = new Set<string>();
  for await (const path of walkMarkdownFiles(root)) {
    if (isReservedName(basename(path))) continue;
    const id = path.slice(0, -3);
    if (!includePrivate && inDbOnlyDir(id.toLowerCase())) continue;
    validateId(id);
    if (selected.size === maxNotes) throw new MarkdownExportError("Export supports up to 10,000 notes.");
    selected.add(id);
  }
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new MarkdownExportError("Choose a new folder. That path already exists.");
    throw error;
  }
  const identity = await lstat(target);
  const folders = new Set([target]);
  const files: string[] = [];
  let readBytes = 0;
  let writtenBytes = 0;
  try {
    for (const id of selected) {
      const source = idToAbsPath(root, id);
      const physical = await realpath(source);
      if (relative(source, physical) || !isWithin(root, physical))
        throw new MarkdownExportError("A note path changed during export. Review the brain and try again.");
      const raw = await readNote(physical, totalLimit - readBytes);
      readBytes += raw.length;
      let original: string | undefined;
      try { original = utf8.decode(raw); } catch { /* Copy non-UTF-8 legacy notes verbatim. */ }
      let output = raw;
      if (original !== undefined) {
        const yaml = frontmatter.exec(original)?.[0] ?? "";
        output = Buffer.from(yaml + relativeConceptLinks(id, original.slice(yaml.length), selected), "utf8");
      }
      writtenBytes += output.length;
      if (writtenBytes > totalLimit) throw new MarkdownExportError("Export supports up to 256 MiB in total.");
      let folder = target;
      for (const part of id.split("/").slice(0, -1)) {
        folder = join(folder, part);
        if (folders.has(folder)) continue;
        await mkdir(folder, { mode: 0o700 });
        folders.add(folder);
      }
      const path = idToAbsPath(target, id);
      const file = await open(path, "wx", 0o600);
      files.push(path);
      try { await file.writeFile(output); } finally { await file.close(); }
    }
  } catch (error) {
    const current = await lstat(target).catch(() => undefined);
    if (current?.isDirectory() && current.dev === identity.dev && current.ino === identity.ino) {
      await Promise.allSettled(files.map((path) => unlink(path)));
      for (const folder of [...folders].reverse()) await rmdir(folder).catch(() => {});
    }
    throw error;
  }
  return { path: target, notes: selected.size, includesPrivate: includePrivate };
}
