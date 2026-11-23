import type { Context } from "@earendil-works/chord";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, ToolResultEntry, ToolTask, type EntryId, type EntryRecord, type Harness,
  type Storage, type SubmissionRecord, type TaskId } from "@earendil-works/pi-durable";
import { approvedSourceToolName, maxApprovedSourceLookups, maxApprovedSourceLookupLines } from "./approved-source-tool.ts";
import { evaluationInput, type EvaluationInput } from "./evaluation.ts";

export type CodingSourceLookupRange = { path: string; startLine: number; endLine: number };
export type CodingSourceLookupReceipt = {
  served: CodingSourceLookupRange[];
  refused: number;
  incomplete: number;
  truncated?: true;
};

export const maxRecordedSourceLookups = 64;
const maxReceiptEntries = 192;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function approvedSourceLookupRange(value: unknown): CodingSourceLookupRange | undefined {
  if (!record(value)) return;
  const { path, startLine, endLine } = value;
  if (typeof path !== "string" || !path || Buffer.byteLength(path) > 4096 || /[:\\\x00-\x1f\x7f]/u.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")) return;
  if (typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine < 1 ||
      typeof endLine !== "number" || !Number.isSafeInteger(endLine) || endLine > 10_000_000 ||
      endLine < startLine || endLine - startLine >= maxApprovedSourceLookupLines) return;
  return { path, startLine, endLine };
}

function servedRange(
  requested: unknown, result: ToolResultMessage, sources: EvaluationInput["sources"],
): CodingSourceLookupRange | undefined {
  const range = approvedSourceLookupRange(requested);
  const block = result.content[0];
  if (!range || result.content.length !== 1 || block?.type !== "text" || Buffer.byteLength(block.text) > 4096) return;
  const { path, startLine, endLine } = range;
  try {
    const value: unknown = JSON.parse(block.text);
    if (!record(value) || value.path !== path || value.startLine !== startLine || value.endLine !== endLine ||
        typeof value.content !== "string") return;
    const source = sources.find((file) => file && file.path === path && typeof file.content === "string" &&
      Number.isSafeInteger(file.startLine) && Number.isSafeInteger(file.endLine) &&
      startLine >= file.startLine && endLine <= file.endLine);
    if (source && value.content === source.content.split("\n").slice(startLine - source.startLine, endLine - source.startLine + 1).join("\n"))
      return range;
  } catch { /* A legacy or malformed result has no verified range to disclose. */ }
}

type LookupAttempt = { args: unknown; outcome?: "refused" | CodingSourceLookupRange };
type LookupRound = { assistant: EntryId; generation?: TaskId; calls: Map<string, LookupAttempt | null> };

async function matchingLookupResult(
  harness: Harness, entry: EntryRecord, result: ToolResultMessage, round: LookupRound, context: Context,
): Promise<boolean> {
  if (entry.byTaskId === undefined || round.generation === undefined) return false;
  // Pi records the refused result in the generation's own commit when a
  // requested tool was unavailable, without creating a separate tool task.
  if (entry.byTaskId === round.generation) return result.isError;
  const task = await harness.getTask(entry.byTaskId, context);
  if (!task || task.kind !== ToolTask.definition.name || task.conversationId !== entry.conversationId ||
      task.owner !== round.generation || !record(task.input) ||
      task.input.assistant !== round.assistant || task.input.callId !== result.toolCallId ||
      task.state.status !== "terminal") return false;
  const outcome = task.state.outcome;
  if (outcome.status !== "completed" && !(result.isError && outcome.status === "failed")) return false;
  const settled = outcome.result;
  return record(settled) && settled.entryId === entry.id;
}

/** Project the selected completed input's native, immutable tool results without replaying them. */
export async function readApprovedSourceLookupReceipt(
  harness: Harness, storage: Storage, submission: Extract<SubmissionRecord, { type: "input"; status: "done" }>,
  savedInput: string, context: Context,
): Promise<CodingSourceLookupReceipt> {
  const page = await storage.scanEntries({
    conversationId: submission.conversationId, minEntryId: submission.entry, maxEntryId: submission.answer,
  }, maxReceiptEntries, undefined, context);
  let truncated = Boolean(page.next);
  const sources = evaluationInput(savedInput)?.sources ?? [];
  const attempts: LookupAttempt[] = [];
  let round: LookupRound | undefined;
  for (const entry of page.items.slice().reverse()) {
    if (entry.conversationId !== submission.conversationId) continue;
    if (AssistantEntry.is(entry)) {
      const message = entry.model?.[0];
      round = undefined;
      if (message?.role !== "assistant" || message.stopReason !== "toolUse" || entry.id === submission.answer) continue;
      const calls = new Map<string, LookupAttempt | null>();
      const seen = new Set<string>();
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const duplicate = seen.has(block.id);
        if (duplicate) calls.set(block.id, null);
        seen.add(block.id);
        if (block.name !== approvedSourceToolName) continue;
        if (attempts.length === maxRecordedSourceLookups) { truncated = true; continue; }
        const attempt: LookupAttempt = { args: block.arguments };
        attempts.push(attempt);
        if (!duplicate) calls.set(block.id, attempt);
      }
      round = { assistant: entry.id, generation: entry.byTaskId, calls };
    } else if (round && ToolResultEntry.is(entry)) {
      const result = entry.model?.[0];
      if (result?.role !== "toolResult" || result.toolName !== approvedSourceToolName) continue;
      const attempt = round.calls.get(result.toolCallId);
      if (!attempt || attempt.outcome || !await matchingLookupResult(harness, entry, result, round, context)) continue;
      attempt.outcome = result.isError ? "refused" : servedRange(attempt.args, result, sources);
    }
  }
  let refused = 0, incomplete = 0;
  const served: CodingSourceLookupRange[] = [];
  for (const { outcome } of attempts) {
    if (outcome === "refused") refused++;
    else if (!outcome) incomplete++;
    else if (served.length < maxApprovedSourceLookups) served.push(outcome);
    else truncated = true;
  }
  return { served, refused, incomplete, ...(truncated ? { truncated: true } : {}) };
}
