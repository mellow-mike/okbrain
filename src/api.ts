// Local HTTP API (3.1): a thin adapter generated over the ops contract, for
// the GUI (3.2) and the clip bookmarklet. Trusted like the CLI — but bound to
// 127.0.0.1 only, Host-checked (DNS rebinding), CORS locked to its own
// localhost origins, and every /api and /clip request must present the
// per-install token (CSRF fail-closed; see CONTEXT §Clip). `localOnly` ops
// (serve, bookmarklet, mcp, brains) are never exposed as ops; the GUI's
// server-side needs they cover are small dedicated routes instead (status,
// brain mounts by name, the bookmarklet), and a request may select a
// configured brain mount with `x-okb-brain` (read-only policy travels along).
//
// operations.ts imports this file for the `serve` op, so nothing here may
// touch an operations.ts binding at module top level (ESM cycle).

import { existsSync } from "node:fs";
import { AiError } from "./core/ai/gateway.ts";
import { ConfigError, listBrains, resolveBrain } from "./core/config.ts";
import { openLocalContext, type LocalContext } from "./core/context.ts";
import { defaultDbPath, EngineError } from "./core/engine/sqlite.ts";
import { SyncError } from "./core/sync.ts";
import { defaultVectorsPath } from "./core/engine/vectors.ts";
import { OKF_VERSION } from "./core/okf/indexmd.ts";
import {
  checkOpCall,
  getOp,
  OpError,
  operations,
  runOp,
  type Operation,
} from "./core/operations.ts";
import {
  bookmarkletJs,
  DEFAULT_PORT,
  ensureServeToken,
  hostAllowed,
  tokenMatches,
} from "./core/serve-token.ts";
import { VERSION } from "./core/version.ts";
import cytoscapeJs from "./core/viz/vendor/cytoscape.min.js" with { type: "text" };
import markedJs from "./core/viz/vendor/marked.umd.js" with { type: "text" };
import okbJs from "./core/viz/okb.js" with { type: "text" };
import renderJs from "./core/viz/render.js" with { type: "text" };
import safeMarkdownJs from "./core/viz/safe-markdown.js" with { type: "text" };
import tokensCss from "./core/viz/tokens.css" with { type: "text" };
import guiAppJs from "./gui/app.js" with { type: "text" };
import literataItalic from "./gui/fonts/Literata-Italic-VF.woff2" with { type: "file" };
import literata from "./gui/fonts/Literata-VF.woff2" with { type: "file" };
import recursiveMono from "./gui/fonts/RecursiveMono-VF.woff2" with { type: "file" };
import recursiveSans from "./gui/fonts/RecursiveSans-VF.woff2" with { type: "file" };
import guiIndexHtml from "./gui/index.html" with { type: "text" };
import guiStyleCss from "./gui/style.css" with { type: "text" };

const JS = "application/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const WOFF2 = "font/woff2";

/**
 * GUI static assets (tokenless, like `/`): body + content type per route.
 * Fonts are `file` imports — a path on disk in dev, embedded in the
 * compiled binary — read per request.
 */
const GUI_ASSETS: Record<string, [string | Blob, string]> = {
  "/gui/app.js": [guiAppJs, JS],
  "/gui/style.css": [guiStyleCss, CSS],
  "/gui/tokens.css": [tokensCss, CSS],
  "/gui/okb.js": [okbJs, JS],
  "/gui/cytoscape.js": [cytoscapeJs, JS],
  "/gui/marked.js": [markedJs, JS],
  "/gui/safe-markdown.js": [safeMarkdownJs, JS],
  "/gui/render.js": [renderJs, JS],
  "/gui/fonts/RecursiveSans-VF.woff2": [Bun.file(recursiveSans), WOFF2],
  "/gui/fonts/RecursiveMono-VF.woff2": [Bun.file(recursiveMono), WOFF2],
  "/gui/fonts/Literata-VF.woff2": [Bun.file(literata), WOFF2],
  "/gui/fonts/Literata-Italic-VF.woff2": [Bun.file(literataItalic), WOFF2],
};

export interface ApiOptions {
  bundle: string;
  /** Bind port on 127.0.0.1 (0 = ephemeral, for tests). */
  port?: number;
  /** Injectable for tests; default: the per-install serve token. */
  token?: string;
  /** Serving a read-only brain mount: write/admin ops are refused per request. */
  readonly?: boolean;
}

export interface ApiServer {
  url: string;
  port: number;
  token: string;
  stop(): void;
}

export { hostAllowed };

/** CORS reflection only for the server's own localhost origins. */
export function corsHeaders(
  origin: string | null,
  port: number,
): Record<string, string> | undefined {
  if (!["http://127.0.0.1", "http://localhost"].some((o) => origin === `${o}:${port}`))
    return undefined;
  return {
    "access-control-allow-origin": origin!,
    "access-control-allow-headers": "content-type, x-okb-token, x-okb-brain, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

type Hdrs = Record<string, string>;

/**
 * On every response: `/` embeds the serve token in the page, so a remote site
 * framing the GUI could drive authenticated write ops with hijacked clicks.
 * nosniff keeps the static assets from being re-typed by the browser.
 */
const GUARD: Hdrs = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

const json = (status: number, body: unknown, headers: Hdrs = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...GUARD, ...headers },
  });

const html = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...GUARD },
  });

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const OP_STATUS: Record<OpError["code"], number> = {
  untrusted: 403,
  bad_params: 400,
  not_found: 404,
  refused: 403,
};

// Operational failures the caller can act on ("run okb index first", git
// state, an unreachable provider) are not server faults: 409 / 502, with
// the same actionable message the CLI prints; anything unexpected is a 500.
const errStatus = (e: unknown): number =>
  e instanceof OpError
    ? OP_STATUS[e.code]
    : e instanceof ConfigError
      ? 400
      : e instanceof EngineError || e instanceof SyncError
        ? 409
        : e instanceof AiError
          ? 502
          : 500;

const errBody = (e: unknown): { error: string; code?: string } =>
  e instanceof OpError
    ? { error: e.message, code: e.code }
    : { error: e instanceof Error ? e.message : String(e) };

const clipPage = (message: string, ok: boolean): string =>
  "<!doctype html><meta charset=utf-8><title>okb clip</title>" +
  `<body style='font-family:system-ui;margin:2rem'><p>${esc(message)}</p>` +
  (ok ? "<script>setTimeout(()=>window.close(),1500)</script>" : "");

/** Public op descriptors for surface generation (GUI forms, MCP tools). */
const opDescriptors = (): unknown =>
  operations
    .filter((o) => !o.localOnly)
    .map(({ name, summary, scope, params }) => ({ name, summary, scope, params }));

interface ServeState {
  bundle: string;
  port: number;
  token: string;
  readonly: boolean;
}

/** The bundle a request addresses: the served one, or a named brain mount. */
interface Scope {
  bundle: string;
  readonly: boolean;
  brain: string | null;
}

/** Resolve `x-okb-brain` / `?brain=` to a mount (ConfigError on unknown names). */
function scopeOf(req: Request, url: URL, o: ServeState): Scope {
  const name = req.headers.get("x-okb-brain") ?? url.searchParams.get("brain");
  if (name === null || name === "") return { bundle: o.bundle, readonly: o.readonly, brain: null };
  const brain = resolveBrain(name);
  return { bundle: brain.path, readonly: brain.readonly, brain: name };
}

const open = (s: Scope): LocalContext => openLocalContext(s.bundle, true, s.readonly);

async function runJsonOp(
  op: Operation,
  scope: Scope,
  raw: Record<string, unknown>,
  cors: Hdrs = {},
): Promise<Response> {
  const local = open(scope);
  try {
    return json(200, { result: await runOp(op, local.ctx, raw) }, cors);
  } catch (e) {
    return json(errStatus(e), errBody(e), cors);
  } finally {
    local.close();
  }
}

function sse(local: LocalContext, run: (send: (event: string, data: unknown) => void) => Promise<unknown>, cors: Hdrs = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        send("done", { result: await run(send) });
      } catch (e) {
        send("error", errBody(e));
      } finally {
        controller.close();
        local.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...GUARD, ...cors },
  });
}

function askStream(url: URL, scope: Scope, cors: Hdrs): Response {
  const op = getOp("ask")!;
  const raw: Record<string, unknown> = {};
  for (const k of ["question", "profile"]) {
    const v = url.searchParams.get(k);
    if (v !== null) raw[k] = v;
  }
  const local = open(scope);
  try {
    const params = checkOpCall(op, local.ctx, raw);
    return sse(local, (send) => op.stream!(local.ctx, params, send), cors);
  } catch (e) {
    local.close();
    return json(errStatus(e), errBody(e), cors);
  }
}

async function clipNav(url: URL, scope: Scope): Promise<Response> {
  const op = getOp("clip")!;
  const raw: Record<string, unknown> = {};
  for (const k of ["url", "quote", "note", "tags"]) {
    const v = url.searchParams.get(k);
    if (v !== null && v !== "") raw[k] = v;
  }
  const local = open(scope);
  try {
    const result = await runOp(op, local.ctx, raw);
    return html(200, clipPage(op.render(result), true));
  } catch (e) {
    return html(errStatus(e), clipPage(errBody(e).error, false));
  } finally {
    local.close();
  }
}

/** What the GUI needs to describe the server it talks to (no mount paths beyond the active bundle). */
function status(scope: Scope, o: ServeState): unknown {
  const local = open(scope);
  try {
    return {
      version: VERSION,
      okfVersion: OKF_VERSION,
      bundle: scope.bundle,
      brain: scope.brain,
      readonly: scope.readonly,
      hasIndex: existsSync(defaultDbPath(scope.bundle)),
      hasVectors: existsSync(defaultVectorsPath(scope.bundle)),
      actor: local.ctx.actor(),
      port: o.port,
    };
  } finally {
    local.close();
  }
}

export async function handleRequest(req: Request, opts: ServeState): Promise<Response> {
  const url = new URL(req.url);
  if (!hostAllowed(req.headers.get("host"), opts.port))
    return json(403, { error: "host not allowed (localhost only)" });
  const cors = corsHeaders(req.headers.get("origin"), opts.port);
  if (req.method === "OPTIONS")
    return new Response(null, { status: cors ? 204 : 403, headers: cors });
  if (req.method === "GET") {
    // The GUI bootstrap: `/` embeds the token for the app's API calls (local
    // processes can read the token file anyway; remote pages can't read this
    // response). The assets are static code — tokenless like `/`.
    if (url.pathname === "/")
      return html(200, guiIndexHtml.replace("__OKB_TOKEN__", opts.token));
    const asset = GUI_ASSETS[url.pathname];
    if (asset)
      return new Response(asset[0], { headers: { "content-type": asset[1], ...GUARD } });
    // Browsers request this unprompted; a 401/404 here is just console noise.
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  }

  const presented =
    req.headers.get("x-okb-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("token");
  if (!tokenMatches(presented, opts.token))
    return json(401, { error: "missing or invalid token (see okb bookmarklet / serve)" }, cors);

  let scope: Scope;
  try {
    scope = scopeOf(req, url, opts);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return json(400, { error: e.message }, cors);
  }

  if (req.method === "GET") {
    if (url.pathname === "/api/ops") return json(200, { ops: opDescriptors() }, cors);
    if (url.pathname === "/api/status") return json(200, status(scope, opts), cors);
    if (url.pathname === "/api/brains")
      try {
        // Names and policy only — mount paths are host topology (5.2 decision).
        const brains = listBrains().map((b) => ({
          name: b.name,
          readonly: b.readonly,
          exists: existsSync(b.path),
          active: b.path === scope.bundle,
        }));
        return json(200, { brains }, cors);
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        return json(400, { error: e.message }, cors);
      }
    if (url.pathname === "/api/bookmarklet")
      return json(200, { port: opts.port, bookmarklet: bookmarkletJs(opts.port, opts.token) }, cors);
    if (url.pathname === "/api/ask/stream") return askStream(url, scope, cors ?? {});
    if (url.pathname === "/clip") return clipNav(url, scope);
  }

  const m = /^\/api\/op\/([a-z_]+)$/.exec(url.pathname);
  if (m && req.method === "POST") {
    const op = operations.find((o) => o.name === m[1] && !o.localOnly);
    if (!op) return json(404, { error: `unknown op: ${m[1]}` }, cors);
    let raw: unknown;
    try {
      const text = await req.text();
      raw = text === "" ? {} : JSON.parse(text);
    } catch {
      return json(400, { error: "request body must be JSON" }, cors);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return json(400, { error: "request body must be a JSON object of parameters" }, cors);
    return runJsonOp(op, scope, raw as Record<string, unknown>, cors);
  }

  return json(404, { error: "not found" }, cors);
}

export function createApiServer(opts: ApiOptions): ApiServer {
  const token = opts.token ?? ensureServeToken();
  const { bundle, readonly = false } = opts;
  const wanted = opts.port ?? DEFAULT_PORT;
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: wanted,
      fetch: (req) => handleRequest(req, { bundle, port: server.port!, token, readonly }),
    });
  } catch (e) {
    if ((e as { code?: string }).code === "EADDRINUSE")
      throw new Error(
        `port ${wanted} is already in use (another okb serve?) — pick one with --port`,
      );
    throw e;
  }
  const port = server.port!;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    stop: () => server.stop(true),
  };
}
