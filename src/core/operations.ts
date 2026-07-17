// The single operations registry behind every surface (CLAUDE.md invariant 2).
// Each op declares name, params, scope, and handler once; the CLI (and later
// the GUI API and MCP server) are thin adapters generated over this table.
// Trust is fail-closed (invariant 3): `runOp` refuses write/admin scope for any
// caller not explicitly trusted, before the handler is ever reached.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createGateway, RECIPES, resolveCall } from "./ai/gateway.ts";
import { loadConfig, saveConfig, type AiSettings, type OkbConfig } from "./config.ts";
import { buildIndex, updateIndexFor, type IndexStats } from "./engine/index-build.ts";
import type { Engine, Neighbor, VectorStore } from "./engine/interface.ts";
import { orphans, shortestPath } from "./graph/queries.ts";
import { log } from "./log.ts";
import { captureNote } from "./ingest/capture.ts";
import { clipUrl, type ClipResult } from "./ingest/clip.ts";
import { FetchGuardError } from "./ingest/fetch-guard.ts";
import { importPath, type ImportResult } from "./ingest/import.ts";
import { listConcepts } from "./okf/bundle.ts";
import { runDoctor, type DoctorReport } from "./okf/doctor.ts";
import { fmTags, OkfParseError, parse, type OkfDocument } from "./okf/document.ts";
import { idToAbsPath, InvalidIdError, slugify, validateId } from "./okf/paths.ts";
import { nowTimestamp, OkfWriteError, writeConcept, type WriteResult } from "./okf/write.ts";
import { askBrain, type AskResult } from "./retrieval/ask.ts";
import { embedBundle, embedConcept, gatewayEmbedder, type EmbedStats } from "./retrieval/embed.ts";
import { hybridRetrieve, type HybridArms, type HybridHit } from "./retrieval/hybrid.ts";
import { ProfileError, resolveProfile, type RetrievalProfile } from "./retrieval/profiles.ts";
import { rerankConfigured, rerankHits } from "./retrieval/rerank.ts";
import { defaultReviewConfig, reviewQueue, type ReviewItem } from "./review/score.ts";
import { syncBundle, syncStatus, type SyncResult, type SyncStatus } from "./sync.ts";
import { exportViz, type VizExport } from "./viz/export.ts";

export type Scope = "read" | "write" | "admin";

/** What an adapter supplies to run ops: bundle root, trust, and a lazy engine. */
export interface OpContext {
  bundle: string;
  trusted: boolean;
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
  return `${w.created ? "created" : "updated"} ${w.id}`;
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

/** Writer/id errors are caller mistakes → bad_params; guard blocks → refused. */
async function writing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OkfWriteError || e instanceof InvalidIdError)
      throw new OpError(e.message, "bad_params");
    if (e instanceof FetchGuardError) throw new OpError(e.message, "refused");
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
    handler: async (ctx, p) => {
      const profile = profileOf(ctx, p);
      const gw = createGateway(ctx.config().ai ?? {});
      const r = await askBrain(
        p.question as string,
        {
          bundle: ctx.bundle,
          arms: hybridArms(ctx),
          chat: (messages) => gw.chat(messages),
          rerank: (q, hits) => maybeRerank(ctx, q, hits, profile),
        },
        profile,
      );
      warnVectorSkip(ctx, r.vectorSkipped);
      return r;
    },
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
    ],
    handler: async (ctx, p) => queueFor(ctx, p.limit as number | undefined),
    render: (r) => {
      const q = r as ReviewItem[];
      if (q.length === 0) return "(queue is empty — nothing needs review)";
      return q
        .map(
          (it, i) =>
            `${i + 1}. ${it.id} — ${it.title} (${it.score.toFixed(2)}) — ${it.reasons.join("; ")}`,
        )
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
      return `clipped ${c.id}${c.truncated ? " (body truncated at the 100 KB cap)" : ""}`;
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
    name: "init",
    cliName: "init",
    summary: "Attach this bundle as the default and pick AI providers (config.json)",
    scope: "admin",
    params: [
      { name: "provider", type: "string", description: "chat provider: anthropic|openai|gemini|openrouter|ollama|llamacpp|lmstudio|local" },
      { name: "model", type: "string", description: "chat model (default: the provider's default)" },
      { name: "embed-provider", type: "string", description: "embedding provider: openai|voyage|gemini|ollama|llamacpp|lmstudio|local" },
      { name: "embed-model", type: "string", description: "embedding model" },
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

/** Validate trust and params per the op's declaration, then run its handler. */
export async function runOp(
  op: Operation,
  ctx: OpContext,
  raw: Record<string, unknown>,
): Promise<unknown> {
  if (!ctx.trusted && op.scope !== "read")
    throw new OpError(
      `op ${op.name} (scope ${op.scope}) is not available to untrusted callers`,
      "untrusted",
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
  return op.handler(ctx, params);
}
