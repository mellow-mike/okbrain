import { Database } from "bun:sqlite";
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataDir } from "./config.ts";
import { ensureExtensionCapableSqlite } from "./engine/custom-sqlite.ts";

export type GitHubSyncCredential = { origin: string; login: string; token: string };

const githubLogin = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu;
const githubToken = /^github_pat_[a-zA-Z0-9_]{20,256}$/u;

/** A selected GitHub.com smart HTTP endpoint, with no URL credentials or aliases. */
export function syncGitHubRepository(origin: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([a-z0-9_.-]{1,100})\.git$/iu.exec(origin);
  if (!match?.[1] || !match[2] || !githubLogin.test(match[1]) || match[2] === "." || match[2] === "..") return null;
  return `${match[1]}/${match[2]}`;
}

export function parseGitHubSyncCredential(origin: string, login: unknown, token: unknown): GitHubSyncCredential {
  if (typeof login !== "string" || !githubLogin.test(login.trim())) throw new TypeError("Enter your GitHub login.");
  if (typeof token !== "string" || !githubToken.test(token.trim())) throw new TypeError("Enter a fine-grained GitHub personal access token.");
  return { origin, login: login.trim(), token: token.trim() };
}

function fileStatus(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function privateMode(info: NonNullable<ReturnType<typeof fileStatus>>): boolean {
  return process.platform === "win32" || (info.uid === process.getuid?.() && (info.mode & 0o077) === 0);
}

const storeDirectory = () => join(dataDir(), "sync-credentials");

function physicalPath(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(physicalPath(parent), basename(path));
  }
}

/** Protect a credential store even when a different registered brain encloses it. */
export function brainEnclosesGitHubSyncStore(canonicalRoot: string): boolean {
  const path = relative(canonicalRoot, physicalPath(resolve(storeDirectory())));
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function store(write: boolean, create: boolean): Database | undefined {
  const directory = storeDirectory();
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const folder = fileStatus(directory);
  if (!folder) return;
  if (!folder.isDirectory() || !privateMode(folder)) throw new Error("Git credential storage must be a private directory.");
  const path = join(directory, "github.sqlite");
  if (create) {
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!fileStatus(path)) return;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const status = fileStatus(path + suffix);
    if (status && (!status.isFile() || status.nlink !== 1 || !privateMode(status)))
      throw new Error("Git credential storage requires a private database file.");
  }
  ensureExtensionCapableSqlite();
  const db = write ? new Database(path) : new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    if (write) db.exec(`PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS credentials (brain TEXT PRIMARY KEY, origin TEXT NOT NULL, login TEXT NOT NULL, token TEXT NOT NULL)`);
    return db;
  } catch (error) { db.close(); throw error; }
}

const brainKey = (root: string) => process.platform === "win32" ? root.toLowerCase() : root;

export function savedGitHubSyncCredential(root: string): GitHubSyncCredential | null {
  const db = store(false, false);
  if (!db) return null;
  try { return db.query<GitHubSyncCredential, [string]>("SELECT origin, login, token FROM credentials WHERE brain = ?").get(brainKey(root)); }
  finally { db.close(); }
}

export function updateGitHubSyncCredential(root: string, value: GitHubSyncCredential | null): void {
  const db = store(true, value !== null);
  if (!db) return;
  try {
    if (!value) db.query("DELETE FROM credentials WHERE brain = ?").run(brainKey(root));
    else db.query(`INSERT INTO credentials(brain, origin, login, token) VALUES (?, ?, ?, ?)
      ON CONFLICT(brain) DO UPDATE SET origin = excluded.origin, login = excluded.login, token = excluded.token`)
      .run(brainKey(root), value.origin, value.login, value.token);
  } finally { db.close(); }
}

/** Build a one-command Git HTTPS delegation. Callers must verify the bound origin immediately first. */
export function gitHubSyncTransport(credential: GitHubSyncCredential, hooksDirectory: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const { origin, login, token } = credential;
  const env: NodeJS.ProcessEnv = {};
  const removed = new Set([
    "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CURL_VERBOSE",
    "GIT_SSL_NO_VERIFY", "SSLKEYLOGFILE", "OKB_SYNC_AUTH_HEADER", "GIT_ALLOW_PROTOCOL",
  ]);
  for (const key of Object.keys(process.env)) {
    if (removed.has(key.toUpperCase()) || /^(?:GIT_TRACE|GIT_CONFIG_(?:KEY|VALUE)_)/iu.test(key)) env[key] = undefined;
  }
  Object.assign(env, {
    GIT_TRACE2: "0", GIT_TRACE2_EVENT: "0", GIT_TRACE2_PERF: "0",
    OKB_SYNC_AUTH_HEADER: `Authorization: Basic ${Buffer.from(`${login}:${token}`).toString("base64")}`,
  });
  const settings = [
    `core.hooksPath=${hooksDirectory}`, "core.fsmonitor=false", "core.askPass=", "credential.helper=",
    `credential.${origin}.helper=`, "credential.interactive=false", "push.gpgSign=false", "maintenance.auto=false", "gc.auto=0",
    `http.${origin}.followRedirects=false`, `http.${origin}.sslVerify=true`, "http.extraHeader=", `http.${origin}.extraHeader=`,
  ];
  const args = [...settings.flatMap((setting) => ["-c", setting]), `--config-env=http.${origin}.extraHeader=OKB_SYNC_AUTH_HEADER`];
  return { args, env };
}
