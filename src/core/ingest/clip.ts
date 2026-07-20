// Clip (F-A.3/4): URL → conformant `references/<slug>` concept tagged `inbox`.
// Dedupe is by normalized canonical URL against every concept's `resource`
// (both sides normalized — hand-written resources count too); a re-clip
// appends to `# Highlights` instead of creating a duplicate. Works with or
// without an index (caller passes engine rows, else the bundle is scanned)
// and with zero AI providers. Offline fails fast — no queue in v1.

import { existsSync } from "node:fs";
import { fmString } from "../okf/document.ts";
import { listConcepts, readConceptPermissive } from "../okf/bundle.ts";
import { idToAbsPath, slugify } from "../okf/paths.ts";
import { nowTimestamp, writeConcept } from "../okf/write.ts";
import { guardedFetch, type FetchedPage } from "./fetch-guard.ts";
import { extractArticle, type ExtractedArticle } from "./extract.ts";

const CLIP_MAX_BODY_BYTES = 100_000;

// Tracking params stripped during URL normalization (clip.stripParams default).
const TRACKING = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_[ce]id$/i, /^igshid$/i];

/** Canonical comparison form: no fragment/tracking params, sorted query, lowercase host. */
export function normalizeUrl(raw: string, stripParams: string[] = []): string {
  const u = new URL(raw); // lowercases scheme+host, drops default ports
  u.hash = "";
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.some((re) => re.test(k)) && !stripParams.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.href;
}

export interface ClipInput {
  url: string;
  note?: string;
  quote?: string;
  tags?: string[];
  /** Skip the `inbox` tag (already read). */
  read?: boolean;
}

export interface ClipOptions {
  /** Injectable for tests; defaults to the guarded fetcher. */
  fetcher?: (url: string) => Promise<FetchedPage>;
  /** id+resource pairs from the engine; omitted → the bundle is scanned. */
  resources?: { id: string; resource: string }[];
  /** AI autoTag hook (F-B.8); called only for new clips, caller owns failure policy. */
  suggestTags?: (article: ExtractedArticle) => Promise<string[]>;
  /** `clip.*` config overrides (okb init config.json). */
  maxBodyBytes?: number;
  defaultTags?: string[];
  stripParams?: string[];
}

export interface ClipResult {
  id: string;
  created: boolean;
  /** Matched an existing concept by canonical URL. */
  deduped: boolean;
  /** A quote/note was appended under # Highlights. */
  appended: boolean;
  truncated: boolean;
  /** Tags added by the autoTag hook (empty when off or nothing suggested). */
  autoTags: string[];
}

/** Every concept's id+resource, scanned from the bundle (no index needed). */
export async function allResources(root: string): Promise<{ id: string; resource: string }[]> {
  const out: { id: string; resource: string }[] = [];
  for (const id of await listConcepts(root)) {
    const r = fmString((await readConceptPermissive(root, id)).doc.frontmatter.resource);
    if (r !== "") out.push({ id, resource: r });
  }
  return out;
}

/** First concept whose normalized `resource` equals `normalized`, else null. */
export function findByResource(
  resources: { id: string; resource: string }[],
  normalized: string,
  stripParams: string[],
): string | null {
  const tryNormalize = (raw: string): string | null => {
    try {
      return normalizeUrl(raw, stripParams);
    } catch {
      return null;
    }
  };
  for (const { id, resource } of resources)
    if (tryNormalize(resource) === normalized) return id;
  return null;
}

const highlightEntry = (quote?: string, note?: string): string | null => {
  if (!quote && !note) return null;
  const q = quote?.replace(/\s+/g, " ").trim();
  const n = note?.replace(/\s+/g, " ").trim();
  const parts = [q ? `"${q}"` : null, n].filter(Boolean);
  return `- ${nowTimestamp().slice(0, 10)}: ${parts.join(" — ")}`;
};

/** Append to the concept's `# Highlights` section (created when missing). */
async function appendHighlight(root: string, id: string, entry: string): Promise<void> {
  const { doc } = await readConceptPermissive(root, id);
  const body = doc.body.replace(/\s+$/, "");
  const withSection = /^# Highlights$/m.test(body)
    ? body.replace(/^# Highlights$/m, `# Highlights\n\n${entry}`)
    : `${body}\n\n# Highlights\n\n${entry}`;
  await writeConcept(root, { id, body: withSection });
}

function capBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= max) return { text: s, truncated: false };
  let t = s;
  while (Buffer.byteLength(t, "utf8") > max) t = t.slice(0, Math.floor(t.length * 0.9));
  const cut = t.lastIndexOf("\n");
  if (cut > 0) t = t.slice(0, cut);
  return {
    text: t + "\n\n*(truncated by okb clip — the original exceeded the body cap)*",
    truncated: true,
  };
}

export async function clipUrl(
  root: string,
  input: ClipInput,
  opts: ClipOptions = {},
): Promise<ClipResult> {
  const fetcher = opts.fetcher ?? guardedFetch;
  const resources = opts.resources ?? (await allResources(root));
  const strip = opts.stripParams ?? [];
  const entry = highlightEntry(input.quote, input.note);

  const finish = async (id: string): Promise<ClipResult> => {
    if (entry !== null) await appendHighlight(root, id, entry);
    return {
      id,
      created: false,
      deduped: true,
      appended: entry !== null,
      truncated: false,
      autoTags: [],
    };
  };

  // Known input URL → no fetch needed (also lets a re-clip work offline).
  const asGiven = normalizeUrl(input.url, strip);
  const known = findByResource(resources, asGiven, strip);
  if (known !== null) return finish(known);

  const page = await fetcher(input.url);
  const art = extractArticle(page.body, page.url);
  const canonical = normalizeUrl(art.canonicalUrl ?? page.url, strip);
  const byCanonical = findByResource(resources, canonical, strip);
  if (byCanonical !== null) return finish(byCanonical);

  const base = `references/${slugify(art.title)}`;
  let id = base;
  for (let n = 2; existsSync(idToAbsPath(root, id)); n++) id = `${base}-${n}`;

  const autoTags = opts.suggestTags ? await opts.suggestTags(art) : [];
  const { text, truncated } = capBytes(art.markdown, opts.maxBodyBytes ?? CLIP_MAX_BODY_BYTES);
  const cite = `- [${art.title}](${canonical})${art.byline ? ` — ${art.byline}` : ""}`;
  const body = [
    text,
    ...(entry !== null ? ["", "# Highlights", "", entry] : []),
    "",
    "# Citations",
    "",
    cite,
  ].join("\n");

  const host = new URL(canonical).hostname;
  const extra: Record<string, unknown> = {};
  if (art.byline) extra.author = art.byline;
  if (art.published) extra.published = art.published;
  await writeConcept(root, {
    id,
    type: "reference",
    title: art.title,
    description: art.description || `Clipped from ${host}`,
    resource: canonical,
    tags: [
      ...new Set([
        ...(opts.defaultTags ?? []),
        ...(input.tags ?? []),
        ...autoTags,
        ...(input.read ? [] : ["inbox"]),
      ]),
    ],
    body,
    extra,
  });
  return { id, created: true, deduped: false, appended: entry !== null, truncated, autoTags };
}
