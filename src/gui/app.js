// okbrain GUI (3.2): a vanilla single-page app over the local API. No build
// step, no framework — served as-is by api.ts and embedded into the compiled
// binary via Bun text imports. Every data access goes through /api/op/* (the
// ops contract); this file is presentation only.

'use strict';

var TOKEN = window.OKB_TOKEN;
var view = document.getElementById('view');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

async function api(op, params) {
  var res = await fetch('/api/op/' + op, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-okb-token': TOKEN },
    body: JSON.stringify(params || {}),
  });
  var body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body.result;
}

function errorBox(e) {
  return '<div class="error">' + esc(e && e.message ? e.message : e) + '</div>';
}

function tile(label, value) {
  return '<div class="tile"><div class="num">' + esc(value) + '</div>' +
    '<div class="lbl">' + esc(label) + '</div></div>';
}

// ---- theme --------------------------------------------------------------

var themeBtn = document.getElementById('theme');
function setTheme(mode, persist) {
  document.documentElement.setAttribute('data-theme', mode);
  themeBtn.textContent = mode === 'dark' ? '☼ light' : '☾ dark';
  if (persist) try { localStorage.setItem('okb-gui-theme', mode); } catch (e) {}
}
try { setTheme(localStorage.getItem('okb-gui-theme') || 'dark', false); }
catch (e) { setTheme('dark', false); }
themeBtn.addEventListener('click', function () {
  var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  setTheme(next, true);
  route(); // views with canvas colors (graph) re-read the tokens
});

// ---- router -------------------------------------------------------------

var routes = {
  graph: renderGraph, search: renderSearch, ask: renderAsk, add: renderAdd,
  review: renderReview, inbox: renderInbox, claims: renderClaims,
  stats: renderStats, editor: renderEditor, settings: renderSettings,
};

var DIR_MARK = { out: '→', in: '←', both: '↔' };

function route() {
  var h = location.hash.slice(1) || 'graph';
  var slash = h.indexOf('/');
  var name = slash < 0 ? h : h.slice(0, slash);
  var arg = slash < 0 ? null : decodeURIComponent(h.slice(slash + 1));
  var fn = routes[name] || renderGraph;
  document.querySelectorAll('#nav a').forEach(function (a) {
    a.classList.toggle('active', a.getAttribute('href') === '#' + name);
  });
  view.className = name === 'graph' ? 'bare' : '';
  fn(arg);
}
window.addEventListener('hashchange', route);

function editorHref(id) { return '#editor/' + encodeURIComponent(id); }
function graphHref(id) { return '#graph/' + encodeURIComponent(id); }

// ---- graph view ---------------------------------------------------------

// Same validated categorical palettes as the static viewer (fixed CVD-safe
// slot order; types beyond 8 fold into the muted overflow color).
var PALETTE = {
  dark: ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926'],
  light: ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'],
};
var OVERFLOW = '#898781';

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function renderGraph(focusId) {
  view.innerHTML =
    '<div id="gwrap"><div id="gmain">' +
    '<div id="gbar"><input id="gsearch" type="search" placeholder="Filter title / id / tags…">' +
    '<button id="gfit">Fit</button></div><div id="gcy"></div></div>' +
    '<div id="gdetail"><p class="empty">Click a node.</p></div></div>';
  var g;
  try { g = await api('graph_data', {}); }
  catch (e) { view.className = ''; view.innerHTML = errorBox(e); return; }

  var byId = {}, linksTo = {}, citedBy = {}, types = [];
  g.nodes.forEach(function (n) {
    byId[n.id] = n;
    var t = n.type || '(untyped)';
    if (types.indexOf(t) < 0) types.push(t);
  });
  g.edges.forEach(function (e) {
    (linksTo[e.src] = linksTo[e.src] || []).push(e.dst);
    (citedBy[e.dst] = citedBy[e.dst] || []).push(e.src);
  });
  types.sort();
  var mode = document.documentElement.getAttribute('data-theme');
  var colorOf = {};
  types.forEach(function (t, i) { colorOf[t] = i < 8 ? PALETTE[mode][i] : OVERFLOW; });

  var cy = cytoscape({
    container: document.getElementById('gcy'),
    elements: g.nodes.map(function (n) {
      return { data: { id: n.id, label: n.title || n.id, type: n.type || '(untyped)',
        size: 16 + 4 * Math.sqrt(Math.min(n.bodyLen, 20000) / 100) } };
    }).concat(g.edges.map(function (e) {
      return { data: { id: JSON.stringify([e.src, e.dst]), source: e.src, target: e.dst } };
    })),
    style: [
      { selector: 'node', style: {
        'background-color': function (ele) { return colorOf[ele.data('type')]; },
        width: 'data(size)', height: 'data(size)', label: 'data(label)',
        'font-size': 9, color: cssVar('--ink-2'),
        'text-outline-color': cssVar('--surface'), 'text-outline-width': 2,
        'text-valign': 'bottom', 'text-margin-y': 4,
        'text-wrap': 'ellipsis', 'text-max-width': '120px' } },
      { selector: 'edge', style: {
        width: 1.2, 'line-color': cssVar('--edge-line'),
        'target-arrow-color': cssVar('--edge-line'),
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier' } },
      { selector: 'node:selected', style: {
        'border-width': 3, 'border-color': cssVar('--accent') } },
      { selector: '.dim', style: { opacity: 0.15 } },
    ],
    layout: { name: 'cose', animate: false },
    wheelSensitivity: 0.2,
  });
  window.cy = cy; // console/driver access, like the static viewer

  var detail = document.getElementById('gdetail');
  function conceptList(ids) {
    return '<ul>' + ids.map(function (id) {
      return '<li><a href="#focus" data-id="' + esc(id) + '">' +
        esc((byId[id] && byId[id].title) || id) + '</a></li>';
    }).join('') + '</ul>';
  }
  function showDetail(id) {
    var n = byId[id];
    if (!n) return;
    var h = '<h2>' + esc(n.title || n.id) + '</h2>' +
      '<div class="meta"><span class="chip"><span class="swatch" style="background:' +
      colorOf[n.type || '(untyped)'] + '"></span>' + esc(n.type || '(untyped)') +
      '</span><code>' + esc(n.id) + '</code></div>' +
      '<div class="row"><a href="' + editorHref(id) + '"><button>Edit</button></a></div>';
    if (n.description) h += '<p class="why">' + esc(n.description) + '</p>';
    if (n.tags.length) h += '<div class="meta">' + n.tags.map(function (t) {
      return '<span class="chip">' + esc(t) + '</span>';
    }).join(' ') + '</div>';
    h += '<div class="body md">' + marked.parse(n.body) + '</div>';
    var out = linksTo[id] || [], back = citedBy[id] || [];
    if (out.length) h += '<h3>Links to</h3>' + conceptList(out);
    if (back.length) h += '<h3>Cited by</h3>' + conceptList(back);
    detail.innerHTML = h;
    detail.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href');
      if (href.indexOf('#concept:') === 0) {
        a.setAttribute('data-id', decodeURIComponent(href.slice(9)));
        a.setAttribute('href', '#focus');
      } else if (href.indexOf('http') === 0) {
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
  detail.addEventListener('click', function (e) {
    var a = e.target.closest('a[href="#focus"]');
    if (!a) return;
    e.preventDefault();
    focusNode(a.getAttribute('data-id'));
  });
  cy.on('tap', 'node', function (e) { showDetail(e.target.id()); });

  var search = document.getElementById('gsearch');
  search.addEventListener('input', function () {
    var q = search.value.trim().toLowerCase();
    cy.batch(function () {
      cy.elements().removeClass('dim');
      if (!q) return;
      cy.elements().addClass('dim');
      cy.nodes().forEach(function (node) {
        var n = byId[node.id()];
        if ((n.id + ' ' + n.title + ' ' + n.tags.join(' ')).toLowerCase().indexOf(q) >= 0) {
          node.removeClass('dim');
          node.connectedEdges().removeClass('dim');
        }
      });
    });
  });
  document.getElementById('gfit').addEventListener('click', function () {
    cy.fit(undefined, 40);
  });
  if (focusId) focusNode(focusId);
}

// ---- search view --------------------------------------------------------

// Hybrid search (keyword + vector recall, graph expansion) via the `search`
// op — distinct from the graph view's client-side title filter.
function renderSearch(initialQ) {
  view.innerHTML =
    '<div class="stack"><h2>Search</h2>' +
    '<form id="sf" class="row">' +
    '<input id="sq" style="flex:1" placeholder="keyword + vector search…" autofocus>' +
    '<select id="sp"><option value="">balanced</option><option>lean</option><option>max</option></select>' +
    '<button class="primary">Search</button></form>' +
    '<div id="sout" class="stack"></div></div>';
  var out = document.getElementById('sout');
  var qEl = document.getElementById('sq');
  document.getElementById('sf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var q = qEl.value.trim();
    if (!q) return;
    out.innerHTML = '<span class="muted">searching…</span>';
    var params = { query: q };
    var p = document.getElementById('sp').value;
    if (p) params.profile = p;
    try {
      var hits = await api('search', params);
      out.innerHTML = hits.length
        ? hits.map(function (h) {
            return '<div class="card"><div class="title">' +
              '<a href="' + editorHref(h.id) + '">' + esc(h.title || h.id) + '</a>' +
              ' <span class="muted">(' + h.score.toFixed(3) + ')</span></div>' +
              '<div class="why"><code>' + esc(h.id) + '</code> · ' +
              h.sources.map(function (s) { return '<span class="chip">' + esc(s) + '</span>'; }).join(' ') +
              '</div>' + (h.description ? '<div class="why">' + esc(h.description) + '</div>' : '') +
              '<div class="row"><a href="' + editorHref(h.id) + '"><button>Open</button></a>' +
              '<a href="' + graphHref(h.id) + '"><button>Graph</button></a></div></div>';
          }).join('')
        : '<div class="notice">No hits.</div>';
    } catch (err) { out.innerHTML = errorBox(err); }
  });
  if (initialQ) { qEl.value = initialQ; qEl.form.requestSubmit(); }
}

// ---- ask view -----------------------------------------------------------

function citationLinks(citations) {
  return citations.map(function (c) {
    return '<span class="chip"><a href="' + graphHref(c.id) + '">graph</a> · <a href="' +
      editorHref(c.id) + '">edit</a> ' + esc(c.title || c.id) + '</span>';
  }).join(' ');
}

function renderAsk() {
  view.innerHTML =
    '<div class="stack"><h2>Ask your brain</h2>' +
    '<form id="askf" class="row">' +
    '<input id="askq" style="flex:1" placeholder="What do my notes say about…" autofocus>' +
    '<select id="askp"><option value="">balanced</option><option>lean</option><option>max</option></select>' +
    '<button class="primary">Ask</button></form>' +
    '<div id="askctx"></div><div id="askout" class="md"></div><div id="asksrc"></div></div>';
  var ctxEl = document.getElementById('askctx');
  var outEl = document.getElementById('askout');
  var srcEl = document.getElementById('asksrc');
  document.getElementById('askf').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = document.getElementById('askq').value.trim();
    if (!q) return;
    ctxEl.innerHTML = '<span class="muted">retrieving…</span>';
    outEl.innerHTML = '';
    srcEl.innerHTML = '';
    var url = '/api/ask/stream?token=' + encodeURIComponent(TOKEN) +
      '&question=' + encodeURIComponent(q);
    var profile = document.getElementById('askp').value;
    if (profile) url += '&profile=' + encodeURIComponent(profile);
    var es = new EventSource(url);
    es.addEventListener('context', function (ev) {
      var ctx = JSON.parse(ev.data);
      ctxEl.innerHTML = ctx.length
        ? '<span class="muted">reading:</span> ' + citationLinks(ctx)
        : '';
    });
    es.addEventListener('answer', function (ev) {
      outEl.innerHTML = marked.parse(JSON.parse(ev.data).answer);
    });
    es.addEventListener('done', function (ev) {
      var r = JSON.parse(ev.data).result;
      if (r.citations.length)
        srcEl.innerHTML = '<h3>Sources</h3>' + citationLinks(r.citations);
      es.close();
    });
    es.addEventListener('error', function (ev) {
      if (ev.data) outEl.innerHTML = errorBox(JSON.parse(ev.data).error);
      else if (!outEl.innerHTML) outEl.innerHTML = errorBox('stream failed');
      es.close();
    });
  });
}

// ---- link suggestions (4.4) ---------------------------------------------

// Shared panel: list suggestions for `id`; `actLabel`/`data-act` decide what
// clicking a row's button does (accept = write via link_accept; insert =
// editor-local, no write).
async function loadSuggestions(el, id, act, actLabel) {
  el.innerHTML = '<span class="muted">suggesting…</span>';
  try {
    var ss = await api('link_suggest', { id: id });
    el.innerHTML = ss.length
      ? ss.map(function (s) {
          return '<div class="row suggestion" data-target="' + esc(s.id) + '">' +
            '<button data-act="' + act + '">' + actLabel + '</button>' +
            '<span>' + esc(s.title || s.id) +
            ' <span class="muted">(' + s.score.toFixed(2) + '; ' + esc(s.reasons.join('; ')) + ')</span></span></div>';
        }).join('')
      : '<span class="muted">no suggestions</span>';
  } catch (e) { el.innerHTML = errorBox(e); }
}

async function acceptSuggestion(btn, conceptId) {
  var target = btn.closest('.suggestion').getAttribute('data-target');
  btn.disabled = true;
  try {
    var r = await api('link_accept', { id: conceptId, target: target });
    btn.textContent = r.added ? 'linked ✓' : 'already linked';
  } catch (e) {
    btn.textContent = 'failed';
    btn.title = e.message;
  }
}

// ---- review view --------------------------------------------------------

async function renderReview() {
  view.innerHTML = '<div class="stack"><h2>Review</h2>' +
    '<label class="row"><input type="checkbox" id="rgarnish"> AI garnish (connects items to recent notes)</label>' +
    '<div id="rlist" class="stack"></div></div>';
  var listEl = document.getElementById('rlist');
  var garnishEl = document.getElementById('rgarnish');
  async function load() {
    listEl.innerHTML = '<span class="muted">scoring…</span>';
    var q;
    try { q = await api('review_queue', garnishEl.checked ? { garnish: true } : {}); }
    catch (e) { listEl.innerHTML = errorBox(e); return; }
    if (!q.length) { listEl.innerHTML = '<div class="notice">Queue is empty — nothing needs review.</div>'; return; }
    listEl.innerHTML = q.map(function (it, i) {
      return '<div class="card" data-id="' + esc(it.id) + '">' +
        '<div class="title">' + (i + 1) + '. ' + esc(it.title || it.id) +
        ' <span class="muted">(' + it.score.toFixed(2) + ')</span></div>' +
        '<div class="why">' + esc(it.reasons.join('; ')) + '</div>' +
        (it.garnish ? '<div class="garnish">↳ ' + esc(it.garnish) + '</div>' : '') +
        '<div class="row"><button data-act="done">Done</button>' +
        '<button data-act="snooze">Snooze 7d</button>' +
        '<button data-act="suggest">Suggest links</button>' +
        '<a href="' + editorHref(it.id) + '"><button>Open</button></a>' +
        '<a href="' + graphHref(it.id) + '"><button>Graph</button></a></div>' +
        '<div class="suggest"></div></div>';
    }).join('');
  }
  listEl.addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var card = btn.closest('.card');
    var id = card.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'suggest') { loadSuggestions(card.querySelector('.suggest'), id, 'accept', 'Link'); return; }
    if (act === 'accept') { acceptSuggestion(btn, id); return; }
    btn.disabled = true;
    try {
      await api(act === 'done' ? 'review_done' : 'review_snooze', { id: id });
      load();
    } catch (err) { listEl.insertAdjacentHTML('afterbegin', errorBox(err)); }
  });
  garnishEl.addEventListener('change', load);
  load();
}

// ---- inbox view ---------------------------------------------------------

async function renderInbox() {
  view.innerHTML = '<div class="stack"><h2>Inbox</h2><div id="ilist" class="stack"></div></div>';
  var listEl = document.getElementById('ilist');
  async function load() {
    var rows;
    try { rows = await api('inbox_list', {}); }
    catch (e) { listEl.innerHTML = errorBox(e); return; }
    if (!rows.length) { listEl.innerHTML = '<div class="notice">Inbox is empty.</div>'; return; }
    listEl.innerHTML = rows.map(function (r) {
      return '<div class="card" data-id="' + esc(r.id) + '">' +
        '<div class="title">' + esc(r.title || r.id) + '</div>' +
        '<div class="why"><code>' + esc(r.id) + '</code></div>' +
        '<div class="row"><a href="' + editorHref(r.id) + '"><button>Open</button></a>' +
        '<button data-act="read">Mark read</button>' +
        '<button data-act="suggest">Suggest links</button>' +
        '<a href="' + graphHref(r.id) + '"><button>Graph</button></a></div>' +
        '<div class="suggest"></div></div>';
    }).join('');
  }
  listEl.addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var card = btn.closest('.card');
    var id = card.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'suggest') { loadSuggestions(card.querySelector('.suggest'), id, 'accept', 'Link'); return; }
    if (act === 'accept') { acceptSuggestion(btn, id); return; }
    btn.disabled = true;
    try { await api('inbox_read', { id: id }); load(); }
    catch (err) { listEl.insertAdjacentHTML('afterbegin', errorBox(err)); }
  });
  load();
}

// ---- add view (capture / clip / rss / import) ---------------------------

// One home for the quick-ingest ops that don't need the full editor: capture a
// note, clip a URL, pull configured feeds, or bulk-import a server-side path.
function renderAdd() {
  view.innerHTML =
    '<div class="stack"><h2>Add to your brain</h2>' +
    '<h3>Quick capture</h3>' +
    '<form id="capf" class="stack">' +
    '<label class="field"><span>Note (first line becomes the title)</span>' +
    '<textarea id="cap-text" rows="4" placeholder="a thought worth keeping…"></textarea></label>' +
    '<div class="row"><input id="cap-tags" placeholder="tags (comma-separated)">' +
    '<button class="primary">Capture</button></div></form><div id="cap-out"></div>' +
    '<h3>Clip a web page</h3>' +
    '<form id="clipf" class="row">' +
    '<input id="clip-url" style="flex:1" placeholder="https://… page to clip">' +
    '<label class="row" style="gap:5px"><input type="checkbox" id="clip-read"> already read</label>' +
    '<button class="primary">Clip</button></form><div id="clip-out"></div>' +
    '<h3>Pull RSS feeds</h3><div class="row">' +
    '<button id="rss-run" class="primary">Pull configured feeds</button>' +
    '<span class="muted">config <code>rss.feeds</code></span></div><div id="rss-out"></div>' +
    '<h3>Import markdown (server-side path)</h3>' +
    '<form id="impf" class="row">' +
    '<input id="imp-path" style="flex:1" placeholder="/path/to/file-or-directory on the okb host">' +
    '<label class="row" style="gap:5px"><input type="checkbox" id="imp-over"> overwrite</label>' +
    '<button class="primary">Import</button></form><div id="imp-out"></div></div>';

  function out(el, p) { document.getElementById(el).innerHTML = p; }
  function busy(el) { out(el, '<span class="muted">working…</span>'); }
  function done(el, id, label) {
    out(el, '<div class="notice">' + esc(label) + ' — <a href="' + editorHref(id) + '">open</a></div>');
  }

  document.getElementById('capf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = document.getElementById('cap-text').value.trim();
    if (!text) return;
    var params = { text: text };
    var tags = document.getElementById('cap-tags').value.trim();
    if (tags) params.tags = tags;
    busy('cap-out');
    try {
      var r = await api('capture', params);
      document.getElementById('cap-text').value = '';
      document.getElementById('cap-tags').value = '';
      done('cap-out', r.id, (r.created ? 'captured ' : 'updated ') + r.id);
    } catch (err) { out('cap-out', errorBox(err)); }
  });

  document.getElementById('clipf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var url = document.getElementById('clip-url').value.trim();
    if (!url) return;
    var params = { url: url };
    if (document.getElementById('clip-read').checked) params.read = true;
    busy('clip-out');
    try {
      var r = await api('clip', params);
      var msg = r.deduped
        ? 'already clipped as ' + r.id + (r.appended ? ' — highlight appended' : '')
        : 'clipped ' + r.id + (r.autoTags && r.autoTags.length ? ' — tagged ' + r.autoTags.join(', ') : '');
      done('clip-out', r.id, msg);
    } catch (err) { out('clip-out', errorBox(err)); }
  });

  document.getElementById('rss-run').addEventListener('click', async function () {
    busy('rss-out');
    try {
      var feeds = await api('rss', {});
      out('rss-out', '<div class="notice">' + esc(feeds.map(function (f) {
        if (f.error) return (f.feed || f.url) + ' — FAILED: ' + f.error;
        return (f.feed || f.url) + ': ' + f.added.length + ' added, ' + f.deduped + ' known';
      }).join('\n')) + '</div>');
    } catch (err) { out('rss-out', errorBox(err)); }
  });

  document.getElementById('impf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var path = document.getElementById('imp-path').value.trim();
    if (!path) return;
    var params = { path: path };
    if (document.getElementById('imp-over').checked) params.overwrite = true;
    busy('imp-out');
    try {
      var r = await api('import', params);
      out('imp-out', '<div class="notice">' + esc(
        r.imported.map(function (id) { return 'imported ' + id; })
          .concat(r.skipped.map(function (s) { return 'skipped ' + s.path + ' — ' + s.reason; }))
          .concat([r.imported.length + ' imported, ' + r.skipped.length + ' skipped']).join('\n')) + '</div>');
    } catch (err) { out('imp-out', errorBox(err)); }
  });
}

// ---- claims view (take / resolve / calibrate) ---------------------------

async function renderClaims() {
  view.innerHTML =
    '<div class="stack"><h2>Claims &amp; calibration</h2>' +
    '<h3>Stake a claim</h3>' +
    '<form id="tf" class="stack"><div class="grid">' +
    '<label class="field"><span>Statement</span>' +
    '<input id="t-statement" placeholder="something you can later judge true or false"></label>' +
    '<label class="field"><span>Confidence %</span>' +
    '<input id="t-confidence" type="number" min="0" max="100" placeholder="0–100"></label>' +
    '</div><div class="grid">' +
    '<label class="field"><span>Resolve by (optional)</span><input id="t-resolve-by" type="date"></label>' +
    '<label class="field"><span>Tags</span><input id="t-tags" placeholder="comma-separated"></label>' +
    '</div><label class="field"><span>Reasoning (optional)</span>' +
    '<textarea id="t-body" rows="3"></textarea></label>' +
    '<div class="row"><button class="primary">Stake claim</button>' +
    '<span id="t-msg" class="muted"></span></div></form>' +
    '<div id="c-out"></div></div>';

  document.getElementById('tf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var statement = document.getElementById('t-statement').value.trim();
    var confidence = document.getElementById('t-confidence').value.trim();
    if (!statement) return;
    if (confidence === '') {
      document.getElementById('t-msg').textContent = 'confidence is required (0–100)';
      return;
    }
    var params = { statement: statement, confidence: parseInt(confidence, 10) };
    ['resolve-by', 'tags', 'body'].forEach(function (n) {
      var v = document.getElementById('t-' + n).value.trim();
      if (v) params[n] = v;
    });
    document.getElementById('t-msg').textContent = 'staking…';
    try {
      var r = await api('take', params);
      document.getElementById('tf').reset();
      document.getElementById('t-msg').textContent = 'staked ' + r.id + ' at ' + r.confidence + '%';
      loadCalibration();
    } catch (err) { document.getElementById('t-msg').textContent = ''; document.getElementById('c-out').innerHTML = errorBox(err); }
  });

  async function loadCalibration() {
    var el = document.getElementById('c-out');
    el.innerHTML = '<span class="muted">scoring…</span>';
    var c;
    try { c = await api('calibrate', {}); }
    catch (e) { el.innerHTML = errorBox(e); return; }
    var total = c.open.length + c.correct + c.incorrect + c.void;
    if (!total) { el.innerHTML = '<div class="notice">No claims yet — stake one above.</div>'; return; }
    var h = '<h3>Score</h3><div class="tiles">' +
      tile('Correct', c.correct) + tile('Incorrect', c.incorrect) + tile('Void', c.void) +
      tile('Brier', c.brier === null ? '—' : c.brier.toFixed(3)) + '</div>';
    if (c.buckets.length) {
      h += '<table class="tbl"><thead><tr><th>confidence</th><th>n</th><th>said</th><th>got</th></tr></thead><tbody>' +
        c.buckets.map(function (b) {
          return '<tr><td>' + esc(b.range) + '</td><td>' + b.n + '</td><td>' + b.meanConfidence + '%</td><td>' + b.hitRate + '%</td></tr>';
        }).join('') + '</tbody></table>';
    }
    if (c.open.length) {
      h += '<h3>Open claims (' + c.open.length + ')</h3>' + c.open.map(function (o) {
        return '<div class="card" data-id="' + esc(o.id) + '">' +
          '<div class="title">' + (o.overdue ? '<span class="chip warn">overdue</span> ' : '') +
          '<a href="' + editorHref(o.id) + '">' + esc(o.title || o.id) + '</a></div>' +
          '<div class="why">' + (o.confidence === null ? '?' : o.confidence + '%') +
          (o.resolveBy ? ' · resolve by ' + esc(o.resolveBy) : '') + '</div>' +
          '<div class="row"><button data-act="correct">Correct</button>' +
          '<button data-act="incorrect">Incorrect</button>' +
          '<button data-act="void">Void</button></div></div>';
      }).join('');
    }
    el.innerHTML = h;
  }

  document.getElementById('c-out').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.closest('.card').getAttribute('data-id');
    btn.closest('.row').querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try { await api('resolve', { id: id, outcome: btn.getAttribute('data-act') }); loadCalibration(); }
    catch (err) { document.getElementById('c-out').insertAdjacentHTML('afterbegin', errorBox(err)); }
  });

  loadCalibration();
}

// ---- stats view (stats / orphans / path) --------------------------------

async function renderStats() {
  view.innerHTML =
    '<div class="stack"><h2>Stats</h2><div id="st-out"><span class="muted">counting…</span></div>' +
    '<h3>Path between two concepts</h3>' +
    '<form id="pf" class="row">' +
    '<input id="p-from" placeholder="from id"><span class="muted">→</span>' +
    '<input id="p-to" placeholder="to id"><button class="primary">Find path</button></form>' +
    '<div id="p-out"></div>' +
    '<h3>Orphans (no links in or out)</h3><div id="or-out"><span class="muted">loading…</span></div></div>';

  try {
    var s = await api('stats', {});
    var h = '<div class="tiles">' +
      tile('Concepts', s.concepts) + tile('Links', s.edges + (s.typedEdges ? ' · ' + s.typedEdges + ' typed' : '')) +
      tile('Tags', s.tags) + tile('Orphans', s.orphans) + tile('Inbox', s.inbox) +
      tile('Never reviewed', s.neverReviewed) + tile('Stale >' + s.staleDays + 'd', s.stale) + '</div>';
    if (s.byType.length) h += '<h3>By type</h3><div class="row">' +
      s.byType.map(function (t) { return '<span class="chip">' + esc(t.type) + ' ' + t.count + '</span>'; }).join(' ') + '</div>';
    if (s.topTags.length) h += '<h3>Top tags</h3><div class="row">' +
      s.topTags.map(function (t) { return '<span class="chip">' + esc(t.tag) + ' ' + t.count + '</span>'; }).join(' ') + '</div>';
    if (s.newest) h += '<p class="muted">freshest ' + esc(s.newest.slice(0, 10)) + ' · oldest ' + esc(s.oldest.slice(0, 10)) + '</p>';
    document.getElementById('st-out').innerHTML = h;
  } catch (e) { document.getElementById('st-out').innerHTML = errorBox(e); }

  document.getElementById('pf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var from = document.getElementById('p-from').value.trim();
    var to = document.getElementById('p-to').value.trim();
    var el = document.getElementById('p-out');
    if (!from || !to) return;
    el.innerHTML = '<span class="muted">searching…</span>';
    try {
      var hops = await api('graph_path', { from: from, to: to });
      if (!hops) { el.innerHTML = '<div class="notice">No path found.</div>'; return; }
      el.innerHTML = '<div class="notice">' + hops.map(function (hp, i) {
        var label = '<a href="' + graphHref(hp.id) + '">' + esc(hp.title || hp.id) + '</a>';
        return i === 0 ? label : ' ' + DIR_MARK[hp.dir] + ' ' + label;
      }).join('') + '</div>';
    } catch (err) { el.innerHTML = errorBox(err); }
  });

  try {
    var os = await api('orphans', {});
    document.getElementById('or-out').innerHTML = os.length
      ? os.map(function (o) {
          return '<div class="row"><a href="' + editorHref(o.id) + '">' + esc(o.title || o.id) + '</a> ' +
            '<a href="' + graphHref(o.id) + '" class="muted">graph</a></div>';
        }).join('')
      : '<div class="notice">No orphans.</div>';
  } catch (e) { document.getElementById('or-out').innerHTML = errorBox(e); }
}

// ---- editor view --------------------------------------------------------

function field(name, label, value, placeholder) {
  return '<label class="field"><span>' + label + '</span><input id="ed-' + name +
    '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '"></label>';
}

async function renderEditor(id) {
  var fm = {}, body = '', exists = false;
  if (id) {
    try {
      var c = await api('read_concept', { id: id });
      fm = c.frontmatter;
      body = c.body;
      exists = true;
    } catch (e) {
      view.innerHTML = errorBox(e);
      return;
    }
  }
  var tags = Array.isArray(fm.tags) ? fm.tags.join(', ') : '';
  view.innerHTML =
    '<div class="stack"><h2>' + (exists ? 'Edit concept' : 'New concept') + '</h2>' +
    '<form id="edf" class="stack">' +
    field('id', 'Id', id, 'notes/my-note') +
    '<div class="grid">' +
    field('type', 'Type', fm.type, 'note') +
    field('title', 'Title', fm.title, '') +
    '</div>' +
    field('description', 'Description', fm.description, 'one line') +
    '<div class="grid">' +
    field('tags', 'Tags (comma-separated)', tags, '') +
    field('resource', 'Resource (URI)', fm.resource, '') +
    '</div>' +
    '<label class="field"><span>Body (markdown; links normalize on save)</span>' +
    '<textarea id="ed-body" rows="16"></textarea></label>' +
    '<div class="row">' +
    '<button class="primary">Save</button>' +
    '<select id="ed-linkpick"><option value="">insert link to…</option></select>' +
    '<button type="button" id="ed-cite">+ Citations</button>' +
    (exists ? '<button type="button" id="ed-suggest">Suggest links</button>' : '') +
    (exists ? '<a href="' + graphHref(id) + '"><button type="button">Open in graph</button></a>' : '') +
    '<span id="ed-msg" class="muted"></span></div>' +
    '</form><div id="ed-sugg"></div><div id="ed-back"></div></div>';
  document.getElementById('ed-body').value = body;
  if (exists) document.getElementById('ed-id').readOnly = true;

  var bodyEl = document.getElementById('ed-body');
  var msgEl = document.getElementById('ed-msg');
  function insertAtCursor(text) {
    var s = bodyEl.selectionStart || 0;
    bodyEl.value = bodyEl.value.slice(0, s) + text + bodyEl.value.slice(bodyEl.selectionEnd || s);
    bodyEl.focus();
    bodyEl.selectionStart = bodyEl.selectionEnd = s + text.length;
  }

  // Concept-id link autocomplete: pick a concept, get a normalized link.
  api('list_concepts', {}).then(function (ids) {
    var pick = document.getElementById('ed-linkpick');
    ids.forEach(function (cid) {
      var o = document.createElement('option');
      o.value = cid;
      o.textContent = cid;
      pick.appendChild(o);
    });
    pick.addEventListener('change', function () {
      if (!pick.value) return;
      insertAtCursor('[' + pick.value.split('/').pop() + '](/' + pick.value + '.md)');
      pick.value = '';
    });
  }).catch(function () {});

  if (exists) {
    var suggEl = document.getElementById('ed-sugg');
    document.getElementById('ed-suggest').addEventListener('click', function () {
      loadSuggestions(suggEl, id, 'insert', 'Insert');
    });
    // Inserting is editor-local: the link lands in the textarea and becomes
    // real (and normalized) only when the user saves.
    suggEl.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act="insert"]');
      if (!btn) return;
      var target = btn.closest('.suggestion').getAttribute('data-target');
      insertAtCursor('[' + target.split('/').pop() + '](/' + target + '.md)');
      btn.textContent = 'inserted ✓';
    });
  }

  document.getElementById('ed-cite').addEventListener('click', function () {
    var url = document.getElementById('ed-resource').value.trim();
    insertAtCursor('\n# Citations\n\n- [' +
      (document.getElementById('ed-title').value || 'Source') + '](' + (url || 'https://…') + ')\n');
  });

  document.getElementById('edf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var val = function (n) { return document.getElementById('ed-' + n).value.trim(); };
    var params = { id: val('id'), body: bodyEl.value, tags: val('tags') };
    ['type', 'title', 'description', 'resource'].forEach(function (n) {
      if (val(n)) params[n] = val(n);
    });
    msgEl.textContent = 'saving…';
    try {
      var r = await api('write_concept', params);
      msgEl.textContent = (r.created ? 'created ' : 'updated ') + r.id;
      if (!exists) location.hash = editorHref(r.id).slice(1);
      else loadBacklinks();
    } catch (err) {
      msgEl.textContent = '';
      view.querySelector('.stack').insertAdjacentHTML('afterbegin', errorBox(err));
    }
  });

  async function loadBacklinks() {
    if (!id) return;
    var el = document.getElementById('ed-back');
    try {
      var ns = await api('graph_neighbors', { id: id, depth: 1 });
      var back = ns.filter(function (n) { return n.dir === 'in' || n.dir === 'both'; });
      el.innerHTML = back.length
        ? '<h3>Cited by</h3>' + back.map(function (n) {
            return '<div><a href="' + editorHref(n.id) + '">' + esc(n.title || n.id) + '</a></div>';
          }).join('')
        : '';
    } catch (e) {
      el.innerHTML = '<h3>Cited by</h3><span class="muted">' + esc(e.message) + '</span>';
    }
  }
  loadBacklinks();
}

// ---- settings view ------------------------------------------------------

async function renderSettings() {
  view.innerHTML =
    '<div class="stack"><h2>Settings</h2>' +
    '<h3>AI providers (persisted by okb init)</h3>' +
    '<form id="setf" class="stack"><div class="grid">' +
    field('provider', 'Chat provider', '', 'anthropic | openai | … | local') +
    field('model', 'Chat model', '', 'provider default') +
    field('embed-provider', 'Embed provider', '', 'openai | voyage | … | local') +
    field('embed-model', 'Embed model', '', 'provider default') +
    '</div><div class="row"><label class="field"><span>Retrieval profile</span>' +
    '<select id="ed-retrieval-profile"><option value="">(keep)</option>' +
    '<option>lean</option><option>balanced</option><option>max</option></select></label>' +
    '<button class="primary">Save</button></div></form>' +
    '<div id="set-out"></div>' +
    '<h3>Sync (git)</h3><div class="row">' +
    '<button id="sync-status">Status</button><button id="sync-run" class="primary">Sync now</button></div>' +
    '<div id="sync-out"></div>' +
    '<h3>Enrichment (guardrailed web pass)</h3>' +
    '<form id="enrf" class="stack"><div class="grid">' +
    field('web-seed', 'Seed URLs', '', 'comma-separated http(s) URLs') +
    field('task', 'Task', '', 'what to improve (optional)') +
    field('web-max-pages', 'Max pages', '', '5') +
    field('web-max-depth', 'Max depth', '', '1') +
    field('allow-host', 'Allowed hosts', '', 'default: the seeds’ hosts') +
    field('deny-path', 'Denied path prefixes', '', 'e.g. /admin,/login') +
    '</div><div class="row"><label class="field"><span>Web</span>' +
    '<select id="ed-no-web"><option value="">on</option><option value="1">off (--no-web)</option></select></label>' +
    '<button class="primary">Run enrich</button></div></form>' +
    '<div id="enr-out"></div>' +
    '<h3>Maintenance</h3><div class="row">' +
    '<button id="mx-index">Re-index</button><button id="mx-embed">Embed</button>' +
    '<button id="mx-doctor">Doctor</button><button id="mx-viz">Export viz.html</button>' +
    '<button id="mx-rebuild">Rebuild (wipe + reindex)</button></div><div id="mx-out"></div></div>';

  function show(el, p) { document.getElementById(el).innerHTML = p; }
  function busy(el) { show(el, '<span class="muted">working…</span>'); }
  function notice(r) { return '<div class="notice">' + esc(JSON.stringify(r, null, 2)) + '</div>'; }

  document.getElementById('setf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var params = { 'no-default-bundle': true };
    ['provider', 'model', 'embed-provider', 'embed-model', 'retrieval-profile'].forEach(function (n) {
      var v = document.getElementById('ed-' + n).value.trim();
      if (v) params[n] = v;
    });
    busy('set-out');
    try {
      var r = await api('init', params);
      show('set-out', '<div class="notice">chat: ' + esc(r.chat.provider + ' / ' + r.chat.model +
        ' (' + r.chat.keyStatus + ')') + '\nembed: ' + esc(r.embed.provider + ' / ' + r.embed.model +
        ' (' + r.embed.keyStatus + ')') + '</div>');
    } catch (err) { show('set-out', errorBox(err)); }
  });
  document.getElementById('enrf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var params = {};
    ['web-seed', 'task', 'allow-host', 'deny-path'].forEach(function (n) {
      var v = document.getElementById('ed-' + n).value.trim();
      if (v) params[n] = v;
    });
    ['web-max-pages', 'web-max-depth'].forEach(function (n) {
      var v = document.getElementById('ed-' + n).value.trim();
      if (v) params[n] = parseInt(v, 10);
    });
    if (document.getElementById('ed-no-web').value) params['no-web'] = true;
    busy('enr-out');
    try {
      var r = await api('enrich', params);
      show('enr-out', '<div class="notice">' + esc(
        r.fetched.map(function (u) { return 'fetched ' + u; })
          .concat(r.written.map(function (w) { return (w.created ? 'created ' : 'enriched ') + w.id; }))
          .concat([(r.summary || '(no summary)') + ' — ' + r.steps + ' steps']).join('\n')) + '</div>');
    } catch (err) { show('enr-out', errorBox(err)); }
  });
  document.getElementById('sync-status').addEventListener('click', async function () {
    busy('sync-out');
    try { show('sync-out', notice(await api('sync', { status: true }))); }
    catch (e) { show('sync-out', errorBox(e)); }
  });
  document.getElementById('sync-run').addEventListener('click', async function () {
    busy('sync-out');
    try { show('sync-out', notice(await api('sync', {}))); }
    catch (e) { show('sync-out', errorBox(e)); }
  });
  document.getElementById('mx-index').addEventListener('click', async function () {
    busy('mx-out');
    try { show('mx-out', notice(await api('index', {}))); }
    catch (e) { show('mx-out', errorBox(e)); }
  });
  document.getElementById('mx-embed').addEventListener('click', async function () {
    busy('mx-out');
    try { show('mx-out', notice(await api('embed', {}))); }
    catch (e) { show('mx-out', errorBox(e)); }
  });
  document.getElementById('mx-doctor').addEventListener('click', async function () {
    busy('mx-out');
    try {
      var r = await api('doctor', {});
      show('mx-out', '<div class="notice">' + esc(
        r.findings.map(function (f) {
          return (f.severity === 'error' ? 'ERROR ' : 'warn  ') + f.path + '  ' + f.message;
        }).concat([(r.ok ? 'ok' : 'not conformant') + ' — ' + r.concepts + ' concepts, ' +
          r.errors + ' errors, ' + r.warnings + ' warnings']).join('\n')) + '</div>');
    } catch (e) { show('mx-out', errorBox(e)); }
  });
  document.getElementById('mx-viz').addEventListener('click', async function () {
    busy('mx-out');
    try {
      var r = await api('export_viz', {});
      show('mx-out', '<div class="notice">wrote ' + esc(r.path) + ' (' + r.nodes + ' concepts, ' + r.edges + ' links)</div>');
    } catch (e) { show('mx-out', errorBox(e)); }
  });
  document.getElementById('mx-rebuild').addEventListener('click', async function () {
    if (!confirm('Rebuild wipes the derived index and rebuilds it from the bundle. Continue?')) return;
    busy('mx-out');
    try { show('mx-out', notice(await api('rebuild', { 'confirm-destructive': true }))); }
    catch (e) { show('mx-out', errorBox(e)); }
  });
}

route();
