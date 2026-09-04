// Concept bodies are untrusted (clip/rss/import/git-synced bundles) and
// markdown permits inline HTML by spec, which marked passes through verbatim.
// Both viewers render bodies into innerHTML — the GUI page also holds the serve
// token — so raw HTML must arrive as escaped source text, never as live markup.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { renderHtml } from "../src/core/viz/export.ts";

const SRC = join(import.meta.dir, "..", "src");

/** Load marked + the sanitizer into an isolated context, as a browser would. */
function loadRenderer(): (md: string) => string {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const ctx = createContext(sandbox);
  for (const file of [
    join(SRC, "core", "viz", "vendor", "marked.umd.js"),
    join(SRC, "core", "viz", "safe-markdown.js"),
  ])
    runInContext(readFileSync(file, "utf8"), ctx);
  return sandbox.okbMarkdown as (md: string) => string;
}

const render = loadRenderer();

describe("okbMarkdown: raw HTML is inert", () => {
  test("event-handler markup renders as text, not markup", () => {
    // The clip path produces exactly this: a page showing `&lt;img …&gt;` as
    // visible text round-trips through turndown into raw markdown HTML.
    const out = render('hi\n\n<img src=x onerror="steal()">\n');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=&quot;steal()&quot;&gt;");
  });

  test("inline HTML and script tags are escaped", () => {
    const out = render("a <b onmouseover=e()>bold</b> c\n\n<script>evil()</script>\n");
    expect(out).not.toContain("<b ");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  test("iframe/svg/object markup never survives", () => {
    for (const payload of [
      '<iframe src="https://evil.test"></iframe>',
      '<svg onload="steal()"></svg>',
      '<object data="x"></object>',
      "<style>@import url(//evil.test)</style>",
    ]) {
      const out = render(payload + "\n");
      expect(out).toContain("&lt;");
      expect(out.toLowerCase()).not.toContain("<iframe");
      expect(out.toLowerCase()).not.toContain("<svg");
      expect(out.toLowerCase()).not.toContain("<object");
      expect(out.toLowerCase()).not.toContain("<style");
    }
  });
});

describe("okbMarkdown: URL schemes", () => {
  test("script-bearing schemes lose the link but keep the label", () => {
    for (const href of [
      "javascript:steal()",
      "JaVaScRiPt:steal()",
      "  javascript:steal()",
      "data:text/html,<script>evil()</script>",
      "vbscript:evil()",
    ]) {
      const out = render(`[click](${href.replace(/[()]/g, "\\$&")})`);
      expect(out).toContain("click");
      expect(out).not.toContain("href=");
    }
  });

  test("an entity-encoded scheme cannot be reassembled by the browser", () => {
    // `&#106;avascript:` has no scheme until the browser decodes it — escaping
    // the ampersand is what keeps it from ever becoming one.
    const out = render("[click](&#106;avascript:alert1)");
    expect(out).not.toContain("&#106;avascript:");
    expect(out).toContain("&amp;#106;avascript:");
  });

  test("images with an unsafe src degrade to their alt text", () => {
    const out = render("![alt text](javascript:steal\\(\\))");
    expect(out).not.toContain("<img");
    expect(out).toContain("alt text");
  });

  test("ordinary links, images and in-viewer anchors still render", () => {
    expect(render("[x](https://example.test/a)")).toContain('href="https://example.test/a"');
    expect(render("[x](mailto:a@b.test)")).toContain('href="mailto:a@b.test"');
    expect(render("[x](notes/other.md)")).toContain('href="notes/other.md"');
    expect(render("[x](#concept:notes%2Fother)")).toContain('href="#concept:notes%2Fother"');
    expect(render("![pic](https://example.test/p.png)")).toContain('src="https://example.test/p.png"');
  });
});

describe("okbMarkdown: markdown itself is unaffected", () => {
  test("headings, emphasis, lists, code and tables render", () => {
    const out = render("# H\n\n**b** _i_\n\n- one\n- two\n\n```js\nvar x = 1;\n```\n");
    expect(out).toContain("<h1>H</h1>");
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<code");
  });
});

describe("viz.html export wiring", () => {
  const html = renderHtml({
    nodes: [
      {
        id: "notes/evil",
        type: "note",
        title: "Clipped",
        description: "d",
        tags: [],
        resource: "",
        bodyLen: 10,
        body: '<img src=x onerror="steal()">',
        status: "stable",
        trust: "unverified",
        stale: false,
        staleAfter: null,
        generated: null,
        verified: [],
        sources: [],
      },
    ],
    edges: [],
  });

  test("the export ships the sanitizer and renders bodies through it", () => {
    expect(html).toContain("okbMarkdown");
    expect(html).not.toContain("marked.parse(n.body)");
  });

  test("payloads in the data block cannot close the script element", () => {
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).toContain("\\u003cimg src=x onerror=");
  });
});
