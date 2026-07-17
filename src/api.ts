// Local HTTP API (3.1): a thin adapter generated over the ops contract, for
// the GUI (3.2) and the clip bookmarklet. Trusted like the CLI — but bound to
// 127.0.0.1 only, Host-checked (DNS rebinding), CORS locked to its own
// localhost origins, and every /api and /clip request must present the
// per-install token (CSRF fail-closed; see CONTEXT §Clip). `localOnly` ops
// (serve, bookmarklet) are never exposed.
//
// operations.ts imports this file for the `serve` op, so nothing here may
// touch an operations.ts binding at module top level (ESM cycle).

import { openLocalContext, type LocalContext } from "./core/context.ts";
import {
  checkOpCall,
  getOp,
  OpError,
  operations,
  runOp,
  type Operation,
} from "./core/operations.ts";
import { DEFAULT_PORT, ensureServeToken, tokenMatches } from "./core/serve-token.ts";

export interface ApiOptions {
  bundle: string;
  /** Bind port on 127.0.0.1 (0 = ephemeral, for tests). */
  port?: number;
  /** Injectable for tests; default: the per-install serve token. */
  token?: string;
}

export interface ApiServer {
  url: string;
  port: number;
  token: string;
  stop(): void;
}

/** Only the server's own host names defeat DNS rebinding. */
export function hostAllowed(host: string | null, port: number): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].some((h) => host === `${h}:${port}`);
}

/** CORS reflection only for the server's own localhost origins. */
export function corsHeaders(
  origin: string | null,
  port: number,
): Record<string, string> | undefined {
  if (!["http://127.0.0.1", "http://localhost"].some((o) => origin === `${o}:${port}`))
    return undefined;
  return {
    "access-control-allow-origin": origin!,
    "access-control-allow-headers": "content-type, x-okb-token, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

type Hdrs = Record<string, string>;

const json = (status: number, body: unknown, headers: Hdrs = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const html = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const OP_STATUS: Record<OpError["code"], number> = {
  untrusted: 403,
  bad_params: 400,
  not_found: 404,
  refused: 403,
};

const errStatus = (e: unknown): number => (e instanceof OpError ? OP_STATUS[e.code] : 500);

const errBody = (e: unknown): { error: string; code?: string } =>
  e instanceof OpError
    ? { error: e.message, code: e.code }
    : { error: e instanceof Error ? e.message : String(e) };

const PLACEHOLDER =
  "<!doctype html><meta charset=utf-8><title>okbrain</title>" +
  "<body style='font-family:system-ui;margin:3rem'><h1>okbrain</h1>" +
  "<p>The GUI arrives with Stage 3.2. The local API is live under <code>/api</code> " +
  "(per-install token required; see <code>okb bookmarklet</code> for clipping).</p>";

const clipPage = (message: string, ok: boolean): string =>
  "<!doctype html><meta charset=utf-8><title>okb clip</title>" +
  `<body style='font-family:system-ui;margin:2rem'><p>${esc(message)}</p>` +
  (ok ? "<script>setTimeout(()=>window.close(),1500)</script>" : "");

/** Public op descriptors for surface generation (GUI forms, MCP tools). */
export const opDescriptors = (): unknown =>
  operations
    .filter((o) => !o.localOnly)
    .map(({ name, summary, scope, params }) => ({ name, summary, scope, params }));

async function runJsonOp(
  op: Operation,
  bundle: string,
  raw: Record<string, unknown>,
  cors: Hdrs = {},
): Promise<Response> {
  const local = openLocalContext(bundle);
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
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...cors },
  });
}

function askStream(url: URL, bundle: string, cors: Hdrs): Response {
  const op = getOp("ask")!;
  const raw: Record<string, unknown> = {};
  for (const k of ["question", "profile"]) {
    const v = url.searchParams.get(k);
    if (v !== null) raw[k] = v;
  }
  const local = openLocalContext(bundle);
  try {
    const params = checkOpCall(op, local.ctx, raw);
    return sse(local, (send) => op.stream!(local.ctx, params, send), cors);
  } catch (e) {
    local.close();
    return json(errStatus(e), errBody(e), cors);
  }
}

async function clipNav(url: URL, bundle: string): Promise<Response> {
  const op = getOp("clip")!;
  const raw: Record<string, unknown> = {};
  for (const k of ["url", "quote", "note", "tags"]) {
    const v = url.searchParams.get(k);
    if (v !== null && v !== "") raw[k] = v;
  }
  const local = openLocalContext(bundle);
  try {
    const result = await runOp(op, local.ctx, raw);
    return html(200, clipPage(op.render(result), true));
  } catch (e) {
    return html(errStatus(e), clipPage(errBody(e).error, false));
  } finally {
    local.close();
  }
}

export async function handleRequest(
  req: Request,
  opts: { bundle: string; port: number; token: string },
): Promise<Response> {
  const url = new URL(req.url);
  if (!hostAllowed(req.headers.get("host"), opts.port))
    return json(403, { error: "host not allowed (localhost only)" });
  const cors = corsHeaders(req.headers.get("origin"), opts.port);
  if (req.method === "OPTIONS")
    return new Response(null, { status: cors ? 204 : 403, headers: cors });
  if (url.pathname === "/" && req.method === "GET") return html(200, PLACEHOLDER);

  const presented =
    req.headers.get("x-okb-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("token");
  if (!tokenMatches(presented, opts.token))
    return json(401, { error: "missing or invalid token (see okb bookmarklet / serve)" }, cors);

  if (url.pathname === "/api/ops" && req.method === "GET")
    return json(200, { ops: opDescriptors() }, cors);
  if (url.pathname === "/api/ask/stream" && req.method === "GET")
    return askStream(url, opts.bundle, cors ?? {});
  if (url.pathname === "/clip" && req.method === "GET") return clipNav(url, opts.bundle);

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
    return runJsonOp(op, opts.bundle, raw as Record<string, unknown>, cors);
  }

  return json(404, { error: "not found" }, cors);
}

export function createApiServer(opts: ApiOptions): ApiServer {
  const token = opts.token ?? ensureServeToken();
  const bundle = opts.bundle;
  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? DEFAULT_PORT,
    fetch: (req) => handleRequest(req, { bundle, port: server.port!, token }),
  });
  const port = server.port!;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    stop: () => server.stop(true),
  };
}
