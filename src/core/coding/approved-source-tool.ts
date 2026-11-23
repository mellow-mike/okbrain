import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, LiveDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { evaluationInput } from "./evaluation.ts";

export const approvedSourceToolName = "lookup_approved_source";
export const maxApprovedSourceLookups = 4;
export const maxApprovedSourceLookupLines = 24;

export function approvedSourceLookupEnabled(content: string | undefined): boolean {
  if (content === undefined) return false;
  try { return JSON.parse(content)?.approvedSourceLookup === true; }
  catch { return false; }
}

export function approvedSourceTool(readInput: (conversation: ConversationId, id: SubmissionId, context: Context) => Promise<string | undefined>) {
  const lookup = defineTool({
    name: approvedSourceToolName,
    description: "Read up to 24 consecutive lines already approved for this request. Use the exact workspace-relative path and inclusive line numbers from the supplied source. The range must be inside a single approved file or excerpt.",
    replay: "safe",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 512 }),
      startLine: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
      endLine: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    }, { additionalProperties: false }),
    async execute({ path, startLine, endLine }, api, context) {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const inputs = live?.run?.inputs;
      const saved = inputs?.length === 1 ? await readInput(api.conversationId, inputs[0]!, context) : undefined;
      if (!saved || !approvedSourceLookupEnabled(saved))
        throw new Error("Approved source lookup is unavailable for this request.");
      if (!live?.tools?.slice(0, maxApprovedSourceLookups).some(({ callId }) => callId === api.callId))
        throw new Error("The lookup round supports up to four approved ranges.");
      if (endLine < startLine || endLine - startLine >= maxApprovedSourceLookupLines)
        throw new Error("Choose an inclusive range of up to 24 approved lines.");
      const source = evaluationInput(saved)?.sources.find((entry) =>
        entry.path === path && startLine >= entry.startLine && endLine <= entry.endLine);
      if (!source) throw new Error("That range is outside this request's approved source.");
      const excerpt = source.content.split("\n").slice(startLine - source.startLine, endLine - source.startLine + 1).join("\n");
      const result = JSON.stringify({ path, startLine, endLine, content: excerpt });
      if (Buffer.byteLength(result) > 4096) throw new Error("Choose fewer approved lines to fit the lookup output limit.");
      return { content: [{ type: "text", text: result }] };
    },
  });
  return { lookup, extension: defineExtension({ name: "okbrain-approved-source", tools: [lookup] }) };
}
