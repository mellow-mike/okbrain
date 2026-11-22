import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const defaultTokenBudget = 4096;
const maxTokenBudget = 16384;
const maxTrackedPaths = 20000;
const maxGitOutputBytes = 4 * 1024 * 1024;
const maxScannedFiles = 256;
const maxFileBytes = 64 * 1024;
const maxExcerptBytes = 4 * 1024;
const maxSelectedFiles = 12;
const maxProjects = 8;
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
const invalidPathCharacters = /[:\\\x00-\x1f\x7f]/u;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class RepositoryContextError extends Error {}

export interface RepositoryContextOptions {
  workspace: string;
  projects: string[];
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
  files: Array<Omit<RepositoryContextExcerpt, "content"> & { sha256: string }>;
}

export interface RepositoryContextSelection {
  manifest: RepositoryContextManifest;
  excerpts: RepositoryContextExcerpt[];
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

function excludedPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const file = parts.pop()!;
  return parts.some((part) => excludedDirectories.has(part))
    || excludedFiles.has(file)
    || /^(?:\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/u.test(file)
    || /(?:^|[._-])(?:credentials?|secrets?)(?:[._-].+)?\.(?:json|ya?ml|toml|ini|txt)$/u.test(file)
    || /\.(?:pem|key|p12|pfx|keystore|map|sqlite3?|db)$/u.test(file)
    || /\.(?:min|generated|bundle)\.[^.]+$/u.test(file);
}

async function readGitIndex(workspace: string, projects: string[]): Promise<{ bytes: Buffer; limited: boolean }> {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[name];
  let child;
  try {
    child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "--literal-pathspecs", "ls-files", "--cached", "--stage", "-z", "--", ...projects], {
      cwd: workspace, env, stdout: "pipe", stderr: "ignore",
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
}

function listCandidates(bytes: Buffer, projects: string[], pattern: RegExp): { candidates: Candidate[]; trackedPaths: number; limited: boolean } {
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
    if (invalidPathCharacters.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..") || excludedPath(path)) continue;
    const project = projects.findLast((scope) => scope === "." || path.startsWith(`${scope}/`));
    if (project === undefined) continue;
    const projectPath = project === "." ? path : path.slice(project.length + 1);
    const slash = projectPath.indexOf("/");
    const group = slash < 0 ? "" : projectPath.slice(0, slash);
    const pathTerms = matchingTerms(path, pattern);
    const key = `${pathTerms.size}\0${project}\0${group}`;
    const groupOrder = groupCounts.get(key) ?? 0;
    groupCounts.set(key, groupOrder + 1);
    candidates.push({ path, pathTerms, groupOrder });
  }
  // Give equally relevant candidates from different project subdirectories a first pass.
  candidates.sort((a, b) => b.pathTerms.size - a.pathTerms.size || a.groupOrder - b.groupOrder || comparePath(a.path, b.path));
  return { candidates, trackedPaths, limited };
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a === b ? 0 : 1;
}

async function readTrackedText(workspace: string, path: string): Promise<{ lines: string[]; limited: boolean } | undefined> {
  const candidate = join(workspace, path);
  try {
    // Compare the canonical path to exclude both leaf and ancestor symlinks.
    if (await realpath(candidate) !== candidate) return;
    const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) return;
      const buffer = Buffer.alloc(Math.min(info.size, maxFileBytes) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (await realpath(candidate) !== candidate) return;
      const current = await stat(candidate);
      if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs) return;
      const limited = offset > maxFileBytes;
      // Discard any partial line so the line range always identifies complete lines.
      const end = limited ? buffer.lastIndexOf(10, maxFileBytes - 1) + 1 : offset;
      const body = decoder.decode(buffer.subarray(0, end));
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(body)) return;
      const lines = body.split(/\r?\n/u);
      if (lines.at(-1) === "") lines.pop();
      return { lines, limited };
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
}

function findMatch(candidate: Candidate, lines: string[], pattern: RegExp): Match | undefined {
  if (lines.length === 0) return;
  const terms = new Set(candidate.pathTerms);
  let center = 0;
  let bestLineTerms = 0;
  for (let index = 0; index < lines.length; index++) {
    const lineTerms = matchingTerms(lines[index]!, pattern);
    for (const term of lineTerms) terms.add(term);
    if (lineTerms.size > bestLineTerms) {
      bestLineTerms = lineTerms.size;
      center = index;
    }
  }
  if (terms.size === 0) return;
  // Distinct query terms drive ranking, with a preference for concentrated matches.
  const score = terms.size * 4 + bestLineTerms * 2 + candidate.pathTerms.size;
  return { path: candidate.path, lines, center, score };
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
  const tokenBudget = options.tokenBudget ?? defaultTokenBudget;
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > maxTokenBudget) {
    throw new RepositoryContextError(`Choose a whole repository context token budget from 1 to ${maxTokenBudget}.`);
  }
  if (!query || Buffer.byteLength(query) > maxQueryBytes) {
    throw new RepositoryContextError(`Enter a repository context query of 1–${maxQueryBytes} UTF-8 bytes.`);
  }
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}$]+/gu) ?? [])]
    .filter((term) => !stopWords.has(term)).slice(0, 16);
  if (terms.length === 0) throw new RepositoryContextError("Enter repository context search terms such as identifiers, paths, or feature names.");
  const alternatives = terms.map((term) => term.replaceAll("$", "\\$")).join("|");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}$])(?:${alternatives})(?![\\p{L}\\p{N}$])`, "gu");

  const workspace = await realpath(options.workspace).catch(() => undefined);
  if (!workspace || !(await stat(workspace).catch(() => undefined))?.isDirectory()) {
    throw new RepositoryContextError("Choose an existing coding workspace directory.");
  }
  const projects = await projectScopes(workspace, options.projects);
  const listing = await readGitIndex(workspace, projects);
  const { candidates, trackedPaths, limited } = listCandidates(listing.bytes, projects, pattern);
  const toScan = candidates.slice(0, maxScannedFiles);
  const matches: Match[] = [];
  const limitsReached = {
    trackedPaths: listing.limited || limited,
    scannedFiles: candidates.length > toScan.length,
    fileBytes: false,
    selectedFiles: false,
    tokenBudget: false,
  };
  for (const candidate of toScan) {
    const source = await readTrackedText(workspace, candidate.path);
    if (!source) continue;
    limitsReached.fileBytes ||= source.limited;
    const match = findMatch(candidate, source.lines, pattern);
    if (match) matches.push(match);
  }
  matches.sort((a, b) => b.score - a.score || comparePath(a.path, b.path));

  const excerpts: RepositoryContextExcerpt[] = [];
  let contextBytes = 2; // Empty JSON array.
  for (const match of matches) {
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
    contextBytes += serializedBytes(excerpt) + comma;
  }

  const files = excerpts.map(({ path, startLine, endLine, content }) => ({ path, startLine, endLine, sha256: sha256(content) }));
  const manifest: RepositoryContextManifest = {
    id: sha256(JSON.stringify([1, projects, query, tokenBudget, files])), projects, query, tokenBudget,
    estimatedTokens: Math.ceil(contextBytes / 2), contextBytes, trackedPaths, candidateFiles: candidates.length,
    scannedFiles: toScan.length, matchedFiles: matches.length, limitsReached, files,
  };
  return { manifest, excerpts };
}
