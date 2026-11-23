// index.md generation (Stage 1.2). Each index.md is okbrain-maintained below
// a human-editable head. Grouped indexes use H2 sections and absolute links.
// Reference-style indexes use H1 sections and relative links below a marker.
// The root
// index.md additionally carries `okf_version` frontmatter — the only index.md
// where frontmatter is allowed — with unknown keys preserved.

import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import { markdownOutsideCode } from "../graph/links.ts";
import { listMdFiles, readConceptPermissive } from "./bundle.ts";
import { fmString, OkfParseError, parse, serialize } from "./document.ts";
import { assertBundleFile, inDbOnlyDir, isReservedName } from "./paths.ts";
import { isPrivateConcept } from "./privacy.ts";

/** The OKF spec version okbrain writes (declared in the root index.md). */
export const OKF_VERSION = "0.2";
export type IndexStyle = "grouped" | "reference";
const referenceMarker = "<!-- okbrain index sections -->";

const skipDir = (name: string) => name.startsWith(".") || name === "node_modules";
const pendingIndexWrites = new Map<string, Promise<void>>();

interface ExistingIndex {
  fm: Record<string, unknown>;
  h1?: string;
  intro?: string;
}

// Extract the preserved head of an existing index.md; null when absent or its
// frontmatter is unparseable (index.md is derived structure, safe to rebuild).
// A link or special file in its place is treated as absent: its target's text
// must not be copied into a parent index that Git then shares (B23).
async function readExisting(absPath: string): Promise<ExistingIndex | null> {
  let raw: string;
  try {
    if (!(await lstat(absPath)).isFile()) return null;
    raw = await readFile(absPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let doc;
  try {
    doc = parse(raw);
  } catch (e) {
    if (!(e instanceof OkfParseError)) throw e;
    return null;
  }
  const headings = markdownOutsideCode(doc.body);
  const marker = headings.search(/^<!-- okbrain index sections -->$/m);
  const at = marker >= 0 ? marker : headings.search(/^##[ \t]+/m);
  const head = at === -1 ? doc.body : doc.body.slice(0, at);
  const title = /^#[ \t]+(.+)$/m.exec(headings.slice(0, head.length));
  const h1 = title?.[1]?.trim();
  const intro = (title ? head.slice(0, title.index) + head.slice(title.index + title[0].length + 1) : head).trim();
  return { fm: doc.frontmatter, h1, intro: intro || undefined };
}

async function configuredIndexStyle(root: string): Promise<IndexStyle> {
  const existing = await readExisting(join(root, "index.md"));
  return existing?.fm.okbrain_index_style === "reference" ? "reference" : "grouped";
}

function linkPart(value: string): string {
  return encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Regenerate `<dir>/index.md` (dir is a forward-slash id, "" for the root). */
export async function generateIndexMd(root: string, dir: string, selectedStyle?: IndexStyle): Promise<void> {
  const style = selectedStyle ?? await configuredIndexStyle(root);
  const reference = style === "reference";
  const bullet = reference ? "*" : "-";
  const heading = reference ? "#" : "##";
  const punctuation = reference ? " - " : " — ";
  const abs = dir === "" ? root : join(root, ...dir.split("/"));
  const isRoot = dir === "";
  await assertBundleFile(root, isRoot ? "index.md" : `${dir}/index.md`);
  const existing = await readExisting(join(abs, "index.md"));
  const entries = await readdir(abs, { withFileTypes: true });

  // Immediate subdirectories that already have an index.md (so the link resolves).
  const dirRows: string[] = [];
  const subdirs = entries.filter((e) => e.isDirectory() && !skipDir(e.name));
  for (const name of subdirs.map((e) => e.name).sort()) {
    if (name.toLowerCase() === "db_only") continue; // private: never listed in a committed parent index
    const child = await readExisting(join(abs, name, "index.md"));
    if (!child) continue;
    const desc = child.intro?.split("\n")[0]?.replace(/\.$/, "");
    const target = reference ? `${linkPart(name)}/index.md` : `/${dir ? `${dir}/` : ""}${name}/index.md`;
    dirRows.push(`${bullet} [${name}](${target})${desc ? punctuation + desc : ""}`);
  }

  // Direct concepts grouped by type; rows sorted by title within each group.
  const byType = new Map<string, { title: string; row: string }[]>();
  const files = entries.filter(
    (e) => e.isFile() && e.name.endsWith(".md") && !isReservedName(e.name),
  );
  for (const name of files.map((e) => e.name).sort()) {
    const id = isRoot ? name.slice(0, -3) : `${dir}/${name.slice(0, -3)}`;
    const { doc } = await readConceptPermissive(root, id);
    if (!inDbOnlyDir(id.toLowerCase()) && isPrivateConcept(id, doc.frontmatter)) continue;
    const type = fmString(doc.frontmatter.type) || "untyped";
    const title = fmString(doc.frontmatter.title) || id;
    const desc = fmString(doc.frontmatter.description);
    const target = reference ? linkPart(name) : `/${id}.md`;
    const row = `${bullet} [${title}](${target})${desc ? punctuation + desc : ""}`;
    (byType.get(type) ?? byType.set(type, []).get(type)!).push({ title, row });
  }

  const title = existing?.h1 ?? (isRoot ? basename(resolve(root)) : posix.basename(dir));
  const intro =
    existing?.intro ??
    (isRoot ? "An Open Knowledge Format bundle." : `Concepts under /${dir}/.`);
  const parts = [`# ${title}`, "", intro];
  if (reference) parts.push("", referenceMarker);
  if (dirRows.length > 0) parts.push("", `${heading} ${reference ? "Subdirectories" : "Directories"}`, "", ...dirRows);
  for (const type of [...byType.keys()].sort()) {
    const rows = byType.get(type)!.sort((a, b) => a.title.localeCompare(b.title));
    parts.push("", `${heading} ${type}`, "", ...rows.map((r) => r.row));
  }

  const fm: Record<string, unknown> = {};
  if (isRoot) {
    const prev = existing?.fm ?? {};
    const v = prev.okf_version;
    fm.okf_version = typeof v === "string" && v !== "" ? v : OKF_VERSION;
    for (const [k, val] of Object.entries(prev)) if (k !== "okf_version") fm[k] = val;
    if (reference) fm.okbrain_index_style = "reference";
    else if (fm.okbrain_index_style === "reference") delete fm.okbrain_index_style;
  }
  await writeFile(
    join(abs, "index.md"),
    serialize({ frontmatter: fm, body: parts.join("\n") + "\n" }),
    "utf8",
  );
}

/** Regenerate index.md for a touched dir and every ancestor up to the root. */
export async function regenerateIndexes(root: string, dir: string): Promise<void> {
  await regenerateIndexBranches(root, [dir]);
}

/** Regenerate each touched directory and ancestor once, with children before parents. */
export async function regenerateIndexBranches(root: string, dirs: Iterable<string>, selectedStyle?: IndexStyle): Promise<void> {
  const pending = new Map<string, number>();
  for (const dir of dirs) {
    let depth = dir ? dir.split("/").length : 0;
    for (let path = dir; !pending.has(path); path = posix.dirname(path) === "." ? "" : posix.dirname(path)) {
      pending.set(path, depth--);
      if (path === "") break;
    }
  }
  if (!pending.size) return;
  const branches = [...pending].sort((a, b) => b[1] - a[1]);
  const key = resolve(root);
  const previous = pendingIndexWrites.get(key);
  const write = (previous?.catch(() => {}) ?? Promise.resolve()).then(async () => {
    const style = selectedStyle ?? await configuredIndexStyle(root);
    if (selectedStyle) {
      for (const [directory] of branches) {
        const path = join(root, ...directory.split("/"), "index.md");
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        if (info && !info.isFile()) throw new Error(`Choose a regular file for ${directory ? `${directory}/` : ""}index.md before changing the format.`);
      }
    }
    for (const [path] of branches) await generateIndexMd(root, path, style);
  });
  pendingIndexWrites.set(key, write);
  try { await write; }
  finally { if (pendingIndexWrites.get(key) === write) pendingIndexWrites.delete(key); }
}

/** Change existing manifests and keep that format for subsequent concept writes. */
export async function setIndexStyle(root: string, style: IndexStyle): Promise<void> {
  const dirs = new Set([""]);
  for (const file of await listMdFiles(root)) {
    const parent = posix.dirname(file);
    if (parent !== ".") dirs.add(parent);
  }
  await regenerateIndexBranches(root, dirs, style);
}
