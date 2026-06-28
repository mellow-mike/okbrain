// Bundle traversal: list concepts, read a concept by id, reserved-file handling.
// Walks the tree with explicit recursion so we can skip VCS/tooling dirs and
// build forward-slash ids regardless of OS separator.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, type OkfDocument } from "./document.ts";
import { idToAbsPath, isReservedName, relPathToId, validateId } from "./paths.ts";

export interface Concept {
  id: string;
  raw: string;
  doc: OkfDocument;
}

const SKIP_DIRS = new Set(["node_modules"]);

// Yields forward-slash relative paths of concept files (reserved files excluded).
async function* walk(root: string, rel: string): AsyncGenerator<string> {
  const dir = rel ? join(root, rel) : root;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    const childRel = rel ? `${rel}/${name}` : name;
    if (entry.isDirectory()) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      yield* walk(root, childRel);
    } else if (entry.isFile() && name.endsWith(".md") && !isReservedName(name)) {
      yield childRel;
    }
  }
}

/** All concept ids in the bundle, sorted; reserved and hidden files excluded. */
export async function listConcepts(root: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const relPath of walk(root, "")) ids.push(relPathToId(relPath));
  return ids.sort();
}

/** Read and parse one concept by id. Throws if the id is unsafe or absent. */
export async function readConcept(root: string, id: string): Promise<Concept> {
  validateId(id);
  const raw = await readFile(idToAbsPath(root, id), "utf8");
  return { id, raw, doc: parse(raw) };
}
