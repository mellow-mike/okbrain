// Concept-id ⇄ path conversion and segment safety. A concept id is the file
// path within the bundle minus `.md`, always using forward slashes
// (`notes/foo.md` → `notes/foo`); on-disk paths use the OS separator via
// node:path. Reserved filenames (`index.md`, `log.md`) are not concepts.

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const RESERVED = new Set(["index.md", "log.md"]);

export function isReservedName(basename: string): boolean {
  return RESERVED.has(basename);
}

export class InvalidIdError extends Error {}

/** The portability comparison for names that may alias on another filesystem. */
export const portablePathKey = (name: string): string => name.normalize("NFC").toLowerCase();

/** Mutations must use the existing spelling and must not introduce case-only aliases. */
export async function assertConceptPathSpelling(root: string, id: string): Promise<void> {
  validateId(id);
  const steps = id.split("/");
  steps.push(`${steps.pop()!}.md`);
  if (isReservedName(portablePathKey(steps.at(-1)!)))
    throw new InvalidIdError("index.md and log.md are reserved in every capitalization.");
  let directory = root;
  const prefix: string[] = [];
  for (const part of steps) {
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!names.includes(part)) {
      const folded = portablePathKey(part);
      const alias = names.find((name) => portablePathKey(name) === folded);
      if (alias !== undefined) throw new InvalidIdError(`Use the existing path spelling ${[...prefix, alias].join("/")}.`);
      return;
    }
    prefix.push(part);
    directory = join(directory, part);
  }
}

/**
 * okbrain reads and writes regular files in real folders below the brain's
 * root, and nothing else. A symbolic link there can point anywhere on this
 * computer, and a shared Git repository can deliver one, so a link (or a
 * device, a pipe, or a folder where a file belongs) is refused before it is
 * opened (B23). `relative` uses forward slashes. Parts that do not exist yet
 * are fine: a write creates them as real folders and files.
 */
export async function assertBundleFile(root: string, relative: string): Promise<void> {
  const parts = relative.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
      throw new InvalidIdError(`${relative} is not a regular file in this brain. okbrain does not follow links or open special files.`);
  }
}

/** The file a concept ID names, after `assertBundleFile` has accepted it. */
export async function conceptFile(root: string, id: string): Promise<string> {
  const path = idToAbsPath(root, id); // validates the id
  await assertBundleFile(root, `${id}.md`);
  return path;
}

/**
 * True when the concept lives under a `db_only/` directory: on disk and in the
 * index, but kept out of git (`okb sync` gitignores `db_only/`) — so the
 * committed root `log.md` and parent `index.md` listings must not name it.
 */
export function inDbOnlyDir(id: string): boolean {
  return id.split("/").slice(0, -1).includes("db_only");
}

/** Reject empty, absolute, or traversing ids before they touch the filesystem. */
export function validateId(id: string): void {
  if (id.length === 0) throw new InvalidIdError("empty concept id");
  if (id.startsWith("/") || id.endsWith("/"))
    throw new InvalidIdError(`concept id must not start or end with '/': ${id}`);
  for (const seg of id.split("/")) {
    if (seg === "")
      throw new InvalidIdError(`empty path segment in id: ${id}`);
    if (seg === "." || seg === "..")
      throw new InvalidIdError(`path traversal in id: ${id}`);
    if (seg.includes("\\") || seg.includes("\0"))
      throw new InvalidIdError(`illegal character in id: ${id}`);
  }
}

/** Text → id-segment slug (`Café Notes!` → `cafe-notes`). Throws if nothing survives. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") throw new InvalidIdError(`cannot derive an id segment from: ${JSON.stringify(text)}`);
  return slug;
}

/** `notes/foo` → OS-relative `notes/foo.md`. */
export function idToRelPath(id: string): string {
  validateId(id);
  return join(...id.split("/")) + ".md";
}

/** `<root>` + `notes/foo` → absolute OS path to the concept file. */
export function idToAbsPath(root: string, id: string): string {
  return join(root, idToRelPath(id));
}

/** OS- or forward-slash relative path → forward-slash id minus `.md`. */
export function relPathToId(relPath: string): string {
  const fwd = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return fwd.endsWith(".md") ? fwd.slice(0, -3) : fwd;
}
