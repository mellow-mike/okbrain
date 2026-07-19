// RSS/Atom ingest (4.1): feed → conformant `references/<slug>` concepts,
// deduped by normalized item URL against every concept's `resource` — the
// same rule as clip, so a feed entry and a hand-clipped article of the same
// page can never duplicate. Entries keep the feed's own summary/content;
// fetching the full page stays clip's (or the enrich pass's) job. Zero AI,
// idempotent re-pulls, works with or without an index.

import { existsSync } from "node:fs";
import { DOMParser } from "linkedom";
import { idToAbsPath, slugify } from "../okf/paths.ts";
import { writeConcept } from "../okf/write.ts";
import { allResources, findByResource, normalizeUrl } from "./clip.ts";
import { htmlToMarkdown } from "./extract.ts";
import { guardedFetch, type FetchedPage } from "./fetch-guard.ts";

export class FeedError extends Error {}

export interface FeedItem {
  title: string;
  url: string | null;
  /** Entry content/summary as the feed carried it (HTML or plain text). */
  contentHtml: string;
  published: string | null;
  author: string | null;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

type El = { tagName: string; textContent: string | null; children: Iterable<El>; getAttribute(n: string): string | null };

/** Direct children with a given tag name (querySelector would cross item boundaries). */
const kids = (el: El, ...names: string[]): El[] =>
  [...el.children].filter((c) => names.includes(c.tagName));
const kidText = (el: El, ...names: string[]): string =>
  kids(el, ...names)[0]?.textContent?.trim() ?? "";

/** Parse RSS 2.0 / RSS 1.0 (RDF) / Atom. Item URLs resolve against `feedUrl`. */
export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement as El | null;
  const abs = (href: string): string | null => {
    if (href === "") return null; // new URL("", base) would yield the feed itself
    try {
      return new URL(href, feedUrl).href;
    } catch {
      return null;
    }
  };

  if (root && (root.tagName === "rss" || root.tagName === "rdf:RDF")) {
    const channel = ([...root.children] as El[]).find((c) => c.tagName === "channel");
    const items = [...doc.querySelectorAll("item")].map((raw): FeedItem => {
      const it = raw as unknown as El;
      return {
        title: kidText(it, "title"),
        url: abs(kidText(it, "link")),
        contentHtml: kidText(it, "content:encoded") || kidText(it, "description"),
        published: kidText(it, "pubDate", "dc:date") || null,
        author: kidText(it, "dc:creator", "author") || null,
      };
    });
    return { title: channel ? kidText(channel, "title") : "", items };
  }

  if (root && root.tagName === "feed") {
    const entries = kids(root, "entry").map((e): FeedItem => {
      const links = kids(e, "link");
      const link =
        links.find((l) => (l.getAttribute("rel") ?? "alternate") === "alternate") ?? links[0];
      const author = kids(e, "author")[0];
      return {
        title: kidText(e, "title"),
        url: link ? abs(link.getAttribute("href") ?? "") : null,
        contentHtml: kidText(e, "content") || kidText(e, "summary"),
        published: kidText(e, "published") || kidText(e, "updated") || null,
        author: author ? kidText(author, "name") : null,
      };
    });
    return { title: kidText(root, "title"), items: entries };
  }

  throw new FeedError(
    `not an RSS/Atom feed (<${root?.tagName ?? "?"}> root): ${feedUrl}`,
  );
}

export interface RssPullOptions {
  /** Injectable for tests; defaults to the guarded fetcher. */
  fetcher?: (url: string) => Promise<FetchedPage>;
  /** id+resource pairs from the engine; omitted → the bundle is scanned. */
  resources?: { id: string; resource: string }[];
  /** Max new concepts written per pull (default 10). */
  limit?: number;
  /** Extra query params stripped during URL normalization (clip.stripParams). */
  stripParams?: string[];
}

export interface RssPullResult {
  url: string;
  feed: string;
  added: { id: string; title: string }[];
  /** Items whose URL already exists as a concept `resource`. */
  deduped: number;
  /** Items without a usable http(s) link or derivable id. */
  skipped: number;
  /** Set instead of throwing on multi-feed pulls, so one dead feed can't block the rest. */
  error?: string;
}

/** One-line description from the entry's content, capped; falls back to the feed. */
function describe(markdown: string, feedTitle: string, host: string): string {
  const line = markdown.replace(/\s+/g, " ").trim();
  if (line === "") return `From ${feedTitle || host}`;
  return line.length > 200 ? line.slice(0, 199).trimEnd() + "…" : line;
}

/** Pull one feed and write its new items as reference concepts. */
export async function pullFeed(
  root: string,
  feedUrl: string,
  opts: RssPullOptions = {},
): Promise<RssPullResult> {
  const fetcher = opts.fetcher ?? guardedFetch;
  const strip = opts.stripParams ?? [];
  const limit = opts.limit ?? 10;
  const resources = [...(opts.resources ?? (await allResources(root)))];

  const page = await fetcher(feedUrl);
  const feed = parseFeed(page.body, page.url);
  const result: RssPullResult = { url: feedUrl, feed: feed.title, added: [], deduped: 0, skipped: 0 };

  for (const item of feed.items) {
    if (result.added.length >= limit) break;
    let canonical: string | null = null;
    try {
      if (item.url !== null && /^https?:/i.test(item.url))
        canonical = normalizeUrl(item.url, strip);
    } catch {
      /* unusable URL → skipped below */
    }
    if (canonical === null) {
      result.skipped++;
      continue;
    }
    if (findByResource(resources, canonical, strip) !== null) {
      result.deduped++;
      continue;
    }

    let slug: string;
    try {
      slug = slugify(item.title || new URL(canonical).pathname);
    } catch {
      result.skipped++; // neither title nor path yields an id segment
      continue;
    }
    let id = `references/${slug}`;
    for (let n = 2; existsSync(idToAbsPath(root, id)); n++) id = `references/${slug}-${n}`;

    const markdown = item.contentHtml === "" ? "" : htmlToMarkdown(item.contentHtml);
    const title = item.title || canonical;
    const host = new URL(canonical).hostname;
    const cite = `- [${title}](${canonical})${feed.title ? ` — ${feed.title}` : ""}`;
    const extra: Record<string, unknown> = { feed: page.url };
    if (item.author) extra.author = item.author;
    if (item.published) extra.published = item.published;

    await writeConcept(root, {
      id,
      type: "reference",
      title,
      description: describe(markdown, feed.title, host),
      resource: canonical,
      tags: ["inbox", "rss"],
      body: [...(markdown === "" ? [] : [markdown, ""]), "# Citations", "", cite].join("\n"),
      extra,
    });
    resources.push({ id, resource: canonical }); // in-run dedupe
    result.added.push({ id, title });
  }
  return result;
}
