// log.md maintenance (Stage 1.2): append an entry under a `## YYYY-MM-DD`
// heading in the root log.md, keeping date sections newest-first (per the
// conformance checklist). Dates are UTC, matching `generated.at`.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type LogKind = "Creation" | "Update" | "Deprecation" | "Deletion";

/** Emitted date format for log headings. */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Append one prose entry under today's date section (created if needed). */
export async function appendLogEntry(root: string, entry: string): Promise<void> {
  const path = join(root, "log.md");
  let text: string;
  try {
    text = (await readFile(path, "utf8")).replace(/\r\n?/g, "\n");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    text = "# Log\n";
  }

  const today = todayUtc();
  const at = text.search(/^## /m);
  const pre = (at === -1 ? text : text.slice(0, at)).replace(/\s+$/, "");
  const sections =
    at === -1
      ? []
      : text.slice(at).split(/^(?=## )/m).map((s) => s.replace(/\s+$/, ""));

  const head = `## ${today}`;
  if (sections[0] === head || sections[0]?.startsWith(head + "\n"))
    sections[0] += `\n\n${entry}`; // same day: append to the existing section
  else sections.unshift(`${head}\n\n${entry}`); // new day goes first (newest-first)

  await writeFile(path, (pre ? pre + "\n\n" : "") + sections.join("\n\n") + "\n", "utf8");
}

/** Append a `**Kind**: [Title](/id.md) — summary` entry. */
export function appendLog(
  root: string,
  kind: LogKind,
  id: string,
  title: string,
  summary = "",
): Promise<void> {
  return appendLogEntry(root, `**${kind}**: [${title}](/${id}.md)${summary ? ` — ${summary}` : ""}`);
}
