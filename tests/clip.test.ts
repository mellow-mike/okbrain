// Clip (F-A): URL normalization, the fetch guard (private targets rejected
// with no packets sent; mechanics against a 127.0.0.1 stub with allowPrivate),
// extraction on a local fixture, and the clip/inbox pipeline with an injected
// fetcher. No live network anywhere.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipUrl, normalizeUrl } from "../src/core/ingest/clip.ts";
import { parse } from "../src/core/okf/document.ts";
import { extractArticle } from "../src/core/ingest/extract.ts";
import {
  FetchGuardError,
  guardedFetch,
  isPrivateIp,
  type FetchedPage,
} from "../src/core/ingest/fetch-guard.ts";
import { okb } from "./helpers.ts";

const FIXTURE = await readFile(join(import.meta.dir, "fixtures", "article.html"), "utf8");
const PAGE_URL = "https://example.com/articles/test-article?utm_source=feed";

/** Fake fetcher: serves `html` as if fetched from `finalUrl`, counting calls. */
const fake = (html: string, finalUrl: string) => {
  const f = async (_url: string): Promise<FetchedPage> => {
    f.calls++;
    return { url: finalUrl, contentType: "text/html", body: html };
  };
  f.calls = 0;
  return f;
};

describe("normalizeUrl", () => {
  test("strips fragment + tracking params, sorts the rest, folds case", () => {
    expect(
      normalizeUrl("HTTPS://Example.COM:443/a?utm_source=x&b=2&a=1&fbclid=f#frag"),
    ).toBe("https://example.com/a?a=1&b=2");
    expect(normalizeUrl("http://example.com/a?gclid=1&utm_campaign=c")).toBe(
      "http://example.com/a",
    );
    expect(normalizeUrl("https://example.com/a?keep=1")).toBe(
      "https://example.com/a?keep=1",
    );
  });
});

describe("fetch guard — target policy (no packets sent)", () => {
  test("non-http(s) schemes are rejected", async () => {
    await expect(guardedFetch("file:///etc/passwd")).rejects.toThrow(/only http\/https/);
    await expect(guardedFetch("ftp://example.com/x")).rejects.toThrow(FetchGuardError);
    await expect(guardedFetch("not a url")).rejects.toThrow(/not a valid URL/);
  });

  test("loopback/private/link-local targets are rejected", async () => {
    for (const url of [
      "http://127.0.0.1/x",
      "http://localhost/x",
      "http://10.0.0.1/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/x",
      "http://[::1]/x",
    ])
      await expect(guardedFetch(url)).rejects.toThrow(/private\/loopback|cannot resolve/);
  });

  test("isPrivateIp classification", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.9.9", "127.0.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::2", "::ffff:192.168.0.1"])
      expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])
      expect(isPrivateIp(ip)).toBe(false);
  });

  // Textual matching on the un-expanded literal missed every spelling but the
  // dotted-quad one, so `http://[::ffff:7f00:1]/` walked straight past the
  // guard into loopback (and `::ffff:a9fe:a9fe` into cloud metadata).
  test("isPrivateIp expands IPv6 before classifying", () => {
    for (const ip of [
      "::ffff:7f00:1", // 127.0.0.1, hex form
      "::ffff:a9fe:a9fe", // 169.254.169.254, hex form
      "::ffff:a00:1", // 10.0.0.1, hex form
      "0:0:0:0:0:0:0:1", // loopback, fully expanded
      "0000:0000:0000:0000:0000:0000:0000:0001",
      "::127.0.0.1", // IPv4-compatible
      "::", // unspecified
      "fdff:ffff::1", // fc00::/7 upper half
      "febf::1", // fe80::/10 upper bound
      "ff02::1", // link-local all-nodes multicast
    ])
      expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ["::ffff:808:808", "2001:4860:4860::8888", "fec0::1"])
      expect(isPrivateIp(ip)).toBe(false);
  });

  test("guardedFetch refuses loopback spelled as IPv4-mapped IPv6", async () => {
    const victim = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("internal") });
    try {
      for (const host of [`[::ffff:7f00:1]:${victim.port}`, `[0:0:0:0:0:0:0:1]:${victim.port}`])
        await expect(guardedFetch(`http://${host}/`)).rejects.toThrow(/private\/loopback/);
    } finally {
      victim.stop(true);
    }
  });
});

describe("fetch guard — mechanics (stub server, allowPrivate)", () => {
  let server: ReturnType<typeof Bun.serve>;
  const base = () => `http://127.0.0.1:${server.port}`;
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/article")
          return new Response(FIXTURE, { headers: { "content-type": "text/html" } });
        if (p === "/r1") return Response.redirect(`${base()}/r2`, 302);
        if (p === "/r2") return Response.redirect(`${base()}/article`, 302);
        if (p === "/loop") return Response.redirect(`${base()}/loop`, 302);
        if (p === "/big") return new Response("x".repeat(300_000));
        if (p === "/slow") {
          await Bun.sleep(500);
          return new Response("late");
        }
        if (p === "/missing") return new Response("no", { status: 404 });
        return new Response("root");
      },
    });
  });
  afterAll(() => server.stop(true));
  const opts = { allowPrivate: true };

  test("follows redirects and reports the final URL", async () => {
    const page = await guardedFetch(`${base()}/r1`, opts);
    expect(page.url).toBe(`${base()}/article`);
    expect(page.body).toContain("Test Article");
  });

  test("redirect loops, size cap, timeout, and HTTP errors fail loudly", async () => {
    await expect(guardedFetch(`${base()}/loop`, { ...opts, maxRedirects: 3 })).rejects.toThrow(
      /too many redirects/,
    );
    await expect(guardedFetch(`${base()}/big`, { ...opts, maxBytes: 100_000 })).rejects.toThrow(
      /too large/,
    );
    await expect(guardedFetch(`${base()}/slow`, { ...opts, timeoutMs: 100 })).rejects.toThrow(
      /fetch failed/,
    );
    await expect(guardedFetch(`${base()}/missing`, opts)).rejects.toThrow(/HTTP 404/);
  });
});

describe("extractArticle (fixture)", () => {
  const art = extractArticle(FIXTURE, PAGE_URL);

  test("metadata: title, canonical, description, byline, published", () => {
    expect(art.title).toBe("Test Article");
    expect(art.canonicalUrl).toBe("https://example.com/articles/test-article");
    expect(art.description).toBe("A fixture article about knowledge graphs and note-taking.");
    expect(art.byline).toContain("Ada Fixture");
    expect(art.published).toBe("2026-01-15T10:00:00Z");
  });

  test("markdown keeps the article, drops the chrome, absolutizes links", () => {
    expect(art.markdown).toContain("write-only memory");
    expect(art.markdown).toContain("```");
    expect(art.markdown).toContain("(https://example.com/articles/related)");
    expect(art.markdown).not.toContain("Subscribe now");
    expect(art.markdown).not.toContain("premium note templates");
  });
});

describe("clipUrl pipeline (injected fetcher)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-clip-"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));
  const refFile = async (name: string) =>
    readFile(join(root, "references", name), "utf8");

  test("first clip writes a conformant reference with citation + inbox tag", async () => {
    const r = await clipUrl(
      root,
      { url: PAGE_URL, quote: "Reasons are the user experience." },
      { fetcher: fake(FIXTURE, PAGE_URL) },
    );
    expect(r).toMatchObject({
      id: "references/test-article",
      created: true,
      deduped: false,
      appended: true,
      truncated: false,
    });
    const doc = await refFile("test-article.md");
    expect(doc).toContain("type: reference");
    expect(doc).toContain("resource: https://example.com/articles/test-article");
    expect(doc).toContain("A clipper that produces a well-formed note");
    expect(doc).toMatch(/tags:\n +- inbox/);
    expect(doc).toContain("generated:\n  by: okb/"); // the tool produced the content
    // OKF v0.2 provenance: the page itself, with byline + publication date as signals.
    expect(parse(doc).frontmatter.sources).toEqual([
      {
        id: "example-com",
        resource: "https://example.com/articles/test-article",
        title: "Test Article",
        author: "Ada Fixture",
        last_modified: "2026-01-15T10:00:00Z",
      },
    ]);
    expect(doc).not.toContain("# Citations");
    expect(doc).not.toContain("published:");
    expect(doc).toContain('"Reasons are the user experience."');
    expect((await okb(["doctor", "--bundle", root])).code).toBe(0);
  });

  test("re-clip of a tracking-param variant appends a highlight, no fetch, no new file", async () => {
    const fetcher = fake(FIXTURE, PAGE_URL);
    const r = await clipUrl(
      root,
      {
        url: "https://example.com/articles/test-article?utm_campaign=later",
        note: "second visit",
      },
      { fetcher },
    );
    expect(r).toMatchObject({ id: "references/test-article", deduped: true, appended: true });
    expect(fetcher.calls).toBe(0); // known URL → offline-friendly append
    const doc = await refFile("test-article.md");
    expect(doc).toContain("second visit");
    expect((await readdir(join(root, "references"))).filter((f) => f !== "index.md")).toEqual([
      "test-article.md",
    ]);
  });

  test("same slug, different URL gets a numeric suffix; description falls back", async () => {
    const minimal = `<html><head><title>Test Article</title><link rel="canonical" href="https://other.org/different"></head><body></body></html>`;
    const r = await clipUrl(
      root,
      { url: "https://other.org/different" },
      { fetcher: fake(minimal, "https://other.org/different") },
    );
    expect(r.id).toBe("references/test-article-2");
    expect(await refFile("test-article-2.md")).toContain("description: Clipped from other.org");
  });

  test("--read skips the inbox tag; user tags survive", async () => {
    const page = `<html><head><title>Read Elsewhere</title><link rel="canonical" href="https://example.com/read"></head><body><p>Done already.</p></body></html>`;
    await clipUrl(
      root,
      { url: "https://example.com/read", read: true, tags: ["web"] },
      { fetcher: fake(page, "https://example.com/read") },
    );
    const doc = await refFile("read-elsewhere.md");
    expect(doc).not.toContain("inbox");
    expect(doc).toMatch(/tags:\n +- web/);
  });

  test("bodies beyond the cap are truncated with a visible note", async () => {
    const big = `<html><head><title>Big Page</title></head><body><article><h1>Big Page</h1>${"<p>All work and no play makes the clipper a dull tool for very long articles indeed.</p>".repeat(3000)}</article></body></html>`;
    const r = await clipUrl(
      root,
      { url: "https://example.com/big" },
      { fetcher: fake(big, "https://example.com/big") },
    );
    expect(r.truncated).toBe(true);
    const doc = await refFile("big-page.md");
    expect(doc).toContain("(truncated by okb clip");
    expect(Buffer.byteLength(doc, "utf8")).toBeLessThan(102_400);
  });
});

describe("okb clip / inbox (CLI)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-inbox-"));
    await clipUrl(root, { url: PAGE_URL }, { fetcher: fake(FIXTURE, PAGE_URL) });
    const other = `<html><head><title>Already Read</title><link rel="canonical" href="https://example.com/read"></head><body><p>Done.</p></body></html>`;
    await clipUrl(
      root,
      { url: "https://example.com/read", read: true },
      { fetcher: fake(other, "https://example.com/read") },
    );
    expect((await okb(["index", "--bundle", root])).code).toBe(0);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("clip refuses guarded targets through the CLI (exit 1, no file)", async () => {
    const r = await okb(["clip", "http://127.0.0.1:1/x", "--bundle", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("private/loopback");
    const bad = await okb(["clip", "file:///etc/passwd", "--bundle", root]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("only http/https");
  });

  test("inbox lists unread only; inbox read clears the tag quietly", async () => {
    const list = await okb(["inbox", "--bundle", root]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("references/test-article — Test Article");
    expect(list.stdout).toContain("1 unread");
    expect(list.stdout).not.toContain("Already Read");

    const before = await readFile(join(root, "references", "test-article.md"), "utf8");
    const logBefore = await readFile(join(root, "log.md"), "utf8");
    const r = await okb(["inbox", "read", "references/test-article", "--bundle", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("marked references/test-article read");

    const after = await readFile(join(root, "references", "test-article.md"), "utf8");
    expect(after).not.toContain("inbox");
    expect(after).toContain(before.match(/generated:\n  by: .*\n  at: .*/)![0]); // untouched
    expect(await readFile(join(root, "log.md"), "utf8")).toBe(logBefore);

    expect((await okb(["inbox", "--bundle", root])).stdout).toContain("(inbox is empty)");
    const again = await okb(["inbox", "read", "references/test-article", "--bundle", root]);
    expect(again.stdout).toContain("was not in the inbox");
    expect((await okb(["inbox", "read", "ghost", "--bundle", root])).code).toBe(1);
  });

  test("clipped concepts are searchable and in the graph after reindex", async () => {
    const hits = await okb(["search", "clipper", "--bundle", root]);
    expect(hits.code).toBe(0);
    expect(hits.stdout).toContain("references/test-article");
  });
});
