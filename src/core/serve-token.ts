// Per-install secret for the local API (F-A.6 / 3.1). Any web page can fire
// requests at localhost, so every API/clip request must carry this token —
// CSRF fail-closed. Generated once, stored beside config.json, embedded into
// the bookmarklet by `okb bookmarklet`.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Constant-time token comparison (length is public — the token format is). */
export function tokenMatches(candidate: string | null, token: string): boolean {
  if (candidate === null || candidate.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(token, "utf8"));
}

/**
 * The clip bookmarklet: opens a small window on the local clip endpoint —
 * a top-level GET navigation, so no CORS/mixed-content/private-network rules
 * apply from whatever page it runs on. The current selection rides along as
 * the highlight quote.
 */
export function bookmarkletJs(port: number, token: string): string {
  const js =
    `var q=String(getSelection()).trim();` +
    `window.open('http://127.0.0.1:${port}/clip?token=${token}` +
    `&url='+encodeURIComponent(location.href)+(q?'&quote='+encodeURIComponent(q):''),` +
    `'okb','width=460,height=200');`;
  return `javascript:(function(){${js}})()`;
}
