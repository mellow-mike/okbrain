// `okb ask` (2.3): retrieval-augmented answering with verified citations.
// Retrieval is the hybrid pipeline; the synthesis prompt confines the model
// to the packed concepts, and citations in the answer are post-verified
// against the ids actually provided — an id the model invented is dropped
// from `citations`, never presented as a source. An empty pool short-circuits
// before the model: asking with nothing to cite only invites fabrication.

import type { ChatMessage, ChatResult } from "../ai/gateway.ts";
import { readConceptPermissive } from "../okf/bundle.ts";
import { MAX_CHUNK_CHARS } from "./chunk.ts";
import { hybridRetrieve, type HybridArms, type HybridHit } from "./hybrid.ts";
import type { RetrievalProfile } from "./profiles.ts";

export interface AskDeps {
  bundle: string;
  arms: HybridArms;
  chat(messages: ChatMessage[]): Promise<ChatResult>;
  /** Optional rerank of the pool (caller owns gating and failure policy). */
  rerank?(query: string, hits: HybridHit[]): Promise<HybridHit[]>;
  /** Called with the packed context before synthesis (streaming surfaces). */
  onContext?(context: Citation[]): void;
}

export interface Citation {
  id: string;
  title: string;
}

export interface AskResult {
  answer: string;
  /** Concept ids the answer cites, verified against the packed context. */
  citations: Citation[];
  /** What was packed into the prompt (context transparency). */
  context: Citation[];
  profile: string;
  /** null when no model was called (empty retrieval pool). */
  provider: string | null;
  model: string | null;
  vectorSkipped: string | null;
}

const SYNTH_SYSTEM =
  "You answer questions from the user's personal knowledge base. Use ONLY the " +
  "concepts provided; after each claim, cite the id of the concept supporting " +
  "it in square brackets, e.g. [notes/foo]. If the concepts do not answer the " +
  "question, say so plainly. Never invent facts, sources, or concept ids.";

/** Chat-generated alternative phrasings (`max` profile); failures just narrow recall. */
async function queryVariants(
  question: string,
  n: number,
  chat: AskDeps["chat"],
): Promise<string[]> {
  try {
    const { text } = await chat([
      {
        role: "user",
        content: `Give ${n} alternative short phrasings of this search query, one per line, nothing else:\n${question}`,
      },
    ]);
    return text
      .split("\n")
      .map((l) => l.replace(/^[\s\d.)*-]+/, "").trim())
      .filter((l) => l !== "")
      .slice(0, n);
  } catch {
    return []; // a real chat failure surfaces at synthesis
  }
}

/** Pack hits (score order) into `[id] title\ntext` blocks under the budget; always ≥1. */
export async function packContext(
  bundle: string,
  hits: HybridHit[],
  budgetChars: number,
): Promise<{ blocks: string[]; packed: HybridHit[] }> {
  const blocks: string[] = [];
  const packed: HybridHit[] = [];
  let size = 0;
  for (const h of hits) {
    let text = h.snippet;
    if (text === undefined)
      try {
        const body = (await readConceptPermissive(bundle, h.id)).doc.body.trim();
        text = (body === "" ? h.description : body).slice(0, MAX_CHUNK_CHARS);
      } catch {
        text = h.description; // index knows an id the bundle no longer has
      }
    const block = `[${h.id}] ${h.title}\n${text}`;
    if (packed.length > 0 && size + block.length > budgetChars) break;
    blocks.push(block);
    packed.push(h);
    size += block.length + 2;
  }
  return { blocks, packed };
}

/** Ids cited in the answer, in order of first appearance, verified against `packed`. */
export function extractCitations(answer: string, packed: HybridHit[]): Citation[] {
  const known = new Map(packed.map((h) => [h.id, h.title]));
  const out: Citation[] = [];
  for (const m of answer.matchAll(/\[([^\][\n]+)\]/g)) {
    const id = m[1]!.trim();
    if (known.has(id) && !out.some((c) => c.id === id)) out.push({ id, title: known.get(id)! });
  }
  return out;
}

export async function askBrain(
  question: string,
  deps: AskDeps,
  profile: RetrievalProfile,
): Promise<AskResult> {
  const queries = [
    question,
    ...(profile.multiQuery > 0 ? await queryVariants(question, profile.multiQuery, deps.chat) : []),
  ];
  const { hits, vectorSkipped } = await hybridRetrieve(queries, deps.arms, profile, profile.vecK);
  const base = { profile: profile.name, vectorSkipped };
  if (hits.length === 0)
    return {
      ...base,
      answer: "No relevant concepts found in the brain — try `okb search`, or add notes first.",
      citations: [],
      context: [],
      provider: null,
      model: null,
    };

  const pool = deps.rerank ? await deps.rerank(question, hits) : hits;
  const { blocks, packed } = await packContext(deps.bundle, pool, profile.budgetChars);
  deps.onContext?.(packed.map(({ id, title }) => ({ id, title })));
  const { text, provider, model } = await deps.chat([
    { role: "system", content: SYNTH_SYSTEM },
    { role: "user", content: `Concepts:\n\n${blocks.join("\n\n")}\n\nQuestion: ${question}` },
  ]);
  return {
    ...base,
    answer: text,
    citations: extractCitations(text, packed),
    context: packed.map(({ id, title }) => ({ id, title })),
    provider,
    model,
  };
}
