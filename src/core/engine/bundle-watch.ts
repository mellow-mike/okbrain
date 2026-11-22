import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { log } from "../log.ts";
import { listConcepts } from "../okf/bundle.ts";
import { idToAbsPath } from "../okf/paths.ts";
import { buildIndex, withIndexWrite, type IndexStats } from "./index-build.ts";
import { defaultDbPath, EngineError, openSqliteEngine } from "./sqlite.ts";

const scanIntervalMs = 750;
const statBatch = 32;

export interface BundleWatchStatus {
  active: boolean;
  indexing: boolean;
  lastIndexedAt: string | null;
  stats: IndexStats | null;
  error: string | null;
}

/** Keep quiet scans to directory entries and timestamps, even for large files. */
async function bundleSignature(bundle: string): Promise<string> {
  const ids = await listConcepts(bundle);
  const hash = createHash("sha256");
  for (let i = 0; i < ids.length; i += statBatch) {
    const records = await Promise.all(ids.slice(i, i + statBatch).map(async (id) => {
      const info = await lstat(idToAbsPath(bundle, id), { bigint: true });
      return [id, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join("\0") + "\0";
    }));
    for (const record of records) hash.update(record);
  }
  return hash.digest("hex");
}

/** Watch one writable bundle for the lifetime of the process that enabled it. */
export class BundleWatcher {
  readonly #source: string;
  readonly #bundle: string;
  readonly #dbPath: string;
  readonly #canWrite: () => boolean;
  readonly #stopped = Promise.withResolvers<void>();
  #active = true;
  #indexing = true;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #run: Promise<void> | undefined;
  #indexSignature: string | null = null;
  #error: string | null = null;
  #lastIndexedAt: string | null = null;
  #stats: IndexStats | null = null;

  constructor(bundle: string, canWrite: () => boolean = () => true) {
    this.#source = bundle;
    this.#canWrite = canWrite;
    try {
      this.#bundle = realpathSync(bundle);
      if (!canWrite() || !statSync(this.#bundle).isDirectory()) throw new Error("Choose a writable brain folder.");
      this.#dbPath = defaultDbPath(this.#bundle);
    } catch (error) {
      throw new EngineError(`could not watch the brain folder: ${(error as Error).message}`);
    }
    // Recursive notifications can miss changes such as whole-directory
    // removals. Using the same traversal as the index also excludes caches.
    this.#schedule(0);
  }

  get finished(): Promise<void> { return this.#stopped.promise; }

  status(): BundleWatchStatus {
    return {
      active: this.#active,
      indexing: this.#active && this.#indexing,
      lastIndexedAt: this.#lastIndexedAt,
      stats: this.#stats,
      error: this.#error,
    };
  }

  stop(): Promise<void> {
    this.#finish();
    return this.finished;
  }

  #finish(error?: string): void {
    if (!this.#active) return;
    this.#active = false;
    if (error) this.#report(error);
    clearTimeout(this.#timer);
    if (!this.#run) this.#stopped.resolve();
  }

  #checkAccess(): boolean {
    if (!this.#active) return false;
    try {
      if (this.#canWrite() && realpathSync(this.#source) === this.#bundle) return true;
    } catch { /* The mount or the path disappeared. */ }
    this.#finish("the brain folder or its write permission changed; reopen the brain and start watching again");
    return false;
  }

  #report(message: string): void {
    if (this.#error !== message) log.warn("bundle watch", { error: message });
    this.#error = message;
  }

  #schedule(delay = scanIntervalMs): void {
    this.#timer = setTimeout(() => {
      this.#run = this.#refresh().finally(() => {
        this.#run = undefined;
        if (!this.#active) this.#stopped.resolve();
        else this.#schedule();
      });
    }, delay);
  }

  async #refresh(): Promise<void> {
    if (!this.#checkAccess()) return;
    try {
      // Take the signature before building. A save that overlaps an index
      // pass remains visible as a change on the next scan.
      const signature = await bundleSignature(this.#bundle);
      if (signature === this.#indexSignature && existsSync(this.#dbPath)) return;
      this.#indexing = true;
      const stats = await withIndexWrite(this.#bundle, async () => {
        if (!this.#checkAccess()) return;
        const engine = openSqliteEngine(this.#dbPath);
        try { return await buildIndex(this.#bundle, engine); }
        finally { engine.close(); }
      });
      if (!stats || !this.#active) return;
      this.#indexSignature = signature;
      this.#lastIndexedAt = new Date().toISOString();
      this.#stats = stats;
      this.#error = null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Atomic saves and concurrent writers are retried on the next scan.
      if (code !== "ENOENT" && code !== "ENOTDIR" && !code?.startsWith("SQLITE_BUSY") && !code?.startsWith("SQLITE_LOCKED"))
        this.#report((error as Error).message);
    } finally {
      this.#indexing = false;
    }
  }
}

export async function watchBundleInForeground(bundle: string, canWrite: () => boolean): Promise<BundleWatchStatus> {
  const watcher = new BundleWatcher(bundle, canWrite);
  const onSignal = () => { void watcher.stop(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    log.info("watching brain folder; press Ctrl+C to stop");
    await watcher.finished;
    return watcher.status();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
