// The repository knowledge bundle: readable Markdown and YAML beside the
// derived atlas, written through the same conformance writer as every other
// okbrain note. Package cards record facts with evidence. Pattern skills
// record where a kind of change has to be wired in. A person can open, edit,
// search or graph the bundle with ordinary okbrain commands.

import { posix } from "node:path";
import { readConceptPermissive } from "../../okf/bundle.ts";
import { fmGenerated } from "../../okf/document.ts";
import { slugify } from "../../okf/paths.ts";
import { writeConceptBatch } from "../../okf/write.ts";
import { VERSION } from "../../version.ts";
import { knowledgeDirectory, type Atlas } from "./store.ts";

export const importActor = `okb-import/${VERSION}`;
export const packageType = "code package";
export const skillType = "code skill";
export const lessonType = "code lesson";
/** Everything from this heading on belongs to the people who maintain the bundle. */
export const notesHeading = "## Notes";

export interface KnowledgeReport {
  directory: string;
  packages: number;
  skills: number;
  written: number;
  unchanged: number;
  /** Cards a person has taken over, left as they are. */
  kept: number;
  removed: number;
}

const maxPatternSkills = 24;
const maxEdgeRows = 400_000;

function code(text: string): string {
  // Paths and names come from the repository. Keep them inside one inline code span.
  return `\`${text.replace(/[`\r\n]+/gu, " ").slice(0, 200)}\``;
}

function plain(text: string, length = 200): string {
  return text.replace(/[\x00-\x1f\x7f]+/gu, " ").replace(/[<>[\]`*_|]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, length);
}

interface PackageRow { id: number; root: string; name: string; ecosystem: string; manifest: string | null; description: string | null; owners: string; files: number; units: number }

function packageIds(packages: readonly PackageRow[]): Map<number, string> {
  const ids = new Map<number, string>();
  const used = new Set<string>();
  for (const pkg of packages) {
    const base = slugify(pkg.root === "." ? `root ${pkg.name}` : pkg.root) || `package-${pkg.id}`;
    let slug = base;
    for (let suffix = 2; used.has(slug); suffix++) slug = `${base}-${suffix}`;
    used.add(slug);
    ids.set(pkg.id, `packages/${slug}`);
  }
  return ids;
}

function packageCard(atlas: Atlas, pkg: PackageRow, ids: ReadonlyMap<number, string>, names: ReadonlyMap<number, string>): { description: string; body: string } {
  const lines: string[] = [`# ${plain(pkg.name, 120) || pkg.root}`, ""];
  const languages = atlas.all<{ language: string; count: number }>(
    "SELECT language, count(*) AS count FROM files WHERE package = ? GROUP BY language ORDER BY count DESC, language LIMIT 4", pkg.id);
  let owners: string[] = [];
  try { owners = (JSON.parse(pkg.owners) as unknown[]).filter((owner): owner is string => typeof owner === "string"); } catch { /* no owners */ }
  lines.push(`- Path: ${code(pkg.root)}`, `- Kind: ${pkg.ecosystem}, ${pkg.files} files, ${pkg.units} units`);
  if (pkg.manifest) lines.push(`- Manifest: ${code(pkg.manifest)}`);
  if (languages.length) lines.push(`- Languages: ${languages.map(({ language, count }) => `${language} (${count})`).join(", ")}`);
  if (owners.length) lines.push(`- Owners: ${owners.map((owner) => code(owner)).join(", ")}`);

  const entries = atlas.all<{ path: string; gist: string }>("SELECT path, gist FROM files WHERE package = ? AND role = 'entry' ORDER BY length(path), path LIMIT 5", pkg.id);
  if (entries.length) {
    lines.push("", "## Entry points");
    for (const { path, gist } of entries) lines.push(`- ${code(path)}${gist ? `: ${plain(gist, 120)}` : ""}`);
  }
  const declarations = atlas.all<{ name: string; path: string; line: number; gist: string }>(
    `SELECT u.name, f.path, u.start_line AS line, u.gist FROM units u JOIN files f ON f.id = u.file LEFT JOIN temp.inbound i ON i.file = f.id
     WHERE f.package = ? AND u.kind = 'symbol' AND f.role IN ('impl', 'entry', 'types') AND u.name NOT LIKE '% (%'
     ORDER BY coalesce(i.count, 0) DESC, f.path, u.ord LIMIT 12`, pkg.id);
  if (declarations.length) {
    lines.push("", "## Key declarations");
    for (const { name, path, line } of declarations) lines.push(`- ${code(name)} in ${code(`${path}:${line}`)}`);
  }
  const uses = atlas.all<{ dst: number; kind: string; weight: number }>(
    "SELECT dst, kind, weight FROM package_edges WHERE src = ? ORDER BY weight DESC, dst LIMIT 12", pkg.id);
  const usedBy = atlas.all<{ src: number; weight: number }>(
    "SELECT src, sum(weight) AS weight FROM package_edges WHERE dst = ? GROUP BY src ORDER BY weight DESC, src LIMIT 12", pkg.id);
  const link = (id: number) => `[${plain(names.get(id) ?? "package", 80)}](/${ids.get(id)}.md)`;
  if (uses.length) {
    lines.push("", "## Depends on");
    const seen = new Set<number>();
    for (const { dst, kind, weight } of uses) {
      if (seen.has(dst) || !ids.has(dst)) continue;
      seen.add(dst);
      lines.push(`- ${link(dst)} (${kind === "declared" ? "declared in the manifest" : `${weight} imports`})`);
    }
  }
  if (usedBy.length) {
    lines.push("", "## Used by");
    for (const { src } of usedBy) if (ids.has(src)) lines.push(`- ${link(src)}`);
  }
  const tools = atlas.all<{ kind: string; argv: string; cwd: string; source_path: string; source_line: number }>(
    "SELECT kind, argv, cwd, source_path, source_line FROM tools WHERE package = ? ORDER BY kind, id LIMIT 12", pkg.id);
  if (tools.length) {
    lines.push("", "## Checks and commands");
    for (const tool of tools) {
      let argv: string[] = [];
      try { argv = JSON.parse(tool.argv) as string[]; } catch { continue; }
      lines.push(`- ${tool.kind}: ${code(argv.join(" "))} in ${code(tool.cwd)} (from ${code(`${tool.source_path}:${tool.source_line}`)})`);
    }
  }
  const testDirs = new Map<string, number>();
  for (const { path } of atlas.all<{ path: string }>("SELECT path FROM files WHERE package = ? AND role = 'test' LIMIT 5000", pkg.id))
    testDirs.set(posix.dirname(path), (testDirs.get(posix.dirname(path)) ?? 0) + 1);
  if (testDirs.size) {
    lines.push("", "## Tests");
    for (const [directory, count] of [...testDirs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4))
      lines.push(`- ${code(directory)} (${count} files)`);
  }
  const coupling = atlas.all<{ a: string; b: string; weight: number }>(
    `SELECT fa.path AS a, fb.path AS b, e.weight FROM file_edges e JOIN files fa ON fa.id = e.src JOIN files fb ON fb.id = e.dst
     WHERE e.kind = 'cochange' AND (fa.package = ?1 OR fb.package = ?1) AND fa.package != fb.package ORDER BY e.weight DESC, fa.path, fb.path LIMIT 5`, pkg.id);
  if (coupling.length) {
    lines.push("", "## Changes together with other packages");
    for (const { a, b } of coupling) lines.push(`- ${code(a)} and ${code(b)}`);
  }
  const description = plain(pkg.description ?? "", 180)
    || `${pkg.ecosystem === "root" ? "Repository root" : `${pkg.ecosystem} package`} at ${pkg.root} with ${pkg.files} files.`;
  return { description, body: lines.join("\n") };
}

interface PatternSkill { id: string; title: string; description: string; body: string; anchors: string[] }

/** Directories whose modules are all wired into one file: the place a new module has to be added too. */
function patternSkills(atlas: Atlas): PatternSkill[] {
  const perDirectory = new Map<string, number>();
  for (const { path } of atlas.all<{ path: string }>("SELECT path FROM files WHERE role IN ('impl', 'entry', 'types') LIMIT 400000"))
    perDirectory.set(posix.dirname(path), (perDirectory.get(posix.dirname(path)) ?? 0) + 1);
  const groups = new Map<string, Set<string>>();
  for (const { src, dst } of atlas.all<{ src: string; dst: string }>(
    `SELECT s.path AS src, d.path AS dst FROM file_edges e JOIN files s ON s.id = e.src JOIN files d ON d.id = e.dst
     WHERE e.kind = 'import' AND s.role != 'test' AND d.role != 'test' LIMIT ?`, maxEdgeRows)) {
    const directory = posix.dirname(dst);
    const home = posix.dirname(src);
    // A registry sits in the directory it wires, or directly above it.
    if (home !== directory && home !== posix.dirname(directory)) continue;
    const key = `${src}\0${directory}`;
    let members = groups.get(key);
    if (!members) groups.set(key, members = new Set());
    members.add(dst);
  }
  const best = new Map<string, { registry: string; members: string[]; total: number }>();
  for (const [key, members] of groups) {
    const [registry, directory] = key.split("\0") as [string, string];
    const total = (perDirectory.get(directory) ?? 0) - Number(posix.dirname(registry) === directory);
    if (members.size < 4 || total < 4 || members.size / total < 0.6) continue;
    const current = best.get(directory);
    if (!current || members.size > current.members.length) best.set(directory, { registry, members: [...members].sort(), total });
  }
  const skills: PatternSkill[] = [];
  for (const [directory, { registry, members, total }] of [...best.entries()].sort((a, b) => b[1].members.length - a[1].members.length || (a[0] < b[0] ? -1 : 1)).slice(0, maxPatternSkills)) {
    const tests = atlas.all<{ path: string }>(
      `SELECT DISTINCT t.path FROM file_edges e JOIN files t ON t.id = e.src JOIN files s ON s.id = e.dst
       WHERE e.kind = 'test' AND s.path >= ? AND s.path < ? ORDER BY t.path LIMIT 64`, `${directory}/`, `${directory}0`);
    const testDirectory = [...tests.reduce((counts, { path }) => counts.set(posix.dirname(path), (counts.get(posix.dirname(path)) ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    const body = [
      `# Modules in ${directory}`, "",
      `- ${code(registry)} imports ${members.length} of the ${total} modules in ${code(directory)}.`,
      `- A module added to, renamed in, or removed from ${code(directory)} usually needs a matching change in ${code(registry)}.`,
      `- Existing modules to model a new one on: ${members.slice(0, 3).map((member) => code(member)).join(", ")}.`,
      ...(testDirectory ? [`- Their tests are in ${code(testDirectory)}.`] : []),
    ].join("\n");
    skills.push({
      id: `skills/wiring-${slugify(directory) || "root"}`, title: `Modules in ${directory} are wired in ${posix.basename(registry)}`,
      description: `Where a new or renamed module under ${directory} has to be registered.`, body, anchors: [directory, registry],
    });
  }
  const guides = atlas.all<{ path: string }>(
    "SELECT path FROM files WHERE lower(path) IN ('agents.md', 'claude.md', 'contributing.md', 'docs/contributing.md', '.github/contributing.md') ORDER BY path LIMIT 3");
  if (guides.length) {
    const body = ["# Repository guidance", ""];
    for (const { path } of guides) {
      const sections = atlas.all<{ name: string; line: number }>(
        "SELECT u.name, u.start_line AS line FROM units u JOIN files f ON f.id = u.file WHERE f.path = ? AND u.kind = 'section' ORDER BY u.ord LIMIT 8", path);
      body.push(`- ${code(path)}${sections.length ? `: ${sections.map(({ name, line }) => `${plain(name, 60)} (line ${line})`).join("; ")}` : ""}`);
    }
    skills.push({
      id: "skills/repository-guidance", title: "Where this repository states its own rules",
      description: "Pointers to the contributor guidance files and their sections.", body: body.join("\n"), anchors: ["."],
    });
  }
  return skills;
}

/** Keep what a person wrote under the notes heading when the generated part is refreshed. */
function withNotes(generated: string, existing: string | undefined): string {
  const start = existing?.indexOf(`\n${notesHeading}`) ?? -1;
  return start < 0 ? generated : `${generated}\n${existing!.slice(start)}`.trimEnd();
}

/** Write or refresh the knowledge bundle from the atlas. Needs the import's writable handle. */
export async function writeKnowledge(atlas: Atlas, digest: (text: string) => string): Promise<KnowledgeReport> {
  const directory = knowledgeDirectory(atlas.directory);
  atlas.db.exec(`CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY, sha256 TEXT NOT NULL) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS inbound(file INTEGER PRIMARY KEY, count INTEGER NOT NULL);
    DELETE FROM temp.inbound;
    INSERT INTO temp.inbound SELECT dst, count(*) FROM file_edges WHERE kind = 'import' GROUP BY dst;`);
  const packages = atlas.all<PackageRow>("SELECT id, root, name, ecosystem, manifest, description, owners, files, units FROM packages ORDER BY root");
  const ids = packageIds(packages);
  const names = new Map(packages.map((pkg) => [pkg.id, pkg.name]));
  const saved = new Map(atlas.all<{ id: string; sha256: string }>("SELECT id, sha256 FROM knowledge").map(({ id, sha256 }) => [id, sha256]));
  const report: KnowledgeReport = { directory, packages: 0, skills: 0, written: 0, unchanged: 0, kept: 0, removed: 0 };
  const current = new Set<string>();
  const drafts: { id: string; type: string; title: string; description: string; body: string; tags: string[]; extra?: Record<string, unknown>; status?: string }[] = [];
  for (const pkg of packages) {
    if (pkg.files === 0 && pkg.root !== ".") continue;
    const { description, body } = packageCard(atlas, pkg, ids, names);
    drafts.push({ id: ids.get(pkg.id)!, type: packageType, title: plain(pkg.name, 120) || pkg.root, description, body, tags: ["code", pkg.ecosystem],
      extra: { root: pkg.root } });
    report.packages++;
  }
  for (const skill of patternSkills(atlas)) {
    // A generated skill starts as a draft: it is delivered to a random half of eligible requests until its effect is known.
    drafts.push({ ...skill, type: skillType, tags: ["code", "skill"], extra: { anchors: skill.anchors }, status: "draft" });
    report.skills++;
  }
  await writeConceptBatch(directory, async (add) => {
    for (const draft of drafts) {
      current.add(draft.id);
      const hash = digest(JSON.stringify([draft.title, draft.description, draft.body, draft.extra ?? null]));
      if (saved.get(draft.id) === hash) { report.unchanged++; continue; }
      let existing;
      try { existing = await readConceptPermissive(directory, draft.id); } catch { existing = undefined; }
      const author = existing?.parsed ? fmGenerated(existing.doc.frontmatter)?.by : undefined;
      // A card someone else last wrote is theirs now. The import leaves it alone.
      if (existing && (!existing.parsed || (author !== undefined && !author.startsWith("okb-import/")))) { report.kept++; continue; }
      await add({
        id: draft.id, type: draft.type, title: draft.title, description: draft.description, tags: draft.tags, actor: importActor,
        body: withNotes(draft.body, existing?.doc.body), ...(draft.extra ? { extra: draft.extra } : {}),
        // An existing skill keeps the status measurement or a person gave it.
        ...(draft.status && !existing ? { status: draft.status } : {}),
      });
      atlas.run("INSERT INTO knowledge(id, sha256) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET sha256 = excluded.sha256", draft.id, hash);
      report.written++;
    }
    // A package or pattern that no longer exists is marked, not deleted: its notes may still matter.
    for (const id of saved.keys()) {
      if (current.has(id)) continue;
      try {
        const existing = await readConceptPermissive(directory, id);
        if (existing.parsed && fmGenerated(existing.doc.frontmatter)?.by.startsWith("okb-import/"))
          await add({ id, status: "deprecated", actor: importActor, body: `${existing.doc.body.trimEnd()}\n\nNo longer present in the repository as of the latest import.` });
      } catch { /* Already removed by hand. */ }
      atlas.run("DELETE FROM knowledge WHERE id = ?", id);
      report.removed++;
    }
  });
  return report;
}
