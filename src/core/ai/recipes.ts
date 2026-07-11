// Provider recipes (Stage 2.1): a data table of known providers plus the
// three HTTP dialects they speak. Local servers (Ollama, llama.cpp's
// llama-server, LM Studio) are OpenAI-compatible, so one dialect covers all
// of them and OpenAI/OpenRouter/Voyage too. Plain fetch, no provider SDKs —
// the binary stays light and offline stays first-class.

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

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AiError(
      `request to ${url} failed: ${(e as Error).message} (is the provider running/reachable?)`,
    );
  }
  if (!res.ok)
    throw new AiError(`${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as Record<string, unknown>;
}

const bearer = (apiKey?: string): Record<string, string> =>
  apiKey ? { authorization: `Bearer ${apiKey}` } : {};

const splitSystem = (messages: ChatMessage[]) => ({
  system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"),
  rest: messages.filter((m) => m.role !== "system"),
});

/* eslint-disable @typescript-eslint/no-explicit-any -- provider JSON shapes */
export async function chatCall(
  style: "openai" | "anthropic" | "gemini",
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
): Promise<string> {
  if (style === "anthropic") {
    const { system, rest } = splitSystem(messages);
    const j: any = await post(
      `${baseUrl}/messages`,
      { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
      { model, max_tokens: 4096, ...(system ? { system } : {}), messages: rest },
      timeoutMs,
    );
    return (j.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
  }
  if (style === "gemini") {
    const { system, rest } = splitSystem(messages);
    const contents = rest.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const j: any = await post(
      `${baseUrl}/models/${model}:generateContent`,
      { "x-goog-api-key": apiKey ?? "" },
      {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
      },
      timeoutMs,
    );
    return (
      j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? ""
    );
  }
  const j: any = await post(
    `${baseUrl}/chat/completions`,
    bearer(apiKey),
    { model, messages },
    timeoutMs,
  );
  return j.choices?.[0]?.message?.content ?? "";
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
