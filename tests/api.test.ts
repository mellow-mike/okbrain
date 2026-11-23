// Stage 3.1: the local API. Token fail-closed on every /api and /clip request
// (CSRF), host check (DNS rebinding), CORS locked to the server's own
// localhost origins, op routes generated from the registry (localOnly hidden),
// SSE ask streaming, bookmarklet clip endpoint. Chat runs against a stub
// server — no live network in CI.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { corsHeaders, createApiServer, hostAllowed, type ApiServer } from "../src/api.ts";
import { runCli } from "../src/cli.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";
import { createGateway } from "../src/core/ai/gateway.ts";
import type { focusedMap } from "../src/core/graph/focus.ts";
import { parse } from "../src/core/okf/document.ts";
import { OKF_VERSION } from "../src/core/okf/indexmd.ts";
import { operations } from "../src/core/operations.ts";
import type { AskResult } from "../src/core/retrieval/ask.ts";
import { VERSION } from "../src/core/version.ts";
import {
  bookmarkletJs,
  clipToken,
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
    // only discoverable inside the comparison itself. `/clip` is the one
    // route that still reads a token from the address.
    const candidate = "é".repeat(api.token.length);
    expect(candidate.length).toBe(api.token.length);
    const res = await fetch(`${base}clip?url=https://example.com&token=${encodeURIComponent(candidate)}`);
    expect(res.status).toBe(401);
  });

  // `/` embeds the serve token, so the GUI must never be framable.
  test("responses carry the anti-framing guards", async () => {
    for (const path of ["", "gui/app.js", "api/ops"]) {
      const res = await fetch(base + path, { headers: { "x-okb-token": api.token } });
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      // A linked site or a remote image in a note learns nothing about the local app's address.
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
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
      "#home", "#browse", "#graph", "#search", "#ask", "#review", "#inbox",
      "#add", "#sources", "#edit", "#claims", "#stats", "#settings", "#accounts", "#map", "#coding",
    ])
      expect(page).toContain(`href="${link}"`);
  });

  test("the GUI JS wires every non-localOnly op in the registry to a surface", async () => {
    const page = await (await fetch(base)).text();
    const assets = [...page.matchAll(/<script src="(\/gui\/[^"/]+\.js)"/g)].map(([, asset]) => asset!);
    const appJs = (await Promise.all(assets.map(async (asset) => (await fetch(new URL(asset, base))).text()))).join("\n");
    // Derived from the registry, so a new network-facing op cannot ship without a GUI home.
    for (const op of operations.filter((o) => !o.localOnly && o.name !== "ask"))
      expect(appJs).toContain(`'${op.name}'`);
    // ...except `ask`, which the GUI drives over the SSE stream endpoint.
    expect(appJs).toContain("/api/ask/stream");
    // Settings actions have dedicated routes outside the generic op surface.
    for (const needle of ["/api/status", "/api/brains/mounts", "/api/bookmarklet", "/api/mcp/http"])
      expect(appJs).toContain(needle);
  });

  test("focused maps explain real links and filter private drafts before return", async () => {
    const secret = "db_only/plan-secret";
    await post("write_concept", { id: secret, type: "note", title: "Private alpha", description: "A private note", body: "Private databases." });
    await post("write_concept", { id: "notes/focus", type: "note", title: "Database plan", description: "Project datastore",
      body: `Read [Alpha](/notes/alpha.md) and [draft](/${secret}.md).` });
    const map = async (params: Record<string, unknown>) => {
      const response = await post("focused_map", params);
      return (await response.json() as { result: ReturnType<typeof focusedMap> }).result;
    };
    try {
      const basic = await map({ id: "notes/focus" });
      expect(basic.nodes.map((item: { id: string }) => item.id)).toEqual(["notes/focus", "notes/alpha"]);
      expect(basic.edges).toContainEqual({ src: "notes/focus", dst: "notes/alpha", rel: null });
      expect(JSON.stringify(basic)).not.toContain(secret);
      expect((await map({ id: "notes/focus", "include-private": true })).nodes.some((node: { id: string; private: boolean }) => node.id === secret && node.private)).toBe(true);
      expect((await map({ id: "notes/focus", source: "web" })).nodes).toEqual([]);
      expect((await map({ id: "notes/focus", since: "2999-01-01" })).nodes).toEqual([]);
      expect((await map({ query: "databases" })).nodes.some((node: { id: string; root: boolean }) => node.id === "notes/alpha" && node.root)).toBe(true);
      expect((await post("focused_map", { id: "notes/focus", since: "2026-02-30" })).status).toBe(400);
    } finally {
      await rm(join(bundle, `${secret}.md`), { force: true });
      await rm(join(bundle, "notes", "focus.md"), { force: true });
      await post("index", {});
    }
  });

  test("keyword search returns marked spans for the app and brackets them in CLI output", async () => {
    const response = await post("search", { query: "databases", "keyword-only": true });
    expect(response.status).toBe(200);
    const hits = (await response.json() as { result: { id: string; keywordExcerpt?: { text: string; match: boolean }[] }[] }).result;
    expect(hits.find((hit) => hit.id === "notes/alpha")?.keywordExcerpt).toContainEqual({ text: "databases", match: true });
    const cli = await okb(["--bundle", bundle, "search", "databases", "--keyword-only"]);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain("[databases]");
  });

  test("an overdue claim appears in Review and stops contributing after settlement", async () => {
    const accepted = await post("take", { statement: "An old prediction", confidence: 75, "resolve-by": "2001-07-10" });
    expect(accepted.status).toBe(200);
    const { result: claim } = await accepted.json() as { result: { id: string } };
    try {
      const listed = async () => (await (await post("review_queue", { limit: 50 })).json() as { result: { id: string; overdueClaim?: string; reasons: string[] }[] }).result;
      expect((await listed()).find((item) => item.id === claim.id)).toMatchObject({ overdueClaim: "2001-07-10" });
      expect((await listed()).find((item) => item.id === claim.id)?.reasons).toContain("claim due 2001-07-10");
      expect((await post("resolve", { id: claim.id, outcome: "correct" })).status).toBe(200);
      expect((await listed()).find((item) => item.id === claim.id)?.overdueClaim).toBeUndefined();
      expect((await post("take", { statement: "Invalid date", confidence: 75, "resolve-by": "2026-02-30" })).status).toBe(400);
    } finally {
      await rm(join(bundle, `${claim.id}.md`), { force: true });
      await post("index", {});
    }
  });

  test("browser provider keys flow into gateway calls without returning credential text", async () => {
    const key = "local-test-provider-key";
    const edit = (value: string | null) => call("api/provider-keys", { method: "POST", body: JSON.stringify({ provider: "openai", key: value }) });
    const inference = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      return Response.json({ choices: [{ message: { content: "Provider response" } }] });
    } });
    try {
      expect((await fetch(`${base}api/provider-keys?token=${TOKEN}`)).status).toBe(401);
      const setup = await edit(key);
      expect(setup.status).toBe(200);
      const serialized = await setup.text();
      expect(serialized).not.toContain(key);
      expect(JSON.parse(serialized).result).toContainEqual({ provider: "openai", saved: true, environment: false });
      const gateway = createGateway({ provider: "openai", baseUrl: `http://127.0.0.1:${inference.port}` });
      expect((await gateway.chat([{ role: "user", content: "Summarize" }])).text).toBe("Provider response");
    } finally {
      inference.stop(true);
      expect((await edit(null)).status).toBe(200);
    }
  });

  test("saved RSS feeds are local settings and pulls still use the fetch guard", async () => {
    const cfg = loadConfig();
    let requests = 0;
    const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      return new Response("<rss/>");
    } });
    const url = `http://127.0.0.1:${fixture.port}/feed`;
    const path = "api/rss-settings";
    const edit = (feeds: string, headers: Record<string, string> = {}) => call(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ feeds }),
    });
    try {
      saveConfig({ ...cfg, retainedSetting: { untouched: true }, rss: { maxItems: 17 }, brains: {
        ...cfg.brains, "rss-readonly": { path: bundle, readonly: true },
      } });
      expect((await fetch(`${base}${path}?token=${TOKEN}`)).status).toBe(401);
      expect((await edit(url, { origin: "https://untrusted.example" })).status).toBe(403);
      expect((await edit(url, { "x-okb-brain": "rss-readonly" })).status).toBe(403);
      expect((await post("rss_settings", { feeds: url })).status).toBe(404);

      const saved = await edit(` ${url}\r\n\r\n${url}`);
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ result: { feeds: [url] } });
      expect(saved.headers.get("cache-control")).toBe("no-store");
      expect(requests).toBe(0);
      expect((await edit(`${url}\nfile:///data/feed.xml`)).status).toBe(400);
      expect(await (await call(path)).json()).toEqual({ result: { feeds: [url] } });
      expect(loadConfig()).toMatchObject({ retainedSetting: { untouched: true }, rss: { feeds: [url], maxItems: 17 } });
      expect((await post("rss", {})).status).toBe(403);
      expect(requests).toBe(0);
      expect(JSON.parse((await okb(["rss", "settings", "--json", "--bundle", bundle])).stdout)).toEqual({ feeds: [url] });
      expect(await (await edit("")).json()).toEqual({ result: { feeds: [] } });
    } finally {
      await fixture.stop(true);
      saveConfig(cfg);
    }
  });

  test("GUI assets served tokenless with correct content types", async () => {
    const cases: [string, string, string][] = [
      ["gui/app.js", "application/javascript", "renderGraph"],
      ["gui/style.css", "text/css", "--accent"],
      ["gui/tokens.css", "text/css", "--graph-1"],
      ["gui/okb.js", "application/javascript", "window.Okb"],
      ["gui/cytoscape.js", "application/javascript", "cytoscape"],
      ["gui/marked.js", "application/javascript", "marked"],
      ["gui/safe-markdown.js", "application/javascript", "okbMarkdown"],
      ["gui/render.js", "application/javascript", "okbRender"],
    ];
    for (const [path, type, needle] of cases) {
      const r = await fetch(base + path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain(type);
      expect(await r.text()).toContain(needle);
    }
  });

  test("every asset the shell and stylesheet reference is served — fonts as woff2", async () => {
    const shell = await (await fetch(base)).text();
    const css = await (await fetch(base + "gui/style.css")).text();
    const refs = [
      ...[...shell.matchAll(/(?:href|src)="\/(gui\/[^"]+)"/g)].map((m) => m[1]!),
      ...[...css.matchAll(/url\("\/(gui\/[^"]+)"\)/g)].map((m) => m[1]!),
    ];
    expect(refs).toContain("gui/tokens.css");
    const fonts = refs.filter((r) => r.endsWith(".woff2"));
    expect(fonts).toHaveLength(4);
    for (const ref of refs) expect((await fetch(base + ref)).status).toBe(200);
    for (const font of fonts) {
      const r = await fetch(base + font);
      expect(r.headers.get("content-type")).toBe("font/woff2");
      expect(new TextDecoder().decode((await r.bytes()).subarray(0, 4))).toBe("wOF2");
    }
  });

  test("the token is accepted as a header or Bearer, never from the address", async () => {
    const bearer = await fetch(base + "api/ops", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.status).toBe(200);
    expect((await fetch(base + `api/ops?token=${TOKEN}`)).status).toBe(401);
  });

  // B22: the bookmarklet runs inside the page being clipped, and that page can
  // read the address it opens. Whatever it finds there must not make it the owner.
  test("a token read from the bookmarklet's address clips and does nothing else", async () => {
    const clip = clipToken(TOKEN);
    const bookmarklet = bookmarkletJs(api.port, TOKEN);
    expect(bookmarklet).toContain(`/clip?token=${clip}`);
    expect(bookmarklet).not.toContain(TOKEN);
    expect(clip).not.toBe(TOKEN);
    expect(clip).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // What a page on another origin can send without a preflight: no custom
    // header, a text/plain body, and the token it read in the address. Both
    // the clip token and the serve token an older bookmarklet carried fail.
    const blind = (path: string, token: string, body?: unknown) => fetch(`${base}${path}${path.includes("?") ? "&" : "?"}token=${token}`, {
      method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
      headers: { origin: "https://clipped.example", ...(body === undefined ? {} : { "content-type": "text/plain;charset=UTF-8" }) },
    });
    for (const token of [clip, TOKEN]) {
      for (const [name, params] of [
        ["write_concept", { id: "notes/planted", type: "note", title: "Planted", description: "by a clipped page" }],
        ["delete_concept", { id: "notes/alpha" }],
        ["init", { "embed-provider": "openai", "embed-base-url": "https://collector.example/v1", "no-default-bundle": true }],
        ["embed", { "include-private": true }],
        ["index", {}],
      ] as const)
        expect((await blind(`api/op/${name}`, token, params)).status).toBe(401);
      for (const path of ["api/ops", "api/status", "api/bookmarklet", "api/brains", "api/ask/stream?question=databases"])
        expect((await blind(path, token)).status).toBe(401);
    }
    expect(existsSync(join(bundle, "notes", "planted.md"))).toBe(false);
    expect(existsSync(join(bundle, "notes", "alpha.md"))).toBe(true);
    expect(loadConfig().ai?.embedBaseUrl).toBeUndefined();

    // The clip token does reach `/clip`, and only as part of the address.
    const reached = await fetch(`${base}clip?token=${clip}`);
    expect(reached.status).toBe(400);
    expect(await reached.text()).toContain("missing required parameter");
    expect((await fetch(`${base}clip`, { headers: { "x-okb-token": clip } })).status).toBe(401);
    expect((await fetch(`${base}api/ops`, { headers: { "x-okb-token": clip } })).status).toBe(401);
    expect((await fetch(`${base}clip?token=${clip}`, { method: "POST", body: "{}" })).status).toBe(401);

    // A bookmarklet saved by an earlier version still clips, and is told to update.
    const outdated = await fetch(`${base}clip?token=${TOKEN}`);
    expect(outdated.status).toBe(400);
    const page = await outdated.text();
    expect(page).toContain("Replace it with the one under Add → Bookmarklet");
    expect(page).not.toContain("window.close");
    expect(await (await call("clip")).text()).not.toContain("Replace it");
  });

  test("a request from another origin cannot change anything, even with the token in a header", async () => {
    const foreign = { origin: "https://other.example", "content-type": "application/json" };
    for (const [path, body] of [
      ["api/op/write_concept", { id: "notes/foreign", type: "note", title: "Foreign", description: "from another origin" }],
      ["api/op/index", {}],
      ["api/conversations/upload?provider=chatgpt", []],
      ["api/provider-keys", { provider: "openai", key: "sk-foreign" }],
    ] as const)
      expect((await call(path, { method: "POST", headers: foreign, body: JSON.stringify(body) })).status).toBe(403);
    expect(existsSync(join(bundle, "notes", "foreign.md"))).toBe(false);
    // The app's own origin and callers without one, such as the CLI's fetch, pass.
    const own = { origin: `http://127.0.0.1:${api.port}`, "content-type": "application/json" };
    expect((await call("api/op/search", { method: "POST", headers: own, body: JSON.stringify({ query: "databases" }) })).status).toBe(200);
    expect((await post("search", { query: "databases" })).status).toBe(200);
    expect((await call("api/ops", { headers: { origin: "https://other.example" } })).status).toBe(200);
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
    expect(ops.filter((o) => o.name.startsWith("code_"))).toEqual([]);
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
    for (const name of ["code_context", "code_run", "code_status"])
      expect((await post(name, {})).status).toBe(404);
    const bad = await post("search", { nope: 1 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("unknown parameter");
    expect((await post("read_concept", { id: "notes/ghost" })).status).toBe(404);
    expect((await post("search", "just a string")).status).toBe(400);
  });
});

describe("server routes for the GUI", () => {
  test("enabled folder logs follow public deletions and omit private notes", async () => {
    const enabled = await post("create_directory_log", { folder: "notes" });
    expect(enabled.status).toBe(200);
    expect((await post("create_directory_log", { folder: "notes/../elsewhere" })).status).toBe(400);
    for (const id of ["notes/public-deletion", "notes/db_only/private-deletion"]) {
      expect((await post("write_concept", { id, type: "note", title: id, description: "Deletion fixture" })).status).toBe(200);
      expect((await post("delete_concept", { id })).status).toBe(200);
    }
    for (const log of [join(bundle, "log.md"), join(bundle, "notes", "log.md")]) {
      const text = await Bun.file(log).text();
      expect(text).toContain("**Deletion**: [notes/public-deletion](/notes/public-deletion.md)");
      expect(text).not.toContain("private-deletion");
    }
    expect((await okb(["--bundle", bundle, "log", "create", "notes"])).stdout).toContain("notes/log.md is already enabled");
  });

  test("GET /api/status describes the served bundle", async () => {
    const r = await call("api/status");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const s = (await r.json()) as Record<string, unknown>;
    expect(s).toMatchObject({ version: VERSION, okfVersion: OKF_VERSION, bundle, brain: null, readonly: false,
      cacheBackend: "sqlite", cacheError: null, hasIndex: true, hasVectors: false, port: api.port });
    expect(typeof s.actor).toBe("string");
  });

  test("cache settings require the local app token and same-origin JSON", async () => {
    const path = "api/op/cache_settings";
    const input = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    expect((await call(`${path}?token=${TOKEN}`, input, null)).status).toBe(401);
    expect((await call(path, { ...input, headers: { ...input.headers, origin: "https://other.example" } })).status).toBe(403);
    expect((await call(path, { ...input, headers: { "content-type": "text/plain" } })).status).toBe(415);
    const result = await call(path, input);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ result: { backend: "sqlite" } });
  });

  test("GET /api/brains lists mount names + policy, never paths; GET /api/bookmarklet embeds the token", async () => {
    expect(((await (await call("api/brains")).json()) as { brains: unknown[] }).brains).toEqual([]);
    const bm = (await (await call("api/bookmarklet")).json()) as { port: number; bookmarklet: string };
    expect(bm.port).toBe(api.port);
    expect(bm.bookmarklet).toContain(`token=${clipToken(TOKEN)}`);
    expect(bm.bookmarklet).not.toContain(TOKEN);
    expect(bm.bookmarklet).toContain(`:${api.port}/clip`);
  });

  test("restoring a GitHub brain requires a writable local owner and a separate destination", async () => {
    const saved = loadConfig();
    const parent = await mkdtemp(join(tmpdir(), "okb-restore-parent-"));
    const draft = { action: "restore", name: "Shared", parent, url: "https://github.com/example/brain.git", branch: "main" };
    const restore = (body: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN) =>
      call("api/brains", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, token);
    try {
      saveConfig({ ...saved, brains: { Reference: { path: parent, readonly: true } } });
      expect((await restore(draft, { authorization: `Bearer ${TOKEN}` }, null)).status).toBe(401);
      expect((await restore(draft, { origin: "https://remote.example" })).status).toBe(403);
      expect((await restore(draft, { "content-type": "text/plain" })).status).toBe(415);
      expect((await restore(draft, { "x-okb-brain": "Reference" })).status).toBe(403);
      expect((await restore(draft)).status).toBe(409);
      expect((await restore({ ...draft, parent: bundle })).status).toBe(409);
      expect((await restore({ ...draft, parent: "relative" })).status).toBe(400);
      expect((await restore({ ...draft, saveCredential: true })).status).toBe(400);
      expect((await restore({ ...draft, name: "Reference" })).status).toBe(409);
      expect(loadConfig().brains).toEqual({ Reference: { path: parent, readonly: true } });
      expect(await readdir(parent)).toEqual([]);
    } finally {
      saveConfig(saved);
      await rm(parent, { recursive: true, force: true });
    }
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
      const privateExport = await call("api/op/export_viz", {
        method: "POST", body: JSON.stringify({ "include-private": true }), headers: { "x-okb-brain": "ref" },
      });
      expect(privateExport.status).toBe(403);
      const upload = await call("api/conversations/upload?provider=chatgpt", {
        method: "POST", body: "[]", headers: { "x-okb-brain": "ref", "content-type": "application/json" },
      });
      expect(upload.status).toBe(403);
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

  test("Settings creates and registers brain folders and changes mount policy without rewriting their files", async () => {
    const config = loadConfig();
    const parent = await mkdtemp(join(tmpdir(), "okb-brain-mounts-"));
    const existing = join(parent, "Existing brain");
    const created = join(parent, "New brain");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "original.md"), "---\ntype: note\ntitle: Original\ndescription: Original draft\n---\nKeep this text.\n");
    const original = await Bun.file(join(existing, "original.md")).text();
    const request = (body: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN) =>
      call("api/brains/mounts", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, token);
    const create = { action: "create", name: "MyBrain", path: created, readonly: false };
    try {
      saveConfig({ ...config, retainedSetting: { untouched: true }, brains: {} });
      expect((await request(create, { authorization: "Bearer " + TOKEN }, null)).status).toBe(401);
      expect((await request(create, { origin: "https://example.test" })).status).toBe(403);
      expect((await request({ ...create, path: "relative/path" })).status).toBe(400);
      expect((await request({ ...create, name: "__proto__" })).status).toBe(400);
      expect((await request({ ...create, path: existing })).status).toBe(409);
      expect((await request({ ...create, action: "register" })).status).toBe(404);
      expect(await Bun.file(join(existing, "index.md")).exists()).toBe(false);

      const response = await request(create, { origin: new URL(base).origin });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ result: { name: "MyBrain", removed: false } });
      expect(await Bun.file(join(created, "index.md")).text()).toContain(`okf_version: "${OKF_VERSION}"`);
      const mounting = { action: "register", name: "Library", path: existing, readonly: false };
      expect((await request(mounting)).status).toBe(200);
      expect((await request({ ...mounting, name: "Duplicate" })).status).toBe(409);
      const existingConfig = loadConfig();
      const record = existingConfig.brains?.Library;
      saveConfig({ ...existingConfig, brains: {
        ...existingConfig.brains, Library: { ...(typeof record === "object" ? record : { path: existing }), mountExtension: "keep" },
      } });
      const rename = { action: "update", previous: "Library", name: "Reference", readonly: true };
      expect((await request(rename, { "x-okb-brain": "Library" })).status).toBe(200);
      const stale = await call("api/status", { headers: { "x-okb-brain": "Library" } });
      expect(stale.status).toBe(400);
      expect(await stale.json()).toMatchObject({ code: "unknown_brain" });
      expect(await (await call("api/status", { headers: { "x-okb-brain": "Reference" } })).json()).toMatchObject({
        brain: "Reference", readonly: true,
      });
      expect(loadConfig()).toMatchObject({
        retainedSetting: { untouched: true }, brains: { Reference: { readonly: true, mountExtension: "keep" } },
      });
      const remove = { action: "remove", previous: "Reference" };
      expect((await request(remove, { "x-okb-brain": "Reference" })).status).toBe(403);
      const readonly = createApiServer({ bundle, port: 0, token: TOKEN, readonly: true });
      try {
        expect((await fetch(readonly.url + "api/brains/mounts", {
          method: "POST", headers: { "x-okb-token": TOKEN, "x-okb-brain": "MyBrain", "content-type": "application/json" },
          body: JSON.stringify(remove),
        })).status).toBe(403);
      } finally {
        readonly.stop();
      }
      expect((await request(remove)).status).toBe(200);
      expect(await Bun.file(join(existing, "original.md")).text()).toBe(original);
      expect(await Bun.file(join(existing, "index.md")).exists()).toBe(false);
      expect(await (await call("api/brains")).json()).toMatchObject({
        brains: [{ name: "MyBrain", exists: true, readonly: false, active: false }],
      });
      expect((await post("change_brain_mount", create)).status).toBe(404);
      const current = loadConfig();
      saveConfig({ ...current, brains: { ...current.brains, ["__proto__"]: { path: existing, custom: "legacy" } } });
      expect((await request({ action: "update", previous: "__proto__", name: "__proto__", readonly: true })).status).toBe(200);
      const updated = loadConfig().brains!;
      expect(Object.hasOwn(updated, "__proto__")).toBe(true);
      expect(updated["__proto__"]).toMatchObject({ readonly: true, custom: "legacy" });
    } finally {
      saveConfig(config);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("named retrieval preferences are scoped to their brain and allow one-run overrides", async () => {
    const saved = loadConfig();
    const profileBundle = await mkdtemp(join(tmpdir(), "okb-api-profile-"));
    const scoped = (route: string, params: Record<string, unknown>) => call(route, {
      method: "POST", headers: { "content-type": "application/json", "x-okb-brain": "Profile" }, body: JSON.stringify(params),
    });
    try {
      saveConfig({ ...saved, retrieval: { profile: "balanced" }, brains: { Profile: profileBundle } });
      const selection = { action: "update", previous: "Profile", name: "Profile", readonly: false };
      expect((await scoped("api/brains/mounts", { ...selection, retrievalProfile: "__proto__" })).status).toBe(400);
      expect((await scoped("api/brains/mounts", { ...selection, retrievalProfile: "lean" })).status).toBe(200);
      for (let i = 0; i < 12; i++) await writeFile(join(profileBundle, `note-${i}.md`), `---\ntype: note\ntitle: Note ${i}\n---\nquartzleaf\n`);
      expect((await scoped("api/op/index", {})).status).toBe(200);
      const query = { query: "quartzleaf", "keyword-only": true };
      const search = async (params: Record<string, unknown>) => {
        const reply = await scoped("api/op/search", params);
        expect(reply.status).toBe(200);
        return (await reply.json() as { result: unknown[] }).result;
      };
      expect(await search(query)).toHaveLength(8);
      expect(await search({ ...query, profile: "max" })).toHaveLength(12);
      expect(await (await call("api/status")).json()).toMatchObject({ retrievalProfile: "balanced" });
      let output = "";
      expect(await runCli(["--brain", "Profile", "search", "quartzleaf", "--keyword-only", "--json"], {
        out: (value) => { output += value; }, err: () => {},
      })).toBe(0);
      expect(JSON.parse(output)).toHaveLength(8);
      expect((await scoped("api/brains/mounts", { ...selection, retrievalProfile: "" })).status).toBe(200);
      expect(await search(query)).toHaveLength(12);

      const served = createApiServer({ bundle: profileBundle, servedBrain: "Profile", port: 0, token: TOKEN });
      try {
        expect((await scoped("api/brains/mounts", { ...selection, retrievalProfile: "lean", readonly: true })).status).toBe(200);
        const rootStatus = await fetch(new URL("api/status", served.url), { headers: { "x-okb-token": TOKEN } });
        expect(await rootStatus.json()).toMatchObject({ brain: null, readonly: true, retrievalProfile: "lean" });
        const blocked = await fetch(new URL("api/op/capture", served.url), { method: "POST",
          headers: { "content-type": "application/json", "x-okb-token": TOKEN }, body: JSON.stringify({ text: "Blocked" }) });
        expect(blocked.status).toBe(403);
        const removed = await call("api/brains/mounts", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "remove", previous: "Profile" }) });
        expect(removed.status).toBe(200);
        const discovery = await fetch(new URL("api/brains", served.url), { headers: { "x-okb-token": TOKEN } });
        expect(discovery.status).toBe(200);
        expect(await discovery.json()).toMatchObject({ brains: [] });
      } finally { await served.stop(); }
    } finally {
      saveConfig(saved);
      await rm(profileBundle, { recursive: true, force: true });
    }
  });

  test("named brain chat and embedding defaults apply through the browser and regular CLI", async () => {
    const saved = loadConfig();
    const notes = await mkdtemp(join(tmpdir(), "okb-mount-ai-"));
    const requests: { path: string; model: string }[] = [];
    const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.json() as { model: string; input?: string[] };
      requests.push({ path, model: body.model });
      if (path === "/embeddings") return Response.json({ data: body.input?.map(() => ({ embedding: [1, 0, 0] })) });
      return Response.json({ choices: [{ message: { content: "Local answer [sample]." } }] });
    } });
    const name = "MountAi";
    const scoped = (path: string, params: Record<string, unknown>) => call(path, {
      method: "POST", headers: { "content-type": "application/json", "x-okb-brain": name }, body: JSON.stringify(params),
    });
    try {
      await writeFile(join(notes, "sample.md"), "---\ntype: note\ntitle: Fern guide\n---\nquartzleaf\n");
      const ai = { provider: "ollama", model: "app-chat", baseUrl: fixture.url.origin,
        embedProvider: "ollama", embedModel: "app-embed", embedBaseUrl: fixture.url.origin };
      saveConfig({ ...saved, ai, brains: { ...saved.brains, [name]: { path: notes, customField: "kept" } } });
      const update = { action: "update", name, previous: name, readonly: false };
      expect((await scoped("api/brains/mounts", { ...update, ai: { embedProvider: "anthropic" } })).status).toBe(400);
      expect((await scoped("api/brains/mounts", { ...update, ai: { apiKey: "ignored" } })).status).toBe(400);
      const defaults = { provider: "ollama", model: "brain-chat", embedProvider: "ollama", embedModel: "brain-embed" };
      expect((await scoped("api/brains/mounts", { ...update, ai: defaults })).status).toBe(200);
      expect(requests).toEqual([]);
      expect(loadConfig()).toMatchObject({ ai, brains: { [name]: { path: notes, customField: "kept", ai: defaults } } });

      expect((await scoped("api/op/index", {})).status).toBe(200);
      const answered = await scoped("api/op/ask", { question: "quartzleaf", profile: "lean" });
      expect(await answered.json()).toMatchObject({ result: { provider: "ollama", model: "brain-chat", citations: [{ id: "sample" }] } });
      const embedded = await okb(["--brain", name, "embed", "--json"]);
      expect(embedded.code).toBe(0);
      expect(JSON.parse(embedded.stdout)).toMatchObject({ provider: "ollama", model: "brain-embed", embedded: 1 });
      expect(requests).toEqual([{ path: "/chat/completions", model: "brain-chat" }, { path: "/embeddings", model: "brain-embed" }]);

      expect((await scoped("api/brains/mounts", { ...update, ai: { provider: "", model: "" } })).status).toBe(200);
      const inherited = await scoped("api/op/ask", { question: "quartzleaf", profile: "lean" });
      expect(await inherited.json()).toMatchObject({ result: { model: "app-chat" } });
      const global = await post("ask", { question: "databases", profile: "lean" });
      expect(await global.json()).toMatchObject({ result: { model: "app-chat" } });
    } finally {
      await fixture.stop(true);
      saveConfig(saved);
      await rm(notes, { recursive: true, force: true });
    }
  });

  test("browser-selected conversation exports preview locally before create-only import", async () => {
    const endpoint = "api/conversations/upload?provider=chatgpt";
    const archive = await Bun.file(join(import.meta.dir, "fixtures", "chatgpt-conversations.json")).text();
    const request = { method: "POST", body: archive, headers: { "content-type": "application/json" } };
    expect((await call(endpoint, request, null)).status).toBe(401);
    expect((await post("import_conversations", { path: "conversations.json", provider: "chatgpt" })).status).toBe(404);
    expect((await call(endpoint, { ...request, headers: { "content-type": "text/plain" } })).status).toBe(415);

    const preview = await call(endpoint, request);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    const { result } = (await preview.json()) as {
      result: { preview: string; planned: string[]; imported: string[]; drafts: unknown[] };
    };
    expect(result.planned).toHaveLength(1);
    expect(result.imported).toEqual([]);
    const id = result.planned[0]!;
    expect(result.drafts).toEqual([{ id, row: 1, title: "Library planning", messages: 2, createdAt: "2024-08-19T16:00:00.000Z" }]);
    expect((await post("read_concept", { id })).status).toBe(404);

    const confirm = { ...request, headers: { ...request.headers, "x-okb-preview": result.preview } };
    expect((await call(endpoint, { ...confirm, body: "[]" })).status).toBe(400);
    expect((await call("api/conversations/upload?provider=claude", confirm)).status).toBe(400);
    const done = await call(endpoint, confirm);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ result: { imported: [id], planned: [], drafts: result.drafts } });
    const draft = await post("read_concept", { id });
    expect(await draft.json()).toMatchObject({ result: { frontmatter: { type: "conversation", status: "draft" }, body: expect.stringContaining("neighborhood library") } });
    const search = await post("search", { query: "neighborhood library", profile: "lean" });
    expect(await search.json()).toMatchObject({ result: [expect.objectContaining({ id })] });
    expect(readFileSync(join(bundle, "index.md"), "utf8")).not.toContain("Library planning");

    expect(await (await call(endpoint, confirm)).json()).toMatchObject({
      result: { imported: [], skipped: [{ row: 1, id, reason: "concept already exists" }] },
    });
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
    expect(bookmarklet).toContain(`token=${clipToken(ensureServeToken())}`);
    expect(bookmarklet).not.toContain(ensureServeToken());
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
  let chatCalls = 0;

  async function completedAnswer(response: Response): Promise<AskResult & { draftReceipt?: string }> {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
    let result: (AskResult & { draftReceipt?: string }) | undefined;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        expect(value.event).not.toBe("error");
        const data = JSON.parse(value.data);
        if (value.event === "done") result = data.result;
        else expect(data).not.toHaveProperty("draftReceipt");
      }
    } finally { reader.releaseLock(); }
    expect(result).toBeDefined();
    return result!;
  }

  beforeAll(() => {
    chat = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        chatCalls++;
        return Response.json({
          choices: [{ message: { content: "Databases are in [notes/alpha]." } }],
        });
      },
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
    expect(text).not.toContain('"draftReceipt"');
  });

  test("a missing question fails before the stream starts (plain 400)", async () => {
    const r = await call("api/ask/stream");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("question");
  });

  test("saves only the exact completed Ask answer to its writable brain and preserves edits on retry", async () => {
    const saved = loadConfig();
    const other = await mkdtemp(join(tmpdir(), "okb-ask-other-brain-"));
    const brain = "AskDraftHome";
    const otherBrain = "AskDraftOther";
    const configure = (path: string, readonly = false) => saveConfig({ ...saved, brains: {
      ...saved.brains, [brain]: { path, readonly }, [otherBrain]: { path: other },
    } });
    const ask = async (question: string) => completedAnswer(await call("api/ask/stream", {
      method: "POST", headers: { "content-type": "application/json", "x-okb-brain": brain }, body: JSON.stringify({ question }),
    }));
    const save = (body: unknown, options: { target?: string; name?: string; headers?: Record<string, string>; token?: string | null } = {}) =>
      fetch((options.target ?? base) + "api/ask/private-draft", {
        method: "POST", headers: { "content-type": "application/json", "x-okb-brain": options.name ?? brain,
          ...(options.token === null ? {} : { "x-okb-token": options.token ?? TOKEN }), ...options.headers },
        body: JSON.stringify(body),
      });
    const answerDirectory = join(bundle, "db_only", "answers");
    try {
      configure(bundle);
      const before = chatCalls;
      const result = await ask("databases");
      expect(result).toMatchObject({ answer: "Databases are in [notes/alpha].", provider: "ollama",
        citations: [{ id: "notes/alpha", title: "Alpha" }] });
      expect(typeof result.draftReceipt).toBe("string");
      const fallback = await ask("okbrainanswernoresultgzcixm");
      expect(fallback).toMatchObject({ provider: null, model: null, citations: [] });
      expect(fallback.draftReceipt).toBeUndefined();
      expect(chatCalls).toBe(before + 1);
      expect(existsSync(answerDirectory)).toBe(false);
      const payload = { receipt: result.draftReceipt!, question: "databases", answer: result.answer,
        citations: result.citations, provider: result.provider, model: result.model };
      for (const changes of [
        { question: "other databases" }, { answer: "An unapproved answer." },
        { citations: [...payload.citations, { id: "notes/other", title: "Other" }] },
        { citations: [{ id: "notes/alpha", title: "Changed citation title" }] },
        { provider: "openai" }, { model: result.model + "-new" }, { receipt: payload.receipt + "x" },
      ]) expect((await save({ ...payload, ...changes })).status).toBe(409);
      expect((await save(payload, { token: null, headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
      expect((await save(payload, { headers: { origin: "https://other.example" } })).status).toBe(403);
      expect((await save(payload, { name: otherBrain })).status).toBe(409);
      configure(other);
      expect((await save(payload)).status).toBe(409);
      expect(existsSync(join(other, "db_only"))).toBe(false);
      configure(bundle, true);
      expect((await save(payload)).status).toBe(403);
      expect((await ask("databases")).draftReceipt).toBeUndefined();
      configure(bundle);
      const restarted = createApiServer({ bundle, port: 0, token: TOKEN });
      try { expect((await save(payload, { target: restarted.url })).status).toBe(409); }
      finally { await restarted.stop(); }
      expect(existsSync(answerDirectory)).toBe(false);
      const callsBeforeSave = chatCalls;

      const responses = await Promise.all([save(payload), save(payload)]);
      const drafts = await Promise.all(responses.map(async (response) => {
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        return ((await response.json()) as { result: { id: string; created: boolean } }).result;
      }));
      const id = drafts[0]!.id;
      expect(id).toMatch(/^db_only\/answers\/[0-9a-f]{32}$/u);
      expect(drafts[1]!.id).toBe(id);
      expect(drafts.map(({ created }) => created).sort()).toEqual([false, true]);
      const file = Bun.file(join(bundle, `${id}.md`));
      const draft = parse(await file.text());
      expect(draft.frontmatter).toMatchObject({
        type: "note", status: "draft", db_only: true, tags: ["inbox", "ask"],
        generated: { by: `${result.provider}/${result.model}`, at: expect.any(String) },
        sources: [{ title: "Alpha", resource: "/notes/alpha.md" }],
        ask_receipt: { id: id.split("/").at(-1), provider: result.provider, model: result.model },
      });
      expect(draft.body.trimEnd()).toBe(`## Question\n\ndatabases\n\n## Answer\n\n${result.answer}`);
      expect(await Bun.file(join(bundle, "index.md")).text()).not.toContain(id);

      expect((await post("write_concept", { id, body: draft.body + "\nAn owner edit to keep." })).status).toBe(200);
      const edited = await file.text();
      expect(edited).toContain("An owner edit to keep.");
      expect(await (await save(payload)).json()).toEqual({ result: { id, created: false } });
      expect(await file.text()).toBe(edited);
      expect((await post("delete_concept", { id })).status).toBe(200);
      expect((await save(payload)).status).toBe(410);
      expect(await file.exists()).toBe(false);
      expect(chatCalls).toBe(callsBeforeSave);
    } finally {
      saveConfig(saved);
      await rm(other, { recursive: true, force: true });
    }
  });

  test("browser POST and CLI streaming both receive text before provider completion", async () => {
    const proceed = Promise.withResolvers<void>();
    let calls = 0;
    const provider = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const body = await request.json() as { stream?: boolean };
        expect(body.stream).toBe(true);
        calls++;
        const encode = (data: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
        return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(encode({ choices: [{ delta: { content: "Databases " } }] }));
            await proceed.promise;
            controller.enqueue(encode({ choices: [{ delta: { content: "[notes/alpha]" }, finish_reason: "stop" }] }));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    process.env.OKB_CHAT_BASE_URL = `http://127.0.0.1:${provider.port}`;
    try {
      const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "databases" }) };
      const foreign = await call("api/ask/stream", { ...request, headers: { ...request.headers, origin: "https://other.example" } });
      expect(foreign.status).toBe(403);
      const response = await call("api/ask/stream", request);
      const reader = response.body!.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
      expect((await reader.read()).value?.event).toBe("context");
      expect((await reader.read()).value).toMatchObject({ event: "delta", data: JSON.stringify({ text: "Databases " }) });

      const firstChunk = Promise.withResolvers<void>();
      const chunks: string[] = [];
      const cli = runCli(["--bundle", bundle, "ask", "databases", "--stream"], {
        out(text) { chunks.push(text); firstChunk.resolve(); },
        err() {},
      });
      await firstChunk.promise;
      expect(chunks).toEqual(["Databases "]);
      proceed.resolve();
      expect((await reader.read()).value?.event).toBe("delta");
      const answer = await reader.read();
      expect(answer.value?.event).toBe("answer");
      expect(JSON.parse(answer.value!.data).citations).toEqual([{ id: "notes/alpha", title: "Alpha" }]);
      const done = (await reader.read()).value;
      expect(done?.event).toBe("done");
      expect(JSON.parse(done!.data).result.draftReceipt).toEqual(expect.any(String));
      expect(await cli).toBe(0);
      expect(chunks.join("")).toContain("Databases [notes/alpha]\n\nsources:");
      expect(calls).toBe(2);
    } finally {
      proceed.resolve();
      await provider.stop(true);
      process.env.OKB_CHAT_BASE_URL = `http://127.0.0.1:${chat.port}`;
    }
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
