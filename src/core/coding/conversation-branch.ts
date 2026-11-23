import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  AssistantEntry, defineDocFamily, ROOT_CONVERSATION_ID, type Agent, type ContextView, type Conversation,
  type ConversationId, type EntryId, type EntryRecord, type Harness,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { estimateCodingContext, outboundCodingMessages } from "./history.ts";

export class ConversationBranchError extends Error {}

const rootBranchScope = "okbrain/conversation-branch/v1";
const activeBranchScope = "okbrain/conversation-branch-active/v1";
const branchIdPattern = /^[0-9a-f]{64}$/u;
const maxHistoryEntries = 128;
const maxHistoryBytes = 128 * 1024;

/** The caller holds the physical coding session lease for each operation. */
export type CodingBranchSession = {
  root: Conversation;
  harness: Harness;
  storage: SqliteStorage;
  session: string;
  transcript: string;
};

type HistoryMessage = { role: "system" | "user" | "assistant" | "toolResult"; text: string };
type History = { estimatedTokens: number; activeEntries: number; providerContinuity: boolean; history: HistoryMessage[] };
export type CodingBranchPreview = History & { version: string; branchId: string; requestId: string };
export type CodingBranchReceipt = {
  branchId: string;
  version: string;
  requestId: string;
  conversationId: ConversationId;
  anchor: EntryId;
};

// Pi writes this receipt in the same commit that creates the native lineage.
// The Pi conversation, the current inherited projection, and the branching
// approval can then be checked without consulting a controller or a worktree.
const BranchReceipt = defineDocFamily({
  kind: "okbrain.conversation-branch", family: true, scope: "session", version: 1,
  initial: (_seed: null): {
    requestId: string; anchor: number; conversationId: number; historyHash: string; agentHash: string; instructionsHash: string;
  } => ({ requestId: "", anchor: 0, conversationId: 0, historyHash: "", agentHash: "", instructionsHash: "" }),
});

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function storedBranchError(): ConversationBranchError {
  return new ConversationBranchError("The saved conversation branch could not be verified.");
}

async function requireIdle(harness: Harness): Promise<void> {
  const { tasks, submissions } = await harness.inspect(context);
  // A later submit or wait can schedule the whole physical transcript.
  if (tasks.length || submissions.length)
    throw new ConversationBranchError("Finish, resume, or cancel other work in this session before branching or sending.");
}

function agentHash(agent: Agent): string {
  if (!agent.model || !agent.cwd) throw storedBranchError();
  return digest([agent.cwd, agent.model.provider, agent.model.modelId, agent.thinkingLevel]);
}

function historyHash(view: ContextView): string {
  return digest([view.head?.id ?? null, view.entries.map(({ id }) => id), view.messages]);
}

function previewHistory(view: ContextView): History {
  const tooLarge = () => new ConversationBranchError("The active history is too large to preview. Use a new session or compact the original context before branching.");
  if (view.entries.length > maxHistoryEntries) throw tooLarge();
  const history: HistoryMessage[] = [];
  let providerContinuity = false;
  let total = 0;
  for (const message of outboundCodingMessages(view.messages)) {
    const parts: string[] = [];
    if (typeof message.content === "string") parts.push(message.content);
    else {
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            if (block.textSignature !== undefined) providerContinuity = true;
            parts.push(block.text);
            break;
          case "toolCall":
            if (block.thoughtSignature !== undefined) providerContinuity = true;
            parts.push(`Tool call ${block.namespace ? block.namespace + "." : ""}${block.name}\n${JSON.stringify(block.arguments)}`);
            break;
          case "thinking":
            providerContinuity = true;
            break;
          default:
            throw new ConversationBranchError("The inherited context contains an attachment that this branch preview cannot display.");
        }
      }
    }
    if (message.role === "system") {
      for (const [name, section] of Object.entries(message.sections ?? {}))
        parts.push(section === null ? `Remove system section ${name}` : `System section ${name}\n${section}`);
      for (const added of message.toolsAdded ?? []) parts.push("Tool added\n" + JSON.stringify(added));
      for (const removed of message.toolsRemoved ?? []) parts.push("Tool removed\n" + JSON.stringify(removed));
    }
    if (message.role === "toolResult") parts.unshift("Tool result from " + message.toolName);
    const text = parts.filter((part) => part !== "").join("\n\n");
    if (!text) continue;
    total += Buffer.byteLength(text);
    if (total > maxHistoryBytes) throw tooLarge();
    history.push({ role: message.role, text });
  }
  return { estimatedTokens: estimateCodingContext(view.messages), activeEntries: view.entries.length, providerContinuity, history };
}

function isBranchAnswer(entry: EntryRecord | undefined, conversationId: ConversationId) {
  if (entry?.conversationId !== conversationId || !AssistantEntry.is(entry)) return false;
  const answer = entry.model?.[0];
  return answer?.role === "assistant" && (answer.stopReason === "stop" || answer.stopReason === "length") &&
    answer.content.some((block) => block.type === "text" && Boolean(block.text.trim()));
}

async function selectedTail({ root, storage }: CodingBranchSession, requestId: string): Promise<EntryId> {
  if (root.id !== ROOT_CONVERSATION_ID) throw storedBranchError();
  const saved = await storage.submissionByRequest(root.id, requestId, context);
  if (saved?.type !== "input" || saved.status !== "done" || saved.answer === undefined)
    throw new ConversationBranchError("Choose a completed ordinary request to branch from.");
  const { items: [tail] } = await root.entries({}, 1, undefined, context);
  // A later compaction can retain this answer while hiding older source.
  // Forking through the earlier answer would lose that newer head marker.
  if (tail?.id !== saved.answer || !isBranchAnswer(tail, root.id))
    throw new ConversationBranchError("Branching requires the latest completed answer in the current context.");
  return tail.id;
}

async function previewRoot(session: CodingBranchSession, requestId: string) {
  await requireIdle(session.harness);
  const anchor = await selectedTail(session, requestId);
  const agent = await session.root.agent(context);
  const binding = agentHash(agent);
  const instructions = digest(agent.instructions ?? null);
  const view = await session.root.context(context);
  const history = previewHistory(view);
  const inherited = historyHash(view);
  const info = await lstat(session.transcript, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n) throw storedBranchError();
  const version = digest([rootBranchScope, session.session, String(info.dev), String(info.ino), String(info.birthtimeNs),
    session.root.id, requestId, anchor, binding, instructions, inherited]);
  return { preview: { ...history, requestId, version, branchId: version }, anchor, agent, binding, instructions, inherited };
}

export async function previewConversationBranch(session: CodingBranchSession, requestId: string): Promise<CodingBranchPreview> {
  return (await previewRoot(session, requestId)).preview;
}

async function readBranchProof(session: CodingBranchSession, branchId: string) {
  if (!branchIdPattern.test(branchId) || session.root.id !== ROOT_CONVERSATION_ID) throw storedBranchError();
  const saved = await session.harness.snapshot(BranchReceipt, branchId, context);
  if (!saved) return undefined;
  const { requestId, anchor, conversationId } = saved;
  if (!requestId || !Number.isSafeInteger(anchor) || anchor <= 0 ||
      !Number.isSafeInteger(conversationId) || conversationId <= ROOT_CONVERSATION_ID ||
      !branchIdPattern.test(saved.historyHash) || !branchIdPattern.test(saved.agentHash) ||
      !branchIdPattern.test(saved.instructionsHash)) throw storedBranchError();
  const record = await session.storage.conversation(conversationId as ConversationId, context);
  const parent = await session.storage.submissionByRequest(session.root.id, requestId, context);
  if (!record || record.owner !== undefined || record.parent?.conversationId !== session.root.id || record.parent.at !== anchor ||
      parent?.type !== "input" || parent.status !== "done" || parent.answer !== anchor) throw storedBranchError();
  const receipt: CodingBranchReceipt = { branchId, version: branchId, requestId, conversationId: record.id, anchor: record.parent.at };
  return { receipt, inherited: saved.historyHash, binding: saved.agentHash, instructions: saved.instructionsHash };
}

export async function readConversationBranch(session: CodingBranchSession, branchId: string): Promise<CodingBranchReceipt | undefined> {
  return (await readBranchProof(session, branchId))?.receipt;
}

export async function forkConversationBranch(
  session: CodingBranchSession, requestId: string, version: string, authorize?: () => void,
): Promise<CodingBranchReceipt & { replayed?: true }> {
  if (!branchIdPattern.test(version)) throw new ConversationBranchError("Preview the conversation before creating the branch.");
  const prior = await readConversationBranch(session, version);
  if (prior) {
    if (prior.requestId !== requestId) throw storedBranchError();
    return { ...prior, replayed: true };
  }
  const { preview, anchor, agent, binding, instructions, inherited } = await previewRoot(session, requestId);
  if (preview.version !== version)
    throw new ConversationBranchError("The conversation or model binding changed. Preview the branch again.");
  authorize?.();
  const conversation = await session.root.fork(anchor, {
    ownership: { kind: "ownerless" },
    // The native fork starts from the historical AgentDoc. Apply the
    // reviewed current binding and clear inherited source lookup permission.
    agent: {
      cwd: agent.cwd!, model: agent.model!, thinkingLevel: agent.thinkingLevel,
      instructions: agent.instructions ?? null, extensions: agent.extensions, tools: [],
    },
    init: async (tx, conversationId) => {
      const saved = await tx.doc(BranchReceipt, version, null);
      saved.requestId = requestId;
      saved.anchor = anchor;
      saved.conversationId = conversationId;
      saved.historyHash = inherited;
      saved.agentHash = binding;
      saved.instructionsHash = instructions;
    },
  }, context);
  return { branchId: version, version, requestId, anchor, conversationId: conversation.id };
}

async function hasOwnInput(storage: SqliteStorage, conversationId: ConversationId): Promise<boolean> {
  let cursor;
  do {
    const page = await storage.scanSubmissions({ conversationId }, 64, cursor, context);
    if (page.items.some(({ type }) => type === "input")) return true;
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}

async function branchState(session: CodingBranchSession, branchId: string) {
  await requireIdle(session.harness);
  const proof = await readBranchProof(session, branchId);
  if (!proof) throw storedBranchError();
  const { receipt, inherited, binding, instructions } = proof;
  const conversation = await session.harness.conversation(receipt.conversationId, context);
  if (!conversation) throw storedBranchError();
  const agent = await conversation.agent(context);
  const bound = agentHash(agent);
  if (bound !== binding) throw storedBranchError();
  const view = await conversation.context(context);
  const firstAdmission = !await hasOwnInput(session.storage, receipt.conversationId);
  const hash = historyHash(view);
  const currentInstructions = digest(agent.instructions ?? null);
  if (firstAdmission && (hash !== inherited || currentInstructions !== instructions)) throw storedBranchError();
  const version = firstAdmission ? receipt.version : digest([activeBranchScope, receipt.branchId, bound, currentInstructions, hash]);
  return { receipt, conversation, firstAdmission, version, view };
}

export async function previewConversationBranchAdmission(session: CodingBranchSession, branchId: string): Promise<CodingBranchPreview> {
  const { receipt, version, view } = await branchState(session, branchId);
  return { ...previewHistory(view), version, branchId, requestId: receipt.requestId };
}

export async function verifyConversationBranchAdmission(session: CodingBranchSession, branchId: string, expectedVersion?: string) {
  const { view, ...result } = await branchState(session, branchId);
  if (expectedVersion !== undefined && expectedVersion !== result.version)
    throw new ConversationBranchError("The branch context changed. Preview it again before sending.");
  previewHistory(view);
  return result;
}
