// macOS: bun:sqlite links Apple's SQLite, which refuses loadExtension — so
// sqlite-vec needs a real libsqlite3 swapped in via Database.setCustomSQLite()
// BEFORE the process opens any Database (2.2). Every module that constructs a
// Database calls this first so ordering can't bite. Linux/Windows Bun bundles
// an extension-capable SQLite: no-op there. A miss leaves Apple's SQLite
// active — everything but extension loading (i.e. vector search) still works.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

let done = false;

/** Candidate libraries, `$OKB_SQLITE_LIB` first, then Homebrew/MacPorts. */
const CANDIDATES = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Homebrew, Apple silicon
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib", // Homebrew, Intel
  "/opt/local/lib/libsqlite3.dylib", // MacPorts
];

export function ensureExtensionCapableSqlite(): void {
  if (done || process.platform !== "darwin") return;
  done = true;
  for (const path of [process.env.OKB_SQLITE_LIB, ...CANDIDATES])
    if (path && existsSync(path)) {
      try {
        Database.setCustomSQLite(path);
      } catch {
        // A Database was already opened elsewhere — too late; vector ops
        // will surface the actionable error.
      }
      return;
    }
}
