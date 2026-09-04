// Cross-platform resolution of config/data directories, the persisted user
// config (config.json, written by `okb init`), and the active bundle.
// Centralized per CLAUDE.md: XDG on Linux/macOS, %APPDATA%/%LOCALAPPDATA% on
// Windows. All path work goes through node:path; nothing here hardcodes a
// separator. Pure given an injected Platform, so it is fully testable.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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

function currentPlatform(): Platform {
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
  /**
   * Who local writes are attributed to (`generated.by` / `verified[].by`),
   * in the OKF actor convention — `human:<id>` for a person. Default:
   * `human:<os user>`.
   */
  actor?: string;
  ai?: AiSettings;
  review?: {
    cooldownDays?: number;
    queueSize?: number;
    weights?: Partial<ReviewConfig["weights"]>;
  };
  /** Local API + GUI (`okb serve`). */
  serve?: {
    /** Open the GUI in the default browser on start (also `--open`). */
    open?: boolean;
  };
  clip?: {
    maxBodyBytes?: number;
    defaultTags?: string[];
    /** Extra query-param names stripped during URL normalization. */
    stripParams?: string[];
    /** Suggest topic tags via the chat model on every clip (AI extra). */
    autoTag?: boolean;
  };
  retrieval?: {
    /** Default profile: lean | balanced | max (core/retrieval/profiles.ts). */
    profile?: string;
  };
  rss?: {
    /** Feeds `okb rss` pulls when called without a URL (also the jobs worker). */
    feeds?: string[];
    /** Max new items written per feed pull (default 10). */
    maxItems?: number;
  };
  /**
   * Named bundle mounts (Stage 5): `okb --brain work …`. A string is the
   * bundle path; the object form adds a per-brain access policy.
   */
  brains?: Record<string, string | { path: string; readonly?: boolean }>;
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
 * The actor local (trusted) writes are attributed to: config `actor`, else
 * `human:<os user>`. The `human:` prefix is what trust tiers key off (§7).
 */
export function resolveActor(cfg: OkbConfig = loadConfig()): string {
  if (typeof cfg.actor === "string" && cfg.actor.trim() !== "") return cfg.actor.trim();
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    /* no passwd entry (some containers) — fall through */
  }
  return `human:${(user || process.env.USER || process.env.USERNAME || "user").replace(/\s+/g, "-")}`;
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

export interface BrainMount {
  name: string;
  path: string;
  readonly: boolean;
}

/** Every configured brain mount, normalized; paths expand a leading `~`. */
export function listBrains(p: Platform = currentPlatform()): BrainMount[] {
  const brains = loadConfig(p).brains ?? {};
  return Object.entries(brains).map(([name, v]) => {
    const raw = typeof v === "string" ? v : v.path;
    const expanded = raw === "~" || raw.startsWith("~/") ? join(p.home, raw.slice(2)) : raw;
    if (!isAbsolute(expanded))
      throw new ConfigError(`brain ${name}: path must be absolute (got ${raw})`);
    return { name, path: resolve(expanded), readonly: typeof v !== "string" && v.readonly === true };
  });
}

/** Resolve one named mount (`okb --brain <name>`); unknown names list what exists. */
export function resolveBrain(name: string, p: Platform = currentPlatform()): BrainMount {
  const brains = listBrains(p);
  const brain = brains.find((b) => b.name === name);
  if (!brain)
    throw new ConfigError(
      brains.length === 0
        ? `no brains configured — add a "brains" map to config.json (okb help brains)`
        : `unknown brain: ${name} (configured: ${brains.map((b) => b.name).join(", ")})`,
    );
  return brain;
}
