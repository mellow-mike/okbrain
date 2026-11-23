import { mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { providersFor } from "./ai/gateway.ts";
import { restoreGitHubBrain } from "./brain-restore.ts";
import { brainAiFields, configDir, ConfigError, dataDir, listBrains, loadConfig, readBrainAiDefaults, resolveBrain, saveConfig, type BrainAiDefaults, type OkbConfig } from "./config.ts";
import { serialize } from "./okf/document.ts";
import { OKF_VERSION } from "./okf/indexmd.ts";
import { PROFILES } from "./retrieval/profiles.ts";
import { sameDir, syncGitHubCredential } from "./sync.ts";

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

function updateAiDefaults(prior: unknown, input: unknown): BrainAiDefaults | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ConfigError("Choose chat and embedding providers and models for this brain.");
  const ai = readBrainAiDefaults(prior) ?? {};
  for (const [field, value] of Object.entries(input)) {
    const setting = brainAiFields.find((key) => key === field);
    if (!setting || typeof value !== "string" || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))
      throw new ConfigError("Brain AI settings accept only provider names and model IDs.");
    const name = value.trim();
    if (!name) { delete ai[setting]; continue; }
    if (setting === "provider" || setting === "embedProvider") {
      const capability = setting === "provider" ? "chat" : "embed";
      const provider = name === "local" ? "ollama" : name;
      if (!providersFor(capability).includes(provider))
        throw new ConfigError(`Choose a supported ${capability === "chat" ? "chat" : "embedding"} provider or use the app default.`);
      ai[setting] = provider;
    } else ai[setting] = name;
  }
  return Object.keys(ai).length ? ai : undefined;
}

/** Teach the local registry about one folder. Prior mount and config metadata survive edits. */
export function changeBrainMount(input: Record<string, unknown>): { name: string; removed: boolean } {
  const { action, previous, readonly, retrievalProfile, ai: aiInput } = input;
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
    if (aiInput !== undefined) {
      const ai = updateAiDefaults(updated.ai, aiInput);
      if (ai) updated.ai = ai;
      else delete updated.ai;
    }
    brains[name] = updated;
    saveConfig({ ...cfg, brains });
    return { name, removed: false };
  }

  const name = mountName(input.name);
  const ai = aiInput === undefined ? undefined : updateAiDefaults(undefined, aiInput);
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
    ...(typeof retrievalProfile === "string" && retrievalProfile ? { retrievalProfile } : {}), ...(ai ? { ai } : {}) };
  saveConfig({ ...cfg, brains });
  return { name, removed: false };
}

const activeRestores = new Set<string>();

function containsFolder(root: string, path: string): boolean {
  const within = relative(existingDirectory(root) ?? root, path);
  return !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`);
}

export async function restoreBrainMount(
  servedBundle: string, input: Record<string, unknown>, allowed: () => boolean,
) {
  const name = mountName(input.name);
  const parent = existingDirectory(folderPath(input.parent));
  if (!parent) throw new BrainMountError("The destination parent folder was not found.", 404);
  const { url, branch, login, token, saveCredential } = input;
  if (typeof url !== "string" || typeof branch !== "string") throw new ConfigError("Enter the GitHub repository URL and branch.");
  if ((login !== undefined && typeof login !== "string") || (token !== undefined && typeof token !== "string"))
    throw new ConfigError("Enter a GitHub login and token as text.");
  const githubLogin = login?.trim() || undefined;
  const githubToken = token?.trim() || undefined;
  if (Boolean(githubLogin) !== Boolean(githubToken))
    throw new ConfigError("Enter both a GitHub login and token for a private repository.");
  if ((saveCredential !== undefined && typeof saveCredential !== "boolean") || (saveCredential && !githubToken))
    throw new ConfigError("Enter a GitHub token before saving it for future sync.");
  if (activeRestores.has(name) || listBrains().some((mount) => mount.name === name))
    throw new BrainMountError("Another mount or restore already uses this name.", 409);

  const canRestore = (): boolean => {
    if (!allowed()) return false;
    const roots = [servedBundle, configDir(), dataDir(), ...listBrains().map(({ path }) => path)];
    if (roots.some((root) => containsFolder(root, parent)))
      throw new BrainMountError("Choose a parent outside your brain folders and okbrain application data.", 409);
    return true;
  };

  activeRestores.add(name);
  try {
    if (!canRestore()) throw new BrainMountError("The selected brain changed or is read-only.", 403);
    const restored = await restoreGitHubBrain({ name, parent, url, branch, login: githubLogin, token: githubToken }, canRestore);
    try {
      if (!canRestore()) throw new BrainMountError("The selected brain changed or is read-only.", 403);
      changeBrainMount({ action: "register", name, path: restored.path, readonly: false });
    } catch (error) {
      const status = error instanceof BrainMountError ? error.status : 409;
      throw new BrainMountError(`The validated checkout is at ${restored.path}. Use Register an existing folder to add it after checking the mount settings.`, status);
    }

    const canUseRestored = () => {
      if (!allowed()) return false;
      const brain = resolveBrain(name);
      return !brain.readonly && sameDir(brain.path, restored.path);
    };
    let credentialSaved = false;
    let warning: string | undefined;
    if (saveCredential) {
      try {
        await syncGitHubCredential(restored.path, { action: "save", login: githubLogin, token: githubToken }, canUseRestored);
        credentialSaved = true;
      } catch {
        warning = "The brain was restored. Save the token under Git sync to use it for future sync.";
      }
    }
    return { ...restored, brain: { name, path: restored.path, readonly: false }, credentialSaved, warning };
  } finally {
    activeRestores.delete(name);
  }
}
