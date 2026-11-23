// The shared viewer renderer (core/viz/render.js): footnote attribution on
// top of the sanitizing markdown renderer, internal-link resolution, and the
// v0.2 badges — loaded into an isolated context the way both surfaces load
// it (marked → safe-markdown → render).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { resolvePathField } from "../src/core/graph/links.ts";

const VIZ = join(import.meta.dir, "..", "src", "core", "viz");

interface Render {
  renderMarkdown(md: string): string;
  resolveInternal(href: string, baseId?: string): string | null;
  badges(s: { status: string; trust: string; stale: boolean; staleAfter?: string | null }): string;
  sourceNoteCandidates(resource: unknown, baseId: string): string[] | null;
  sourcesList(s: unknown[], localUsage?: Record<string, unknown>, opts?: {
    baseId: string;
    known(id: string): boolean;
    hrefFor(id: string): string;
  }): string;
  actorLine(ev: { by?: string; at?: string } | null): string;
}

function load(): Render {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const ctx = createContext(sandbox);
  for (const file of ["vendor/marked.umd.js", "safe-markdown.js", "render.js"])
    runInContext(readFileSync(join(VIZ, file), "utf8"), ctx);
  return sandbox.okbRender as Render;
}

const R = load();

describe("renderMarkdown", () => {
  test("footnotes keyed to sources ids become superscripts + a numbered list", () => {
    const out = R.renderMarkdown("Sharded daily.[^ga4] Again.[^ga4] Other.[^b]\n\n[^ga4]: GA4 *schema*\n[^b]: B\n");
    expect(out).toContain('<sup class="fn"><a href="#fn-ga4" title="GA4 *schema*">1</a></sup>');
    expect(out).toContain('<a href="#fn-b" title="B">2</a>');
    expect(out).toContain('<ol class="footnotes"><li id="fn-ga4"><code>ga4</code> GA4 <em>schema</em></li>');
    expect(out).not.toContain("[^ga4]: GA4"); // definitions lifted out of the body
    expect(out).toContain("Again.<sup");
  });

  test("an undefined footnote reference stays literal text", () => {
    expect(R.renderMarkdown("See.[^nope]\n")).toContain("See.[^nope]");
  });

  test("raw HTML stays inert and unsafe schemes are dropped (safe-markdown underneath)", () => {
    const out = R.renderMarkdown('x\n\n<img src=x onerror="steal()">\n\n[c](javascript:steal\\(\\))\n\n[^i]: <b>bold</b>\n\nref[^i]');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;"); // definitions render through the sanitizer too
  });

  // A reference swapped in inside an attribute value closed that attribute
  // with the superscript's own quotes and left a stray `fn"` attribute behind.
  test("a footnote reference is replaced in running text only, never inside a tag or code", () => {
    const out = R.renderMarkdown([
      "[^a]: First", "[^b]: Second", "",
      'Text[^a] ![alt [^a]](pic.png "title [^b]") [link]([^a] "about [^b]")', "",
      "Inline `[^a]` stays code.", "", "```", "fenced [^b]", "```",
    ].join("\n"));
    expect(out).toContain('Text<sup class="fn"><a href="#fn-a" title="First">1</a></sup>');
    expect(out).toContain('<img src="pic.png" alt="alt [^a]" title="title [^b]">');
    expect(out).toContain('<a href="[^a]" title="about [^b]">link</a>');
    expect(out).toContain("<code>[^a]</code>");
    expect(out).toContain("fenced [^b]");
    expect(out).not.toContain('fn"><a href="#fn-b"'); // b is only ever named inside tags and code
    expect(out.match(/<sup class="fn">/g)).toHaveLength(1);
    expect(out).toContain('<ol class="footnotes"><li id="fn-a"><code>a</code> First</li></ol>');
  });
});

describe("resolveInternal", () => {
  test("anchors, bundle-absolute, relative, and non-concept hrefs", () => {
    expect(R.resolveInternal("#concept:notes%2Fa", "x")).toBe("notes/a");
    expect(R.resolveInternal("/notes/a.md", "refs/r")).toBe("notes/a");
    expect(R.resolveInternal("../notes/a.md#sec", "refs/r")).toBe("notes/a");
    expect(R.resolveInternal("sibling.md", "refs/r")).toBe("refs/sibling");
    expect(R.resolveInternal("../../escape.md", "refs/r")).toBeNull();
    expect(R.resolveInternal("https://x.test/a.md", "refs/r")).toBeNull();
    expect(R.resolveInternal("#frag", "refs/r")).toBeNull();
    expect(R.resolveInternal("pic.png", "refs/r")).toBeNull();
  });
});

describe("badges + sources", () => {
  test("status / trust / stale chips", () => {
    const h = R.badges({ status: "draft", trust: "human-reviewed", stale: true, staleAfter: "2026-01-01T00:00:00Z" });
    expect(h).toContain('class="badge status-draft"');
    expect(h).toContain('class="badge trust-human-reviewed">human reviewed');
    expect(h).toContain("stale since 2026-01-01");
    expect(R.badges({ status: "stable", trust: "unverified", stale: false, staleAfter: "2099-01-01T00:00:00Z" })).toContain("stale after 2099-01-01");
  });

  test("sources list links URLs, shows credibility signals, escapes text", () => {
    const h = R.sourcesList([
      { id: "a", resource: "https://a.test/<x>", title: "A <t>", author: "human:ada", usage_count: 3, last_modified: "2026-06-15T00:00:00Z" },
      { resource: "policies/x.md" },
    ]);
    expect(h).toContain('href="https://a.test/&lt;x&gt;"');
    expect(h).toContain("A &lt;t&gt;");
    expect(h).toContain("human:ada · modified 2026-06-15 · 3 uses");
    expect(h).toContain("<li>policies/x.md</li>");
    expect(R.sourcesList([])).toContain("—");
  });

  test("source note links follow OKF field resolution and retain local usage by original resource", () => {
    const baseId = "metrics/gross-margin";
    const known = new Set(["metrics/policies/local", "policies/local", "policies/root", "policies/quoted & space"]);
    const opts = { baseId, known: (id: string) => known.has(id), hrefFor: (id: string) => `#concept/${encodeURIComponent(id)}` };
    const cases: [string, string][] = [
      ["policies/local.md", "metrics/policies/local"],
      ["policies/root.md#definition", "policies/root"],
      ["/policies/local.md", "policies/local"],
      ["./policies/local.md", "metrics/policies/local"],
      ["../policies/root.md", "policies/root"],
      ["<../policies/quoted & space.md#about>", "policies/quoted & space"],
    ];
    for (const [resource, id] of cases) {
      expect(resolvePathField(baseId, resource, known)).toBe(id);
      expect(R.sourceNoteCandidates(resource, baseId)?.find(opts.known)).toBe(id);
      expect(R.sourcesList([{ resource }], undefined, opts)).toContain(`href="${opts.hrefFor(id)}" class="internal"`);
    }
    const localUsage = { "policies/root.md": { usage_count: 5, usage_window: { from: "2026-06-01", to: "2026-06-30" } } };
    expect(R.sourcesList(["policies/root.md"], localUsage, opts)).toBe(
      '<ul class="sources"><li><a href="#concept/policies%2Froot" class="internal" data-id="policies/root">policies/root.md</a>' +
      ' <span class="muted">(<span title="2026-06-01 to 2026-06-30">5 local uses</span>)</span></li></ul>',
    );
  });

  test("absent notes and non-note resources never become raw server or graph hrefs", () => {
    const baseId = "metrics/gross-margin";
    const opts = { baseId, known: (id: string) => id === "policies/local", hrefFor: (id: string) => `#concept:${encodeURIComponent(id)}` };
    const candidates = ["db_only/filtered.md", "./policies/local.md", "/policies/missing.md"];
    for (const resource of candidates) expect(R.sourceNoteCandidates(resource, baseId)).not.toBeNull();
    const inert = ["scope:notes", "files/chart.pdf", "//example.test/policies/local.md", "../../policies/local.md", "#concept:policies%2Flocal"];
    for (const resource of inert) expect(R.sourceNoteCandidates(resource, baseId)).toBeNull();
    const entries = [...candidates, ...inert].map((resource) => ({ resource, title: "Unavailable <source>" }));
    const h = R.sourcesList([...entries, null, { title: "Missing resource" }], undefined, opts);
    expect(h).not.toContain("href=");
    expect(h).toContain("<li>Unavailable &lt;source&gt;</li>");
    expect(h).not.toContain("Missing resource");
    expect(R.sourcesList([{ resource: "https://example.test/record.md" }], undefined, opts)).toContain(
      'href="https://example.test/record.md" target="_blank" rel="noopener" class="external"',
    );
    expect(R.sourceNoteCandidates("https://example.test/record.md", baseId)).toBeNull();
  });

  test("metadata resource links use the same scheme guard as Markdown links", () => {
    expect(R.sourcesList([{ resource: "java\nscript:alert(1)", title: "Unsafe source" }])).toBe('<ul class="sources"><li>Unsafe source</li></ul>');
    expect(R.resolveInternal("#concept:%GG", "note")).toBeNull();
  });

  test("actor lines set the actor apart (mono) and escape it", () => {
    expect(R.actorLine({ by: "human:<ada>", at: "2026-06-15T00:00:00Z" })).toBe(
      '<span class="actor">human:&lt;ada&gt;</span> <span class="muted">· 2026-06-15T00:00:00Z</span>',
    );
    expect(R.actorLine(null)).toBe("—");
  });
});
