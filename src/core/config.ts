// Cross-platform resolution of config/data directories and the active bundle.
// Centralized per CLAUDE.md: XDG on Linux/macOS, %APPDATA%/%LOCALAPPDATA% on
// Windows. All path work goes through node:path; nothing here hardcodes a
// separator. Pure given an injected Platform, so it is fully testable.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const APP_NAME = "okbrain";

/** The ambient inputs config resolution depends on; injectable for tests. */
export interface Platform {
  os: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
}

export function currentPlatform(): Platform {
  return {
    os: process.platform,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
  };
}

/** Per-user config directory for okbrain (settings live here). */
export function configDir(p: Platform = currentPlatform()): string {
  if (p.os === "win32") {
    const base = p.env.APPDATA ?? join(p.home, "AppData", "Roaming");
    return join(base, APP_NAME);
  }
  const base = p.env.XDG_CONFIG_HOME ?? join(p.home, ".config");
  return join(base, APP_NAME);
}

/** Per-user data directory for okbrain (caches, default bundle home). */
export function dataDir(p: Platform = currentPlatform()): string {
  if (p.os === "win32") {
    const base = p.env.LOCALAPPDATA ?? join(p.home, "AppData", "Local");
    return join(base, APP_NAME);
  }
  const base = p.env.XDG_DATA_HOME ?? join(p.home, ".local", "share");
  return join(base, APP_NAME);
}

/**
 * Resolve the active bundle root, in priority order:
 *   explicit argument  →  $OKB_BUNDLE  →  current working directory.
 * Returns an absolute, normalized path. `okb init` (Stage 1) will persist a
 * default into config; until then cwd is the convention (run okb in your brain).
 */
export function resolveBundlePath(
  explicit?: string,
  p: Platform = currentPlatform(),
): string {
  const candidate = explicit ?? p.env.OKB_BUNDLE ?? p.cwd;
  return isAbsolute(candidate) ? resolve(candidate) : resolve(p.cwd, candidate);
}
