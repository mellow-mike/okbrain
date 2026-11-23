// Review garnish (F-B.8): an optional AI one-liner per queue item connecting
// it to recently changed notes. Strictly garnish: opt-in per call, one chat
// call for the whole queue, and any failure leaves the deterministic queue
// untouched (the caller catches and warns). Off in the `lean` profile.

import type { ChatMessage, ChatResult } from "../ai/gateway.ts";
import { readConceptPermissive } from "../okf/bundle.ts";
import { fmString } from "../okf/document.ts";
import { isPrivateConcept } from "../okf/privacy.ts";

export interface GarnishNote {
  id: string;
  title: string;
  description: string;
}

const RECENT_DAYS = 7;
const RECENT_CAP = 10;

/** Use the same Markdown snapshot to check privacy and read metadata for the provider. */
export async function describePublicReviewNote(bundle: string, id: string): Promise<GarnishNote | undefined> {
  if (isPrivateConcept(id, {})) return;
  try {
    const { parsed, doc } = await readConceptPermissive(bundle, id);
    if (parsed && !isPrivateConcept(id, doc.frontmatter)) return {
      id, title: fmString(doc.frontmatter.title) || id, description: fmString(doc.frontmatter.description),
    };
  } catch { /* Unavailable notes are never sent to the provider. */ }
}

/** Eligible notes changed within RECENT_DAYS (queue excluded), newest first, capped. */
export async function pickRecent(
  rows: { id: string; timestamp: string | null }[],
  exclude: Set<string>,
  now: Date,
  describe: (id: string) => Promise<GarnishNote | undefined>,
): Promise<GarnishNote[]> {
  const candidates = rows
    .filter(
      (r): r is typeof r & { timestamp: string } =>
        !exclude.has(r.id) &&
        r.timestamp !== null &&
        now.getTime() - Date.parse(r.timestamp) <= RECENT_DAYS * 86_400_000,
    )
    .sort((a, b) => (a.timestamp > b.timestamp ? -1 : a.timestamp < b.timestamp ? 1 : 0));
  const picked: GarnishNote[] = [];
  for (const { id } of candidates) {
    const note = await describe(id);
    if (!note) continue;
    picked.push(note);
    if (picked.length === RECENT_CAP) break;
  }
  return picked;
}

const listing = (notes: GarnishNote[]): string =>
  notes.map((n) => `[${n.id}] ${n.title} — ${n.description}`).join("\n");

/**
 * One chat call → id-keyed one-liners for queue items with a genuine
 * connection to a recent note. No recent activity means nothing to connect,
 * so the model is never called. Unknown ids and "-" (no connection) lines
 * are dropped — the model can only annotate, never invent queue entries.
 */
export async function garnishQueue(
  queue: GarnishNote[],
  recent: GarnishNote[],
  chat: (messages: ChatMessage[]) => Promise<ChatResult>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (queue.length === 0 || recent.length === 0) return out;
  const { text } = await chat([
    {
      role: "user",
      content:
        `Recently changed notes:\n${listing(recent)}\n\n` +
        `Review queue:\n${listing(queue)}\n\n` +
        "For each review-queue concept, if it has a genuine connection to one of the " +
        "recently changed notes, describe it in one line of under 25 words. " +
        "Reply with exactly one line per queue concept, format `id: connection`, " +
        "using `id: -` when there is no real connection. No other text.",
    },
  ]);
  const known = new Set(queue.map((q) => q.id));
  for (const line of text.split("\n")) {
    const m = /^\[?(.+?)\]?\s*:\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const [id, note] = [m[1]!.trim(), m[2]!.trim()];
    if (known.has(id) && note !== "-" && !out.has(id)) out.set(id, note.slice(0, 200));
  }
  return out;
}
