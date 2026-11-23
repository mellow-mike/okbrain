// The single operations registry behind every surface (CLAUDE.md invariant 2).
// Each op declares name, params, scope, and handler once; the CLI (and later
// the GUI API and MCP server) are thin adapters generated over this table.
// Trust is fail-closed (invariant 3): `runOp` refuses write/admin scope for any
// caller not explicitly trusted, before the handler is ever reached.

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createApiServer } from "../api.ts";
import { runMcpHttp, runMcpStdio } from "../mcp/server.ts";
import { AiError, createGateway, RECIPES, resolveCall, type AiOptions } from "./ai/gateway.ts";
import { CHATGPT_USAGE, createChatgptPlan, type ChatgptPlanStatus } from "./ai/chatgpt-plan.ts";
import { gatewayEnvironment } from "./ai/local-keys.ts";
import { focusedMap, MAP_SOURCES } from "./graph/focus.ts";
import { openInBrowser } from "./browser.ts";
import { changeBrainMount, restoreBrainMount } from "./brain-mounts.ts";
import type { CodingSessionResult, CodingSessionStatusResult } from "./coding/durable.ts";
import { CodingProjectProfileError, parseCodingProjectProfile } from "./coding/project-profile.ts";
import type { RepositoryContextManifest, RepositoryContextSelection, RepositoryContextOptions } from "./coding/repository-context.ts";
import { brainAiDefaults, listBrains, loadConfig, resolveBrain, saveConfig, type AiSettings, type OkbConfig } from "./config.ts";
import { calibration, CLAIM_TYPE, isClaimDeadline, overdueClaimDates, scanClaims, type CalibrationReport, type Outcome } from "./claims.ts";
import { watchBundleInForeground, type BundleWatchStatus } from "./engine/bundle-watch.ts";
import { buildIndex, updateIndexFor, withIndexWrite, type IndexStats } from "./engine/index-build.ts";
import type { Awaitable, IndexEngine, IndexVectors, Neighbor } from "./engine/interface.ts";
import { readCacheSettings, setCacheSettings } from "./engine/cache-settings.ts";
import { localBundleWatchBackend, openLocalContext } from "./context.ts";
import { EngineError } from "./engine/sqlite.ts";
import { suggestLinks, type LinkSuggestion } from "./graph/link-suggest.ts";
import { extractTargets } from "./graph/links.ts";
import { orphans, shortestPath } from "./graph/queries.ts";
import { log } from "./log.ts";
import { noteUsageSettings, recordCitedNotes, recordNoteOpen, type LocalUsageView } from "./local-usage.ts";
import { publicTagVocabulary, suggestTags } from "./ingest/autotag.ts";
import { captureNote } from "./ingest/capture.ts";
import { clipUrl, type ClipOptions, type ClipResult } from "./ingest/clip.ts";
import {
  importConversations,
  importConversationUpload,
  isConversationProvider,
  type ConversationImportResult,
  type ConversationUploadResult,
} from "./ingest/conversations.ts";
import { FetchGuardError } from "./ingest/fetch-guard.ts";
import { importPath, type ImportResult } from "./ingest/import.ts";
import type { NotionSource } from "./ingest/notion-source.ts";
import {
  importPersonalSource, isOfflineSourceKind, isSourceKind, MAX_SOURCE_ROWS, readOfflineSourcePath, sourceHistory,
  type SourceUploadFile, type SourceUploadResult,
} from "./ingest/personal-sources.ts";
import { FeedError, pullFeed, type RssPullResult } from "./ingest/rss.ts";
import { defaultLimits, runEnrich, type EnrichResult } from "./ingest/web.ts";
import { listConcepts, readConceptPermissive } from "./okf/bundle.ts";
import { runDoctor, type DoctorReport } from "./okf/doctor.ts";
import {
  fmStatus,
  fmString,
  fmTags,
  generatedAt,
  isActor,
  isStale,
  lastVerifiedAt,
  OkfParseError,
  parse,
  STATUSES,
  trustTier,
  type OkfDocument,
  type SourceEntry,
  type Status,
  type TrustTier,
} from "./okf/document.ts";
import { regenerateIndexes, setIndexStyle } from "./okf/indexmd.ts";
import { fileInboxNote, InboxFilingError, type InboxFiling } from "./okf/inbox-filing.ts";
import { appendLog, createDirectoryLog, LogFolderError, removePrivateLogEntries } from "./okf/logmd.ts";
import { exportMarkdown, MarkdownExportError, type MarkdownExport } from "./okf/markdown-export.ts";
import { assertConceptPathSpelling, idToAbsPath, InvalidIdError, slugify, validateId } from "./okf/paths.ts";
import { isPrivateConcept, isPrivateConceptAt, PrivacyPathError } from "./okf/privacy.ts";
import { brainStarterCatalog, createBrainStarter, findBrainStarter } from "./okf/starter.ts";
import { upgradeBundle, type UpgradeResult } from "./okf/upgrade.ts";
import { nowTimestamp, OkfWriteError, writeConcept, type WriteResult } from "./okf/write.ts";
import {
  attestComputation, computationRuntime, ComputationError, compute, configureComputation, previewComputation, verifyComputation,
} from "./okf/computation.ts";
import { TOOL_ACTOR } from "./version.ts";
import { saveAskDraft, type AskDraftInput, type AskDraftResult } from "./retrieval/ask-draft.ts";
import { askBrain, publicHits, type AskResult } from "./retrieval/ask.ts";
import { embedBundle, embedConcept, gatewayEmbedder, type EmbedStats } from "./retrieval/embed.ts";
import { hybridRetrieve, type HybridArms, type HybridHit } from "./retrieval/hybrid.ts";
import { PROFILES, ProfileError, resolveProfile, type RetrievalProfile } from "./retrieval/profiles.ts";
import { rerankConfigured, rerankHits } from "./retrieval/rerank.ts";
import { describePublicReviewNote, garnishQueue, pickRecent } from "./review/garnish.ts";
import { defaultReviewConfig, reviewQueue, type ReviewItem } from "./review/score.ts";
import { bookmarkletJs, DEFAULT_MCP_PORT, DEFAULT_PORT, ensureServeToken, publishDesktopAddress } from "./serve-token.ts";
import { computeStats, type BrainStats } from "./stats.ts";
import { jobReadOnly, jobShutdown, JobLockError, runJobs, type Job, type JobResult } from "./jobs/worker.ts";
import {
  protectUnsharedNote, sameDir, syncBundle, syncRebaseInProgress, syncSettings, syncStatus, withSyncRepository, type SyncResult, type SyncStatus,
} from "./sync.ts";
import { syncRecovery } from "./sync-recovery.ts";
import { buildVizGraph, exportViz, type VizExport, type VizGraph } from "./viz/export.ts";

export type Scope = "read" | "write" | "admin";

/** What an adapter supplies to run ops: bundle root, trust, and a lazy engine. */
export interface OpContext {
  bundle: string;
  /** Named mount selected by a long-running local command. */
  brain?: string;
  trusted: boolean;
  /** Local owner surfaces may contribute to explicitly enabled usage counts. */
  localUsage?: boolean;
  /** Direct local owner requests may use the brain’s saved GitHub credential. */
  allowSavedSyncCredential?: boolean;
  /** Recheck the selected mount's write policy while publishing Git settings. */
  canWriteSyncSettings?: () => boolean;
  /** Read-only brain mount (Stage 5): write/admin ops are refused. */
  readonly?: boolean;
  /**
   * Open (or return the already-open) engine; the adapter owns its lifecycle.
   * Without `createIfMissing`, a bundle with no index yet must fail loudly —
   * silently opening an empty index would truncate search (see 1.4 decision).
   */
  engine(createIfMissing?: boolean): Awaitable<IndexEngine>;
  /** True when a derived index already exists (write ops refresh it, never create it). */
  hasIndex(): Awaitable<boolean>;
  /** Open (or return) the vector store; same create semantics as `engine`. */
  vectors(createIfMissing?: boolean): Awaitable<IndexVectors>;
  /** True when a vector store exists (write ops refresh it, never create it). */
  hasVectors(): Awaitable<boolean>;
  /** User config (config.json via okb init); adapter-loaded, {} when absent. */
  config(): OkbConfig;
  /** Who this caller's writes are attributed to (OKF actor, §7). */
  actor(): string;
}

export interface ParamSpec {
  /** Kebab-case; doubles as the CLI flag name (`--confirm-destructive`). */
  name: string;
  type: "string" | "int" | "boolean";
  required?: boolean;
  /** Filled from bare CLI arguments, in declaration order. */
  positional?: boolean;
  /** CLI adapter may fill a missing value from piped stdin. */
  stdinFallback?: boolean;
  description: string;
}

export interface Operation {
  name: string;
  /** Command name on the CLI surface (`read_concept` → `okb read`). */
  cliName: string;
  summary: string;
  scope: Scope;
  params: ParamSpec[];
  handler(ctx: OpContext, params: Record<string, unknown>): Promise<unknown>;
  /**
   * Streaming variant for SSE-capable adapters: same result as `handler`,
   * but may emit named events (progress, partial output) along the way.
   * Callers validate with `checkOpCall` first, exactly like `runOp`.
   */
  stream?(
    ctx: OpContext,
    params: Record<string, unknown>,
    emit: (event: string, data: unknown) => void,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Footer for a CLI stream after its answer text has already been printed. */
  renderStreamFooter?(result: unknown): string;
  /** CLI-only: never exposed over network adapters (local API, MCP). */
  localOnly?: boolean;
  /** Runs against per-user application state rather than a brain mount. */
  bundleIndependent?: boolean;
  /** Human rendering of the result for the CLI (`--json` bypasses it). */
  render(result: unknown): string;
  /** CLI exit status derived from a successful result (default 0). */
  exitCode?(result: unknown): number;
}

export class OpError extends Error {
  constructor(
    message: string,
    readonly code: "untrusted" | "bad_params" | "not_found" | "refused",
  ) {
    super(message);
  }
}

const codingWorkspace = { name: "workspace", type: "string", required: true, description: "local workspace directory" } satisfies ParamSpec;
const codingSessionParams: ParamSpec[] = [
  codingWorkspace,
  { name: "session", type: "string", required: true, description: "persistent session name" },
  { name: "provider", type: "string", required: true, description: "Pi provider: openai, anthropic, or google" },
  { name: "model", type: "string", required: true, description: "model ID in Pi's provider catalog" },
];
const repositorySelectionParams: ParamSpec[] = [
  { name: "projects", type: "string", description: "comma-separated workspace-relative project directories, or . for the workspace" },
  { name: "profile-json", type: "string", description: "versioned coding project profile as JSON, instead of --projects" },
  { name: "query", type: "string", description: "paths or keywords to look for in tracked source" },
  { name: "context-tokens", type: "int", description: "estimated token budget for repository excerpts (default 4096)" },
];

function codingSessionParamsFrom(p: Record<string, unknown>) {
  return { workspace: p.workspace as string, session: p.session as string, provider: p.provider as string, model: p.model as string };
}

function repositorySelectionFrom(p: Record<string, unknown>): Omit<RepositoryContextOptions, "workspace"> {
  if ((p.projects === undefined) === (p["profile-json"] === undefined)) {
    throw new OpError("Choose either --projects or --profile-json.", "bad_params");
  }
  try {
    return {
      projects: (p.projects as string | undefined)?.split(",").map((project) => project.trim()),
      profile: p["profile-json"] === undefined ? undefined : parseCodingProjectProfile(p["profile-json"] as string),
      query: p.query as string,
      tokenBudget: p["context-tokens"] as number | undefined,
    };
  } catch (error) {
    if (error instanceof CodingProjectProfileError) throw new OpError(error.message, "bad_params");
    throw error;
  }
}

function renderRepositoryContext(manifest: RepositoryContextManifest, excerpts?: RepositoryContextSelection["excerpts"], guidance?: string): string {
  const limits = Object.entries(manifest.limitsReached).filter(([, reached]) => reached).map(([name]) => ({
    trackedPaths: "tracked path cap", scannedFiles: "scan cap", fileBytes: "per-file read cap", selectedFiles: "excerpt cap", tokenBudget: "token budget",
  })[name]);
  const lines = [
    `Context ID ${manifest.id}`,
    `Projects ${manifest.projects.join(", ")}`,
    ...(manifest.profile ? [`Profile ${manifest.profile.name} (v${manifest.profile.version})`] : []),
    ...(manifest.profile?.sharedProjects?.length ? [`Permitted dependencies ${manifest.profile.sharedProjects.join(", ")}`] : []),
    ...(manifest.index ? [`Indexed ${manifest.index.indexedFiles} files, with ${manifest.index.expandedFiles} candidate imports${manifest.index.limited ? " (index cap reached)" : ""}.`] : []),
    `${manifest.estimatedTokens}/${manifest.tokenBudget} estimated excerpt tokens. Scanned ${manifest.scannedFiles} of ${manifest.candidateFiles} eligible files.`,
    ...manifest.files.map(({ path, startLine, endLine, reason }) => `${path}:${startLine}-${endLine}${reason ? ` (${reason})` : ""}`),
  ];
  if (!manifest.files.length) lines.push("No excerpts selected.");
  if (limits.length) lines.push(`Limits reached: ${limits.join(", ")}. Narrow the scope or query to improve coverage.`);
  if (guidance) lines.push("\n--- Profile guidance ---", guidance);
  for (const excerpt of excerpts ?? []) lines.push(`\n--- ${excerpt.path}:${excerpt.startLine}-${excerpt.endLine} ---`, excerpt.content);
  return stripVTControlCharacters(lines.join("\n"));
}

/** OKF v0.2 signals derived from a concept's frontmatter (one rule set, every surface). */
interface ConceptSignals {
  status: Status;
  trust: TrustTier;
  stale: boolean;
  /** Last content change (`generated.at`, else legacy `timestamp`). */
  updated: string | null;
  /** Latest verification instant, any actor. */
  verified: string | null;
}

interface ConceptView {
  id: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  signals: ConceptSignals;
}

const signalsOf = (fm: Record<string, unknown>): ConceptSignals => ({
  status: fmStatus(fm),
  trust: trustTier(fm),
  stale: isStale(fm),
  updated: generatedAt(fm),
  verified: lastVerifiedAt(fm),
});

/** One row of `okb list --detail`: the index-free browse listing. */
interface ConceptRow extends ConceptSignals {
  id: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
}

type Dir = "out" | "in" | "both";

interface TitledNeighbor extends Neighbor {
  title: string;
  /** Link direction relative to the center; only meaningful at depth 1. */
  dir?: Dir;
}

interface PathHop {
  id: string;
  title: string;
  /** Traversal direction from the previous hop; absent on the first. */
  dir?: Dir;
}

const DIR_MARK: Record<Dir, string> = { out: "→", in: "←", both: "↔" };

/** Incrementally refresh written concepts in the derived caches — where they exist. */
async function reindex(ctx: OpContext, ids: string[], refreshVectors = true): Promise<void> {
  if (ids.length === 0) return;
  await afterMarkdownWrite(async () => {
    await withIndexWrite(ctx.bundle, async () => {
      if (!(await ctx.hasIndex())) return;
      const engine = await ctx.engine();
      for (const id of ids) await updateIndexFor(ctx.bundle, id, engine);
    });
  });
  if (!refreshVectors) return;
  try {
    if (!(await ctx.hasVectors())) return;
    const vectors = await ctx.vectors();
    const emb = gatewayEmbedder(ctx.config().ai ?? {});
    for (const id of ids) {
      if (await isPrivateConceptAt(ctx.bundle, id)) await vectors.remove(id);
      else await embedConcept(ctx.bundle, id, vectors, emb);
    }
  } catch (e) {
    // Never fail a write over a derived cache; `okb embed` reconciles later.
    log.warn("vector refresh failed — run `okb embed` to catch up", {
      error: (e as Error).message,
    });
  }
}

/** Refresh only the local search and graph cache after Git changes the bundle. */
async function refreshSyncIndex(ctx: OpContext): Promise<{ indexWarning?: string }> {
  try {
    await withSyncRepository(ctx.bundle, async (root) => {
      if (await syncRebaseInProgress(root)) return;
      await withIndexWrite(root, async () => {
        if (await ctx.hasIndex()) await buildIndex(root, await ctx.engine());
      });
    });
    return {};
  } catch (error) {
    log.warn("Git finished but the search index refresh failed", { error: (error as Error).message });
    return { indexWarning: "Git finished. Use Re-index in Settings to refresh search and the graph." };
  }
}

async function afterMarkdownWrite(refresh: () => Promise<void>): Promise<void> {
  try { await refresh(); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    log.warn("The Markdown changes were saved. Refresh the caches after reconnecting the database.", { error: error.message });
  }
}

async function requireNode(eng: IndexEngine, id: string): Promise<void> {
  if (!(await eng.getNode(id)))
    throw new OpError(`concept not in index: ${id} (run \`okb index\`?)`, "not_found");
}

async function readConceptView(bundle: string, id: string): Promise<ConceptView> {
  try {
    validateId(id);
  } catch (e) {
    if (!(e instanceof InvalidIdError)) throw e;
    throw new OpError(e.message, "bad_params");
  }
  let raw: string;
  try {
    raw = await readFile(idToAbsPath(bundle, id), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new OpError(`no such concept: ${id}`, "not_found");
    throw e;
  }
  let doc: OkfDocument;
  try {
    doc = parse(raw);
  } catch (e) {
    if (!(e instanceof OkfParseError)) throw e;
    doc = { frontmatter: {}, body: raw }; // permissive read; doctor flags it
  }
  return { id, frontmatter: doc.frontmatter, body: doc.body, raw, signals: signalsOf(doc.frontmatter) };
}

/** `sources` from a surface: a JSON array (GUI/MCP) or comma-separated resources (CLI). */
function parseSources(v: unknown): SourceEntry[] | undefined {
  if (v === undefined) return undefined;
  const text = (v as string).trim();
  if (text === "") return [];
  if (text.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new OpError("sources must be a JSON array of {resource, id?, title?} or comma-separated URLs", "bad_params");
    }
    if (!Array.isArray(arr)) throw new OpError("sources must be a JSON array", "bad_params");
    return arr.map((s) =>
      typeof s === "string" ? { resource: s } : (s as SourceEntry),
    );
  }
  return text.split(",").map((r) => r.trim()).filter((r) => r !== "").map((resource) => ({ resource }));
}

const requireActor = (v: unknown): string => {
  if (!isActor(v))
    throw new OpError(
      `actor must follow the OKF convention: human:<id>, process:<id>, or <producer>/<version> (got ${String(v)})`,
      "bad_params",
    );
  return v;
};

/** The enrichment agent's actor: `okb-enrich/<chat model>` (§7 producer/version). */
function enrichActor(ctx: OpContext): string {
  try {
    return `okb-enrich/${resolveCall("chat", ctx.config().ai ?? {}, gatewayEnvironment()).model.replace(/\s+/g, "-")}`;
  } catch (e) {
    if (e instanceof AiError) return "okb-enrich/unknown";
    throw e;
  }
}

const renderStats = (r: unknown): string => {
  const s = r as IndexStats;
  return `indexed ${s.indexed}, skipped ${s.skipped}, removed ${s.removed}, edges ${s.edges}`;
};

const renderWrite = (r: unknown): string => {
  const w = r as WriteResult;
  return `${w.noop ? "unchanged" : w.created ? "created" : "updated"} ${w.id}`;
};

/** Comma-separated CLI tags → array (`""` clears, undefined keeps). */
const parseTags = (v: unknown): string[] | undefined =>
  v === undefined
    ? undefined
    : (v as string).split(",").map((t) => t.trim()).filter((t) => t !== "");

/** Effective review config: code defaults overlaid with `review.*` from config.json. */
const reviewCfg = (c: OkbConfig) => ({
  ...defaultReviewConfig,
  ...c.review,
  weights: { ...defaultReviewConfig.weights, ...c.review?.weights },
});

const queueFor = async (ctx: OpContext, limit?: number): Promise<ReviewItem[]> => {
  const cfg = reviewCfg(ctx.config());
  const eng = await ctx.engine();
  const rows = await eng.listReviewRows();
  const now = new Date();
  const overdue = cfg.weights.overdueClaim > 0
    ? await overdueClaimDates(ctx.bundle, rows.filter((row) => row.type === CLAIM_TYPE && row.status !== "deprecated").map(({ id }) => id), now)
    : undefined;
  return reviewQueue(rows, await eng.listEdges(), now, {
    ...cfg,
    queueSize: limit ?? cfg.queueSize,
  }, overdue);
};

/** Review target: a 1-based queue position (pure integer in range) or a concept id. */
async function resolveReviewTarget(ctx: OpContext, raw: string): Promise<string> {
  if (/^\d+$/.test(raw)) {
    // Rank without the display limit so positions match any `--limit` listing.
    const q = await queueFor(ctx, Number.MAX_SAFE_INTEGER);
    const n = Number(raw);
    if (n >= 1 && n <= q.length) return q[n - 1]!.id;
  }
  await requireNode(await ctx.engine(), raw);
  return raw;
}

const profileOf = (ctx: OpContext, p: Record<string, unknown>): RetrievalProfile => {
  try {
    return resolveProfile(p.profile as string | undefined, ctx.config());
  } catch (e) {
    if (e instanceof ProfileError) throw new OpError(e.message, "bad_params");
    throw e;
  }
};

/**
 * Recall arms for hybrid retrieval. The vector arm joins only when a store
 * with a pinned cache key exists AND its recorded embedder still resolves —
 * queries must be embedded in the documents' own space, so the store's
 * (provider, model) wins over whatever is currently configured.
 */
async function hybridArms(ctx: OpContext): Promise<HybridArms> {
  const arms: HybridArms = { engine: await ctx.engine() };
  if (!(await ctx.hasVectors())) return arms;
  const store = await ctx.vectors();
  const meta = await store.meta();
  if (!meta) return arms;
  try {
    const emb = gatewayEmbedder(ctx.config().ai ?? {}, { provider: meta.provider, model: meta.model });
    arms.vectors = store;
    arms.embed = (texts) => emb.embed(texts);
  } catch (e) {
    log.warn("vector arm unavailable", { error: (e as Error).message });
  }
  return arms;
}

/**
 * Rerank arm: only when the profile asks AND a provider is explicitly
 * configured (never via key detection — searches must not silently spend);
 * failures degrade to the fused order.
 */
async function maybeRerank(
  ctx: OpContext,
  query: string,
  hits: HybridHit[],
  profile: RetrievalProfile,
): Promise<HybridHit[]> {
  const ai = ctx.config().ai ?? {};
  if (!profile.rerank || hits.length < 2 || !rerankConfigured(ai)) return hits;
  try {
    const publicPool = await publicHits(ctx.bundle, hits);
    if (publicPool.length < 2) return hits;
    const reranked = await rerankHits(query, publicPool, createGateway(ai));
    const visible = new Set(publicPool.map((hit) => hit.id));
    let index = 0;
    return hits.map((hit) => visible.has(hit.id) ? reranked[index++]! : hit);
  } catch (e) {
    log.warn("rerank skipped", { error: (e as Error).message });
    return hits;
  }
}

/** A vector store that exists but couldn't serve recall deserves a warning. */
const warnVectorSkip = async (ctx: OpContext, reason: string | null): Promise<void> => {
  if (reason !== null && await ctx.hasVectors()) log.warn("vector arm skipped", { reason });
};

/**
 * Clip's autoTag hook (F-B.8): undefined unless asked for and allowed by the
 * profile; failures warn and tag nothing — AI never blocks a clip.
 */
function autoTagger(ctx: OpContext, wanted: boolean): ClipOptions["suggestTags"] {
  if (!wanted) return undefined;
  if (!profileOf(ctx, {}).extras) {
    log.warn("autoTag is an AI extra — off in the lean profile");
    return undefined;
  }
  return async (article) => {
    try {
      const vocabulary = await ctx.hasIndex() ? await publicTagVocabulary(ctx.bundle, await (await ctx.engine()).listNodeIds()) : [];
      return await suggestTags(article, vocabulary, (m) =>
        createGateway(ctx.config().ai ?? {}).chat(m),
      );
    } catch (e) {
      log.warn("autoTag skipped", { error: (e as Error).message });
      return [];
    }
  };
}

/** The ask pipeline; `emit` (streaming surfaces) gets context before the answer. */
async function runAsk(
  ctx: OpContext,
  p: Record<string, unknown>,
  emit?: (event: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<AskResult> {
  const profile = profileOf(ctx, p);
  const gw = createGateway(ctx.config().ai ?? {});
  const r = await askBrain(
    p.question as string,
    {
      bundle: ctx.bundle,
      arms: await hybridArms(ctx),
      chat: (messages) => gw.chat(messages, undefined, { signal }),
      synthesize: emit && ((messages) => gw.chat(messages, undefined, { signal, onDelta: (text) => emit("delta", { text }) })),
      signal,
      includePrivate: p["include-private"] === true,
      rerank: (q, hits) => maybeRerank(ctx, q, hits, profile),
      onContext: emit && ((context) => emit("context", context)),
    },
    profile,
  );
  await warnVectorSkip(ctx, r.vectorSkipped);
  if (!signal?.aborted) recordCitedNotes(ctx, r.citations.map(({ id }) => id));
  emit?.("answer", { answer: r.answer, citations: r.citations });
  return r;
}

function renderAnswer(result: unknown): string {
  const answer = result as AskResult;
  return answer.answer.trim() + renderAnswerFooter(answer);
}

function renderAnswerFooter(result: unknown): string {
  const { citations } = result as AskResult;
  return citations.length ? ["", "", "sources:", ...citations.map((c) => `  ${c.id} — ${c.title}`)].join("\n") : "";
}

function renderChatgptStatus(result: unknown): string {
  const { account, accounts, connected, sharing, email } = result as ChatgptPlanStatus;
  if (!account) return "No ChatGPT account selected. Run `okb chatgpt connect`.";
  const label = email ? `${account} (${email})` : account;
  const state = connected ? (sharing ? "plan usage enabled" : "plan usage unavailable") : "signed out";
  return `${label} — ${state}\nsaved accounts: ${accounts.join(", ")}\nmanage usage: ${CHATGPT_USAGE}`;
}

/**
 * Pull feeds and reindex what landed (`okb rss` + the jobs worker). A single
 * explicit URL fails loudly; a configured multi-pull records per-feed errors
 * so one dead feed can't block the rest.
 */
async function pullFeeds(ctx: OpContext, urls: string[], limit?: number, refreshVectors = true): Promise<RssPullResult[]> {
  const results: RssPullResult[] = [];
  for (const url of urls) {
    try {
      const r = await writing(async () =>
        pullFeed(ctx.bundle, url, {
          resources: await ctx.hasIndex() ? await (await ctx.engine()).listResources() : undefined,
          limit,
          stripParams: ctx.config().clip?.stripParams,
        }),
      );
      await reindex(ctx, r.added.map((a) => a.id), refreshVectors);
      results.push(r);
    } catch (e) {
      if (urls.length === 1) throw e;
      results.push({
        url, feed: "", added: [], deduped: 0, skipped: 0,
        error: e instanceof OpError ? e.message : (e as Error).message,
      });
    }
  }
  return results;
}

/** Suggestions for one concept (op handler + the enrich agent's tool). */
async function suggestFor(ctx: OpContext, id: string, limit?: number): Promise<LinkSuggestion[]> {
  const view = await readConceptView(ctx.bundle, id);
  return suggestLinks(
    {
      id,
      title: fmString(view.frontmatter.title),
      description: fmString(view.frontmatter.description),
      body: view.body,
      tags: fmTags(view.frontmatter.tags),
    },
    await ctx.engine(),
    limit,
  );
}

/** Writer/id errors are caller mistakes → bad_params; guard blocks → refused. */
async function writing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OkfWriteError || e instanceof InvalidIdError || e instanceof PrivacyPathError)
      throw new OpError(e.message, "bad_params");
    if (e instanceof FetchGuardError || e instanceof FeedError)
      throw new OpError(e.message, "refused");
    throw e;
  }
}

async function localComputation<T>(action: () => Promise<T>): Promise<T> {
  try { return await writing(action); }
  catch (error) {
    if (error instanceof ComputationError) throw new OpError(error.message, error.code);
    throw error;
  }
}

async function computationWrite<T extends { id: string }>(ctx: OpContext, action: () => Promise<T>): Promise<T> {
  const result = await localComputation(action);
  // The portable receipt is committed. Refresh local metadata without an embedding request.
  try {
    await withIndexWrite(ctx.bundle, async () => {
      if (await ctx.hasIndex()) await updateIndexFor(ctx.bundle, result.id, await ctx.engine());
    });
  } catch { log.warn("The computation was saved, but the local index needs to be rebuilt."); }
  return result;
}

const computationId: ParamSpec = { name: "id", type: "string", required: true, positional: true, description: "Attested Computation concept ID" };
const computationParameters: ParamSpec = { name: "parameters", type: "string", description: "typed parameter values as JSON" };
const computationReceipt: ParamSpec = { name: "receipt", type: "string", required: true, stdinFallback: true, description: "computation receipt as JSON" };
const computationApproval: ParamSpec = { name: "approval", type: "string", required: true, description: "digest from the reviewed preview or verified receipt" };
const renderComputation = (value: unknown) => JSON.stringify(value, null, 2);

async function refreshPrivateImportIndex(ctx: OpContext, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await withIndexWrite(ctx.bundle, async () => {
      if (!(await ctx.hasIndex())) return;
      const engine = await ctx.engine();
      for (const id of ids) await updateIndexFor(ctx.bundle, id, engine);
    });
  } catch {
    log.warn("Private drafts were saved. Rebuild search to refresh the keyword and graph index.");
  }
}

/** Browser-only Ask saving. The owner adapter authenticates the completed answer before dispatch. */
export async function runAskDraftSave(ctx: OpContext, draft: AskDraftInput, authorize?: () => void): Promise<AskDraftResult> {
  checkOpScope({ name: "Ask draft save", scope: "write" }, ctx);
  const result = await writing(() => saveAskDraft(ctx.bundle, draft, authorize));
  if (result.created) await refreshPrivateImportIndex(ctx, [result.id]);
  return result;
}

/** Scoped browser upload workflow. The CLI operation only accepts local paths. */
export async function runConversationUpload(
  ctx: OpContext,
  provider: unknown,
  preview: string | null,
  read: () => Promise<Uint8Array>,
): Promise<ConversationUploadResult & { preview: string }> {
  checkOpScope({ name: "conversation upload", scope: "write" }, ctx);
  if (!isConversationProvider(provider)) throw new OpError("Choose ChatGPT or Claude as the export provider.", "bad_params");
  const raw = await read();
  const receipt = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([ctx.bundle, provider]))
    .update(raw)
    .digest("hex");
  if (preview !== null && preview !== receipt)
    throw new OpError("The file, provider, or brain changed. Preview this import again.", "bad_params");
  const result = await writing(() => importConversationUpload(ctx.bundle, raw, { provider, dryRun: preview === null }));
  await refreshPrivateImportIndex(ctx, result.imported);
  return { ...result, preview: receipt };
}

/** Browser-only import accepts selected bytes and never reads caller-supplied host paths. */
export async function runPersonalSourceUpload(
  ctx: OpContext,
  kind: unknown,
  preview: string | null,
  read: () => Promise<{ name: string; files: SourceUploadFile[]; selected: number[] }>,
): Promise<SourceUploadResult> {
  checkOpScope({ name: "personal source import", scope: "write" }, ctx);
  if (!isSourceKind(kind) || kind === "notion-live")
    throw new OpError("Choose a bookmarks, Markdown, Notion, email, or calendar export.", "bad_params");
  const { name, files, selected } = await read();
  const result = await writing(() => importPersonalSource(
    ctx.bundle, kind, name, files, preview === null ? undefined : { preview, selected },
  ));
  await refreshPrivateImportIndex(ctx, result.imported);
  return result;
}

/** The connector is available only to the trusted local browser adapter. */
export async function runNotionSource(ctx: OpContext, connector: NotionSource, action: string, input: Record<string, unknown>) {
  if (!ctx.trusted) throw new OpError("Notion connections require the local browser.", "untrusted");
  checkOpScope({ name: "Notion connection", scope: action === "status" ? "read" : "write" }, ctx);
  switch (action) {
    case "status": return connector.status();
    case "connect": return connector.connect(input);
    case "disconnect": return connector.disconnect();
    case "preview": return writing(() => connector.preview(ctx.bundle, input));
    case "import": {
      const outcome = await writing(() => connector.commit(ctx.bundle, input.previewId));
      await refreshPrivateImportIndex(ctx, outcome.imported);
      return outcome;
    }
    default: throw new OpError("Notion action not found.", "not_found");
  }
}

/** Keep filesystem mount administration on the dedicated local Settings route. */
export function runBrainMountChange(ctx: OpContext, input: Record<string, unknown>) {
  checkOpScope({ name: "brain mount settings", scope: "admin" }, ctx);
  return changeBrainMount(input);
}

/** Restore a shared bundle through the same local mount administration boundary. */
export async function runBrainRestore(
  ctx: OpContext, input: Record<string, unknown>, canWrite: () => boolean, servedBundle: string,
) {
  checkOpScope({ name: "restore brain from GitHub", scope: "admin" }, ctx);
  const result = await restoreBrainMount(servedBundle, input, canWrite);
  try {
    const mounted = resolveBrain(result.brain.name);
    if (!canWrite() || mounted.readonly || !sameDir(mounted.path, result.path))
      throw new Error("The mount changed after restore.");
    const restored = openLocalContext(result.path, true, false);
    restored.ctx.brain = mounted.name;
    try { await runOp(getOp("index")!, restored.ctx, {}); }
    finally { await restored.close(); }
  } catch {
    const message = "The brain was restored. Choose Re-index in Settings to make it searchable.";
    result.warning = result.warning ? `${result.warning} ${message}` : message;
  }
  return result;
}

/** The settings edit only local config. All network rules remain in pullFeed. */
export function runRssSettings(ctx: OpContext, input?: unknown): { feeds: string[] } {
  checkOpScope({ name: "rss_settings", scope: "admin" }, ctx);
  const cfg = loadConfig();
  if (input === undefined) return { feeds: cfg.rss?.feeds ?? [] };
  if (typeof input !== "string") throw new OpError("Enter one feed URL per line.", "bad_params");

  const feeds = new Set<string>();
  for (const [index, line] of input.split(/\r?\n/).entries()) {
    const feed = line.trim();
    if (!feed) continue;
    const url = URL.parse(feed);
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new OpError(`Line ${index + 1} must be an HTTP or HTTPS feed URL without credentials.`, "bad_params");
    feeds.add(feed);
  }
  const saved = [...feeds];
  saveConfig({ ...cfg, rss: { ...cfg.rss, feeds: saved } });
  return { feeds: saved };
}

const scheduledEmbedLimit = 100;
const maintenanceId = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface MaintenanceApprovals {
  embedding: { provider: string; model: string; endpoint: string; id: string; limit: number } | null;
  rss: { id: string; count: number } | null;
}

interface ScheduledMaintenanceOptions {
  jobs: readonly string[];
  approvals?: { embed?: string; rss?: string };
  canWrite: () => boolean;
  signal: AbortSignal;
}

type MaintenanceJobStatus = "completed" | "failed" | "skipped";
export interface MaintenanceOutcome {
  status: MaintenanceJobStatus;
  jobs?: { name: string; status: MaintenanceJobStatus; ms: number }[];
  message?: string;
}

function scheduledRss(cfg: OkbConfig) {
  const feeds = cfg.rss?.feeds;
  if (!Array.isArray(feeds) || !feeds.length || feeds.some((feed) => {
    const url = typeof feed === "string" ? URL.parse(feed) : null;
    return !url || !["http:", "https:"].includes(url.protocol) || url.username || url.password;
  })) return null;
  const maxItems = cfg.rss?.maxItems;
  const limit = typeof maxItems === "number" && Number.isInteger(maxItems) ? Math.max(0, Math.min(100, maxItems)) : 10;
  const id = maintenanceId(["okbrain-scheduled-rss-v1", feeds, limit]);
  return { feeds: [...feeds], limit, approval: { id, count: feeds.length } };
}

async function scheduledEmbedding(ctx: OpContext) {
  const ai = ctx.config().ai ?? {};
  const env = gatewayEnvironment();
  // An API key or chat provider alone does not authorize background embedding.
  if (!ai.embedProvider && !ai[brainAiDefaults]?.embedProvider && !env.OKB_EMBED_PROVIDER) return null;
  try {
    const { provider, model, baseUrl, apiKey, recipe } = resolveCall("embed", ai, env);
    const url = URL.parse(baseUrl);
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      baseUrl.length > 2048 || !model || model.length > 256 || (recipe.kind === "api" && !apiKey) || !await ctx.hasVectors()) return null;
    const id = maintenanceId(["okbrain-scheduled-embedding-v1", provider, model, baseUrl, scheduledEmbedLimit]);
    return { ai, provider, model, baseUrl, apiKey,
      approval: { id, provider, model, endpoint: url.href, limit: scheduledEmbedLimit } };
  } catch (error) {
    if (error instanceof AiError || error instanceof EngineError) return null;
    throw error;
  }
}

export async function maintenanceApprovals(ctx: OpContext): Promise<MaintenanceApprovals> {
  if (!ctx.trusted || ctx.readonly) return { embedding: null, rss: null };
  const embedding = await scheduledEmbedding(ctx);
  return { embedding: embedding?.approval ?? null, rss: scheduledRss(ctx.config())?.approval ?? null };
}

async function refreshMaintenanceVectors(ctx: OpContext, ai: AiSettings, pinned?: AiOptions, limit?: number) {
  const s = await embedBundle(ctx.bundle, await ctx.vectors(), gatewayEmbedder(ai, pinned), {
    limit, includePrivate: false, preservePrivateVectors: pinned !== undefined,
  });
  return `embedded ${s.embedded}, skipped ${s.skipped}, removed ${s.removed}${s.pending > 0 ? `, ${s.pending} pending` : ""}`;
}

async function refreshMaintenanceFeeds(ctx: OpContext, feeds: string[], limit?: number, scheduled = false) {
  // Scheduled RSS updates search, but embedding requires a separate allowance.
  const rs = await pullFeeds(ctx, feeds, limit, !scheduled);
  const added = rs.reduce((n, r) => n + r.added.length, 0);
  const failed = rs.filter((r) => r.error !== undefined);
  if (scheduled && failed.length) throw new Error("A configured RSS feed could not update.");
  return `${added} added across ${rs.length} feeds${failed.length > 0 ? `; failed: ${failed.map((f) => f.url).join(", ")}` : ""}`;
}

function maintenanceJobs(ctx: OpContext, options?: ScheduledMaintenanceOptions, notices?: Set<string>): Job[] {
  const cfg = options ? undefined : ctx.config();
  const feeds = cfg?.rss?.feeds ?? [];
  const explain = (reason: string) => { notices?.add(reason); return reason; };
  let approvedEmbed: Awaited<ReturnType<typeof scheduledEmbedding>> = null;
  let approvedRss: ReturnType<typeof scheduledRss> = null;
  return [
    {
      name: "index",
      run: async () => renderStats(await withIndexWrite(ctx.bundle, async () => buildIndex(ctx.bundle, await ctx.engine(true)))),
    },
    {
      name: "embed",
      skip: async () => {
        if (!options) return await ctx.hasVectors() ? undefined : "no vector store — run `okb embed` once to opt in";
        const selected = await scheduledEmbedding(ctx);
        if (!selected) return explain("Set an embedding provider and build its vector index in Settings to schedule embedding.");
        if (selected.approval.id !== options.approvals?.embed) return explain("Review the embedding settings and approve scheduled embedding again.");
        const meta = await (await ctx.vectors()).meta();
        if (meta && (meta.provider !== selected.provider || meta.model !== selected.model))
          return explain("Run Embed in Settings to update the vector index for this provider and model.");
        approvedEmbed = selected;
      },
      run: async () => {
        if (!options) return refreshMaintenanceVectors(ctx, cfg?.ai ?? {});
        const { ai, provider, model, baseUrl, apiKey, approval } = approvedEmbed!;
        return refreshMaintenanceVectors(ctx, ai, { provider, model, baseUrl, apiKey }, approval.limit);
      },
    },
    {
      name: "rss",
      skip: async () => {
        if (!options) return feeds.length > 0 ? undefined : "no rss.feeds configured";
        const selected = scheduledRss(ctx.config());
        if (!selected) return explain("Configure RSS feeds in Settings before scheduling updates.");
        if (selected.approval.id !== options.approvals?.rss) return explain("Review the RSS feed settings and approve scheduled updates again.");
        approvedRss = selected;
      },
      run: async () => options
        ? refreshMaintenanceFeeds(ctx, approvedRss!.feeds, approvedRss!.limit, true)
        : refreshMaintenanceFeeds(ctx, feeds, cfg?.rss?.maxItems),
    },
    {
      // F-B.7's queue is computed on demand, so the job surfaces today's queue.
      name: "review",
      run: async () => {
        const q = await queueFor(ctx);
        return q.length === 0
          ? "queue empty"
          : q.map((it, i) => `${i + 1}. ${it.id} (${it.score.toFixed(2)}) — ${it.reasons.join("; ")}`).join("\n");
      },
    },
    {
      name: "doctor",
      run: async () => {
        const rep = await runDoctor(ctx.bundle);
        if (options && !rep.ok) throw new Error("The brain has conformance errors.");
        return `${rep.ok ? "ok" : "NOT CONFORMANT"} — ${rep.errors} errors, ${rep.warnings} warnings`;
      },
    },
  ];
}

export async function runScheduledMaintenance(ctx: OpContext, options: ScheduledMaintenanceOptions): Promise<MaintenanceOutcome> {
  const notices = new Set<string>();
  const picked = maintenanceJobs(ctx, options, notices).filter(({ name }) => options.jobs.includes(name));
  if (!picked.length || options.jobs.some((name) => !picked.some((job) => job.name === name)))
    return { status: "failed", message: "Choose supported maintenance jobs in Settings." };
  try {
    const results = await runJobs(ctx.bundle, picked, { signal: options.signal,
      canWrite: () => ctx.trusted && !ctx.readonly && options.canWrite() });
    const jobs = results.map(({ name, skipped, ok, ms }) => ({ name, status: skipped ? "skipped" as const : ok ? "completed" as const : "failed" as const, ms }));
    const failed = jobs.some((job) => job.status === "failed");
    if (failed) notices.add("A maintenance job failed. Run it manually in Settings for details.");
    if (results.some(({ detail }) => detail === jobShutdown)) notices.add("Maintenance stopped when the app closed.");
    if (results.some(({ detail }) => detail === jobReadOnly)) notices.add("Open a writable brain to run its maintenance schedule.");
    return { status: failed ? "failed" : jobs.some((job) => job.status === "completed") ? "completed" : "skipped",
      jobs, ...(notices.size ? { message: [...notices].join(" ") } : {}) };
  } catch (error) {
    if (error instanceof JobLockError) return { status: "skipped", message: "Another maintenance run holds the brain’s job lock." };
    return { status: "failed", message: "Maintenance could not start. Check the brain and try again in Settings." };
  }
}

export const operations: readonly Operation[] = [
  {
    name: "search",
    cliName: "search",
    summary: "Search the brain (hybrid: keyword + vector recall, graph expansion)",
    scope: "read",
    params: [
      { name: "query", type: "string", required: true, positional: true, description: "search terms" },
      { name: "limit", type: "int", description: "maximum hits (default 20)" },
      { name: "profile", type: "string", description: "retrieval profile: lean|balanced|max (default balanced)" },
      { name: "keyword-only", type: "boolean", description: "use the local keyword index without provider calls" },
    ],
    handler: async (ctx, p) => {
      const profile = profileOf(ctx, p);
      const query = p.query as string;
      const keywordOnly = p["keyword-only"] === true;
      const { hits, vectorSkipped } = await hybridRetrieve(
        [query],
        keywordOnly ? { engine: await ctx.engine() } : await hybridArms(ctx),
        profile,
        (p.limit as number | undefined) ?? 20,
        true,
      );
      await warnVectorSkip(ctx, vectorSkipped);
      return keywordOnly ? hits : maybeRerank(ctx, query, hits, profile);
    },
    render: (r) => {
      const hits = r as HybridHit[];
      if (hits.length === 0) return "(no hits)";
      return hits.flatMap((h) => {
        const title = `${h.score.toFixed(3)}  ${h.id} — ${h.title}  [${h.sources.join("+")}]`;
        const excerpt = h.keywordExcerpt?.map(({ text, match }) => {
          const safe = stripVTControlCharacters(text).replace(/\s+/gu, " ");
          return match ? `[${safe}]` : safe;
        }).join("");
        return excerpt ? [title, `       ${excerpt}`] : [title];
      }).join("\n");
    },
  },
  {
    name: "ask",
    cliName: "ask",
    summary: "Ask the brain a question (RAG answer with verified citations)",
    scope: "read",
    params: [
      { name: "question", type: "string", required: true, positional: true, description: "the question to answer from your notes" },
      { name: "profile", type: "string", description: "retrieval profile: lean|balanced|max (default balanced)" },
      { name: "stream", type: "boolean", description: "print answer text as it arrives (plain CLI output)" },
      { name: "include-private", type: "boolean", description: "allow private notes in the answer provider context" },
    ],
    handler: (ctx, p) => runAsk(ctx, p),
    stream: (ctx, p, emit, signal) => runAsk(ctx, p, emit, signal),
    render: renderAnswer,
    renderStreamFooter: renderAnswerFooter,
  },
  {
    name: "ask_plan",
    cliName: "ask-plan",
    summary: "Ask the brain using your ChatGPT plan and local retrieval",
    scope: "read",
    localOnly: true,
    params: [
      { name: "question", type: "string", required: true, positional: true, description: "question to answer using your notes" },
      { name: "model", type: "string", description: "model slug from `okb chatgpt models`" },
      { name: "include-private", type: "boolean", description: "allow private notes in the ChatGPT context" },
    ],
    handler: async (ctx, p) => {
      const plan = createChatgptPlan();
      const result = await askBrain(p.question as string, {
        bundle: ctx.bundle,
        arms: { engine: await ctx.engine() },
        includePrivate: p["include-private"] === true,
        chat: async (messages) => ({
          ...(await plan.complete(messages, p.model as string | undefined)),
          provider: "chatgpt-plan",
        }),
      }, { ...PROFILES.balanced!, rerank: false });
      recordCitedNotes(ctx, result.citations.map(({ id }) => id));
      return result;
    },
    render: renderAnswer,
  },
  {
    name: "chatgpt_connect",
    cliName: "chatgpt connect",
    summary: "Sign in with ChatGPT and authorize plan usage",
    scope: "read",
    localOnly: true,
    bundleIndependent: true,
    params: [{ name: "account", type: "string", description: "local label for a ChatGPT account or workspace" }],
    handler: (_ctx, p) => createChatgptPlan().connect(p.account as string | undefined),
    render: renderChatgptStatus,
  },
  {
    name: "chatgpt_status",
    cliName: "chatgpt status",
    summary: "Show the active ChatGPT account and saved labels",
    scope: "read",
    localOnly: true,
    bundleIndependent: true,
    params: [],
    handler: () => createChatgptPlan().status(),
    render: renderChatgptStatus,
  },
  {
    name: "chatgpt_use",
    cliName: "chatgpt use",
    summary: "Switch to a saved ChatGPT account or workspace",
    scope: "read",
    localOnly: true,
    bundleIndependent: true,
    params: [{ name: "account", type: "string", required: true, positional: true, description: "saved account label" }],
    handler: (_ctx, p) => createChatgptPlan().use(p.account as string),
    render: renderChatgptStatus,
  },
  {
    name: "chatgpt_disconnect",
    cliName: "chatgpt disconnect",
    summary: "Sign out of the selected ChatGPT account",
    scope: "read",
    localOnly: true,
    bundleIndependent: true,
    params: [],
    handler: () => createChatgptPlan().disconnect(),
    render: (r) => (r as { revoked: boolean }).revoked
      ? "ChatGPT account signed out."
      : `ChatGPT account signed out locally. Confirm remote access removal at ${CHATGPT_USAGE}`,
  },
  {
    name: "chatgpt_models",
    cliName: "chatgpt models",
    summary: "List models available to the selected ChatGPT plan",
    scope: "read",
    localOnly: true,
    bundleIndependent: true,
    params: [],
    handler: () => createChatgptPlan().models(),
    render: (r) => ((r as { slug: string; name: string }[]).map((m) => `${m.slug} — ${m.name}`).join("\n")) || "No models available.",
  },
  {
    name: "code_context",
    cliName: "code context",
    summary: "Preview task-relevant excerpts from tracked project files without calling a model",
    scope: "read",
    localOnly: true,
    bundleIndependent: true,
    params: [
      codingWorkspace,
      ...repositorySelectionParams.map((param) => param.name === "query" ? { ...param, required: true } : param),
      { name: "show-content", type: "boolean", description: "include the excerpt text in the preview" },
    ],
    handler: async (_ctx, p) => {
      const { selectRepositoryContext, RepositoryContextError } = await import("./coding/repository-context.ts");
      try {
        const selection = await selectRepositoryContext({ workspace: p.workspace as string, ...repositorySelectionFrom(p) });
        return p["show-content"] ? selection : { manifest: selection.manifest };
      } catch (error) {
        if (error instanceof RepositoryContextError) throw new OpError(error.message, "refused");
        throw error;
      }
    },
    render: (r) => {
      const { manifest, excerpts, guidance } = r as Partial<RepositoryContextSelection> & Pick<RepositoryContextSelection, "manifest">;
      return renderRepositoryContext(manifest, excerpts, guidance);
    },
  },
  {
    name: "code_run",
    cliName: "code run",
    summary: "Start or resume a Pi Durable coding request for human review",
    scope: "read",
    localOnly: true,
    bundleIndependent: true,
    params: [
      ...codingSessionParams,
      { name: "request-id", type: "string", required: true, description: "stable ID for one request or retry" },
      { name: "prompt", type: "string", description: "coding task (omit when resuming a saved request)" },
      { name: "files", type: "string", description: "comma-separated workspace-relative text files to attach" },
      ...repositorySelectionParams,
      { name: "context-id", type: "string", description: "ID issued by `okb code context` for the same selection" },
    ],
    handler: async (_ctx, p) => {
      const usesRepository = p.projects !== undefined || p["profile-json"] !== undefined || p.query !== undefined || p["context-tokens"] !== undefined || p["context-id"] !== undefined;
      if (p.prompt === undefined && (p.files !== undefined || usesRepository))
        throw new OpError("Use source selection flags with a new request prompt.", "bad_params");
      if (usesRepository && ((p.projects === undefined && p["profile-json"] === undefined) || p.query === undefined || p["context-id"] === undefined))
        throw new OpError(p["profile-json"] === undefined
          ? "Use --projects, --query, and --context-id together. Get the ID from `okb code context`."
          : "Use --profile-json, --query, and --context-id together. Get the ID from `okb code context`.", "bad_params");
      if (usesRepository && p.files !== undefined)
        throw new OpError("Choose either --files or a previewed repository context.", "bad_params");
      const { CodingError, runCodingSession } = await import("./coding/durable.ts");
      try {
        return await runCodingSession({
          ...codingSessionParamsFrom(p),
          requestId: p["request-id"] as string,
          prompt: p.prompt as string | undefined,
          files: (p.files as string | undefined)?.split(",").map((file) => file.trim()),
          repository: usesRepository ? { ...repositorySelectionFrom(p), id: p["context-id"] as string } : undefined,
        });
      } catch (error) {
        if (error instanceof CodingError) throw new OpError(error.message, "refused");
        throw error;
      }
    },
    render: (r) => {
      const result = r as CodingSessionResult;
      if (result.status === "unanswered") return stripVTControlCharacters(`Request ${result.requestId} unanswered: ${result.reason}`);
      const text = result.stopReason === "length" ? `${result.text}\n\nThe model reached its output limit.` : result.text;
      return stripVTControlCharacters(text);
    },
    exitCode: (r) => (r as CodingSessionResult).status === "done" ? 0 : 1,
  },
  {
    name: "code_status",
    cliName: "code status",
    summary: "Inspect saved request status, model context, and recorded usage without a model call",
    scope: "read",
    localOnly: true,
    bundleIndependent: true,
    params: [
      ...codingSessionParams,
      { name: "request-id", type: "string", description: "inspect one saved request, including its source selection" },
    ],
    handler: async (_ctx, p) => {
      const { CodingError, getCodingSessionStatus } = await import("./coding/durable.ts");
      try {
        return await getCodingSessionStatus({ ...codingSessionParamsFrom(p), requestId: p["request-id"] as string | undefined });
      } catch (error) {
        if (error instanceof CodingError) throw new OpError(error.message, "refused");
        throw error;
      }
    },
    render: (r) => {
      const result = r as CodingSessionStatusResult;
      const { context, request, usage } = result;
      const lines = [
        `Session ${result.session} (${result.provider}/${result.model})`,
        `Pending requests: ${result.pendingRequestIds.join(", ") || "none"}`,
        context.limitTokens === undefined
          ? `Estimated active context: ${context.estimatedTokens} tokens. Model window unavailable.`
          : `Estimated active context: ${context.estimatedTokens}/${context.limitTokens} tokens (${context.maxOutputTokens} reserved for output; model window ${context.modelWindowTokens}).`,
      ];
      if (context.historyCompacted) lines.push("Older turns are compacted in the active context. The original transcript is retained.");
      if (context.compactionPending) lines.push("Local compaction is awaiting recovery. Open this session in the app and choose Compact context locally.");
      const renderUsage = (label: string, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }) =>
        `${label}: ${tokens.totalTokens} total tokens (${tokens.input} input, ${tokens.output} output, ${tokens.cacheRead} cache read, ${tokens.cacheWrite} cache write).`;
      const sessionUsage = usage.models[`${result.provider}/${result.model}`];
      if (sessionUsage) lines.push(renderUsage("Session usage", sessionUsage));
      else lines.push("Session usage: no provider usage recorded.");
      if (request) {
        lines.push(`Request ${request.requestId}: ${request.status}${request.reason ? ` (${request.reason})` : ""}.`);
        if (request.stopReason === "length") lines.push("The model reached its output limit.");
        if (request.usage) lines.push(renderUsage("Request usage", request.usage));
        if (request.repositoryContext) lines.push(renderRepositoryContext(request.repositoryContext));
      }
      return stripVTControlCharacters(lines.join("\n"));
    },
  },
  {
    name: "read_concept",
    cliName: "read",
    summary: "Read one concept (frontmatter + body) by id",
    scope: "read",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id, e.g. notes/foo" },
    ],
    handler: async (ctx, p): Promise<ConceptView & { localUsage?: LocalUsageView }> => {
      const view = await readConceptView(ctx.bundle, p.id as string);
      const localUsage = recordNoteOpen(ctx, view.id, view.frontmatter);
      return localUsage ? { ...view, localUsage } : view;
    },
    render: (r) => (r as ConceptView).raw,
  },
  {
    name: "list_concepts",
    cliName: "list",
    summary: "List concept ids (or, with --detail, a browsable listing with status/trust)",
    scope: "read",
    params: [
      { name: "detail", type: "boolean", description: "return title/type/description/tags plus OKF v0.2 signals per concept" },
      { name: "type", type: "string", description: "only concepts of this type" },
      { name: "tag", type: "string", description: "only concepts carrying this tag" },
      { name: "status", type: "string", description: "only this lifecycle status: draft|stable|deprecated" },
      { name: "limit", type: "int", description: "maximum rows" },
    ],
    handler: async (ctx, p) => {
      if (p.status !== undefined && !(STATUSES as readonly unknown[]).includes(p.status))
        throw new OpError(`status must be one of ${STATUSES.join(", ")}`, "bad_params");
      const filtered = p.type !== undefined || p.tag !== undefined || p.status !== undefined;
      const ids = await listConcepts(ctx.bundle);
      if (p.detail !== true && !filtered) return ids.slice(0, (p.limit as number | undefined) ?? ids.length);
      const rows: ConceptRow[] = [];
      for (const id of ids) {
        const fm = (await readConceptPermissive(ctx.bundle, id)).doc.frontmatter;
        const row: ConceptRow = {
          id,
          type: fmString(fm.type),
          title: fmString(fm.title),
          description: fmString(fm.description),
          tags: fmTags(fm.tags),
          ...signalsOf(fm),
        };
        if (p.type !== undefined && row.type !== p.type) continue;
        if (p.tag !== undefined && !row.tags.includes(p.tag as string)) continue;
        if (p.status !== undefined && row.status !== p.status) continue;
        rows.push(row);
        if (rows.length === (p.limit as number | undefined)) break;
      }
      return p.detail === true ? rows : rows.map((r) => r.id);
    },
    render: (r) => {
      const rows = r as (string | ConceptRow)[];
      if (rows.length === 0) return "(no concepts)";
      return rows
        .map((x) =>
          typeof x === "string"
            ? x
            : `${x.id} — ${x.title || "(untitled)"}  [${x.type || "?"} · ${x.status} · ${x.trust}${x.stale ? " · STALE" : ""}]`,
        )
        .join("\n");
    },
  },
  {
    name: "graph_neighbors",
    cliName: "graph",
    summary: "Show the link neighborhood of a concept (→ links to, ← cited by)",
    scope: "read",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id at the center" },
      { name: "depth", type: "int", description: "hops to walk (default 1)" },
    ],
    handler: async (ctx, p) => {
      const id = p.id as string;
      const eng = await ctx.engine();
      await requireNode(eng, id);
      const { out, in: cited } = await eng.edgesOf(id);
      const dirOf = (n: Neighbor): Dir | undefined =>
        n.depth !== 1
          ? undefined
          : out.includes(n.id)
            ? cited.includes(n.id)
              ? "both"
              : "out"
            : "in";
      const neighbors = await eng.neighbors(id, (p.depth as number | undefined) ?? 1);
      return Promise.all(neighbors.map(async (n): Promise<TitledNeighbor> => ({
        ...n, title: (await eng.getNode(n.id))?.title ?? "", dir: dirOf(n),
      })));
    },
    render: (r) => {
      const ns = r as TitledNeighbor[];
      if (ns.length === 0) return "(no neighbors)";
      return ns
        .map((n) => `${n.depth} ${n.dir ? DIR_MARK[n.dir] : " "} ${n.id} — ${n.title}`)
        .join("\n");
    },
  },
  {
    name: "focused_map",
    cliName: "map",
    summary: "Map direct links around a concept or a local keyword query",
    scope: "read",
    params: [
      { name: "query", type: "string", positional: true, description: "local keyword query" },
      { name: "id", type: "string", description: "concept ID to focus instead of searching" },
      { name: "source", type: "string", description: "all|notes|web|imports" },
      { name: "since", type: "string", description: "include notes changed on or after this date (YYYY-MM-DD)" },
      { name: "include-private", type: "boolean", description: "include private draft nodes and their relationships" },
    ],
    handler: async (ctx, p) => {
      const { id, query, since } = p as { id?: string; query?: string; since?: string };
      if (Boolean(id?.trim()) === Boolean(query?.trim()) || (query?.length ?? 0) > 1000)
        throw new OpError("Choose one concept ID or a query up to 1,000 characters.", "bad_params");
      const source = p.source as typeof MAP_SOURCES[number] | undefined;
      if (source && !MAP_SOURCES.includes(source)) throw new OpError("Unknown source filter.", "bad_params");
      if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since))
        throw new OpError("Choose a valid start date.", "bad_params");
      return focusedMap(ctx.bundle, await ctx.engine(), { id: id?.trim(), query: query?.trim(), source, since, includePrivate: p["include-private"] === true });
    },
    render(result) {
      const map = result as Awaited<ReturnType<typeof focusedMap>>;
      return [...map.nodes.map((node) => `${node.id} — ${node.title}`),
        ...map.edges.map((edge) => `${edge.src} → ${edge.dst}${edge.rel ? ` (${edge.rel})` : ""}`),
        ...(map.bounded ? ["Map limited. Narrow the query or focus on one concept."] : []),
      ].join("\n") || "(no matching notes)";
    },
  },
  {
    name: "graph_path",
    cliName: "path",
    summary: "Shortest chain of links (either direction) between two concepts",
    scope: "read",
    params: [
      { name: "from", type: "string", required: true, positional: true, description: "start concept id" },
      { name: "to", type: "string", required: true, positional: true, description: "end concept id" },
      { name: "max-depth", type: "int", description: "hop limit for the search (default 10)" },
    ],
    handler: async (ctx, p) => {
      const eng = await ctx.engine();
      const [from, to] = [p.from as string, p.to as string];
      await requireNode(eng, from);
      await requireNode(eng, to);
      const edges = await eng.listEdges();
      const ids = shortestPath(edges, from, to, (p["max-depth"] as number | undefined) ?? 10);
      if (!ids) return null;
      const fwd = new Set(edges.map((e) => JSON.stringify([e.src, e.dst])));
      const has = (a: string, b: string) => fwd.has(JSON.stringify([a, b]));
      return Promise.all(ids.map(async (id, i): Promise<PathHop> => {
        const hop: PathHop = { id, title: (await eng.getNode(id))?.title ?? "" };
        if (i > 0) {
          const prev = ids[i - 1]!;
          hop.dir = has(prev, id) ? (has(id, prev) ? "both" : "out") : "in";
        }
        return hop;
      }));
    },
    render: (r) => {
      const hops = r as PathHop[] | null;
      if (!hops) return "(no path)";
      return hops
        .map((h, i) => (i === 0 ? h.id : ` ${DIR_MARK[h.dir!]} ${h.id}`))
        .join("");
    },
    exitCode: (r) => (r === null ? 1 : 0),
  },
  {
    name: "orphans",
    cliName: "orphans",
    summary: "List concepts with no links in or out",
    scope: "read",
    params: [],
    handler: async (ctx) => {
      const eng = await ctx.engine();
      const ids = orphans(await eng.listNodeIds(), await eng.listEdges());
      return Promise.all(ids.map(async (id) => ({ id, title: (await eng.getNode(id))?.title ?? "" })));
    },
    render: (r) => {
      const os = r as { id: string; title: string }[];
      if (os.length === 0) return "(no orphans)";
      return os.map((o) => `${o.id} — ${o.title}`).join("\n");
    },
  },
  {
    name: "stats",
    cliName: "stats",
    summary: "Brain at a glance: concept/link/tag counts, orphans, freshness",
    scope: "read",
    params: [],
    handler: async (ctx) => {
      const eng = await ctx.engine();
      return computeStats(await eng.listReviewRows(), await eng.listEdges(), await eng.tagCounts(), new Date());
    },
    render: (r) => {
      const s = r as BrainStats;
      const lines = [
        `${s.concepts} concepts, ${s.edges} links (${s.typedEdges} typed), ${s.tags} tags`,
      ];
      if (s.byType.length > 0)
        lines.push("by type:  " + s.byType.map((t) => `${t.type} ${t.count}`).join(", "));
      if (s.topTags.length > 0)
        lines.push("top tags: " + s.topTags.map((t) => `${t.tag} ${t.count}`).join(", "));
      lines.push(
        `orphans ${s.orphans}, inbox ${s.inbox}, never reviewed ${s.neverReviewed}, stale ${s.stale} (>${s.staleDays}d), past stale_after ${s.expired}`,
        `status:   draft ${s.byStatus.draft}, stable ${s.byStatus.stable}, deprecated ${s.byStatus.deprecated}`,
        `trust:    unverified ${s.byTrust.unverified}, machine-confirmed ${s.byTrust["machine-confirmed"]}, human-reviewed ${s.byTrust["human-reviewed"]}`,
      );
      if (s.newest) lines.push(`freshest ${s.newest.slice(0, 10)}, oldest ${s.oldest!.slice(0, 10)}`);
      return lines.join("\n");
    },
  },
  {
    name: "doctor",
    cliName: "doctor",
    summary: "Check the bundle for OKF conformance issues",
    scope: "read",
    params: [],
    handler: (ctx) => runDoctor(ctx.bundle),
    render: (r) => {
      const rep = r as DoctorReport;
      return [
        ...rep.findings.map(
          (f) => `${f.severity === "error" ? "ERROR" : "warn "}  ${f.path}  ${f.message} [${f.check}]`,
        ),
        `${rep.ok ? "ok" : "not conformant"} — ${rep.files} files, ${rep.concepts} concepts, ${rep.errors} errors, ${rep.warnings} warnings (okf_version ${rep.okfVersion ?? "undeclared"})`,
        `signals — trust: ${rep.signals.trust["human-reviewed"]} human-reviewed, ${rep.signals.trust["machine-confirmed"]} machine-confirmed, ${rep.signals.trust.unverified} unverified; status: ${rep.signals.status.draft} draft, ${rep.signals.status.deprecated} deprecated; ${rep.signals.stale} past stale_after; ${rep.signals.legacy} still v0.1`,
      ].join("\n");
    },
    exitCode: (r) => ((r as DoctorReport).ok ? 0 : 1),
  },
  {
    name: "write_concept",
    cliName: "write",
    summary: "Create or update a concept through the conformance writer",
    scope: "write",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id, e.g. notes/foo" },
      { name: "type", type: "string", description: "concept type (required on create)" },
      { name: "title", type: "string", description: "title (required on create)" },
      { name: "description", type: "string", description: "one-line description (required on create)" },
      { name: "body", type: "string", description: "markdown body; links are normalized to bundle-absolute" },
      { name: "tags", type: "string", description: "comma-separated tags (empty string clears)" },
      { name: "resource", type: "string", description: "canonical URI for reference concepts" },
      { name: "status", type: "string", description: "lifecycle: draft|stable|deprecated (empty string clears)" },
      { name: "stale-after", type: "string", description: "ISO instant after which the content is stale, e.g. 2026-12-31T00:00:00Z (empty clears)" },
      { name: "sources", type: "string", description: "provenance: comma-separated URLs/paths, or a JSON array of {resource,id,title,…} (empty clears)" },
      { name: "private", type: "boolean", description: "create a local-only note using this explicit ID" },
    ],
    handler: async (ctx, p) => {
      const id = p.id as string;
      if (p.private === true) {
        checkOpScope({ name: "private note creation", scope: "admin" }, ctx);
        if (existsSync(idToAbsPath(ctx.bundle, id))) throw new OpError("To keep an existing note local, use okb keep-private.", "bad_params");
        if ([p.type, p.title, p.description].some((field) => typeof field !== "string" || !field.trim()))
          throw new OpError("Enter a type, title, and description to create a private note.", "bad_params");
        await writing(() => protectUnsharedNote(ctx.bundle, id));
      }
      const r = await writing(() =>
        writeConcept(ctx.bundle, {
          id,
          type: p.type as string | undefined,
          title: p.title as string | undefined,
          description: p.description as string | undefined,
          body: p.body as string | undefined,
          resource: p.resource as string | undefined,
          tags: parseTags(p.tags),
          status: p.status as string | undefined,
          staleAfter: p["stale-after"] as string | undefined,
          sources: parseSources(p.sources),
          actor: ctx.actor(),
          extra: p.private === true ? { db_only: true } : undefined,
        }, { createOnly: p.private === true }),
      );
      if (p.private === true && !r.created) throw new OpError("Another note now uses this ID.", "bad_params");
      await reindex(ctx, [r.id]);
      return r;
    },
    render: renderWrite,
  },
  {
    name: "keep_private",
    cliName: "keep-private",
    summary: "Keep an existing unpublished note local to this brain",
    scope: "admin",
    params: [{ name: "id", type: "string", required: true, positional: true, description: "unpublished concept ID" }],
    handler: async (ctx, p) => writing(async () => {
      const id = p.id as string;
      const note = await readConceptView(ctx.bundle, id);
      if (!isPrivateConcept(id, note.frontmatter)) {
        await protectUnsharedNote(ctx.bundle, id);
        await writeConcept(ctx.bundle, { id, metadataOnly: true, extra: { db_only: true } });
      }
      await removePrivateLogEntries(ctx.bundle, new Set([id]));
      await reindex(ctx, [id]);
      return { id, private: true };
    }),
    render: (r) => `kept ${(r as { id: string }).id} private`,
  },
  {
    name: "new_concept",
    cliName: "new",
    summary: "Create a concept; its id is derived from type and title",
    scope: "write",
    params: [
      { name: "type", type: "string", required: true, positional: true, description: "concept type, e.g. note" },
      { name: "title", type: "string", required: true, positional: true, description: "concept title" },
      { name: "description", type: "string", required: true, positional: true, description: "one-line description" },
      { name: "body", type: "string", description: "markdown body" },
      { name: "tags", type: "string", description: "comma-separated tags" },
      { name: "resource", type: "string", description: "canonical URI for reference concepts" },
      { name: "status", type: "string", description: "lifecycle: draft|stable|deprecated (default stable)" },
      { name: "id", type: "string", description: "override the derived id (default <type>s/<title-slug>)" },
    ],
    handler: async (ctx, p) => {
      const r = await writing(async () => {
        const id =
          (p.id as string | undefined) ?? `${slugify(p.type as string)}s/${slugify(p.title as string)}`;
        const note = await writeConcept(ctx.bundle, {
          id,
          type: p.type as string,
          title: p.title as string,
          description: p.description as string,
          body: p.body as string | undefined,
          resource: p.resource as string | undefined,
          tags: parseTags(p.tags),
          status: p.status as string | undefined,
          actor: ctx.actor(),
        }, { createOnly: true });
        if (!note.created) throw new OpError(`concept exists: ${id} (update it with \`okb write\`)`, "refused");
        return note;
      });
      await reindex(ctx, [r.id]);
      return r;
    },
    render: renderWrite,
  },
  {
    name: "capture",
    cliName: "capture",
    summary: "Quick-capture text (or piped stdin) as a note under inbox/",
    scope: "write",
    params: [
      { name: "text", type: "string", required: true, positional: true, stdinFallback: true, description: "text to capture (or pipe it on stdin)" },
      { name: "title", type: "string", description: "title (default: first line of the text)" },
      { name: "tags", type: "string", description: "comma-separated tags" },
    ],
    handler: async (ctx, p) => {
      const r = await writing(() =>
        captureNote(ctx.bundle, {
          text: p.text as string,
          title: p.title as string | undefined,
          tags: parseTags(p.tags),
          actor: ctx.actor(),
        }),
      );
      await reindex(ctx, [r.id]);
      return r;
    },
    render: renderWrite,
  },
  {
    name: "import",
    cliName: "import",
    summary: "Import existing markdown (file or directory) as OKF concepts",
    scope: "write",
    params: [
      { name: "path", type: "string", required: true, positional: true, description: "markdown file or directory to import" },
      { name: "type", type: "string", description: "type for sources without one (default note)" },
      { name: "dest", type: "string", description: "bundle directory to import into (default: mirror the source layout at the root)" },
      { name: "overwrite", type: "boolean", description: "update concepts whose id already exists (default: skip)" },
    ],
    handler: async (ctx, p) => {
      const imported: string[] = [];
      try {
        return await writing(() => importPath(ctx.bundle, {
          path: p.path as string,
          type: p.type as string | undefined,
          dest: p.dest as string | undefined,
          overwrite: p.overwrite as boolean | undefined,
          actor: TOOL_ACTOR,
        }, (id) => imported.push(id)));
      } finally {
        if (imported.length > 0) await reindex(ctx, imported);
      }
    },
    render: (r) => {
      const res = r as ImportResult;
      return [
        ...res.imported.map((id) => `imported ${id}`),
        ...res.skipped.map((s) => `skipped ${s.path} — ${s.reason}`),
        `${res.imported.length} imported, ${res.skipped.length} skipped`,
      ].join("\n");
    },
  },
  {
    name: "import_conversations",
    cliName: "import-conversations",
    summary: "Import text from a local ChatGPT or Claude export as private drafts",
    scope: "write",
    localOnly: true,
    params: [
      { name: "path", type: "string", required: true, positional: true, description: "one extracted conversations JSON file" },
      { name: "provider", type: "string", required: true, description: "export format: chatgpt or claude" },
      { name: "dry-run", type: "boolean", description: "preview without writing draft notes" },
    ],
    handler: async (ctx, p) => {
      const provider = p.provider;
      if (!isConversationProvider(provider)) throw new OpError("Choose chatgpt or claude as the export provider.", "bad_params");
      const result = await writing(() => importConversations(ctx.bundle, {
        provider,
        path: p.path as string,
        dryRun: p["dry-run"] === true,
      }));
      await refreshPrivateImportIndex(ctx, result.imported);
      return result;
    },
    render: (r) => {
      const { imported, planned, skipped } = r as ConversationImportResult;
      return [
        ...imported.map((id) => `imported ${id}`),
        ...planned.map((id) => `would import ${id}`),
        ...skipped.map(({ row, id, reason }) => `skipped row ${row}${id ? ` (${id})` : ""} — ${reason}`),
        `${imported.length} imported, ${planned.length} planned, ${skipped.length} skipped`,
      ].join("\n");
    },
  },
  {
    name: "personal_source_import",
    cliName: "source import",
    summary: "Preview local email or calendar files and save selected rows as private drafts",
    scope: "write",
    localOnly: true,
    params: [
      { name: "path", type: "string", required: true, positional: true, description: "one .eml or .ics file, or a directory of files" },
      { name: "kind", type: "string", required: true, description: "export format: email or calendar" },
      { name: "name", type: "string", required: true, description: "source name to reuse for later imports" },
      { name: "preview", type: "string", description: "receipt from a prior preview of this selection" },
      { name: "selected", type: "string", description: "comma-separated draft row numbers from the preview" },
    ],
    handler: (ctx, p) => {
      if (!isOfflineSourceKind(p.kind)) throw new OpError("Choose email or calendar.", "bad_params");
      const kind = p.kind;
      const preview = p.preview as string | undefined;
      const rows = p.selected as string | undefined;
      if ((preview === undefined) !== (rows === undefined))
        throw new OpError("Pass both --preview and --selected to confirm an import.", "bad_params");
      const selected = rows?.split(",").map((row) => Number(row.trim())) ?? [];
      if (preview !== undefined && (!/^[a-f0-9]{64}$/.test(preview) || selected.length > MAX_SOURCE_ROWS ||
          selected.some((row) => !Number.isSafeInteger(row) || row < 1)))
        throw new OpError("Pass a preview receipt and positive draft row numbers.", "bad_params");
      return runPersonalSourceUpload(ctx, kind, preview ?? null, async () => ({
        name: p.name as string, files: await writing(() => readOfflineSourcePath(p.path as string, kind)), selected,
      }));
    },
    render: (result) => {
      const { rows, preview, imported } = result as SourceUploadResult;
      return [...rows.map(({ row, title, path, status, reason }) => `${row}. [${status}] ${title ?? path}${reason ? ` — ${reason}` : ""}`),
        imported.length ? `${imported.length} private drafts saved.` : `Preview receipt ${preview}`].join("\n");
    },
  },
  {
    name: "personal_source_history",
    cliName: "source history",
    summary: "Show import runs for personal sources in this brain",
    scope: "read",
    localOnly: true,
    params: [],
    handler: (ctx) => writing(() => sourceHistory(ctx.bundle)),
    render: (result) => {
      const history = result as Awaited<ReturnType<typeof sourceHistory>>;
      return history.map(({ source, at, count }) => `${at ?? "Date unavailable"}  ${source}  ${count} drafts`).join("\n") || "(no imports yet)";
    },
  },
  {
    name: "graph_data",
    cliName: "graph-data",
    summary: "The whole graph (nodes + edges) as data — for the GUI and agents",
    scope: "read",
    params: [],
    handler: (ctx) => buildVizGraph(ctx.bundle),
    render: (r) => {
      const g = r as VizGraph;
      return `${g.nodes.length} concepts, ${g.edges.length} links (use --json for the data)`;
    },
  },
  {
    // The portable form of graph_data: the same nodes and edges, meant to be
    // saved as a file that leaves the app. Private notes stay out unless a
    // trusted caller of a writable brain explicitly includes them.
    name: "export_graph",
    cliName: "export-graph",
    summary: "The graph (nodes + edges) as portable JSON, without private notes unless included",
    scope: "read",
    params: [
      { name: "include-private", type: "boolean", description: "include private db_only notes in the JSON" },
    ],
    handler: (ctx, p) => {
      const includePrivate = p["include-private"] === true;
      if (includePrivate && !ctx.trusted) throw new OpError("Private graph exports require a trusted caller.", "untrusted");
      if (includePrivate && ctx.readonly) throw new OpError("Private graph exports require a writable brain.", "refused");
      return buildVizGraph(ctx.bundle, { includePrivate });
    },
    render: (r) => {
      const g = r as VizGraph;
      return `${g.nodes.length} concepts, ${g.edges.length} links (use --json for the data)`;
    },
  },
  {
    // Scope read despite writing a file: output is derived (never canonical
    // knowledge) and the path is fixed to <bundle>/viz.html — no caller-chosen
    // destination an untrusted caller could abuse.
    name: "export_viz",
    cliName: "export-viz",
    summary: "Write a self-contained HTML graph viewer to <bundle>/viz.html",
    scope: "read",
    params: [
      { name: "include-private", type: "boolean", description: "embed private db_only notes in the HTML" },
      { name: "fonts", type: "boolean", description: "embed the app's typefaces for offline use" },
    ],
    handler: (ctx, p) => {
      const includePrivate = p["include-private"] === true;
      if (includePrivate && !ctx.trusted) throw new OpError("Private HTML exports require a trusted caller.", "untrusted");
      if (includePrivate && ctx.readonly) throw new OpError("Private HTML exports require a writable brain.", "refused");
      return exportViz(ctx.bundle, { includePrivate, fonts: p.fonts === true });
    },
    render: (r) => {
      const v = r as VizExport;
      return `wrote ${v.path} (${v.nodes} concepts, ${v.edges} links)`;
    },
  },
  {
    name: "export_markdown",
    cliName: "export-markdown",
    summary: "Copy brain notes to a new portable Markdown or Obsidian folder",
    scope: "admin",
    params: [
      { name: "destination", type: "string", required: true, positional: true, description: "absolute path to a new folder outside the brain" },
      { name: "include-private", type: "boolean", description: "include notes from private db_only directories" },
    ],
    handler: (ctx, p) => writing(async () => {
      try { return await exportMarkdown(ctx.bundle, p.destination as string, p["include-private"] === true); }
      catch (error) {
        if (error instanceof MarkdownExportError) throw new OpError(error.message, "bad_params");
        throw error;
      }
    }),
    render: (r) => {
      const { path, notes } = r as MarkdownExport;
      return `exported ${notes} ${notes === 1 ? "note" : "notes"} to ${path}`;
    },
  },
  {
    name: "index",
    cliName: "index",
    summary: "(Re)index the bundle incrementally (unchanged files skipped)",
    scope: "admin",
    params: [],
    handler: (ctx) => withIndexWrite(ctx.bundle, async () => buildIndex(ctx.bundle, await ctx.engine(true))),
    render: renderStats,
  },
  {
    name: "cache_settings",
    cliName: "cache-settings",
    summary: "Choose SQLite or a local PostgreSQL and pgvector cache for this brain",
    scope: "admin",
    params: [
      { name: "backend", type: "string", positional: true, description: "sqlite or postgres (omit to show current setting)" },
      { name: "connection-env", type: "string", description: "environment variable containing the PostgreSQL connection URL" },
      { name: "connection", type: "string", description: "PostgreSQL connection URL (prefer --connection-env in the CLI)" },
    ],
    handler: async (ctx, p) => {
      const backend = p.backend;
      const name = p["connection-env"] as string | undefined;
      if (backend === undefined || backend === "sqlite") {
        if (name !== undefined || p.connection !== undefined)
          throw new OpError("Connection credentials require the postgres backend.", "bad_params");
        if (backend === "sqlite") await setCacheSettings(ctx.bundle, null);
      } else if (backend === "postgres") {
        if (name !== undefined && (p.connection !== undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
          throw new OpError("Use one connection URL or a valid environment variable name.", "bad_params");
        const connection = name === undefined ? p.connection as string | undefined : process.env[name];
        if (!connection) throw new OpError("Supply a PostgreSQL connection URL.", "bad_params");
        try { await setCacheSettings(ctx.bundle, connection); }
        catch (error) {
          if (error instanceof TypeError) throw new OpError(error.message, "bad_params");
          throw error;
        }
      } else throw new OpError("Choose sqlite or postgres.", "bad_params");
      return { backend: readCacheSettings(ctx.bundle)?.connection ? "postgres" : "sqlite" };
    },
    render: (result) => `Cache backend: ${(result as { backend: string }).backend}`,
  },
  {
    name: "create_directory_log",
    cliName: "log create",
    summary: "Enable a Markdown change log in an existing public folder",
    scope: "write",
    params: [{ name: "folder", type: "string", required: true, positional: true, description: "folder path relative to the brain" }],
    handler: (ctx, p) => writing(async () => {
      try { return await createDirectoryLog(ctx.bundle, p.folder as string); }
      catch (error) {
        if (error instanceof LogFolderError) throw new OpError(error.message, "bad_params");
        throw error;
      }
    }),
    render: (value) => {
      const { folder, created } = value as Awaited<ReturnType<typeof createDirectoryLog>>;
      return `${folder}/log.md ${created ? "created" : "is already enabled"}`;
    },
  },
  {
    name: "set_index_style",
    cliName: "manifests style",
    summary: "Regenerate Markdown indexes using grouped or OKF reference headings",
    scope: "admin",
    params: [{ name: "style", type: "string", required: true, positional: true, description: "index layout: grouped or reference" }],
    handler: async (ctx, p) => {
      const style = p.style;
      if (style !== "grouped" && style !== "reference") throw new OpError("Choose grouped or reference index headings.", "bad_params");
      await setIndexStyle(ctx.bundle, style);
      return { style };
    },
    render: (result) => `updated index.md files using ${(result as { style: string }).style} headings`,
  },
  {
    name: "watch_index",
    cliName: "watch",
    summary: "Watch a writable brain folder and refresh keyword search and graph links",
    scope: "admin",
    localOnly: true,
    params: [],
    handler: (ctx) => watchBundleInForeground(ctx.bundle, () => {
      if (!ctx.brain) return true;
      const mount = resolveBrain(ctx.brain);
      return mount.path === ctx.bundle && !mount.readonly;
    }, localBundleWatchBackend),
    render: (r) => {
      const status = r as BundleWatchStatus;
      return status.error ?? (status.stats ? `watch stopped; last refresh ${renderStats(status.stats)}` : "watch stopped");
    },
    exitCode: (r) => (r as BundleWatchStatus).error ? 1 : 0,
  },
  {
    name: "rebuild",
    cliName: "rebuild",
    summary: "Wipe the derived index and rebuild it from the bundle",
    scope: "admin",
    params: [
      { name: "confirm-destructive", type: "boolean", description: "required acknowledgement that the derived index is wiped first" },
    ],
    handler: (ctx, p) => {
      if (p["confirm-destructive"] !== true)
        throw new OpError(
          "rebuild wipes the derived index; pass --confirm-destructive to proceed",
          "refused",
        );
      return withIndexWrite(ctx.bundle, async () => {
        const eng = await ctx.engine(true);
        const rebuild = async (index: IndexEngine) => {
          await index.wipe();
          return buildIndex(ctx.bundle, index);
        };
        return eng.batch ? eng.batch(rebuild) : rebuild(eng);
      });
    },
    render: renderStats,
  },
  {
    name: "embed",
    cliName: "embed",
    summary: "Embed concepts into the vector index (incremental; unchanged skipped)",
    scope: "admin",
    params: [
      { name: "limit", type: "int", description: "max concepts to (re)embed this run (paces API spend)" },
      { name: "provider", type: "string", description: "embedding provider override (default: config/env)" },
      { name: "model", type: "string", description: "embedding model override" },
      { name: "include-private", type: "boolean", description: "send private notes to the selected embedding provider" },
    ],
    handler: async (ctx, p) => {
      const emb = gatewayEmbedder(ctx.config().ai ?? {}, {
        provider: p.provider as string | undefined,
        model: p.model as string | undefined,
      });
      return embedBundle(ctx.bundle, await ctx.vectors(true), emb, {
        includePrivate: p["include-private"] === true,
        limit: p.limit as number | undefined,
      });
    },
    render: (r) => {
      const s = r as EmbedStats;
      const parts = [
        `embedded ${s.embedded} (${s.chunks} chunks), skipped ${s.skipped}, removed ${s.removed} — ${s.provider}/${s.model}${s.dim === null ? "" : ` dim ${s.dim}`}`,
      ];
      if (s.reset) parts.push("vector cache rebuilt from scratch (new provider/model key)");
      if (s.pending > 0) parts.push(`${s.pending} still pending — rerun \`okb embed\` to continue`);
      return parts.join("\n");
    },
  },
  {
    name: "sync",
    cliName: "sync",
    summary: "Commit bundle changes to git; pull+push when a remote is configured",
    scope: "write",
    params: [
      { name: "message", type: "string", description: "commit message (default: okb sync <timestamp>)" },
      { name: "status", type: "boolean", description: "report repo state without changing anything" },
    ],
    handler: async (ctx, p) => {
      if (p.status === true) return syncStatus(ctx.bundle);
      const result = await syncBundle(ctx.bundle, p.message as string | undefined, ctx.allowSavedSyncCredential === true);
      return result.pulled || result.committed ? { ...result, ...await refreshSyncIndex(ctx) } : result;
    },
    render: (r) => {
      if ("repo" in (r as object)) {
        const s = r as SyncStatus;
        if (!s.repo) return "not a git repo (okb sync initializes one)";
        const up = s.ahead === null ? "no upstream" : `ahead ${s.ahead}, behind ${s.behind}`;
        return `on ${s.branch ?? "(detached)"} — ${s.dirty} dirty, remote ${s.remote ?? "none"}, ${up}`;
      }
      const s = r as SyncResult & { indexWarning?: string };
      const parts: string[] = [];
      if (s.initialized) parts.push("initialized git repo");
      if (s.seeded.length > 0) parts.push(`seeded ${s.seeded.join(", ")}`);
      parts.push(s.committed ? `committed ${s.committed}` : "nothing to commit");
      if (s.pulled) parts.push("pulled");
      if (s.pushed) parts.push("pushed");
      else if (s.remote === null) parts.push("no remote configured (local-only)");
      if (s.indexWarning) parts.push(s.indexWarning);
      return parts.join("; ");
    },
  },
  {
    name: "sync_settings",
    cliName: "sync settings",
    summary: "Inspect or configure the current brain’s Git repository",
    scope: "admin",
    params: [
      { name: "action", type: "string", required: true, positional: true,
        description: "status, identity, origin, origin-preview, or origin-apply" },
      { name: "name", type: "string", description: "repository commit name" },
      { name: "email", type: "string", description: "repository commit email" },
      { name: "url", type: "string", description: "credential-free HTTPS origin URL" },
      { name: "change", type: "string", description: "replace or disconnect the current origin" },
      { name: "approval", type: "string", description: "approval from the current origin preview" },
    ],
    handler: (ctx, p) => {
      const { action, change, approval } = p;
      const url = p.url as string | undefined;
      if (action === "origin-preview" || action === "origin-apply") {
        if (change !== "replace" && change !== "disconnect")
          throw new OpError("Choose whether to replace or disconnect the current origin.", "bad_params");
        if ((change === "replace" && !url) || (change === "disconnect" && url !== undefined) ||
          (action === "origin-apply" && !approval) || (action === "origin-preview" && approval !== undefined) ||
          p.name !== undefined || p.email !== undefined)
          throw new OpError("Send the replacement URL when replacing and the current preview approval when applying.", "bad_params");
        return action === "origin-preview"
          ? syncSettings(ctx.bundle, { action, change, url }, ctx.canWriteSyncSettings)
          : syncSettings(ctx.bundle, { action, change, url, approval: approval as string }, ctx.canWriteSyncSettings);
      }
      if (action !== "status" && action !== "identity" && action !== "origin")
        throw new OpError("Choose status, identity, origin, origin-preview, or origin-apply.", "bad_params");
      if (change !== undefined || approval !== undefined)
        throw new OpError("Origin change and approval are only accepted by origin-preview and origin-apply.", "bad_params");
      return syncSettings(ctx.bundle, { action, name: p.name as string | undefined, email: p.email as string | undefined,
        url }, ctx.canWriteSyncSettings);
    },
    render: (result) => JSON.stringify(result, null, 2),
  },
  {
    name: "sync_recovery",
    cliName: "sync recovery",
    summary: "Inspect, resolve, continue, or abort a Git sync rebase",
    scope: "admin",
    params: [
      { name: "action", type: "string", required: true, positional: true, description: "status, preview, resolve, continue, or abort" },
      { name: "path", type: "string", description: "bundle-relative conflicted path" },
      { name: "approval", type: "string", description: "approval from the current conflict preview" },
      { name: "choice", type: "string", description: "local, upstream, or manual" },
      { name: "text", type: "string", stdinFallback: true, description: "replacement text for a manual resolution" },
      { name: "confirm", type: "boolean", description: "approve the selected action" },
    ],
    handler: async (ctx, p) => {
      const { action, choice } = p;
      if (action !== "status" && action !== "preview" && action !== "resolve" && action !== "continue" && action !== "abort")
        throw new OpError("Choose status, preview, resolve, continue, or abort.", "bad_params");
      if (choice !== undefined && choice !== "local" && choice !== "upstream" && choice !== "manual")
        throw new OpError("Choose the local or upstream version, or enter merged text.", "bad_params");
      const result = await syncRecovery(ctx.bundle, { action, choice, path: p.path as string | undefined, approval: p.approval as string | undefined,
        text: p.text as string | undefined, confirm: p.confirm === true });
      return !result.inProgress && (action === "abort" || action === "continue")
        ? { ...result, ...await refreshSyncIndex(ctx) } : result;
    },
    render: (result) => JSON.stringify(result, null, 2),
  },
  {
    name: "computation_configure",
    cliName: "computation configure",
    summary: "Save a built-in CSV aggregate contract on a computation concept",
    scope: "admin",
    params: [computationId, { name: "contract", type: "string", required: true, stdinFallback: true, description: "parameters and executor as JSON" }],
    handler: (ctx, p) => computationWrite(ctx, () => configureComputation(ctx.bundle, p.id as string, p.contract as string)),
    render: renderComputation,
  },
  {
    name: "computation_preview",
    cliName: "computation preview",
    summary: "Review the exact local CSV source, typed parameters, and computation contract",
    scope: "admin",
    params: [computationId, computationParameters],
    handler: (ctx, p) => localComputation(() => previewComputation(ctx.bundle, p.id as string, (p.parameters as string | undefined) ?? "{}")),
    render: renderComputation,
  },
  {
    name: "computation_run",
    cliName: "computation run",
    summary: "Run an approved local CSV aggregate and return its receipt",
    scope: "admin",
    params: [computationId, computationParameters, computationApproval],
    handler: (ctx, p) => localComputation(() => compute(ctx.bundle, p.id as string, (p.parameters as string | undefined) ?? "{}", p.approval as string)),
    render: renderComputation,
  },
  {
    name: "computation_verify",
    cliName: "computation verify",
    summary: "Recompute an attested result from the original local source and contract",
    scope: "admin",
    params: [computationId, computationReceipt],
    handler: (ctx, p) => localComputation(() => verifyComputation(ctx.bundle, p.id as string, p.receipt as string)),
    render: renderComputation,
  },
  {
    name: "computation_attest",
    cliName: "computation attest",
    summary: `Record a verified ${computationRuntime} computation on its concept`,
    scope: "admin",
    params: [computationId, computationReceipt, computationApproval,
      { name: "confirm", type: "boolean", description: "explicitly publish the independently checked process verification" }],
    handler: (ctx, p) => {
      if (p.confirm !== true) throw new OpError("Confirm recording the process verification after reviewing the verified receipt.", "refused");
      return computationWrite(ctx, () => attestComputation(ctx.bundle, p.id as string, p.receipt as string, p.approval as string));
    },
    render: renderComputation,
  },
  {
    name: "review_queue",
    cliName: "review",
    summary: "Today's review queue: concepts worth another look, with reasons",
    scope: "read",
    params: [
      { name: "limit", type: "int", description: "queue size (default 5, config review.queueSize)" },
      { name: "garnish", type: "boolean", description: "add an AI one-liner tying public review items to recent public notes (off in lean)" },
      { name: "profile", type: "string", description: "retrieval profile gating the garnish: lean|balanced|max" },
    ],
    handler: async (ctx, p) => {
      const q = await queueFor(ctx, p.limit as number | undefined);
      if (p.garnish !== true || q.length === 0) return q;
      if (!profileOf(ctx, p).extras) {
        log.warn("garnish is an AI extra — off in the lean profile");
        return q;
      }
      try {
        const describe = (id: string) => describePublicReviewNote(ctx.bundle, id);
        const publicQueue = (await Promise.all(q.map(({ id }) => describe(id)))).filter((note) => note !== undefined);
        if (!publicQueue.length) return q;
        const eng = await ctx.engine();
        const recent = await pickRecent(await eng.listReviewRows(), new Set(q.map((it) => it.id)), new Date(), describe);
        if (!recent.length) return q;
        const lines = await garnishQueue(publicQueue, recent, (m) =>
          createGateway(ctx.config().ai ?? {}).chat(m),
        );
        return q.map((it) => {
          const garnish = lines.get(it.id);
          return garnish === undefined ? it : { ...it, garnish };
        });
      } catch (e) {
        log.warn("garnish skipped", { error: (e as Error).message });
        return q;
      }
    },
    render: (r) => {
      const q = r as ReviewItem[];
      if (q.length === 0) return "(queue is empty — nothing needs review)";
      return q
        .flatMap((it, i) => [
          `${i + 1}. ${it.id} — ${it.title} (${it.score.toFixed(2)}) — ${it.reasons.join("; ")}`,
          ...(it.garnish === undefined ? [] : [`   ↳ ${it.garnish}`]),
        ])
        .join("\n");
    },
  },
  {
    name: "review_done",
    cliName: "review done",
    summary: "Mark a concept reviewed: records a `verified` event by you (content untouched)",
    scope: "write",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id or queue position" },
    ],
    handler: async (ctx, p) => {
      const id = await resolveReviewTarget(ctx, p.id as string);
      const by = ctx.actor();
      const at = nowTimestamp();
      await writing(() => writeConcept(ctx.bundle, { id, verify: { by, at }, metadataOnly: true }));
      await reindex(ctx, [id], false);
      await afterMarkdownWrite(async () => (await ctx.engine()).clearSnooze(id));
      return { id, verifiedBy: by, verifiedAt: at };
    },
    render: (r) => {
      const x = r as { id: string; verifiedBy: string };
      return `reviewed ${x.id} (verified by ${x.verifiedBy})`;
    },
  },
  {
    name: "review_snooze",
    cliName: "review snooze",
    summary: "Hide a concept from the review queue for a few days (DB-only)",
    scope: "write",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id or queue position" },
      { name: "days", type: "int", description: "days to snooze (default 7)" },
    ],
    handler: async (ctx, p) => {
      const days = (p.days as number | undefined) ?? 7;
      if (days < 1) throw new OpError("days must be at least 1", "bad_params");
      const id = await resolveReviewTarget(ctx, p.id as string);
      const snoozeUntil = new Date(Date.now() + days * 86_400_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      await (await ctx.engine()).setSnooze(id, snoozeUntil);
      return { id, snoozeUntil };
    },
    render: (r) => {
      const s = r as { id: string; snoozeUntil: string };
      return `snoozed ${s.id} until ${s.snoozeUntil.slice(0, 10)} (cleared by okb rebuild)`;
    },
  },
  {
    name: "clip",
    cliName: "clip",
    summary: "Clip a web page into references/ as a readable, cited concept",
    scope: "write",
    params: [
      { name: "url", type: "string", required: true, positional: true, description: "page to clip (http/https)" },
      { name: "quote", type: "string", description: "passage to save under # Highlights" },
      { name: "note", type: "string", description: "your comment, saved with the quote" },
      { name: "tags", type: "string", description: "comma-separated extra tags" },
      { name: "read", type: "boolean", description: "skip the inbox tag (already read)" },
      { name: "auto-tag", type: "boolean", description: "suggest topic tags via the chat model using public vocabulary (also config clip.autoTag; off in lean)" },
    ],
    handler: async (ctx, p) => {
      const clip = ctx.config().clip;
      const r = await writing(async () =>
        clipUrl(
          ctx.bundle,
          {
            url: p.url as string,
            quote: p.quote as string | undefined,
            note: p.note as string | undefined,
            tags: parseTags(p.tags),
            read: p.read as boolean | undefined,
          },
          {
            resources: await ctx.hasIndex() ? await (await ctx.engine()).listResources() : undefined,
            suggestTags: autoTagger(ctx, p["auto-tag"] === true || clip?.autoTag === true),
            maxBodyBytes: clip?.maxBodyBytes,
            defaultTags: clip?.defaultTags,
            stripParams: clip?.stripParams,
            actor: ctx.actor(),
          },
        ),
      );
      await reindex(ctx, [r.id]);
      return r;
    },
    render: (r) => {
      const c = r as ClipResult;
      if (c.deduped)
        return `already clipped as ${c.id}${c.appended ? " — highlight appended" : ""}`;
      return [
        `clipped ${c.id}`,
        c.truncated ? " (body truncated at the 100 KB cap)" : "",
        c.autoTags.length > 0 ? ` — tagged ${c.autoTags.join(", ")}` : "",
      ].join("");
    },
  },
  {
    name: "rss",
    cliName: "rss",
    summary: "Pull RSS/Atom feeds into references/ (no URL: every config rss.feeds)",
    scope: "write",
    params: [
      { name: "url", type: "string", positional: true, description: "feed URL (default: every configured rss.feeds entry)" },
      { name: "limit", type: "int", description: "max new items per feed (default 10, config rss.maxItems)" },
    ],
    handler: async (ctx, p) => {
      const cfg = ctx.config().rss;
      const urls = p.url !== undefined ? [p.url as string] : (cfg?.feeds ?? []);
      if (urls.length === 0)
        throw new OpError(
          "Enter a feed URL or add feeds in Add → Manage saved feeds or with okb rss settings --feeds.",
          "bad_params",
        );
      return pullFeeds(ctx, urls, (p.limit as number | undefined) ?? cfg?.maxItems);
    },
    render: (r) =>
      (r as RssPullResult[])
        .flatMap((f) => {
          if (f.error !== undefined) return [`${f.url} — FAILED: ${f.error}`];
          const skipped = f.skipped > 0 ? `, ${f.skipped} skipped` : "";
          return [
            `${f.feed || f.url}: ${f.added.length} added, ${f.deduped} known${skipped}`,
            ...f.added.map((a) => `  + ${a.id} — ${a.title}`),
          ];
        })
        .join("\n"),
  },
  {
    name: "rss_settings",
    cliName: "rss settings",
    summary: "View or replace saved RSS feed URLs without pulling entries",
    scope: "admin",
    localOnly: true,
    params: [{ name: "feeds", type: "string", description: "one feed URL per line (empty clears the list)" }],
    handler: async (ctx, p) => runRssSettings(ctx, p.feeds),
    render: (r) => (r as { feeds: string[] }).feeds.join("\n") || "No saved RSS feeds.",
  },
  {
    name: "link_suggest",
    cliName: "links suggest",
    summary: "Propose cross-links for a concept (deterministic, with reasons)",
    scope: "read",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id to suggest links for" },
      { name: "limit", type: "int", description: "max suggestions (default 5)" },
    ],
    handler: (ctx, p) => suggestFor(ctx, p.id as string, p.limit as number | undefined),
    render: (r) => {
      const ss = r as LinkSuggestion[];
      if (ss.length === 0) return "(no suggestions)";
      return ss
        .map((s) => `${s.score.toFixed(2)}  ${s.id} — ${s.title}  (${s.reasons.join("; ")})`)
        .join("\n");
    },
  },
  {
    name: "link_accept",
    cliName: "links accept",
    summary: "Accept a suggestion: append a normalized link under # Related",
    scope: "write",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept that gains the link" },
      { name: "target", type: "string", required: true, positional: true, description: "concept id to link to" },
    ],
    handler: async (ctx, p) => {
      const [id, target] = [p.id as string, p.target as string];
      const view = await readConceptView(ctx.bundle, id);
      const targetView = await readConceptView(ctx.bundle, target); // not_found on missing
      if (extractTargets(id, view.body).includes(target)) return { id, target, added: false };
      const line = `- [${fmString(targetView.frontmatter.title) || target}](/${target}.md)`;
      const body = view.body.replace(/\s+$/, "");
      const withSection = /^# Related$/m.test(body)
        ? body.replace(/^# Related$/m, `# Related\n\n${line}`)
        : `${body}\n\n# Related\n\n${line}`;
      await writing(() => writeConcept(ctx.bundle, { id, body: withSection, actor: ctx.actor() }));
      await reindex(ctx, [id]);
      return { id, target, added: true };
    },
    render: (r) => {
      const x = r as { id: string; target: string; added: boolean };
      return x.added
        ? `linked ${x.id} → ${x.target}`
        : `${x.id} already links to ${x.target}`;
    },
  },
  {
    name: "enrich",
    cliName: "enrich",
    summary: "Run the enrichment agent (LLM as a guarded crawler; caps enforced in-tool)",
    scope: "write",
    params: [
      { name: "task", type: "string", positional: true, description: "what to improve (default derived from --concept/--web-seed)" },
      { name: "web-seed", type: "string", description: "comma-separated seed URLs the crawl may start from" },
      { name: "concept", type: "string", description: "existing concept id to focus the enrichment on" },
      { name: "web-max-pages", type: "int", description: "page fetch cap for the run (default 5)" },
      { name: "web-max-depth", type: "int", description: "link-following depth from the seeds (default 1)" },
      { name: "allow-host", type: "string", description: "comma-separated fetchable hosts (default: the seeds' hosts)" },
      { name: "allow-path", type: "string", description: "comma-separated URL path prefixes allowed (default: all)" },
      { name: "deny-path", type: "string", description: "comma-separated URL path prefixes refused" },
      { name: "no-web", type: "boolean", description: "run purely from the bundle (every fetch refused)" },
    ],
    handler: async (ctx, p) => {
      const list = (v: unknown): string[] =>
        v === undefined
          ? []
          : (v as string).split(",").map((s) => s.trim()).filter((s) => s !== "");
      const seeds = list(p["web-seed"]);
      for (const s of seeds) {
        let u: URL | undefined;
        try {
          u = new URL(s);
        } catch {
          /* refused below */
        }
        if (u === undefined || (u.protocol !== "http:" && u.protocol !== "https:"))
          throw new OpError(`seed is not an http(s) URL: ${s}`, "bad_params");
      }
      const concept = p.concept as string | undefined;
      if (concept !== undefined) {
        const note = await readConceptView(ctx.bundle, concept);
        if (isPrivateConcept(concept, note.frontmatter)) throw new OpError("Private notes are unavailable to enrichment.", "refused");
      }
      if (p.task === undefined && seeds.length === 0 && concept === undefined)
        throw new OpError(
          "give okb enrich a task, --concept, and/or --web-seed URLs",
          "bad_params",
        );
      const task =
        (p.task as string | undefined) ??
        (concept !== undefined
          ? `Enrich the concept ${concept} with well-cited material from the seed pages.`
          : "Review the seed pages and capture what is worth keeping as reference concepts.");

      const limits = defaultLimits(seeds);
      if (p["web-max-pages"] !== undefined) limits.maxPages = p["web-max-pages"] as number;
      if (p["web-max-depth"] !== undefined) limits.maxDepth = p["web-max-depth"] as number;
      if (p["allow-host"] !== undefined) limits.allowHosts = list(p["allow-host"]);
      limits.allowPaths = list(p["allow-path"]);
      limits.denyPaths = list(p["deny-path"]);
      limits.noWeb = p["no-web"] === true;

      const gw = createGateway(ctx.config().ai ?? {});
      const r = await runEnrich(ctx.bundle, task, seeds, limits, {
        chat: async (messages) => (await gw.chat(messages)).text,
        actor: enrichActor(ctx),
        suggestLinks: await ctx.hasIndex() ? async (id) => await isPrivateConceptAt(ctx.bundle, id)
          ? [] : publicHits(ctx.bundle, await suggestFor(ctx, id)) : undefined,
        listConcepts: async () => {
          const out: { id: string; title: string }[] = [];
          for (const id of await listConcepts(ctx.bundle)) {
            const { doc, parsed } = await readConceptPermissive(ctx.bundle, id);
            if (parsed && !isPrivateConcept(id, doc.frontmatter)) out.push({ id, title: fmString(doc.frontmatter.title) });
          }
          return out;
        },
      });
      await reindex(ctx, r.written.map((w) => w.id));
      return r;
    },
    render: (r) => {
      const e = r as EnrichResult;
      return [
        ...e.fetched.map((u) => `fetched ${u}`),
        ...e.written.map((w) => `${w.created ? "created" : "enriched"} ${w.id}`),
        `${e.summary || "(no summary)"} — ${e.steps} steps`,
      ].join("\n");
    },
  },
  {
    name: "inbox_list",
    cliName: "inbox",
    summary: "List unread clips and notes (concepts tagged inbox), newest first",
    scope: "read",
    params: [],
    handler: async (ctx) => {
      const rows = (await (await ctx.engine()).listReviewRows())
        .filter((r) => r.inbox)
        .map(({ id, title, timestamp }) => ({ id, title, timestamp }));
      rows.sort((a, b) => {
        const [x, y] = [a.timestamp ?? "", b.timestamp ?? ""];
        return x === y ? (a.id < b.id ? -1 : 1) : x > y ? -1 : 1;
      });
      return rows;
    },
    render: (r) => {
      const rows = r as { id: string; title: string }[];
      if (rows.length === 0) return "(inbox is empty)";
      return [...rows.map((x) => `${x.id} — ${x.title}`), `${rows.length} unread`].join("\n");
    },
  },
  {
    name: "inbox_read",
    cliName: "inbox read",
    summary: "Mark a concept read (removes its inbox tag; content untouched)",
    scope: "write",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id to mark read" },
    ],
    handler: async (ctx, p) => {
      const id = p.id as string;
      const view = await readConceptView(ctx.bundle, id); // not_found on missing
      const tags = fmTags(view.frontmatter.tags);
      if (!tags.includes("inbox")) return { id, removed: false };
      await writing(() =>
        writeConcept(ctx.bundle, {
          id,
          tags: tags.filter((t) => t !== "inbox"),
          metadataOnly: true,
        }),
      );
      await reindex(ctx, [id]);
      return { id, removed: true };
    },
    render: (r) => {
      const x = r as { id: string; removed: boolean };
      return x.removed ? `marked ${x.id} read` : `${x.id} was not in the inbox`;
    },
  },
  {
    name: "inbox_file",
    cliName: "inbox file",
    summary: "Preview or confirm filing an inbox capture to an unused concept ID",
    scope: "admin",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "captured inbox concept ID" },
      { name: "destination", type: "string", required: true, positional: true, description: "new concept ID outside the inbox" },
      { name: "confirm", type: "string", description: "matching preview ID to approve the filing" },
    ],
    handler: (ctx, p) => writing(async () => {
      try {
        const file = () => fileInboxNote(ctx.bundle, p.id as string, p.destination as string, ctx.actor(), p.confirm as string | undefined);
        if (p.confirm === undefined) return await file();
        return await withIndexWrite(ctx.bundle, async () => {
          const result = await file();
          if (await ctx.hasIndex()) {
            const engine = await ctx.engine();
            await updateIndexFor(ctx.bundle, result.destination, engine);
            await updateIndexFor(ctx.bundle, result.id, engine);
          }
          if (await ctx.hasVectors()) await (await ctx.vectors()).remove(result.id);
          return result;
        });
      } catch (error) {
        if (error instanceof InboxFilingError) throw new OpError(error.message, "bad_params");
        throw error;
      }
    }),
    render: (r) => {
      const filing = r as InboxFiling;
      return filing.status === "filed"
        ? `filed ${filing.title} at ${filing.destination}`
        : `${filing.id} → ${filing.destination}\nPreview ${filing.preview}\nRun the same command with --confirm ${filing.preview} to file it.`;
    },
  },
  {
    // The CLI and API still run one pass. Scheduled network jobs need separate approval.
    name: "jobs",
    cliName: "jobs",
    summary: "Run the maintenance jobs once, under a lock (schedule via OS cron)",
    scope: "admin",
    params: [
      { name: "only", type: "string", description: "comma-separated subset of: index,embed,rss,review,doctor" },
    ],
    handler: async (ctx, p) => {
      const jobs = maintenanceJobs(ctx);
      let picked = jobs;
      if (p.only !== undefined) {
        const names = (p.only as string).split(",").map((s) => s.trim()).filter((s) => s !== "");
        for (const n of names)
          if (!jobs.some((j) => j.name === n))
            throw new OpError(
              `unknown job: ${n} (known: ${jobs.map((j) => j.name).join(", ")})`,
              "bad_params",
            );
        picked = jobs.filter((j) => names.includes(j.name));
      }
      try {
        return await runJobs(ctx.bundle, picked);
      } catch (e) {
        if (e instanceof JobLockError) throw new OpError(e.message, "refused");
        throw e;
      }
    },
    render: (r) =>
      (r as JobResult[])
        .map((j) => {
          if (j.skipped) return `[skip] ${j.name} — ${j.detail}`;
          const tag = j.ok ? " ok " : "FAIL";
          const detail = j.detail.includes("\n")
            ? "\n" + j.detail.replace(/^/gm, "       ")
            : ` — ${j.detail}`;
          return `[${tag}] ${j.name} (${j.ms} ms)${detail}`;
        })
        .join("\n"),
    exitCode: (r) => ((r as JobResult[]).some((j) => !j.ok && !j.skipped) ? 1 : 0),
  },
  {
    name: "take",
    cliName: "take",
    summary: "Record an opinion/prediction as a claim with stated confidence",
    scope: "write",
    params: [
      { name: "statement", type: "string", required: true, positional: true, description: "the claim, stated so it can later be judged correct or not" },
      { name: "confidence", type: "int", required: true, description: "how sure you are it's correct, 0–100" },
      { name: "resolve-by", type: "string", description: "date (YYYY-MM-DD) by which the claim should be judged" },
      { name: "tags", type: "string", description: "comma-separated tags" },
      { name: "body", type: "string", description: "reasoning behind the take (markdown)" },
    ],
    handler: async (ctx, p) => {
      const confidence = p.confidence as number;
      if (confidence < 0 || confidence > 100)
        throw new OpError("confidence must be 0–100", "bad_params");
      const resolveBy = p["resolve-by"] as string | undefined;
      if (resolveBy !== undefined && !isClaimDeadline(resolveBy))
        throw new OpError("resolve-by must be a YYYY-MM-DD date", "bad_params");
      const statement = (p.statement as string).trim();
      const r = await writing(async () => {
        const base = `${CLAIM_TYPE}s/${slugify(statement.slice(0, 80))}`;
        let id = base;
        for (let n = 2; existsSync(idToAbsPath(ctx.bundle, id)); n++) id = `${base}-${n}`;
        return writeConcept(ctx.bundle, {
          id,
          type: CLAIM_TYPE,
          title: statement,
          description: `Claim held at ${confidence}% confidence.`,
          body: p.body as string | undefined,
          tags: parseTags(p.tags),
          extra: { confidence, ...(resolveBy === undefined ? {} : { resolve_by: resolveBy }) },
          actor: ctx.actor(),
        });
      });
      await reindex(ctx, [r.id]);
      return { ...r, confidence };
    },
    render: (r) => {
      const x = r as WriteResult & { confidence: number };
      return `staked ${x.id} at ${x.confidence}% — settle it later with \`okb resolve\``;
    },
  },
  {
    name: "resolve",
    cliName: "resolve",
    summary: "Settle a claim: correct, incorrect, or void (can't be judged)",
    scope: "write",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "claim concept id, e.g. claims/foo" },
      { name: "outcome", type: "string", required: true, positional: true, description: "correct | incorrect | void (aliases: true, false)" },
    ],
    handler: async (ctx, p) => {
      const alias: Record<string, Outcome> = {
        correct: "correct", true: "correct", incorrect: "incorrect", false: "incorrect", void: "void",
      };
      const outcome = alias[(p.outcome as string).toLowerCase()];
      if (outcome === undefined)
        throw new OpError("outcome must be correct, incorrect, or void", "bad_params");
      const id = p.id as string;
      const view = await readConceptView(ctx.bundle, id); // not_found on missing
      if (fmString(view.frontmatter.type) !== CLAIM_TYPE)
        throw new OpError(`${id} is not a claim (type ${fmString(view.frontmatter.type) || "?"})`, "bad_params");
      const prior = view.frontmatter.outcome;
      if (prior !== undefined)
        throw new OpError(
          `${id} is already resolved (${String(prior)}) — edit its frontmatter to re-judge`,
          "refused",
        );
      const resolved = nowTimestamp();
      await writing(() => writeConcept(ctx.bundle, { id, extra: { outcome, resolved }, actor: ctx.actor() }));
      await reindex(ctx, [id]);
      return { id, outcome, resolved };
    },
    render: (r) => {
      const x = r as { id: string; outcome: Outcome };
      return `resolved ${x.id}: ${x.outcome}`;
    },
  },
  {
    name: "calibrate",
    cliName: "calibrate",
    summary: "Score your resolved claims: Brier score + calibration by confidence",
    scope: "read",
    params: [],
    handler: async (ctx) => calibration(await scanClaims(ctx.bundle), new Date()),
    render: (r) => {
      const c = r as CalibrationReport;
      const total = c.open.length + c.correct + c.incorrect + c.void;
      if (total === 0) return "no claims yet — stake one with `okb take`";
      const lines: string[] = [];
      if (c.open.length > 0) {
        lines.push(`open claims (${c.open.length}):`);
        for (const o of c.open)
          lines.push(
            `  ${o.overdue ? "!" : " "} ${o.id} — ${o.confidence === null ? "?" : `${o.confidence}%`}${o.resolveBy ? ` — resolve by ${o.resolveBy}${o.overdue ? " (overdue)" : ""}` : ""}`,
          );
      }
      lines.push(`resolved: ${c.correct} correct, ${c.incorrect} incorrect, ${c.void} void`);
      if (c.brier !== null) {
        lines.push(
          `Brier score: ${c.brier.toFixed(3)} over ${c.correct + c.incorrect} scored claims (0 is perfect, 0.25 = coin flip)`,
        );
        for (const b of c.buckets)
          lines.push(`  ${b.range.padStart(7)}  n=${b.n}  said ${b.meanConfidence}%  got ${b.hitRate}%`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "upgrade",
    cliName: "upgrade",
    summary: "Migrate v0.1 conventions to OKF v0.2 (timestamp → generated, # Citations → sources, …)",
    scope: "write",
    params: [
      { name: "dry-run", type: "boolean", description: "report what would change without writing" },
      { name: "by", type: "string", description: "actor to credit for legacy timestamps/reviews (default: your actor)" },
    ],
    handler: async (ctx, p) => {
      const actor = p.by === undefined ? ctx.actor() : requireActor(p.by);
      const r = await writing(() => upgradeBundle(ctx.bundle, { actor, dryRun: p["dry-run"] === true }));
      if (!r.dryRun) await reindex(ctx, r.upgraded.map((u) => u.id));
      return r;
    },
    render: (r) => {
      const u = r as UpgradeResult;
      const verb = u.dryRun ? "would upgrade" : "upgraded";
      return [
        ...u.upgraded.map((x) => `${verb} ${x.id} — ${x.changes.join(", ")}`),
        ...u.skipped.map((id) => `skipped ${id} — unparseable frontmatter (see okb doctor)`),
        `${u.upgraded.length} ${verb}, ${u.unchanged} already v${u.okfVersion}${u.declared ? `; root index.md declares okf_version ${u.okfVersion}` : ""}`,
      ].join("\n");
    },
  },
  {
    name: "delete_concept",
    cliName: "rm",
    summary: "Delete a concept file (index.md/log.md and the derived caches follow)",
    scope: "write",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id to delete" },
    ],
    handler: async (ctx, p) => {
      const id = p.id as string;
      await writing(() => assertConceptPathSpelling(ctx.bundle, id));
      const view = await readConceptView(ctx.bundle, id); // not_found / bad id first
      if (isPrivateConcept(id, view.frontmatter)) await removePrivateLogEntries(ctx.bundle, new Set([id]));
      await unlink(idToAbsPath(ctx.bundle, id));
      // Directories left with nothing but their generated index.md are pruned
      // (so parent listings drop them), then the surviving chain regenerates.
      let dir = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
      while (dir !== "") {
        const abs = join(ctx.bundle, ...dir.split("/"));
        const left = (await readdir(abs)).filter((n) => n !== "index.md");
        if (left.length > 0) break;
        await rm(abs, { recursive: true, force: true });
        dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      }
      await regenerateIndexes(ctx.bundle, dir);
      if (!isPrivateConcept(id, view.frontmatter)) await appendLog(ctx.bundle, "Deletion", id, fmString(view.frontmatter.title) || id);
      await afterMarkdownWrite(async () => {
        await withIndexWrite(ctx.bundle, async () => {
          if (await ctx.hasIndex()) await (await ctx.engine()).removeNode(id);
        });
        if (await ctx.hasVectors()) await (await ctx.vectors()).remove(id);
      });
      return { id, deleted: true };
    },
    render: (r) => `deleted ${(r as { id: string }).id}`,
  },
  {
    name: "brains",
    cliName: "brains",
    summary: "List configured brain mounts (config.json `brains`; use --brain <name>)",
    scope: "read",
    // Mount paths are host filesystem topology — CLI only, never a network surface.
    localOnly: true,
    params: [],
    handler: async (ctx) =>
      listBrains().map((b) => ({
        ...b,
        exists: existsSync(b.path),
        active: b.path === ctx.bundle,
      })),
    render: (r) => {
      const bs = r as { name: string; path: string; readonly: boolean; exists: boolean; active: boolean }[];
      if (bs.length === 0)
        return 'no brains configured — add to config.json, e.g.\n  "brains": { "work": "/path/to/work-bundle", "ref": { "path": "/path/to/ref", "readonly": true } }';
      return bs
        .map(
          (b) =>
            `${b.active ? "*" : " "} ${b.name.padEnd(12)} ${b.path}${b.readonly ? "  [readonly]" : ""}${b.exists ? "" : "  [missing]"}`,
        )
        .join("\n");
    },
  },
  {
    name: "brain_templates",
    cliName: "brain-templates",
    summary: "List starter templates for an empty brain",
    scope: "read",
    params: [],
    handler: async () => brainStarterCatalog,
    render: () => brainStarterCatalog.map((starter) => `${starter.name} — ${starter.description}`).join("\n"),
  },
  {
    name: "brain_default",
    cliName: "brains default",
    summary: "Use the selected brain when okb starts without a folder argument",
    scope: "admin",
    params: [],
    handler: async (ctx) => {
      const cfg = loadConfig();
      if (cfg.defaultBundle !== ctx.bundle) saveConfig({ ...cfg, defaultBundle: ctx.bundle });
      return { defaultBundle: ctx.bundle };
    },
    render: (result) => `default brain: ${(result as { defaultBundle: string }).defaultBundle}`,
  },
  {
    name: "note_usage_settings",
    cliName: "usage settings",
    summary: "View or change local note usage counting for this brain",
    scope: "admin",
    params: [
      { name: "mode", type: "string", positional: true, description: "on or off (off also clears existing counts)" },
    ],
    handler: async (ctx, p) => {
      if (p.mode === undefined) return noteUsageSettings(ctx.bundle);
      if (p.mode !== "on" && p.mode !== "off") throw new OpError("Choose on or off for local note usage.", "bad_params");
      return noteUsageSettings(ctx.bundle, p.mode === "on");
    },
    render: (result) => {
      const settings = result as ReturnType<typeof noteUsageSettings>;
      return settings.enabled ? `Local note usage counts are enabled (${settings.windowDays} days).` : "Local note usage counts are off.";
    },
  },
  {
    name: "init",
    cliName: "init",
    summary: "Set up a brain, its AI providers, and an optional starter template",
    scope: "admin",
    params: [
      { name: "template", type: "string", description: `optional starter for an empty brain: ${brainStarterCatalog.map((s) => s.name).join("|")}` },
      { name: "provider", type: "string", description: "chat provider: anthropic|openai|gemini|openrouter|ollama|llamacpp|lmstudio|local" },
      { name: "model", type: "string", description: "chat model (default: the provider's default)" },
      { name: "base-url", type: "string", description: "override the chat endpoint (empty clears the override)" },
      { name: "embed-provider", type: "string", description: "embedding provider: openai|voyage|gemini|ollama|llamacpp|lmstudio|local" },
      { name: "embed-model", type: "string", description: "embedding model" },
      { name: "embed-base-url", type: "string", description: "override the embedding endpoint (empty clears the override)" },
      { name: "retrieval-profile", type: "string", description: "default retrieval profile: lean|balanced|max" },
      { name: "actor", type: "string", description: "who your writes are attributed to, e.g. human:alice (default human:<os user>)" },
      { name: "no-default-bundle", type: "boolean", description: "don't change which bundle okb uses by default" },
    ],
    handler: async (ctx, p) => {
      const local = (v: unknown): string | undefined =>
        v === "local" ? "ollama" : (v as string | undefined);
      const starter = typeof p.template === "string" ? findBrainStarter(p.template) : undefined;
      if (p.template !== undefined && !starter)
        throw new OpError("Choose a starter template listed by okb brain-templates.", "bad_params");
      const cfg = loadConfig();
      if (p.actor !== undefined) cfg.actor = requireActor(p.actor);
      const ai: AiSettings = { ...cfg.ai };
      if (p.provider !== undefined && local(p.provider) !== ai.provider) {
        ai.provider = local(p.provider);
        delete ai.model;
        delete ai.baseUrl;
      }
      if (p.model !== undefined) ai.model = p.model as string;
      if (p["embed-provider"] !== undefined && local(p["embed-provider"]) !== ai.embedProvider) {
        ai.embedProvider = local(p["embed-provider"]);
        delete ai.embedModel;
        delete ai.embedBaseUrl;
      }
      if (p["embed-model"] !== undefined) ai.embedModel = p["embed-model"] as string;
      for (const [param, field] of [["base-url", "baseUrl"], ["embed-base-url", "embedBaseUrl"]] as const) {
        if (p[param] === undefined) continue;
        const value = (p[param] as string).trim();
        if (!value) { delete ai[field]; continue; }
        let url: URL;
        try { url = new URL(value); }
        catch { throw new OpError("Enter an HTTP or HTTPS model endpoint URL.", "bad_params"); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search)
          throw new OpError("Use an HTTP or HTTPS endpoint without credentials, a query, or a fragment.", "bad_params");
        ai[field] = url.href.replace(/\/$/, "");
      }
      if (p["retrieval-profile"] !== undefined) {
        if (!Object.hasOwn(PROFILES, p["retrieval-profile"] as string))
          throw new OpError(
            `unknown retrieval profile: ${p["retrieval-profile"]} (known: ${Object.keys(PROFILES).join(", ")})`,
            "bad_params",
          );
        cfg.retrieval = { ...cfg.retrieval, profile: p["retrieval-profile"] as string };
      }
      for (const [name, cap] of [
        [ai.provider, "chat"],
        [ai.embedProvider, "embed"],
      ] as const)
        if (name !== undefined && RECIPES[name]?.[cap] === undefined)
          throw new OpError(
            `${name} is not a known ${cap} provider (see okb help init)`,
            "bad_params",
          );

      // Persist what detection picked, so the choice is explicit from now on.
      const env = gatewayEnvironment();
      const chat = resolveCall("chat", ai, env);
      const embed = resolveCall("embed", ai, env);
      ai.provider ??= chat.provider;
      ai.embedProvider ??= embed.provider;
      cfg.ai = ai;
      if (p["no-default-bundle"] !== true) cfg.defaultBundle = ctx.bundle;
      const guide = starter ? await createBrainStarter(ctx.bundle, starter) : undefined;
      if (guide && !guide.created)
        throw new OpError("Start with an empty brain folder that has no notes or conflicting files.", "bad_params");
      if (guide) await afterMarkdownWrite(() => withIndexWrite(ctx.bundle, async () => {
        if (await ctx.hasIndex()) await updateIndexFor(ctx.bundle, guide.id, await ctx.engine());
      }));
      const starterOnly = guide && p["no-default-bundle"] === true && Object.keys(p).length === 2;
      const path = starterOnly ? null : saveConfig(cfg);
      // A brain starts life conformant: seed the root index.md (okf_version)
      // when the directory has none yet.
      if (!existsSync(idToAbsPath(ctx.bundle, "index"))) await regenerateIndexes(ctx.bundle, "");
      const describe = (r: typeof chat) => ({
        provider: r.provider,
        model: r.model,
        offline: r.recipe.kind === "local",
        keyStatus: r.apiKeyEnv ? `${r.apiKeyEnv} ${r.apiKey ? "present" : "MISSING"}` : "no key needed",
      });
      return {
        path,
        defaultBundle: cfg.defaultBundle ?? null,
        actor: ctx.actor(),
        ...(guide && starter ? { starter: { name: starter.name, id: guide.id } } : {}),
        chat: describe(chat),
        embed: describe(embed),
      };
    },
    render: (r) => {
      const x = r as {
        path: string | null;
        defaultBundle: string | null;
        actor: string;
        starter?: { name: string; id: string };
        chat: { provider: string; model: string; keyStatus: string };
        embed: { provider: string; model: string; keyStatus: string };
      };
      return [
        ...(x.path ? [`wrote ${x.path}`] : []),
        ...(x.starter ? [`added ${x.starter.name} starter guide (${x.starter.id}.md)`] : []),
        ...(x.defaultBundle ? [`default bundle: ${x.defaultBundle}`] : []),
        `actor: ${x.actor}`,
        `chat:  ${x.chat.provider} / ${x.chat.model} (${x.chat.keyStatus})`,
        `embed: ${x.embed.provider} / ${x.embed.model} (${x.embed.keyStatus})`,
        "switch anytime: okb init --provider local | --provider anthropic …",
      ].join("\n");
    },
  },
  {
    name: "serve",
    cliName: "serve",
    summary: "Start the local API + GUI server (binds 127.0.0.1 only)",
    scope: "admin",
    localOnly: true,
    params: [
      { name: "port", type: "int", description: `port on 127.0.0.1 (default ${DEFAULT_PORT})` },
      { name: "open", type: "boolean", description: "open the GUI in your browser (also config serve.open)" },
      { name: "desktop", type: "boolean", description: "use a private ephemeral port and report readiness to the desktop app" },
    ],
    handler: async (ctx, p) => {
      const { url } = createApiServer({
        bundle: ctx.bundle,
        servedBrain: ctx.brain,
        port: p.desktop ? 0 : p.port as number | undefined,
        readonly: ctx.readonly === true,
      });
      log.info(`serving ${ctx.bundle} at ${url} — Ctrl-C to stop`);
      log.info("clip from the browser: `okb bookmarklet`");
      if (p.desktop) {
        try { publishDesktopAddress(url); }
        catch { log.warn("Could not publish the local desktop address for editor integrations"); }
        process.stdout.write(`${url}\n`);
      }
      else if (p.open === true || ctx.config().serve?.open === true) openInBrowser(url);
      return new Promise(() => {}); // lives until interrupted
    },
    render: () => "",
  },
  {
    name: "mcp",
    cliName: "mcp",
    summary: "Serve the brain over MCP (stdio; --http for Streamable HTTP)",
    scope: "admin",
    localOnly: true,
    params: [
      { name: "http", type: "boolean", description: "serve Streamable HTTP on 127.0.0.1 instead of stdio" },
      { name: "port", type: "int", description: `HTTP port (default ${DEFAULT_MCP_PORT}; implies --http)` },
      { name: "trusted", type: "boolean", description: "expose write ops (only for MCP clients you fully trust)" },
    ],
    handler: async (ctx, p) => {
      const trusted = p.trusted === true;
      const readonly = ctx.readonly === true;
      const brain = ctx.brain;
      const bundle = brain ? realpathSync(ctx.bundle) : ctx.bundle;
      const mountAllowed = brain ? () => {
        try {
          const mount = resolveBrain(brain);
          return mount.path === ctx.bundle && realpathSync(mount.path) === bundle && (!trusted || !mount.readonly || readonly);
        } catch { return false; }
      } : undefined;
      const options = { bundle, brain, trusted, readonly, mountAllowed };
      const mode = trusted && !readonly ? "TRUSTED — write ops exposed" : "read-only";
      if (p.http === true || p.port !== undefined) {
        const port = (p.port as number | undefined) ?? DEFAULT_MCP_PORT;
        runMcpHttp({ ...options, port });
        log.info(`mcp: http://127.0.0.1:${port}/ (${mode})`);
      } else {
        await runMcpStdio(options);
        log.info(`mcp: stdio (${mode})`);
      }
      return new Promise(() => {}); // lives until the client disconnects us
    },
    render: () => "",
  },
  {
    name: "bookmarklet",
    cliName: "bookmarklet",
    summary: "Print the clip-to-brain bookmarklet (embeds the serve token)",
    scope: "admin",
    localOnly: true,
    params: [
      { name: "port", type: "int", description: `port okb serve listens on (default ${DEFAULT_PORT})` },
    ],
    handler: async (_ctx, p) => {
      const port = (p.port as number | undefined) ?? DEFAULT_PORT;
      return { port, bookmarklet: bookmarkletJs(port, ensureServeToken()) };
    },
    render: (r) => {
      const b = r as { bookmarklet: string };
      return [
        b.bookmarklet,
        "",
        "Save this as a bookmark's URL; clicking it on any page clips that page",
        "into your brain (requires a running `okb serve`).",
      ].join("\n");
    },
  },
];

export function getOp(name: string): Operation | undefined {
  return operations.find((o) => o.name === name);
}

function coerce(spec: ParamSpec, v: unknown): unknown {
  switch (spec.type) {
    case "string":
      if (typeof v === "string") return v;
      break;
    case "int":
      if (typeof v === "number" && Number.isInteger(v)) return v;
      if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
      break;
    case "boolean":
      if (typeof v === "boolean") return v;
      break;
  }
  throw new OpError(
    `parameter ${spec.name} must be ${spec.type === "int" ? "an integer" : `a ${spec.type}`}`,
    "bad_params",
  );
}

function checkOpScope(op: Pick<Operation, "name" | "scope">, ctx: OpContext): void {
  if (!ctx.trusted && op.scope !== "read")
    throw new OpError(
      `op ${op.name} (scope ${op.scope}) is not available to untrusted callers`,
      "untrusted",
    );
  if (ctx.readonly === true && op.scope !== "read")
    throw new OpError(
      `this brain is mounted read-only — op ${op.name} (scope ${op.scope}) is refused`,
      "refused",
    );
}

/** Validate trust and params per the op's declaration (every adapter's gate). */
export function checkOpCall(
  op: Operation,
  ctx: OpContext,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  checkOpScope(op, ctx);
  for (const key of Object.keys(raw))
    if (!op.params.some((s) => s.name === key))
      throw new OpError(`unknown parameter: ${key}`, "bad_params");
  const params: Record<string, unknown> = {};
  for (const spec of op.params) {
    const v = raw[spec.name];
    if (v === undefined) {
      if (spec.required)
        throw new OpError(`missing required parameter: ${spec.name}`, "bad_params");
      continue;
    }
    params[spec.name] = coerce(spec, v);
  }
  return params;
}

/** Validate trust and params per the op's declaration, then run its handler. */
export async function runOp(
  op: Operation,
  ctx: OpContext,
  raw: Record<string, unknown>,
): Promise<unknown> {
  return op.handler(ctx, checkOpCall(op, ctx, raw));
}
