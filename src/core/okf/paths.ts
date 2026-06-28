// Concept-id ⇄ path conversion and segment safety. A concept id is the file
// path within the bundle minus `.md`, always using forward slashes
// (`notes/foo.md` → `notes/foo`); on-disk paths use the OS separator via
// node:path. Reserved filenames (`index.md`, `log.md`) are not concepts.

import { join } from "node:path";

const RESERVED = new Set(["index.md", "log.md"]);

export function isReservedName(basename: string): boolean {
  return RESERVED.has(basename);
}

export class InvalidIdError extends Error {}

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
