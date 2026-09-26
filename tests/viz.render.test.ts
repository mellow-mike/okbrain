// The shared viewer renderer (core/viz/render.js): footnote attribution on
// top of the sanitizing markdown renderer, internal-link resolution, and the
// v0.2 badges — loaded into an isolated context the way both surfaces load
// it (marked → safe-markdown → render).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const VIZ = join(import.meta.dir, "..", "src", "core", "viz");

interface Render {
  renderMarkdown(md: string): string;
  resolveInternal(href: string, baseId?: string): string | null;
  badges(s: { status: string; trust: string; stale: boolean; staleAfter?: string | null }): string;
  sourcesList(s: unknown[]): string;
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
    expect(h).toContain('<a href="policies/x.md">policies/x.md</a>');
    expect(R.sourcesList([])).toContain("—");
  });

  test("actor lines set the actor apart (mono) and escape it", () => {
    expect(R.actorLine({ by: "human:<ada>", at: "2026-06-15T00:00:00Z" })).toBe(
      '<span class="actor">human:&lt;ada&gt;</span> <span class="muted">· 2026-06-15T00:00:00Z</span>',
    );
    expect(R.actorLine(null)).toBe("—");
  });
});
