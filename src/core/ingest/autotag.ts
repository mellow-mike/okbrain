// Clip autoTag (F-B.8 / F-A): optional AI topic tags for a clipped article.
// One chat call; suggestions are normalized to kebab-case and pruned so the
// model can only add plausible tags, never reserved workflow tags. Existing
// bundle tags are offered as vocabulary so the tag space doesn't fragment.
// Opt-in (flag or clip.autoTag config) and off in the `lean` profile.

import type { ChatMessage, ChatResult } from "../ai/gateway.ts";

const MAX_AUTO_TAGS = 5;
const EXCERPT_CHARS = 2_000;
/** Workflow tags the model must never assign. */
const RESERVED = new Set(["inbox"]);

const normalize = (raw: string): string =>
  raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");

export async function suggestTags(
  article: { title: string; description: string; markdown: string },
  vocabulary: string[],
  chat: (messages: ChatMessage[]) => Promise<ChatResult>,
): Promise<string[]> {
  const { text } = await chat([
    {
      role: "user",
      content:
        `Suggest up to ${MAX_AUTO_TAGS} topic tags for this article. ` +
        "Prefer reusing existing tags when they fit; invent new ones only when needed. " +
        "Reply with only the tags, comma-separated, lowercase kebab-case, no other text.\n" +
        (vocabulary.length > 0 ? `Existing tags: ${vocabulary.join(", ")}\n` : "") +
        `\nTitle: ${article.title}\nDescription: ${article.description}\n\n` +
        article.markdown.slice(0, EXCERPT_CHARS),
    },
  ]);
  const out: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const tag = normalize(part);
    if (tag !== "" && !RESERVED.has(tag) && !out.includes(tag)) out.push(tag);
    if (out.length === MAX_AUTO_TAGS) break;
  }
  return out;
}
