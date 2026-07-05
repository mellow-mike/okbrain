// The single operations registry behind every surface (CLAUDE.md invariant 2).
// Each op declares name, params, scope, and handler once; the CLI (and later
// the GUI API and MCP server) are thin adapters generated over this table.
// Trust is fail-closed (invariant 3): `runOp` refuses write/admin scope for any
// caller not explicitly trusted, before the handler is ever reached.

import { readFile } from "node:fs/promises";
import { buildIndex, type IndexStats } from "./engine/index-build.ts";
import type { Engine, Neighbor, SearchHit } from "./engine/interface.ts";
import { listConcepts } from "./okf/bundle.ts";
import { runDoctor, type DoctorReport } from "./okf/doctor.ts";
import { OkfParseError, parse, type OkfDocument } from "./okf/document.ts";
import { idToAbsPath, InvalidIdError, validateId } from "./okf/paths.ts";
import { OkfWriteError, writeConcept, type WriteResult } from "./okf/write.ts";
import { exportViz, type VizExport } from "./viz/export.ts";

export type Scope = "read" | "write" | "admin";

/** What an adapter supplies to run ops: bundle root, trust, and a lazy engine. */
export interface OpContext {
  bundle: string;
  trusted: boolean;
  /** Open (or return the already-open) engine; the adapter owns its lifecycle. */
  engine(): Engine;
}

export interface ParamSpec {
  /** Kebab-case; doubles as the CLI flag name (`--confirm-destructive`). */
  name: string;
  type: "string" | "int" | "boolean";
  required?: boolean;
  /** Filled from bare CLI arguments, in declaration order. */
  positional?: boolean;
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

interface TitledNeighbor extends Neighbor {
  title: string;
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
    summary: "Show the link neighborhood (links + backlinks) of a concept",
    scope: "read",
    params: [
      { name: "id", type: "string", required: true, positional: true, description: "concept id at the center" },
      { name: "depth", type: "int", description: "hops to walk (default 1)" },
    ],
    handler: async (ctx, p) => {
      const id = p.id as string;
      const eng = ctx.engine();
      if (!eng.getNode(id))
        throw new OpError(`concept not in index: ${id} (run \`okb index\`?)`, "not_found");
      return eng
        .neighbors(id, (p.depth as number | undefined) ?? 1)
        .map((n): TitledNeighbor => ({ ...n, title: eng.getNode(n.id)?.title ?? "" }));
    },
    render: (r) => {
      const ns = r as TitledNeighbor[];
      if (ns.length === 0) return "(no neighbors)";
      return ns.map((n) => `${n.depth}  ${n.id} — ${n.title}`).join("\n");
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
      const tags = p.tags as string | undefined;
      try {
        return await writeConcept(ctx.bundle, {
          id: p.id as string,
          type: p.type as string | undefined,
          title: p.title as string | undefined,
          description: p.description as string | undefined,
          body: p.body as string | undefined,
          resource: p.resource as string | undefined,
          tags: tags === undefined
            ? undefined
            : tags.split(",").map((t) => t.trim()).filter((t) => t !== ""),
        });
      } catch (e) {
        if (e instanceof OkfWriteError || e instanceof InvalidIdError)
          throw new OpError(e.message, "bad_params");
        throw e;
      }
    },
    render: (r) => {
      const w = r as WriteResult;
      return `${w.created ? "created" : "updated"} ${w.id}`;
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
    handler: (ctx) => buildIndex(ctx.bundle, ctx.engine()),
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
      const eng = ctx.engine();
      eng.wipe();
      return buildIndex(ctx.bundle, eng);
    },
    render: renderStats,
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
