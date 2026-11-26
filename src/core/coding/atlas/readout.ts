// The fixed-budget readout. Every unit of the imported repository is scored
// against the task, a fixed set of slots then compete for the units with real
// evidence, and each slot spends a share of one token budget. The result is
// the same size whether the repository has a thousand files or a million.
//
// The shape follows Memorilla (Fallahpour et al., 2026): encode once, keep a
// persistent store, and read it through K query-conditioned slots with a
// fixed output budget. Two things differ because the model here is a hosted,
// frozen one. A slot emits real source ranges and a short map instead of soft
// tokens, and exact lexical and graph evidence are fused in before the read,
// which is the hybrid that paper names as future work.

import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { readTrackedText, type RepositoryContextExcerpt, type RepositoryContextManifest } from "../repository-context.ts";
import { profilePath } from "../project-profile.ts";
import type { AtlasManifest } from "./manifest.ts";
import { defaultParams, type Lane, type LearningView, type ReadoutParams } from "./params.ts";
import { Atlas, AtlasError, AtlasMissingError, type AtlasLocation, type AtlasVectors } from "./store.ts";
import { analyzeSource, roles, type Role } from "./structure.ts";
import {
  dequantize, embedBag, embeddingDim, estimateTokens, ftsQuery, inverseFrequency, queryFeatures, rowDot, sparseVector, stem,
} from "./text.ts";

export const defaultTokenBudget = 4096;
export const maxTokenBudget = 16384;
export const defaultSlots = 16;
const maxQueryBytes = 16 * 1024;
export const maxReadQueryBytes = 2048;
const maxScopes = 8;
const maxExcerptBytes = 4 * 1024;
const maxExcerpts = 32;
const maxSelectedFiles = 24;
const maxCandidates = 2048;
const maxReadBytes = 512 * 1024;
const lexicalLimit = 1024;
const graphSeeds = 10;
const maxLinkedFiles = 24;
const minExcerptLines = 10;
const mapShare = 0.15;
const skillShare = 0.1;
const maxDeferred = 16;
/** Sharpness of slot attention over fused evidence. */
const sharpness = 8;
/**
 * Evidence a unit needs before it is sent. Lane scores are absolute, so this
 * floor is too: a broad task with weak matches yields a small selection
 * rather than a padded one. The relative part only tightens it slightly when
 * the best match is strong.
 */
const relativeFloor = 0.25;
const absoluteFloor = 0.2;
const floorReference = 1.2;
const candidateFloor = 0.5;
/** Share of a seed's strength that reaches a linked unit, by how the link was established. */
const linkStrength = { defines: 0.8, tests: 0.75, uses: 0.6, cochange: 0.4 } as const;

export interface ReadoutOptions {
  workspace: string;
  /** The task, or a narrower search text. */
  query: string;
  tokenBudget?: number;
  /** Workspace-relative directories to read from. Defaults to everything imported. */
  projects?: string[];
  exclude?: string[];
  slots?: number;
  /** Also approve further excerpts the model may look up by path and line. */
  deferred?: boolean;
}

export interface PackSkill {
  id: string;
  title: string;
  text: string;
  /** Still being measured: delivered to a random half of eligible requests. */
  trial?: true;
}

export interface SkillRequest {
  /** Package roots the selection touches, most relevant first. */
  packages: string[];
  paths: string[];
  queryVector: Float32Array;
  query: string;
  budgetBytes: number;
  /** Stable per-selection value for measurement draws. */
  seed: string;
}

export type SkillSelector = (request: SkillRequest) => { skills: PackSkill[]; withheld: string[] };

export interface RankedUnit {
  path: string;
  name: string;
  startLine: number;
  endLine: number;
  role: Role;
  package: string;
  /** The package, or outside a declared package the leading directories, this unit belongs to. */
  region: string;
  evidence: number;
  lanes: Record<Lane, number>;
  slot: string;
  selected: boolean;
}

export interface AtlasContext {
  manifest: RepositoryContextManifest;
  excerpts: RepositoryContextExcerpt[];
  /** A short navigation map: the packages involved and where else to look. */
  map: string[];
  skills: PackSkill[];
  /** Approved excerpts that are saved with the request and served on request. */
  deferred: RepositoryContextExcerpt[];
  /** The strongest candidates and their scores. Stays on this computer. */
  ranked: RankedUnit[];
}

/** A readout together with the query features learning needs. Never serialized. */
export interface AtlasReadout extends AtlasContext {
  probe: { vector: Float32Array; terms: string[] };
}

interface Derived {
  rowOfUnit: Map<number, number>;
  fileRows: Map<number, [number, number]>;
}
const derivedCache = new WeakMap<AtlasVectors, Derived>();

function derive(vectors: AtlasVectors): Derived {
  let derived = derivedCache.get(vectors);
  if (derived) return derived;
  const rowOfUnit = new Map<number, number>();
  const fileRows = new Map<number, [number, number]>();
  for (let row = 0; row < vectors.rows; row++) {
    rowOfUnit.set(vectors.index[row * 4]!, row);
    const file = vectors.index[row * 4 + 1]!;
    const span = fileRows.get(file);
    if (span) span[1] = row + 1;
    else fileRows.set(file, [row, row + 1]);
  }
  derivedCache.set(vectors, derived = { rowOfUnit, fileRows });
  return derived;
}

interface UnitDetail {
  id: number; file: number; name: string; kind: string; start_line: number; end_line: number; role: Role; gist: string;
  path: string; sha256: string; package: number;
}
interface PackageDetail { id: number; root: string; name: string; description: string | null; files: number; owners: string }

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function scopePaths(values: readonly string[] | undefined, what: string): string[] {
  if (!values?.length) return [];
  if (values.length > maxScopes) throw new AtlasError(`Choose at most ${maxScopes} ${what} directories.`);
  const paths = new Set<string>();
  for (const value of values) {
    const path = typeof value === "string" && Buffer.byteLength(value) <= 512 ? profilePath(value) : undefined;
    if (!path) throw new AtlasError(`${JSON.stringify(value)} must be a workspace-relative directory.`);
    paths.add(path);
  }
  return [...paths].sort();
}

/** File ids under a directory, using the path index as a range scan. */
function filesUnder(atlas: Atlas, directory: string): number[] {
  if (directory === ".") return atlas.all<{ id: number }>("SELECT id FROM files").map(({ id }) => id);
  return atlas.all<{ id: number }>("SELECT id FROM files WHERE path >= ? AND path < ?", `${directory}/`, `${directory}0`).map(({ id }) => id);
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) chunks.push(values.slice(offset, offset + size));
  return chunks;
}

function unitDetails(atlas: Atlas, ids: readonly number[]): Map<number, UnitDetail> {
  const details = new Map<number, UnitDetail>();
  for (const chunk of chunked(ids, 400)) {
    const rows = atlas.all<UnitDetail>(`SELECT u.id, u.file, u.name, u.kind, u.start_line, u.end_line, u.role, u.gist, f.path, f.sha256, f.package
      FROM units u JOIN files f ON f.id = u.file WHERE u.id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
    for (const row of rows) details.set(row.id, row);
  }
  return details;
}

interface Scored {
  row: number;
  unit: UnitDetail;
  evidence: number;
  lanes: Record<Lane, number>;
  region: string;
}

interface Slot {
  name: string;
  /** Index into the learned utilities: a role index, or the shared region entry. */
  utility: number;
  gain: number;
  affinity: Float32Array;
  attention: Float32Array;
  mass: number;
  order: number[];
  cursor: number;
  budget: number;
  spent: number;
  units: number;
}

function clip(text: string, length: number): string {
  const compact = text.replace(/[\x00-\x1f\x7f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1).trimEnd()}…` : compact;
}

/** The window of a unit that fits the excerpt cap, centred on the line with the most query terms. */
function excerptWindow(lines: string[], start: number, end: number, terms: ReadonlySet<string>, path: string, byteLimit: number): RepositoryContextExcerpt | undefined {
  const last = Math.min(end, lines.length);
  if (start < 1 || start > last) return undefined;
  const make = (first: number, final: number): RepositoryContextExcerpt => ({ path, startLine: first, endLine: final, content: lines.slice(first - 1, final).join("\n") });
  const whole = make(start, last);
  if (serializedBytes(whole) <= byteLimit) return whole;
  let centre = start;
  let best = -1;
  for (let line = start; line <= last; line++) {
    let hits = 0;
    for (const match of lines[line - 1]!.toLowerCase().matchAll(/[\p{L}\p{N}_$]+/gu)) if (terms.has(match[0])) hits++;
    if (hits > best) { best = hits; centre = line; }
  }
  let first = centre;
  let final = centre;
  let excerpt = make(first, final);
  if (serializedBytes(excerpt) > byteLimit) return undefined;
  // Grow downward twice as fast as upward: what follows a matching line usually explains it.
  for (let step = 0; ; step++) {
    const down = step % 3 !== 2;
    const candidate = down && final < last ? make(first, final + 1) : first > start ? make(first - 1, final) : final < last ? make(first, final + 1) : undefined;
    if (!candidate || serializedBytes(candidate) > byteLimit) break;
    excerpt = candidate;
    first = candidate.startLine;
    final = candidate.endLine;
  }
  return excerpt;
}

/** Read the task-conditioned selection for one request. Makes no model call. */
export async function readAtlas(
  options: ReadoutOptions, hooks: { learning?: LearningView; skills?: SkillSelector } = {}, location: AtlasLocation = {},
): Promise<AtlasReadout> {
  const given = options.query.trim();
  if (!given || Buffer.byteLength(given) > maxQueryBytes) throw new AtlasError(`Enter a task or search text of 1–${maxQueryBytes} UTF-8 bytes.`);
  // Only the opening of a long task is read, and that same text is what the manifest records,
  // so a saved manifest is enough to reproduce the selection.
  const query = clipBytes(given, maxReadQueryBytes);
  const tokenBudget = options.tokenBudget ?? defaultTokenBudget;
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > maxTokenBudget)
    throw new AtlasError(`Choose a whole context token budget from 1 to ${maxTokenBudget}.`);
  const slotCount = options.slots ?? defaultSlots;
  if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 32) throw new AtlasError("Choose between 1 and 32 readout slots.");
  const workspace = await realpath(options.workspace).catch(() => undefined);
  if (!workspace || !(await stat(workspace).catch(() => undefined))?.isDirectory()) throw new AtlasError("Choose an existing coding workspace directory.");
  const scopes = scopePaths(options.projects, "project");
  const excluded = scopePaths(options.exclude, "excluded");
  const params: ReadoutParams = hooks.learning?.params ?? defaultParams();
  const features = queryFeatures(query);
  if (!features.terms.size) throw new AtlasError("Enter search terms such as identifiers, paths, or feature names.");

  const atlas = Atlas.open(workspace, location);
  let scored: Scored[];
  let packages: Map<number, PackageDetail>;
  let meta;
  let rows: number;
  let scannedUnits = 0;
  let queryVector: Float32Array;
  let neighbours: Map<number, { via: string; kind: string }>;
  let tests: Map<number, string[]>;
  let commands: Map<number, string[]>;
  let dependencies: Map<number, string[]>;
  let savedFrequencies: ReturnType<Atlas["frequencies"]>;
  try {
    // One read transaction, so the rows and the vector generation belong to the same import.
    atlas.db.exec("BEGIN");
    meta = atlas.meta();
    let vectors: AtlasVectors;
    try {
      vectors = atlas.vectors();
    } catch (error) {
      if (!(error instanceof AtlasMissingError)) throw error;
      // An import in another process published a newer map after this snapshot began and
      // removed the files the snapshot names. Take a fresh snapshot and read that map.
      atlas.db.exec("ROLLBACK; BEGIN");
      meta = atlas.meta();
      vectors = atlas.vectors();
    }
    const { rowOfUnit, fileRows } = derive(vectors);
    rows = vectors.rows;
    const frequencies = savedFrequencies = atlas.frequencies();
    queryVector = embedBag(features.terms, frequencies);

    let allowed: Uint8Array | undefined;
    if ((scopes.length && !scopes.includes(".")) || excluded.length) {
      allowed = new Uint8Array(rows);
      const mark = (directory: string, value: number) => {
        for (const file of filesUnder(atlas, directory)) {
          const span = fileRows.get(file);
          if (span) allowed!.fill(value, span[0], span[1]);
        }
      };
      if (scopes.length && !scopes.includes(".")) for (const scope of scopes) mark(scope, 1);
      else allowed.fill(1);
      for (const directory of excluded) mark(directory, 0);
    }

    // Dense lane. A hashed vector has a noise floor that grows with the number
    // of units, so only similarity above the expected maximum of pure noise counts.
    const dense = new Float32Array(rows);
    const sparseQuery = sparseVector(queryVector);
    let sum = 0;
    let squares = 0;
    for (let row = 0; row < rows; row++) {
      if (allowed && !allowed[row]) continue;
      const value = rowDot(sparseQuery, vectors.vectors, row * embeddingDim);
      dense[row] = value;
      sum += value;
      squares += value * value;
      scannedUnits++;
    }
    const mean = scannedUnits ? sum / scannedUnits : 0;
    const deviation = scannedUnits ? Math.sqrt(Math.max(0, squares / scannedUnits - mean * mean)) : 0;
    const noise = mean + deviation * Math.sqrt(2 * Math.log(Math.max(scannedUnits, 2)));

    const evidence = new Float32Array(rows);
    const lexical = new Map<number, number>();
    const exact = new Map<number, number>();
    const experience = new Map<number, number>();

    // Lexical lane. BM25 proposes candidates. They are then rescored by how
    // much of the task's vocabulary each one covers, weighted by rarity and by
    // where the term sits. Coverage is on an absolute scale, so the best hit
    // of a vague task does not pass for a strong one, and a three-line
    // constant cannot outrank a function that matches several terms.
    const text = ftsQuery(features.terms);
    const termWeights = [...features.terms.keys()].slice(0, 32).map((term) => [term, inverseFrequency(frequencies, term)] as const);
    const totalWeight = termWeights.reduce((total, [, weight]) => total + weight, 0);
    if (text && totalWeight > 0) {
      const prefixes = termWeights.filter(([term]) => /^[\p{L}\p{N}]{5,24}$/u.test(term)).slice(0, 12).map(([term]) => `${term}*`);
      const hits = atlas.all<{ id: number }>(
        `SELECT rowid AS id FROM unit_text WHERE unit_text MATCH ? ORDER BY bm25(unit_text, 8.0, 3.0, 6.0, 1.0) LIMIT ?`,
        [text, ...prefixes].join(" OR "), lexicalLimit * (allowed ? 4 : 1));
      const ids: number[] = [];
      for (const { id } of hits) {
        const row = rowOfUnit.get(id);
        if (row === undefined || (allowed && !allowed[row])) continue;
        ids.push(id);
        if (ids.length >= lexicalLimit) break;
      }
      const stored: StoredText[] = [];
      for (const chunk of chunked(ids, 400))
        stored.push(...atlas.all<StoredText>(`SELECT rowid AS id, name, path, alias, body FROM unit_text WHERE rowid IN (${chunk.map(() => "?").join(",")})`, ...chunk));
      let lengths = 0;
      for (const { body } of stored) lengths += body.length;
      // Stored terms are short, so characters stand in for term counts when averaging.
      const averageLength = stored.length ? lengths / stored.length / 7 : 1;
      for (const unit of stored) {
        const score = coverage(unit, termWeights, averageLength) / totalWeight;
        if (score > 0) lexical.set(rowOfUnit.get(unit.id)!, Math.min(1, score));
      }
    }

    // Exact lane: a named symbol or path is the strongest evidence a task can give.
    if (features.identifiers.length) {
      const names = features.identifiers.slice(0, 16);
      for (const { unit } of atlas.all<{ unit: number }>(`SELECT unit FROM symbols WHERE name IN (${names.map(() => "?").join(",")}) LIMIT 256`, ...names)) {
        const row = rowOfUnit.get(unit);
        if (row !== undefined && (!allowed || allowed[row])) exact.set(row, 1);
      }
    }
    for (const path of features.paths) {
      const escaped = path.replace(/[\\%_]/gu, "\\$&");
      for (const { id } of atlas.all<{ id: number }>("SELECT id FROM files WHERE lower(path) = ? OR lower(path) LIKE ? ESCAPE '\\' LIMIT 8", path, `%/${escaped}`)) {
        const span = fileRows.get(id);
        if (!span) continue;
        for (let row = span[0]; row < span[1]; row++) if (!allowed || allowed[row]) exact.set(row, Math.max(exact.get(row) ?? 0, 0.6));
      }
    }

    // Experience lane: units that mattered when similar tasks were accepted before.
    for (const { path, name, weight } of hooks.learning?.experience(queryVector) ?? []) {
      // A remembered file without a unit name lends a smaller share to each of its units.
      const found = name
        ? atlas.all<{ id: number }>("SELECT u.id FROM units u JOIN files f ON f.id = u.file WHERE f.path = ? AND u.name = ? LIMIT 1", path, name)
        : atlas.all<{ id: number }>("SELECT u.id FROM units u JOIN files f ON f.id = u.file WHERE f.path = ? ORDER BY u.ord LIMIT 64", path);
      for (const { id } of found) {
        const row = rowOfUnit.get(id);
        if (row !== undefined && (!allowed || allowed[row])) experience.set(row, Math.min(1, Math.max(experience.get(row) ?? 0, name ? weight : weight * 0.5)));
      }
    }

    const denseScore = (row: number) => Math.min(1, Math.max(0, (dense[row]! - noise) / 0.35));
    let best = 0;
    for (let row = 0; row < rows; row++) {
      if (allowed && !allowed[row]) continue;
      const value = dense[row]! > noise ? params.lanes.dense * denseScore(row) : 0;
      evidence[row] = value;
      if (value > best) best = value;
    }
    // The other lanes name few units each, so they are added where they apply instead of looked up for every unit.
    for (const [lane, weight] of [[lexical, params.lanes.lexical], [exact, params.lanes.exact], [experience, params.lanes.experience]] as const) {
      for (const [row, score] of lane) {
        if (allowed && !allowed[row]) continue;
        const value = evidence[row]! + weight * score;
        evidence[row] = value;
        if (value > best) best = value;
      }
    }

    // Graph lane. Evidence follows definition and use rather than mere file
    // adjacency: from a strong unit to the linked units that declare what it
    // mentions, that mention what it declares, or that test it. Files that
    // only change together pass on a smaller share to their best unit.
    const graph = new Map<number, number>();
    neighbours = new Map();
    if (best > 0 && params.lanes.graph > 0) {
      const perFile = new Map<number, number>();
      const seeds = topRows(evidence, best * 0.5, graphSeeds * 4).filter((row) => {
        const file = vectors.index[row * 4 + 1]!;
        const count = perFile.get(file) ?? 0;
        perFile.set(file, count + 1);
        return count < 2;
      }).slice(0, graphSeeds);
      const fileText = new Map<number, (StoredText & { declared: string[] })[]>();
      const textOf = (file: number) => {
        let stored = fileText.get(file);
        if (!stored) {
          const declared = new Map<number, string[]>();
          for (const { unit, name } of atlas.all<{ unit: number; name: string }>("SELECT unit, name FROM symbols WHERE file = ? LIMIT 2048", file)) {
            const list = declared.get(unit);
            if (list) list.push(name);
            else declared.set(unit, [name]);
          }
          stored = atlas.all<StoredText>(
            "SELECT u.id, t.name, t.path, t.alias, t.body FROM units u JOIN unit_text t ON t.rowid = u.id WHERE u.file = ? ORDER BY u.ord LIMIT 256", file)
            .map((row) => ({ ...row, declared: declared.get(row.id) ?? [] }));
          fileText.set(file, stored);
        }
        return stored;
      };
      // A mention counts when it is the declared identifier itself and that
      // identifier is rare here, or every `session` would link to every other.
      // Names are stored lowercased, so a one-word name is also tried as stored text stems it.
      const mentionKeys = (name: string): string[] =>
        [...new Set([name, stem(name)])].filter((term) => term.length >= 4 && inverseFrequency(frequencies, term) >= 1.5);
      for (const seed of seeds) {
        const file = vectors.index[seed * 4 + 1]!;
        // Absolute, so the neighbours of a mediocre match stay below the match itself.
        const strength = Math.min(1, evidence[seed]! / floorReference);
        const own = textOf(file).find(({ id }) => id === vectors.index[seed * 4]!);
        if (!own) continue;
        const declared = new Set(own.declared.flatMap(mentionKeys));
        const mentioned = new Set(own.body.split(" "));
        const edges = atlas.all<{ src: number; dst: number; kind: string; weight: number }>(
          `SELECT src, dst, kind, weight FROM file_edges WHERE src = ?1 UNION ALL SELECT src, dst, kind, weight FROM file_edges WHERE dst = ?1
           ORDER BY weight DESC, src, dst LIMIT ?2`, file, maxLinkedFiles * 2);
        const visited = new Set<string>();
        const reached: [number, number, string][] = [];
        for (const edge of edges) {
          const outgoing = edge.src === file;
          const other = outgoing ? edge.dst : edge.src;
          if (other === file || visited.has(`${other}:${edge.kind}`) || visited.size >= maxLinkedFiles) continue;
          visited.add(`${other}:${edge.kind}`);
          const span = fileRows.get(other);
          if (!span) continue;
          if (edge.kind === "cochange") {
            let top = span[0];
            for (let row = span[0]; row < span[1]; row++) if (evidence[row]! > evidence[top]!) top = row;
            reached.push([top, edge.weight * linkStrength.cochange, edge.kind]);
            continue;
          }
          for (const linked of textOf(other)) {
            const row = rowOfUnit.get(linked.id);
            if (row === undefined) continue;
            // The seed uses this unit when it mentions a name the unit declares, and is used by it the other way round.
            const defines = linked.declared.some((name) => mentionKeys(name).some((key) => mentioned.has(key)));
            let uses = false;
            if (declared.size) for (const term of linked.body.split(" ")) if (declared.has(term)) { uses = true; break; }
            if (outgoing && defines) reached.push([row, linkStrength.defines, edge.kind]);
            else if (uses) reached.push([row, edge.kind === "test" ? linkStrength.tests : linkStrength.uses, edge.kind]);
          }
        }
        // A unit that links to many others says less about each of them.
        const damping = 1 / Math.sqrt(Math.max(1, reached.length / 2));
        for (const [row, share, kind] of reached) {
          const mass = strength * share * damping;
          if ((allowed && !allowed[row]) || mass <= (graph.get(row) ?? 0)) continue;
          graph.set(row, mass);
          neighbours.set(vectors.index[row * 4]!, { via: String(file), kind });
        }
      }
      for (const [row, value] of graph) evidence[row] = evidence[row]! + params.lanes.graph * value;
    }
    best = 0;
    for (let row = 0; row < rows; row++) if (evidence[row]! > best) best = evidence[row]!;

    const candidateRows = best > 0 ? topRows(evidence, absoluteFloor * candidateFloor, maxCandidates) : [];
    const details = unitDetails(atlas, candidateRows.map((row) => vectors.index[row * 4]!));
    packages = new Map(atlas.all<PackageDetail>("SELECT id, root, name, description, files, owners FROM packages").map((pkg) => [pkg.id, pkg]));
    const multiPackage = packages.size > 1;
    scored = [];
    for (const row of candidateRows) {
      const unit = details.get(vectors.index[row * 4]!);
      if (!unit) continue;
      const root = packages.get(unit.package)?.root ?? ".";
      // Outside a declared package, the leading directories stand in for one.
      const region = multiPackage && root !== "." ? root : unit.path.split("/").slice(0, -1).slice(0, 3).join("/") || "(root)";
      scored.push({
        row, unit, evidence: evidence[row]!, region,
        lanes: { lexical: lexical.get(row) ?? 0, dense: denseScore(row), exact: exact.get(row) ?? 0, graph: graph.get(row) ?? 0, experience: experience.get(row) ?? 0 },
      });
    }
    // Resolve link provenance to paths while the connection is open.
    const viaIds = [...new Set([...neighbours.values()].map(({ via }) => Number(via)))];
    const viaPaths = new Map<number, string>();
    for (const chunk of chunked(viaIds, 400))
      for (const { id, path } of atlas.all<{ id: number; path: string }>(`SELECT id, path FROM files WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk)) viaPaths.set(id, path);
    for (const entry of neighbours.values()) entry.via = viaPaths.get(Number(entry.via)) ?? "";

    // Facts for the map: where each involved package keeps tests, what it runs, and what it depends on.
    const involved = [...new Set(scored.slice(0, 256).map(({ unit }) => unit.package))].slice(0, 24);
    tests = new Map();
    commands = new Map();
    dependencies = new Map();
    for (const id of involved) {
      const testFiles = atlas.all<{ path: string }>("SELECT path FROM files WHERE package = ? AND role = 'test' ORDER BY path LIMIT 64", id).map(({ path }) => posix.dirname(path));
      tests.set(id, [...new Set(testFiles)].slice(0, 2));
      commands.set(id, atlas.all<{ argv: string; kind: string }>("SELECT argv, kind FROM tools WHERE package = ? AND kind IN ('test', 'typecheck') ORDER BY kind, length(argv) LIMIT 2", id)
        .flatMap(({ argv }) => { try { return [(JSON.parse(argv) as string[]).join(" ")]; } catch { return []; } }));
      dependencies.set(id, atlas.all<{ name: string }>(
        "SELECT p.name FROM package_edges e JOIN packages p ON p.id = e.dst WHERE e.src = ? GROUP BY p.id ORDER BY sum(e.weight) DESC LIMIT 4", id).map(({ name }) => name));
    }

    const seedBlob = atlas.blob("roleSeeds");
    const seeds = seedBlob && seedBlob.byteLength === roles.length * embeddingDim * 4
      ? new Float32Array(seedBlob.buffer.slice(seedBlob.byteOffset, seedBlob.byteOffset + seedBlob.byteLength)) : undefined;
    assignAffinity(scored, vectors, seeds);
    atlas.db.exec("COMMIT");
  } catch (error) {
    if (atlas.db.inTransaction) atlas.db.exec("ROLLBACK");
    throw error;
  } finally {
    atlas.close();
  }

  // ----- Slots -----
  const best = scored.reduce((max, candidate) => Math.max(max, candidate.evidence), 0);
  const floor = Math.max(Math.min(best, floorReference) * relativeFloor, absoluteFloor);
  const regionMass = new Map<string, number>();
  for (const candidate of scored) regionMass.set(candidate.region, (regionMass.get(candidate.region) ?? 0) + candidate.evidence);
  const regionNames = [...regionMass.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name);
  const roleSlots = Math.min(roles.length, slotCount);
  const regionSlots = regionNames.length > 1 ? Math.min(regionNames.length, Math.max(0, slotCount - roleSlots)) : 0;
  const slots: Slot[] = [];
  const blank = (name: string, utility: number, gain: number): Slot => ({
    name, utility, gain, affinity: new Float32Array(scored.length), attention: new Float32Array(scored.length),
    mass: 0, order: [], cursor: 0, budget: 0, spent: 0, units: 0,
  });
  for (let role = 0; role < roleSlots; role++) {
    const slot = blank(roles[role]!, role, params.roleGain[role] ?? 0.5);
    for (const [index, candidate] of scored.entries()) slot.affinity[index] = roleAffinity.get(candidate)![role]!;
    slots.push(slot);
  }
  for (let region = 0; region < regionSlots; region++) {
    const name = regionNames[region]!;
    const slot = blank(`in ${name}`, roles.length, params.regionGain);
    for (const [index, candidate] of scored.entries()) slot.affinity[index] = candidate.region === name ? 1 : 0;
    slots.push(slot);
  }
  // Competition: each unit's evidence is divided among the slots by how well
  // they fit it, so two slots never spend their budgets on the same code.
  const logits = new Float32Array(slots.length);
  for (const [index, candidate] of scored.entries()) {
    let peak = -Infinity;
    for (const [position, slot] of slots.entries()) {
      logits[position] = sharpness * candidate.evidence * (1 + slot.gain * slot.affinity[index]!);
      if (logits[position]! > peak) peak = logits[position]!;
    }
    let total = 0;
    for (let position = 0; position < slots.length; position++) total += Math.exp(logits[position]! - peak);
    for (const [position, slot] of slots.entries()) {
      const responsibility = Math.exp(logits[position]! - peak) / total;
      slot.attention[index] = candidate.evidence * (1 + slot.gain * slot.affinity[index]!) * responsibility;
      if (candidate.evidence >= floor) slot.mass += candidate.evidence * responsibility;
    }
  }
  const mapBudget = Math.floor(tokenBudget * 2 * mapShare);
  const skillBudget = hooks.skills ? Math.floor(tokenBudget * 2 * skillShare) : 0;
  const excerptBudget = tokenBudget * 2 - mapBudget - skillBudget;
  let weighted = 0;
  for (const slot of slots) {
    const utility = params.slotUtility[slot.utility] ?? { alpha: 2, beta: 2 };
    slot.mass *= utility.alpha / (utility.alpha + utility.beta);
    weighted += slot.mass;
  }
  for (const slot of slots) {
    slot.budget = weighted > 0 ? (slot.mass / weighted) * excerptBudget : 0;
    slot.order = scored.map((_, index) => index).filter((index) => slot.attention[index]! > 0)
      .sort((a, b) => slot.attention[b]! - slot.attention[a]! || scored[a]!.unit.path.localeCompare(scored[b]!.unit.path) || scored[a]!.unit.start_line - scored[b]!.unit.start_line);
  }

  // ----- Selection -----
  const terms = new Set(features.terms.keys());
  const sources = new Map<string, { lines: string[]; limited: boolean; stale: boolean; units?: ReturnType<typeof analyzeSource> } | null>();
  let staleFiles = 0;
  let limitedBytes = false;
  const load = async (unit: UnitDetail) => {
    let source = sources.get(unit.path);
    if (source === undefined) {
      const read = await readTrackedText(workspace, unit.path, maxReadBytes);
      if (!read) source = null;
      else {
        const stale = sha256(read.lines.join("\n")) !== unit.sha256;
        source = { lines: read.lines, limited: read.limited, stale };
        if (stale) { staleFiles++; source.units = analyzeSource(unit.path, read.lines); }
        if (read.limited) limitedBytes = true;
      }
      sources.set(unit.path, source);
    }
    return source;
  };
  /** A unit's current line range. A file edited since the import is re-read and the unit found again by name. */
  const locate = (unit: UnitDetail, source: NonNullable<Awaited<ReturnType<typeof load>>>): [number, number] | undefined => {
    if (!source.stale) return [unit.start_line, unit.end_line];
    const fresh = source.units?.units ?? [];
    const match = fresh.find((candidate) => candidate.name === unit.name)
      ?? fresh.reduce<typeof fresh[number] | undefined>((nearest, candidate) =>
        !nearest || Math.abs(candidate.startLine - unit.start_line) < Math.abs(nearest.startLine - unit.start_line) ? candidate : nearest, undefined);
    return match ? [match.startLine, match.endLine] : undefined;
  };

  const excerpts: (RepositoryContextExcerpt & { reason: string; slot: string })[] = [];
  const taken = new Set<number>();
  const selectedFiles = new Set<string>();
  let contextBytes = 2;
  let budgetReached = false;
  let filesReached = false;
  const reasonFor = (candidate: Scored): string => {
    const { lanes: lane, unit } = candidate;
    if (lane.exact >= 1) return `Declares ${unit.name}`;
    if (lane.exact > 0) return "Exact workspace path";
    const weighted: [string, number][] = [
      ["Matches the task's terms", params.lanes.lexical * lane.lexical], ["Similar to the task", params.lanes.dense * lane.dense],
      ["Used in similar accepted requests", params.lanes.experience * lane.experience],
    ];
    const link = neighbours.get(unit.id);
    if (link) weighted.push([`${link.kind === "test" ? "Test link" : link.kind === "cochange" ? "Changes together" : "Import link"} with ${link.via}`, params.lanes.graph * lane.graph]);
    return weighted.sort((a, b) => b[1] - a[1])[0]![0];
  };
  const take = async (index: number, slot: Slot | undefined): Promise<"taken" | "skip" | "full"> => {
    const candidate = scored[index]!;
    if (taken.has(index)) return "skip";
    if (excerpts.length >= maxExcerpts) return "full";
    if (!selectedFiles.has(candidate.unit.path) && selectedFiles.size >= maxSelectedFiles) { filesReached = true; return "skip"; }
    const source = await load(candidate.unit);
    const range = source ? locate(candidate.unit, source) : undefined;
    if (!source || !range) { taken.add(index); return "skip"; }
    const remaining = excerptBudget - contextBytes - (excerpts.length ? 1 : 0);
    // A unit of a few lines is hard to read alone, so it brings some of its surroundings.
    const short = Math.max(0, minExcerptLines - (range[1] - range[0] + 1));
    const padded: [number, number] = [Math.max(1, range[0] - Math.floor(short / 3)), Math.min(source.lines.length, range[1] + Math.ceil((short * 2) / 3))];
    const excerpt = excerptWindow(source.lines, padded[0], padded[1], terms, candidate.unit.path, Math.min(maxExcerptBytes, remaining))
      ?? excerptWindow(source.lines, range[0], range[1], terms, candidate.unit.path, Math.min(maxExcerptBytes, remaining));
    if (!excerpt) { budgetReached = true; return remaining < 256 ? "full" : "skip"; }
    if (excerpt.endLine - excerpt.startLine < range[1] - range[0] && remaining < maxExcerptBytes) budgetReached = true;
    taken.add(index);
    const bytes = serializedBytes({ path: excerpt.path, startLine: excerpt.startLine, endLine: excerpt.endLine, content: excerpt.content }) + (excerpts.length ? 1 : 0);
    contextBytes += bytes;
    selectedFiles.add(candidate.unit.path);
    excerpts.push({ ...excerpt, reason: reasonFor(candidate), slot: slot?.name ?? "exact" });
    if (slot) { slot.spent += bytes; slot.units++; }
    return "taken";
  };

  // Named symbols and paths go first, before any slot spends.
  const pinned = scored.map((candidate, index) => [candidate, index] as const).filter(([candidate]) => candidate.lanes.exact > 0)
    .sort((a, b) => b[0].evidence - a[0].evidence || a[0].unit.path.localeCompare(b[0].unit.path)).slice(0, 6);
  let pinnedBytes = 0;
  for (const [candidate, index] of pinned) {
    if (candidate.evidence < floor || pinnedBytes > excerptBudget / 2) continue;
    const before = contextBytes;
    if (await take(index, undefined) === "full") break;
    pinnedBytes += contextBytes - before;
  }
  // Then the slot furthest below its share takes its next unit, until every
  // slot has run out of units above the floor or the budget is spent.
  const active = new Set(slots.filter((slot) => slot.budget > 0));
  while (active.size) {
    let next: Slot | undefined;
    for (const slot of active) if (!next || slot.budget - slot.spent > next.budget - next.spent) next = slot;
    const slot = next!;
    let outcome: "taken" | "skip" | "full" | "exhausted" = "exhausted";
    while (slot.cursor < slot.order.length) {
      const index = slot.order[slot.cursor++]!;
      if (scored[index]!.evidence < floor) continue;
      outcome = await take(index, slot);
      if (outcome !== "skip") break;
      outcome = "exhausted";
    }
    if (outcome === "full") { budgetReached = true; break; }
    if (outcome === "exhausted") active.delete(slot);
  }
  if ([...active].length === 0 && scored.some((candidate, index) => candidate.evidence >= floor && !taken.has(index))) budgetReached ||= contextBytes > excerptBudget * 0.9;

  // Adjacent ranges of one file read better as a single excerpt.
  const merged = mergeExcerpts(excerpts, sources);
  contextBytes = serializedBytes(merged.map(({ path, startLine, endLine, content }) => ({ path, startLine, endLine, content })));

  // ----- Map, deferred excerpts, skills -----
  const packageOrder = [...new Set(scored.filter((_, index) => taken.has(index)).map(({ unit }) => unit.package))];
  for (const candidate of scored.slice(0, 64)) if (!packageOrder.includes(candidate.unit.package) && candidate.evidence >= floor) packageOrder.push(candidate.unit.package);
  const map: string[] = [];
  let mapBytes = 0;
  const pushMap = (line: string): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(line)) + 1;
    if (mapBytes + bytes > mapBudget) return false;
    map.push(line);
    mapBytes += bytes;
    return true;
  };
  for (const id of packageOrder.slice(0, 8)) {
    const pkg = packages.get(id);
    if (!pkg) continue;
    const symbols = [...new Set(scored.filter(({ unit }) => unit.package === id && unit.kind === "symbol" && unit.role !== "test" && !unit.name.includes(" "))
      .slice(0, 5).map(({ unit }) => unit.name))];
    const parts = [`${pkg.root === "." ? "(root)" : pkg.root} — ${pkg.name}${pkg.description ? `: ${clip(pkg.description, 90)}` : ""} (${pkg.files} files)`];
    if (symbols.length) parts.push(`relevant: ${symbols.join(", ")}`);
    const deps = dependencies.get(id);
    if (deps?.length) parts.push(`uses: ${deps.join(", ")}`);
    const testDirs = tests.get(id);
    if (testDirs?.length) parts.push(`tests: ${testDirs.join(", ")}`);
    const run = commands.get(id);
    if (run?.length) parts.push(`checks: ${run.join("; ")}`);
    if (!pushMap(clip(parts.join(" | "), 420))) break;
  }
  const deferred: RepositoryContextExcerpt[] = [];
  if (options.deferred) {
    let deferredBytes = 0;
    const order = scored.map((candidate, index) => [candidate, index] as const).filter(([candidate, index]) => !taken.has(index) && candidate.evidence >= floor * 0.6)
      .sort((a, b) => b[0].evidence - a[0].evidence || a[0].unit.path.localeCompare(b[0].unit.path));
    for (const [candidate] of order) {
      if (deferred.length >= maxDeferred || deferredBytes > excerptBudget) break;
      if (!selectedFiles.has(candidate.unit.path) && selectedFiles.size + new Set(deferred.map(({ path }) => path)).size >= maxSelectedFiles + 8) continue;
      const source = await load(candidate.unit);
      const range = source ? locate(candidate.unit, source) : undefined;
      if (!source || !range) continue;
      if (merged.some((excerpt) => excerpt.path === candidate.unit.path && range[0] >= excerpt.startLine && range[1] <= excerpt.endLine)) continue;
      const excerpt = excerptWindow(source.lines, range[0], range[1], terms, candidate.unit.path, maxExcerptBytes);
      if (!excerpt) continue;
      if (!pushMap(`on request: ${excerpt.path}:${excerpt.startLine}-${excerpt.endLine} ${clip(candidate.unit.gist || candidate.unit.name, 80)}`)) break;
      deferred.push(excerpt);
      deferredBytes += serializedBytes(excerpt);
    }
  }
  const seed = sha256(JSON.stringify([query, merged.map(({ path, startLine, endLine }) => [path, startLine, endLine]), params.version]));
  const delivered = hooks.skills && merged.length ? hooks.skills({
    packages: packageOrder.flatMap((id) => packages.get(id)?.root ?? []), paths: [...selectedFiles], queryVector, query, budgetBytes: skillBudget, seed,
  }) : { skills: [], withheld: [] };

  const files = merged.map(({ path, startLine, endLine, content, reason }) => ({ path, startLine, endLine, sha256: sha256(content), reason }));
  const atlasManifest: AtlasManifest = {
    version: 1, generation: meta.generation, ...(meta.importedAt ? { importedAt: meta.importedAt } : {}),
    slots: slots.filter((slot) => slot.units > 0).map((slot) => ({ name: slot.name, units: slot.units, tokens: estimateTokens(slot.spent) })),
    staleFiles, map: { sha256: sha256(JSON.stringify(map)), lines: map.length },
    skills: delivered.skills.map(({ id, text, trial }) => ({ id, sha256: sha256(text), ...(trial ? { trial } : {}) })),
    ...(delivered.withheld.length ? { withheld: delivered.withheld } : {}),
    deferred: deferred.map(({ path, startLine, endLine, content }) => ({ path, startLine, endLine, sha256: sha256(content) })),
    params: params.version,
  };
  const totalBytes = contextBytes + mapBytes + delivered.skills.reduce((bytes, skill) => bytes + serializedBytes(skill.text) + 1, 0);
  const projects = scopes.length ? scopes : meta.scopes;
  const manifest: RepositoryContextManifest = {
    // The ID binds exactly what would be sent: the request text, every selected byte, the map, and the skills.
    id: sha256(JSON.stringify([3, projects, excluded, query, tokenBudget, files, atlasManifest.map.sha256, atlasManifest.skills, atlasManifest.deferred])),
    projects, query, tokenBudget,
    estimatedTokens: estimateTokens(totalBytes), contextBytes: totalBytes, trackedPaths: meta.files, candidateFiles: new Set(scored.map(({ unit }) => unit.file)).size,
    scannedFiles: scannedUnits, matchedFiles: scored.filter((candidate) => candidate.evidence >= floor).length,
    limitsReached: { trackedPaths: meta.limited, scannedFiles: false, fileBytes: limitedBytes, selectedFiles: filesReached, tokenBudget: budgetReached },
    files, ...(meta.revision ? { workspaceRevision: meta.revision } : {}), atlas: atlasManifest,
  };
  const ranked: RankedUnit[] = scored.slice(0, 48).map((candidate, index) => ({
    path: candidate.unit.path, name: candidate.unit.name, startLine: candidate.unit.start_line, endLine: candidate.unit.end_line, role: candidate.unit.role,
    package: packages.get(candidate.unit.package)?.root ?? ".", region: candidate.region, evidence: Number(candidate.evidence.toFixed(4)),
    lanes: Object.fromEntries(Object.entries(candidate.lanes).map(([lane, value]) => [lane, Number(value.toFixed(4))])) as Record<Lane, number>,
    slot: slots.reduce<Slot | undefined>((top, slot) => !top || slot.attention[index]! > top.attention[index]! ? slot : top, undefined)?.name ?? "",
    selected: taken.has(index) && merged.some((excerpt) => excerpt.path === candidate.unit.path),
  }));
  return {
    manifest, excerpts: merged.map(({ path, startLine, endLine, content }) => ({ path, startLine, endLine, content })),
    map, skills: delivered.skills, deferred, ranked,
    probe: {
      vector: queryVector,
      terms: [...features.terms.keys()].map((term) => [term, inverseFrequency(savedFrequencies, term)] as const)
        .filter(([, weight]) => weight >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([term]) => term),
    },
  };
}

function clipBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let end = Math.min(text.length, bytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > bytes) end--;
  return text.slice(0, end).toWellFormed().trimEnd();
}

interface StoredText { id: number; name: string; path: string; alias: string; body: string }

/**
 * Rarity-weighted share of the task's terms a unit covers. A declared name
 * counts fully and a learned alias nearly so. A body mention is saturated and
 * length-normalized as in BM25, so one long unit that mentions everything
 * does not outrank a short one that is about the task. The path or a shared
 * prefix counts a little.
 */
function coverage(stored: StoredText, termWeights: readonly (readonly [string, number])[], averageLength: number): number {
  const names = new Set(stored.name.split(" "));
  const aliases = new Set(stored.alias.split(" "));
  const paths = new Set(stored.path.split(" "));
  const body = new Map<string, number>();
  let length = 0;
  for (const term of stored.body.split(" ")) { body.set(term, (body.get(term) ?? 0) + 1); length++; }
  const normalizer = 1.2 * (0.25 + 0.75 * (length / Math.max(1, averageLength)));
  let total = 0;
  for (const [term, weight] of termWeights) {
    let credit = 0;
    const count = body.get(term) ?? 0;
    if (names.has(term)) credit = 1;
    else if (aliases.has(term)) credit = 0.9;
    else if (count) credit = 0.8 * (count / (count + normalizer));
    else if (paths.has(term)) credit = 0.3;
    else if (term.length >= 5) {
      for (const name of names) if (name.startsWith(term)) { credit = 0.4; break; }
      if (!credit) for (const candidate of body.keys()) if (candidate.startsWith(term)) { credit = 0.2; break; }
    }
    total += weight * credit;
  }
  return total;
}

function topRows(values: Float32Array, threshold: number, limit: number): number[] {
  const rows: number[] = [];
  for (let row = 0; row < values.length; row++) if (values[row]! >= threshold) rows.push(row);
  rows.sort((a, b) => values[b]! - values[a]! || a - b);
  return rows.length > limit ? rows.slice(0, limit) : rows;
}

const roleAffinity = new WeakMap<Scored, Float32Array>();

/** How well each candidate fits each role: its own label, softened by similarity to the role's prototype. */
function assignAffinity(scored: Scored[], vectors: AtlasVectors, seeds: Float32Array | undefined): void {
  for (const candidate of scored) {
    const affinity = new Float32Array(roles.length);
    const vector = seeds ? dequantize(vectors.vectors, candidate.row * embeddingDim) : undefined;
    for (const [role, name] of roles.entries()) {
      let similarity = 0;
      if (seeds && vector) {
        let dot = 0;
        const offset = role * embeddingDim;
        for (let dim = 0; dim < embeddingDim; dim++) dot += seeds[offset + dim]! * vector[dim]!;
        similarity = Math.min(1, Math.max(0, dot / 0.5));
      }
      affinity[role] = 0.6 * Number(candidate.unit.role === name) + 0.4 * similarity;
    }
    roleAffinity.set(candidate, affinity);
  }
}

type Chosen = RepositoryContextExcerpt & { reason: string; slot: string };

function mergeExcerpts(excerpts: Chosen[], sources: Map<string, { lines: string[] } | null>): Chosen[] {
  const byPath = new Map<string, Chosen[]>();
  const order: string[] = [];
  for (const excerpt of excerpts) {
    const list = byPath.get(excerpt.path);
    if (list) list.push(excerpt);
    else { byPath.set(excerpt.path, [excerpt]); order.push(excerpt.path); }
  }
  const merged: Chosen[] = [];
  for (const path of order) {
    const list = byPath.get(path)!.sort((a, b) => a.startLine - b.startLine);
    const lines = sources.get(path)?.lines;
    let current = list[0]!;
    for (const next of list.slice(1)) {
      const joined = lines && next.startLine <= current.endLine + 3
        ? { ...current, endLine: Math.max(current.endLine, next.endLine), content: lines.slice(current.startLine - 1, Math.max(current.endLine, next.endLine)).join("\n") }
        : undefined;
      if (joined && serializedBytes(joined.content) <= maxExcerptBytes * 2) current = joined;
      else { merged.push(current); current = next; }
    }
    merged.push(current);
  }
  return merged;
}
