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
import { buildEdges, LINK, resolveLinkTarget, type Edge } from "../graph/links.ts";
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
  return body.replace(LINK, (match, target: string) => {
    const id = resolveLinkTarget(srcId, target);
    return id !== null && known.has(id)
      ? `](#concept:${encodeURIComponent(id)})`
      : match;
  });
}

export async function buildVizGraph(root: string): Promise<VizGraph> {
  const ids = await listConcepts(root);
  const known = new Set(ids);
  const nodes: VizNode[] = [];
  const docs: { id: string; body: string; frontmatter: Record<string, unknown> }[] = [];
  for (const id of ids) {
    const { doc } = await readConceptPermissive(root, id);
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
      body: rewireLinks(id, doc.body, known),
      status: fmStatus(fm),
      trust: trustTier(fm),
      stale: isStale(fm),
      staleAfter: isIsoInstant(fm.stale_after) ? fm.stale_after : null,
      generated: fmGenerated(fm),
      verified: normalizeVerified(fm),
      sources: fmSources(fm),
    });
  }
  return { nodes, edges: buildEdges(docs, known) };
}

export interface VizExport {
  path: string;
  nodes: number;
  edges: number;
}

/** Export the bundle's graph to `<root>/viz.html` (fixed path by design). */
export async function exportViz(root: string): Promise<VizExport> {
  const graph = await buildVizGraph(root);
  const path = join(root, "viz.html");
  await writeFile(path, renderHtml(graph), "utf8");
  return { path, nodes: graph.nodes.length, edges: graph.edges.length };
}

/**
 * Render the single-file page: data + vendored libs + viewer, no network.
 * Look: the design system's tokens (core/viz/tokens.css, inlined) and its
 * Okb helpers (theme restore + ink-flood toggle under `okb-viz-theme`, graph
 * palette), shared with the GUI. The web fonts stay out — the families fall
 * back through their stacks — so the file stays the size of its libraries.
 * Types take graph slots in sorted order (the ninth onward shares
 * graph-other), and every node keeps a visible label, so identity is never
 * colour alone.
 */
export function renderHtml(graph: VizGraph): string {
  // <-escape so no `</script>` (or any tag) can break out of the block.
  const data = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>okbrain graph — ${graph.nodes.length} concepts</title>
<style>${tokensCss}</style>
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
<script>
var G = JSON.parse(document.getElementById('okb-graph').textContent);
var R = window.okbRender, esc = R.esc;
function typeName(t) { return t || '(untyped)'; }
function ms(token) { return parseFloat(Okb.token(token)) || 0; }

var byId = {}, citedBy = {}, linksTo = {}, typeCount = {}, types = [];
G.nodes.forEach(function (n) {
  byId[n.id] = n;
  var t = typeName(n.type);
  typeCount[t] = (typeCount[t] || 0) + 1;
  if (types.indexOf(t) < 0) types.push(t);
});
G.edges.forEach(function (e) {
  (citedBy[e.dst] = citedBy[e.dst] || []).push(e.src);
  (linksTo[e.src] = linksTo[e.src] || []).push(e.dst);
});
types.sort();
function slot(t) { var i = types.indexOf(t); return i < 8 ? 'graph-' + (i + 1) : 'graph-other'; }
function swatch(t) { return '<span class="swatch" style="background:var(--' + slot(t) + ')"></span>'; }

// The canvas takes concrete colours: the current theme's, re-read when it flips.
var fill = {}, tok = {};
function readTheme() {
  var p = Okb.graphPalette();
  types.forEach(function (t, i) { fill[t] = i < 8 ? p.slots[i] : p.other; });
  ['ink-2', 'surface', 'danger', 'edge-line', 'accent'].forEach(function (k) { tok[k] = Okb.token(k); });
}
function themed(k) { return function () { return tok[k]; }; }
readTheme();

var cy = cytoscape({
  container: document.getElementById('graph'),
  elements: G.nodes.map(function (n) {
    return { data: { id: n.id, label: n.title || n.id, type: typeName(n.type),
      status: n.status, stale: n.stale,
      size: 16 + 4 * Math.sqrt(Math.min(n.bodyLen, 20000) / 100) } };
  }).concat(G.edges.map(function (e) {
    return { data: { id: JSON.stringify([e.src, e.dst]), source: e.src, target: e.dst } };
  })),
  style: [
    { selector: 'node', style: {
      'background-color': function (ele) { return fill[ele.data('type')]; },
      width: 'data(size)', height: 'data(size)', label: 'data(label)',
      'font-family': Okb.token('font-read'), 'font-size': 9, color: themed('ink-2'),
      'text-outline-color': themed('surface'), 'text-outline-width': 2,
      'text-valign': 'bottom', 'text-margin-y': 4,
      'text-wrap': 'ellipsis', 'text-max-width': '120px' } },
    { selector: 'node[?stale]', style: { 'border-width': 2, 'border-style': 'dashed', 'border-color': themed('danger') } },
    { selector: 'node[status = "deprecated"]', style: { opacity: Number(Okb.token('opacity-deprecated')) } },
    { selector: 'edge', style: {
      width: 1.2, 'line-color': themed('edge-line'), 'target-arrow-color': themed('edge-line'),
      'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier' } },
    { selector: 'node:selected', style: { 'border-width': 2, 'border-style': 'solid', 'border-color': themed('accent') } },
    { selector: '.dim, .faded', style: { opacity: Number(Okb.token('opacity-dim')) } }
  ],
  layout: { name: 'cose', animate: false },
  wheelSensitivity: 0.2
});

var searchEl = document.getElementById('search');
var detailEl = document.getElementById('detail');
var tipEl = document.getElementById('tip');
var themeEl = document.getElementById('theme');

// The label and the canvas follow the attribute, inside the ink flood.
function themeLabel() {
  themeEl.textContent = Okb.theme.get() === 'dark' ? '\\u263C light' : '\\u263E dark';
}
themeLabel();
new MutationObserver(function () { themeLabel(); readTheme(); cy.style().update(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
themeEl.addEventListener('click', function () { Okb.theme.toggle(themeEl); });

var checked = {};
var filtersEl = document.getElementById('filters');
types.forEach(function (t) {
  checked[t] = true;
  var label = document.createElement('label');
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  cb.addEventListener('change', function () { checked[t] = cb.checked; applyFilters(); });
  var count = document.createElement('span');
  count.className = 'count';
  count.textContent = typeCount[t];
  label.appendChild(cb);
  label.insertAdjacentHTML('beforeend', swatch(t));
  label.appendChild(document.createTextNode(t));
  label.appendChild(count);
  filtersEl.appendChild(label);
});

function applyFilters() {
  var q = searchEl.value.trim().toLowerCase();
  cy.batch(function () {
    cy.nodes().forEach(function (node) {
      node.style('display', checked[node.data('type')] ? 'element' : 'none');
    });
    cy.elements().removeClass('dim');
    if (!q) return;
    cy.elements().addClass('dim');
    cy.nodes().forEach(function (node) {
      var n = byId[node.id()];
      var hay = (n.id + ' ' + n.title + ' ' + n.tags.join(' ')).toLowerCase();
      if (hay.indexOf(q) >= 0) {
        node.removeClass('dim');
        node.connectedEdges().removeClass('dim');
      }
    });
  });
}
searchEl.addEventListener('input', applyFilters);
document.addEventListener('keydown', function (e) {
  if (e.key === '/' && document.activeElement !== searchEl) {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
  }
});

document.getElementById('layout').addEventListener('change', function (e) {
  var d = ms('dur-deliberate');
  cy.layout({ name: e.target.value, animate: d > 0 ? 'end' : false, animationDuration: d,
    animationEasing: Okb.token('ease-in-out') }).run();
});
document.getElementById('fit').addEventListener('click', function () {
  cy.fit(undefined, 40);
});

function conceptHref(id) { return '#concept:' + encodeURIComponent(id); }
function typeChip(t) { return '<span class="chip">' + swatch(t) + esc(t) + '</span>'; }
function conceptList(ids) {
  return '<ul>' + ids.map(function (id) {
    return '<li><a href="' + conceptHref(id) + '">' +
      esc((byId[id] && byId[id].title) || id) + '</a></li>';
  }).join('') + '</ul>';
}

function showDetail(id) {
  var n = byId[id];
  if (!n) return;
  var h = '<h2>' + esc(n.title || n.id) + '</h2>' +
    '<div class="meta">' + typeChip(typeName(n.type)) + '<code>' + esc(n.id) + '</code></div>' +
    '<div class="meta">' + R.badges(n) + '</div>';
  if (n.description) h += '<p class="desc">' + esc(n.description) + '</p>';
  if (n.tags.length) h += '<div class="meta">' + n.tags.map(function (t) {
    return '<span class="chip">' + esc(t) + '</span>';
  }).join(' ') + '</div>';
  h += '<dl class="fm">';
  if (n.resource) h += '<dt>Resource</dt><dd><a href="' + esc(n.resource) + '">' + esc(n.resource) + '</a></dd>';
  h += '<dt>Generated</dt><dd>' + R.actorLine(n.generated) + '</dd>';
  h += '<dt>Verified</dt><dd>' + (n.verified.length ? n.verified.map(R.actorLine).join('<br>') : '—') + '</dd>';
  h += '<dt>Sources</dt><dd>' + R.sourcesList(n.sources) + '</dd></dl>';
  h += '<div class="body">' + R.renderMarkdown(n.body) + '</div>';
  var out = linksTo[id] || [], back = citedBy[id] || [];
  if (out.length) h += '<h3>Links to</h3>' + conceptList(out);
  if (back.length) h += '<h3>Cited by</h3>' + conceptList(back);
  detailEl.innerHTML = h;
  R.wireLinks(detailEl, { baseId: id, hrefFor: conceptHref, known: function (x) { return !!byId[x]; } });
}

function focusNode(id) {
  var node = cy.getElementById(id);
  if (node.nonempty()) {
    cy.$(':selected').unselect();
    node.select();
    cy.animate({ center: { eles: node } }, { duration: ms('dur-slow'), easing: Okb.token('ease-in-out') });
  }
  showDetail(id);
}

detailEl.addEventListener('click', function (e) {
  var a = e.target.closest('a[href^="#concept:"]');
  if (!a) return;
  e.preventDefault();
  focusNode(decodeURIComponent(a.getAttribute('href').slice(9)));
});

cy.on('tap', 'node', function (e) { showDetail(e.target.id()); });
// Hover dims everything outside the node's neighbourhood and names the node.
cy.on('mouseover', 'node', function (e) {
  var n = byId[e.target.id()];
  var t = typeName(n.type);
  cy.elements().difference(e.target.closedNeighborhood()).addClass('faded');
  tipEl.innerHTML = '<div class="t">' + esc(n.title || n.id) + '</div>' +
    '<div class="meta">' + swatch(t) + esc(t) + (n.stale ? ' · stale' : '') + (n.status !== 'stable' ? ' · ' + esc(n.status) : '') + '</div>' +
    (n.description ? '<div class="d">' + esc(n.description) + '</div>' : '');
  var p = e.renderedPosition, box = e.cy.container().getBoundingClientRect();
  tipEl.style.left = Math.min(p.x + 14, box.width - 270) + 'px';
  tipEl.style.top = Math.min(p.y + 14, box.height - 90) + 'px';
  tipEl.style.display = 'block';
  e.cy.container().style.cursor = 'pointer';
});
cy.on('mouseout tap', 'node', function (e) {
  cy.elements().removeClass('faded');
  tipEl.style.display = 'none';
  e.cy.container().style.cursor = '';
});
cy.on('pan zoom', function () { tipEl.style.display = 'none'; });
</script>
</body>
</html>
`;
}
