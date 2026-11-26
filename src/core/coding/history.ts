import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { CompactionTask, defineExtension, hook, type CompactionPolicy } from "@earendil-works/pi-durable";
import { approvedSourceToolName } from "./approved-source-tool.ts";
import { withOpenRouterPreferences, type OpenRouterPreferences } from "./router.ts";

export const contextBudgetError = "The saved coding context exceeds the active token budget. Start a new session or submit a smaller request.";

export interface CodingBudget {
  limitTokens: number;
  modelWindowTokens: number;
  maxOutputTokens: number;
}

export function codingBudget(model: Model<Api>): CodingBudget {
  const modelWindowTokens = model.contextWindow;
  const modelOutputLimit = model.maxTokens > 0 ? model.maxTokens : 8192;
  const maxOutputTokens = Math.min(8192, modelOutputLimit, Math.max(1, Math.floor(modelWindowTokens / 4)));
  const safetyTokens = Math.min(4096, Math.max(1, Math.floor(modelWindowTokens / 8)));
  const limitTokens = Math.min(32_768, Math.max(1, modelWindowTokens - maxOutputTokens - safetyTokens));
  return { limitTokens, modelWindowTokens, maxOutputTokens };
}

export function compactionPolicy(budget: CodingBudget): CompactionPolicy {
  const { limitTokens, modelWindowTokens } = budget;
  return {
    enabled: true,
    reserveTokens: modelWindowTokens - limitTokens + Math.min(512, Math.floor(limitTokens / 8)),
    keepRecentTokens: Math.max(1, Math.floor(limitTokens / 3)),
    backgroundTokens: 0,
  };
}

function estimateOutboundTokens(messages: readonly Message[]): number {
  // Pi uses measured usage including the previous assistant output, which is now part of the input.
  // A changed prefix may invalidate a prior measurement, so estimate the visible messages too.
  const visibleTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return Math.max(visibleTokens, estimateContextTokens(messages).tokens);
}

export function estimateCodingContext(messages: readonly Message[]): number {
  return estimateOutboundTokens(outboundCodingMessages(messages));
}

export function newRequestFits(content: string, instructions: string, budget: CodingBudget): boolean {
  // Leave room for the system message, compacted history, and provider message framing.
  const overhead = Math.min(1024, Math.floor(budget.limitTokens / 4));
  return estimateTextTokens(outboundContent(content)) + estimateTextTokens(instructions) + overhead <= budget.limitTokens;
}

function requestPreview(message: Message): string | undefined {
  if (message.role === "assistant") {
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
    return text ? `Prior review excerpt: ${text.slice(0, 180)}` : undefined;
  }
  if (message.role !== "user" || typeof message.content !== "string") return undefined;
  // The coding host writes a JSON envelope. Keep a task excerpt and source references only.
  try {
    const request = JSON.parse(message.content) as {
      task?: string;
      files?: { path: string }[];
      excerpts?: { path: string; startLine: number; endLine: number }[];
    };
    if (typeof request.task !== "string") return undefined;
    const sources = request.excerpts?.map(({ path, startLine, endLine }) => `${path}:${startLine}-${endLine}`)
      ?? request.files?.map(({ path }) => path) ?? [];
    return `Prior task excerpt: ${request.task.trim().slice(0, 160)}${sources.length ? `\nSources: ${sources.join(", ").slice(0, 240)}` : ""}`;
  } catch {
    return undefined;
  }
}

export function codingHistory(budget: CodingBudget | undefined) {
  return defineExtension({
    name: "okbrain-coding-history",
    hooks: [hook(CompactionTask, {
      beforeCompact({ messages }) {
        // Use Pi's durable context marker without a separate provider call or old source bodies.
        const maxChars = Math.min(2048, budget?.limitTokens ?? 2048);
        const previews = messages.slice(-8).map(requestPreview).filter((preview) => preview !== undefined).join("\n\n");
        return { summary: `Older coding turns are retained locally. These excerpts are historical and may omit details. Ask for fresh source when needed.\n\n${previews.slice(-maxChars)}` };
      },
    })],
  });
}

/**
 * A saved request as the provider receives it. The local manifest stays here,
 * and an approved excerpt marked `deferred` is sent as a pointer: its text
 * leaves this computer only if the model looks it up.
 */
export function outboundContent(content: string): string {
  if (!content.includes('"repositoryContext":')) return content;
  try {
    const { repositoryContext, ...request } = JSON.parse(content);
    if (!repositoryContext) return content;
    if (Array.isArray(request.excerpts)) {
      request.excerpts = request.excerpts.map((excerpt: { deferred?: unknown; path?: unknown; startLine?: unknown; endLine?: unknown }) =>
        excerpt?.deferred === true ? { path: excerpt.path, startLine: excerpt.startLine, endLine: excerpt.endLine, deferred: true } : excerpt);
    }
    return JSON.stringify(request);
  } catch {
    return content;
  }
}

export function outboundCodingMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content !== "string") return message;
    const content = outboundContent(message.content);
    return content === message.content ? message : { ...message, content };
  });
}

const noUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function blockedRequest(model: Model<Api>, errorMessage: string) {
  const stream = createAssistantMessageEventStream();
  stream.end({
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), content: [], usage: noUsage, stopReason: "error", errorMessage,
  });
  return stream;
}

/** Settings that apply to every provider request of the run in progress. Set before the run is scheduled. */
export interface RequestRouting { openRouter?: OpenRouterPreferences }

export function budgetedModels(models: Models, sessionBudget: CodingBudget, sessionId: string, routing: RequestRouting = {}): Models {
  const streamSimple: Models["streamSimple"] = (requested, context, options) => {
    let model = requested;
    try { model = withOpenRouterPreferences(requested, routing.openRouter); }
    catch (error) { return blockedRequest(requested, (error as Error).message); }
    // A routed child conversation may use a model with a different window than the session's.
    const budget = model.contextWindow > 0 ? codingBudget(model) : sessionBudget;
    const messages = outboundCodingMessages(context.messages);
    const toolRounds = getCurrentTools(messages).some(({ name }) => name === approvedSourceToolName)
      ? messages.slice(messages.findLastIndex(({ role }) => role === "user") + 1).filter((message) =>
        message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.name === approvedSourceToolName)).length
      : 0;
    if (toolRounds > 1)
      return blockedRequest(model, "The model requested additional lookups after its approved lookup round.");
    // Durable's beforeRequest hooks are fail-soft. Enforce the budget at the provider boundary,
    // including on replay from a checkpoint already in its request phase.
    if (estimateOutboundTokens(messages) <= budget.limitTokens) {
      return models.streamSimple(model, { ...context, messages }, {
        ...options,
        ...(toolRounds ? { toolChoice: "none" } : {}),
        // Preserve provider affinity across harness openings, scoped to this transcript.
        sessionId,
        maxTokens: Math.min(options?.maxTokens ?? budget.maxOutputTokens, budget.maxOutputTokens),
      });
    }
    return blockedRequest(model, contextBudgetError);
  };
  // Pi calls completeSimple for the default summarizer. An older checkpoint can
  // already be in that phase, past the hook that now builds summaries locally.
  const completeSimple: Models["completeSimple"] = (model) =>
    blockedRequest(model, "Coding session summaries are built locally.").result();
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      if (property === "completeSimple") return completeSimple;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
