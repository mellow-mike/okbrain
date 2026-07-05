// Static graph viewer export (Stage 0.7). Walks the bundle directly (no index
// required), builds graph JSON, and writes one self-contained OKF-style HTML
// file: Cytoscape.js graph + marked.js body rendering, both vendored and
// inlined, so viz.html needs no backend or network and can be committed next
// to the bundle. Internal `.md` links in bodies are rewired to `#concept:<id>`
// anchors the viewer intercepts to focus the target node.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildEdges, LINK, resolveLinkTarget, type Edge } from "../graph/links.ts";
import { listConcepts, readConceptPermissive } from "../okf/bundle.ts";
import { fmString, fmTags } from "../okf/document.ts";
import cytoscapeJs from "./vendor/cytoscape.min.js" with { type: "text" };
import markedJs from "./vendor/marked.umd.js" with { type: "text" };

export interface VizNode {
  id: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  bodyLen: number;
  /** Markdown body with internal links rewired for in-viewer navigation. */
  body: string;
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
  const docs: { id: string; body: string }[] = [];
  for (const id of ids) {
    const { doc } = await readConceptPermissive(root, id);
    docs.push({ id, body: doc.body });
    const fm = doc.frontmatter;
    nodes.push({
      id,
      type: fmString(fm.type),
      title: fmString(fm.title),
      description: fmString(fm.description),
      tags: fmTags(fm.tags),
      bodyLen: doc.body.length,
      body: rewireLinks(id, doc.body, known),
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

/** Render the single-file page: data + vendored libs + viewer, no network. */
export function renderHtml(graph: VizGraph): string {
  // <-escape so no `</script>` (or any tag) can break out of the block.
  const data = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>okbrain graph — ${graph.nodes.length} concepts</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 13px/1.5 system-ui, sans-serif; color: #24292f; height: 100vh;
         display: grid; grid-template-columns: 220px 1fr minmax(280px, 26%); }
  #side { padding: 12px; border-right: 1px solid #d8dee4; overflow-y: auto; }
  #side h1 { font-size: 15px; margin-bottom: 2px; }
  #side .stats { color: #57606a; margin-bottom: 12px; }
  #search, #layout { width: 100%; padding: 4px 6px; margin-bottom: 12px;
    border: 1px solid #d8dee4; border-radius: 4px; font: inherit; }
  #side .group { font-weight: 600; margin-bottom: 4px; }
  #filters label { display: flex; align-items: center; gap: 6px; padding: 2px 0;
    cursor: pointer; }
  .swatch { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  #graph { min-width: 0; }
  #detail { padding: 14px; border-left: 1px solid #d8dee4; overflow-y: auto; }
  #detail .empty { color: #57606a; }
  #detail h2 { font-size: 16px; margin-bottom: 4px; }
  #detail h3 { font-size: 13px; margin: 14px 0 4px; }
  #detail .meta { display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
    flex-wrap: wrap; }
  #detail .meta code { font-size: 11px; color: #57606a; overflow-wrap: anywhere; }
  .badge { color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; }
  .tag { background: #eef1f4; border-radius: 10px; padding: 1px 8px; font-size: 11px; }
  #detail .desc { color: #57606a; margin-bottom: 8px; }
  #detail .body { border-top: 1px solid #d8dee4; margin-top: 8px; padding-top: 8px; }
  #detail .body h1, #detail .body h2, #detail .body h3 { font-size: 14px; margin: 10px 0 4px; }
  #detail .body p, #detail .body ul, #detail .body ol { margin-bottom: 8px; }
  #detail .body ul, #detail .body ol, #detail ul { padding-left: 20px; }
  #detail .body pre { background: #f6f8fa; padding: 8px; border-radius: 4px;
    overflow-x: auto; margin-bottom: 8px; }
  #detail .body code { font-size: 12px; }
  #detail .body img { max-width: 100%; }
  #detail a { color: #0969da; }
</style>
</head>
<body>
<div id="side">
  <h1>okbrain graph</h1>
  <div class="stats">${graph.nodes.length} concepts · ${graph.edges.length} links</div>
  <input id="search" type="search" placeholder="search title / id / tags">
  <div class="group">Layout</div>
  <select id="layout">
    <option value="cose" selected>cose</option>
    <option value="concentric">concentric</option>
    <option value="breadthfirst">breadth-first</option>
    <option value="circle">circle</option>
    <option value="grid">grid</option>
  </select>
  <div class="group">Types</div>
  <div id="filters"></div>
</div>
<div id="graph"></div>
<div id="detail"><p class="empty">Click a node to see its details.</p></div>
<script id="okb-graph" type="application/json">${data}</script>
<script>${cytoscapeJs}</script>
<script>${markedJs}</script>
<script>
var G = JSON.parse(document.getElementById('okb-graph').textContent);
var PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948',
  '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#86bcb6', '#d37295'];
function typeName(t) { return t || '(untyped)'; }
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

var byId = {}, citedBy = {}, types = [];
G.nodes.forEach(function (n) {
  byId[n.id] = n;
  var t = typeName(n.type);
  if (types.indexOf(t) < 0) types.push(t);
});
G.edges.forEach(function (e) { (citedBy[e.dst] = citedBy[e.dst] || []).push(e.src); });
types.sort();
var colorOf = {};
types.forEach(function (t, i) { colorOf[t] = PALETTE[i % PALETTE.length]; });

var cy = cytoscape({
  container: document.getElementById('graph'),
  elements: G.nodes.map(function (n) {
    return { data: { id: n.id, label: n.title || n.id, type: typeName(n.type),
      color: colorOf[typeName(n.type)],
      size: 16 + 4 * Math.sqrt(Math.min(n.bodyLen, 20000) / 100) } };
  }).concat(G.edges.map(function (e) {
    return { data: { id: JSON.stringify([e.src, e.dst]), source: e.src, target: e.dst } };
  })),
  style: [
    { selector: 'node', style: { 'background-color': 'data(color)',
      width: 'data(size)', height: 'data(size)', label: 'data(label)',
      'font-size': 9, color: '#333', 'text-valign': 'bottom', 'text-margin-y': 4,
      'text-wrap': 'ellipsis', 'text-max-width': '120px' } },
    { selector: 'edge', style: { width: 1.2, 'line-color': '#b9c2cc',
      'target-arrow-color': '#b9c2cc', 'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8, 'curve-style': 'bezier' } },
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#1a73e8' } },
    { selector: '.dim', style: { opacity: 0.15 } }
  ],
  layout: { name: 'cose', animate: false },
  wheelSensitivity: 0.2
});

var searchEl = document.getElementById('search');
var detailEl = document.getElementById('detail');
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
  sw.style.background = colorOf[t];
  label.appendChild(cb);
  label.appendChild(sw);
  label.appendChild(document.createTextNode(t));
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

document.getElementById('layout').addEventListener('change', function (e) {
  cy.layout({ name: e.target.value, animate: false }).run();
});

function conceptHref(id) { return '#concept:' + encodeURIComponent(id); }

function showDetail(id) {
  var n = byId[id];
  if (!n) return;
  var h = '<h2>' + esc(n.title || n.id) + '</h2>' +
    '<div class="meta"><span class="badge" style="background:' +
    colorOf[typeName(n.type)] + '">' + esc(typeName(n.type)) + '</span><code>' +
    esc(n.id) + '</code></div>';
  if (n.description) h += '<p class="desc">' + esc(n.description) + '</p>';
  if (n.tags.length) h += '<div>' + n.tags.map(function (t) {
    return '<span class="tag">' + esc(t) + '</span>';
  }).join(' ') + '</div>';
  h += '<div class="body">' + marked.parse(n.body) + '</div>';
  var back = citedBy[id] || [];
  if (back.length) h += '<h3>Cited by</h3><ul>' + back.map(function (src) {
    return '<li><a href="' + conceptHref(src) + '">' +
      esc((byId[src] && byId[src].title) || src) + '</a></li>';
  }).join('') + '</ul>';
  detailEl.innerHTML = h;
  detailEl.querySelectorAll('a[href]').forEach(function (a) {
    if (a.getAttribute('href').indexOf('#concept:') !== 0) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  });
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
</script>
</body>
</html>
`;
}
