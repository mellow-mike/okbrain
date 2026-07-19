// RSS/Atom ingest (4.1): feed parsing (RSS 2.0 + Atom), pull mechanics with an
// injected fetcher (dedupe vs resources and in-run, limit, skip rules,
// doctor-clean output), and the CLI op. No live network anywhere.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeed, pullFeed, FeedError } from "../src/core/ingest/rss.ts";
import { runDoctor } from "../src/core/okf/doctor.ts";
import { okb } from "./helpers.ts";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Example Blog</title>
  <link>https://blog.example.com/</link>
  <item>
    <title>First Post</title>
    <link>https://blog.example.com/first?utm_source=rss</link>
    <pubDate>Mon, 13 Jul 2026 10:00:00 GMT</pubDate>
    <dc:creator>Ann Author</dc:creator>
    <description>Short summary.</description>
    <content:encoded>&lt;p&gt;Full &lt;b&gt;content&lt;/b&gt; of the post.&lt;/p&gt;</content:encoded>
  </item>
  <item>
    <title>Second Post</title>
    <link>/second</link>
    <description>&lt;p&gt;Relative link entry.&lt;/p&gt;</description>
  </item>
  <item>
    <title>No Link At All</title>
    <description>Cannot be stored.</description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Entry One</title>
    <link rel="self" href="https://ex.org/meta"/>
    <link rel="alternate" href="https://ex.org/e1"/>
    <id>tag:e1</id>
    <published>2026-07-13T10:00:00Z</published>
    <author><name>Bob</name></author>
    <content type="html">&lt;p&gt;Atom body&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Entry Two</title>
    <link href="https://ex.org/e2"/>
    <updated>2026-07-14T10:00:00Z</updated>
    <summary>Plain summary</summary>
  </entry>
</feed>`;

const FEED_URL = "https://blog.example.com/feed.xml";
const fake = (body: string, url = FEED_URL) => {
  const f = async () => ({ url, contentType: "application/xml", body });
  return f;
};

function tempBundle(): string {
  return mkdtempSync(join(tmpdir(), "okb-rss-"));
}

describe("parseFeed", () => {
  test("RSS 2.0: channel title, items, content:encoded preferred, dc:creator", () => {
    const f = parseFeed(RSS, FEED_URL);
    expect(f.title).toBe("Example Blog");
    expect(f.items.length).toBe(3);
    const [first, second, third] = f.items;
    expect(first!.title).toBe("First Post");
    expect(first!.url).toBe("https://blog.example.com/first?utm_source=rss");
    expect(first!.contentHtml).toContain("<b>content</b>");
    expect(first!.author).toBe("Ann Author");
    expect(first!.published).toContain("2026");
    expect(second!.url).toBe("https://blog.example.com/second"); // resolved vs feed URL
    expect(third!.url).toBeNull();
  });

  test("Atom: rel=alternate link wins, author name, published/updated fallback", () => {
    const f = parseFeed(ATOM, "https://ex.org/feed");
    expect(f.title).toBe("Atom Feed");
    const [e1, e2] = f.items;
    expect(e1!.url).toBe("https://ex.org/e1");
    expect(e1!.author).toBe("Bob");
    expect(e1!.contentHtml).toContain("Atom body");
    expect(e2!.url).toBe("https://ex.org/e2");
    expect(e2!.published).toBe("2026-07-14T10:00:00Z");
    expect(e2!.contentHtml).toBe("Plain summary");
  });

  test("non-feed XML is refused", () => {
    expect(() => parseFeed("<html><body>nope</body></html>", FEED_URL)).toThrow(FeedError);
  });
});

describe("pullFeed", () => {
  test("writes conformant reference concepts; tracking params stripped", async () => {
    const root = tempBundle();
    try {
      const r = await pullFeed(root, FEED_URL, { fetcher: fake(RSS) });
      expect(r.feed).toBe("Example Blog");
      expect(r.added.map((a) => a.id)).toEqual([
        "references/first-post",
        "references/second-post",
      ]);
      expect(r.skipped).toBe(1); // the linkless item

      const raw = await readFile(join(root, "references", "first-post.md"), "utf8");
      expect(raw).toContain("resource: https://blog.example.com/first"); // utm gone
      expect(raw).not.toContain("utm_source");
      expect(raw).toContain("Full **content** of the post.");
      expect(raw).toContain("# Citations");
      expect(raw).toContain("author: Ann Author");
      expect(raw).toContain("- rss");

      const rep = await runDoctor(root);
      expect(rep.errors).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-pull dedupes everything; clip-style resource match counts too", async () => {
    const root = tempBundle();
    try {
      await pullFeed(root, FEED_URL, { fetcher: fake(RSS) });
      const again = await pullFeed(root, FEED_URL, { fetcher: fake(RSS) });
      expect(again.added).toEqual([]);
      expect(again.deduped).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("limit caps new items per pull; the rest arrive on the next run", async () => {
    const root = tempBundle();
    try {
      const first = await pullFeed(root, FEED_URL, { fetcher: fake(RSS), limit: 1 });
      expect(first.added.length).toBe(1);
      const second = await pullFeed(root, FEED_URL, { fetcher: fake(RSS), limit: 5 });
      expect(second.added.length).toBe(1);
      expect(second.deduped).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("duplicate links inside one feed dedupe in-run", async () => {
    const twice = RSS.replaceAll("/second", "/first?utm_source=rss");
    const root = tempBundle();
    try {
      const r = await pullFeed(root, FEED_URL, { fetcher: fake(twice) });
      expect(r.added.length).toBe(1);
      expect(r.deduped).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("okb rss (CLI)", () => {
  test("no URL and no configured feeds → usage error", async () => {
    const root = tempBundle();
    try {
      const r = await okb(["rss", "--bundle", root]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("rss.feeds");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fetch guard is live on the op path (private target refused)", async () => {
    const root = tempBundle();
    try {
      const r = await okb(["rss", "http://127.0.0.1:1/feed.xml", "--bundle", root]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("private/loopback");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
