import type { CodingProvider } from "./durable.ts";

const endpoints = {
  openai: "https://api.openai.com/v1/models/",
  anthropic: "https://api.anthropic.com/v1/models/",
  google: "https://generativelanguage.googleapis.com/v1beta/models/",
} as const satisfies Record<CodingProvider, string>;
const deadlineMs = 8000;
const maxResponseBytes = 64 * 1024;
const codes = [
  "ready", "denied", "model-unavailable", "rate-limited", "redirected", "unreachable", "timed-out", "invalid-response", "provider-error",
] as const;

export interface ProviderCheckInput {
  provider: CodingProvider;
  model: string;
  apiKey: string;
}

export interface ProviderCheckOutcome {
  code: typeof codes[number];
  httpStatus?: number;
}

function statusCode(status: number): ProviderCheckOutcome["code"] {
  if (status === 200) return "ready";
  if (status >= 200 && status < 300) return "invalid-response";
  if (status >= 300 && status < 400) return "redirected";
  if (status === 401 || status === 403) return "denied";
  if (status === 404 || status === 410) return "model-unavailable";
  if (status === 429) return "rate-limited";
  return "provider-error";
}

/** Validate data from the worker before returning it to the control plane. */
export function parseProviderCheckOutcome(value: unknown): ProviderCheckOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => key !== "code" && key !== "httpStatus")) return;
  const code = codes.find((candidate) => candidate === row.code);
  if (!code) return;
  const { httpStatus } = row;
  if (httpStatus === undefined) return { code };
  if (typeof httpStatus !== "number" || !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 599) return;
  if (statusCode(httpStatus) !== code && !(httpStatus === 200 && code === "invalid-response")) return;
  return { code, httpStatus };
}

function authHeaders(provider: CodingProvider, key: string): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (provider === "google") headers.set("x-goog-api-key", key);
  else if (provider === "openai") headers.set("authorization", `Bearer ${key}`);
  else {
    // Match the pinned Pi Anthropic SDK's API key versus OAuth header selection.
    headers.set("anthropic-version", "2023-06-01");
    if (key.includes("sk-ant-oat")) headers.set("authorization", `Bearer ${key}`);
    else headers.set("x-api-key", key);
  }
  return headers;
}

function discard(body: Pick<ReadableStream<Uint8Array>, "cancel"> | null | undefined): void {
  void body?.cancel().catch(() => {});
}

async function modelMetadata(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxResponseBytes) {
    discard(response.body);
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  const cancel = () => discard(reader);
  signal.addEventListener("abort", cancel, { once: true });
  const bytes = Buffer.alloc(maxResponseBytes);
  let length = 0;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      if (value.byteLength > bytes.length - length) return;
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch { /* A stream or JSON error is never part of the outcome. */ }
  finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function matchesModel(provider: CodingProvider, model: string, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (provider === "openai") return row.object === "model" && row.id === model;
  if (provider === "google") return row.name === `models/${model}`;
  if (row.type !== "model" || typeof row.id !== "string") return false;
  // Claude 4.5 also has short aliases that resolve to a dated snapshot of the same model.
  return row.id === model || (model.endsWith("-4-5") && row.id.startsWith(`${model}-`)
    && /^\d{8}$/u.test(row.id.slice(model.length + 1)) && row.id.length === model.length + 9);
}

async function check(
  provider: CodingProvider, model: string, endpoint: URL, headers: Headers, signal: AbortSignal, transport: typeof fetch,
): Promise<ProviderCheckOutcome> {
  let response: Response;
  try {
    response = await transport(endpoint, {
      method: "GET", headers, redirect: "manual", cache: "no-store", credentials: "omit", proxy: false, keepalive: false, signal,
    });
  } catch { return { code: "unreachable" }; }
  if (!(response instanceof Response)) return { code: "invalid-response" };
  if (signal.aborted || response.redirected || response.type === "opaqueredirect" ||
      (response.url && response.url !== endpoint.href) || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    discard(response.body);
    return { code: response.redirected || response.type === "opaqueredirect" ? "redirected" : "invalid-response" };
  }
  const httpStatus = response.status;
  const code = statusCode(httpStatus);
  if (code !== "ready") {
    discard(response.body);
    return { code, httpStatus };
  }
  const metadata = await modelMetadata(response, signal).catch(() => undefined);
  return { code: matchesModel(provider, model, metadata) ? "ready" : "invalid-response", httpStatus };
}

/** Make one fixed-origin model metadata request. The outcome contains no provider data. */
export async function checkProviderModel(
  input: ProviderCheckInput, signal: AbortSignal, transport: typeof fetch = fetch,
): Promise<ProviderCheckOutcome> {
  const { provider, model } = input;
  if (!Object.hasOwn(endpoints, provider) || typeof model !== "string" || model.length > 128 ||
      !/^[a-zA-Z0-9]/u.test(model) || /[^a-zA-Z0-9._:-]/u.test(model)) return { code: "model-unavailable" };
  const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!key || key.length > 4096 || /[^!-~]/u.test(key)) return { code: "denied" };
  if (signal.aborted) return { code: "unreachable" };
  const deadline = AbortSignal.timeout(deadlineMs);
  const bounded = AbortSignal.any([signal, deadline]);
  const endpoint = new URL(endpoints[provider] + encodeURIComponent(model));
  const { promise, resolve } = Promise.withResolvers<ProviderCheckOutcome>();
  const cancel = () => resolve({ code: deadline.aborted ? "timed-out" : "unreachable" });
  bounded.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([promise, check(provider, model, endpoint, authHeaders(provider, key), bounded, transport)]);
  } finally {
    bounded.removeEventListener("abort", cancel);
  }
}
