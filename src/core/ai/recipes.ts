// Provider recipes (Stage 2.1): a data table of known providers plus the
// three HTTP dialects they speak. Local servers (Ollama, llama.cpp's
// llama-server, LM Studio) are OpenAI-compatible, so one dialect covers all
// of them and OpenAI/OpenRouter/Voyage too. Plain fetch, no provider SDKs —
// the binary stays light and offline stays first-class.

import { EventSourceParserStream } from "eventsource-parser/stream";

export class AiError extends Error {}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Recipe {
  kind: "local" | "api";
  /** Env var holding the key (api kind only). */
  apiKeyEnv?: string;
  chat?: { baseUrl: string; defaultModel: string; style: "openai" | "anthropic" | "gemini" };
  embed?: { baseUrl: string; defaultModel: string; style: "openai" | "gemini" };
  rerank?: { baseUrl: string; defaultModel: string };
}

const OLLAMA = "http://127.0.0.1:11434/v1";
const LLAMACPP = "http://127.0.0.1:8080/v1";
const LMSTUDIO = "http://127.0.0.1:1234/v1";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

export const RECIPES: Record<string, Recipe> = {
  ollama: {
    kind: "local",
    chat: { baseUrl: OLLAMA, defaultModel: "llama3.2", style: "openai" },
    embed: { baseUrl: OLLAMA, defaultModel: "nomic-embed-text", style: "openai" },
  },
  llamacpp: {
    kind: "local",
    // llama-server serves whatever model it was started with; the name is informational.
    chat: { baseUrl: LLAMACPP, defaultModel: "loaded", style: "openai" },
    embed: { baseUrl: LLAMACPP, defaultModel: "loaded", style: "openai" },
  },
  lmstudio: {
    kind: "local",
    chat: { baseUrl: LMSTUDIO, defaultModel: "loaded", style: "openai" },
    embed: { baseUrl: LMSTUDIO, defaultModel: "loaded", style: "openai" },
  },
  openai: {
    kind: "api",
    apiKeyEnv: "OPENAI_API_KEY",
    chat: { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", style: "openai" },
    embed: { baseUrl: "https://api.openai.com/v1", defaultModel: "text-embedding-3-small", style: "openai" },
  },
  anthropic: {
    kind: "api",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    chat: { baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-5", style: "anthropic" },
  },
  gemini: {
    kind: "api",
    apiKeyEnv: "GEMINI_API_KEY",
    chat: { baseUrl: GEMINI, defaultModel: "gemini-2.5-flash", style: "gemini" },
    embed: { baseUrl: GEMINI, defaultModel: "text-embedding-004", style: "gemini" },
  },
  openrouter: {
    kind: "api",
    apiKeyEnv: "OPENROUTER_API_KEY",
    chat: { baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto", style: "openai" },
  },
  voyage: {
    kind: "api",
    apiKeyEnv: "VOYAGE_API_KEY",
    embed: { baseUrl: "https://api.voyageai.com/v1", defaultModel: "voyage-3", style: "openai" },
    rerank: { baseUrl: "https://api.voyageai.com/v1", defaultModel: "rerank-2" },
  },
};

async function postResponse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  let res: Response;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    throw new AiError(
      `request to ${url} failed: ${(e as Error).message} (is the provider running/reachable?)`,
    );
  }
  if (!res.ok) {
    let message = await res.text();
    for (const secret of [headers.authorization?.replace(/^Bearer /, ""), headers["x-api-key"], headers["x-goog-api-key"]])
      if (secret) message = message.replaceAll(secret, "[redacted]");
    throw new AiError(`${url} → HTTP ${res.status}: ${message.slice(0, 300)}`);
  }
  return res;
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  return (await postResponse(url, headers, body, timeoutMs)).json() as Promise<Record<string, unknown>>;
}

const bearer = (apiKey?: string): Record<string, string> =>
  apiKey ? { authorization: `Bearer ${apiKey}` } : {};

const splitSystem = (messages: ChatMessage[]) => ({
  system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"),
  rest: messages.filter((m) => m.role !== "system"),
});

export interface ChatProgress {
  onDelta?(text: string): void;
  signal?: AbortSignal;
}

type ChatStyle = NonNullable<Recipe["chat"]>["style"];

function chatRequest(style: ChatStyle, baseUrl: string, apiKey: string | undefined, model: string,
  messages: ChatMessage[], streaming: boolean): { url: string; headers: Record<string, string>; body: unknown } {
  const { system, rest } = splitSystem(messages);
  if (style === "anthropic") return {
    url: `${baseUrl}/messages`,
    headers: { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
    body: { model, max_tokens: 4096, ...(system ? { system } : {}), messages: rest, ...(streaming ? { stream: true } : {}) },
  };
  if (style === "gemini") return {
    url: `${baseUrl}/models/${model}:${streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    headers: { "x-goog-api-key": apiKey ?? "" },
    body: {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: rest.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    },
  };
  return {
    url: `${baseUrl}/chat/completions`,
    headers: bearer(apiKey),
    body: { model, messages, ...(streaming ? { stream: true } : {}) },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- provider JSON shapes */
function geminiText(candidate: any): string {
  return (candidate?.content?.parts ?? [])
    .filter((part: any) => part.thought !== true && typeof part.text === "string")
    .map((part: any) => part.text).join("");
}

function completeText(style: ChatStyle, value: any): string {
  if (style === "anthropic") return (value.content ?? [])
    .filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
  if (style === "gemini") return value.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("") ?? "";
  return value.choices?.[0]?.message?.content ?? "";
}

function eventText(style: ChatStyle, data: string, event?: string): { delta?: string; complete?: boolean } {
  if (style === "openai" && data === "[DONE]") return { complete: true };
  const frame = JSON.parse(data);
  if (event === "error" || frame.type === "error" || frame.error) throw new AiError("The model provider reported a streaming error.");
  if (style === "anthropic") return {
    complete: frame.type === "message_stop",
    delta: frame.type === "content_block_delta" && frame.delta?.type === "text_delta" ? frame.delta.text : undefined,
  };
  if (style === "gemini") {
    const candidate = frame.candidates?.[0];
    if (!candidate && frame.promptFeedback?.blockReason) throw new AiError("The model provider declined this request.");
    return { delta: geminiText(candidate), complete: Boolean(candidate?.finishReason) };
  }
  const choice = frame.choices?.[0];
  return { delta: choice?.delta?.content, complete: Boolean(choice?.finish_reason) };
}

const MAX_CHAT_TEXT = 2_000_000;

async function streamText(style: ChatStyle, response: Response, onDelta: (text: string) => void): Promise<string> {
  if (!response.body) throw new AiError("The model provider returned an empty response stream.");
  const events = response.body.pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ maxBufferSize: MAX_CHAT_TEXT }));
  let text = "";
  try {
    for await (const { data, event } of events) {
      const { delta, complete } = eventText(style, data, event);
      if (typeof delta === "string" && delta.length) {
        if (text.length + delta.length > MAX_CHAT_TEXT) throw new AiError("The answer exceeded the local text limit.");
        text += delta;
        onDelta(delta);
      }
      if (complete) return text;
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError("The model response stream was interrupted.");
  }
  throw new AiError("The model response stream ended before completion.");
}

export async function chatCall(
  style: ChatStyle,
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
  progress?: ChatProgress,
): Promise<string> {
  const { url, headers, body } = chatRequest(style, baseUrl, apiKey, model, messages, Boolean(progress?.onDelta));
  const response = await postResponse(url, headers, body, timeoutMs, progress?.signal);
  if (progress?.onDelta && response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream")
    return streamText(style, response, progress.onDelta);
  // Some compatible local servers answer with ordinary JSON despite stream:true.
  return completeText(style, await response.json());
}

export async function embedCall(
  style: "openai" | "gemini",
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  texts: string[],
  timeoutMs: number,
): Promise<number[][]> {
  if (style === "gemini") {
    const j: any = await post(
      `${baseUrl}/models/${model}:batchEmbedContents`,
      { "x-goog-api-key": apiKey ?? "" },
      {
        requests: texts.map((t) => ({
          model: `models/${model}`,
          content: { parts: [{ text: t }] },
        })),
      },
      timeoutMs,
    );
    return (j.embeddings ?? []).map((e: any) => e.values as number[]);
  }
  const j: any = await post(
    `${baseUrl}/embeddings`,
    bearer(apiKey),
    { model, input: texts },
    timeoutMs,
  );
  return (j.data ?? []).map((d: any) => d.embedding as number[]);
}

export async function rerankCall(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  query: string,
  documents: string[],
  timeoutMs: number,
): Promise<{ index: number; score: number }[]> {
  const j: any = await post(
    `${baseUrl}/rerank`,
    bearer(apiKey),
    { model, query, documents },
    timeoutMs,
  );
  return (j.data ?? []).map((d: any) => ({
    index: d.index as number,
    score: d.relevance_score as number,
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
