// Bundle traversal: list concepts, read a concept by id, reserved-file handling.
// Walks the tree with explicit recursion so we can skip VCS/tooling dirs and
// build forward-slash ids regardless of OS separator.

import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { OkfParseError, parse, type OkfDocument } from "./document.ts";
import { idToAbsPath, isReservedName, relPathToId, validateId } from "./paths.ts";

export interface Concept {
  id: string;
  raw: string;
  doc: OkfDocument;
}

export interface PermissiveConcept extends Concept {
  /** False when frontmatter was unparseable (doc holds `{}` + raw body). */
  parsed: boolean;
}

const SKIP_DIRS = new Set(["node_modules"]);

// Yields forward-slash relative paths of all `.md` files (reserved included).
async function* walk(root: string, rel: string): AsyncGenerator<string> {
  const dir = rel ? join(root, rel) : root;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    const childRel = rel ? `${rel}/${name}` : name;
    if (entry.isDirectory()) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      yield* walk(root, childRel);
    } else if (entry.isFile() && name.endsWith(".md")) {
      yield childRel;
    }
  }
}

/** All `.md` files in the bundle as sorted forward-slash relative paths. */
export async function listMdFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const relPath of walk(root, "")) paths.push(relPath);
  return paths.sort();
}

/** All concept ids in the bundle, sorted; reserved and hidden files excluded. */
export async function listConcepts(root: string): Promise<string[]> {
  return (await listMdFiles(root))
    .filter((p) => !isReservedName(posix.basename(p)))
    .map(relPathToId);
}

/** Read and parse one concept by id. Throws if the id is unsafe or absent. */
export async function readConcept(root: string, id: string): Promise<Concept> {
  validateId(id);
  const raw = await readFile(idToAbsPath(root, id), "utf8");
  return { id, raw, doc: parse(raw) };
}

/** Permissive read: unparseable frontmatter yields `{}` + raw body, not a throw. */
export async function readConceptPermissive(
  root: string,
  id: string,
): Promise<PermissiveConcept> {
  validateId(id);
  const raw = await readFile(idToAbsPath(root, id), "utf8");
  try {
    return { id, raw, doc: parse(raw), parsed: true };
  } catch (e) {
    if (!(e instanceof OkfParseError)) throw e;
    return { id, raw, doc: { frontmatter: {}, body: raw }, parsed: false };
  }
}
