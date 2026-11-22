import { mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ConfigError, listBrains, loadConfig, saveConfig, type OkbConfig } from "./config.ts";
import { serialize } from "./okf/document.ts";
import { OKF_VERSION } from "./okf/indexmd.ts";
import { PROFILES } from "./retrieval/profiles.ts";

export class BrainMountError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const newName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function mountName(value: unknown): string {
  if (typeof value !== "string" || !newName.test(value.trim()))
    throw new ConfigError("Use 1–64 letters, digits, periods, hyphens, or underscores for the mount name. Start with a letter or digit.");
  return value.trim();
}

function folderPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/u.test(value))
    throw new ConfigError("Enter the absolute path of a local brain folder.");
  const path = value.trim();
  const expanded = path === "~" || /^~[/\\]/.test(path) ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded) || /^[/\\]{2}/.test(expanded) || (process.platform === "win32" && !/^[a-z]:[/\\]/i.test(expanded)))
    throw new ConfigError("Enter the absolute path of a local brain folder.");
  return resolve(expanded);
}

function existingDirectory(path: string): string | undefined {
  try {
    const info = statSync(path);
    if (!info.isDirectory()) throw new BrainMountError("The selected path is a file. Choose a directory.", 409);
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function createIndex(path: string) {
  const title = (basename(path) || "Brain").replace(/[\r\n]/g, " ");
  const index = serialize({
    frontmatter: { okf_version: OKF_VERSION },
    body: `# ${title}\n\nAn Open Knowledge Format bundle.\n`,
  });
  try {
    writeFileSync(join(path, "index.md"), index, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new BrainMountError("This folder already has an index. Register the existing brain.", 409);
    throw error;
  }
}

/** Teach the local registry about one folder. Prior mount and config metadata survive edits. */
export function changeBrainMount(input: Record<string, unknown>): { name: string; removed: boolean } {
  const { action, previous, readonly, retrievalProfile } = input;
  if (action !== "create" && action !== "register" && action !== "update" && action !== "remove")
    throw new ConfigError("Choose create, register, update, or remove.");
  if (action !== "remove" && typeof readonly !== "boolean")
    throw new ConfigError("Choose a mount access policy.");
  if (action !== "remove" && retrievalProfile !== undefined && retrievalProfile !== "" &&
      (typeof retrievalProfile !== "string" || !Object.hasOwn(PROFILES, retrievalProfile)))
    throw new ConfigError("Choose a retrieval profile or use the app default.");
  const cfg = loadConfig();
  if (cfg.brains !== undefined && (!cfg.brains || typeof cfg.brains !== "object" || Array.isArray(cfg.brains)))
    throw new ConfigError("The saved brain mount registry is invalid.");
  const brains: NonNullable<OkbConfig["brains"]> = Object.assign(Object.create(null), cfg.brains);
  if (action === "update" || action === "remove") {
    if (typeof previous !== "string" || !Object.hasOwn(brains, previous))
      throw new BrainMountError("This named mount changed. Refresh the list and try again.", 404);
    const prior = brains[previous]!;
    if (action === "remove") {
      delete brains[previous];
      saveConfig({ ...cfg, brains });
      return { name: previous, removed: true };
    }
    const name = input.name === previous ? previous : mountName(input.name);
    if (name !== previous && Object.hasOwn(brains, name))
      throw new BrainMountError("Another mount already uses this name.", 409);
    delete brains[previous];
    const updated = { ...(typeof prior === "string" ? { path: prior } : prior), readonly: readonly === true };
    if (retrievalProfile === "") delete updated.retrievalProfile;
    else if (typeof retrievalProfile === "string") updated.retrievalProfile = retrievalProfile;
    brains[name] = updated;
    saveConfig({ ...cfg, brains });
    return { name, removed: false };
  }

  const name = mountName(input.name);
  if (Object.hasOwn(brains, name)) throw new BrainMountError("Another mount already uses this name.", 409);
  const path = folderPath(input.path);
  const existing = existingDirectory(path);
  if (action === "register" && !existing)
    throw new BrainMountError("This folder was not found. Create a new brain folder or check the path.", 404);
  for (const mount of listBrains()) {
    let canonical: string | undefined;
    try { canonical = realpathSync(mount.path); } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (mount.path === path || (existing !== undefined && canonical === existing))
      throw new BrainMountError("This folder is already registered as a named mount.", 409);
  }
  if (action === "create") {
    if (!existing) mkdirSync(path, { recursive: true });
    else if (readdirSync(existing).length)
      throw new BrainMountError("This folder contains files. Register the folder to use it as a brain.", 409);
    createIndex(existing ?? path);
  }
  brains[name] = { path: existing ?? realpathSync(path), readonly: readonly === true,
    ...(typeof retrievalProfile === "string" && retrievalProfile ? { retrievalProfile } : {}) };
  saveConfig({ ...cfg, brains });
  return { name, removed: false };
}
