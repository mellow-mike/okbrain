// Clip autoTag (F-B.8 / F-A): optional AI topic tags for a clipped article.
// One chat call; suggestions are normalized to kebab-case and pruned so the
// model can only add plausible tags, never reserved workflow tags. Existing
// public bundle tags are offered as vocabulary to encourage reuse.
// Opt-in (flag or clip.autoTag config) and off in the `lean` profile.

import type { ChatMessage, ChatResult } from "../ai/gateway.ts";
import { readConceptPermissive } from "../okf/bundle.ts";
import { fmTags } from "../okf/document.ts";
import { checkPrivacyPath, isPrivateConcept } from "../okf/privacy.ts";

const MAX_AUTO_TAGS = 5;
const EXCERPT_CHARS = 2_000;
const MAX_VOCABULARY_TAGS = 64;
const MAX_VOCABULARY_CHARS = 2_048;
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

/** Verify current privacy and read tag vocabulary from that same Markdown snapshot. */
export async function publicTagVocabulary(bundle: string, indexedIds: readonly string[]): Promise<string[]> {
  const tags = new Set<string>();
  let length = 0;
  for (const id of indexedIds) {
    if (isPrivateConcept(id, {})) continue;
    try {
      await checkPrivacyPath(bundle, id);
      const { parsed, doc } = await readConceptPermissive(bundle, id);
      if (!parsed || isPrivateConcept(id, doc.frontmatter)) continue;
      for (const raw of fmTags(doc.frontmatter.tags)) {
        const tag = normalize(raw);
        const nextLength = length + tag.length + (tags.size ? 2 : 0);
        if (!tag || RESERVED.has(tag) || tags.has(tag) || nextLength > MAX_VOCABULARY_CHARS) continue;
        tags.add(tag);
        length = nextLength;
        if (tags.size === MAX_VOCABULARY_TAGS || length + 3 > MAX_VOCABULARY_CHARS) return [...tags].sort();
      }
    } catch { /* Stale or unavailable index entries cannot supply provider vocabulary. */ }
  }
  return [...tags].sort();
}

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
