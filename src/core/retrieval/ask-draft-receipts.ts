import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AskResult, Citation } from "./ask.ts";

const receiptLifetime = 30 * 60_000;
const maxDraftBytes = 512 * 1024;
export const maxAskDraftRequestBytes = maxDraftBytes + 4096;
const receiptPattern = /^v1\.([a-f0-9]{32})\.(\d{13})\.([a-zA-Z0-9_-]{43})$/u;

type DraftContent = { question: string; answer: string; provider: string; model: string; citations: Citation[] };
type Receipt = { id: string; issued: number };
type SavedDraft = { id: string; created: boolean };

export class AskDraftReceiptError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentOf(value: Record<string, unknown>): DraftContent | undefined {
  const { question, answer, provider, model, citations } = value;
  if (typeof question !== "string" || !question.trim() || question.length > 8000 ||
      typeof answer !== "string" || !answer.trim() || answer.length > maxDraftBytes ||
      typeof provider !== "string" || !provider.trim() || provider.length > 256 ||
      typeof model !== "string" || !model.trim() || model.length > 256 ||
      !Array.isArray(citations) || citations.length > 64) return;
  const sources: Citation[] = [];
  for (const citation of citations) {
    if (!record(citation) || typeof citation.id !== "string" || typeof citation.title !== "string" ||
        Object.keys(citation).length !== 2 || !citation.id || citation.id.length > 4096 || citation.title.length > 4096) return;
    sources.push({ id: citation.id, title: citation.title });
  }
  const content = { question, answer, provider, model, citations: sources };
  if (Buffer.byteLength(JSON.stringify(content)) <= maxDraftBytes) return content;
}

const expired = () => new AskDraftReceiptError("This draft approval is no longer available. Ask again before saving.", 409);

/** Authenticate exactly the completed answer shown in the app without storing its text again. */
export class AskDraftReceipts {
  readonly #key = randomBytes(32);
  readonly #issued = new WeakMap<AskResult, Receipt>();
  readonly #saved = new Map<string, number>();
  readonly #writing = new Map<string, Promise<SavedDraft>>();

  #signature({ id, issued }: Receipt, brain: string, content: DraftContent): string {
    return createHmac("sha256", this.#key).update(JSON.stringify(["v1", id, issued, brain, content])).digest("base64url");
  }

  issue(brain: string, question: string, result: AskResult): string | undefined {
    const content = contentOf({ ...result, question });
    if (!content) return;
    let receipt = this.#issued.get(result);
    if (!receipt) {
      receipt = { id: randomBytes(16).toString("hex"), issued: Date.now() };
      this.#issued.set(result, receipt);
    }
    if (Date.now() >= receipt.issued + receiptLifetime) return;
    return `v1.${receipt.id}.${receipt.issued}.${this.#signature(receipt, brain, content)}`;
  }

  async save(
    body: unknown, brain: string,
    write: (draft: DraftContent & { receiptId: string; generatedAt: string; mustExist: boolean }) => Promise<SavedDraft>,
  ): Promise<SavedDraft> {
    if (!record(body) || Object.keys(body).length !== 6 || typeof body.receipt !== "string")
      throw new AskDraftReceiptError("Send the completed answer with its draft approval.", 400);
    const match = receiptPattern.exec(body.receipt);
    const content = contentOf(body);
    if (!match || !content) throw expired();
    const receipt = { id: match[1]!, issued: Number(match[2]) };
    const now = Date.now();
    if (receipt.issued > now || now >= receipt.issued + receiptLifetime ||
        !timingSafeEqual(Buffer.from(match[3]!), Buffer.from(this.#signature(receipt, brain, content)))) throw expired();
    for (const [id, until] of this.#saved) if (now >= until) this.#saved.delete(id);
    const pending = this.#writing.get(receipt.id);
    if (pending) return { id: (await pending).id, created: false };
    const saving = write({ ...content, receiptId: receipt.id, generatedAt: new Date(receipt.issued).toISOString(),
      mustExist: this.#saved.has(receipt.id) });
    this.#writing.set(receipt.id, saving);
    try {
      const saved = await saving;
      this.#saved.set(receipt.id, receipt.issued + receiptLifetime);
      return saved;
    } finally { this.#writing.delete(receipt.id); }
  }
}
