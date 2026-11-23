import { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "../config.ts";
import { ensureExtensionCapableSqlite } from "../engine/custom-sqlite.ts";
import { AiError, RECIPES } from "./recipes.ts";

const providers = Object.entries(RECIPES).flatMap(([provider, recipe]) =>
  recipe.apiKeyEnv ? [[provider, recipe.apiKeyEnv] as const] : []);
const pathOf = () => join(dataDir(), "providers", "keys.sqlite");

function openStore(path: string, write: boolean): Database {
  if (write) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
    throw new AiError("Provider credentials require a private local database (0600 on Unix).");
  ensureExtensionCapableSqlite();
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS keys (provider TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return db;
  } catch (error) { db.close(); throw error; }
}

function savedKeys(): Record<string, string> {
  const path = pathOf();
  if (!existsSync(path)) return {};
  const db = openStore(path, false);
  try {
    const rows = db.query<{ provider: string; value: string }, []>("SELECT provider, value FROM keys").all();
    return Object.fromEntries(rows.map(({ provider, value }) => [provider, value]));
  } finally { db.close(); }
}

export function gatewayEnvironment(): Record<string, string | undefined> {
  const env = { ...process.env };
  const keys = savedKeys();
  for (const [provider, variable] of providers) if (!env[variable] && keys[provider]) env[variable] = keys[provider];
  return env;
}

export function providerKeyStatus() {
  const keys = savedKeys();
  return providers.map(([provider, variable]) => ({ provider, saved: Boolean(keys[provider]), environment: Boolean(process.env[variable]) }));
}

export function setProviderKey(provider: unknown, value: unknown): void {
  if (!providers.some(([name]) => name === provider)) throw new TypeError("Choose a supported API provider.");
  if (value !== null && (typeof value !== "string" || !value.trim() || !/^[\x21-\x7e]{1,4096}$/.test(value.trim())))
    throw new TypeError("Enter an API key up to 4,096 visible characters.");
  const path = pathOf();
  if (value === null && !existsSync(path)) return;
  const db = openStore(path, true);
  try {
    if (value === null) db.query("DELETE FROM keys WHERE provider = ?").run(provider as string);
    else db.query("INSERT OR REPLACE INTO keys(provider, value) VALUES (?, ?)").run(provider as string, (value as string).trim());
  } finally { db.close(); }
}
