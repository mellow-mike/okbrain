// Repository import: map a checkout of any size into the atlas. The first
// import reads every eligible tracked file once. Later imports read only
// files whose worktree fingerprint changed, then relink and re-publish.

import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, posix } from "node:path";
import { setImmediate } from "node:timers/promises";
import { excludedPath, readRevision, readTrackedText, worktreeStamp } from "../repository-context.ts";
import { dependencyResolver, fileStructure, type RepositoryFileStructure } from "../repository-index.ts";
import { profilePath } from "../project-profile.ts";
import { applyAliases } from "./aliases.ts";
import { writeKnowledge, type KnowledgeReport } from "./knowledge.ts";
import { Learning } from "./learn.ts";
import { detectPackages, internalDependencies, packageOf, packageRootMarkers, type CommandTool, type PackageInfo } from "./packages.ts";
import { AtlasScanError, listTrackedPaths, mineChangeCoupling, ownersOf, parseCodeOwners, trackedAmong } from "./scan.ts";
import { Atlas, AtlasError, type AtlasLocation, type AtlasMeta } from "./store.ts";
import { analyzeSource, languageOf, roles, type SourceFile } from "./structure.ts";
import {
  addRow, addTerms, dfBucket, embedBag, embeddingDim, emptyFrequencies, inverseFrequency, normalize, quantize, type DocumentFrequencies,
} from "./text.ts";

export interface ImportProgress {
  phase: "list" | "read" | "link" | "history" | "embed" | "publish" | "knowledge";
  done: number;
  total: number;
}

export interface ImportOptions {
  workspace: string;
  /** Workspace-relative directories to import. Defaults to the whole workspace. */
  scopes?: string[];
  /** Commits of history to mine for change coupling. Zero skips history. */
  historyCommits?: number;
  /** Re-read every file and rebuild term statistics. */
  full?: boolean;
  maxFiles?: number;
  signal?: AbortSignal;
  progress?: (event: ImportProgress) => void;
}

export interface ImportReport {
  workspace: string;
  revision?: string;
  generation: number;
  scopes: string[];
  trackedPaths: number;
  files: number;
  units: number;
  packages: number;
  tools: number;
  changedFiles: number;
  unchangedFiles: number;
  removedFiles: number;
  skippedFiles: number;
  importEdges: number;
  testEdges: number;
  couplingEdges: number;
  historyCommits: number;
  reembedded: boolean;
  limitsReached: { trackedPaths: boolean; files: boolean; packages: boolean; fileBytes: number };
  knowledge: KnowledgeReport;
  durationMs: number;
}

export const defaultHistoryCommits = 2000;
const defaultMaxFiles = 400_000;
const maxFileBytes = 512 * 1024;
const maxScopes = 32;
const readBatch = 24;
const commitEvery = 480;
const maxBodyTerms = 600;
const maxEmbeddedBodyTerms = 32;
const maxSymbolsPerUnit = 48;
/** Weights of the fields when a unit's stored terms are embedded. */
const fieldWeights = { name: 4, path: 2, alias: 3, body: 1 } as const;
/** How much a unit's vector takes from its file, its linked files, and its package. */
const propagation = { file: 0.35, linked: 0.25, package: 0.1 } as const;
const edgeWeights: Record<string, number> = { import: 1, test: 1, cochange: 0.8 };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function canonicalWorkspace(path: string): Promise<string> {
  const workspace = await realpath(path).catch(() => undefined);
  if (!workspace || !(await stat(workspace).catch(() => undefined))?.isDirectory())
    throw new AtlasError("Choose an existing coding workspace directory.");
  return workspace;
}

export function normalizeScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes?.length) return ["."];
  if (scopes.length > maxScopes) throw new AtlasError(`Import at most ${maxScopes} workspace-relative directories.`);
  const normalized = new Set<string>();
  for (const scope of scopes) {
    const path = typeof scope === "string" && Buffer.byteLength(scope) <= 512 ? profilePath(scope) : undefined;
    if (!path) throw new AtlasError(`Import scope ${JSON.stringify(scope)} must be a workspace-relative directory.`);
    normalized.add(path);
  }
  return normalized.has(".") ? ["."] : [...normalized].sort();
}

/** Terms as stored for search: each distinct term, repeated up to three times by frequency. */
function termText(bag: Map<string, number>, limit: number): string {
  const ranked = bag.size > limit ? [...bag.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit) : [...bag.entries()];
  const parts: string[] = [];
  for (const [term, count] of ranked) {
    if (!/^[\p{L}\p{N}_$]+$/u.test(term)) continue;
    const repeats = Math.min(3, Math.max(1, Math.round(count)));
    for (let index = 0; index < repeats; index++) parts.push(term);
  }
  return parts.join(" ");
}

/**
 * Rebuild a unit's weighted bag from its stored search text, so vectors never
 * need the worktree. Names, path and learned aliases all count. Of the body,
 * only the most distinctive terms do: a hashed vector has a fixed noise floor,
 * and a unit described by a few rare terms stands further above it than one
 * described by everything it mentions. Exhaustive body matching is the
 * lexical lane's job.
 */
export function storedBag(
  row: { name: string; path: string; alias: string; body: string }, frequencies?: DocumentFrequencies,
): Map<string, number> {
  const bag = new Map<string, number>();
  for (const field of ["name", "path", "alias"] as const) {
    const weight = fieldWeights[field];
    for (const term of row[field].split(" ")) if (term) bag.set(term, (bag.get(term) ?? 0) + weight);
  }
  const body = new Map<string, number>();
  for (const term of row.body.split(" ")) if (term) body.set(term, (body.get(term) ?? 0) + fieldWeights.body);
  const distinctive = [...body.entries()]
    .map(([term, count]) => [term, count, (1 + Math.log(count + 1)) * inverseFrequency(frequencies, term)] as const)
    .sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1)).slice(0, maxEmbeddedBodyTerms);
  for (const [term, count] of distinctive) bag.set(term, (bag.get(term) ?? 0) + count);
  return bag;
}

interface FileRow { id: number; path: string; sha256: string; stamp: string }
type Analyzed = { path: string; stamp: string; sha: string; limited: boolean; source: SourceFile };

class Linker {
  readonly #tracked: Set<string>;
  readonly #byId: Map<string, number>;
  readonly #suffixes = new Map<string, string[]>();
  readonly #stems = new Map<string, string[]>();
  readonly #goDirs = new Map<string, string[]>();
  readonly #script: (importer: string, specifier: string) => string | undefined;
  readonly #goModules: { name: string; root: string }[];
  readonly #crates: Map<string, string>;

  constructor(files: readonly { id: number; path: string; language: string; role: string }[], packages: readonly PackageInfo[],
    scriptPackages: ReadonlyMap<string, RepositoryFileStructure>) {
    this.#tracked = new Set(files.map((file) => file.path));
    this.#byId = new Map(files.map((file) => [file.path, file.id]));
    this.#script = dependencyResolver(scriptPackages, this.#tracked);
    this.#goModules = packages.filter((pkg) => pkg.ecosystem === "go").map(({ name, root }) => ({ name, root })).sort((a, b) => b.name.length - a.name.length);
    this.#crates = new Map(packages.filter((pkg) => pkg.ecosystem === "cargo").map(({ name, root }) => [name.replaceAll("-", "_"), root]));
    for (const { path, language, role } of files) {
      const extension = posix.extname(path);
      const stemPath = path.slice(0, path.length - extension.length);
      if (["python", "java", "kotlin", "scala", "c", "cpp", "objc", "ruby", "php", "dart"].includes(language)) {
        // Index up to four trailing segments, with and without the extension, for suffix lookups.
        const segments = (language === "c" || language === "cpp" || language === "objc" ? path : stemPath).split("/");
        for (let take = 1; take <= Math.min(4, segments.length); take++) this.#push(this.#suffixes, segments.slice(-take).join("/"), path);
        if (language === "python" && posix.basename(stemPath) === "__init__" && segments.length > 1) {
          const pkg = segments.slice(0, -1);
          for (let take = 1; take <= Math.min(4, pkg.length); take++) this.#push(this.#suffixes, pkg.slice(-take).join("/"), path);
        }
      }
      if (language === "go" && role !== "test") this.#push(this.#goDirs, posix.dirname(path), path, 8);
      if (role !== "test") this.#push(this.#stems, posix.basename(stemPath).toLowerCase(), path, 6);
    }
  }

  #push(map: Map<string, string[]>, key: string, path: string, cap = 4): void {
    const list = map.get(key);
    if (!list) map.set(key, [path]);
    else if (list.length < cap) list.push(path);
  }

  id(path: string): number | undefined { return this.#byId.get(path); }

  #nearest(importer: string, candidates: string[] | undefined): string | undefined {
    if (!candidates?.length) return undefined;
    if (candidates.length === 1) return candidates[0];
    const directory = posix.dirname(importer).split("/");
    let best: string | undefined;
    let bestShared = -1;
    for (const candidate of candidates) {
      const parts = candidate.split("/");
      let shared = 0;
      while (shared < directory.length && parts[shared] === directory[shared]) shared++;
      if (shared > bestShared) { best = candidate; bestShared = shared; }
    }
    return best;
  }

  #first(...candidates: string[]): string | undefined {
    return candidates.find((candidate) => this.#tracked.has(candidate));
  }

  /** Files an import specifier refers to. Unresolvable and external imports yield nothing. */
  resolve(importer: string, language: string, specifier: string): string[] {
    const directory = posix.dirname(importer);
    const join = (...parts: string[]) => posix.normalize(posix.join(...parts));
    switch (language) {
      case "typescript": case "javascript": case "markup": {
        const target = this.#script(importer, specifier);
        return target ? [target] : [];
      }
      case "python": {
        const dots = /^\.*/u.exec(specifier)![0].length;
        const rest = specifier.slice(dots).split(".").filter(Boolean);
        if (dots > 0) {
          let base = directory;
          for (let up = 1; up < dots; up++) base = posix.dirname(base);
          const stem = rest.length ? join(base, ...rest) : base;
          const target = this.#first(`${stem}.py`, `${stem}/__init__.py`, `${stem}.pyi`);
          return target ? [target] : [];
        }
        for (let take = Math.min(4, rest.length); take >= 2; take--) {
          const target = this.#nearest(importer, this.#suffixes.get(rest.slice(-take).join("/")));
          if (target) return [target];
        }
        // A single-segment module is only trusted when it sits beside the importer.
        const local = rest.length ? this.#first(join(directory, `${rest.join("/")}.py`), join(directory, rest.join("/"), "__init__.py")) : undefined;
        return local ? [local] : [];
      }
      case "go": {
        for (const { name, root } of this.#goModules) {
          if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
          return this.#goDirs.get(join(root, specifier.slice(name.length + 1) || ".")) ?? [];
        }
        return [];
      }
      case "rust": {
        if (specifier.startsWith("mod:")) {
          const name = specifier.slice(4);
          const stem = posix.basename(importer, ".rs");
          const home = stem === "lib" || stem === "main" || stem === "mod" ? directory : join(directory, stem);
          const target = this.#first(join(home, `${name}.rs`), join(home, name, "mod.rs"));
          return target ? [target] : [];
        }
        if (specifier.startsWith("crate:")) {
          const root = this.#crates.get(specifier.slice(6));
          const target = root === undefined ? undefined : this.#first(join(root, "src/lib.rs"), join(root, "lib.rs"));
          return target ? [target] : [];
        }
        const source = importer.lastIndexOf("/src/") >= 0 ? importer.slice(0, importer.lastIndexOf("/src/") + 4) : importer.startsWith("src/") ? "src" : directory;
        const parts = specifier.split("::").slice(1);
        for (let take = parts.length; take >= 1; take--) {
          const stem = join(source, ...parts.slice(0, take));
          const target = this.#first(`${stem}.rs`, `${stem}/mod.rs`);
          if (target) return [target];
        }
        return [];
      }
      case "java": case "kotlin": case "scala": {
        const parts = specifier.split(".");
        for (let take = Math.min(4, parts.length); take >= 2; take--) {
          const target = this.#nearest(importer, this.#suffixes.get(parts.slice(-take).join("/")));
          if (target) return [target];
        }
        return [];
      }
      case "c": case "cpp": case "objc": {
        const name = specifier.slice(4);
        const local = this.#first(join(directory, name));
        if (local) return [local];
        const target = this.#nearest(importer, this.#suffixes.get(name.split("/").slice(-4).join("/")));
        return target ? [target] : [];
      }
      case "ruby": case "php": case "dart": {
        if (!specifier.startsWith(".")) {
          const target = this.#nearest(importer, this.#suffixes.get(specifier.replace(/^package:[^/]+\//u, "").replace(/\.\w+$/u, "").split("/").slice(-4).join("/")));
          return target && target !== importer ? [target] : [];
        }
        const stem = join(directory, specifier);
        const target = this.#first(stem, `${stem}.rb`, `${stem}.php`, `${stem}.dart`);
        return target ? [target] : [];
      }
      default: return [];
    }
  }

  /** The source file a test is named after, when one exists. */
  subject(test: string): string | undefined {
    const stem = posix.basename(test).replace(/\.[^.]+$/u, "")
      .replace(/[._-](?:test|spec|tests|e2e)$/iu, "").replace(/^test_/iu, "").replace(/_test$/iu, "").replace(/(?:Tests?|Spec|IT)$/u, "");
    if (!stem) return undefined;
    const target = this.#nearest(test, this.#stems.get(stem.toLowerCase()));
    return target && target !== test ? target : undefined;
  }
}

function report(options: ImportOptions, phase: ImportProgress["phase"], done: number, total: number): void {
  options.signal?.throwIfAborted();
  options.progress?.({ phase, done, total });
  options.signal?.throwIfAborted();
}

async function yieldProgress(options: ImportOptions, phase: ImportProgress["phase"], done: number, total: number): Promise<void> {
  report(options, phase, done, total);
  // A browser cancellation needs an event-loop turn while the import is doing synchronous SQLite and vector work.
  if (options.signal) {
    await setImmediate();
    options.signal.throwIfAborted();
  }
}

/**
 * How an import's writes become visible.
 *
 * Until a map has been published nothing can read it, so each step commits as
 * it finishes and an interrupted first import resumes where it stopped. Once a
 * map is published, requests are reading it: every step then joins a single
 * transaction that commits together with the new generation, so a reader sees
 * the previous map or the new one and never a mixture of the two.
 */
class Steps {
  readonly #db: Atlas["db"];
  readonly atomic: boolean;
  constructor(db: Atlas["db"], atomic: boolean) {
    this.#db = db;
    this.atomic = atomic;
  }
  begin(): void { if (!this.#db.inTransaction) this.#db.exec("BEGIN IMMEDIATE"); }
  /** The end of one step. */
  end(): void { if (!this.atomic && this.#db.inTransaction) this.#db.exec("COMMIT"); }
  /** A point inside a long step where partial work may be kept. */
  checkpoint(): void { if (!this.atomic && this.#db.inTransaction) this.#db.exec("COMMIT; BEGIN IMMEDIATE"); }
  /** Make everything visible. */
  finish(): void { if (this.#db.inTransaction) this.#db.exec("COMMIT"); }
}

/**
 * Import or refresh a workspace's atlas. An interrupted first import resumes on
 * the next run. An interrupted later import changes nothing: the map that was
 * published before it stays in use.
 */
export async function importRepository(options: ImportOptions, location: AtlasLocation = {}): Promise<ImportReport> {
  const started = performance.now();
  const workspace = await canonicalWorkspace(options.workspace);
  const scopes = normalizeScopes(options.scopes);
  const full = options.full === true;
  const historyLimit = options.historyCommits ?? defaultHistoryCommits;
  const atlas = Atlas.create(workspace, location);
  try {
    const previous = atlas.meta();
    const steps = new Steps(atlas.db, previous.generation > 0);
    const revision = await readRevision(workspace);
    report(options, "list", 0, 1);
    let listing;
    let scopedRootMarkers: Set<string> | undefined;
    try {
      listing = await listTrackedPaths(workspace, scopes, { signal: options.signal });
      if (!scopes.includes(".") || listing.limited) {
        // Root marker presence configures package discovery. The contents and all other root paths remain outside the scope.
        scopedRootMarkers = await trackedAmong(workspace, packageRootMarkers, { signal: options.signal });
      }
    } catch (error) {
      if (error instanceof AtlasScanError) throw new AtlasError(error.message, { cause: error });
      throw error;
    }
    const visible = listing.paths.filter((path) => !excludedPath(path));
    const maxFiles = Math.max(1, Math.min(options.maxFiles ?? defaultMaxFiles, 2_000_000));
    const indexable = visible.filter((path) => languageOf(path) !== undefined);
    const eligible = indexable.length > maxFiles ? indexable.slice(0, maxFiles) : indexable;

    const readText = async (path: string) => (await readTrackedText(workspace, path, 256 * 1024))?.lines.join("\n");
    const packageMap = await detectPackages(visible, readText, {
      workspaceName: basename(workspace), rootFiles: scopedRootMarkers ?? listing.paths.filter((path) => !path.includes("/")),
    });
    const roots = new Set(packageMap.packages.map((pkg) => pkg.root));

    // Packages keep their ids across imports so learned state can refer to them.
    const ownerRules = await readOwners(workspace, visible);
    steps.begin();
    for (const pkg of packageMap.packages) {
      atlas.run(`INSERT INTO packages(root, name, ecosystem, manifest, description, owners) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(root) DO UPDATE SET name = excluded.name, ecosystem = excluded.ecosystem, manifest = excluded.manifest,
          description = excluded.description, owners = excluded.owners`,
        pkg.root, pkg.name, pkg.ecosystem, pkg.manifest ?? null, pkg.description ?? null, JSON.stringify(ownersOf(pkg.root, ownerRules)));
    }
    for (const { root } of atlas.all<{ root: string }>("SELECT root FROM packages")) if (!roots.has(root)) atlas.run("DELETE FROM packages WHERE root = ?", root);
    const packageIds = new Map(atlas.all<{ id: number; root: string }>("SELECT id, root FROM packages").map(({ id, root }) => [root, id]));
    steps.end();

    const existing = new Map(atlas.all<FileRow>("SELECT id, path, sha256, stamp FROM files").map((row) => [row.path, row]));
    const seen = new Set<string>();
    let changedFiles = 0;
    let unchangedFiles = 0;
    let skippedFiles = 0;

    const insertFile = atlas.prepare(`INSERT INTO files(path, package, language, role, lines, sha256, stamp, gist, imports, limited, units, vectors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(path) DO UPDATE SET package = excluded.package, language = excluded.language, role = excluded.role, lines = excluded.lines,
        sha256 = excluded.sha256, stamp = excluded.stamp, gist = excluded.gist, imports = excluded.imports, limited = excluded.limited,
        units = excluded.units, vectors = NULL
      RETURNING id`);
    const selectUnits = atlas.prepare<{ id: number }>("SELECT id FROM units WHERE file = ?");
    const deleteText = atlas.prepare("DELETE FROM unit_text WHERE rowid = ?");
    const deleteUnits = atlas.prepare("DELETE FROM units WHERE file = ?");
    const deleteSymbols = atlas.prepare("DELETE FROM symbols WHERE file = ?");
    const insertUnit = atlas.prepare("INSERT INTO units(file, ord, kind, name, start_line, end_line, role, gist) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id");
    const insertText = atlas.prepare("INSERT INTO unit_text(rowid, name, path, alias, body) VALUES (?, ?, ?, '', ?)");
    const insertSymbol = atlas.prepare("INSERT INTO symbols(name, unit, file) VALUES (?, ?, ?)");
    const touch = atlas.prepare("UPDATE files SET stamp = ?, limited = ? WHERE id = ?");
    const dropFile = (id: number) => {
      for (const { id: unit } of selectUnits.all(id)) deleteText.run(unit);
      deleteSymbols.run(id);
      deleteUnits.run(id);
    };
    const writeFile = ({ path, stamp, sha, limited, source }: Analyzed) => {
      const row = insertFile.get(path, packageIds.get(packageOf(path, roots)) ?? 0, source.language, source.role, source.lines, sha, stamp,
        source.gist, JSON.stringify(source.imports), Number(limited), source.units.length) as { id: number };
      dropFile(row.id);
      const pathTerms = new Map<string, number>();
      addTerms(pathTerms, path, 1);
      const pathText = termText(pathTerms, 64);
      for (const [ord, unit] of source.units.entries()) {
        const { id } = insertUnit.get(row.id, ord, unit.kind, unit.name, unit.startLine, unit.endLine, unit.role, unit.gist) as { id: number };
        insertText.run(id, termText(unit.names, 64), pathText, termText(unit.body, maxBodyTerms));
        for (const symbol of unit.symbols.slice(0, maxSymbolsPerUnit)) insertSymbol.run(symbol.toLowerCase(), id, row.id);
      }
    };

    let pending = 0;
    steps.begin();
    try {
      for (let offset = 0; offset < eligible.length; offset += readBatch) {
        report(options, "read", offset, eligible.length);
        const batch = eligible.slice(offset, offset + readBatch);
        const results = await Promise.all(batch.map(async (path): Promise<Analyzed | "unchanged" | "skipped" | { touch: number; stamp: string; limited: boolean }> => {
          const stamp = await worktreeStamp(workspace, path);
          // Tracked but absent, linked, or unreadable in the worktree: nothing to index.
          if (!stamp) return "skipped";
          const row = existing.get(path);
          if (row && !full && row.stamp === stamp) return "unchanged";
          const text = await readTrackedText(workspace, path, maxFileBytes);
          if (!text) return "skipped";
          const sha = sha256(text.lines.join("\n"));
          if (row && !full && row.sha256 === sha) return { touch: row.id, stamp: text.stamp, limited: text.limited };
          const source = analyzeSource(path, text.lines);
          return source ? { path, stamp: text.stamp, sha, limited: text.limited, source } : "skipped";
        }));
        for (const [index, result] of results.entries()) {
          const path = batch[index]!;
          if (result === "skipped") { skippedFiles++; continue; }
          seen.add(path);
          if (result === "unchanged") { unchangedFiles++; continue; }
          if ("touch" in result) { touch.run(result.stamp, Number(result.limited), result.touch); unchangedFiles++; continue; }
          writeFile(result);
          changedFiles++;
          if (++pending >= commitEvery) {
            steps.checkpoint();
            pending = 0;
          }
        }
      }
      let removedFiles = 0;
      for (const [path, row] of existing) {
        if (seen.has(path)) continue;
        dropFile(row.id);
        atlas.run("DELETE FROM file_edges WHERE src = ? OR dst = ?", row.id, row.id);
        atlas.run("DELETE FROM files WHERE id = ?", row.id);
        removedFiles++;
      }
      steps.end();
      report(options, "read", eligible.length, eligible.length);

      const linked = await linkFiles(atlas, steps, workspace, packageMap.packages, packageIds, roots, options);
      const coupling = await linkHistory(atlas, steps, workspace, revision, previous, changedFiles + removedFiles > 0 || full, historyLimit, options);
      writeTools(atlas, steps, packageMap.tools, packageIds);
      // Learned aliases live outside the derived store and are laid back over it on every import.
      const learning = Learning.open(workspace, location);
      if (learning) try { applyAliases(atlas.db, learning.admittedAliases(), true); } finally { learning.close(); }

      const totalUnits = atlas.get<{ count: number }>("SELECT count(*) AS count FROM units")!.count;
      const limitedFiles = atlas.get<{ count: number }>("SELECT count(*) AS count FROM files WHERE limited = 1")!.count;
      const changedUnits = atlas.get<{ count: number }>("SELECT coalesce(sum(units), 0) AS count FROM files WHERE vectors IS NULL")!.count;
      const saved = atlas.frequencies();
      // Term statistics are refreshed when a fifth of the units changed. Every vector is then
      // rebuilt from stored text, so the worktree is not read again.
      const reembedded = full || !saved || (totalUnits > 0 && changedUnits / totalUnits > 0.2);
      const frequencies = reembedded ? rebuildFrequencies(atlas, totalUnits) : saved;
      if (reembedded) atlas.run("UPDATE files SET vectors = NULL");
      await embedUnits(atlas, steps, frequencies, options);
      // The new generation and what describes it become visible in one commit.
      steps.begin();
      const published = await publish(atlas, options);
      atlas.setMeta({
        revision: revision ?? "", importedAt: new Date().toISOString(), scopes, historyCommits: coupling.commits, historyLimit,
        limited: listing.limited || indexable.length > eligible.length || packageMap.limited,
      });
      steps.finish();
      atlas.dropStaleVectors(published.generation);
      // The map is committed. Complete the bundle and report the published import even if a stop arrives now.
      options.progress?.({ phase: "knowledge", done: 0, total: 1 });
      const knowledge = await writeKnowledge(atlas, sha256);
      options.progress?.({ phase: "knowledge", done: 1, total: 1 });
      return {
        knowledge,
        workspace, ...(revision ? { revision } : {}), generation: published.generation, scopes, trackedPaths: listing.paths.length,
        files: published.files, units: published.units, packages: packageMap.packages.length, tools: packageMap.tools.length,
        changedFiles, unchangedFiles, removedFiles, skippedFiles, importEdges: linked.imports, testEdges: linked.tests,
        couplingEdges: coupling.pairs, historyCommits: coupling.commits, reembedded,
        limitsReached: { trackedPaths: listing.limited, files: indexable.length > eligible.length, packages: packageMap.limited, fileBytes: limitedFiles },
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (atlas.db.inTransaction) atlas.db.exec("ROLLBACK");
      throw error;
    } finally {
      for (const statement of [insertFile, selectUnits, deleteText, deleteUnits, deleteSymbols, insertUnit, insertText, insertSymbol, touch]) statement.finalize();
    }
  } catch (error) {
    // Whichever step noticed the stop, the caller sees one kind of error.
    if (options.signal?.aborted && !(error instanceof AtlasError)) throw new AtlasError("The repository import was cancelled.", { cause: error });
    throw error;
  } finally {
    atlas.close();
  }
}

async function readOwners(workspace: string, paths: readonly string[]) {
  const candidates = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
  const tracked = new Set(paths);
  for (const candidate of candidates) {
    if (!tracked.has(candidate)) continue;
    const text = await readTrackedText(workspace, candidate, 256 * 1024);
    if (text) return parseCodeOwners(text.lines.join("\n"));
  }
  return [];
}

/** Recompute import and test links for every file from stored specifiers. */
async function linkFiles(
  atlas: Atlas, steps: Steps, workspace: string, packages: readonly PackageInfo[], packageIds: ReadonlyMap<string, number>, roots: ReadonlySet<string>,
  options: ImportOptions,
): Promise<{ imports: number; tests: number }> {
  const files = atlas.all<{ id: number; path: string; language: string; role: string; imports: string; package: number }>(
    "SELECT id, path, language, role, imports, package FROM files ORDER BY id");
  report(options, "link", 0, files.length);
  // Package entry points come from the same reader the existing preview index uses.
  const scriptPackages = new Map<string, RepositoryFileStructure>();
  for (const pkg of packages) {
    if ((pkg.ecosystem !== "npm" && pkg.ecosystem !== "deno") || !pkg.manifest || posix.basename(pkg.manifest) !== "package.json") continue;
    const text = await readTrackedText(workspace, pkg.manifest, 256 * 1024);
    if (text) scriptPackages.set(pkg.manifest, fileStructure(pkg.manifest, text));
  }
  const linker = new Linker(files, packages, scriptPackages);
  steps.begin();
  try {
    atlas.run("DELETE FROM file_edges WHERE kind IN ('import', 'test')");
    atlas.run("DELETE FROM package_edges");
    using insertEdge = atlas.prepare("INSERT OR IGNORE INTO file_edges(src, dst, kind, weight) VALUES (?, ?, ?, 1)");
    using setPackage = atlas.prepare("UPDATE files SET package = ? WHERE id = ?");
    const packageLinks = new Map<string, number>();
    const packageOfFile = new Map<number, number>();
    let imports = 0;
    let tests = 0;
    for (const file of files) {
      const pkg = packageIds.get(packageOf(file.path, roots)) ?? 0;
      packageOfFile.set(file.id, pkg);
      if (pkg !== file.package) setPackage.run(pkg, file.id);
    }
    for (const [index, file] of files.entries()) {
      if (index % 4096 === 0) await yieldProgress(options, "link", index, files.length);
      let specifiers: unknown;
      try { specifiers = JSON.parse(file.imports); } catch { specifiers = []; }
      const targets = new Set<number>();
      if (Array.isArray(specifiers)) for (const specifier of specifiers) {
        if (typeof specifier !== "string") continue;
        for (const path of linker.resolve(file.path, file.language, specifier)) {
          const id = linker.id(path);
          if (id !== undefined && id !== file.id) targets.add(id);
        }
      }
      const source = packageOfFile.get(file.id)!;
      for (const target of targets) {
        insertEdge.run(file.id, target, "import");
        imports++;
        const destination = packageOfFile.get(target)!;
        if (destination !== source) packageLinks.set(`${source}\0${destination}`, (packageLinks.get(`${source}\0${destination}`) ?? 0) + 1);
        // A test that imports a source file is that file's test.
        if (file.role === "test") { insertEdge.run(file.id, target, "test"); tests++; }
      }
      if (file.role === "test") {
        const subject = linker.subject(file.path);
        const id = subject === undefined ? undefined : linker.id(subject);
        if (id !== undefined && !targets.has(id)) { insertEdge.run(file.id, id, "test"); tests++; }
      }
    }
    using insertPackageEdge = atlas.prepare("INSERT OR REPLACE INTO package_edges(src, dst, kind, weight) VALUES (?, ?, ?, ?)");
    for (const [key, count] of packageLinks) {
      const [src, dst] = key.split("\0").map(Number) as [number, number];
      insertPackageEdge.run(src, dst, "import", count);
    }
    for (const { from, to } of internalDependencies(packages)) {
      const src = packageIds.get(from);
      const dst = packageIds.get(to);
      if (src !== undefined && dst !== undefined) insertPackageEdge.run(src, dst, "declared", 1);
    }
    atlas.run(`UPDATE packages SET
      files = (SELECT count(*) FROM files WHERE files.package = packages.id),
      units = (SELECT coalesce(sum(units), 0) FROM files WHERE files.package = packages.id)`);
    steps.end();
    report(options, "link", files.length, files.length);
    return { imports, tests };
  } catch (error) {
    if (atlas.db.inTransaction) atlas.db.exec("ROLLBACK");
    throw error;
  }
}

async function linkHistory(
  atlas: Atlas, steps: Steps, workspace: string, revision: string | undefined, previous: AtlasMeta, filesChanged: boolean,
  commits: number, options: ImportOptions,
): Promise<{ commits: number; pairs: number }> {
  if (!filesChanged && revision !== undefined && revision === previous.revision && commits === previous.historyLimit
    && (commits === 0 || previous.historyCommits > 0)) {
    const current = atlas.get<{ count: number }>("SELECT count(*) AS count FROM file_edges WHERE kind = 'cochange'")!.count;
    return { commits: previous.historyCommits, pairs: current };
  }
  report(options, "history", 0, 1);
  const ids = new Map(atlas.all<{ id: number; path: string }>("SELECT id, path FROM files").map(({ id, path }) => [path, id]));
  const coupling = commits > 0 ? await mineChangeCoupling(workspace, new Set(ids.keys()), { commits, signal: options.signal }) : { commits: 0, pairs: [] };
  const strongest = coupling.pairs[0]?.[2] ?? 1;
  steps.begin();
  try {
    atlas.run("DELETE FROM file_edges WHERE kind = 'cochange'");
    using insert = atlas.prepare("INSERT OR IGNORE INTO file_edges(src, dst, kind, weight) VALUES (?, ?, 'cochange', ?)");
    for (const [a, b, weight] of coupling.pairs) insert.run(ids.get(a)!, ids.get(b)!, Number((weight / strongest).toFixed(4)));
    steps.end();
  } catch (error) {
    if (atlas.db.inTransaction) atlas.db.exec("ROLLBACK");
    throw error;
  }
  report(options, "history", 1, 1);
  return { commits: coupling.commits, pairs: coupling.pairs.length };
}

function writeTools(atlas: Atlas, steps: Steps, tools: readonly CommandTool[], packageIds: ReadonlyMap<string, number>): void {
  steps.begin();
  try {
    atlas.run("DELETE FROM tools");
    using insert = atlas.prepare("INSERT OR IGNORE INTO tools(id, package, kind, name, cwd, argv, source_path, source_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const tool of tools)
      insert.run(tool.id, packageIds.get(tool.package) ?? 0, tool.kind, tool.name, tool.cwd, JSON.stringify(tool.argv), tool.source.path, tool.source.line);
    steps.end();
  } catch (error) {
    if (atlas.db.inTransaction) atlas.db.exec("ROLLBACK");
    throw error;
  }
}

/** Document frequencies from the search index's own vocabulary, so both lanes agree on rarity. */
function rebuildFrequencies(atlas: Atlas, documents: number): DocumentFrequencies {
  const frequencies = emptyFrequencies();
  frequencies.documents = documents;
  using statement = atlas.prepare<{ term: string; doc: number }>("SELECT term, doc FROM unit_vocab");
  for (const { term, doc } of statement.iterate()) {
    const bucket = dfBucket(term);
    // Colliding terms share the larger count, which only ever lowers a weight.
    if (doc > (frequencies.counts[bucket] ?? 0)) frequencies.counts[bucket] = doc;
  }
  atlas.setFrequencies(frequencies);
  return frequencies;
}

async function embedUnits(atlas: Atlas, steps: Steps, frequencies: DocumentFrequencies, options: ImportOptions): Promise<void> {
  const files = atlas.all<{ id: number; units: number }>("SELECT id, units FROM files WHERE vectors IS NULL ORDER BY id");
  using selectText = atlas.prepare<{ name: string; path: string; alias: string; body: string }>(
    "SELECT t.name, t.path, t.alias, t.body FROM units u JOIN unit_text t ON t.rowid = u.id WHERE u.file = ? ORDER BY u.ord");
  using store = atlas.prepare("UPDATE files SET vectors = ? WHERE id = ?");
  steps.begin();
  try {
    for (const [index, file] of files.entries()) {
      if (index % 512 === 0) {
        await yieldProgress(options, "embed", index, files.length);
        if (index) steps.checkpoint();
      }
      const rows = selectText.all(file.id);
      const vectors = new Int8Array(rows.length * embeddingDim);
      for (const [ord, row] of rows.entries()) quantize(embedBag(storedBag(row, frequencies), frequencies), vectors, ord * embeddingDim);
      store.run(new Uint8Array(vectors.buffer), file.id);
    }
    steps.end();
  } catch (error) {
    if (atlas.db.inTransaction) atlas.db.exec("ROLLBACK");
    throw error;
  }
  report(options, "embed", files.length, files.length);
}

/**
 * Build the vectors readers use. Each unit keeps its own content and takes a
 * share from its file, from files linked by imports, tests and change
 * coupling, and from its package, so structurally related code sits closer
 * than its words alone would put it.
 */
async function publish(atlas: Atlas, options: ImportOptions): Promise<{ generation: number; files: number; units: number }> {
  await yieldProgress(options, "publish", 0, 3);
  const files = atlas.all<{ id: number; package: number; units: number }>("SELECT id, package, units FROM files ORDER BY id");
  const fileRow = new Map<number, number>();
  const offsets = new Uint32Array(files.length + 1);
  for (const [row, file] of files.entries()) {
    fileRow.set(file.id, row);
    offsets[row + 1] = offsets[row]! + file.units;
  }
  const total = offsets[files.length]!;
  const vectors = new Int8Array(total * embeddingDim);
  const index = new Uint32Array(total * 4);
  const fileVectors = new Int8Array(files.length * embeddingDim);
  const scratch = new Float32Array(embeddingDim);

  using selectVectors = atlas.prepare<{ id: number; vectors: Uint8Array | null }>("SELECT id, vectors FROM files ORDER BY id");
  for (const { id, vectors: blob } of selectVectors.iterate()) {
    const row = fileRow.get(id);
    if (row === undefined || !blob) continue;
    const start = offsets[row]! * embeddingDim;
    const length = Math.min(blob.byteLength, (offsets[row + 1]! - offsets[row]!) * embeddingDim);
    vectors.set(new Int8Array(blob.buffer, blob.byteOffset, length), start);
    scratch.fill(0);
    for (let offset = 0; offset < length; offset += embeddingDim) addRow(scratch, vectors, start + offset, 1);
    normalize(scratch);
    quantize(scratch, fileVectors, row * embeddingDim);
  }
  using selectUnits = atlas.prepare<{ id: number; file: number; ord: number; role: string }>("SELECT id, file, ord, role FROM units ORDER BY file, ord");
  const roleIndex = new Map<string, number>(roles.map((role, position) => [role, position]));
  for (const unit of selectUnits.iterate()) {
    const row = fileRow.get(unit.file);
    if (row === undefined) continue;
    const position = offsets[row]! + unit.ord;
    if (position >= offsets[row + 1]!) continue;
    index.set([unit.id, unit.file, files[row]!.package, roleIndex.get(unit.role) ?? 0], position * 4);
  }
  await yieldProgress(options, "publish", 1, 3);

  // Symmetric adjacency in compressed rows: a file is informed by what it uses and by what uses it.
  const edges = atlas.all<{ src: number; dst: number; kind: string; weight: number }>("SELECT src, dst, kind, weight FROM file_edges");
  const degree = new Uint32Array(files.length + 1);
  for (const { src, dst } of edges) {
    const a = fileRow.get(src);
    const b = fileRow.get(dst);
    if (a === undefined || b === undefined) continue;
    degree[a + 1] = degree[a + 1]! + 1;
    degree[b + 1] = degree[b + 1]! + 1;
  }
  for (let row = 0; row < files.length; row++) degree[row + 1] = degree[row + 1]! + degree[row]!;
  const neighbour = new Uint32Array(degree[files.length]!);
  const strength = new Float32Array(degree[files.length]!);
  const cursor = degree.slice(0, files.length);
  for (const { src, dst, kind, weight } of edges) {
    const a = fileRow.get(src);
    const b = fileRow.get(dst);
    if (a === undefined || b === undefined) continue;
    const value = weight * (edgeWeights[kind] ?? 0.5);
    neighbour[cursor[a]!] = b; strength[cursor[a]!] = value; cursor[a] = cursor[a]! + 1;
    neighbour[cursor[b]!] = a; strength[cursor[b]!] = value; cursor[b] = cursor[b]! + 1;
  }
  const packageRows = new Map<number, Float32Array>();
  for (const [row, file] of files.entries()) {
    let centroid = packageRows.get(file.package);
    if (!centroid) packageRows.set(file.package, centroid = new Float32Array(embeddingDim));
    addRow(centroid, fileVectors, row * embeddingDim, 1);
  }
  for (const centroid of packageRows.values()) normalize(centroid);
  await yieldProgress(options, "publish", 2, 3);

  const linked = new Float32Array(embeddingDim);
  const unit = new Float32Array(embeddingDim);
  const roleSums = roles.map(() => new Float32Array(embeddingDim));
  const roleCounts = new Uint32Array(roles.length);
  const mean = new Float32Array(embeddingDim);
  for (const [row, file] of files.entries()) {
    linked.fill(0);
    for (let edge = degree[row]!; edge < degree[row + 1]!; edge++) addRow(linked, fileVectors, neighbour[edge]! * embeddingDim, strength[edge]!);
    const hasLinks = normalize(linked) > 0;
    const centroid = packageRows.get(file.package)!;
    for (let position = offsets[row]!; position < offsets[row + 1]!; position++) {
      const offset = position * embeddingDim;
      for (let dim = 0; dim < embeddingDim; dim++) {
        unit[dim] = vectors[offset + dim]! / 127 + propagation.file * (fileVectors[row * embeddingDim + dim]! / 127)
          + (hasLinks ? propagation.linked * linked[dim]! : 0) + propagation.package * centroid[dim]!;
      }
      normalize(unit);
      quantize(unit, vectors, offset);
      const role = index[position * 4 + 3]!;
      const sum = roleSums[role]!;
      for (let dim = 0; dim < embeddingDim; dim++) { sum[dim] = sum[dim]! + unit[dim]!; mean[dim] = mean[dim]! + unit[dim]!; }
      roleCounts[role] = roleCounts[role]! + 1;
    }
  }
  // A role prototype is what its units have in common beyond what every unit shares.
  const seeds = new Float32Array(roles.length * embeddingDim);
  if (total > 0) for (let dim = 0; dim < embeddingDim; dim++) mean[dim] = mean[dim]! / total;
  for (const [role, sum] of roleSums.entries()) {
    const count = roleCounts[role]!;
    if (!count) continue;
    const seed = seeds.subarray(role * embeddingDim, (role + 1) * embeddingDim);
    for (let dim = 0; dim < embeddingDim; dim++) seed[dim] = sum[dim]! / count - mean[dim]!;
    normalize(seed);
  }
  atlas.setBlob("roleSeeds", new Uint8Array(seeds.buffer));
  const packages = atlas.get<{ count: number }>("SELECT count(*) AS count FROM packages")!.count;
  const generation = atlas.publishVectors(vectors, index, { files: files.length, units: total, packages });
  report(options, "publish", 3, 3);
  return { generation, files: files.length, units: total };
}


