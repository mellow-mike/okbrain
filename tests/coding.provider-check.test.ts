import { expect, spyOn, test } from "bun:test";
import {
  checkProviderModel, parseProviderCheckOutcome, type ProviderCheckInput,
} from "../src/core/coding/provider-check.ts";

type FakeRequest = (url: URL, options: RequestInit) => Response | Promise<Response>;
const fakeFetch = (handle: FakeRequest): typeof fetch =>
  (async (url, options) => handle(url as URL, options!)) as typeof fetch;
const active = () => new AbortController().signal;
const apiKey = "isolated-fake-credential";
const openai: ProviderCheckInput = { provider: "openai", model: "gpt-5.4", apiKey };
const anthropic: ProviderCheckInput = { provider: "anthropic", model: "claude-sonnet-4-5", apiKey };
const google: ProviderCheckInput = { provider: "google", model: "gemini-2.5-flash", apiKey };

test("the provider check requests fixed model metadata only, with pinned Pi authentication", async () => {
  const cases: { input: ProviderCheckInput; url: string; auth: Record<string, string>; metadata: Record<string, string> }[] = [
    { input: openai, url: "https://api.openai.com/v1/models/gpt-5.4",
      auth: { authorization: `Bearer ${apiKey}` }, metadata: { object: "model", id: "gpt-5.4" } },
    { input: anthropic, url: "https://api.anthropic.com/v1/models/claude-sonnet-4-5",
      auth: { "anthropic-version": "2023-06-01", "x-api-key": apiKey },
      metadata: { type: "model", id: "claude-sonnet-4-5-20250929" } },
    { input: { ...anthropic, apiKey: "sk-ant-oat-offline-sample" }, url: "https://api.anthropic.com/v1/models/claude-sonnet-4-5",
      auth: { "anthropic-version": "2023-06-01", authorization: "Bearer sk-ant-oat-offline-sample" },
      metadata: { type: "model", id: "claude-sonnet-4-5" } },
    { input: google, url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash",
      auth: { "x-goog-api-key": apiKey }, metadata: { name: "models/gemini-2.5-flash" } },
    ...["gemini-flash-latest", "gemini-flash-lite-latest"].map((model) => ({
      input: { ...google, model }, url: `https://generativelanguage.googleapis.com/v1beta/models/${model}`,
      auth: { "x-goog-api-key": apiKey }, metadata: { name: `models/${model}` },
    })),
  ];
  for (const { input, url, auth, metadata } of cases) {
    let calls = 0;
    const result = await checkProviderModel(input, active(), fakeFetch((target, options) => {
      calls++;
      expect(target.href).toBe(url);
      expect(options).toMatchObject({
        method: "GET", redirect: "manual", credentials: "omit", proxy: false, cache: "no-store", keepalive: false,
      });
      expect(options.body).toBeUndefined();
      expect(options.signal?.aborted).toBe(false);
      expect(Object.fromEntries(new Headers(options.headers))).toEqual({ accept: "application/json", ...auth });
      return Response.json({ ...metadata, apiKey, workspace: "private upstream metadata" });
    }));
    expect(calls).toBe(1);
    expect(result).toEqual({ code: "ready", httpStatus: 200 });
  }
});

test("invalid model path segments, unknown providers, and invalid header bytes refuse transport", async () => {
  let calls = 0;
  const transport = fakeFetch(() => { calls++; throw new Error("unexpected transport"); });
  for (const model of ["https://example.test/model", "//example.test", "../model", "a/../b", "a\\b", "a?b",
    "a#b", "a%2fb", "a\n", ".", "a".repeat(129), ""]) {
    expect(await checkProviderModel({ ...openai, model }, active(), transport)).toEqual({ code: "model-unavailable" });
  }
  expect(await checkProviderModel({ ...openai, provider: "unknown" as "openai" }, active(), transport)).toEqual({ code: "model-unavailable" });
  expect(await checkProviderModel({ ...openai, apiKey: "fake\r\nx-extra: invalid" }, active(), transport)).toEqual({ code: "denied" });
  expect(await checkProviderModel(openai, AbortSignal.abort(), transport)).toEqual({ code: "unreachable" });
  expect(calls).toBe(0);
});

test("failed statuses discard external bodies and redirects with no retry", async () => {
  const cases = [
    [401, "denied"], [403, "denied"], [404, "model-unavailable"], [410, "model-unavailable"],
    [429, "rate-limited"], [400, "provider-error"], [500, "provider-error"],
    [302, "redirected"], [307, "redirected"], [204, "invalid-response"],
  ] as const;
  for (const [status, code] of cases) {
    let calls = 0;
    let discarded = false;
    const response = new Response(status === 204 ? null : new ReadableStream<Uint8Array>({
      cancel() { discarded = true; },
    }), { status, headers: { location: "https://untrusted.test/redirect" } });
    expect(await checkProviderModel(openai, active(), fakeFetch(() => { calls++; return response; }))).toEqual({ code, httpStatus: status });
    expect(calls).toBe(1);
    if (status !== 204) expect(discarded).toBe(true);
  }
  expect(await checkProviderModel(openai, active(), fakeFetch(() => {
    throw new Error(`upstream exception with ${apiKey} and https://untrusted.test/`);
  }))).toEqual({ code: "unreachable" });
});

test("successful HTTP must contain the selected model's bounded metadata", async () => {
  const invalid = { code: "invalid-response", httpStatus: 200 } as const;
  expect(await checkProviderModel(openai, active(), fakeFetch(() => Response.json({ object: "model", id: "wrong" })))).toEqual(invalid);
  expect(await checkProviderModel(google, active(), fakeFetch(() => Response.json({ name: "models/gemini-different" })))).toEqual(invalid);
  expect(await checkProviderModel(anthropic, active(), fakeFetch(() => Response.json({
    type: "model", id: "claude-sonnet-4-5-20250929-unrelated",
  })))).toEqual(invalid);
  expect(await checkProviderModel(openai, active(), fakeFetch(() => new Response("<html>provider proxy page</html>")))).toEqual(invalid);
  expect(await checkProviderModel(openai, active(), fakeFetch(() => new Response(Uint8Array.from([0xff]))))).toEqual(invalid);
  let discarded = false;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
    cancel() { discarded = true; },
  }));
  expect(await checkProviderModel(openai, active(), fakeFetch(() => oversized))).toEqual(invalid);
  expect(discarded).toBe(true);
});

test("an abort and the lookup deadline bound stalled responses", async () => {
  const parent = new AbortController();
  const deadline = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  try {
    const started = Promise.withResolvers<void>();
    const hanging = fakeFetch(() => { started.resolve(); return new Promise(() => {}); });
    const check = checkProviderModel(openai, parent.signal, hanging);
    await started.promise;
    parent.abort(new Error("private reason"));
    expect(await check).toEqual({ code: "unreachable" });
    const reading = Promise.withResolvers<void>();
    const pending = checkProviderModel(openai, active(), fakeFetch(() => new Response(new ReadableStream({
      pull() { reading.resolve(); return new Promise(() => {}); },
    }))));
    await reading.promise;
    deadline.abort();
    expect(await pending).toEqual({ code: "timed-out" });
    expect(timeout).toHaveBeenCalledWith(8000);
  } finally { timeout.mockRestore(); }
});

test("worker result validation keeps only permitted outcomes and matching HTTP status", () => {
  expect(parseProviderCheckOutcome({ code: "ready", httpStatus: 200 })).toEqual({ code: "ready", httpStatus: 200 });
  expect(parseProviderCheckOutcome({ code: "unreachable" })).toEqual({ code: "unreachable" });
  expect(parseProviderCheckOutcome({ code: "invalid-response", httpStatus: 200 })).toEqual({ code: "invalid-response", httpStatus: 200 });
  for (const outcome of [
    { code: apiKey }, { code: "ready", httpStatus: 499 }, { code: "unreachable", httpStatus: 500 },
    { code: "provider-error", httpStatus: 404 }, { code: "provider-error", httpStatus: 100 },
    { code: "ready", httpStatus: 200, apiKey }, ["ready"], null,
  ]) expect(parseProviderCheckOutcome(outcome)).toBeUndefined();
});
