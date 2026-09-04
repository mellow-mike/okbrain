// Stage 3.1: the local API. Token fail-closed on every /api and /clip request
// (CSRF), host check (DNS rebinding), CORS locked to the server's own
// localhost origins, op routes generated from the registry (localOnly hidden),
// SSE ask streaming, bookmarklet clip endpoint. Chat runs against a stub
// server — no live network in CI.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corsHeaders, createApiServer, hostAllowed, type ApiServer } from "../src/api.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";
import { OKF_VERSION } from "../src/core/okf/indexmd.ts";
import { operations } from "../src/core/operations.ts";
import { VERSION } from "../src/core/version.ts";
import {
  bookmarkletJs,
  ensureServeToken,
  serveTokenPath,
  tokenMatches,
} from "../src/core/serve-token.ts";
import { okb } from "./helpers.ts";

const TOKEN = "test-token-0123456789";

let bundle: string;
let api: ApiServer;
let base: string;

const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
  fetch(base + path, {
    ...init,
    headers: { ...(token === null ? {} : { "x-okb-token": token }), ...init.headers },
  });

const post = (op: string, params: unknown, token: string | null = TOKEN) =>
  call(`api/op/${op}`, { method: "POST", body: JSON.stringify(params) }, token);

beforeAll(async () => {
  bundle = await mkdtemp(join(tmpdir(), "okb-api-"));
  await writeFile(join(bundle, "index.md"), "# bundle\n");
  await mkdir(join(bundle, "notes"), { recursive: true });
  await writeFile(
    join(bundle, "notes", "alpha.md"),
    "---\ntype: note\ntitle: Alpha\ndescription: about databases\n---\nAlpha body about databases.\n",
  );
  expect((await okb(["index", "--bundle", bundle])).code).toBe(0);
  api = createApiServer({ bundle, port: 0, token: TOKEN });
  base = api.url;
});

afterAll(async () => {
  api.stop();
  await rm(bundle, { recursive: true, force: true });
});

describe("serve token", () => {
  test("minted once, persisted, base64url", () => {
    const t1 = ensureServeToken();
    const t2 = ensureServeToken();
    expect(t2).toBe(t1);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(serveTokenPath(), "utf8").trim()).toBe(t1);
  });

  test("tokenMatches: exact only", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(null, TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN + "x", TOKEN)).toBe(false);
  });
});

describe("request guards", () => {
  test("hostAllowed: own localhost hosts only", () => {
    expect(hostAllowed("127.0.0.1:6522", 6522)).toBe(true);
    expect(hostAllowed("localhost:6522", 6522)).toBe(true);
    expect(hostAllowed("[::1]:6522", 6522)).toBe(true);
    expect(hostAllowed("evil.com:6522", 6522)).toBe(false); // DNS rebinding
    expect(hostAllowed("127.0.0.1:9999", 6522)).toBe(false);
    expect(hostAllowed(null, 6522)).toBe(false);
  });

  test("corsHeaders: own localhost origins only", () => {
    expect(corsHeaders("http://localhost:6522", 6522)?.["access-control-allow-origin"]).toBe(
      "http://localhost:6522",
    );
    expect(corsHeaders("http://evil.com", 6522)).toBeUndefined();
    expect(corsHeaders("http://localhost:9999", 6522)).toBeUndefined();
    expect(corsHeaders(null, 6522)).toBeUndefined();
  });

  test("preflight: allowed origin gets CORS headers, foreign origin a 403", async () => {
    const ok = await fetch(base + "api/ops", {
      method: "OPTIONS",
      headers: { origin: `http://localhost:${api.port}` },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(`http://localhost:${api.port}`);

    const evil = await fetch(base + "api/ops", {
      method: "OPTIONS",
      headers: { origin: "http://evil.com" },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("every /api and /clip request needs the token; / does not", async () => {
    expect((await call("api/ops", {}, null)).status).toBe(401);
    expect((await call("api/ops", {}, "wrong-token")).status).toBe(401);
    expect((await call("clip?url=https://example.com", {}, null)).status).toBe(401);
    expect((await fetch(base)).status).toBe(200);
    expect(await (await fetch(base)).text()).toContain("okbrain");
  });

  test("GET / serves the GUI shell with the token injected", async () => {
    const page = await (await fetch(base)).text();
    expect(page).toContain(`window.OKB_TOKEN = "${TOKEN}"`);
    for (const link of [
      "#home", "#browse", "#graph", "#search", "#ask", "#review", "#inbox",
      "#add", "#edit", "#claims", "#stats", "#settings",
    ])
      expect(page).toContain(`href="${link}"`);
  });

  test("the GUI JS wires every non-localOnly op in the registry to a surface", async () => {
    const appJs = await (await fetch(base + "gui/app.js")).text();
    // Derived from the registry, so a new network-facing op cannot ship without a GUI home.
    for (const op of operations.filter((o) => !o.localOnly && o.name !== "ask"))
      expect(appJs).toContain(`'${op.name}'`);
    // ...except `ask`, which the GUI drives over the SSE stream endpoint.
    expect(appJs).toContain("/api/ask/stream");
    // localOnly ops have dedicated routes or documented terminal recipes instead.
    for (const needle of ["/api/status", "/api/brains", "/api/bookmarklet", "okb mcp"])
      expect(appJs).toContain(needle);
  });

  test("GUI assets served tokenless with correct content types", async () => {
    const cases: [string, string, string][] = [
      ["gui/app.js", "application/javascript", "renderGraph"],
      ["gui/style.css", "text/css", "--accent"],
      ["gui/cytoscape.js", "application/javascript", "cytoscape"],
      ["gui/marked.js", "application/javascript", "marked"],
      ["gui/purify.js", "application/javascript", "DOMPurify"],
      ["gui/render.js", "application/javascript", "okbRender"],
    ];
    for (const [path, type, needle] of cases) {
      const r = await fetch(base + path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain(type);
      expect(await r.text()).toContain(needle);
    }
  });

  test("token also accepted as Bearer and as query param", async () => {
    const bearer = await fetch(base + "api/ops", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.status).toBe(200);
    expect((await fetch(base + `api/ops?token=${TOKEN}`)).status).toBe(200);
  });

  test("a busy port fails with an actionable message", () => {
    expect(() => createApiServer({ bundle, port: api.port, token: TOKEN })).toThrow(
      /already in use.*--port/,
    );
  });
});

describe("op routes", () => {
  test("GET /api/ops lists the registry without localOnly ops", async () => {
    const r = await call("api/ops");
    expect(r.status).toBe(200);
    const { ops } = (await r.json()) as { ops: { name: string; scope: string }[] };
    expect(ops.some((o) => o.name === "search")).toBe(true);
    expect(ops.some((o) => o.name === "write_concept")).toBe(true);
    expect(ops.some((o) => o.name === "serve")).toBe(false);
    expect(ops.some((o) => o.name === "bookmarklet")).toBe(false);
  });

  test("POST /api/op/search returns hits", async () => {
    const r = await post("search", { query: "databases" });
    expect(r.status).toBe(200);
    const { result } = (await r.json()) as { result: { id: string }[] };
    expect(result.some((h) => h.id === "notes/alpha")).toBe(true);
  });

  test("write then read round-trips through the API (trusted)", async () => {
    const w = await post("write_concept", {
      id: "notes/via-api",
      type: "note",
      title: "Via API",
      description: "written over HTTP",
    });
    expect(w.status).toBe(200);
    const r = await post("read_concept", { id: "notes/via-api" });
    const { result } = (await r.json()) as { result: { raw: string } };
    expect(result.raw).toContain("title: Via API");
  });

  test("graph_data returns the live graph for the GUI", async () => {
    const r = await post("graph_data", {});
    expect(r.status).toBe(200);
    const { result } = (await r.json()) as {
      result: { nodes: { id: string }[]; edges: unknown[] };
    };
    expect(result.nodes.some((n) => n.id === "notes/alpha")).toBe(true);
  });

  test("unknown op → 404; localOnly op → 404; bad params → 400; not_found → 404", async () => {
    expect((await post("nonsense", {})).status).toBe(404);
    expect((await post("serve", {})).status).toBe(404);
    expect((await post("bookmarklet", {})).status).toBe(404);
    const bad = await post("search", { nope: 1 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("unknown parameter");
    expect((await post("read_concept", { id: "notes/ghost" })).status).toBe(404);
    expect((await post("search", "just a string")).status).toBe(400);
  });
});

describe("server routes for the GUI", () => {
  test("GET /api/status describes the served bundle", async () => {
    const r = await call("api/status");
    expect(r.status).toBe(200);
    const s = (await r.json()) as Record<string, unknown>;
    expect(s).toMatchObject({ version: VERSION, okfVersion: OKF_VERSION, bundle, brain: null, readonly: false, hasIndex: true, hasVectors: false, port: api.port });
    expect(typeof s.actor).toBe("string");
  });

  test("GET /api/brains lists mount names + policy, never paths; GET /api/bookmarklet embeds the token", async () => {
    expect(((await (await call("api/brains")).json()) as { brains: unknown[] }).brains).toEqual([]);
    const bm = (await (await call("api/bookmarklet")).json()) as { port: number; bookmarklet: string };
    expect(bm.port).toBe(api.port);
    expect(bm.bookmarklet).toContain(`token=${TOKEN}`);
    expect(bm.bookmarklet).toContain(`:${api.port}/clip`);
  });

  test("x-okb-brain scopes a request to a configured mount (read-only policy included)", async () => {
    const saved = loadConfig();
    const ref = await mkdtemp(join(tmpdir(), "okb-api-ref-"));
    await writeFile(join(ref, "beta.md"), "---\ntype: note\ntitle: Beta\ndescription: b\n---\nRef body.\n");
    try {
      saveConfig({ ...saved, brains: { ref: { path: ref, readonly: true } } });
      const brains = (await (await call("api/brains")).json()) as { brains: Record<string, unknown>[] };
      expect(brains.brains).toEqual([{ name: "ref", readonly: true, exists: true, active: false }]);

      const scoped = (init: RequestInit = {}) =>
        call("api/op/read_concept", { ...init, method: "POST", body: JSON.stringify({ id: "beta" }), headers: { "x-okb-brain": "ref" } });
      const read = await scoped();
      expect(read.status).toBe(200);
      expect(((await read.json()) as { result: { raw: string } }).result.raw).toContain("Ref body");
      const status = (await (await call("api/status", { headers: { "x-okb-brain": "ref" } })).json()) as { brain: string; readonly: boolean };
      expect(status).toMatchObject({ brain: "ref", readonly: true });

      const write = await call("api/op/capture", { method: "POST", body: JSON.stringify({ text: "nope" }), headers: { "x-okb-brain": "ref" } });
      expect(write.status).toBe(403); // read-only mount
      // An engine-backed read on the never-indexed mount is a precondition failure, not a server fault.
      const unindexed = await call("api/op/graph_neighbors", { method: "POST", body: JSON.stringify({ id: "beta" }), headers: { "x-okb-brain": "ref" } });
      expect(unindexed.status).toBe(409);
      expect(((await unindexed.json()) as { error: string }).error).toContain("okb index");
      expect((await call("api/status", { headers: { "x-okb-brain": "ghost" } })).status).toBe(400);
    } finally {
      saveConfig(saved);
      await rm(ref, { recursive: true, force: true });
    }
  });

  test("delete_concept removes the file, the index row, and logs a Deletion", async () => {
    await post("write_concept", { id: "notes/doomed", type: "note", title: "Doomed", description: "d" });
    expect((await post("delete_concept", { id: "notes/doomed" })).status).toBe(200);
    expect((await post("read_concept", { id: "notes/doomed" })).status).toBe(404);
    const { result } = (await (await post("search", { query: "Doomed" })).json()) as { result: { id: string }[] };
    expect(result.some((h) => h.id === "notes/doomed")).toBe(false);
    expect(readFileSync(join(bundle, "log.md"), "utf8")).toContain("**Deletion**: [Doomed](/notes/doomed.md)");
    expect((await post("delete_concept", { id: "notes/doomed" })).status).toBe(404);
  });
});

describe("clip endpoint (bookmarklet)", () => {
  test("missing url → 400, guard-refused target → 403, both as HTML", async () => {
    const missing = await call("clip");
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("missing required parameter");

    const refused = await call("clip?url=" + encodeURIComponent("http://127.0.0.1:1/x"));
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("okb clip");
  });

  test("okb bookmarklet embeds the real token and port", async () => {
    const r = await okb(["bookmarklet", "--json", "--bundle", bundle]);
    expect(r.code).toBe(0);
    const { bookmarklet, port } = JSON.parse(r.stdout) as { bookmarklet: string; port: number };
    expect(port).toBe(6522);
    expect(bookmarklet.startsWith("javascript:")).toBe(true);
    expect(bookmarklet).toContain(`token=${ensureServeToken()}`);
    expect(bookmarklet).toContain("http://127.0.0.1:6522/clip");
    const custom = await okb(["bookmarklet", "--port", "7777", "--json", "--bundle", bundle]);
    expect(JSON.parse(custom.stdout).bookmarklet).toContain(":7777/clip");
  });

  test("bookmarkletJs carries the selection as the quote", () => {
    expect(bookmarkletJs(6522, "tok")).toContain("'&quote='+encodeURIComponent(q)");
  });
});

describe("SSE ask stream (stub chat server)", () => {
  let chat: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    chat = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          choices: [{ message: { content: "Databases are in [notes/alpha]." } }],
        }),
    });
    process.env.OKB_CHAT_PROVIDER = "ollama";
    process.env.OKB_CHAT_BASE_URL = `http://127.0.0.1:${chat.port}`;
  });

  afterAll(() => {
    delete process.env.OKB_CHAT_PROVIDER;
    delete process.env.OKB_CHAT_BASE_URL;
    chat.stop();
  });

  test("streams context → answer → done, with verified citations", async () => {
    const r = await call("api/ask/stream?question=databases");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const text = await r.text();
    const order = ["event: context", "event: answer", "event: done"].map((e) =>
      text.indexOf(e),
    );
    expect(Math.min(...order)).toBeGreaterThanOrEqual(0);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain('"id":"notes/alpha"');
    expect(text).toContain("Databases are in");
  });

  test("a missing question fails before the stream starts (plain 400)", async () => {
    const r = await call("api/ask/stream");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("question");
  });

  test("a chat failure surfaces as an SSE error event, not a broken response", async () => {
    process.env.OKB_CHAT_BASE_URL = "http://127.0.0.1:9";
    try {
      const r = await call("api/ask/stream?question=databases");
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("event: error");
    } finally {
      process.env.OKB_CHAT_BASE_URL = `http://127.0.0.1:${chat.port}`;
    }
  });
});
