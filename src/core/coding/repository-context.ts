import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { AtlasManifest } from "./atlas/manifest.ts";
import { maxProfileProjects, maxProfileTokens, validateCodingProjectProfile, type CodingProjectProfile } from "./project-profile.ts";
import { dependencyResolver, fileStructure, indexRepository, type RepositoryFileStructure } from "./repository-index.ts";

const defaultTokenBudget = 4096;
const maxTokenBudget = maxProfileTokens;
const maxTrackedPaths = 20000;
const maxGitOutputBytes = 4 * 1024 * 1024;
const maxScannedFiles = 256;
const maxFileBytes = 64 * 1024;
const maxExcerptBytes = 4 * 1024;
const maxSelectedFiles = 12;
const maxProjects = maxProfileProjects;
const maxQueryBytes = 1024;

const excludedDirectories = new Set([
  ".git", ".okb", ".next", ".turbo", "build", "coverage", "db_only", "dist", "generated", "node_modules", "vendor",
]);
const excludedFiles = new Set([
  ".envrc", ".netrc", ".npmrc", ".pypirc", "bun.lock", "bun.lockb", "cargo.lock", "composer.lock", "go.sum",
  "package-lock.json", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "yarn.lock",
]);
const stopWords = new Set([
  "about", "and", "are", "can", "for", "from", "how", "into", "its", "of", "on", "or", "our", "the", "this", "to", "what", "where", "with",
]);
// Keep paths usable across platforms and exclude Windows alternate data stream names.
export const invalidPathCharacters = /[:\\\x00-\x1f\x7f]/u;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class RepositoryContextError extends Error {}

export interface RepositoryContextOptions {
  workspace: string;
  projects?: string[];
  profile?: CodingProjectProfile;
  query: string;
  tokenBudget?: number;
}

export interface RepositoryContextExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface RepositoryContextManifest {
  id: string;
  projects: string[];
  query: string;
  tokenBudget: number;
  estimatedTokens: number;
  contextBytes: number;
  trackedPaths: number;
  candidateFiles: number;
  scannedFiles: number;
  matchedFiles: number;
  limitsReached: {
    trackedPaths: boolean;
    scannedFiles: boolean;
    fileBytes: boolean;
    selectedFiles: boolean;
    tokenBudget: boolean;
  };
  files: Array<Omit<RepositoryContextExcerpt, "content"> & { sha256: string; reason?: string }>;
  profile?: Pick<CodingProjectProfile, "name" | "version" | "sharedProjects" | "exclude"> & { id: string };
  workspaceRevision?: string;
  index?: { indexedFiles: number; limited: boolean; expandedFiles: number };
  /** Present when the selection came from an imported repository atlas. */
  atlas?: AtlasManifest;
}

export interface RepositoryContextSelection {
  manifest: RepositoryContextManifest;
  excerpts: RepositoryContextExcerpt[];
  guidance?: string;
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

async function projectScopes(workspace: string, projects: string[]): Promise<string[]> {
  if (projects.length === 0 || projects.length > maxProjects) {
    throw new RepositoryContextError(`Choose between 1 and ${maxProjects} workspace-relative project directories.`);
  }
  const scopes = new Set<string>();
  for (const project of projects) {
    const path = project.replaceAll("\\", "/");
    if (!path || path.startsWith("/") || path.split("/").includes("..") || invalidPathCharacters.test(path)) {
      throw new RepositoryContextError(`Project ${JSON.stringify(project)} must be a workspace-relative directory.`);
    }
    const candidate = resolve(workspace, path);
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical !== candidate || !(await stat(canonical).catch(() => undefined))?.isDirectory()) {
      throw new RepositoryContextError(`Project ${JSON.stringify(project)} must be an existing workspace directory without symlinks.`);
    }
    scopes.add(portablePath(relative(workspace, canonical)) || ".");
  }
  return [...scopes].sort();
}

export function excludedPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const file = parts.pop()!;
  return parts.some((part) => excludedDirectories.has(part))
    || excludedFiles.has(file)
    || /^(?:\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/u.test(file)
    || /(?:^|[._-])(?:credentials?|secrets?)(?:[._-].+)?\.(?:json|ya?ml|toml|ini|txt)$/u.test(file)
    || /\.(?:pem|key|p12|pfx|keystore|map|sqlite3?|db)$/u.test(file)
    || /\.(?:min|generated|bundle)\.[^.]+$/u.test(file);
}

export function gitEnvironment() {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[name];
  return env;
}

export async function readRevision(workspace: string): Promise<string | undefined> {
  const child = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: workspace, env: gitEnvironment(), stdout: "pipe", stderr: "ignore",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const revision = output.trim();
    if (status === 0 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(revision)) return revision;
  } finally {
    clearTimeout(timeout);
  }
}

async function readGitIndex(workspace: string, projects: string[]): Promise<{ bytes: Buffer; limited: boolean }> {
  let child;
  try {
    child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "--literal-pathspecs", "ls-files", "--cached", "--stage", "-z", "--", ...projects], {
      cwd: workspace, env: gitEnvironment(), stdout: "pipe", stderr: "ignore",
    });
  } catch (error) {
    throw new RepositoryContextError("Could not start Git to list tracked workspace files.", { cause: error });
  }

  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let limited = false;
  let timedOut = false;
  let exited = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 10000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, maxGitOutputBytes - size);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        limited = true;
        child.kill();
        break;
      }
    }
    const status = await child.exited;
    exited = true;
    if (timedOut) throw new RepositoryContextError("Git timed out listing tracked files. Choose narrower project directories.");
    if (!limited && status !== 0) throw new RepositoryContextError("Repository context requires a workspace inside a Git checkout.");
    return { bytes: Buffer.concat(chunks, size), limited };
  } finally {
    clearTimeout(timeout);
    if (!exited) child.kill();
    reader.releaseLock();
  }
}

function matchingTerms(text: string, pattern: RegExp): Set<string> {
  const camelCase = text.replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2");
  return new Set([...text.toLowerCase().matchAll(pattern), ...camelCase.toLowerCase().matchAll(pattern)].map((match) => match[0]));
}

interface Candidate {
  path: string;
  pathTerms: Set<string>;
  groupOrder: number;
  group: string;
  shared: boolean;
}

function directoryOf(path: string, scopes: string[]): string | undefined {
  return scopes.findLast((scope) => scope === "." || path.startsWith(`${scope}/`));
}

function listCandidates(bytes: Buffer, projects: string[], pattern: RegExp, sharedProjects: string[], exclude: string[]): { candidates: Candidate[]; trackedPaths: number; limited: boolean } {
  const candidates: Candidate[] = [];
  const groupCounts = new Map<string, number>();
  let trackedPaths = 0;
  let limited = false;
  for (let start = 0; start < bytes.length;) {
    const end = bytes.indexOf(0, start);
    if (end === -1) break;
    if (trackedPaths === maxTrackedPaths) {
      limited = true;
      break;
    }
    trackedPaths++;
    const entry = bytes.subarray(start, end);
    start = end + 1;
    const tab = entry.indexOf(9);
    if (tab < 0 || !/^100(?:644|755) [0-9a-f]+ 0$/u.test(entry.subarray(0, tab).toString("ascii"))) continue;
    let path: string;
    try {
      path = decoder.decode(entry.subarray(tab + 1));
    } catch {
      continue;
    }
    if (invalidPathCharacters.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..") || excludedPath(path)
      || exclude.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue;
    const direct = directoryOf(path, projects);
    const project = direct ?? directoryOf(path, sharedProjects);
    if (project === undefined) continue;
    const projectPath = project === "." ? path : path.slice(project.length + 1);
    const slash = projectPath.indexOf("/");
    const group = slash < 0 ? "" : projectPath.slice(0, slash);
    const pathTerms = matchingTerms(path, pattern);
    const key = `${pathTerms.size}\0${project}\0${group}`;
    const groupOrder = groupCounts.get(key) ?? 0;
    groupCounts.set(key, groupOrder + 1);
    candidates.push({ path, pathTerms, groupOrder, group: `${project}\0${group}`, shared: direct === undefined });
  }
  // Give equally relevant candidates from different project subdirectories a first pass.
  candidates.sort((a, b) => b.pathTerms.size - a.pathTerms.size || a.groupOrder - b.groupOrder || comparePath(a.path, b.path));
  return { candidates, trackedPaths, limited };
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a === b ? 0 : 1;
}

function fingerprint(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

export async function worktreeStamp(workspace: string, path: string): Promise<string | undefined> {
  const candidate = join(workspace, path);
  try {
    if (await realpath(candidate) !== candidate) return;
    const info = await stat(candidate, { bigint: true });
    if (info.isFile()) return fingerprint(info);
  } catch { /* Vanished, unreadable, or substituted path. */ }
}

/** Read one tracked regular file as text, refusing links, binary data, and files that change mid-read. */
export async function readTrackedText(
  workspace: string, path: string, byteLimit = maxFileBytes,
): Promise<{ lines: string[]; limited: boolean; stamp: string } | undefined> {
  const candidate = join(workspace, path);
  try {
    // Compare the canonical path to exclude both leaf and ancestor symlinks.
    if (await realpath(candidate) !== candidate) return;
    const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) return;
      const buffer = Buffer.alloc(Math.min(Number(info.size), byteLimit) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (await realpath(candidate) !== candidate) return;
      const stamp = fingerprint(info);
      if (fingerprint(await stat(candidate, { bigint: true })) !== stamp) return;
      const limited = offset > byteLimit;
      // Discard any partial line so the line range always identifies complete lines.
      const end = limited ? buffer.lastIndexOf(10, byteLimit - 1) + 1 : offset;
      const body = decoder.decode(buffer.subarray(0, end));
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(body)) return;
      const lines = body.split(/\r?\n/u);
      if (lines.at(-1) === "") lines.pop();
      return { lines, limited, stamp };
    } finally {
      await file.close();
    }
  } catch {
    // Deleted worktree files, binary data, and unreadable paths cannot contribute context.
    return undefined;
  }
}

interface Match {
  path: string;
  lines: string[];
  center: number;
  score: number;
  reason?: string;
  dependencyOf?: string;
}

function findMatch(candidate: Candidate, lines: string[], pattern: RegExp, specific?: Set<string>): Match | undefined {
  if (lines.length === 0) return;
  const weight = (found: Set<string>) => {
    let score = found.size;
    if (specific?.size) for (const term of found) if (specific.has(term)) score += 4;
    return score;
  };
  const terms = new Set(candidate.pathTerms);
  const byLine = specific?.size ? lines.map((line) => {
    const matches = matchingTerms(line, pattern);
    return matches.size ? matches : undefined;
  }) : undefined;
  let center = 0;
  let bestLineTerms = 0;
  for (const [index, line] of lines.entries()) {
    const lineTerms = byLine ? byLine[index] : matchingTerms(line, pattern);
    if (!lineTerms?.size) continue;
    for (const term of lineTerms) terms.add(term);
    let strength = weight(lineTerms);
    if (byLine) {
      // Favor nearby corroborating terms without letting repeated generic words
      // displace an exact identifier on the line being excerpted.
      const cluster = new Set<string>();
      for (let nearby = Math.max(0, index - 4); nearby < Math.min(byLine.length, index + 5); nearby++) {
        for (const term of byLine[nearby] ?? []) cluster.add(term);
      }
      strength += weight(cluster) / 3;
    }
    if (strength > bestLineTerms) {
      bestLineTerms = strength;
      center = index;
    }
  }
  if (terms.size === 0) return;
  // Distinct query terms drive ranking, with a preference for concentrated matches.
  const score = weight(terms) * 4 + bestLineTerms * 2 + weight(candidate.pathTerms);
  return { path: candidate.path, lines, center, score };
}

type TrackedText = NonNullable<Awaited<ReturnType<typeof readTrackedText>>>;

interface QueryHints {
  identifiers: Set<string>;
  singleIdentifier: boolean;
  paths: Set<string>;
}

function matchesPath(path: string, hints: QueryHints): boolean {
  return hints.paths.has(path.toLowerCase());
}

function matchedSymbol(file: RepositoryFileStructure | undefined, hints: QueryHints) {
  return file?.symbols.find(({ name }) => hints.identifiers.has(name.toLowerCase()));
}

function matchingHeading(path: string, lines: string[], hints: QueryHints): number {
  if (!/\.md$/iu.test(path) || !hints.identifiers.size) return -1;
  return lines.findIndex((line) => {
    const name = /^ {0,3}#{1,6}\s+`?([\p{L}_$][\p{L}\p{N}_$]*)`?\s*#*$/u.exec(line)?.[1];
    return name !== undefined && hints.identifiers.has(name.toLowerCase());
  });
}

function profileMatch(candidate: Candidate, source: TrackedText, pattern: RegExp, hints: QueryHints, saved: RepositoryFileStructure | undefined): Match | undefined {
  if (!source.lines.length) return;
  const lexical = findMatch(candidate, source.lines, pattern, hints.identifiers);
  const symbol = matchedSymbol(saved?.stamp === source.stamp ? saved : fileStructure(candidate.path, source), hints);
  const exactPath = matchesPath(candidate.path, hints);
  const heading = matchingHeading(candidate.path, source.lines, hints);
  if (!exactPath && !symbol && heading < 0) return lexical && { ...lexical, reason: "Path or source text matches the query" };
  const declaration = symbol && symbol.line < source.lines.length ? symbol.line : undefined;
  const anchor = heading >= 0 ? heading : hints.singleIdentifier || symbol?.method ? declaration : undefined;
  return {
    path: candidate.path, lines: source.lines, center: anchor ?? lexical?.center ?? declaration ?? 0,
    score: (lexical?.score ?? 0) + (exactPath ? 400 : 8),
    reason: exactPath ? "Exact workspace path" : heading >= 0 ? "Documentation heading matches the query" : `Declares ${symbol!.name}`,
  };
}

function compareMatches(a: Match, b: Match): number {
  return b.score - a.score || comparePath(a.path, b.path);
}

function indexPaths(candidates: Candidate[]): string[] {
  const counts = new Map<string, number>();
  return [...candidates].sort((a, b) => comparePath(a.path, b.path)).map(({ path, group }) => {
    const order = counts.get(group) ?? 0;
    counts.set(group, order + 1);
    return { path, order };
  }).sort((a, b) => a.order - b.order || comparePath(a.path, b.path)).map(({ path }) => path);
}

async function expandDependencies(workspace: string, primary: Match[], candidates: Candidate[], sources: Map<string, TrackedText>,
  index: ReadonlyMap<string, RepositoryFileStructure>, pattern: RegExp, hints: QueryHints): Promise<{ matches: Match[]; fileBytes: boolean }> {
  const seen = new Set(primary.map((match) => match.path));
  const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  const resolver = dependencyResolver(index, new Set(byPath.keys()));
  const matches: Match[] = [];
  let fileBytes = false;
  for (const parent of primary.slice(0, 4)) {
    const source = sources.get(parent.path)!;
    const stored = index.get(parent.path);
    const structure = stored?.stamp === source.stamp ? stored : fileStructure(parent.path, source);
    let expanded = 0;
    for (const imported of structure.imports) {
      const path = resolver(parent.path, imported);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const dependency = sources.get(path) ?? await readTrackedText(workspace, path);
      if (!dependency?.lines.length) continue;
      fileBytes ||= dependency.limited;
      const match = profileMatch(byPath.get(path)!, dependency, pattern, hints, index.get(path));
      matches.push({
        path, lines: dependency.lines, center: match?.center ?? 0, score: match ? Math.min(parent.score - 1, match.score / 2) : 0,
        reason: `Direct import from ${parent.path}`, dependencyOf: parent.path,
      });
      expanded++;
      if (matches.length === 6) return { matches, fileBytes };
      if (expanded === 2) break;
    }
  }
  return { matches, fileBytes };
}

function excerptAt(match: Match, byteLimit: number): RepositoryContextExcerpt | undefined {
  let start = match.center;
  let end = match.center;
  const makeExcerpt = (first: number, last: number): RepositoryContextExcerpt => ({
    path: match.path, startLine: first + 1, endLine: last + 1, content: match.lines.slice(first, last + 1).join("\n"),
  });
  let excerpt = makeExcerpt(start, end);
  if (serializedBytes(excerpt) > byteLimit) return;
  while (start > Math.max(0, match.center - 5)) {
    const candidate = makeExcerpt(start - 1, end);
    if (serializedBytes(candidate) > byteLimit) break;
    excerpt = candidate;
    start--;
  }
  while (end < Math.min(match.lines.length - 1, match.center + 14)) {
    const candidate = makeExcerpt(start, end + 1);
    if (serializedBytes(candidate) > byteLimit) break;
    excerpt = candidate;
    end++;
  }
  return excerpt;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Select bounded source excerpts for local inspection or a confirmed coding request. */
export async function selectRepositoryContext(options: RepositoryContextOptions): Promise<RepositoryContextSelection> {
  const query = options.query.trim();
  let profile: CodingProjectProfile | undefined;
  if (options.profile !== undefined) {
    if (options.projects !== undefined) throw new RepositoryContextError("Choose explicit project directories or a project profile.");
    try {
      profile = validateCodingProjectProfile(options.profile);
    } catch (error) {
      throw new RepositoryContextError((error as Error).message, { cause: error });
    }
  }
  const tokenBudget = options.tokenBudget ?? profile?.tokenBudget ?? defaultTokenBudget;
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > maxTokenBudget) {
    throw new RepositoryContextError(`Choose a whole repository context token budget from 1 to ${maxTokenBudget}.`);
  }
  if (!query || Buffer.byteLength(query) > maxQueryBytes) {
    throw new RepositoryContextError(`Enter a repository context query of 1–${maxQueryBytes} UTF-8 bytes.`);
  }
  const plainTerms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}$]+/gu) ?? [])]
    .filter((term) => !stopWords.has(term)).slice(0, 16);
  if (plainTerms.length === 0) throw new RepositoryContextError("Enter repository context search terms such as identifiers, paths, or feature names.");
  const identifiers = (query.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? []).filter((term) => !stopWords.has(term.toLowerCase())).slice(0, 16);
  const singleIdentifier = identifiers.length === 1;
  const specific = new Set(identifiers.filter((term) => singleIdentifier || /[\p{Ll}\p{N}]\p{Lu}|\p{Lu}{2}\p{Ll}|[_$\d]/u.test(term)).map((term) => term.toLowerCase()));
  // A whole identifier with separators and its subwords are both search clues.
  const terms = profile ? [...new Set([...specific, ...plainTerms])].sort((a, b) => b.length - a.length) : plainTerms;
  const alternatives = terms.map((term) => term.replaceAll("$", "\\$")).join("|");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}$])(?:${alternatives})(?![\\p{L}\\p{N}$])`, "gu");

  const workspace = await realpath(options.workspace).catch(() => undefined);
  if (!workspace || !(await stat(workspace).catch(() => undefined))?.isDirectory()) {
    throw new RepositoryContextError("Choose an existing coding workspace directory.");
  }
  const projects = await projectScopes(workspace, profile?.projects ?? options.projects ?? []);
  const sharedProjects = profile?.sharedProjects?.length ? await projectScopes(workspace, profile.sharedProjects) : [];
  const listing = await readGitIndex(workspace, [...new Set([...projects, ...sharedProjects])]);
  const { candidates, trackedPaths, limited } = listCandidates(listing.bytes, projects, pattern, sharedProjects, profile?.exclude ?? []);
  const workspaceRevision = profile ? await readRevision(workspace) : undefined;
  const index = profile ? await indexRepository({
    workspace, revision: createHash("sha256").update(workspaceRevision ?? "unborn").update(listing.bytes).digest("hex"),
    paths: indexPaths(candidates), stamp: (path) => worktreeStamp(workspace, path), read: (path) => readTrackedText(workspace, path),
  }) : undefined;
  const hints: QueryHints = {
    identifiers: specific,
    singleIdentifier,
    paths: new Set(query.toLowerCase().split(/\s+/u).map((term) => term.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/:\d+(?::\d+)?$/u, ""))),
  };
  const eligible = candidates.filter(({ shared }) => !shared);
  if (index) {
    const rank = (path: string) => matchesPath(path, hints) ? 2 : matchedSymbol(index.files.get(path), hints) ? 1 : 0;
    // Stable sort keeps the lexical path and group ordering among equal ranks.
    eligible.sort((a, b) => rank(b.path) - rank(a.path));
  }
  const toScan = eligible.slice(0, maxScannedFiles);
  const matches: Match[] = [];
  const sources = new Map<string, TrackedText>();
  const limitsReached = {
    trackedPaths: listing.limited || limited,
    scannedFiles: eligible.length > toScan.length,
    fileBytes: false,
    selectedFiles: false,
    tokenBudget: false,
  };
  for (const candidate of toScan) {
    const source = await readTrackedText(workspace, candidate.path);
    if (!source) continue;
    limitsReached.fileBytes ||= source.limited;
    const match = index ? profileMatch(candidate, source, pattern, hints, index.files.get(candidate.path)) : findMatch(candidate, source.lines, pattern);
    if (!match) continue;
    if (index) sources.set(candidate.path, source);
    matches.push(match);
  }
  matches.sort(compareMatches);
  const expanded = index ? await expandDependencies(workspace, matches, candidates, sources, index.files, pattern, hints) : undefined;
  if (expanded) {
    matches.push(...expanded.matches);
    matches.sort(compareMatches);
    limitsReached.fileBytes ||= expanded.fileBytes;
  }

  const excerpts: RepositoryContextExcerpt[] = [];
  const reasons = new Map<string, string>();
  const selected = new Set<string>();
  let contextBytes = 2; // Empty JSON array.
  for (const match of matches) {
    if (match.dependencyOf && !selected.has(match.dependencyOf)) continue;
    if (excerpts.length === maxSelectedFiles) {
      limitsReached.selectedFiles = true;
      break;
    }
    const preferred = excerptAt(match, maxExcerptBytes);
    if (!preferred) continue;
    const comma = excerpts.length > 0 ? 1 : 0;
    // Count the serialized path, line range, escaping, and separators in the estimated allowance.
    const remaining = tokenBudget * 2 - contextBytes - comma;
    const preferredBytes = serializedBytes(preferred);
    limitsReached.tokenBudget ||= preferredBytes > remaining;
    const excerpt = preferredBytes <= remaining ? preferred : excerptAt(match, remaining);
    if (!excerpt) continue;
    excerpts.push(excerpt);
    selected.add(match.path);
    if (match.reason) reasons.set(match.path, match.reason);
    contextBytes += serializedBytes(excerpt) + comma;
  }

  const files = excerpts.map(({ path, startLine, endLine, content }) => {
    const reason = reasons.get(path);
    return { path, startLine, endLine, sha256: sha256(content), ...(reason ? { reason } : {}) };
  });
  const profileReceipt = profile && {
    version: profile.version, name: profile.name, id: sha256(JSON.stringify(profile)),
    ...(sharedProjects.length ? { sharedProjects } : {}), ...(profile.exclude ? { exclude: profile.exclude } : {}),
  };
  const manifest: RepositoryContextManifest = {
    id: sha256(JSON.stringify(profileReceipt
      ? [2, workspaceRevision, projects, query, tokenBudget, files, profileReceipt.id]
      : [1, projects, query, tokenBudget, files])), projects, query, tokenBudget,
    estimatedTokens: Math.ceil(contextBytes / 2), contextBytes, trackedPaths, candidateFiles: candidates.length,
    scannedFiles: toScan.length, matchedFiles: matches.length, limitsReached, files,
    ...(profileReceipt ? { profile: profileReceipt } : {}), ...(workspaceRevision ? { workspaceRevision } : {}),
    ...(index ? { index: { indexedFiles: index.files.size, limited: index.limited, expandedFiles: expanded?.matches.length ?? 0 } } : {}),
  };
  return { manifest, excerpts, ...(profile?.guidance ? { guidance: profile.guidance } : {}) };
}
