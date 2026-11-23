// Per-install secret for the local API (F-A.6 / 3.1). Any web page can fire
// requests at localhost, so every API/clip request must carry this token —
// CSRF fail-closed. Generated once, stored beside config.json, embedded into
// the bookmarklet by `okb bookmarklet`.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, type Platform } from "./config.ts";

export const DEFAULT_PORT = 6522; // "okb" on a phone keypad
export const DEFAULT_MCP_PORT = 6523;

/** Only a local server's own host names defeat DNS rebinding. */
export function hostAllowed(host: string | null, port: number): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].some((h) => host === `${h}:${port}`);
}

export function serveTokenPath(p?: Platform): string {
  return join(configDir(p), "serve-token");
}

/** Publish the current desktop web address for same-user editor integrations. */
export function publishDesktopAddress(url: string): void {
  const directory = configDir();
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `desktop-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, `${url}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, join(directory, "desktop-url"));
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* temp file may not have been created */ }
    throw error;
  }
}

/** Read the install's serve token, minting (0600) and persisting it on first use. */
export function ensureServeToken(p?: Platform): string {
  const path = serveTokenPath(p);
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t !== "") return t;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(configDir(p), { recursive: true });
  writeFileSync(path, token + "\n", { encoding: "utf8", mode: 0o600 });
  return token;
}

/**
 * Constant-time token comparison (length is public — the token format is).
 * Lengths are compared in bytes, not UTF-16 code units: a multibyte candidate
 * can match the token's string length while differing in byte length, and
 * timingSafeEqual throws rather than returning false on mismatched buffers.
 */
export function tokenMatches(candidate: string | null, token: string): boolean {
  if (candidate === null) return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The credential a bookmarklet carries. A bookmarklet runs inside whatever
 * page it is clicked on, and that page can read the address it opens. So the
 * address holds a token derived from the serve token that `/clip` accepts and
 * no other route does. The serve token itself travels in a request header
 * only, which a foreign page cannot set.
 */
export function clipToken(token: string): string {
  return createHmac("sha256", token).update("okbrain clip bookmarklet v1").digest("base64url");
}

/**
 * The clip bookmarklet: opens a small window on the local clip endpoint —
 * a top-level GET navigation, so no CORS/mixed-content/private-network rules
 * apply from whatever page it runs on. The current selection rides along as
 * the highlight quote. `token` is the install's serve token. The bookmarklet
 * embeds only the clip token derived from it.
 */
export function bookmarkletJs(port: number, token: string): string {
  const js =
    `var q=String(getSelection()).trim();` +
    `window.open('http://127.0.0.1:${port}/clip?token=${clipToken(token)}` +
    `&url='+encodeURIComponent(location.href)+(q?'&quote='+encodeURIComponent(q):''),` +
    `'okb','width=460,height=200');`;
  return `javascript:(function(){${js}})()`;
}
