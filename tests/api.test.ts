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

  // Same UTF-16 length, different byte length: comparing string lengths let
  // this reach timingSafeEqual, which throws instead of returning false.
  test("tokenMatches: multibyte candidate is refused, not thrown on", () => {
    expect(tokenMatches("é".repeat(TOKEN.length), TOKEN)).toBe(false);
    expect(tokenMatches("☃".repeat(TOKEN.length), TOKEN)).toBe(false);
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

  test("a multibyte token candidate gets 401, not a 500", async () => {
    // Same UTF-16 length as the real token, so the byte-length mismatch is
    // only discoverable inside the comparison itself.
    const candidate = "é".repeat(api.token.length);
    expect(candidate.length).toBe(api.token.length);
    const res = await fetch(`${base}api/ops?token=${encodeURIComponent(candidate)}`);
    expect(res.status).toBe(401);
  });

  // `/` embeds the serve token, so the GUI must never be framable.
  test("responses carry the anti-framing guards", async () => {
    for (const path of ["", "gui/app.js", "api/ops"]) {
      const res = await fetch(base + path, { headers: { "x-okb-token": api.token } });
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
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
      "#graph", "#search", "#ask", "#add", "#review", "#inbox",
      "#claims", "#stats", "#editor", "#settings",
    ])
      expect(page).toContain(`href="${link}"`);
  });

  test("the GUI JS wires every non-localOnly op to a surface", async () => {
    const appJs = await (await fetch(base + "gui/app.js")).text();
    // Each op the GUI exposes appears as an api() call target...
    for (const op of [
      "search", "read_concept", "list_concepts", "graph_neighbors",
      "graph_path", "orphans", "stats", "doctor", "write_concept", "capture",
      "import", "graph_data", "export_viz", "index", "rebuild", "embed", "sync",
      "review_queue", "review_done", "review_snooze", "clip", "rss",
      "link_suggest", "link_accept", "enrich", "inbox_list", "inbox_read",
      "take", "resolve", "calibrate", "init",
    ])
      expect(appJs).toContain(`'${op}'`);
    // ...except `ask`, which the GUI drives over the SSE stream endpoint.
    expect(appJs).toContain("/api/ask/stream");
  });

  test("GUI assets served tokenless with correct content types", async () => {
    const cases: [string, string, string][] = [
      ["gui/app.js", "application/javascript", "renderGraph"],
      ["gui/style.css", "text/css", "--accent"],
      ["gui/cytoscape.js", "application/javascript", "cytoscape"],
      ["gui/marked.js", "application/javascript", "marked"],
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
