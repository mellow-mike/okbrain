import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "../config.ts";
import { ensureExtensionCapableSqlite } from "./custom-sqlite.ts";
import { EngineError } from "./sqlite.ts";

interface SavedCache {
  namespace: string;
  connection: string | null;
}

const settingsPath = () => join(dataDir(), "cache", "settings.sqlite");
const brainKey = (bundle: string) => createHash("sha256").update(realpathSync(bundle)).digest("hex");
const unavailableMessage = "PostgreSQL cache is unavailable. Check the local database and its credentials in Settings.";

function openSettings(path: string, write: boolean): Database {
  if (write) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
    throw new EngineError("Cache settings require a private local database (0600 on Unix).");
  ensureExtensionCapableSqlite();
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS settings (brain TEXT PRIMARY KEY, namespace TEXT NOT NULL, connection TEXT)");
    return db;
  } catch (error) { db.close(); throw error; }
}

export function readCacheSettings(bundle: string): SavedCache | null {
  const path = settingsPath();
  if (!existsSync(path)) return null;
  const db = openSettings(path, false);
  try {
    return db.query<SavedCache, [string]>("SELECT namespace, connection FROM settings WHERE brain = ?").get(brainKey(bundle));
  } finally { db.close(); }
}

function normalizeConnection(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); }
  catch { throw new TypeError("Enter a PostgreSQL connection URL."); }
  const validOptions = [...url.searchParams].every(([key, value]) =>
    key === "sslmode" && (value === "disable" || value === "verify-full"));
  if (raw.length > 4096 || !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.username ||
      !/^\/[^/]+$/.test(url.pathname) || url.hash || !validOptions || url.searchParams.size > 1)
    throw new TypeError("Enter a PostgreSQL URL with a user, database, and loopback address (127.0.0.1 or [::1]). The optional sslmode is disable or verify-full.");
  return url.toString();
}

export function createCacheClient(url: string): SQL {
  try {
    return new SQL({ url, max: 2, connectionTimeout: 4, idleTimeout: 10,
      connection: { statement_timeout: 30_000 } });
  } catch {
    throw new EngineError(unavailableMessage);
  }
}

export async function closeCacheClient(sql: SQL): Promise<void> {
  try { await sql.close({ timeout: 1 }); }
  catch { /* The operation already reported any database failure. */ }
}

export async function postgresAccess<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError(unavailableMessage);
  }
}

export async function setCacheSettings(bundle: string, raw: string | null): Promise<void> {
  const path = settingsPath();
  if (raw === null && !existsSync(path)) return;
  const connection = raw === null ? null : normalizeConnection(raw);
  if (connection) {
    const sql = createCacheClient(connection);
    try {
      await postgresAccess(async () => {
        const [result] = await sql<{ has_vector: boolean; can_create: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'vector') AS has_vector,
                 pg_catalog.has_database_privilege(current_database(), 'CREATE') AS can_create
        `;
        if (!result?.has_vector)
          throw new EngineError("Install the pgvector extension in this PostgreSQL database before connecting it.");
        if (!result.can_create)
          throw new EngineError("The PostgreSQL user needs permission to create a cache schema in this database.");
      });
    } finally { await closeCacheClient(sql); }
  }
  const db = openSettings(path, true);
  try {
    const key = brainKey(bundle);
    if (connection === null) db.query("UPDATE settings SET connection = NULL WHERE brain = ?").run(key);
    else db.query(`INSERT INTO settings(brain, namespace, connection) VALUES (?, ?, ?)
      ON CONFLICT(brain) DO UPDATE SET connection = excluded.connection`)
      .run(key, `okb_${randomBytes(16).toString("hex")}`, connection);
  } finally { db.close(); }
}
