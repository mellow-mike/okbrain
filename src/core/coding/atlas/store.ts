// Storage for one workspace's repository atlas, in per-user application data.
// `atlas.sqlite` and the flat vector files are derived: deleting them and
// importing again rebuilds them from the checkout. Learned state lives beside
// them in `learning.sqlite` (see learn.ts) and survives a rebuild.

import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../config.ts";
import { ensureExtensionCapableSqlite } from "../../engine/custom-sqlite.ts";
import { dfBuckets, embeddingDim, type DocumentFrequencies } from "./text.ts";

export const atlasVersion = 1;
export class AtlasError extends Error {}
export class AtlasMissingError extends AtlasError {}
export class AtlasBusyError extends AtlasError {}

export interface AtlasLocation { stateDir?: string }

export function atlasRoot({ stateDir }: AtlasLocation = {}): string {
  return stateDir ?? join(dataDir(), "coding", "atlas");
}

/** One directory per canonical workspace path. The key reveals nothing about the path. */
export function atlasDirectory(workspace: string, location: AtlasLocation = {}): string {
  return join(atlasRoot(location), createHash("sha256").update(workspace).digest("hex").slice(0, 32));
}

export const knowledgeDirectory = (directory: string): string => join(directory, "knowledge");

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory()) throw new AtlasError("Repository atlas state must be a local directory.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

const schema = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS packages(
    id INTEGER PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, ecosystem TEXT NOT NULL,
    manifest TEXT, description TEXT, owners TEXT NOT NULL DEFAULT '[]', files INTEGER NOT NULL DEFAULT 0, units INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS package_edges(
    src INTEGER NOT NULL, dst INTEGER NOT NULL, kind TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY(src, dst, kind)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS files(
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, package INTEGER NOT NULL DEFAULT 0, language TEXT NOT NULL, role TEXT NOT NULL,
    lines INTEGER NOT NULL, sha256 TEXT NOT NULL, stamp TEXT NOT NULL, gist TEXT NOT NULL, imports TEXT NOT NULL DEFAULT '[]',
    limited INTEGER NOT NULL DEFAULT 0, units INTEGER NOT NULL DEFAULT 0, vectors BLOB
  );
  CREATE INDEX IF NOT EXISTS files_package ON files(package, role, path);
  CREATE TABLE IF NOT EXISTS units(
    id INTEGER PRIMARY KEY, file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, ord INTEGER NOT NULL, kind TEXT NOT NULL,
    name TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, role TEXT NOT NULL, gist TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS units_file ON units(file, ord);
  CREATE TABLE IF NOT EXISTS symbols(name TEXT NOT NULL, unit INTEGER NOT NULL, file INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
  CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);
  CREATE TABLE IF NOT EXISTS file_edges(
    src INTEGER NOT NULL, dst INTEGER NOT NULL, kind TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY(src, dst, kind)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS file_edges_dst ON file_edges(dst);
  CREATE TABLE IF NOT EXISTS tools(
    id TEXT PRIMARY KEY, package INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, cwd TEXT NOT NULL, argv TEXT NOT NULL,
    source_path TEXT NOT NULL, source_line INTEGER NOT NULL
  ) WITHOUT ROWID;
`;
// Terms are written already split and lowercased, so the tokenizer must keep
// `_` and `$` inside a token for stored and queried identifiers to agree.
const ftsSchema = `
  CREATE VIRTUAL TABLE IF NOT EXISTS unit_text USING fts5(
    name, path, alias, body, tokenize = "unicode61 remove_diacritics 0 tokenchars '_$'"
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS unit_vocab USING fts5vocab(unit_text, 'row');
`;

export interface AtlasMeta {
  version: number;
  workspace: string;
  generation: number;
  revision?: string;
  importedAt?: string;
  scopes: string[];
  files: number;
  units: number;
  packages: number;
  historyCommits: number;
  historyLimit?: number;
  limited: boolean;
}

export interface AtlasVectors {
  generation: number;
  rows: number;
  /** rows × embeddingDim quantized unit vectors. */
  vectors: Int8Array;
  /** rows × 4: unit id, file id, package id, role index. */
  index: Uint32Array;
}

const vectorCache = new Map<string, AtlasVectors>();

export class Atlas {
  readonly directory: string;
  readonly db: Database;
  readonly #lease: Database | undefined;
  #closed = false;

  private constructor(directory: string, db: Database, lease?: Database) {
    this.directory = directory;
    this.db = db;
    this.#lease = lease;
  }

  /**
   * Open for import. A separate SQLite connection holds an exclusive lease for
   * the lifetime of the import and releases it if the process dies.
   */
  static create(workspace: string, location: AtlasLocation = {}): Atlas {
    const directory = atlasDirectory(workspace, location);
    privateDirectory(atlasRoot(location));
    privateDirectory(directory);
    ensureExtensionCapableSqlite();
    const lease = new Database(join(directory, "owner.sqlite"));
    try {
      lease.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    } catch (error) {
      lease.close();
      if ((error as { code?: string }).code === "SQLITE_BUSY") throw new AtlasBusyError("This repository is already being imported by another okbrain process.");
      throw error;
    }
    let db: Database | undefined;
    try {
      db = new Database(join(directory, "atlas.sqlite"), { strict: true, create: true, readwrite: true });
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
      const saved = Atlas.#version(db);
      if (saved !== undefined && saved !== atlasVersion) {
        // An older derived layout is rebuilt rather than migrated.
        db.exec("DROP TABLE IF EXISTS unit_vocab; DROP TABLE IF EXISTS unit_text; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS packages; DROP TABLE IF EXISTS package_edges; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS units; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS file_edges; DROP TABLE IF EXISTS tools");
      }
      db.exec(schema);
      try { db.exec(ftsSchema); }
      catch (error) { throw new AtlasError(`This SQLite build cannot create the repository search index: ${(error as Error).message}`); }
      const atlas = new Atlas(directory, db, lease);
      if (atlas.#get("version") === undefined) {
        atlas.#set("version", atlasVersion);
        atlas.#set("workspace", workspace);
        atlas.#set("generation", 0);
      }
      return atlas;
    } catch (error) {
      db?.close(true);
      lease.close(true);
      throw error;
    }
  }

  /** Open an imported atlas for reading. */
  static open(workspace: string, location: AtlasLocation = {}): Atlas {
    const directory = atlasDirectory(workspace, location);
    const path = join(directory, "atlas.sqlite");
    if (!existsSync(path)) throw new AtlasMissingError("This repository has not been imported yet. Run `okb code import` for the workspace first.");
    ensureExtensionCapableSqlite();
    const db = new Database(path, { strict: true, readwrite: true, create: false });
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON");
      const atlas = new Atlas(directory, db);
      if (Atlas.#version(db) !== atlasVersion || atlas.meta().generation < 1)
        throw new AtlasMissingError("This repository's import is incomplete or from another okbrain version. Run `okb code import` again.");
      return atlas;
    } catch (error) {
      db.close(true);
      throw error;
    }
  }

  static exists(workspace: string, location: AtlasLocation = {}): boolean {
    return existsSync(join(atlasDirectory(workspace, location), "atlas.sqlite"));
  }

  static #version(db: Database): number | undefined {
    try {
      using statement = db.prepare<{ value: number }, []>("SELECT value FROM meta WHERE key = 'version'");
      return statement.get()?.value;
    } catch { return undefined; }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close(true);
    this.#lease?.close(true);
  }

  [Symbol.dispose](): void { this.close(); }

  /** A reusable statement for bulk work. The caller finalizes it. */
  prepare<Row>(sql: string): Statement<Row, SQLQueryBindings[]> {
    return this.db.prepare<Row, SQLQueryBindings[]>(sql);
  }

  all<Row>(sql: string, ...params: SQLQueryBindings[]): Row[] {
    using statement = this.db.prepare<Row, SQLQueryBindings[]>(sql);
    return statement.all(...params);
  }

  get<Row>(sql: string, ...params: SQLQueryBindings[]): Row | undefined {
    using statement = this.db.prepare<Row, SQLQueryBindings[]>(sql);
    return statement.get(...params) ?? undefined;
  }

  run(sql: string, ...params: SQLQueryBindings[]): void {
    using statement = this.db.prepare<unknown, SQLQueryBindings[]>(sql);
    statement.run(...params);
  }

  #get(key: string): unknown {
    return this.get<{ value: unknown }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }

  #set(key: string, value: SQLQueryBindings): void {
    this.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  setMeta(values: Partial<Omit<AtlasMeta, "scopes" | "limited">> & { scopes?: string[]; limited?: boolean }): void {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      this.#set(key, Array.isArray(value) ? JSON.stringify(value) : typeof value === "boolean" ? Number(value) : value);
    }
  }

  meta(): AtlasMeta {
    const rows = this.all<{ key: string; value: unknown }>("SELECT key, value FROM meta WHERE typeof(value) != 'blob'");
    const values = new Map(rows.map(({ key, value }) => [key, value]));
    const number = (key: string) => typeof values.get(key) === "number" ? values.get(key) as number : 0;
    const text = (key: string) => typeof values.get(key) === "string" ? values.get(key) as string : undefined;
    let scopes: string[] = ["."];
    try {
      const parsed: unknown = JSON.parse(text("scopes") ?? "[]");
      if (Array.isArray(parsed) && parsed.length && parsed.every((scope) => typeof scope === "string")) scopes = parsed;
    } catch { /* A damaged value falls back to the whole workspace. */ }
    return {
      version: number("version"), workspace: text("workspace") ?? "", generation: number("generation"), revision: text("revision"),
      importedAt: text("importedAt"), scopes, files: number("files"), units: number("units"), packages: number("packages"),
      historyCommits: number("historyCommits"), historyLimit: values.has("historyLimit") ? number("historyLimit") : undefined,
      limited: number("limited") === 1,
    };
  }

  blob(key: string): Uint8Array | undefined {
    const value = this.#get(key);
    return value instanceof Uint8Array ? value : undefined;
  }

  setBlob(key: string, value: Uint8Array): void { this.#set(key, value); }

  frequencies(): DocumentFrequencies | undefined {
    const saved = this.blob("df");
    const documents = this.#get("dfDocuments");
    if (!saved || saved.byteLength !== dfBuckets * 4 || typeof documents !== "number") return undefined;
    return { documents, counts: new Uint32Array(saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength)) };
  }

  setFrequencies(frequencies: DocumentFrequencies): void {
    this.setBlob("df", new Uint8Array(frequencies.counts.buffer, frequencies.counts.byteOffset, frequencies.counts.byteLength));
    this.#set("dfDocuments", frequencies.documents);
  }

  /**
   * Write a new set of flat vector files and name it the readable generation.
   * Inside a transaction, readers switch to it when the transaction commits.
   * The files of older generations stay until `dropStaleVectors`.
   */
  publishVectors(vectors: Int8Array, index: Uint32Array, counts: Pick<AtlasMeta, "files" | "units" | "packages">): number {
    const generation = this.meta().generation + 1;
    const write = (name: string, bytes: Uint8Array) => {
      const target = join(this.directory, name);
      const temporary = `${target}.tmp`;
      writeFileSync(temporary, bytes, { mode: 0o600 });
      renameSync(temporary, target);
    };
    write(`units-${generation}.vec`, new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength));
    write(`units-${generation}.idx`, new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
    this.setMeta({ generation, ...counts });
    vectorCache.delete(this.directory);
    return generation;
  }

  /**
   * Remove vector files of every generation but `keep`, once that generation is committed.
   * A reader that already loaded an older generation keeps its copy in memory, and one that
   * was about to load it looks again (see `readAtlas`). Best effort: a file another process
   * holds open is left for the next import.
   */
  dropStaleVectors(keep: number): void {
    for (const name of readdirSync(this.directory)) {
      const match = /^units-(\d+)\.(?:vec|idx)(?:\.tmp)?$/u.exec(name);
      if (!match || Number(match[1]) === keep) continue;
      try { rmSync(join(this.directory, name), { force: true }); } catch { /* Still in use. */ }
    }
  }

  /** Load the flat vectors for the generation this connection sees. */
  vectors(): AtlasVectors {
    const { generation } = this.meta();
    const cached = vectorCache.get(this.directory);
    if (cached?.generation === generation) return cached;
    let bytes: Buffer;
    let indexBytes: Buffer;
    try {
      bytes = readFileSync(join(this.directory, `units-${generation}.vec`));
      indexBytes = readFileSync(join(this.directory, `units-${generation}.idx`));
    } catch (error) {
      throw new AtlasMissingError("The repository import is incomplete. Run `okb code import` again.", { cause: error });
    }
    const rows = indexBytes.byteLength / 16;
    if (!Number.isInteger(rows) || bytes.byteLength !== rows * embeddingDim)
      throw new AtlasMissingError("The repository vector files are damaged. Run `okb code import --full` to rebuild them.");
    const loaded: AtlasVectors = {
      generation, rows,
      vectors: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      index: new Uint32Array(indexBytes.buffer.slice(indexBytes.byteOffset, indexBytes.byteOffset + indexBytes.byteLength)),
    };
    vectorCache.set(this.directory, loaded);
    return loaded;
  }
}

/** Remove a workspace's derived atlas. Learned state and the knowledge bundle are kept unless `everything` is set. */
export function removeAtlas(workspace: string, location: AtlasLocation = {}, everything = false): boolean {
  const directory = atlasDirectory(workspace, location);
  if (!existsSync(directory)) return false;
  vectorCache.delete(directory);
  if (everything) {
    rmSync(directory, { recursive: true, force: true });
    return true;
  }
  let removed = false;
  for (const name of readdirSync(directory)) {
    if (/^atlas\.sqlite(?:-wal|-shm|-journal)?$/u.test(name) || /^units-\d+\.(?:vec|idx)(?:\.tmp)?$/u.test(name)) {
      rmSync(join(directory, name), { force: true });
      removed = true;
    }
  }
  return removed;
}
