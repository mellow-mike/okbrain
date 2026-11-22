// log.md maintenance (Stage 1.2): append an entry under a `## YYYY-MM-DD`
// heading in the root log.md, keeping date sections newest-first (per the
// conformance checklist). Dates are UTC, matching `generated.at`.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { markdownOutsideCode } from "../graph/links.ts";

export type LogKind = "Creation" | "Update" | "Deprecation" | "Deletion";

/** Emitted date format for log headings. */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Append one prose entry under today's date section (created if needed). */
export async function appendLogEntry(root: string, entry: string, date = todayUtc()): Promise<void> {
  const path = join(root, "log.md");
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

/** Append a `**Kind**: [Title](/id.md) — summary` entry. */
export function appendLog(
  root: string,
  kind: LogKind,
  id: string,
  title: string,
  summary = "",
): Promise<void> {
  return appendLogEntry(root, formatLogEntry(kind, id, title, summary));
}
