// Cross-platform resolution of config/data directories, the persisted user
// config (config.json, written by `okb init`), and the active bundle.
// Centralized per CLAUDE.md: XDG on Linux/macOS, %APPDATA%/%LOCALAPPDATA% on
// Windows. All path work goes through node:path; nothing here hardcodes a
// separator. Pure given an injected Platform, so it is fully testable.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ReviewConfig } from "./review/score.ts";

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

export class ConfigError extends Error {}

/** AI provider settings persisted by `okb init` (resolution: core/ai/gateway.ts). */
export interface AiSettings {
  provider?: string;
  model?: string;
  baseUrl?: string;
  embedProvider?: string;
  embedModel?: string;
  embedBaseUrl?: string;
  rerankProvider?: string;
  rerankModel?: string;
}

export interface OkbConfig {
  /** Bundle used when neither --bundle nor $OKB_BUNDLE is given. */
  defaultBundle?: string;
  ai?: AiSettings;
  review?: {
    cooldownDays?: number;
    queueSize?: number;
    weights?: Partial<ReviewConfig["weights"]>;
  };
  clip?: {
    maxBodyBytes?: number;
    defaultTags?: string[];
    /** Extra query-param names stripped during URL normalization. */
    stripParams?: string[];
  };
  retrieval?: {
    /** Default profile: lean | balanced | max (core/retrieval/profiles.ts). */
    profile?: string;
  };
  /** Unknown keys are preserved on rewrite (permissive, like the OKF reader). */
  [key: string]: unknown;
}

export function configFilePath(p: Platform = currentPlatform()): string {
  return join(configDir(p), "config.json");
}

/** Read config.json: {} when absent, ConfigError on unparseable JSON. */
export function loadConfig(p: Platform = currentPlatform()): OkbConfig {
  let raw: string;
  try {
    raw = readFileSync(configFilePath(p), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  try {
    return JSON.parse(raw) as OkbConfig;
  } catch (e) {
    throw new ConfigError(
      `cannot parse ${configFilePath(p)}: ${(e as Error).message} — fix or delete it`,
    );
  }
}

/** Write config.json (pretty, LF) and return its path. */
export function saveConfig(cfg: OkbConfig, p: Platform = currentPlatform()): string {
  const path = configFilePath(p);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return path;
}

/**
 * Resolve the active bundle root, in priority order:
 *   explicit argument → $OKB_BUNDLE → config defaultBundle (okb init) → cwd.
 * Returns an absolute, normalized path.
 */
export function resolveBundlePath(
  explicit?: string,
  p: Platform = currentPlatform(),
): string {
  const candidate = explicit ?? p.env.OKB_BUNDLE ?? loadConfig(p).defaultBundle ?? p.cwd;
  return isAbsolute(candidate) ? resolve(candidate) : resolve(p.cwd, candidate);
}
