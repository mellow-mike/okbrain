import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { readConceptPermissive } from "./bundle.ts";
import { inDbOnlyDir, isReservedName, validateId } from "./paths.ts";

export class PrivacyPathError extends Error {}

/** A privacy change must operate on an ordinary concept path owned by this brain. */
export async function checkPrivacyPath(root: string, id: string): Promise<void> {
  validateId(id);
  const parts = id.split("/");
  if (/[\x00-\x1f\x7f]/.test(id) || isReservedName(`${posix.basename(id)}.md`) ||
      parts.some((part) => part.startsWith(".") || part === "node_modules")) throw new PrivacyPathError("Choose a regular note within this brain.");
  const file = parts.pop()!;
  let current = root;
  for (const [index, part] of [...parts, `${file}.md`].entries()) {
    current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) return;
    if (index < parts.length ? !info.isDirectory() : !info.isFile())
      throw new PrivacyPathError("Choose a regular note within this brain.");
  }
}

/** Directory privacy cannot be overridden by frontmatter. */
export function isPrivateConcept(id: string, frontmatter: Record<string, unknown>): boolean {
  return inDbOnlyDir(id.toLowerCase()) || frontmatter.db_only === true;
}

/** Consult the Markdown source before exposing a note outside the local reader. */
export async function isPrivateConceptAt(root: string, id: string): Promise<boolean> {
  if (inDbOnlyDir(id.toLowerCase())) return true;
  try {
    const { parsed, doc } = await readConceptPermissive(root, id);
    return !parsed || isPrivateConcept(id, doc.frontmatter);
  } catch { return true; }
}
