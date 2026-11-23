// Bundle traversal: list concepts, read a concept by id, reserved-file handling.
// Walks the tree with explicit recursion so we can skip VCS/tooling dirs and
// build forward-slash ids regardless of OS separator.

import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { OkfParseError, parse, type OkfDocument } from "./document.ts";
import { conceptFile, isReservedName, relPathToId } from "./paths.ts";

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

/**
 * Symbolic links below the root, as sorted forward-slash paths. The walk above
 * skips them and no reader or writer follows them, so `okb doctor` names them.
 */
export async function listLinks(root: string, rel = ""): Promise<string[]> {
  const links: string[] = [];
  for (const entry of await readdir(rel ? join(root, rel) : root, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) links.push(childRel);
    else if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name))
      links.push(...await listLinks(root, childRel));
  }
  return links.sort();
}

/** All `.md` files in the bundle as sorted forward-slash relative paths. */
export async function listMdFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const relPath of walkMarkdownFiles(root)) paths.push(relPath);
  return paths.sort();
}

/** Stream bundle Markdown paths as traversed, including reserved files. */
export function walkMarkdownFiles(root: string): AsyncGenerator<string> {
  return walk(root, "");
}

/** All concept ids in the bundle, sorted; reserved and hidden files excluded. */
export async function listConcepts(root: string): Promise<string[]> {
  return (await listMdFiles(root))
    .filter((p) => !isReservedName(posix.basename(p)))
    .map(relPathToId);
}

/** Read and parse one concept by id. Throws if the id is unsafe or absent. */
export async function readConcept(root: string, id: string): Promise<Concept> {
  const raw = await readFile(await conceptFile(root, id), "utf8");
  return { id, raw, doc: parse(raw) };
}

/** Permissive read: unparseable frontmatter yields `{}` + raw body, not a throw. */
export async function readConceptPermissive(
  root: string,
  id: string,
): Promise<PermissiveConcept> {
  const raw = await readFile(await conceptFile(root, id), "utf8");
  try {
    return { id, raw, doc: parse(raw), parsed: true };
  } catch (e) {
    if (!(e instanceof OkfParseError)) throw e;
    return { id, raw, doc: { frontmatter: {}, body: raw }, parsed: false };
  }
}
