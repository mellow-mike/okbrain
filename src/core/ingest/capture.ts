// Quick capture (Stage 1.3): turn a snippet of text into a conformant concept
// under `inbox/` with zero required metadata — title/description are derived
// from the first line, the id from the date + title, colliding ids get a
// numeric suffix. Captures carry the `inbox` tag (the reading inbox is the
// tag, not the directory), so `okb inbox` and the review queue see them
// until they are triaged. Routes through the conformance writer like every
// write.

import { existsSync } from "node:fs";
import { idToAbsPath, slugify } from "../okf/paths.ts";
import { nowTimestamp, OkfWriteError, writeConcept, type WriteResult } from "../okf/write.ts";

export interface CaptureInput {
  text: string;
  title?: string;
  tags?: string[];
  /** `generated.by` for the note (default: the configured local actor). */
  actor?: string;
}

/** Clip to `max` chars on a word-ish boundary, marking truncation with `…`. */
export const clip = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";

export async function captureNote(root: string, input: CaptureInput): Promise<WriteResult> {
  const text = input.text.replace(/\r\n?/g, "\n").trim();
  const firstLine = text.split("\n")[0]?.replace(/^#+\s*/, "").trim() ?? "";
  if (firstLine === "") throw new OkfWriteError("nothing to capture: empty text");
  const title = input.title ?? clip(firstLine, 80);
  const base = `inbox/${nowTimestamp().slice(0, 10)}-${slugify(title)}`;
  let id = base;
  for (let n = 2; existsSync(idToAbsPath(root, id)); n++) id = `${base}-${n}`;
  return writeConcept(root, {
    id,
    type: "note",
    title,
    description: clip(firstLine, 120),
    body: text,
    tags: [...new Set([...(input.tags ?? []), "inbox"])],
    actor: input.actor,
  });
}
