// Stage 2.1: gateway resolution (pure), provider dialects against a stub
// local server (the tested offline path), the config file, and `okb init`.
// The preload pins the config dir to a temp location and strips provider
// keys, so everything here is deterministic and network-free.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiError, createGateway, detectProvider, resolveCall } from "../src/core/ai/gateway.ts";
import {
  ConfigError,
  configFilePath,
  loadConfig,
  resolveBundlePath,
  saveConfig,
} from "../src/core/config.ts";
import { clipUrl } from "../src/core/ingest/clip.ts";
import { okb } from "./helpers.ts";

const NO_ENV = {} as Record<string, string | undefined>;

describe("resolution (pure)", () => {
  test("detection is API-first per capability, local otherwise", () => {
    expect(detectProvider("chat", { ANTHROPIC_API_KEY: "k" })).toBe("anthropic");
    expect(detectProvider("chat", { OPENROUTER_API_KEY: "k" })).toBe("openrouter");
    expect(detectProvider("chat", NO_ENV)).toBe("ollama");
    expect(detectProvider("embed", { VOYAGE_API_KEY: "k" })).toBe("voyage");
    expect(detectProvider("embed", NO_ENV)).toBe("ollama");
    expect(detectProvider("rerank", NO_ENV)).toBe("voyage"); // only rerank recipe
    expect(detectProvider("rerank", { OPENAI_API_KEY: "k" })).toBe("voyage"); // openai can't rerank
  });

  test("precedence: per-call → env → config → detection", () => {
    const settings = { provider: "openai" };
    const env = { OKB_CHAT_PROVIDER: "gemini", GEMINI_API_KEY: "g" };
    expect(resolveCall("chat", settings, env, { provider: "anthropic" }).provider).toBe("anthropic");
    expect(resolveCall("chat", settings, env).provider).toBe("gemini");
    expect(resolveCall("chat", settings, NO_ENV).provider).toBe("openai");
    expect(resolveCall("chat", {}, NO_ENV).provider).toBe("ollama");
  });

  test("a chat-only provider never hijacks the embed slot", () => {
    expect(resolveCall("embed", { provider: "anthropic" }, NO_ENV).provider).toBe("ollama");
    expect(resolveCall("embed", {}, { OKB_AI_PROVIDER: "anthropic" }).provider).toBe("ollama");
    expect(resolveCall("embed", { provider: "openai" }, NO_ENV).provider).toBe("openai");
  });

  test("local alias, model/baseUrl precedence, capability errors", () => {
    expect(resolveCall("chat", {}, NO_ENV, { provider: "local" }).provider).toBe("ollama");
    const r = resolveCall("chat", { model: "cfg-model", baseUrl: "http://cfg" }, {
      OKB_CHAT_MODEL: "env-model",
    });
    expect(r.model).toBe("env-model");
    expect(r.baseUrl).toBe("http://cfg");
    expect(resolveCall("chat", {}, NO_ENV).model).toBe("llama3.2");
    expect(() => resolveCall("chat", {}, NO_ENV, { provider: "nope" })).toThrow(AiError);
    expect(() => resolveCall("rerank", {}, NO_ENV, { provider: "ollama" })).toThrow(
      /no rerank support/,
    );
  });
});

describe("gateway dialects (stub local server — the offline path)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let last: { path: string; body: Record<string, unknown>; headers: Headers };
  const base = () => `http://127.0.0.1:${server.port}`;
  const gw = createGateway({}, NO_ENV);

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = (await req.json()) as Record<string, unknown>;
        last = { path, body, headers: req.headers };
        if (path.endsWith("/chat/completions"))
          return Response.json({ choices: [{ message: { content: "local says hi" } }] });
        if (path.endsWith("/embeddings"))
          return Response.json({
            data: (body.input as string[]).map((_, i) => ({ embedding: [i, 0.5, 1] })),
          });
        if (path.endsWith("/messages"))
          return Response.json({ content: [{ type: "text", text: "claude says hi" }] });
        if (path.includes(":generateContent"))
          return Response.json({ candidates: [{ content: { parts: [{ text: "gemini says hi" }] } }] });
        if (path.includes(":batchEmbedContents"))
          return Response.json({
            embeddings: (body.requests as unknown[]).map(() => ({ values: [1, 2] })),
          });
        if (path.endsWith("/rerank"))
          return Response.json({
            data: [
              { index: 1, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.1 },
            ],
          });
        return new Response("?", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("openai-compatible chat + embed (no key needed locally)", async () => {
    const chat = await gw.chat([{ role: "user", content: "hi" }], {
      provider: "ollama",
      baseUrl: base(),
    });
    expect(chat).toEqual({ text: "local says hi", provider: "ollama", model: "llama3.2" });
    expect(last.headers.get("authorization")).toBeNull();

    const emb = await gw.embed(["a", "b"], { provider: "ollama", baseUrl: base() });
    expect(emb.vectors).toHaveLength(2);
    expect(emb.dim).toBe(3);
  });

  test("api keys travel as Bearer for openai-style providers", async () => {
    await gw.chat([{ role: "user", content: "hi" }], {
      provider: "openai",
      baseUrl: base(),
      apiKey: "sk-test",
    });
    expect(last.headers.get("authorization")).toBe("Bearer sk-test");
  });

  test("anthropic dialect: system lifted, x-api-key + version headers", async () => {
    const r = await gw.chat(
      [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      { provider: "anthropic", baseUrl: base(), apiKey: "ak" },
    );
    expect(r.text).toBe("claude says hi");
    expect(last.path).toBe("/messages");
    expect(last.body.system).toBe("be brief");
    expect(last.body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(last.headers.get("x-api-key")).toBe("ak");
    expect(last.headers.get("anthropic-version")).toBeTruthy();
  });

  test("gemini dialect: role mapping, systemInstruction, key header, batch embed", async () => {
    const r = await gw.chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
      { provider: "gemini", baseUrl: base(), apiKey: "gk" },
    );
    expect(r.text).toBe("gemini says hi");
    expect(last.headers.get("x-goog-api-key")).toBe("gk");
    expect(last.body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(last.body.contents).toEqual([
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ text: "a" }] },
    ]);

    const emb = await gw.embed(["x", "y"], { provider: "gemini", baseUrl: base(), apiKey: "gk" });
    expect(emb.vectors).toEqual([[1, 2], [1, 2]]);
  });

  test("voyage rerank returns best-first indices", async () => {
    const r = await gw.rerank("q", ["d0", "d1"], {
      provider: "voyage",
      baseUrl: base(),
      apiKey: "vk",
    });
    expect(r.ranked.map((x) => x.index)).toEqual([1, 0]);
  });

  test("api provider without a key fails with the env var name", async () => {
    await expect(gw.chat([{ role: "user", content: "hi" }], { provider: "openai" })).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
  });
});

describe("config file + okb init", () => {
  // The preload pointed the config dir at a fresh temp dir for this process.
  let bundleA: string;
  beforeAll(async () => {
    bundleA = await mkdtemp(join(tmpdir(), "okb-init-a-"));
    await writeFile(
      join(bundleA, "a.md"),
      "---\ntype: note\ntitle: InBundleA\ndescription: d\n---\nhello\n",
      "utf8",
    );
  });
  afterAll(async () => {
    await rm(bundleA, { recursive: true, force: true });
    await rm(configFilePath(), { force: true });
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("loadConfig: absent → {}, corrupt → ConfigError, save round-trips", async () => {
    await rm(configFilePath(), { force: true });
    expect(loadConfig()).toEqual({});
    saveConfig({ future: { keep: true } });
    expect(loadConfig()).toEqual({ future: { keep: true } });
    await mkdir(join(configFilePath(), ".."), { recursive: true });
    await writeFile(configFilePath(), "{ nope", "utf8");
    expect(() => loadConfig()).toThrow(ConfigError);
    await rm(configFilePath(), { force: true });
  });

  test("bare init detects (no keys → local) and persists the default bundle", async () => {
    const r = await okb(["init", "--bundle", bundleA]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("chat:  ollama");
    expect(r.stdout).toContain("no key needed");
    const cfg = loadConfig();
    expect(cfg.ai?.provider).toBe("ollama");
    expect(cfg.defaultBundle).toBe(resolveBundlePath(bundleA));

    // The persisted default bundle now serves commands with no --bundle at all.
    const list = await okb(["list"]);
    expect(list.code).toBe(0);
    expect(list.stdout.trim()).toBe("a");
  });

  test("init with a key present detects API-first", async () => {
    await rm(configFilePath(), { force: true });
    process.env.ANTHROPIC_API_KEY = "test-key";
    const r = await okb(["init", "--bundle", bundleA]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("chat:  anthropic");
    expect(r.stdout).toContain("ANTHROPIC_API_KEY present");
    expect(loadConfig().ai?.provider).toBe("anthropic");
  });

  test("explicit flags merge; unknown config keys survive; validation rejects", async () => {
    saveConfig({ ...loadConfig(), custom: "kept" });
    expect((await okb(["init", "--provider", "local", "--model", "qwen3", "--bundle", bundleA])).code).toBe(0);
    expect((await okb(["init", "--embed-provider", "voyage", "--bundle", bundleA])).code).toBe(0);
    const cfg = loadConfig();
    expect(cfg.ai).toMatchObject({ provider: "ollama", model: "qwen3", embedProvider: "voyage" });
    expect(cfg.custom).toBe("kept");

    const bad = await okb(["init", "--embed-provider", "anthropic", "--bundle", bundleA]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("not a known embed provider");
  });

  test("--retrieval-profile persists to config.retrieval; bad names rejected", async () => {
    expect(
      (await okb(["init", "--retrieval-profile", "lean", "--no-default-bundle", "--bundle", bundleA])).code,
    ).toBe(0);
    expect(loadConfig().retrieval?.profile).toBe("lean");
    const bad = await okb(["init", "--retrieval-profile", "turbo", "--bundle", bundleA]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown retrieval profile");
    expect(loadConfig().retrieval?.profile).toBe("lean");
  });

  test("--no-default-bundle leaves the default alone", async () => {
    const before = loadConfig().defaultBundle;
    const other = await mkdtemp(join(tmpdir(), "okb-init-b-"));
    try {
      expect((await okb(["init", "--no-default-bundle", "--bundle", other])).code).toBe(0);
      expect(loadConfig().defaultBundle).toBe(before);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("review.* / clip.* config wiring", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-cfgwire-"));
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const n of ["one", "two", "three"])
      await writeFile(
        join(root, `${n}.md`),
        `---\ntype: note\ntitle: ${n}\ndescription: d\ntimestamp: ${old}\n---\nBody.\n`,
        "utf8",
      );
    expect((await okb(["index", "--bundle", root])).code).toBe(0);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(configFilePath(), { force: true });
  });

  test("review.queueSize and review.weights come from config.json", async () => {
    saveConfig({ review: { queueSize: 2 } });
    let q = JSON.parse((await okb(["review", "--json", "--bundle", root])).stdout);
    expect(q).toHaveLength(2);

    saveConfig({ review: { weights: { orphan: 0 } } });
    q = JSON.parse((await okb(["review", "--json", "--bundle", root])).stdout);
    expect(q[0].score).toBeLessThan(1); // staleness only — orphan weight zeroed
    expect(q[0].reasons.join()).not.toContain("orphan");
  });

  test("clip honors maxBodyBytes and defaultTags overrides", async () => {
    const page = `<html><head><title>Config Clip</title></head><body><article><h1>Config Clip</h1>${"<p>A reasonably long paragraph that will absolutely exceed a three hundred byte body cap when repeated.</p>".repeat(10)}</article></body></html>`;
    const r = await clipUrl(
      root,
      { url: "https://example.com/cfg" },
      {
        fetcher: async () => ({ url: "https://example.com/cfg", contentType: "text/html", body: page }),
        maxBodyBytes: 300,
        defaultTags: ["auto"],
      },
    );
    expect(r.truncated).toBe(true);
    const doc = await Bun.file(join(root, "references", "config-clip.md")).text();
    expect(doc).toMatch(/tags:\n +- auto\n +- inbox/);
    expect(doc).toContain("(truncated by okb clip");
  });
});
