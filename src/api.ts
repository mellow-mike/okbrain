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

import { existsSync, realpathSync, statSync } from "node:fs";
import { BrowserPlanInputError, createBrowserPlan, type BrowserPlan } from "./core/ai/browser-plan.ts";
import type { PlanOptions } from "./core/ai/chatgpt-plan.ts";
import { providerKeyStatus, setProviderKey } from "./core/ai/local-keys.ts";
import { AiError, providersFor } from "./core/ai/gateway.ts";
import { CodingError, CodingHandoffError, CodingSessionMissingError } from "./core/coding/durable.ts";
import { CodingProjectProfileError } from "./core/coding/project-profile.ts";
import { codingProjectCatalogPath, CodingProjectControl, ProjectControlError, readCodingTeamStartup, readCodingTeamStartupPort, type ProjectControlOptions } from "./core/coding/project-control.ts";
import { RepositoryContextError } from "./core/coding/repository-context.ts";
import { StandaloneCodingControl, StandaloneControlError } from "./core/coding/standalone-control.ts";
import { CodingTeamListener, type TeamStatus } from "./core/coding/team-listener.ts";
import { BrainMountError } from "./core/brain-mounts.ts";
import { configForBrain, ConfigError, listBrains, loadConfig, resolveBrain, UnknownBrainError } from "./core/config.ts";
import { localBundleWatchBackend, openLocalContext, type LocalContext } from "./core/context.ts";
import { BundleWatcher } from "./core/engine/bundle-watch.ts";
import { EngineError } from "./core/engine/sqlite.ts";
import { MaintenanceScheduleError, MaintenanceScheduler, maintenanceJobNames, type MaintenanceJobName, type MaintenanceSchedulerOptions, type MaintenanceTarget } from "./core/jobs/schedule.ts";
import { SyncError, syncGitHubCredential } from "./core/sync.ts";
import { MAX_CONVERSATION_EXPORT_BYTES } from "./core/ingest/conversations.ts";
import { createNotionSource, NotionSourceError, type NotionSource, type NotionSourceOptions } from "./core/ingest/notion-source.ts";
import { isOfflineSourceKind, MAX_OFFLINE_FILE_BYTES, MAX_SOURCE_FILES, MAX_SOURCE_ROWS, MAX_SOURCE_UPLOAD_BYTES } from "./core/ingest/personal-sources.ts";
import { OKF_VERSION } from "./core/okf/indexmd.ts";
import { AskDraftError } from "./core/retrieval/ask-draft.ts";
import { AskDraftReceiptError, AskDraftReceipts, maxAskDraftRequestBytes } from "./core/retrieval/ask-draft-receipts.ts";
import type { AskResult } from "./core/retrieval/ask.ts";
import {
  checkOpCall,
  getOp,
  maintenanceApprovals,
  OpError,
  operations,
  runAskDraftSave,
  runBrainMountChange,
  runBrainRestore,
  runConversationUpload,
  runNotionSource,
  runOp,
  runPersonalSourceUpload,
  runRssSettings,
  runScheduledMaintenance,
  type Operation,
} from "./core/operations.ts";
import {
  bookmarkletJs,
  DEFAULT_PORT,
  ensureServeToken,
  hostAllowed,
  tokenMatches,
} from "./core/serve-token.ts";
import { TOOL_ACTOR, VERSION } from "./core/version.ts";
import { ManagedMcpHttp, ManagedMcpHttpError } from "./mcp/managed-http.ts";
import { fontAssets, hostedFontCss } from "./core/viz/fonts.ts";
import cytoscapeJs from "./core/viz/vendor/cytoscape.min.js" with { type: "text" };
import markedJs from "./core/viz/vendor/marked.umd.js" with { type: "text" };
import okbJs from "./core/viz/okb.js" with { type: "text" };
import graphViewJs from "./core/viz/graph-view.js" with { type: "text" };
import renderJs from "./core/viz/render.js" with { type: "text" };
import safeMarkdownJs from "./core/viz/safe-markdown.js" with { type: "text" };
import tokensCss from "./core/viz/tokens.css" with { type: "text" };
import guiAppJs from "./gui/app.js" with { type: "text" };
import guiComputationJs from "./gui/computation.js" with { type: "text" };
import guiMcpSettingsJs from "./gui/mcp-settings.js" with { type: "text" };
import guiCodingJs from "./gui/coding.js" with { type: "text" };
import guiCodingStandaloneJs from "./gui/coding-standalone.js" with { type: "text" };
import guiCodingEvaluationJs from "./gui/coding-evaluation.js" with { type: "text" };
import guiGithubJs from "./gui/github.js" with { type: "text" };
import guiNotionJs from "./gui/notion.js" with { type: "text" };
import guiCodingCss from "./gui/coding.css" with { type: "text" };
import codingTeamHtmlAsset from "./gui/coding-team.html" with { type: "text" };
import guiAccountsJs from "./gui/accounts.js" with { type: "text" };
import guiFocusedMapJs from "./gui/focused-map.js" with { type: "text" };
import indexHtmlAsset from "./gui/index.html" with { type: "text" };
import guiStyleCss from "./gui/style.css" with { type: "text" };

// Bun's wildcard HTML declaration describes its HTML loader. The explicit
// text loader used here returns the original asset even in compiled builds.
function htmlAsset(asset: unknown): string {
  if (typeof asset !== "string") throw new TypeError("Expected a bundled HTML text asset.");
  return asset;
}

const guiCodingTeamHtml = htmlAsset(codingTeamHtmlAsset);
const guiIndexHtml = htmlAsset(indexHtmlAsset);
const JS = "application/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";

/**
 * GUI static assets (tokenless, like `/`): body + content type per route.
 * Fonts are `file` imports — a path on disk in dev, embedded in the
 * compiled binary — read per request.
 */
const GUI_ASSETS: Record<string, readonly [string | Blob, string]> = {
  "/gui/app.js": [guiAppJs, JS],
  "/gui/computation.js": [guiComputationJs, JS],
  "/gui/mcp-settings.js": [guiMcpSettingsJs, JS],
  "/gui/coding.js": [guiCodingJs, JS],
  "/gui/coding-standalone.js": [guiCodingStandaloneJs, JS],
  "/gui/coding-evaluation.js": [guiCodingEvaluationJs, JS],
  "/gui/github.js": [guiGithubJs, JS],
  "/gui/notion.js": [guiNotionJs, JS],
  "/gui/coding.css": [guiCodingCss, CSS],
  "/gui/accounts.js": [guiAccountsJs, JS],
  "/gui/focused-map.js": [guiFocusedMapJs, JS],
  "/gui/style.css": [`${hostedFontCss}\n${guiStyleCss}`, CSS],
  "/gui/tokens.css": [tokensCss, CSS],
  "/gui/okb.js": [okbJs, JS],
  "/gui/graph-view.js": [graphViewJs, JS],
  "/gui/cytoscape.js": [cytoscapeJs, JS],
  "/gui/marked.js": [markedJs, JS],
  "/gui/safe-markdown.js": [safeMarkdownJs, JS],
  "/gui/render.js": [renderJs, JS],
  ...Object.fromEntries(fontAssets),
};

export interface ApiOptions {
  bundle: string;
  /** Original named mount when serving with `okb --brain`. */
  servedBrain?: string;
  /** Bind port on 127.0.0.1 (0 = ephemeral, for tests). */
  port?: number;
  /** Injectable for tests; default: the per-install serve token. */
  token?: string;
  /** Serving a read-only brain mount: write/admin ops are refused per request. */
  readonly?: boolean;
  chatgpt?: Pick<PlanOptions, "path" | "fetch">;
  coding?: ProjectControlOptions;
  standaloneCoding?: ConstructorParameters<typeof StandaloneCodingControl>[0];
  notion?: NotionSourceOptions;
  maintenance?: Pick<MaintenanceSchedulerOptions, "now" | "path" | "intervalMs">;
}

export interface ApiServer {
  url: string;
  port: number;
  token: string;
  stop(): Promise<void>;
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
    "access-control-allow-headers": "content-type, x-okb-token, x-okb-brain, x-okb-preview, authorization",
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
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...GUARD },
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
  e instanceof UnknownBrainError
    ? { error: e.message, code: "unknown_brain" }
    : e instanceof OpError
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
  mcp?: ManagedMcpHttp;
  coding?: () => CodingProjectControl;
  standalone?: StandaloneCodingControl;
  notion?: NotionSource;
  team?: CodingTeamListener;
  projectTokensOnly?: boolean;
  bundle: string;
  servedBrain?: string;
  watches?: Map<string | null, BundleWatcher>;
  maintenance?: MaintenanceScheduler;
  maintenanceAllowed?: (target: MaintenanceTarget) => boolean;
  port: number;
  token: string;
  readonly: boolean;
  plan?: BrowserPlan;
  askDrafts?: AskDraftReceipts;
}

/** The bundle a request addresses: the served one, or a named brain mount. */
interface Scope {
  bundle: string;
  readonly: boolean;
  brain: string | null;
  /** Name configured on the served bundle when no browser mount is selected. */
  servedBrain?: string;
}

/** Resolve `x-okb-brain` / `?brain=` to a mount (ConfigError on unknown names). */
function scopeOf(req: Request, url: URL, o: ServeState): Scope {
  const name = req.headers.get("x-okb-brain") ?? url.searchParams.get("brain");
  if (name === null || name === "") {
    if (!o.servedBrain) return { bundle: o.bundle, readonly: o.readonly, brain: null };
    const mount = resolveBrain(o.servedBrain);
    if (mount.path !== o.bundle) throw new ConfigError("The served brain folder changed. Restart okbrain to use its new path.");
    return { bundle: o.bundle, readonly: o.readonly || mount.readonly, brain: null, servedBrain: o.servedBrain };
  }
  const brain = resolveBrain(name);
  return { bundle: brain.path, readonly: o.readonly || brain.readonly, brain: name };
}

const open = (s: Scope): LocalContext => {
  const local = openLocalContext(s.bundle, true, s.readonly);
  local.ctx.brain = s.brain ?? s.servedBrain;
  return local;
};

function maintenanceTarget(scope: Scope): MaintenanceTarget {
  if (!mountIsAvailable(scope.bundle)) throw new ConfigError("The selected brain folder is unavailable.");
  return { path: realpathSync.native(scope.bundle), brain: scope.brain ?? scope.servedBrain ?? null };
}

function maintenancePathMatches(path: string, bound: string): boolean {
  const canonical = realpathSync.native(path);
  return process.platform === "win32" ? canonical.toLowerCase() === bound.toLowerCase() : canonical === bound;
}

async function maintenanceRequest(req: Request, url: URL, opts: ServeState, cors?: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
    return json(401, { error: "missing or invalid local app token" }, headers);
  if (req.headers.has("origin") && !cors)
    return json(403, { error: "Maintenance settings must come from the local app." }, headers);
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "Method not allowed." }, headers);
  try {
    let input: Record<string, unknown> | undefined;
    if (req.method === "POST") {
      if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
        return json(415, { error: "Send a JSON object." }, headers);
      const raw = await readUpload(req, 4096, "Maintenance settings exceed 4 KiB.");
      let value: unknown;
      try { value = JSON.parse(raw.toString("utf8")); } catch { /* Handled below. */ }
      if (!value || typeof value !== "object" || Array.isArray(value)) return json(400, { error: "Send a JSON object." }, headers);
      input = value as Record<string, unknown>;
    }
    const scope = scopeOf(req, url, opts);
    const target = maintenanceTarget(scope);
    const allowed = opts.maintenanceAllowed!;
    if (input && (scope.readonly || !allowed(target)))
      return json(403, { error: "Open a writable brain to change its maintenance schedule." }, headers);
    const local = open(scope);
    try {
      const { embedding, rss } = await maintenanceApprovals(local.ctx);
      const scheduler = opts.maintenance!;
      if (input) {
        if (!allowed(target)) return json(403, { error: "The selected brain changed or is read-only." }, headers);
        if (input.action === "pause") scheduler.pause(target);
        else if (input.action === "remove") scheduler.remove(target);
        else if (input.action === "save") {
          const { cadence, jobs, approvals: rawApprovals } = input;
          if (cadence !== "6h" && cadence !== "daily" && cadence !== "weekly")
            return json(400, { error: "Choose how often the schedule should run." }, headers);
          if (!Array.isArray(jobs) || !jobs.length || new Set(jobs).size !== jobs.length ||
              jobs.some((job) => !maintenanceJobNames.includes(job)))
            return json(400, { error: "Choose at least one available maintenance job." }, headers);
          if (rawApprovals !== undefined && (!rawApprovals || typeof rawApprovals !== "object" || Array.isArray(rawApprovals)))
            return json(400, { error: "Review the current maintenance job approvals." }, headers);
          const supplied = (rawApprovals ?? {}) as Record<string, unknown>;
          if ((jobs.includes("embed") && (!embedding || supplied.embed !== embedding.id)) ||
              (jobs.includes("rss") && (!rss || supplied.rss !== rss.id)))
            return json(409, { error: "Review and approve the current embedding or RSS settings before scheduling these jobs." }, headers);
          const approvals = { ...(jobs.includes("embed") && embedding ? { embed: embedding.id } : {}),
            ...(jobs.includes("rss") && rss ? { rss: rss.id } : {}) };
          scheduler.save(target, { cadence, jobs: jobs as MaintenanceJobName[], approvals });
        } else return json(400, { error: "Choose Save, Pause, or Remove schedule." }, headers);
      }
      const row = scheduler.get(target);
      const schedule = row ? { cadence: row.cadence, jobs: row.jobs, enabled: row.enabled,
        nextAt: row.nextAt, lastRun: row.lastRun, bindingAvailable: allowed(row.target) } : null;
      return json(200, { result: { schedule,
        embedding: embedding && { ...embedding, approved: row?.approvals?.embed === embedding.id },
        rss: rss && { ...rss, approved: row?.approvals?.rss === rss.id },
      } }, headers);
    } finally { await local.close(); }
  } catch (e) {
    const status = e instanceof UploadTooLarge ? 413 : e instanceof MaintenanceScheduleError ? e.status : errStatus(e);
    return json(status, status === 500 ? { error: "Could not open or update the local maintenance schedule." } : errBody(e), headers);
  }
}

async function bundleWatchRequest(req: Request, url: URL, opts: ServeState, cors?: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
    return json(401, { error: "missing or invalid local app token" }, headers);
  if (req.headers.has("origin") && !cors)
    return json(403, { error: "Watch settings must come from the local app." }, headers);
  const watches = opts.watches!;
  try {
    if (req.method === "GET") {
      return json(200, { result: watches.get(scopeOf(req, url, opts).brain)?.status() ?? null }, headers);
    }
    if (req.method !== "POST") return json(405, { error: "Method not allowed." }, headers);
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return json(415, { error: "Send a JSON object." }, headers);
    const raw = await readUpload(req, 4096, "Watch settings exceed 4 KiB.");
    let action: unknown;
    try { action = JSON.parse(raw.toString("utf8"))?.action; } catch { /* handled below */ }
    if (action !== "stop" && action !== "start")
      return json(400, { error: "Choose Start or Stop for bundle watching." }, headers);
    // The selected mount can change while we read the request body.
    const scope = scopeOf(req, url, opts);
    const prior = watches.get(scope.brain);
    if (action === "stop") {
      await prior?.stop();
      return json(200, { result: prior?.status() ?? null }, headers);
    }
    const local = open(scope);
    try { checkOpCall(getOp("watch_index")!, local.ctx, {}); }
    finally { await local.close(); }
    const name = scope.brain ?? opts.servedBrain;
    const canWrite = (): boolean => {
      if (!name) return true;
      const mount = resolveBrain(name);
      return mount.path === scope.bundle && !mount.readonly;
    };
    if (!canWrite()) return json(403, { error: "The brain mount changed or is read-only." }, headers);
    if (prior?.status().active) return json(200, { result: prior.status() }, headers);
    const watcher = new BundleWatcher(scope.bundle, canWrite, localBundleWatchBackend);
    watches.set(scope.brain, watcher);
    return json(200, { result: watcher.status() }, headers);
  } catch (error) {
    return json(error instanceof UploadTooLarge ? 413 : errStatus(error), errBody(error), headers);
  }
}

function mountIsAvailable(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

async function brainMountRequest(req: Request, url: URL, opts: ServeState, cors: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
    return json(401, { error: "missing or invalid local app token" }, headers);
  if (req.headers.has("origin") && !cors["access-control-allow-origin"])
    return json(403, { error: "Mount changes must come from the local app." }, headers);
  if (req.method !== "POST") return json(405, { error: "Method not allowed." }, headers);
  if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return json(415, { error: "Send a JSON object." }, headers);
  try {
    const raw = await readUpload(req, 16 * 1024, "Brain mount request exceeds 16 KiB.");
    let body: unknown;
    try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return json(400, { error: "Send a JSON object." }, headers);
    // Recheck the mount after reading the request. A concurrent policy
    // change can take effect while the request body is streaming.
    const scope = scopeOf(req, url, opts);
    const local = open(scope);
    try {
      const input = body as Record<string, unknown>;
      if (url.pathname === "/api/brains") {
        if (input.action !== "restore") return json(400, { error: "Choose Restore from GitHub." }, headers);
        const canWrite = () => {
          try {
            const current = scopeOf(req, url, opts);
            return current.bundle === scope.bundle && !current.readonly;
          } catch { return false; }
        };
        return json(200, { result: await runBrainRestore(local.ctx, input, canWrite, opts.bundle) }, headers);
      }
      return json(200, { result: runBrainMountChange(local.ctx, input) }, headers);
    } finally {
      await local.close();
    }
  } catch (error) {
    return json(error instanceof BrainMountError ? error.status : error instanceof UploadTooLarge ? 413 : errStatus(error), errBody(error), headers);
  }
}

async function managedMcpRequest(req: Request, opts: ServeState, scope: Scope, cors?: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
    return json(401, { error: "missing or invalid local app token" }, headers);
  if (req.headers.has("origin") && !cors)
    return json(403, { error: "MCP HTTP settings must come from the local app." }, headers);
  const mcp = opts.mcp!;
  if (req.method === "GET") return json(200, { result: mcp.status() }, headers);
  if (req.method !== "POST") return json(405, { error: "Method not allowed." }, headers);
  if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return json(415, { error: "Send a JSON object." }, headers);
  try {
    const raw = await readUpload(req, 4096, "MCP settings exceed 4 KiB.");
    let params: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      params = value as Record<string, unknown>;
    } catch {
      return json(400, { error: "Send a JSON object." }, headers);
    }
    if (params.action === "stop") {
      await mcp.stop();
      return json(200, { result: null }, headers);
    }
    if (params.action !== "start") return json(400, { error: "Choose Start or Stop for MCP HTTP." }, headers);
    const mount = { ...scope, brain: scope.brain ?? scope.servedBrain ?? null, readonly: opts.readonly || scope.readonly };
    const result = mcp.start(params, mount, () => {
      if (!mount.brain) return mount;
      const current = resolveBrain(mount.brain);
      return { brain: mount.brain, bundle: current.path, readonly: opts.readonly || current.readonly };
    });
    return json(200, { result }, headers);
  } catch (error) {
    const status = error instanceof ManagedMcpHttpError ? error.status : error instanceof UploadTooLarge ? 413 : 500;
    return json(status, status === 500 ? { error: "Could not change the MCP HTTP listener." } : errBody(error), headers);
  }
}

async function providerKeys(req: Request, scope: Scope, cors: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  try {
    if (req.method === "POST") {
      if (scope.readonly) return json(403, { error: "Open Settings from a writable brain to change provider keys." }, headers);
      const raw = await readUpload(req, 6 * 1024, "Provider setup request is too large.");
      const body: unknown = JSON.parse(raw.toString("utf8"));
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Expected a JSON object.");
      const { provider, key } = body as Record<string, unknown>;
      setProviderKey(provider, key);
    } else if (req.method !== "GET") return json(405, { error: "Method not allowed." }, headers);
    return json(200, { result: providerKeyStatus() }, headers);
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError || error instanceof UploadTooLarge)
      return json(400, errBody(error), headers);
    return json(409, { error: "Could not use the local provider credential store." }, headers);
  }
}

async function syncGitHubRequest(req: Request, url: URL, opts: ServeState, cors: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
    return json(401, { error: "missing or invalid local app token" }, headers);
  if (req.headers.has("origin") && !cors["access-control-allow-origin"])
    return json(403, { error: "GitHub credentials must come from the local app." }, headers);
  if (req.method !== "POST") return json(405, { error: "Method not allowed." }, headers);
  if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return json(415, { error: "Send a JSON object." }, headers);
  try {
    const selected = scopeOf(req, url, opts);
    const raw = await readUpload(req, 4096, "GitHub credential request exceeds 4 KiB.");
    let body: unknown;
    try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return json(400, { error: "Send a JSON object." }, headers);
    const { action, login, token } = body as Record<string, unknown>;
    if (action !== "status" && action !== "save" && action !== "remove")
      return json(400, { error: "Choose a GitHub credential action." }, headers);
    if (action === "save" && (typeof login !== "string" || typeof token !== "string"))
      return json(400, { error: "Enter a GitHub username and token." }, headers);
    const requireCurrentWrite = () => {
      let writable = false;
      try {
        const current = scopeOf(req, url, opts);
        writable = !selected.readonly && !current.readonly && current.bundle === selected.bundle;
      } catch { /* The request's original brain is no longer selected. */ }
      if (!writable) throw new OpError("Open Git sync from a writable brain to manage its GitHub credential.", "refused");
      return true;
    };
    requireCurrentWrite();
    const result = await syncGitHubCredential(selected.bundle, action === "save"
      ? { action, login: login as string, token: token as string } : { action }, requireCurrentWrite);
    return json(200, { result }, headers);
  } catch (error) {
    if (error instanceof UploadTooLarge) return json(413, errBody(error), headers);
    if (error instanceof TypeError) return json(400, { error: "Enter a valid GitHub username and fine-grained token." }, headers);
    if (error instanceof ConfigError || error instanceof SyncError || error instanceof OpError)
      return json(errStatus(error), errBody(error), headers);
    return json(409, { error: "Could not use the local GitHub credential store." }, headers);
  }
}

async function rssSettings(req: Request, url: URL, opts: ServeState, cors?: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
    return json(401, { error: "missing or invalid local app token" }, headers);
  if (req.headers.has("origin") && !cors)
    return json(403, { error: "RSS settings must come from the local app." }, headers);
  try {
    let feeds: unknown;
    if (req.method === "POST") {
      if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
        return json(415, { error: "Send a JSON object." }, headers);
      const raw = await readUpload(req, 128 * 1024, "RSS settings exceed 128 KiB.");
      try { feeds = JSON.parse(raw.toString("utf8"))?.feeds; } catch { /* handled below */ }
      if (typeof feeds !== "string")
        return json(400, { error: "Enter one feed URL per line." }, headers);
    } else if (req.method !== "GET") return json(405, { error: "Method not allowed." }, headers);
    const local = open(scopeOf(req, url, opts));
    try { return json(200, { result: runRssSettings(local.ctx, feeds) }, headers); }
    finally { await local.close(); }
  } catch (error) {
    return json(error instanceof UploadTooLarge ? 413 : errStatus(error), errBody(error), headers);
  }
}

function askDraftBrain(scope: Scope): { bundle: string; binding: string } | undefined {
  try {
    const bundle = realpathSync.native(scope.bundle);
    const info = statSync(bundle, { bigint: true });
    if (info.isDirectory()) return { bundle, binding: JSON.stringify([
      scope.brain ?? scope.servedBrain ?? null, bundle, String(info.dev), String(info.ino),
    ]) };
  } catch { /* An unavailable brain cannot receive an answer draft approval. */ }
}

async function browserPlan(req: Request, path: string, plan: BrowserPlan, scope: Scope, cors: Hdrs, drafts?: AskDraftReceipts): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  try {
    if (req.method === "GET" && path === "status") return json(200, { result: await plan.status() }, headers);
    if (req.method !== "POST") return json(404, { error: "not found" }, headers);
    if (scope.readonly && ["connect", "use", "disconnect"].includes(path))
      return json(403, { error: "Open Accounts from a writable brain to manage the local connection." }, headers);
    const encoded = req.body ? (await readUpload(req, 36_000, "Plan request is too large.")).toString("utf8") : "";
    let raw: unknown;
    try { raw = JSON.parse(encoded || "{}"); } catch { throw new BrowserPlanInputError("Expected a JSON request."); }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new BrowserPlanInputError("Expected a JSON object.");
    const body = raw as Record<string, unknown>;
    switch (path) {
      case "connect": return json(200, { result: await plan.connect(body.account) }, headers);
      case "sign-in": return json(200, { result: plan.signIn(body.id, body.cancel === true) }, headers);
      case "use": return json(200, { result: await plan.use(body.account) }, headers);
      case "disconnect": return json(200, { result: await plan.disconnect(body.account) }, headers);
      case "models": return json(200, { result: await plan.models(body.account) }, headers);
      case "preview":
      case "answer": {
        const binding = drafts && !scope.readonly ? askDraftBrain(scope)?.binding : undefined;
        const local = open(scope);
        try {
          if (path === "preview") return json(200, { result: await plan.preview(local.ctx, body, binding) }, headers);
          const { result, question, draftBrain } = await plan.answer(local.ctx, body.id);
          const draftReceipt = binding && binding === draftBrain ? drafts?.issue(binding, question, result) : undefined;
          return json(200, { result: draftReceipt ? { ...result, draftReceipt } : result }, headers);
        } finally { await local.close(); }
      }
      default: return json(404, { error: "not found" }, headers);
    }
  } catch (error) {
    return json(error instanceof UploadTooLarge ? 413 : error instanceof BrowserPlanInputError ? 400 : errStatus(error), errBody(error), headers);
  }
}

async function runJsonOp(
  op: Operation,
  scope: Scope,
  raw: Record<string, unknown>,
  cors: Hdrs = {},
  allowSavedSyncCredential = false,
): Promise<Response> {
  const local = open(scope);
  local.ctx.allowSavedSyncCredential = allowSavedSyncCredential;
  try {
    return json(200, { result: await runOp(op, local.ctx, raw) }, cors);
  } catch (e) {
    return json(errStatus(e), errBody(e), cors);
  } finally {
    await local.close();
  }
}

function sse(local: LocalContext, request: Request,
  run: (send: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<unknown>, cors: Hdrs = {}): Response {
  const enc = new TextEncoder();
  const detached = new AbortController();
  const disconnect = AbortSignal.any([request.signal, detached.signal]);
  const signal = AbortSignal.any([disconnect, AbortSignal.timeout(300_000)]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown): void => {
        if (!disconnect.aborted) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      void (async () => {
        try {
          send("done", { result: await run(send, signal) });
        } catch (error) {
          send("error", signal.aborted ? { error: "The answer took too long to complete." } : errBody(error));
        } finally {
          try { if (!disconnect.aborted) controller.close(); }
          finally { await local.close(); }
        }
      })();
    },
    cancel() { detached.abort(); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...GUARD, ...cors },
  });
}

async function askStream(req: Request, url: URL, scope: Scope, cors: Hdrs, drafts?: AskDraftReceipts): Promise<Response> {
  const op = getOp("ask")!;
  let raw: Record<string, unknown> = {};
  const binding = drafts && !scope.readonly && req.method === "POST" ? askDraftBrain(scope)?.binding : undefined;
  const local = open(scope);
  try {
    if (req.method === "POST") {
      if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
        await local.close();
        return json(415, { error: "Send the question as JSON." }, cors);
      }
      const input = await readUpload(req, 64 * 1024, "The question is too large.");
      let parsed: unknown;
      try { parsed = JSON.parse(input.toString("utf8")); }
      catch { throw new OpError("Send the question as a JSON object.", "bad_params"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OpError("Send the question as a JSON object.", "bad_params");
      raw = parsed as Record<string, unknown>;
    } else {
      for (const key of ["question", "profile"]) {
        const value = url.searchParams.get(key);
        if (value !== null) raw[key] = value;
      }
    }
    const params = checkOpCall(op, local.ctx, raw);
    return sse(local, req, async (send, signal) => {
      const result = await op.stream!(local.ctx, params, send, signal) as AskResult;
      const draftReceipt = binding ? drafts?.issue(binding, params.question as string, result) : undefined;
      return draftReceipt ? { ...result, draftReceipt } : result;
    }, cors);
  } catch (e) {
    await local.close();
    return json(e instanceof UploadTooLarge ? 413 : errStatus(e), errBody(e), cors);
  }
}

async function saveAskDraft(req: Request, url: URL, opts: ServeState, scope: Scope, cors?: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
    return json(401, { error: "missing or invalid local app token" }, headers);
  if (req.headers.has("origin") && !cors) return json(403, { error: "Open Ask from the local app." }, headers);
  if (req.method !== "POST") return json(405, { error: "Method not allowed." }, headers);
  if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return json(415, { error: "Send the completed answer as JSON." }, headers);
  const readonlyError = () => new AskDraftReceiptError("Open a writable brain to save private drafts.", 403);
  const changedError = () => new AskDraftReceiptError("The selected brain changed. Ask again before saving.", 409);
  try {
    if (scope.readonly) throw readonlyError();
    const brain = askDraftBrain(scope);
    if (!brain) throw changedError();
    const authorize = () => {
      let current: Scope;
      try { current = scopeOf(req, url, opts); } catch { throw changedError(); }
      if (current.readonly) throw readonlyError();
      if (askDraftBrain(current)?.binding !== brain.binding) throw changedError();
    };
    const content = await readUpload(req, maxAskDraftRequestBytes, "The completed answer is too large to save as a draft.");
    let body: unknown;
    try { body = JSON.parse(content.toString("utf8")); }
    catch { throw new AskDraftReceiptError("Send the completed answer as a JSON object.", 400); }
    authorize();
    const result = await opts.askDrafts!.save(body, brain.binding, async (draft) => {
      const local = open({ ...scope, bundle: brain.bundle });
      try { return await runAskDraftSave(local.ctx, draft, authorize); }
      finally { await local.close(); }
    });
    return json(200, { result }, headers);
  } catch (error) {
    if (error instanceof AskDraftReceiptError || error instanceof AskDraftError) return json(error.status, errBody(error), headers);
    const status = error instanceof UploadTooLarge ? 413 : errStatus(error);
    return json(status, status === 500 ? { error: "Could not save the private draft. Verify the brain folder is writable and try again." }
      : errBody(error), headers);
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
    await local.close();
  }
}

class UploadTooLarge extends Error {}

async function readUpload(req: Request, maxBytes: number, message: string): Promise<Buffer> {
  if (Number(req.headers.get("content-length")) > maxBytes)
    throw new UploadTooLarge(message);
  const reader = req.body?.getReader();
  if (!reader) throw new OpError("Choose a file to upload.", "bad_params");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new UploadTooLarge(message);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

async function conversationUpload(req: Request, url: URL, scope: Scope, cors: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return json(415, { error: "Choose an extracted conversations JSON file." }, headers);
  const local = open(scope);
  try {
    const result = await runConversationUpload(local.ctx, url.searchParams.get("provider"), req.headers.get("x-okb-preview"),
      () => readUpload(req, MAX_CONVERSATION_EXPORT_BYTES, "Choose a conversations JSON file up to 128 MiB."));
    return json(200, { result }, headers);
  } catch (e) {
    return json(e instanceof UploadTooLarge ? 413 : errStatus(e), errBody(e), headers);
  } finally {
    await local.close();
  }
}

async function sourceUpload(req: Request, url: URL, scope: Scope, opts: ServeState, cors: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "multipart/form-data")
    return json(415, { error: "Choose supported export files." }, headers);
  const kind = url.searchParams.get("kind");
  const local = open(scope);
  try {
    const result = await runPersonalSourceUpload(
      local.ctx, kind, req.headers.get("x-okb-preview"),
      async () => {
        const tooLarge = "Choose a selection up to 24 MiB.";
        const raw = await readUpload(req, MAX_SOURCE_UPLOAD_BYTES + 2 * 1024 * 1024, tooLarge);
        let form: Awaited<ReturnType<Response["formData"]>>;
        let paths: unknown;
        let selected: unknown;
        try {
          form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
          paths = JSON.parse(String(form.get("paths") ?? "null"));
          selected = JSON.parse(String(form.get("selected") ?? "[]"));
        } catch {
          throw new OpError("The source upload is invalid. Choose the files again.", "bad_params");
        }
        const name = form.get("name");
        const uploads = form.getAll("files");
        if (typeof name !== "string" || !Array.isArray(paths) || !uploads.length || uploads.length > MAX_SOURCE_FILES ||
            paths.length !== uploads.length || !paths.every((path) => typeof path === "string") ||
            !uploads.every((file) => typeof file !== "string") ||
            !Array.isArray(selected) || selected.length > MAX_SOURCE_ROWS || !selected.every((row) => Number.isSafeInteger(row)))
          throw new OpError("The source upload is invalid. Choose the files again.", "bad_params");
        if (uploads.reduce((size, file) => size + file.size, 0) > MAX_SOURCE_UPLOAD_BYTES)
          throw new UploadTooLarge(tooLarge);
        const offline = isOfflineSourceKind(kind);
        if (offline && uploads.some((file) => file.size > MAX_OFFLINE_FILE_BYTES))
          throw new UploadTooLarge("Choose email and calendar files up to 2 MiB each.");
        const files = await Promise.all(uploads.map(async (file, index) => ({ path: paths[index] as string, ...(offline
          ? { text: "", bytes: new Uint8Array(await file.arrayBuffer()) }
          : { text: await file.text() }) })));
        const current = scopeOf(req, url, opts);
        if (current.readonly || current.bundle !== scope.bundle)
          throw new OpError("The brain folder or its write permission changed. Preview the files again.", "refused");
        return { name, files, selected };
      },
    );
    return json(200, { result }, headers);
  } catch (error) {
    return json(error instanceof UploadTooLarge ? 413 : errStatus(error), errBody(error), headers);
  } finally {
    await local.close();
  }
}

async function notionRequest(req: Request, action: string, scope: Scope, connector: NotionSource, cors: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (req.method !== (action === "status" ? "GET" : "POST"))
    return json(405, { error: "Method not allowed." }, headers);
  const local = open(scope);
  try {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        return json(415, { error: "Send a JSON object." }, headers);
      const raw = await readUpload(req, 16 * 1024, "Notion request exceeds 16 KiB.");
      try {
        const value: unknown = JSON.parse(raw.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        body = value as Record<string, unknown>;
      } catch {
        return json(400, { error: "Send a JSON object." }, headers);
      }
    }
    return json(200, { result: await runNotionSource(local.ctx, connector, action, body) }, headers);
  } catch (error) {
    const status = error instanceof NotionSourceError ? error.status : error instanceof UploadTooLarge ? 413 : errStatus(error);
    return json(status, errBody(error), headers);
  } finally {
    await local.close();
  }
}

/** What the GUI needs to describe the server it talks to (no mount paths beyond the active bundle). */
async function status(scope: Scope, o: ServeState) {
  const local = open(scope);
  try {
    let cacheBackend: ReturnType<LocalContext["cacheBackend"]> = "sqlite";
    let cacheError: string | null = null;
    let hasIndex = false;
    let hasVectors = false;
    try {
      cacheBackend = local.cacheBackend();
      [hasIndex, hasVectors] = await Promise.all([local.ctx.hasIndex(), local.ctx.hasVectors()]);
    } catch (error) {
      cacheError = error instanceof EngineError ? error.message : "Could not read the local cache status.";
    }
    return {
      version: VERSION,
      okfVersion: OKF_VERSION,
      bundle: scope.bundle,
      brain: scope.brain,
      readonly: scope.readonly,
      isDefaultBundle: local.ctx.config().defaultBundle === scope.bundle,
      retrievalProfile: local.ctx.config().retrieval?.profile || "balanced",
      cacheBackend,
      cacheError,
      hasIndex,
      hasVectors,
      actor: local.ctx.actor(),
      port: o.port,
    };
  } finally {
    await local.close();
  }
}

async function codingRequest(req: Request, url: URL, opts: ServeState, cors: Hdrs): Promise<Response> {
  const headers = { ...cors, "cache-control": "no-store" };
  if (req.headers.has("origin") && !cors["access-control-allow-origin"])
    return json(403, { error: "Coding requests must come from the local app." }, headers);
  const bearer = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
  const owner = !opts.projectTokensOnly && tokenMatches(req.headers.get("x-okb-token") ?? bearer, opts.token);
  if (!owner && !/^okbp_[a-zA-Z0-9_-]{43}$/.test(bearer ?? ""))
    return json(401, { error: "A valid coding project or local okbrain token is required." }, headers);
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "Method not allowed." }, headers);
  try {
    const path = url.pathname.slice("/api/coding".length);
    const standalone = path === "/standalone" || path.startsWith("/standalone/");
    if (standalone && (!opts.standalone || !owner || !tokenMatches(req.headers.get("x-okb-token"), opts.token)))
      return json(403, { error: "Standalone sessions are available to the local operator." }, headers);
    // Coding state is separate from bundles. When the browser chose a brain
    // mount, still respect its read-only policy before writing local state.
    const selected = owner ? scopeOf(req, url, opts) : undefined;
    const readonly = opts.readonly || selected?.readonly === true;
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        return json(415, { error: "Send a JSON object." }, headers);
      const data = await readUpload(req, 128 * 1024, "Coding request body exceeds 128 KiB.");
      try {
        const parsed: unknown = JSON.parse(data.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        return json(400, { error: "Send a JSON object." }, headers);
      }
    }
    const canWrite = () => {
      if (readonly) return false;
      try {
        const current = scopeOf(req, url, opts);
        return current.bundle === selected?.bundle && !current.readonly;
      } catch { return false; }
    };
    if (standalone) {
      const result = await opts.standalone!.dispatch(req.method, path.slice("/standalone".length), body, canWrite);
      return json(200, { result }, headers);
    }
    if ((path === "/team" || path === "/team/preferences") && opts.team) {
      if (!owner) return json(403, { error: "Only the local operator can manage the team listener." }, headers);
      const preferences = path === "/team/preferences";
      if (req.method === "GET") return json(200, { result: preferences ? opts.team.preferences() : opts.team.status }, headers);
      const policy = () => canWrite() && teamControlWritable(opts);
      if (!policy()) return json(403, { error: "Open a writable brain to change the team workspace." }, headers);
      const handler = (request: Request, state: TeamStatus) => codingTeamRequest(request, state, opts);
      const result = preferences ? await opts.team.changePreferences(body, handler, policy) : await opts.team.change(body, handler, policy);
      return json(200, { result }, headers);
    }
    const result = await opts.coding!().dispatch(req.method, path, body, owner, bearer, readonly, canWrite);
    return json(200, { result }, headers);
  } catch (error) {
    if (error instanceof ProjectControlError) return json(error.status, errBody(error), headers);
    if (error instanceof StandaloneControlError) return json(error.status, errBody(error), headers);
    if (error instanceof CodingSessionMissingError) return json(404, errBody(error), headers);
    if (error instanceof UploadTooLarge) return json(413, errBody(error), headers);
    if (error instanceof CodingHandoffError) return json(400, errBody(error), headers);
    if (error instanceof CodingError || error instanceof RepositoryContextError) return json(409, errBody(error), headers);
    if (error instanceof CodingProjectProfileError) return json(400, errBody(error), headers);
    if (error instanceof ConfigError) return json(400, errBody(error), headers);
    return json(500, { error: "Coding project data could not be opened or updated." }, headers);
  }
}

const teamAssets = new Set([
  "/gui/coding.js", "/gui/coding-evaluation.js", "/gui/github.js", "/gui/coding.css", "/gui/tokens.css", "/gui/style.css", "/gui/render.js",
  "/gui/fonts/RecursiveSans-VF.woff2", "/gui/fonts/RecursiveMono-VF.woff2",
  "/gui/fonts/Literata-VF.woff2", "/gui/fonts/Literata-Italic-VF.woff2",
]);

function teamControlWritable(local: Pick<ServeState, "bundle" | "servedBrain" | "readonly">): boolean {
  if (local.readonly) return false;
  if (!local.servedBrain) return true;
  try {
    const mount = resolveBrain(local.servedBrain);
    return mount.path === local.bundle && !mount.readonly;
  } catch { return false; }
}

async function codingTeamRequest(req: Request, team: TeamStatus, local: ServeState): Promise<Response> {
  const url = new URL(req.url);
  if (!hostAllowed(req.headers.get("host"), team.port))
    return json(403, { error: "Invalid team workspace host." });
  const origin = req.headers.get("origin");
  const headers = origin && origin === team.publicOrigin ? {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "origin",
  } : corsHeaders(origin, team.port);
  const guards = {
    ...GUARD,
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
  if (req.method === "GET" && url.pathname === "/") return new Response(guiCodingTeamHtml, {
    headers: { ...guards, "content-type": "text/html; charset=utf-8" },
  });
  if (req.method === "GET" && teamAssets.has(url.pathname)) {
    const asset = GUI_ASSETS[url.pathname];
    if (asset) return new Response(asset[0], { headers: { ...guards, "content-type": asset[1] } });
  }
  if (url.pathname.startsWith("/api/coding/")) {
    if (req.method === "OPTIONS") return new Response(null, { status: headers ? 204 : 403, headers });
    return codingRequest(req, url, {
      bundle: local.bundle, port: team.port, token: "", readonly: !teamControlWritable(local),
      coding: local.coding, projectTokensOnly: true,
    }, headers ?? {});
  }
  return json(404, { error: "Not found." }, guards);
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

  if (url.pathname.startsWith("/api/coding/") && opts.coding) return codingRequest(req, url, opts, cors ?? {});
  if (url.pathname === "/api/brains/sync-github") return syncGitHubRequest(req, url, opts, cors ?? {});
  if (url.pathname === "/api/maintenance" && opts.maintenance) return maintenanceRequest(req, url, opts, cors);

  const presented =
    req.headers.get("x-okb-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("token");
  if (!tokenMatches(presented, opts.token))
    return json(401, { error: "missing or invalid token (see okb bookmarklet / serve)" }, cors);
  const recoveryAction = url.pathname === "/api/op/sync_recovery";
  const ownerFileAction = recoveryAction || url.pathname.startsWith("/api/op/computation_") ||
    ["/api/op/export_markdown", "/api/op/inbox_file", "/api/op/keep_private", "/api/op/cache_settings",
      "/api/op/sync_settings"].includes(url.pathname);
  if (ownerFileAction) {
    if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
      return json(401, { error: "missing or invalid local app token" }, cors);
    if (req.headers.has("origin") && !cors) return json(403, { error: "This request must come from the local app." });
    if (req.method === "POST" && req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return json(415, { error: "Send a JSON object." }, cors);
  }
  if (url.pathname.startsWith("/api/personal/sources/")) {
    if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
      return json(401, { error: "missing or invalid local app token" }, cors);
    if (req.headers.has("origin") && !cors)
      return json(403, { error: "Source actions must come from the local app." });
  }
  if (url.pathname === "/api/brains/mounts" || (req.method === "POST" && url.pathname === "/api/brains"))
    return brainMountRequest(req, url, opts, cors ?? {});
  if (url.pathname === "/api/rss-settings") return rssSettings(req, url, opts, cors);
  if (url.pathname === "/api/brains/watch" && opts.watches) return bundleWatchRequest(req, url, opts, cors);
  if (req.method === "GET" && url.pathname === "/api/brains") {
    try {
      const mounts = listBrains();
      const selected = req.headers.get("x-okb-brain") ?? url.searchParams.get("brain");
      const bundle = mounts.find(({ name }) => name === selected)?.path ?? opts.bundle;
      // Discovery stays available after removing the served mount and excludes host paths.
      const brains = mounts.map(({ path, ...mount }) => ({ ...mount, exists: mountIsAvailable(path), active: path === bundle }));
      const providers = { chat: providersFor("chat"), embed: providersFor("embed") };
      return json(200, { brains, providers }, { ...cors, "cache-control": "no-store" });
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      return json(400, errBody(e), cors);
    }
  }

  let scope: Scope;
  try {
    scope = scopeOf(req, url, opts);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return json(400, errBody(e), cors);
  }

  const notion = /^\/api\/personal\/sources\/notion\/(status|connect|disconnect|preview|import)$/.exec(url.pathname);
  if (notion && opts.notion) return notionRequest(req, notion[1]!, scope, opts.notion, cors ?? {});
  if (url.pathname === "/api/mcp/http" && opts.mcp) return managedMcpRequest(req, opts, scope, cors);

  if (url.pathname === "/api/ask/private-draft" && opts.askDrafts) return saveAskDraft(req, url, opts, scope, cors);

  if (url.pathname === "/api/ask/stream" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "POST" && (!tokenMatches(req.headers.get("x-okb-token"), opts.token) || (req.headers.has("origin") && !cors)))
      return json(403, { error: "Open Ask from the local app." });
    return askStream(req, url, scope, cors ?? {}, opts.askDrafts);
  }

  if ((url.pathname.startsWith("/api/plan/") && opts.plan) || url.pathname === "/api/provider-keys") {
    if (!tokenMatches(req.headers.get("x-okb-token"), opts.token))
      return json(401, { error: "missing or invalid local app token" }, cors);
    if (req.headers.has("origin") && !cors) return json(403, { error: "Requests must come from the local app." });
    if (url.pathname === "/api/provider-keys") return providerKeys(req, scope, cors ?? {});
    return browserPlan(req, url.pathname.slice("/api/plan/".length), opts.plan!, scope, cors ?? {}, opts.askDrafts);
  }

  if (req.method === "GET") {
    if (url.pathname === "/api/ops") return json(200, { ops: opDescriptors() }, cors);
    if (url.pathname === "/api/status") return json(200, await status(scope, opts), { ...cors, "cache-control": "no-store" });
    if (url.pathname === "/api/bookmarklet")
      return json(200, { port: opts.port, bookmarklet: bookmarkletJs(opts.port, opts.token) }, cors);
    if (url.pathname === "/api/personal/sources/history")
      return runJsonOp(getOp("personal_source_history")!, scope, {}, { ...cors, "cache-control": "no-store" });
    if (url.pathname === "/clip") return clipNav(url, scope);
  }

  const m = /^\/api\/op\/([a-z_]+)$/.exec(url.pathname);
  if (req.method === "POST" && url.pathname === "/api/conversations/upload")
    return conversationUpload(req, url, scope, cors ?? {});
  if (req.method === "POST" && url.pathname === "/api/personal/sources/upload")
    return sourceUpload(req, url, scope, opts, cors ?? {});
  if (m && req.method === "POST") {
    const op = operations.find((o) => o.name === m[1] && !o.localOnly);
    if (!op) return json(404, { error: `unknown op: ${m[1]}` }, cors);
    let raw: unknown;
    try {
      // JSON escaping can expand the approved 256 KiB merged text before it reaches the core.
      const text = ownerFileAction ? (await readUpload(req, recoveryAction ? 2 * 1024 * 1024 : 16 * 1024,
        recoveryAction ? "Git recovery request exceeds 2 MiB." : "Request exceeds 16 KiB.")).toString("utf8") : await req.text();
      raw = text === "" ? {} : JSON.parse(text);
    } catch (error) {
      if (error instanceof UploadTooLarge) return json(413, errBody(error), cors);
      return json(400, { error: "request body must be JSON" }, cors);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return json(400, { error: "request body must be a JSON object of parameters" }, cors);
    if (scope.brain || scope.servedBrain) {
      try { scope = scopeOf(req, url, opts); }
      catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        return json(400, errBody(error), cors);
      }
    }
    const allowSavedSyncCredential = op.name === "sync" && tokenMatches(req.headers.get("x-okb-token"), opts.token)
      && (!req.headers.has("origin") || cors !== undefined);
    return runJsonOp(op, scope, raw as Record<string, unknown>,
      ownerFileAction || allowSavedSyncCredential ? { ...cors, "cache-control": "no-store" } : cors, allowSavedSyncCredential);
  }

  return json(404, { error: "not found" }, cors);
}

export function createApiServer(opts: ApiOptions): ApiServer {
  const wanted = opts.port ?? DEFAULT_PORT;
  const reservedTeamPort = readCodingTeamStartupPort(opts.coding?.stateDir);
  if (reservedTeamPort !== null && wanted === reservedTeamPort) {
    throw new Error(`Port ${wanted} is reserved for the team workspace. Choose another port for the local operator app.`);
  }
  const token = opts.token ?? ensureServeToken();
  const plan = createBrowserPlan(opts.chatgpt);
  const askDrafts = new AskDraftReceipts();
  const notion = createNotionSource(opts.notion);
  const mcp = new ManagedMcpHttp();
  const watches = new Map<string | null, BundleWatcher>();
  const standalone = new StandaloneCodingControl(opts.standaloneCoding);
  const { bundle, readonly = false } = opts;
  const maintenanceAllowed = (target: MaintenanceTarget): boolean => {
    if (readonly || !mountIsAvailable(target.path)) return false;
    try {
      if (!maintenancePathMatches(target.path, target.path)) return false;
      if (target.brain !== null) {
        const mount = resolveBrain(target.brain);
        return !mount.readonly && maintenancePathMatches(mount.path, target.path);
      }
      if (opts.servedBrain || !maintenancePathMatches(bundle, target.path)) return false;
      return !listBrains().some((mount) => mount.readonly && mountIsAvailable(mount.path) && maintenancePathMatches(mount.path, target.path));
    } catch { return false; }
  };
  const maintenance = new MaintenanceScheduler({
    ...opts.maintenance,
    allowed: maintenanceAllowed,
    run: async (schedule, signal, isCurrent) => {
      const { target, jobs, approvals } = schedule;
      const canWrite = () => isCurrent() && maintenanceAllowed(target);
      const local = openLocalContext(target.path, true, false, TOOL_ACTOR);
      local.ctx.brain = target.brain ?? undefined;
      local.ctx.config = () => configForBrain(loadConfig(), local.ctx.brain, target.path);
      try { return await runScheduledMaintenance(local.ctx, { jobs, approvals, canWrite, signal }); }
      finally { await local.close(); }
    },
  });
  let controller: CodingProjectControl | undefined;
  const coding = () => controller ??= new CodingProjectControl({ ...opts.coding, retentionAllowed: () => {
    if (readonly || opts.coding?.retentionAllowed?.() === false) return false;
    if (!opts.servedBrain) return true;
    try { return !resolveBrain(opts.servedBrain).readonly; } catch { return false; }
  } });
  const team = new CodingTeamListener({
    get: () => controller ? controller.getTeamStartup() : readCodingTeamStartup(opts.coding?.stateDir),
    save: (value) => coding().saveTeamStartup(value),
    ensure: () => { coding(); },
  });
  let state: ServeState;
  const listen = () => {
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: wanted,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/plan/answer") listener.timeout(req, 150);
        if (path === "/api/ask/stream") listener.timeout(req, 0);
        if (path.startsWith("/api/coding/")) listener.timeout(req, 65);
        if (path === "/api/op/sync" || path === "/api/op/sync_recovery") listener.timeout(req, 260);
        if (path === "/api/brains" && req.method === "POST") listener.timeout(req, 150);
        return handleRequest(req, state);
      },
    });
    return listener;
  };
  let server: Bun.Server<undefined>;
  let teamPortAtBoot: number | null;
  try {
    const first = listen();
    if (first.port === reservedTeamPort) {
      // Holding the first port during the second ephemeral bind prevents it
      // from being assigned again. Requests wait until state is initialized.
      try { server = listen(); } finally { void first.stop(true); }
    } else server = first;
    // Another runtime may have saved a binding during the port selection.
    teamPortAtBoot = readCodingTeamStartupPort(opts.coding?.stateDir);
    if (server.port === reservedTeamPort || server.port === teamPortAtBoot) {
      void server.stop(true);
      throw new Error("Could not assign a local operator port separate from the Team workspace.");
    }
  } catch (e) {
    if ((e as { code?: string }).code === "EADDRINUSE")
      throw new Error(
        `port ${wanted} is already in use (another okb serve?) — pick one with --port`,
      );
    throw e;
  }
  const port = server.port!;
  state = { bundle, servedBrain: opts.servedBrain, watches, maintenance, maintenanceAllowed,
    port, token, readonly, plan, askDrafts, coding, standalone, team, notion, mcp };
  if (!readonly) maintenance.start();
  if (!readonly && existsSync(codingProjectCatalogPath(opts.coding?.stateDir))) {
    try { coding(); } catch { /* Leave personal routes available. The Coding API reports catalog errors. */ }
    if (teamPortAtBoot !== null && teamControlWritable(state)) {
      void team.restore((request, binding) => codingTeamRequest(request, binding, state), () => teamControlWritable(state)).catch(() => {});
    }
  }
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    async stop() {
      plan.close();
      notion.close();
      const teamStopped = team.stop();
      const closeCoding = () => controller?.close();
      const stopped = await Promise.allSettled([
        server.stop(true), teamStopped, mcp.stop(), teamStopped.then(closeCoding, closeCoding), standalone.close(), maintenance.stop(),
        ...[...watches.values()].map((watcher) => watcher.stop()),
      ]);
      const failures = stopped.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Could not close the okbrain server.");
    },
  };
}
