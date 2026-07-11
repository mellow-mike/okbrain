// The single operations registry behind every surface (CLAUDE.md invariant 2).
// Each op declares name, params, scope, and handler once; the CLI (and later
// the GUI API and MCP server) are thin adapters generated over this table.
// Trust is fail-closed (invariant 3): `runOp` refuses write/admin scope for any
// caller not explicitly trusted, before the handler is ever reached.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { buildIndex, updateIndexFor, type IndexStats } from "./engine/index-build.ts";
import type { Engine, Neighbor, SearchHit } from "./engine/interface.ts";
import { orphans, shortestPath } from "./graph/queries.ts";
import { captureNote } from "./ingest/capture.ts";
import { importPath, type ImportResult } from "./ingest/import.ts";
import { listConcepts } from "./okf/bundle.ts";
import { runDoctor, type DoctorReport } from "./okf/doctor.ts";
import { OkfParseError, parse, type OkfDocument } from "./okf/document.ts";
import { idToAbsPath, InvalidIdError, slugify, validateId } from "./okf/paths.ts";
import { nowTimestamp, OkfWriteError, writeConcept, type WriteResult } from "./okf/write.ts";
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

/** Incrementally refresh written concepts in the index — if one exists. */
async function reindex(ctx: OpContext, ids: string[]): Promise<void> {
  if (!ctx.hasIndex()) return;
  for (const id of ids) await updateIndexFor(ctx.bundle, id, ctx.engine());
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

const queueFor = (eng: Engine, limit?: number): ReviewItem[] =>
  reviewQueue(eng.listReviewRows(), eng.listEdges(), new Date(), {
    ...defaultReviewConfig,
    queueSize: limit ?? defaultReviewConfig.queueSize,
  });

/** Review target: a 1-based queue position (pure integer in range) or a concept id. */
function resolveReviewTarget(eng: Engine, raw: string): string {
  if (/^\d+$/.test(raw)) {
    // Rank without the display limit so positions match any `--limit` listing.
    const q = queueFor(eng, Number.MAX_SAFE_INTEGER);
    const n = Number(raw);
    if (n >= 1 && n <= q.length) return q[n - 1]!.id;
  }
  requireNode(eng, raw);
  return raw;
}

/** Writer/id errors are caller mistakes → bad_params; the rest propagate. */
async function writing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OkfWriteError || e instanceof InvalidIdError)
      throw new OpError(e.message, "bad_params");
    throw e;
  }
}

export const operations: readonly Operation[] = [
  {
    name: "search",
    cliName: "search",
    summary: "Keyword search (BM25) over titles, bodies, and tags",
    scope: "read",
    params: [
      { name: "query", type: "string", required: true, positional: true, description: "search terms (all must match)" },
      { name: "limit", type: "int", description: "maximum hits (default 20)" },
    ],
    handler: async (ctx, p) =>
      ctx.engine().search(p.query as string, (p.limit as number | undefined) ?? 20),
    render: (r) => {
      const hits = r as SearchHit[];
      if (hits.length === 0) return "(no hits)";
      return hits.map((h) => `${h.score.toFixed(2)}  ${h.id} — ${h.title}`).join("\n");
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
      { name: "limit", type: "int", description: "queue size (default 5)" },
    ],
    handler: async (ctx, p) => queueFor(ctx.engine(), p.limit as number | undefined),
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
      const eng = ctx.engine();
      const id = resolveReviewTarget(eng, p.id as string);
      const lastReviewed = nowTimestamp();
      await writing(() =>
        writeConcept(ctx.bundle, { id, extra: { last_reviewed: lastReviewed }, metadataOnly: true }),
      );
      await reindex(ctx, [id]);
      eng.clearSnooze(id);
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
      const eng = ctx.engine();
      const id = resolveReviewTarget(eng, p.id as string);
      const snoozeUntil = new Date(Date.now() + days * 86_400_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      eng.setSnooze(id, snoozeUntil);
      return { id, snoozeUntil };
    },
    render: (r) => {
      const s = r as { id: string; snoozeUntil: string };
      return `snoozed ${s.id} until ${s.snoozeUntil.slice(0, 10)} (cleared by okb rebuild)`;
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
