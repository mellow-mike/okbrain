// Web pass (4.2): the LLM acts as a guarded crawler. The model drives a small
// JSON-action loop (list/read/fetch/write/done); every guardrail lives INSIDE
// the tools, never in the prompt: fetch_url enforces --no-web, the page cap,
// the depth cap, host allowlist, path filters, and only ever fetches URLs
// that were given as seeds or discovered on already-fetched pages (an
// invented URL is refused). Writes may enrich an existing concept or mint a
// new one under references/ — nothing else — and carry OKF v0.2 provenance:
// `sources` entries (merged, never shrunk, on existing concepts; required on
// new ones) and a `generated` event naming the agent + model. The gateway's
// chat is plain text, so the protocol is one JSON object per model turn.

import { parseHTML } from "linkedom";
import type { ChatMessage } from "../ai/gateway.ts";
import { readConceptPermissive } from "../okf/bundle.ts";
import { fmSources, type SourceEntry } from "../okf/document.ts";
import { idToAbsPath, validateId, InvalidIdError } from "../okf/paths.ts";
import { OkfWriteError, writeConcept } from "../okf/write.ts";
import { existsSync } from "node:fs";
import { extractArticle } from "./extract.ts";
import { FetchGuardError, guardedFetch, type FetchedPage } from "./fetch-guard.ts";

export interface WebPassLimits {
  /** Successful page fetches allowed in one run (0 with noWeb). */
  maxPages: number;
  /** Link-following depth: seeds are 0; a link found at depth d is d+1. */
  maxDepth: number;
  /** Hosts fetchable (exact or subdomain). Default: the seeds' hosts. */
  allowHosts: string[];
  /** URL path prefixes refused outright. */
  denyPaths: string[];
  /** When non-empty, only these URL path prefixes are fetchable. */
  allowPaths: string[];
  /** Refuse every fetch (the run works purely from the bundle). */
  noWeb: boolean;
  /** Hard cap on model turns, so a listing loop can't run forever. */
  maxSteps: number;
}

export const defaultLimits = (seeds: string[]): WebPassLimits => ({
  maxPages: 5,
  maxDepth: 1,
  allowHosts: [...new Set(seeds.map((s) => new URL(s).hostname))],
  denyPaths: [],
  allowPaths: [],
  noWeb: false,
  maxSteps: 24,
});

export class WebPassError extends Error {}

export interface EnrichDeps {
  /** One model turn: full message history in, reply text out. */
  chat(messages: ChatMessage[]): Promise<string>;
  /** Actor recorded as `generated.by` on every write (e.g. `okb-enrich/<model>`). */
  actor?: string;
  /** Injectable for tests; defaults to the guarded fetcher. */
  fetcher?(url: string): Promise<FetchedPage>;
  /** Concept ids + titles the list tool returns (engine or bundle scan). */
  listConcepts(): Promise<{ id: string; title: string }[]>;
  /** Cross-link proposals (4.4); absent when the bundle has no index. */
  suggestLinks?(id: string): Promise<unknown>;
}

export interface EnrichResult {
  written: { id: string; created: boolean }[];
  fetched: string[];
  summary: string;
  steps: number;
}

/** Observation content the fetch tool hands the model. */
const PAGE_CHARS = 6_000;
const PAGE_LINKS = 50;
const LIST_CAP = 200;
const BAD_REPLY_STRIKES = 2;
const DEFAULT_ACTOR = "okb-enrich/unknown";

const hostAllowed = (host: string, allow: string[]): boolean =>
  allow.some((h) => host === h || host.endsWith(`.${h}`));

/** First balanced JSON object in the reply; models sometimes add prose. */
export function parseAction(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const v = JSON.parse(text.slice(start, i + 1));
        return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** All absolute http(s) links on a page (the crawl frontier), capped. */
function pageLinks(html: string, pageUrl: string): string[] {
  const { document } = parseHTML(html);
  const out: string[] = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (out.length === PAGE_LINKS) break;
    try {
      const u = new URL(a.getAttribute("href")!, pageUrl);
      u.hash = "";
      if ((u.protocol === "http:" || u.protocol === "https:") && !out.includes(u.href))
        out.push(u.href);
    } catch {
      /* unresolvable href */
    }
  }
  return out;
}

/** The model's `sources` argument as entries (strings are bare resources). */
function sourcesArg(v: unknown): SourceEntry[] {
  if (!Array.isArray(v)) return [];
  const out: SourceEntry[] = [];
  for (const s of v) {
    if (typeof s === "string" && s !== "") out.push({ resource: s });
    else if (typeof s === "object" && s !== null && typeof (s as SourceEntry).resource === "string")
      out.push(s as SourceEntry);
  }
  return out;
}

const SYSTEM = `You are okbrain's enrichment agent, working inside a personal Open Knowledge Format (OKF v0.2) bundle.
Improve the bundle per the task: enrich existing concepts, mint new reference concepts, or skip when nothing is worth writing.

Respond with EXACTLY one JSON object per turn (no prose), one of:
{"action":"list_concepts"}
{"action":"read_concept","id":"<concept id>"}
{"action":"fetch_url","url":"<seed or discovered url>"}
{"action":"link_suggest","id":"<concept id>"}
{"action":"write_concept","id":"<id>","type":"<type>","title":"...","description":"one line","body":"<markdown>","tags":["optional"],"sources":[{"id":"short-key","resource":"<url you fetched>","title":"page title"}]}
{"action":"done","summary":"<what you did and why>"}

Rules:
- Only fetch URLs given as seeds or listed in a previous fetch result's "links".
- Provenance is frontmatter, not prose: every web page a write draws on must appear in "sources" (resource = the fetched URL). Attribute specific claims in the body with a footnote whose label is the source id, e.g. "…as documented.[^short-key]". Never write a "# Citations" section.
- New concepts must have an id under references/ (e.g. references/some-topic) and at least one source. Existing concepts may be updated; omit fields to keep their current values — existing sources are kept and merged.
- Prefer few, high-value writes. When finished (or nothing qualifies), send done.`;

/**
 * Run the enrichment loop. Deterministic given `chat`/`fetcher`; every
 * guardrail is enforced in the tool handlers, and a rule-breaking action gets
 * an error observation (the model may correct course) rather than an abort.
 */
export async function runEnrich(
  root: string,
  task: string,
  seeds: string[],
  limits: WebPassLimits,
  deps: EnrichDeps,
): Promise<EnrichResult> {
  const fetcher = deps.fetcher ?? guardedFetch;
  const actor = deps.actor ?? DEFAULT_ACTOR;
  // The crawl frontier: URL → depth. Only entries here are ever fetchable.
  const frontier = new Map<string, number>(seeds.map((s) => [s, 0]));
  const result: EnrichResult = { written: [], fetched: [], summary: "", steps: 0 };

  const fetchTool = async (rawUrl: string): Promise<unknown> => {
    if (limits.noWeb) throw new WebPassError("web access is disabled (--no-web)");
    const depth = frontier.get(rawUrl);
    if (depth === undefined)
      throw new WebPassError("only seed URLs or links from fetched pages can be fetched");
    if (depth > limits.maxDepth)
      throw new WebPassError(`beyond the depth cap (${limits.maxDepth})`);
    const url = new URL(rawUrl);
    if (!hostAllowed(url.hostname, limits.allowHosts))
      throw new WebPassError(`host not in the allowlist: ${url.hostname}`);
    if (limits.denyPaths.some((p) => url.pathname.startsWith(p)))
      throw new WebPassError(`path is denied: ${url.pathname}`);
    if (limits.allowPaths.length > 0 && !limits.allowPaths.some((p) => url.pathname.startsWith(p)))
      throw new WebPassError(`path is outside the allowed prefixes: ${url.pathname}`);
    // Budget last: policy refusals report their real reason even after the cap.
    if (result.fetched.length >= limits.maxPages)
      throw new WebPassError(`page cap reached (${limits.maxPages}); write or finish`);

    const page = await fetcher(rawUrl);
    result.fetched.push(rawUrl);
    const links = pageLinks(page.body, page.url);
    for (const l of links) if (!frontier.has(l)) frontier.set(l, depth + 1);
    const art = extractArticle(page.body, page.url);
    const markdown =
      art.markdown.length > PAGE_CHARS
        ? art.markdown.slice(0, PAGE_CHARS) + "\n…(truncated)"
        : art.markdown;
    return { url: page.url, title: art.title, markdown, links };
  };

  const writeTool = async (a: Record<string, unknown>): Promise<unknown> => {
    const id = a.id as string;
    if (typeof id !== "string" || id === "") throw new WebPassError("write_concept needs an id");
    try {
      validateId(id);
    } catch (e) {
      throw new WebPassError((e as InvalidIdError).message);
    }
    const exists = existsSync(idToAbsPath(root, id));
    if (!exists && !id.startsWith("references/"))
      throw new WebPassError(
        `new concepts must live under references/ (got ${id}); existing concepts may be enriched in place`,
      );
    // Provenance: merge onto what the concept already cites (never shrink), and
    // a minted reference must cite at least one source.
    const given = sourcesArg(a.sources);
    const have = exists ? fmSources((await readConceptPermissive(root, id)).doc.frontmatter) : [];
    const known = new Set(have.map((s) => s.resource));
    const sources = [...have, ...given.filter((s) => !known.has(s.resource))];
    if (!exists && sources.length === 0)
      throw new WebPassError("a new reference concept needs at least one sources entry (the page it was drawn from)");
    const r = await writeConcept(root, {
      id,
      type: a.type as string | undefined,
      title: a.title as string | undefined,
      description: a.description as string | undefined,
      body: a.body as string | undefined,
      tags: Array.isArray(a.tags) ? (a.tags as string[]).map(String) : undefined,
      sources: sources.length > 0 ? sources : undefined,
      actor,
    });
    result.written.push({ id: r.id, created: r.created });
    return { written: r.id, created: r.created, sources: sources.length };
  };

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: JSON.stringify({
        task,
        seeds,
        limits: { maxPages: limits.maxPages, maxDepth: limits.maxDepth, web: !limits.noWeb },
      }),
    },
  ];

  let strikes = 0;
  while (result.steps < limits.maxSteps) {
    result.steps++;
    const reply = await deps.chat(messages);
    messages.push({ role: "assistant", content: reply });
    const action = parseAction(reply);

    let observation: unknown;
    if (action === null) {
      if (++strikes > BAD_REPLY_STRIKES) {
        result.summary = "aborted: the model kept replying without a parseable JSON action";
        return result;
      }
      observation = { error: "reply must be exactly one JSON action object" };
    } else if (action.action === "done") {
      result.summary = String(action.summary ?? "");
      return result;
    } else {
      try {
        switch (action.action) {
          case "list_concepts": {
            const all = await deps.listConcepts();
            observation = { concepts: all.slice(0, LIST_CAP), total: all.length };
            break;
          }
          case "read_concept": {
            const id = String(action.id ?? "");
            validateId(id);
            const { doc } = await readConceptPermissive(root, id);
            observation = { id, frontmatter: doc.frontmatter, body: doc.body };
            break;
          }
          case "fetch_url":
            observation = await fetchTool(String(action.url ?? ""));
            break;
          case "link_suggest":
            observation = deps.suggestLinks
              ? { suggestions: await deps.suggestLinks(String(action.id ?? "")) }
              : { error: "link suggestions need an index (run `okb index` first)" };
            break;
          case "write_concept":
            observation = await writeTool(action);
            break;
          default:
            observation = { error: `unknown action: ${String(action.action)}` };
        }
      } catch (e) {
        // Guard refusals, fetch failures, and bad writes become observations,
        // not crashes — the model can correct course. Anything else surfaces.
        if (
          e instanceof WebPassError ||
          e instanceof InvalidIdError ||
          e instanceof FetchGuardError ||
          e instanceof OkfWriteError ||
          (e as NodeJS.ErrnoException).code === "ENOENT"
        )
          observation = { error: (e as Error).message };
        else throw e;
      }
    }
    messages.push({ role: "user", content: JSON.stringify(observation) });
  }
  result.summary = `stopped at the step cap (${limits.maxSteps})`;
  return result;
}
