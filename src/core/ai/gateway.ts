// Provider-agnostic AI gateway (CLAUDE.md invariant 6): one interface for
// embed / chat / rerank, resolved per call as
//   per-call override → env (OKB_*) → named brain → app config → detection.
// Detection is API-first when a key is present; with no keys everything runs
// against a local server (Ollama et al.) — fully offline is first-class.
// Nothing above this file may talk to a provider directly.

import { brainAiDefaults, type AiSettings } from "../config.ts";
import { gatewayEnvironment } from "./local-keys.ts";
import {
  AiError,
  chatCall,
  embedCall,
  RECIPES,
  rerankCall,
  type ChatMessage,
  type ChatProgress,
  type Recipe,
} from "./recipes.ts";

export { AiError, RECIPES, type ChatMessage, type ChatProgress };

export type Capability = "chat" | "embed" | "rerank";

export interface AiOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ResolvedCall {
  provider: string;
  recipe: Recipe;
  model: string;
  baseUrl: string;
  apiKey?: string;
  /** Env var a missing key would come from (report/error text). */
  apiKeyEnv?: string;
}

type Env = Record<string, string | undefined>;

/** `local` is an alias for the most common local server. */
const alias = (name?: string): string | undefined => (name === "local" ? "ollama" : name);

export const providersFor = (cap: Capability): string[] =>
  Object.keys(RECIPES).filter((n) => RECIPES[n]![cap] !== undefined);

/** First capability-bearing provider a present API key points at, else local. */
export function detectProvider(cap: Capability, env: Env): string {
  const order = ["anthropic", "openai", "gemini", "openrouter", "voyage"].filter(
    (n) => RECIPES[n]![cap] !== undefined,
  );
  for (const name of order)
    if (env[RECIPES[name]!.apiKeyEnv!]) return name;
  // No keys: local when it can serve the capability; else the sole API option
  // (rerank → voyage), whose missing-key error names the env var to set.
  return RECIPES.ollama![cap] !== undefined ? "ollama" : order[order.length - 1]!;
}

/** Pure resolution — no network, never checks key presence (call sites do). */
export function resolveCall(
  cap: Capability,
  settings: AiSettings,
  env: Env,
  opts: AiOptions = {},
): ResolvedCall {
  // The generic provider (env OKB_AI_PROVIDER / config `provider`) only wins a
  // capability it actually has — anthropic as chat provider must not hijack embed.
  const capable = (name?: string): string | undefined => {
    const n = alias(name);
    return n && RECIPES[n]?.[cap] ? n : undefined;
  };
  const fromSettings =
    cap === "chat"
      ? settings.provider
      : cap === "embed"
        ? (settings.embedProvider ?? capable(settings.provider))
        : settings.rerankProvider;
  const brain = settings[brainAiDefaults];
  const brainProvider = alias(cap === "chat" ? brain?.provider : cap === "embed" ? brain?.embedProvider : undefined);
  const configProvider = alias(fromSettings);
  const envPrefix = `OKB_${cap.toUpperCase()}_`;
  const envProvider = alias(env[`${envPrefix}PROVIDER`]) ?? capable(env.OKB_AI_PROVIDER);
  const globalProvider = configProvider ?? detectProvider(cap, env);
  const provider =
    alias(opts.provider) ??
    envProvider ??
    brainProvider ??
    globalProvider;

  const recipe = Object.hasOwn(RECIPES, provider) ? RECIPES[provider] : undefined;
  if (!recipe)
    throw new AiError(`unknown AI provider: ${provider} (known: ${Object.keys(RECIPES).join(", ")})`);
  const spec = recipe[cap];
  if (!spec)
    throw new AiError(`provider ${provider} has no ${cap} support (try: ${providersFor(cap).join(", ")})`);

  const brainModel = cap === "chat" ? brain?.model : cap === "embed" ? brain?.embedModel : undefined;
  const configModel = cap === "chat" ? settings.model : cap === "embed" ? settings.embedModel : settings.rerankModel;
  const model =
    opts.model ??
    env[`${envPrefix}MODEL`] ??
    (brainProvider === undefined || brainProvider === provider ? brainModel : undefined) ??
    (globalProvider === provider ? configModel : undefined) ??
    spec.defaultModel;

  // An explicit environment URL belongs to the environment's provider or the
  // provider the app would resolve without a mount. An unbound config URL can
  // still serve the default local engine without forwarding an inferred key.
  const envEndpointProvider = envProvider ?? globalProvider;
  const configEndpointProvider = configProvider ?? "ollama";
  const configUrl = cap === "chat" ? settings.baseUrl : cap === "embed" ? settings.embedBaseUrl : undefined;
  const baseUrl =
    opts.baseUrl ??
    (envEndpointProvider === provider ? env[`${envPrefix}BASE_URL`] : undefined) ??
    (configEndpointProvider === provider ? configUrl : undefined) ??
    spec.baseUrl;
  return {
    provider,
    recipe,
    model,
    baseUrl,
    apiKey: opts.apiKey ?? (recipe.apiKeyEnv ? env[recipe.apiKeyEnv] : undefined),
    apiKeyEnv: recipe.apiKeyEnv,
  };
}

function requireKey(r: ResolvedCall): void {
  if (r.recipe.kind === "api" && !r.apiKey)
    throw new AiError(
      `provider ${r.provider} needs an API key in Settings or in ${r.apiKeyEnv} (or choose a local provider)`,
    );
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
}
export interface EmbedResult {
  vectors: number[][];
  dim: number;
  provider: string;
  model: string;
}
export interface RerankResult {
  /** Best-first document indices with scores. */
  ranked: { index: number; score: number }[];
  provider: string;
  model: string;
}

export interface Gateway {
  chat(messages: ChatMessage[], opts?: AiOptions, progress?: ChatProgress): Promise<ChatResult>;
  embed(texts: string[], opts?: AiOptions): Promise<EmbedResult>;
  rerank(query: string, documents: string[], opts?: AiOptions): Promise<RerankResult>;
}

export function createGateway(settings: AiSettings = {}, env: Env = gatewayEnvironment()): Gateway {
  return {
    async chat(messages, opts, progress) {
      const r = resolveCall("chat", settings, env, opts);
      requireKey(r);
      const text = await chatCall(r.recipe.chat!.style, r.baseUrl, r.apiKey, r.model, messages, 120_000, progress);
      return { text, provider: r.provider, model: r.model };
    },
    async embed(texts, opts) {
      const r = resolveCall("embed", settings, env, opts);
      requireKey(r);
      const vectors = await embedCall(r.recipe.embed!.style, r.baseUrl, r.apiKey, r.model, texts, 60_000);
      if (vectors.length !== texts.length)
        throw new AiError(
          `${r.provider} returned ${vectors.length} embeddings for ${texts.length} inputs`,
        );
      return { vectors, dim: vectors[0]?.length ?? 0, provider: r.provider, model: r.model };
    },
    async rerank(query, documents, opts) {
      const r = resolveCall("rerank", settings, env, opts);
      requireKey(r);
      const ranked = await rerankCall(r.baseUrl, r.apiKey, r.model, query, documents, 30_000);
      ranked.sort((a, b) => b.score - a.score || a.index - b.index);
      return { ranked, provider: r.provider, model: r.model };
    },
  };
}
