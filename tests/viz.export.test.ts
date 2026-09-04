import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import {
  buildVizGraph,
  renderHtml,
  rewireLinks,
  type VizGraph,
} from "../src/core/viz/export.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-viz-"));
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(
    join(root, "alpha.md"),
    "---\ntype: note\ntitle: Alpha\ntags: [a, b]\n---\n" +
      "See [beta](notes/beta.md) and [beta again](/notes/beta.md), " +
      "[gone](missing.md), [ext](https://x.test/y.md).\n",
  );
  await writeFile(
    join(root, "notes", "beta.md"),
    "---\ntype: idea\ntitle: Beta\n---\nBack to [alpha](../alpha.md).\n",
  );
  await writeFile(join(root, "notes", "gamma.md"), "no frontmatter, plain text\n");
  await writeFile(join(root, "index.md"), "---\ntype: navigation\n---\n"); // reserved
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("rewireLinks", () => {
  const known = new Set(["alpha", "notes/beta", "sp ace"]);

  test("relative and bundle-absolute internal links become #concept anchors", () => {
    expect(rewireLinks("alpha", "[b](notes/beta.md)", known)).toBe(
      "[b](#concept:notes%2Fbeta)",
    );
    expect(rewireLinks("notes/beta", "[a](/alpha.md) [a](../alpha.md)", known)).toBe(
      "[a](#concept:alpha) [a](#concept:alpha)",
    );
  });

  test("ids are URI-encoded so anchors survive markdown parsing", () => {
    expect(rewireLinks("alpha", "[s](<sp ace.md>)", known)).toBe(
      "[s](#concept:sp%20ace)",
    );
  });

  test("external, broken, and non-md links are untouched", () => {
    const body = "[x](https://x.test/y.md) [gone](missing.md) [img](pic.png)";
    expect(rewireLinks("alpha", body, known)).toBe(body);
  });
});

describe("buildVizGraph", () => {
  test("node and edge counts; reserved files excluded; broken links dropped", async () => {
    const g = await buildVizGraph(root);
    expect(g.nodes.map((n) => n.id)).toEqual(["alpha", "notes/beta", "notes/gamma"]);
    expect(g.edges.sort((a, b) => a.src.localeCompare(b.src))).toEqual([
      { src: "alpha", dst: "notes/beta" },
      { src: "notes/beta", dst: "alpha" },
    ]);
  });

  test("node metadata and rewired bodies", async () => {
    const g = await buildVizGraph(root);
    const alpha = g.nodes.find((n) => n.id === "alpha")!;
    expect(alpha).toMatchObject({ type: "note", title: "Alpha", tags: ["a", "b"], status: "stable", trust: "unverified", stale: false });
    expect(alpha.body).toContain("[beta](#concept:notes%2Fbeta)");
    expect(alpha.body).toContain("[gone](missing.md)"); // broken: untouched
    expect(alpha.bodyLen).toBeGreaterThan(0);
    // unparseable frontmatter still yields a node (permissive read)
    expect(g.nodes.find((n) => n.id === "notes/gamma")).toMatchObject({
      type: "",
      title: "",
    });
  });
});

describe("renderHtml", () => {
  const graph: VizGraph = {
    nodes: [
      {
        id: "evil",
        type: "note",
        title: "Evil",
        description: "",
        tags: [],
        resource: "",
        bodyLen: 20,
        body: "</script><b>bad</b>",
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
  };

  test("embeds data, vendored libs, and viewer; data cannot break out", () => {
    const html = renderHtml(graph);
    expect(html).toContain('<script id="okb-graph" type="application/json">');
    expect(html).toContain("The Cytoscape Consortium"); // cytoscape inlined
    expect(html).toContain("a markdown parser"); // marked inlined
    expect(html).toContain("DOMPurify"); // sanitizer inlined: bodies never run script
    expect(html).toContain("okbRender"); // shared viewer helpers inlined
    expect(html).not.toContain("</script><b>"); // < escaped in data
    const json = /<script id="okb-graph"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect((JSON.parse(json) as VizGraph).nodes[0]!.body).toBe("</script><b>bad</b>");
    // self-contained: the document shell references no external resources
    expect(html.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(/\bsrc=|href=/);
  });
});

describe("okb export-viz", () => {
  test("writes <bundle>/viz.html and reports counts", async () => {
    let stdout = "";
    const code = await runCli(["export-viz", "--bundle", root], {
      out: (t) => void (stdout += t),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(stdout).toContain("3 concepts, 2 links");
    const out = join(root, "viz.html");
    expect(existsSync(out)).toBe(true);
    expect(await readFile(out, "utf8")).toContain("okbrain graph");
  });
});
