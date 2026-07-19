// Readable-article extraction (F-A.2): linkedom parses, @mozilla/readability
// isolates the article, turndown emits markdown. Verified working on Bun
// (Decisions Log). Relative links/images are absolutized against the page URL
// so clipped markdown keeps working outside the page.

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export interface ExtractedArticle {
  title: string;
  markdown: string;
  description: string;
  /** <link rel=canonical> / og:url when the page declares one. */
  canonicalUrl: string | null;
  byline: string | null;
  published: string | null;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.remove(["script", "style", "noscript"]);

/** HTML (or plain text) → markdown with the clip conversion rules. */
export const htmlToMarkdown = (html: string): string => turndown.turndown(html).trim();

/** Rewrite relative hrefs/srcs in an HTML fragment to absolute URLs. */
function absolutize(fragmentHtml: string, pageUrl: string): string {
  const { document } = parseHTML(fragmentHtml);
  for (const [sel, attr] of [
    ["a[href]", "href"],
    ["img[src]", "src"],
  ] as const)
    for (const el of document.querySelectorAll(sel)) {
      try {
        el.setAttribute(attr, new URL(el.getAttribute(attr)!, pageUrl).href);
      } catch {
        /* leave unresolvable values as-is */
      }
    }
  return document.toString(); // stray wrapper tags are inert to turndown
}

export function extractArticle(html: string, pageUrl: string): ExtractedArticle {
  const { document } = parseHTML(html);
  const meta = (sel: string): string | null =>
    document.querySelector(sel)?.getAttribute("content")?.trim() || null;

  const canonicalUrl =
    document.querySelector("link[rel=canonical]")?.getAttribute("href")?.trim() ||
    meta('meta[property="og:url"]');

  // Readability mutates its document; the metadata reads above came first.
  const article = new Readability(document as never).parse();
  const contentHtml = article?.content ?? document.querySelector("body")?.innerHTML ?? "";
  const markdown = turndown.turndown(absolutize(contentHtml, pageUrl)).trim();

  const title =
    article?.title?.trim() ||
    meta('meta[property="og:title"]') ||
    document.querySelector("title")?.textContent?.trim() ||
    new URL(pageUrl).hostname;
  const description =
    meta('meta[name="description"]') ||
    meta('meta[property="og:description"]') ||
    article?.excerpt?.trim() ||
    "";
  return {
    title,
    markdown,
    description,
    canonicalUrl: canonicalUrl ? new URL(canonicalUrl, pageUrl).href : null,
    byline: article?.byline?.trim() || meta('meta[name="author"]'),
    published: meta('meta[property="article:published_time"]') || meta('meta[name="date"]'),
  };
}
