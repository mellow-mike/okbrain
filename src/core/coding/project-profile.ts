/** A repository profile is inert configuration until an operator previews it. */
export interface CodingProjectProfile {
  version: 1;
  name: string;
  projects: string[];
  sharedProjects?: string[];
  exclude?: string[];
  guidance?: string;
  tokenBudget?: number;
}

export class CodingProjectProfileError extends Error {}

export const maxProfileProjects = 8;
export const maxProfileTokens = 16384;
const maxProfileBytes = 8192;
const maxGuidanceBytes = 1024;

export function profilePath(path: string): string | undefined {
  const portable = path.trim().replaceAll("\\", "/");
  if (!portable || portable.startsWith("/") || /[:\x00-\x1f\x7f]/u.test(portable)) return;
  const parts = portable.split("/");
  if (parts.includes("..")) return;
  return parts.filter((part) => part && part !== ".").join("/") || ".";
}

function pathList(value: unknown, name: string, limit: number, required = false): string[] | undefined {
  if (value === undefined && !required) return;
  if (!Array.isArray(value) || value.length > limit || (required && value.length === 0)) {
    throw new CodingProjectProfileError(`Profile ${name} must contain ${required ? "1" : "0"}–${limit} workspace-relative paths.`);
  }
  const paths = new Set<string>();
  for (const entry of value) {
    const path = typeof entry === "string" && Buffer.byteLength(entry) <= 512 ? profilePath(entry) : undefined;
    if (!path || (name === "exclude" && path === ".")) {
      throw new CodingProjectProfileError(`Profile ${name} must contain workspace-relative paths.`);
    }
    paths.add(path);
  }
  return [...paths].sort();
}

export function validateCodingProjectProfile(value: unknown): CodingProjectProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodingProjectProfileError("Provide a coding project profile object.");
  }
  const { version, name, projects: rawProjects, sharedProjects: rawShared, exclude: rawExclude, guidance, tokenBudget } = value as Record<string, unknown>;
  if (version !== 1) throw new CodingProjectProfileError("Use coding project profile version 1.");
  if (typeof name !== "string" || !name.trim() || Buffer.byteLength(name) > 120 || /[\x00-\x1f\x7f]/u.test(name)) {
    throw new CodingProjectProfileError("Give the coding project profile a short name.");
  }
  if (guidance !== undefined && (typeof guidance !== "string" || Buffer.byteLength(guidance) > maxGuidanceBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(guidance))) {
    throw new CodingProjectProfileError(`Keep profile guidance to ${maxGuidanceBytes} UTF-8 bytes of text.`);
  }
  if (tokenBudget !== undefined && (typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > maxProfileTokens)) {
    throw new CodingProjectProfileError(`Choose a whole profile token budget from 1 to ${maxProfileTokens}.`);
  }
  const projects = pathList(rawProjects, "projects", maxProfileProjects, true)!;
  const sharedProjects = pathList(rawShared, "sharedProjects", maxProfileProjects);
  const exclude = pathList(rawExclude, "exclude", 32);
  if (new Set([...projects, ...(sharedProjects ?? [])]).size > maxProfileProjects) {
    throw new CodingProjectProfileError(`Choose at most ${maxProfileProjects} project and shared directories in total.`);
  }
  const profile = {
    version, name: name.trim(), projects,
    ...(sharedProjects?.length ? { sharedProjects } : {}),
    ...(exclude?.length ? { exclude } : {}),
    ...(guidance?.trim() ? { guidance: guidance.trim() } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  } satisfies CodingProjectProfile;
  if (Buffer.byteLength(JSON.stringify(profile)) > maxProfileBytes) throw new CodingProjectProfileError("Keep the coding project profile within 8192 UTF-8 bytes.");
  return profile;
}

export function parseCodingProjectProfile(text: string): CodingProjectProfile {
  if (Buffer.byteLength(text) > maxProfileBytes) throw new CodingProjectProfileError("Keep the coding project profile within 8192 UTF-8 bytes.");
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    throw new CodingProjectProfileError("Enter a valid JSON coding project profile.");
  }
  return validateCodingProjectProfile(value);
}
