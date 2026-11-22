import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { dataDir } from "../config.ts";

const indexVersion = 2;
const maxIndexedFiles = 4096;
const maxIndexBytes = 8 * 1024 * 1024;
const maxSymbolsPerFile = 48;
const maxImportsPerFile = 32;
const extensionPriority = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];
const symbolPattern = /^(?:\s*(?:export|default|declare|async|pub|abstract|public|private|protected|static)\s+)*\s*(?:function\*?|class|interface|type|enum|namespace|const|let|var|fn|struct|trait|def)\s+([\p{L}_$][\p{L}\p{N}_$]{0,95})\b/u;
const goFunctionPattern = /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][A-Za-z0-9_]{0,95})\b/u;
const methodPattern = /^\s*(?:(?:public|private|protected|static|abstract)\s+)+(?:async\s+)?([\p{L}_$][\p{L}\p{N}_$]{0,95})\s*[<(]/u;
const moduleSyntax = /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([\w@./-]{1,256})["']/gu;

export interface RepositoryFileStructure {
  stamp: string;
  symbols: { name: string; line: number; method?: true }[];
  imports: string[];
  pkg?: { name: string; entries: string[] };
}

interface SavedIndex {
  version: typeof indexVersion;
  revision: string;
  files: Record<string, RepositoryFileStructure>;
}

export interface IndexedRepository {
  files: Map<string, RepositoryFileStructure>;
  limited: boolean;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageFields(lines: string[]): RepositoryFileStructure["pkg"] {
  try {
    const pkg: unknown = JSON.parse(lines.join("\n"));
    if (!plainObject(pkg) || typeof pkg.name !== "string" || !/^(?:@[\w.-]+\/)?[\w.-]{1,120}$/u.test(pkg.name)) return;
    const exportedRoot = plainObject(pkg.exports) ? pkg.exports["."] : pkg.exports;
    const exports = plainObject(exportedRoot) ? [exportedRoot.types, exportedRoot.import, exportedRoot.require, exportedRoot.default] : [exportedRoot];
    const entries = [...exports, pkg.types, pkg.module, pkg.main, "src/index", "index"]
      .filter((entry): entry is string => typeof entry === "string" && /^[\w./-]{1,256}$/u.test(entry));
    return { name: pkg.name, entries: [...new Set(entries)] };
  } catch {
    return undefined;
  }
}

export function fileStructure(path: string, source: { stamp: string; lines: string[]; limited: boolean }): RepositoryFileStructure {
  const { stamp, lines, limited } = source;
  const symbols: RepositoryFileStructure["symbols"] = [];
  const imports = new Set<string>();
  if (/\.(?:[cm]?[jt]sx?|go|py|rs)$/u.test(path)) {
    for (const [index, line] of lines.entries()) {
      if (symbols.length < maxSymbolsPerFile) {
        const method = line.match(methodPattern)?.[1];
        const name = line.match(symbolPattern)?.[1] ?? line.match(goFunctionPattern)?.[1] ?? method;
        if (name) symbols.push({ name, line: index, ...(method === name ? { method: true as const } : {}) });
      }
      if (imports.size < maxImportsPerFile && /\.[cm]?[jt]sx?$/u.test(path)) {
        for (const match of line.matchAll(moduleSyntax)) {
          imports.add(match[1]!);
          if (imports.size === maxImportsPerFile) break;
        }
      }
      if (symbols.length === maxSymbolsPerFile && imports.size === maxImportsPerFile) break;
    }
  }
  const pkg = posix.basename(path) === "package.json" && !limited ? packageFields(lines) : undefined;
  return { stamp, symbols, imports: [...imports], ...(pkg ? { pkg } : {}) };
}

function savedFile(value: unknown): RepositoryFileStructure | undefined {
  if (!plainObject(value) || typeof value.stamp !== "string" || !Array.isArray(value.symbols) || !Array.isArray(value.imports)) return;
  if (value.symbols.length > maxSymbolsPerFile || value.imports.length > maxImportsPerFile) return;
  if (!value.symbols.every((item) => plainObject(item) && typeof item.name === "string" && Number.isInteger(item.line) && Number(item.line) >= 0
    && (item.method === undefined || item.method === true))) return;
  if (!value.imports.every((item) => typeof item === "string")) return;
  if (value.pkg !== undefined && (!plainObject(value.pkg) || typeof value.pkg.name !== "string" || !Array.isArray(value.pkg.entries)
    || !value.pkg.entries.every((entry) => typeof entry === "string"))) return;
  return value as unknown as RepositoryFileStructure;
}

async function readIndex(path: string): Promise<SavedIndex | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxIndexBytes) return;
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) return;
      const value: unknown = JSON.parse(bytes.toString("utf8", 0, bytesRead));
      if (!plainObject(value) || value.version !== indexVersion || typeof value.revision !== "string" || !plainObject(value.files)) return;
      return value as unknown as SavedIndex;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

async function writeIndex(dir: string, path: string, index: SavedIndex): Promise<void> {
  const body = JSON.stringify(index);
  if (Buffer.byteLength(body) > maxIndexBytes) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory()) return;
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await chmod(dir, 0o700);
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch {
    // Index files are disposable. Preview continues if app-data is unavailable.
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function indexRepository(options: {
  workspace: string;
  revision: string;
  paths: string[];
  stamp: (path: string) => Promise<string | undefined>;
  read: (path: string) => Promise<{ stamp: string; lines: string[]; limited: boolean } | undefined>;
}): Promise<IndexedRepository> {
  const { workspace, revision, paths, stamp, read } = options;
  const dir = join(dataDir(), "coding", "context-index");
  const key = createHash("sha256").update(workspace).digest("hex");
  const path = join(dir, `${key}.json`);
  const previous = await readIndex(path);
  const sameRevision = previous?.revision === revision;
  const files = new Map<string, RepositoryFileStructure>();
  const bounded = paths.slice(0, maxIndexedFiles).filter((candidate) => /(?:\.[cm]?[jt]sx?|\.go|\.py|\.rs|(?:^|\/)package\.json)$/u.test(candidate));
  let reused = 0;
  for (let offset = 0; offset < bounded.length; offset += 16) {
    const batch = await Promise.all(bounded.slice(offset, offset + 16).map(async (candidate) => {
      const saved = sameRevision ? savedFile(previous.files[candidate]) : undefined;
      if (saved && await stamp(candidate) === saved.stamp) {
        reused++;
        return [candidate, saved] as const;
      }
      const source = await read(candidate);
      return source ? [candidate, fileStructure(candidate, source)] as const : undefined;
    }));
    for (const entry of batch) if (entry) files.set(...entry);
  }
  if (!sameRevision || reused !== files.size || Object.keys(previous.files).length !== files.size) {
    await writeIndex(dir, path, { version: indexVersion, revision, files: Object.fromEntries(files) });
  }
  return { files, limited: paths.length > maxIndexedFiles };
}

export function dependencyResolver(files: ReadonlyMap<string, RepositoryFileStructure>, tracked: ReadonlySet<string>) {
  const packages = new Map<string, { root: string; entries: string[] } | null>();
  for (const [path, file] of files) {
    if (!file.pkg) continue;
    const { name, entries } = file.pkg;
    packages.set(name, packages.has(name) ? null : { root: posix.dirname(path), entries });
  }
  function resolveTracked(base: string): string | undefined {
    if (tracked.has(base)) return base;
    const stem = /\.[cm]?jsx?$/u.test(base) ? base.slice(0, base.lastIndexOf(".")) : base;
    for (const ext of extensionPriority) if (tracked.has(stem + ext)) return stem + ext;
    for (const ext of extensionPriority) if (tracked.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return (importer: string, specifier: string): string | undefined => {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return resolveTracked(posix.normalize(posix.join(posix.dirname(importer), specifier)));
    }
    const segments = specifier.split("/");
    const name = segments.splice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    const pkg = packages.get(name);
    if (!pkg) return;
    const suffix = segments.join("/");
    const entries = suffix ? [suffix, posix.join("src", suffix)] : pkg.entries;
    for (const entry of entries) {
      const candidate = posix.normalize(posix.join(pkg.root, entry));
      if (pkg.root !== "." && !candidate.startsWith(`${pkg.root}/`)) continue;
      const result = resolveTracked(candidate);
      if (result) return result;
    }
  };
}
