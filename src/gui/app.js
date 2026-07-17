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
  graph: renderGraph, ask: renderAsk, review: renderReview,
  inbox: renderInbox, editor: renderEditor, settings: renderSettings,
};

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
        '<a href="' + editorHref(it.id) + '"><button>Open</button></a>' +
        '<a href="' + graphHref(it.id) + '"><button>Graph</button></a></div></div>';
    }).join('');
  }
  listEl.addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.closest('.card').getAttribute('data-id');
    btn.disabled = true;
    try {
      await api(btn.getAttribute('data-act') === 'done' ? 'review_done' : 'review_snooze', { id: id });
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
        '<a href="' + graphHref(r.id) + '"><button>Graph</button></a></div></div>';
    }).join('');
  }
  listEl.addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act="read"]');
    if (!btn) return;
    btn.disabled = true;
    try { await api('inbox_read', { id: btn.closest('.card').getAttribute('data-id') }); load(); }
    catch (err) { listEl.insertAdjacentHTML('afterbegin', errorBox(err)); }
  });
  load();
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
    (exists ? '<a href="' + graphHref(id) + '"><button type="button">Open in graph</button></a>' : '') +
    '<span id="ed-msg" class="muted"></span></div>' +
    '</form><div id="ed-back"></div></div>';
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
    '<h3>Maintenance</h3><div class="row">' +
    '<button id="mx-index">Re-index</button><button id="mx-embed">Embed</button>' +
    '<button id="mx-doctor">Doctor</button></div><div id="mx-out"></div></div>';

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
}

route();
