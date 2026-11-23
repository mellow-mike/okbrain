// log.md maintenance (Stage 1.2): append an entry under a `## YYYY-MM-DD`
// heading in the root log.md, keeping date sections newest-first (per the
// conformance checklist). Dates are UTC, matching `generated.at`.

import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { markdownOutsideCode } from "../graph/links.ts";
import { walkMarkdownFiles } from "./bundle.ts";
import { inDbOnlyDir, InvalidIdError, validateId } from "./paths.ts";

export type LogKind = "Creation" | "Update" | "Deprecation" | "Deletion";
export interface ConceptLogEntry { id: string; entry: string; date: string }
export class LogFolderError extends Error {}

/** Emitted date format for log headings. */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Append one prose entry under today's date section (created if needed). */
const pendingWrites = new Map<string, Promise<void>>();

export async function appendLogEntry(directory: string, entry: string, date = todayUtc()): Promise<void> {
  const path = join(directory, "log.md");
  const previous = pendingWrites.get(path);
  const write = (previous?.catch(() => {}) ?? Promise.resolve()).then(() => appendDateSection(path, entry, date));
  pendingWrites.set(path, write);
  try { await write; }
  finally { if (pendingWrites.get(path) === write) pendingWrites.delete(path); }
}

async function appendDateSection(path: string, entry: string, date: string): Promise<void> {
  // A link in the log's place would send the entry to another file on this computer (B23).
  if ((await lstatIfPresent(path))?.isFile() === false)
    throw new InvalidIdError("log.md is not a regular file in this brain. okbrain does not follow links or open special files.");
  let text: string;
  try {
    text = (await readFile(path, "utf8")).replace(/\r\n?/g, "\n");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    text = "# Log\n";
  }

  const headings = [...markdownOutsideCode(text).matchAll(/^##[ \t]+/gm)].map((match) => match.index);
  const pre = text.slice(0, headings[0] ?? text.length).trimEnd();
  const sections = headings.map((start, index) => text.slice(start, headings[index + 1]).trimEnd());

  const head = `## ${date}`;
  const sectionDate = (part: string) => /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*(?:\n|$)/.exec(part)?.[1];
  const section = sections.findIndex((part) => sectionDate(part) === date);
  if (section >= 0) sections[section] += `\n\n${entry}`;
  else {
    // A batch can finish after UTC midnight while another writer already has today's heading.
    const later = sections.findLastIndex((part) => (sectionDate(part) ?? "") > date);
    sections.splice(later + 1, 0, `${head}\n\n${entry}`);
  }

  await writeFile(path, (pre ? pre + "\n\n" : "") + sections.join("\n\n") + "\n", "utf8");
}

export function formatLogEntry(kind: LogKind, id: string, title: string, summary = ""): string {
  return `**${kind}**: [${title}](/${id}.md)${summary ? ` — ${summary}` : ""}`;
}

/** Remove generated entries for newly local notes while preserving manually written log prose. */
export async function removePrivateLogEntries(root: string, ids: ReadonlySet<string>): Promise<void> {
  if (ids.size === 0) return;
  for await (const path of walkMarkdownFiles(root)) {
    if (posix.basename(path) !== "log.md" || inDbOnlyDir(path.toLowerCase())) continue;
    const file = join(root, ...path.split("/"));
    const content = await readFile(file, "utf8");
    const visible = markdownOutsideCode(content).split(/(?<=\n)/);
    const filtered = content.split(/(?<=\n)/).filter((line, index) => {
      if (!/^\*\*(?:Creation|Update|Deprecation|Deletion)\*\*: /.test(visible[index] ?? "")) return true;
      return ![...line.matchAll(/\]\(\/(.+?)\.md\)/g)].some((match) => ids.has(match[1]!));
    }).join("");
    if (filtered !== content) await writeFile(file, filtered, "utf8");
  }
}

async function lstatIfPresent(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Create a portable change log in an existing public folder. */
export async function createDirectoryLog(root: string, folder: string): Promise<{ folder: string; created: boolean }> {
  const name = folder.trim().replace(/\/$/, "");
  validateId(name);
  const parts = name.split("/");
  if (inDbOnlyDir(`${name.toLowerCase()}/log`) || parts.some((part) => part.startsWith(".") || part === "node_modules"))
    throw new LogFolderError("Choose a public folder inside the brain.");
  let directory = root;
  for (const part of parts) {
    directory = join(directory, part);
    if (!(await lstatIfPresent(directory))?.isDirectory())
      throw new LogFolderError("Choose an existing folder inside the brain.");
  }
  const path = join(directory, "log.md");
  try { await writeFile(path, "# Log\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lstatIfPresent(path))?.isFile()) throw new LogFolderError("log.md must be a regular file in the selected folder.");
    return { folder: name, created: false };
  }
  return { folder: name, created: true };
}

/** Keep the root log and any enabled ancestor logs current for public changes. */
export async function appendConceptLogs(root: string, entries: Iterable<ConceptLogEntry>): Promise<void> {
  const logsForParent = new Map<string, string[]>();
  const pending = new Map<string, Map<string, string[]>>();
  for (const { id, entry, date } of entries) {
    if (inDbOnlyDir(id.toLowerCase())) continue;
    const parent = posix.dirname(id);
    let targets = logsForParent.get(parent);
    if (!targets) {
      targets = [root];
      let directory = root;
      for (const part of parent === "." ? [] : parent.split("/")) {
        directory = join(directory, part);
        if (!(await lstatIfPresent(directory))?.isDirectory()) break;
        if ((await lstatIfPresent(join(directory, "log.md")))?.isFile()) targets.push(directory);
      }
      logsForParent.set(parent, targets);
    }
    for (const directory of targets) {
      const dates = pending.get(directory) ?? new Map<string, string[]>();
      const changes = dates.get(date) ?? [];
      changes.push(entry);
      dates.set(date, changes);
      pending.set(directory, dates);
    }
  }
  for (const [directory, dates] of pending) {
    for (const [date, changes] of dates) await appendLogEntry(directory, changes.join("\n\n"), date);
  }
}

/** Append a `**Kind**: [Title](/id.md) — summary` entry. */
export function appendLog(
  root: string,
  kind: LogKind,
  id: string,
  title: string,
  summary = "",
): Promise<void> {
  return appendConceptLogs(root, [{ id, entry: formatLogEntry(kind, id, title, summary), date: todayUtc() }]);
}
