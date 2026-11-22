// Static graph viewer export (Stage 0.7). Walks the bundle directly (no index
// required), builds graph JSON, and writes one self-contained OKF-style HTML
// file: Cytoscape.js graph + marked body rendering (through safe-markdown.js:
// raw HTML escaped, unsafe URL schemes dropped), the shared render.js, and the
// design system's tokens.css + okb.js, all inlined, so viz.html needs no
// backend or network and can be committed
// next to the bundle. Internal `.md` links in bodies are rewired to
// `#concept:<id>` anchors the viewer intercepts to focus the target node; the
// OKF v0.2 signals (status, trust tier, staleness, provenance) show as badges.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildEdges, resolveLinkTarget, rewriteBodyLinks, type Edge } from "../graph/links.ts";
import { listConcepts, readConceptPermissive } from "../okf/bundle.ts";
import {
  fmGenerated,
  fmSources,
  fmStatus,
  fmString,
  fmTags,
  isIsoInstant,
  isStale,
  normalizeVerified,
  trustTier,
  type ActorEvent,
  type SourceEntry,
  type Status,
  type TrustTier,
} from "../okf/document.ts";
import { isPrivateConcept } from "../okf/privacy.ts";
import { embeddedFontCss } from "./fonts.ts";
import graphViewJs from "./graph-view.js" with { type: "text" };
import okbJs from "./okb.js" with { type: "text" };
import renderJs from "./render.js" with { type: "text" };
import safeMarkdownJs from "./safe-markdown.js" with { type: "text" };
import tokensCss from "./tokens.css" with { type: "text" };
import cytoscapeJs from "./vendor/cytoscape.min.js" with { type: "text" };
import markedJs from "./vendor/marked.umd.js" with { type: "text" };

export interface VizNode {
  id: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  resource: string;
  bodyLen: number;
  /** Markdown body with internal links rewired for in-viewer navigation. */
  body: string;
  status: Status;
  trust: TrustTier;
  stale: boolean;
  staleAfter: string | null;
  generated: ActorEvent | null;
  verified: ActorEvent[];
  sources: SourceEntry[];
}

export interface VizGraph {
  nodes: VizNode[];
  edges: Edge[];
}

/**
 * Rewrite links that resolve to a known concept as `#concept:<encoded-id>`
 * anchors; external, broken, and non-`.md` links are left untouched. Pure.
 */
export function rewireLinks(srcId: string, body: string, known: Set<string>): string {
  return rewriteBodyLinks(body, (match, target) => {
    const id = resolveLinkTarget(srcId, target);
    return id !== null && known.has(id)
      ? `](#concept:${encodeURIComponent(id)})`
      : match;
  });
}

export async function buildVizGraph(root: string, { includePrivate = true } = {}): Promise<VizGraph> {
  const ids = await listConcepts(root);
  const known = new Set<string>();
  const nodes: VizNode[] = [];
  const docs: { id: string; body: string; frontmatter: Record<string, unknown> }[] = [];
  for (const id of ids) {
    const { doc } = await readConceptPermissive(root, id);
    if (!includePrivate && isPrivateConcept(id, doc.frontmatter)) continue;
    known.add(id);
    docs.push({ id, body: doc.body, frontmatter: doc.frontmatter });
    const fm = doc.frontmatter;
    nodes.push({
      id,
      type: fmString(fm.type),
      title: fmString(fm.title),
      description: fmString(fm.description),
      tags: fmTags(fm.tags),
      resource: fmString(fm.resource),
      bodyLen: doc.body.length,
      body: doc.body,
      status: fmStatus(fm),
      trust: trustTier(fm),
      stale: isStale(fm),
      staleAfter: isIsoInstant(fm.stale_after) ? fm.stale_after : null,
      generated: fmGenerated(fm),
      verified: normalizeVerified(fm),
      sources: fmSources(fm),
    });
  }
  for (const node of nodes) node.body = rewireLinks(node.id, node.body, known);
  return { nodes, edges: buildEdges(docs, known) };
}

export interface VizExport {
  path: string;
  nodes: number;
  edges: number;
}

/** Export the bundle's graph to `<root>/viz.html` (fixed path by design). */
export async function exportViz(root: string, { includePrivate = false, fonts = false } = {}): Promise<VizExport> {
  const graph = await buildVizGraph(root, { includePrivate });
  const path = join(root, "viz.html");
  await writeFile(path, renderHtml(graph, fonts ? await embeddedFontCss() : ""), "utf8");
  return { path, nodes: graph.nodes.length, edges: graph.edges.length };
}

/**
 * Render the single-file page: data + vendored libs + viewer, no network.
 * Look: the design system's tokens (core/viz/tokens.css, inlined) and its
 * Okb helpers (theme restore + ink-flood toggle under `okb-viz-theme`, graph
 * palette), shared with the GUI. The fonts can be embedded for offline use.
 * Types take graph slots in sorted order (the ninth onward shares
 * graph-other), and every node keeps a visible label, so identity is never
 * colour alone.
 */
export function renderHtml(graph: VizGraph, fontCss = ""): string {
  // <-escape so no `</script>` (or any tag) can break out of the block.
  const data = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>okbrain graph — ${graph.nodes.length} concepts</title>
<style>${tokensCss}${fontCss ? `\n${fontCss}` : ""}</style>
<style>
  :root, [data-theme="dark"] { color-scheme: dark; --wght-text: 370; --wght-read: 400; }
  [data-theme="light"] { color-scheme: light; --wght-text: 400; --wght-read: 440; }
  *, *::before, *::after { box-sizing: border-box; }
  * { margin: 0; }
  body { font-family: var(--font-sans); font-size: 14px; line-height: 20px; font-weight: var(--wght-text);
         color: var(--ink); background: var(--surface); height: 100vh; -webkit-font-smoothing: antialiased;
         display: grid; grid-template-columns: 240px minmax(0, 1fr) minmax(var(--detail-width), 27%); }
  ::selection { background: var(--accent); color: var(--accent-ink); }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  a { color: inherit; text-decoration-color: var(--line-strong); text-underline-offset: 0.25em; }
  a:hover { text-decoration-color: currentColor; }
  code { font-family: var(--font-mono); font-size: 12px; line-height: 16px; color: var(--muted); overflow-wrap: anywhere; }
  button, select, input { font: inherit; color: var(--ink); }
  button, select, #search { height: var(--control-h); padding: 0 var(--space-3); background: var(--raised);
    border: 1px solid var(--line-strong); border-radius: var(--radius-sm); }
  button { font-weight: 560; cursor: pointer; }
  button:hover { border-color: var(--ink); font-weight: 680; }
  select:hover, #search:hover { border-color: var(--ink-2); }
  #search::placeholder { color: var(--muted); }
  #side { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4) var(--space-3);
          overflow-y: auto; background: var(--plane); border-right: 1px solid var(--line); }
  #brand { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  #brand h1 { font-size: 17px; line-height: 20px; font-weight: 800; letter-spacing: -0.02em; }
  #brand h1 span { font-weight: 400; letter-spacing: 0; color: var(--muted); }
  .stats { margin-top: calc(-1 * var(--space-2)); font-family: var(--font-mono); font-size: 12px; line-height: 16px; color: var(--muted); }
  #search { width: 100%; }
  .row { display: flex; gap: var(--space-2); }
  #layout { flex: 1; }
  .group { margin-top: var(--space-2); font-size: 11px; line-height: 14px; font-weight: 650; letter-spacing: 0.08em;
           text-transform: uppercase; color: var(--muted); }
  #filters label { display: flex; align-items: center; gap: var(--space-2); padding: 3px 0; cursor: pointer;
                   font-size: 12px; line-height: 16px; color: var(--ink-2); }
  #filters label:hover { color: var(--ink); }
  #filters input { width: 14px; height: 14px; margin: 0; accent-color: var(--ink); }
  #filters .count { margin-left: auto; font-family: var(--font-mono); color: var(--muted); }
  .swatch { width: 8px; height: 8px; border-radius: var(--radius-full); flex: none; }
  #graph { position: relative; min-width: 0; }
  #tip { position: absolute; z-index: 2; display: none; max-width: 260px; pointer-events: none; padding: var(--space-2) var(--space-3);
         background: var(--raised); border-radius: var(--radius-md); box-shadow: var(--shadow); }
  #tip .t { font-family: var(--font-read); font-size: 15px; line-height: 20px; font-weight: 600; }
  #tip .meta { display: flex; align-items: center; gap: var(--space-1); font-size: 12px; line-height: 16px; color: var(--muted); }
  #tip .d { margin-top: var(--space-1); font-family: var(--font-read); font-style: italic; font-size: 14px; line-height: 20px; color: var(--ink-2); }
  #detail { overflow-y: auto; overflow-wrap: break-word; padding: var(--space-5); background: var(--plane); border-left: 1px solid var(--line); }
  #detail .empty { margin-top: 40vh; text-align: center; color: var(--muted); }
  #detail h2 { margin-bottom: var(--space-2); font-family: var(--font-read); font-size: 22px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; }
  #detail h3 { margin: var(--space-6) 0 var(--space-2); font-size: 11px; line-height: 14px; font-weight: 650; letter-spacing: 0.08em;
               text-transform: uppercase; color: var(--muted); }
  #detail .meta { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin: var(--space-2) 0; }
  #detail .desc { margin: var(--space-3) 0; font-family: var(--font-read); font-style: italic; font-size: 15px; line-height: 22px; color: var(--ink-2); }
  #detail > ul, ul.sources { list-style: none; padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
  #detail > ul { font-family: var(--font-read); }
  .chip { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 var(--space-2); font-size: 12px; line-height: 16px;
          color: var(--ink-2); white-space: nowrap; background: var(--chip-bg); border: 1px solid var(--line); border-radius: var(--radius-full); }
  .badge { display: inline-flex; align-items: center; gap: var(--space-1); height: 20px; padding: 0 6px; font-size: 11px; line-height: 14px;
           font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; color: var(--ink-2);
           border: 1px solid var(--line-strong); border-radius: var(--radius-xs); }
  .badge.status-draft { color: var(--warn); border-color: currentColor; }
  .badge.status-deprecated { color: var(--muted); border-color: var(--line); text-decoration: line-through; }
  .badge.trust-unverified { color: var(--muted); border-style: dashed; }
  .badge.trust-machine-confirmed { color: var(--ink); border-color: var(--ink-2); }
  .badge.trust-human-reviewed { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
  .badge.trust-human-reviewed::before { content: "\\2713"; letter-spacing: 0; }
  .badge.stale { color: var(--danger); border-color: currentColor; }
  .badge.fresh { color: var(--muted); border-color: transparent; padding-inline: 0; }
  dl.fm { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: var(--space-2) var(--space-3); margin: var(--space-3) 0;
          font-size: 12px; line-height: 18px; }
  dl.fm dt { color: var(--muted); }
  dl.fm dd { color: var(--ink-2); overflow-wrap: anywhere; }
  .actor { font-family: var(--font-mono); color: var(--ink); }
  .muted { color: var(--muted); }
  #detail .body { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line);
    font-family: var(--font-read); font-size: 14px; line-height: 22px; font-weight: var(--wght-read); }
  #detail .body :is(h1, h2) { margin: var(--space-4) 0 var(--space-2); font-size: 17px; line-height: 24px; font-weight: 600; }
  #detail .body :is(h3, h4) { margin: var(--space-4) 0 var(--space-2); font-size: 15px; line-height: 22px; font-weight: 600;
    letter-spacing: normal; text-transform: none; color: var(--ink); }
  #detail .body :is(p, ul, ol, pre, table, blockquote) { margin: 0 0 var(--space-3); }
  #detail .body :is(ul, ol) { padding-left: 1.4em; }
  #detail .body pre { padding: var(--space-3) var(--space-4); overflow-x: auto; white-space: pre-wrap; font: 13px/20px var(--font-mono);
    background: var(--code-bg); border: 1px solid var(--line); border-radius: var(--radius-md); }
  #detail .body code { padding: 0.15em 0.35em; font-size: 0.8em; line-height: 1; color: var(--ink); background: var(--code-bg); border-radius: var(--radius-xs); }
  #detail .body pre code { padding: 0; font-size: inherit; background: none; }
  #detail .body img { max-width: 100%; }
  #detail .body table { border-collapse: collapse; }
  #detail .body :is(th, td) { padding: var(--space-1) var(--space-3) var(--space-1) 0; text-align: left; border-bottom: 1px solid var(--line); }
  #detail .body blockquote { padding-left: var(--space-4); border-left: 1px solid var(--line-strong); color: var(--ink-2); font-style: italic; }
  #detail .body sup.fn a { padding: 0 0.15em; font-size: 0.75em; text-decoration: none; }
  #detail .body ol.footnotes { margin-top: var(--space-6); padding: var(--space-3) 0 0 1.4em; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-2); }
  #detail .body ol.footnotes code { padding: 0; background: none; color: var(--muted); }
  #detail a.broken { color: var(--muted); text-decoration: line-through; }
  /* Ink flood (Okb.theme): the new theme is revealed through a growing circle. */
  html.flooding::view-transition-old(root), html.flooding::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
</style>
<script>${okbJs}</script>
<script>Okb.theme.key = 'okb-viz-theme'; Okb.theme.restore();</script>
</head>
<body>
<div id="side">
  <div id="brand">
    <h1>okbrain <span>graph</span></h1>
    <button id="theme" title="toggle light/dark"></button>
  </div>
  <div class="stats">${graph.nodes.length} concepts · ${graph.edges.length} links</div>
  <input id="search" type="search" placeholder="Search title / id / tags…  ( / )">
  <div class="group">Layout</div>
  <div class="row">
    <select id="layout">
      <option value="cose" selected>cose</option>
      <option value="concentric">concentric</option>
      <option value="breadthfirst">breadth-first</option>
      <option value="circle">circle</option>
      <option value="grid">grid</option>
    </select>
    <button id="fit" title="fit graph to view">Fit</button>
  </div>
  <div class="group">Types</div>
  <div id="filters"></div>
</div>
<div id="graph"><div id="tip"></div></div>
<div id="detail"><p class="empty">Click a node to see its details.</p></div>
<script id="okb-graph" type="application/json">${data}</script>
<script>${cytoscapeJs}</script>
<script>${markedJs}</script>
<script>${safeMarkdownJs}</script>
<script>${renderJs}</script>
<script>${graphViewJs}</script>
<script>
var graph = window.okbGraphView.mount(JSON.parse(document.getElementById('okb-graph').textContent), {
  canvas: document.getElementById('graph'),
  detail: document.getElementById('detail'),
  filters: document.getElementById('filters'),
  search: document.getElementById('search'),
  layout: document.getElementById('layout'),
  fit: document.getElementById('fit'),
  tip: document.getElementById('tip'),
}, { descriptionClass: 'desc', metadataClass: 'fm', showResource: true });
var searchEl = document.getElementById('search'), themeEl = document.getElementById('theme');
function themeLabel() {
  themeEl.textContent = Okb.theme.get() === 'dark' ? '\\u263C light' : '\\u263E dark';
}
themeLabel();
new MutationObserver(function () { themeLabel(); graph.repaint(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
themeEl.addEventListener('click', function () { Okb.theme.toggle(themeEl); });
document.addEventListener('keydown', function (event) {
  if (event.key === '/' && document.activeElement !== searchEl) {
    event.preventDefault();
    searchEl.focus();
    searchEl.select();
  }
});
</script>
</body>
</html>
`;
}
