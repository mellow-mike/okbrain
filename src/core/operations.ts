// The single operations registry behind every surface (CLAUDE.md invariant 2).
// Each op declares name, params, scope, and handler once; the CLI (and later
// the GUI API and MCP server) are thin adapters generated over this table.
// Trust is fail-closed (invariant 3): `runOp` refuses write/admin scope for any
// caller not explicitly trusted, before the handler is ever reached.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createApiServer } from "../api.ts";
import { runMcpHttp, runMcpStdio } from "../mcp/server.ts";
import { createGateway, RECIPES, resolveCall } from "./ai/gateway.ts";
import { listBrains, loadConfig, saveConfig, type AiSettings, type OkbConfig } from "./config.ts";
import { calibration, CLAIM_TYPE, scanClaims, type CalibrationReport, type Outcome } from "./claims.ts";
import { buildIndex, updateIndexFor, type IndexStats } from "./engine/index-build.ts";
import type { Engine, Neighbor, VectorStore } from "./engine/interface.ts";
import { suggestLinks, type LinkSuggestion } from "./graph/link-suggest.ts";
import { extractTargets } from "./graph/links.ts";
import { orphans, shortestPath } from "./graph/queries.ts";
import { log } from "./log.ts";
import { suggestTags } from "./ingest/autotag.ts";
import { captureNote } from "./ingest/capture.ts";
import { clipUrl, type ClipOptions, type ClipResult } from "./ingest/clip.ts";
import { FetchGuardError } from "./ingest/fetch-guard.ts";
import { importPath, type ImportResult } from "./ingest/import.ts";
import { FeedError, pullFeed, type RssPullResult } from "./ingest/rss.ts";
import { defaultLimits, runEnrich, type EnrichResult } from "./ingest/web.ts";
import { listConcepts, readConceptPermissive } from "./okf/bundle.ts";
import { runDoctor, type DoctorReport } from "./okf/doctor.ts";
import { fmString, fmTags, OkfParseError, parse, type OkfDocument } from "./okf/document.ts";
import { idToAbsPath, InvalidIdError, slugify, validateId } from "./okf/paths.ts";
import { nowTimestamp, OkfWriteError, writeConcept, type WriteResult } from "./okf/write.ts";
import { askBrain, type AskResult } from "./retrieval/ask.ts";
import { embedBundle, embedConcept, gatewayEmbedder, type EmbedStats } from "./retrieval/embed.ts";
import { hybridRetrieve, type HybridArms, type HybridHit } from "./retrieval/hybrid.ts";
import { PROFILES, ProfileError, resolveProfile, type RetrievalProfile } from "./retrieval/profiles.ts";
import { rerankConfigured, rerankHits } from "./retrieval/rerank.ts";
import { garnishQueue, pickRecent, type GarnishNote } from "./review/garnish.ts";
import { defaultReviewConfig, reviewQueue, type ReviewItem } from "./review/score.ts";
import { bookmarkletJs, DEFAULT_MCP_PORT, DEFAULT_PORT, ensureServeToken } from "./serve-token.ts";
import { computeStats, type BrainStats } from "./stats.ts";
import { JobLockError, runJobs, type Job, type JobResult } from "./jobs/worker.ts";
import { syncBundle, syncStatus, type SyncResult, type SyncStatus } from "./sync.ts";
import { buildVizGraph, exportViz, type VizExport, type VizGraph } from "./viz/export.ts";

export type Scope = "read" | "write" | "admin";

/** What an adapter supplies to run ops: bundle root, trust, and a lazy engine. */
export interface OpContext {
  bundle: string;
  trusted: boolean;
  /** Read-only brain mount (Stage 5): write/admin ops are refused. */
  readonly?: boolean;
  /**
   * Open (or return the already-open) engine; the adapter owns its lifecycle.
   * Without `createIfMissing`, a bundle with no index yet must fail loudly —
   * silently opening an empty index would truncate search (see 1.4 decision).
   */
  engine(createIfMissing?: boolean): Engine;
  /** True when a derived index already exists (write ops refresh it, never create it). */
  hasIndex(): boolean;
  /** Open (or return) the vector store; same create semantics as `engine`. */
  vectors(createIfMissing?: boolean): VectorStore;
  /** True when a vector store exists (write ops refresh it, never create it). */
  hasVectors(): boolean;
  /** User config (config.json via okb init); adapter-loaded, {} when absent. */
  config(): OkbConfig;
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
  ): Promise<unknown>;
  /** CLI-only: never exposed over network adapters (local API, MCP). */
  localOnly?: boolean;
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

interface ConceptView {
  id: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
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
async function reindex(ctx: OpContext, ids: string[]): Promise<void> {
  if (ctx.hasIndex()) for (const id of ids) await updateIndexFor(ctx.bundle, id, ctx.engine());
  if (!ctx.hasVectors()) return;
  try {
    const emb = gatewayEmbedder(ctx.config().ai ?? {});
    for (const id of ids) await embedConcept(ctx.bundle, id, ctx.vectors(), emb);
  } catch (e) {
    // Never fail a write over a derived cache; `okb embed` reconciles later.
    log.warn("vector refresh failed — run `okb embed` to catch up", {
      error: (e as Error).message,
    });
  }
}

function requireNode(eng: Engine, id: string): void {
  if (!eng.getNode(id))
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
  return { id, frontmatter: doc.frontmatter, body: doc.body, raw };
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

const queueFor = (ctx: OpContext, limit?: number): ReviewItem[] => {
  const cfg = reviewCfg(ctx.config());
  const eng = ctx.engine();
  return reviewQueue(eng.listReviewRows(), eng.listEdges(), new Date(), {
    ...cfg,
    queueSize: limit ?? cfg.queueSize,
  });
};

/** Review target: a 1-based queue position (pure integer in range) or a concept id. */
function resolveReviewTarget(ctx: OpContext, raw: string): string {
  if (/^\d+$/.test(raw)) {
    // Rank without the display limit so positions match any `--limit` listing.
    const q = queueFor(ctx, Number.MAX_SAFE_INTEGER);
    const n = Number(raw);
    if (n >= 1 && n <= q.length) return q[n - 1]!.id;
  }
  requireNode(ctx.engine(), raw);
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
function hybridArms(ctx: OpContext): HybridArms {
  const arms: HybridArms = { engine: ctx.engine() };
  if (!ctx.hasVectors()) return arms;
  const store = ctx.vectors();
  const meta = store.meta();
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
    return await rerankHits(query, hits, createGateway(ai));
  } catch (e) {
    log.warn("rerank skipped", { error: (e as Error).message });
    return hits;
  }
}

/** A vector store that exists but couldn't serve recall deserves a warning. */
const warnVectorSkip = (ctx: OpContext, reason: string | null): void => {
  if (reason !== null && ctx.hasVectors()) log.warn("vector arm skipped", { reason });
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
      const vocabulary = ctx.hasIndex() ? ctx.engine().listTags() : [];
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
): Promise<AskResult> {
  const profile = profileOf(ctx, p);
  const gw = createGateway(ctx.config().ai ?? {});
  const r = await askBrain(
    p.question as string,
    {
      bundle: ctx.bundle,
      arms: hybridArms(ctx),
      chat: (messages) => gw.chat(messages),
      rerank: (q, hits) => maybeRerank(ctx, q, hits, profile),
      onContext: emit && ((context) => emit("context", context)),
    },
    profile,
  );
  warnVectorSkip(ctx, r.vectorSkipped);
  emit?.("answer", { answer: r.answer, citations: r.citations });
  return r;
}

/**
 * Pull feeds and reindex what landed (`okb rss` + the jobs worker). A single
 * explicit URL fails loudly; a configured multi-pull records per-feed errors
 * so one dead feed can't block the rest.
 */
async function pullFeeds(ctx: OpContext, urls: string[], limit?: number): Promise<RssPullResult[]> {
  const results: RssPullResult[] = [];
  for (const url of urls) {
    try {
      const r = await writing(() =>
        pullFeed(ctx.bundle, url, {
          resources: ctx.hasIndex() ? ctx.engine().listResources() : undefined,
          limit,
          stripParams: ctx.config().clip?.stripParams,
        }),
      );
      await reindex(ctx, r.added.map((a) => a.id));
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
    ctx.engine(),
    limit,
  );
}

/** Writer/id errors are caller mistakes → bad_params; guard blocks → refused. */
async function writing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OkfWriteError || e instanceof InvalidIdError)
      throw new OpError(e.message, "bad_params");
    if (e instanceof FetchGuardError || e instanceof FeedError)
      throw new OpError(e.message, "refused");
    throw e;
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
    ],
    handler: async (ctx, p) => {
      const profile = profileOf(ctx, p);
      const query = p.query as string;
      const { hits, vectorSkipped } = await hybridRetrieve(
        [query],
        hybridArms(ctx),
        profile,
        (p.limit as number | undefined) ?? 20,
      );
      warnVectorSkip(ctx, vectorSkipped);
      return maybeRerank(ctx, query, hits, profile);
    },
    render: (r) => {
      const hits = r as HybridHit[];
      if (hits.length === 0) return "(no hits)";
      return hits
        .map((h) => `${h.score.toFixed(3)}  ${h.id} — ${h.title}  [${h.sources.join("+")}]`)
        .join("\n");
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
    ],
    handler: (ctx, p) => runAsk(ctx, p),
    stream: (ctx, p, emit) => runAsk(ctx, p, emit),
    render: (r) => {
      const a = r as AskResult;
      const lines = [a.answer.trim()];
      if (a.citations.length > 0)
        lines.push("", "sources:", ...a.citations.map((c) => `  ${c.id} — ${c.title}`));
      return lines.join("\n");
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
    handler: (ctx, p) => readConceptView(ctx.bundle, p.id as string),
    render: (r) => (r as ConceptView).raw,
  },
  {
    name: "list_concepts",
    cliName: "list",
    summary: "List all concept ids in the bundle",
    scope: "read",
    params: [],
    handler: (ctx) => listConcepts(ctx.bundle),
    render: (r) => {
      const ids = r as string[];
      return ids.length === 0 ? "(empty bundle)" : ids.join("\n");
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
      const eng = ctx.engine();
      requireNode(eng, id);
      const { out, in: cited } = eng.edgesOf(id);
      const dirOf = (n: Neighbor): Dir | undefined =>
        n.depth !== 1
          ? undefined
          : out.includes(n.id)
            ? cited.includes(n.id)
              ? "both"
              : "out"
            : "in";
      return eng
        .neighbors(id, (p.depth as number | undefined) ?? 1)
        .map((n): TitledNeighbor => ({ ...n, title: eng.getNode(n.id)?.title ?? "", dir: dirOf(n) }));
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
      const eng = ctx.engine();
      const [from, to] = [p.from as string, p.to as string];
      requireNode(eng, from);
      requireNode(eng, to);
      const edges = eng.listEdges();
      const ids = shortestPath(edges, from, to, (p["max-depth"] as number | undefined) ?? 10);
      if (!ids) return null;
      const fwd = new Set(edges.map((e) => JSON.stringify([e.src, e.dst])));
      const has = (a: string, b: string) => fwd.has(JSON.stringify([a, b]));
      return ids.map((id, i): PathHop => {
        const hop: PathHop = { id, title: eng.getNode(id)?.title ?? "" };
        if (i > 0) {
          const prev = ids[i - 1]!;
          hop.dir = has(prev, id) ? (has(id, prev) ? "both" : "out") : "in";
        }
        return hop;
      });
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
      const eng = ctx.engine();
      return orphans(eng.listNodeIds(), eng.listEdges()).map((id) => ({
        id,
        title: eng.getNode(id)!.title,
      }));
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
      const eng = ctx.engine();
      return computeStats(eng.listReviewRows(), eng.listEdges(), eng.tagCounts(), new Date());
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
        `orphans ${s.orphans}, inbox ${s.inbox}, never reviewed ${s.neverReviewed}, stale ${s.stale} (>${s.staleDays}d)`,
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
        `${rep.ok ? "ok" : "not conformant"} — ${rep.files} files, ${rep.concepts} concepts, ${rep.errors} errors, ${rep.warnings} warnings`,
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
    ],
    handler: async (ctx, p) => {
      const r = await writing(() =>
        writeConcept(ctx.bundle, {
          id: p.id as string,
          type: p.type as string | undefined,
          title: p.title as string | undefined,
          description: p.description as string | undefined,
          body: p.body as string | undefined,
          resource: p.resource as string | undefined,
          tags: parseTags(p.tags),
        }),
      );
      await reindex(ctx, [r.id]);
      return r;
    },
    render: renderWrite,
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
      { name: "id", type: "string", description: "override the derived id (default <type>s/<title-slug>)" },
    ],
    handler: async (ctx, p) => {
      const r = await writing(async () => {
        const id = (p.id as string | undefined) ?? `${p.type}s/${slugify(p.title as string)}`;
        if (existsSync(idToAbsPath(ctx.bundle, id)))
          throw new OpError(`concept exists: ${id} (update it with \`okb write\`)`, "refused");
        return writeConcept(ctx.bundle, {
          id,
          type: p.type as string,
          title: p.title as string,
          description: p.description as string,
          body: p.body as string | undefined,
          resource: p.resource as string | undefined,
          tags: parseTags(p.tags),
        });
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
      const r = await writing(() =>
        importPath(ctx.bundle, {
          path: p.path as string,
          type: p.type as string | undefined,
          dest: p.dest as string | undefined,
          overwrite: p.overwrite as boolean | undefined,
        }),
      );
      await reindex(ctx, r.imported);
      return r;
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
    // Scope read despite writing a file: output is derived (never canonical
    // knowledge) and the path is fixed to <bundle>/viz.html — no caller-chosen
    // destination an untrusted caller could abuse.
    name: "export_viz",
    cliName: "export-viz",
    summary: "Write a self-contained HTML graph viewer to <bundle>/viz.html",
    scope: "read",
    params: [],
    handler: (ctx) => exportViz(ctx.bundle),
    render: (r) => {
      const v = r as VizExport;
      return `wrote ${v.path} (${v.nodes} concepts, ${v.edges} links)`;
    },
  },
  {
    name: "index",
    cliName: "index",
    summary: "(Re)index the bundle incrementally (unchanged files skipped)",
    scope: "admin",
    params: [],
    handler: (ctx) => buildIndex(ctx.bundle, ctx.engine(true)),
    render: renderStats,
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
      const eng = ctx.engine(true);
      eng.wipe();
      return buildIndex(ctx.bundle, eng);
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
    ],
    handler: async (ctx, p) => {
      const emb = gatewayEmbedder(ctx.config().ai ?? {}, {
        provider: p.provider as string | undefined,
        model: p.model as string | undefined,
      });
      return embedBundle(ctx.bundle, ctx.vectors(true), emb, {
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
    handler: (ctx, p) =>
      p.status === true
        ? syncStatus(ctx.bundle)
        : syncBundle(ctx.bundle, p.message as string | undefined),
    render: (r) => {
      if ("repo" in (r as object)) {
        const s = r as SyncStatus;
        if (!s.repo) return "not a git repo (okb sync initializes one)";
        const up = s.ahead === null ? "no upstream" : `ahead ${s.ahead}, behind ${s.behind}`;
        return `on ${s.branch ?? "(detached)"} — ${s.dirty} dirty, remote ${s.remote ?? "none"}, ${up}`;
      }
      const s = r as SyncResult;
      const parts: string[] = [];
      if (s.initialized) parts.push("initialized git repo");
      if (s.seeded.length > 0) parts.push(`seeded ${s.seeded.join(", ")}`);
      parts.push(s.committed ? `committed ${s.committed}` : "nothing to commit");
      if (s.pulled) parts.push("pulled");
      if (s.pushed) parts.push("pushed");
      else if (s.remote === null) parts.push("no remote configured (local-only)");
      return parts.join("; ");
    },
  },
  {
    name: "review_queue",
    cliName: "review",
    summary: "Today's review queue: concepts worth another look, with reasons",
    scope: "read",
    params: [
      { name: "limit", type: "int", description: "queue size (default 5, config review.queueSize)" },
      { name: "garnish", type: "boolean", description: "add an AI one-liner tying each item to recent notes (off in lean)" },
      { name: "profile", type: "string", description: "retrieval profile gating the garnish: lean|balanced|max" },
    ],
    handler: async (ctx, p) => {
      const q = queueFor(ctx, p.limit as number | undefined);
      if (p.garnish !== true || q.length === 0) return q;
      if (!profileOf(ctx, p).extras) {
        log.warn("garnish is an AI extra — off in the lean profile");
        return q;
      }
      try {
        const eng = ctx.engine();
        const describe = (n: { id: string; title: string }): GarnishNote => ({
          ...n,
          description: eng.getNode(n.id)?.description ?? "",
        });
        const recent = pickRecent(eng.listReviewRows(), new Set(q.map((it) => it.id)), new Date());
        const lines = await garnishQueue(q.map(describe), recent.map(describe), (m) =>
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
    summary: "Mark a concept reviewed (stamps last_reviewed; content untouched)",
    scope: "write",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id or queue position" },
    ],
    handler: async (ctx, p) => {
      const id = resolveReviewTarget(ctx, p.id as string);
      const lastReviewed = nowTimestamp();
      await writing(() =>
        writeConcept(ctx.bundle, { id, extra: { last_reviewed: lastReviewed }, metadataOnly: true }),
      );
      await reindex(ctx, [id]);
      ctx.engine().clearSnooze(id);
      return { id, lastReviewed };
    },
    render: (r) => `reviewed ${(r as { id: string }).id}`,
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
      const id = resolveReviewTarget(ctx, p.id as string);
      const snoozeUntil = new Date(Date.now() + days * 86_400_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      ctx.engine().setSnooze(id, snoozeUntil);
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
      { name: "auto-tag", type: "boolean", description: "suggest topic tags via the chat model (also config clip.autoTag; off in lean)" },
    ],
    handler: async (ctx, p) => {
      const clip = ctx.config().clip;
      const r = await writing(() =>
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
            resources: ctx.hasIndex() ? ctx.engine().listResources() : undefined,
            suggestTags: autoTagger(ctx, p["auto-tag"] === true || clip?.autoTag === true),
            maxBodyBytes: clip?.maxBodyBytes,
            defaultTags: clip?.defaultTags,
            stripParams: clip?.stripParams,
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
          "no feed URL given and no rss.feeds configured (add feeds to config.json)",
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
      await writing(() => writeConcept(ctx.bundle, { id, body: withSection }));
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
      if (concept !== undefined) await readConceptView(ctx.bundle, concept); // not_found early
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
        suggestLinks: ctx.hasIndex() ? (id) => suggestFor(ctx, id) : undefined,
        listConcepts: async () => {
          if (ctx.hasIndex()) {
            const eng = ctx.engine();
            return eng.listNodeIds().map((id) => ({ id, title: eng.getNode(id)!.title }));
          }
          const out: { id: string; title: string }[] = [];
          for (const id of await listConcepts(ctx.bundle))
            out.push({
              id,
              title: fmString((await readConceptPermissive(ctx.bundle, id)).doc.frontmatter.title),
            });
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
      const rows = ctx
        .engine()
        .listReviewRows()
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
    // No AI-spending job runs implicitly: embed only backfills an existing
    // store, and enrich-stale is deliberately absent (run `okb enrich` when
    // you mean to spend). Scheduling belongs to the OS (cron/Task Scheduler).
    name: "jobs",
    cliName: "jobs",
    summary: "Run the maintenance jobs once, under a lock (schedule via OS cron)",
    scope: "admin",
    params: [
      { name: "only", type: "string", description: "comma-separated subset of: index,embed,rss,review,doctor" },
    ],
    handler: async (ctx, p) => {
      const cfg = ctx.config();
      const feeds = cfg.rss?.feeds ?? [];
      const jobs: Job[] = [
        {
          name: "index",
          run: async () => renderStats(await buildIndex(ctx.bundle, ctx.engine(true))),
        },
        {
          name: "embed",
          skip: ctx.hasVectors()
            ? undefined
            : "no vector store — run `okb embed` once to opt in",
          run: async () => {
            const s = await embedBundle(ctx.bundle, ctx.vectors(), gatewayEmbedder(cfg.ai ?? {}));
            return `embedded ${s.embedded}, skipped ${s.skipped}, removed ${s.removed}${s.pending > 0 ? `, ${s.pending} pending` : ""}`;
          },
        },
        {
          name: "rss",
          skip: feeds.length > 0 ? undefined : "no rss.feeds configured",
          run: async () => {
            const rs = await pullFeeds(ctx, feeds, cfg.rss?.maxItems);
            const added = rs.reduce((n, r) => n + r.added.length, 0);
            const failed = rs.filter((r) => r.error !== undefined);
            return `${added} added across ${rs.length} feeds${failed.length > 0 ? `; failed: ${failed.map((f) => f.url).join(", ")}` : ""}`;
          },
        },
        {
          // F-B.7 nightly recompute: the queue is on-demand, so "recompute"
          // means surfacing today's queue in the run report.
          name: "review",
          run: async () => {
            const q = queueFor(ctx);
            return q.length === 0
              ? "queue empty"
              : q.map((it, i) => `${i + 1}. ${it.id} (${it.score.toFixed(2)}) — ${it.reasons.join("; ")}`).join("\n");
          },
        },
        {
          name: "doctor",
          run: async () => {
            const rep = await runDoctor(ctx.bundle);
            return `${rep.ok ? "ok" : "NOT CONFORMANT"} — ${rep.errors} errors, ${rep.warnings} warnings`;
          },
        },
      ];
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
      if (resolveBy !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(resolveBy))
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
      await writing(() => writeConcept(ctx.bundle, { id, extra: { outcome, resolved } }));
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
    name: "init",
    cliName: "init",
    summary: "Attach this bundle as the default and pick AI providers (config.json)",
    scope: "admin",
    params: [
      { name: "provider", type: "string", description: "chat provider: anthropic|openai|gemini|openrouter|ollama|llamacpp|lmstudio|local" },
      { name: "model", type: "string", description: "chat model (default: the provider's default)" },
      { name: "embed-provider", type: "string", description: "embedding provider: openai|voyage|gemini|ollama|llamacpp|lmstudio|local" },
      { name: "embed-model", type: "string", description: "embedding model" },
      { name: "retrieval-profile", type: "string", description: "default retrieval profile: lean|balanced|max" },
      { name: "no-default-bundle", type: "boolean", description: "don't change which bundle okb uses by default" },
    ],
    handler: async (ctx, p) => {
      const local = (v: unknown): string | undefined =>
        v === "local" ? "ollama" : (v as string | undefined);
      const cfg = loadConfig();
      const ai: AiSettings = { ...cfg.ai };
      if (p.provider !== undefined) ai.provider = local(p.provider);
      if (p.model !== undefined) ai.model = p.model as string;
      if (p["embed-provider"] !== undefined) ai.embedProvider = local(p["embed-provider"]);
      if (p["embed-model"] !== undefined) ai.embedModel = p["embed-model"] as string;
      if (p["retrieval-profile"] !== undefined) {
        if (!PROFILES[p["retrieval-profile"] as string])
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
      const chat = resolveCall("chat", ai, process.env);
      const embed = resolveCall("embed", ai, process.env);
      ai.provider ??= chat.provider;
      ai.embedProvider ??= embed.provider;
      cfg.ai = ai;
      if (p["no-default-bundle"] !== true) cfg.defaultBundle = ctx.bundle;
      const path = saveConfig(cfg);
      const describe = (r: typeof chat) => ({
        provider: r.provider,
        model: r.model,
        offline: r.recipe.kind === "local",
        keyStatus: r.apiKeyEnv ? `${r.apiKeyEnv} ${r.apiKey ? "present" : "MISSING"}` : "no key needed",
      });
      return {
        path,
        defaultBundle: cfg.defaultBundle ?? null,
        chat: describe(chat),
        embed: describe(embed),
      };
    },
    render: (r) => {
      const x = r as {
        path: string;
        defaultBundle: string | null;
        chat: { provider: string; model: string; keyStatus: string };
        embed: { provider: string; model: string; keyStatus: string };
      };
      return [
        `wrote ${x.path}`,
        ...(x.defaultBundle ? [`default bundle: ${x.defaultBundle}`] : []),
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
    ],
    handler: async (ctx, p) => {
      const { url } = createApiServer({
        bundle: ctx.bundle,
        port: p.port as number | undefined,
        readonly: ctx.readonly === true,
      });
      log.info(`serving ${ctx.bundle} at ${url} — Ctrl-C to stop`);
      log.info("clip from the browser: `okb bookmarklet`");
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
      const mode = trusted ? "TRUSTED — write ops exposed" : "untrusted, read-only";
      if (p.http === true || p.port !== undefined) {
        const port = (p.port as number | undefined) ?? DEFAULT_MCP_PORT;
        runMcpHttp({ bundle: ctx.bundle, trusted, readonly, port });
        log.info(`mcp: http://127.0.0.1:${port}/ (${mode})`);
      } else {
        await runMcpStdio({ bundle: ctx.bundle, trusted, readonly });
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

/** Validate trust and params per the op's declaration (every adapter's gate). */
export function checkOpCall(
  op: Operation,
  ctx: OpContext,
  raw: Record<string, unknown>,
): Record<string, unknown> {
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
