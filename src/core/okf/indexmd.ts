// index.md generation (Stage 1.2). Each index.md is okbrain-maintained below
// a human-editable head: the H1 title and the intro paragraphs before the
// first `##` heading are preserved on regeneration; every `##` section
// (Directories listing + per-type concept listings) is regenerated. The root
// index.md additionally carries `okf_version` frontmatter — the only index.md
// where frontmatter is allowed — with unknown keys preserved.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import { readConceptPermissive } from "./bundle.ts";
import { fmString, OkfParseError, parse, serialize } from "./document.ts";
import { isReservedName } from "./paths.ts";

/** The OKF spec version okbrain writes (declared in the root index.md). */
export const OKF_VERSION = "0.2";

const skipDir = (name: string) => name.startsWith(".") || name === "node_modules";

interface ExistingIndex {
  fm: Record<string, unknown>;
  h1?: string;
  intro?: string;
}

// Extract the preserved head of an existing index.md; null when absent or its
// frontmatter is unparseable (index.md is derived structure, safe to rebuild).
async function readExisting(absPath: string): Promise<ExistingIndex | null> {
  let raw: string;
  try {
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
  const at = doc.body.search(/^## /m);
  const head = at === -1 ? doc.body : doc.body.slice(0, at);
  let h1: string | undefined;
  const introLines: string[] = [];
  for (const line of head.split("\n")) {
    const m = /^# (.+)$/.exec(line);
    if (!h1 && m) h1 = m[1]!.trim();
    else introLines.push(line);
  }
  const intro = introLines.join("\n").trim();
  return { fm: doc.frontmatter, h1, intro: intro || undefined };
}

/** Regenerate `<dir>/index.md` (dir is a forward-slash id, "" for the root). */
export async function generateIndexMd(root: string, dir: string): Promise<void> {
  const abs = dir === "" ? root : join(root, ...dir.split("/"));
  const isRoot = dir === "";
  const existing = await readExisting(join(abs, "index.md"));
  const entries = await readdir(abs, { withFileTypes: true });

  // Immediate subdirectories that already have an index.md (so the link resolves).
  const dirRows: string[] = [];
  const subdirs = entries.filter((e) => e.isDirectory() && !skipDir(e.name));
  for (const name of subdirs.map((e) => e.name).sort()) {
    if (name === "db_only") continue; // private: never listed in a committed parent index
    const child = await readExisting(join(abs, name, "index.md"));
    if (!child) continue;
    const desc = child.intro?.split("\n")[0]?.replace(/\.$/, "");
    const target = isRoot ? `/${name}/index.md` : `/${dir}/${name}/index.md`;
    dirRows.push(`- [${name}](${target})${desc ? ` — ${desc}` : ""}`);
  }

  // Direct concepts grouped by type; rows sorted by title within each group.
  const byType = new Map<string, { title: string; row: string }[]>();
  const files = entries.filter(
    (e) => e.isFile() && e.name.endsWith(".md") && !isReservedName(e.name),
  );
  for (const name of files.map((e) => e.name).sort()) {
    const id = isRoot ? name.slice(0, -3) : `${dir}/${name.slice(0, -3)}`;
    const { doc } = await readConceptPermissive(root, id);
    const type = fmString(doc.frontmatter.type) || "untyped";
    const title = fmString(doc.frontmatter.title) || id;
    const desc = fmString(doc.frontmatter.description);
    const row = `- [${title}](/${id}.md)${desc ? ` — ${desc}` : ""}`;
    (byType.get(type) ?? byType.set(type, []).get(type)!).push({ title, row });
  }

  const title = existing?.h1 ?? (isRoot ? basename(resolve(root)) : posix.basename(dir));
  const intro =
    existing?.intro ??
    (isRoot ? "An Open Knowledge Format bundle." : `Concepts under /${dir}/.`);
  const parts = [`# ${title}`, "", intro];
  if (dirRows.length > 0) parts.push("", "## Directories", "", ...dirRows);
  for (const type of [...byType.keys()].sort()) {
    const rows = byType.get(type)!.sort((a, b) => a.title.localeCompare(b.title));
    parts.push("", `## ${type}`, "", ...rows.map((r) => r.row));
  }

  const fm: Record<string, unknown> = {};
  if (isRoot) {
    const prev = existing?.fm ?? {};
    const v = prev.okf_version;
    fm.okf_version = typeof v === "string" && v !== "" ? v : OKF_VERSION;
    for (const [k, val] of Object.entries(prev)) if (k !== "okf_version") fm[k] = val;
  }
  await writeFile(
    join(abs, "index.md"),
    serialize({ frontmatter: fm, body: parts.join("\n") + "\n" }),
    "utf8",
  );
}

/** Regenerate index.md for a touched dir and every ancestor up to the root. */
export async function regenerateIndexes(root: string, dir: string): Promise<void> {
  for (let d = dir; ; d = posix.dirname(d) === "." ? "" : posix.dirname(d)) {
    await generateIndexMd(root, d); // deepest first, so parents see fresh intros
    if (d === "") return;
  }
}
