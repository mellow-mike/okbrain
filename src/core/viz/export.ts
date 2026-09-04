// Static graph viewer export (Stage 0.7). Walks the bundle directly (no index
// required), builds graph JSON, and writes one self-contained OKF-style HTML
// file: Cytoscape.js graph + marked/DOMPurify body rendering, all vendored
// and inlined, so viz.html needs no backend or network and can be committed
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
import cytoscapeJs from "./vendor/cytoscape.min.js" with { type: "text" };
import markedJs from "./vendor/marked.umd.js" with { type: "text" };
import purifyJs from "./vendor/purify.min.js" with { type: "text" };
import renderJs from "./render.js" with { type: "text" };

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
 * Theme: dark default, light via toggle (persisted); chrome colors live once as
 * CSS custom properties and the graph reads them back via getComputedStyle.
 * Node colors are per-mode categorical palettes (validated: CVD-safe order,
 * contrast vs each surface); types beyond 8 share the muted overflow color, and
 * every node keeps a visible text label so identity is never color-alone.
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
<style>
  :root {
    color-scheme: dark;
    --plane: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --line: #2c2c2a; --edge-line: #383835; --accent: #3987e5;
    --ok: #199e70; --warn: #c98500; --danger: #e66767;
    --code-bg: #242422; --chip-bg: rgba(255, 255, 255, 0.06);
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --plane: #f9f9f7; --surface: #fcfcfb;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --line: #e1e0d9; --edge-line: #c3c2b7; --accent: #2a78d6;
    --ok: #1baf7a; --warn: #eda100; --danger: #e34948;
    --code-bg: #f0efec; --chip-bg: rgba(11, 11, 11, 0.05);
  }
  * { box-sizing: border-box; margin: 0; }
  body { font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         color: var(--ink); background: var(--surface); height: 100vh;
         display: grid; grid-template-columns: 240px 1fr minmax(300px, 27%); }
  #side { background: var(--plane); padding: 14px; border-right: 1px solid var(--line);
          overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
  #brand { display: flex; align-items: center; justify-content: space-between; }
  #brand h1 { font-size: 15px; letter-spacing: 0.2px; }
  #brand h1 span { color: var(--muted); font-weight: 400; }
  button, select, input { font: inherit; color: var(--ink); background: var(--surface);
    border: 1px solid var(--line); border-radius: 6px; }
  button { cursor: pointer; padding: 3px 9px; }
  button:hover, select:hover { border-color: var(--muted); }
  input:focus-visible, select:focus-visible, button:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 1px; }
  .stats { color: var(--muted); font-size: 12px; margin-top: -8px; }
  #search { width: 100%; padding: 6px 9px; }
  #search::placeholder { color: var(--muted); }
  .row { display: flex; gap: 6px; }
  #layout { flex: 1; padding: 5px 6px; }
  .group { font-size: 11px; font-weight: 600; letter-spacing: 0.5px;
           text-transform: uppercase; color: var(--muted); margin-bottom: -6px; }
  #filters label { display: flex; align-items: center; gap: 7px; padding: 3px 0;
    cursor: pointer; color: var(--ink-2); }
  #filters .count { margin-left: auto; color: var(--muted); font-size: 11px; }
  #filters input { accent-color: var(--accent); }
  .swatch { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  #graph { min-width: 0; position: relative; }
  #tip { position: absolute; z-index: 2; max-width: 260px; pointer-events: none;
    background: var(--plane); border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 10px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); display: none; }
  #tip .t { font-weight: 600; }
  #tip .d { color: var(--ink-2); font-size: 12px; }
  #tip .meta { display: flex; align-items: center; gap: 5px; color: var(--muted);
    font-size: 11px; }
  #detail { background: var(--plane); padding: 16px; border-left: 1px solid var(--line);
            overflow-y: auto; overflow-wrap: break-word; }
  #detail .empty { color: var(--muted); text-align: center; margin-top: 40vh; }
  #detail h2 { font-size: 16px; margin-bottom: 6px; }
  #detail h3 { font-size: 11px; font-weight: 600; letter-spacing: 0.5px;
               text-transform: uppercase; color: var(--muted); margin: 16px 0 4px; }
  #detail .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
    flex-wrap: wrap; }
  #detail .meta code { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
  .chip { display: inline-flex; align-items: center; gap: 5px; color: var(--ink-2);
    background: var(--chip-bg); border: 1px solid var(--line); border-radius: 10px;
    padding: 1px 8px; font-size: 11px; }
  .badge { display: inline-block; border-radius: 10px; padding: 1px 8px; font-size: 11px;
    font-weight: 600; border: 1px solid var(--line); color: var(--ink-2); }
  .badge.status-draft { color: var(--warn); border-color: var(--warn); }
  .badge.status-deprecated { color: var(--muted); text-decoration: line-through; }
  .badge.trust-human-reviewed { color: var(--ok); border-color: var(--ok); }
  .badge.trust-machine-confirmed { color: var(--accent); border-color: var(--accent); }
  .badge.stale { color: var(--danger); border-color: var(--danger); }
  dl.fm { display: grid; grid-template-columns: 80px 1fr; gap: 3px 10px; font-size: 12px;
    margin: 8px 0; }
  dl.fm dt { color: var(--muted); }
  dl.fm dd { color: var(--ink-2); overflow-wrap: anywhere; }
  ul.sources { padding-left: 16px; }
  #detail .desc { color: var(--ink-2); margin-bottom: 8px; }
  #detail .body { border-top: 1px solid var(--line); margin-top: 10px; padding-top: 10px;
    color: var(--ink-2); }
  #detail .body h1, #detail .body h2, #detail .body h3 { font-size: 13px; color: var(--ink);
    letter-spacing: normal; text-transform: none; margin: 12px 0 4px; }
  #detail .body p, #detail .body ul, #detail .body ol { margin-bottom: 8px; }
  #detail .body ul, #detail .body ol, #detail ul { padding-left: 20px; }
  #detail .body pre { background: var(--code-bg); padding: 8px; border-radius: 6px;
    overflow-x: auto; margin-bottom: 8px; }
  #detail .body code { font-size: 12px; background: var(--code-bg); border-radius: 4px;
    padding: 0 3px; }
  #detail .body pre code { padding: 0; }
  #detail .body img { max-width: 100%; }
  #detail .body table { border-collapse: collapse; margin-bottom: 8px; }
  #detail .body th, #detail .body td { border: 1px solid var(--line); padding: 3px 6px; }
  #detail .body blockquote { border-left: 2px solid var(--line); padding-left: 10px;
    color: var(--muted); margin-bottom: 8px; }
  #detail .body sup.fn a { font-size: 10px; }
  #detail .body ol.footnotes { font-size: 12px; color: var(--muted); border-top: 1px solid var(--line);
    padding-top: 6px; margin-top: 10px; }
  #detail a { color: var(--accent); text-decoration: none; }
  #detail a:hover { text-decoration: underline; }
  #detail a.broken { color: var(--muted); text-decoration: line-through; }
  #detail li { margin: 2px 0; }
</style>
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
<script>
try { if (localStorage.getItem('okb-viz-theme') === 'light')
  document.documentElement.setAttribute('data-theme', 'light'); } catch (e) {}
</script>
<script>${cytoscapeJs}</script>
<script>${markedJs}</script>
<script>${purifyJs}</script>
<script>${renderJs}</script>
<script>
var G = JSON.parse(document.getElementById('okb-graph').textContent);
var R = window.okbRender, esc = R.esc;
// Categorical palettes per surface (validated: fixed CVD-safe slot order, never
// cycled); types beyond 8 fold into the muted overflow color.
var PALETTE = {
  dark: ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926'],
  light: ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']
};
var OVERFLOW = '#898781';
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function typeName(t) { return t || '(untyped)'; }

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
var colorOf = {};
function applyPalette() {
  var mode = document.documentElement.getAttribute('data-theme');
  types.forEach(function (t, i) { colorOf[t] = i < 8 ? PALETTE[mode][i] : OVERFLOW; });
}
applyPalette();

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
      'background-color': function (ele) { return colorOf[ele.data('type')]; },
      width: 'data(size)', height: 'data(size)', label: 'data(label)',
      'font-size': 9, color: function () { return cssVar('--ink-2'); },
      'text-outline-color': function () { return cssVar('--surface'); },
      'text-outline-width': 2, 'text-valign': 'bottom', 'text-margin-y': 4,
      'text-wrap': 'ellipsis', 'text-max-width': '120px' } },
    { selector: 'node[?stale]', style: {
      'border-width': 2, 'border-style': 'dashed',
      'border-color': function () { return cssVar('--danger'); } } },
    { selector: 'node[status = "deprecated"]', style: { opacity: 0.45 } },
    { selector: 'edge', style: {
      width: 1.2, 'line-color': function () { return cssVar('--edge-line'); },
      'target-arrow-color': function () { return cssVar('--edge-line'); },
      'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier' } },
    { selector: 'node:selected', style: {
      'border-width': 3, 'border-style': 'solid',
      'border-color': function () { return cssVar('--accent'); } } },
    { selector: '.dim', style: { opacity: 0.15 } }
  ],
  layout: { name: 'cose', animate: false },
  wheelSensitivity: 0.2
});

var searchEl = document.getElementById('search');
var detailEl = document.getElementById('detail');
var tipEl = document.getElementById('tip');
var themeEl = document.getElementById('theme');
var currentId = null;

function setThemeButton() {
  themeEl.textContent =
    document.documentElement.getAttribute('data-theme') === 'dark' ? '\\u263C light' : '\\u263E dark';
}
setThemeButton();
themeEl.addEventListener('click', function () {
  var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('okb-viz-theme', next); } catch (e) {}
  applyPalette();
  setThemeButton();
  cy.style().update();
  document.querySelectorAll('.swatch[data-type]').forEach(function (sw) {
    sw.style.background = colorOf[sw.getAttribute('data-type')];
  });
  if (currentId) showDetail(currentId);
});

var checked = {};
var filtersEl = document.getElementById('filters');
types.forEach(function (t) {
  checked[t] = true;
  var label = document.createElement('label');
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  cb.addEventListener('change', function () { checked[t] = cb.checked; applyFilters(); });
  var sw = document.createElement('span');
  sw.className = 'swatch';
  sw.setAttribute('data-type', t);
  sw.style.background = colorOf[t];
  var count = document.createElement('span');
  count.className = 'count';
  count.textContent = typeCount[t];
  label.appendChild(cb);
  label.appendChild(sw);
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
  cy.layout({ name: e.target.value, animate: false }).run();
});
document.getElementById('fit').addEventListener('click', function () {
  cy.fit(undefined, 40);
});

function conceptHref(id) { return '#concept:' + encodeURIComponent(id); }
function typeChip(t) {
  return '<span class="chip"><span class="swatch" data-type="' + esc(t) +
    '" style="background:' + colorOf[t] + '"></span>' + esc(t) + '</span>';
}
function conceptList(ids) {
  return '<ul>' + ids.map(function (id) {
    return '<li><a href="' + conceptHref(id) + '">' +
      esc((byId[id] && byId[id].title) || id) + '</a></li>';
  }).join('') + '</ul>';
}

function showDetail(id) {
  var n = byId[id];
  if (!n) return;
  currentId = id;
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
    cy.animate({ center: { eles: node } }, { duration: 200 });
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
cy.on('mouseover', 'node', function (e) {
  var n = byId[e.target.id()];
  var t = typeName(n.type);
  tipEl.innerHTML = '<div class="t">' + esc(n.title || n.id) + '</div>' +
    '<div class="meta"><span class="swatch" style="background:' + colorOf[t] +
    '"></span>' + esc(t) + (n.stale ? ' · stale' : '') + (n.status !== 'stable' ? ' · ' + esc(n.status) : '') + '</div>' +
    (n.description ? '<div class="d">' + esc(n.description) + '</div>' : '');
  var p = e.renderedPosition, box = e.cy.container().getBoundingClientRect();
  tipEl.style.left = Math.min(p.x + 14, box.width - 270) + 'px';
  tipEl.style.top = Math.min(p.y + 14, box.height - 90) + 'px';
  tipEl.style.display = 'block';
  e.cy.container().style.cursor = 'pointer';
});
cy.on('mouseout tap', 'node', function (e) {
  tipEl.style.display = 'none';
  e.cy.container().style.cursor = '';
});
cy.on('pan zoom', function () { tipEl.style.display = 'none'; });
</script>
</body>
</html>
`;
}
