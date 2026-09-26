// okbrain GUI: a vanilla single-page app over the local API. No build step,
// no framework — served as-is by api.ts and embedded into the compiled
// binary via Bun text imports. Every data access goes through /api/op/* (the
// ops contract) or one of the small server routes (status, brain mounts,
// bookmarklet); this file is presentation only. Rendering helpers shared
// with the static viewer come from render.js (window.okbRender); theme,
// motion and the graph palette from the design system's okb.js (window.Okb).

'use strict';

var TOKEN = window.OKB_TOKEN;
var R = window.okbRender;
var esc = R.esc;
var view = document.getElementById('view');
var STATUS = null; // /api/status for the selected brain
var BRAIN = '';
try { BRAIN = localStorage.getItem('okb-gui-brain') || ''; } catch (e) {}

// ---- transport ----------------------------------------------------------

function headers(extra) {
  var h = { 'x-okb-token': TOKEN };
  if (BRAIN) h['x-okb-brain'] = BRAIN;
  return Object.assign(h, extra || {});
}

async function api(op, params) {
  var res = await fetch('/api/op/' + op, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(params || {}),
  });
  var body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body.result;
}

async function get(path) {
  var res = await fetch(path, { headers: headers() });
  var body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// ---- small renderers ------------------------------------------------------

function errorBox(e) {
  return '<div class="error">' + esc(e && e.message ? e.message : e) + '</div>';
}
function tile(label, value, cls) {
  return '<div class="tile' + (cls ? ' ' + cls : '') + '"><div class="num">' + esc(value) +
    '</div><div class="lbl">' + esc(label) + '</div></div>';
}
function conceptHref(id) { return '#concept/' + encodeURIComponent(id); }
function editHref(id) { return '#edit/' + encodeURIComponent(id); }
function graphHref(id) { return '#graph/' + encodeURIComponent(id); }
function conceptLink(id, title) {
  return '<a href="' + conceptHref(id) + '">' + esc(title || id) + '</a>';
}
function chips(tags) {
  return (tags || []).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join(' ');
}
function dateOf(iso) { return iso ? esc(String(iso).slice(0, 10)) : '—'; }
function badges(s) { return '<span class="badges">' + R.badges(s) + '</span>'; }
function basename(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }
function jsonNotice(r) { return '<div class="notice">' + esc(JSON.stringify(r, null, 2)) + '</div>'; }

// Concept types in sorted order: type i owns graph slot i+1 (its nodes,
// legend row and type chips); the ninth type onward shares graph-other.
// Refreshed by every view that lists the whole bundle.
var TYPES = [];
function typeName(t) { return t || '(untyped)'; }
function setTypes(types) {
  var seen = {};
  types.forEach(function (t) { seen[typeName(t)] = true; });
  TYPES = Object.keys(seen).sort();
}
function slotOf(t) {
  var i = TYPES.indexOf(typeName(t));
  return i < 0 ? null : i < 8 ? 'graph-' + (i + 1) : 'graph-other';
}
function typeChip(t, count) {
  var slot = slotOf(t);
  return '<span class="chip">' + (slot ? '<span class="swatch" style="background:var(--' + slot + ')"></span>' : '') +
    esc(typeName(t)) + (count === undefined ? '' : ' ' + esc(count)) + '</span>';
}

/** A live "verb…" line in the element with this id (still on screen). */
function working(id, verb) {
  var el = document.getElementById(id);
  if (el) Okb.working(el, verb);
}
/** App-level work (index, embed, sync, ask…) waves the wordmark until it settles. */
async function appWork(p) {
  Okb.busy(true);
  try { return await p; } finally { Okb.busy(false); }
}
/** File a card away once its act is recorded; an emptied list says so. */
async function fileAway(card, kind, empty) {
  var list = card.parentNode;
  await Okb.fileAway(card, kind);
  if (!list.querySelector('.card')) list.innerHTML = '<div class="empty">' + empty + '</div>';
}
/** Stat-tile figures by label, so a redraw can flash the ones that changed. */
function figures(el) {
  var f = {};
  el.querySelectorAll('.tile').forEach(function (t) { f[t.querySelector('.lbl').textContent] = t.querySelector('.num').textContent; });
  return f;
}
function flashChanged(el, before) {
  el.querySelectorAll('.tile').forEach(function (t) {
    var was = before[t.querySelector('.lbl').textContent];
    if (was !== undefined && was !== t.querySelector('.num').textContent) Okb.flash(t);
  });
}

/** Render a markdown body into `el` with internal links routed to the reader. */
function renderBody(el, md, baseId) {
  el.innerHTML = R.renderMarkdown(md);
  R.wireLinks(el, { baseId: baseId, hrefFor: conceptHref });
}

// ---- theme ---------------------------------------------------------------

// Okb.theme restored the saved choice before first paint (index.html); the
// toggle floods the new theme out from the button. The label and canvas
// colours (a mounted graph) follow the attribute, so they change inside the
// flood rather than after it.
var themeBtn = document.getElementById('theme');
var repaint = null; // the mounted graph's restyle, while one is on screen
function themeChanged() {
  themeBtn.textContent = Okb.theme.get() === 'dark' ? '☼ light' : '☾ dark';
  if (repaint) repaint();
}
themeChanged();
new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
themeBtn.addEventListener('click', function () { Okb.theme.toggle(themeBtn); });

// ---- shell: status, brains, quick search ------------------------------------

async function refreshStatus() {
  var el = document.getElementById('nav-status');
  try {
    STATUS = await get('/api/status');
    document.getElementById('nav-brain').textContent = STATUS.brain || basename(STATUS.bundle);
    el.innerHTML =
      '<div><span class="dot' + (STATUS.hasIndex ? ' on' : '') + '"></span>index' +
      ' <span class="dot' + (STATUS.hasVectors ? ' on' : '') + '"></span>vectors</div>' +
      '<div>okb ' + esc(STATUS.version) + ' · OKF ' + esc(STATUS.okfVersion) +
      (STATUS.readonly ? ' · <span class="chip warn">read-only</span>' : '') + '</div>';
  } catch (e) {
    STATUS = null;
    el.innerHTML = '<span class="error">' + esc(e.message) + '</span>';
  }
}

async function loadBrains() {
  var sel = document.getElementById('brain');
  try {
    var r = await get('/api/brains');
    if (!r.brains.length) { sel.hidden = true; return; }
    sel.innerHTML = '<option value="">served bundle</option>' + r.brains.map(function (b) {
      return '<option value="' + esc(b.name) + '"' + (b.name === BRAIN ? ' selected' : '') + '>' +
        esc(b.name) + (b.readonly ? ' (read-only)' : '') + (b.exists ? '' : ' (missing)') + '</option>';
    }).join('');
    sel.hidden = false;
  } catch (e) { sel.hidden = true; }
}
document.getElementById('brain').addEventListener('change', function (e) {
  BRAIN = e.target.value;
  try { localStorage.setItem('okb-gui-brain', BRAIN); } catch (err) {}
  refreshStatus().then(route);
});

document.getElementById('qs').addEventListener('submit', function (e) {
  e.preventDefault();
  var q = document.getElementById('qs-in').value.trim();
  if (q) location.hash = '#search/' + encodeURIComponent(q);
});
document.addEventListener('keydown', function (e) {
  var tag = (document.activeElement && document.activeElement.tagName) || '';
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(tag)) {
    e.preventDefault();
    var qs = document.getElementById('qs-in');
    qs.focus();
    qs.select();
  }
});

// ---- router -------------------------------------------------------------

var routes = {
  home: renderHome, browse: renderBrowse, concept: renderConcept, edit: renderEdit,
  editor: renderEdit, graph: renderGraph, search: renderSearch, ask: renderAsk,
  add: renderAdd, review: renderReview, inbox: renderInbox, claims: renderClaims,
  stats: renderStats, settings: renderSettings,
};

var DIR_MARK = { out: '→', in: '←', both: '↔' };

// Every render gets a generation number; async work checks `stale(seq)` after
// each await so a render abandoned by navigation never touches the new view.
var gen = 0;
function stale(seq) { return seq !== gen; }
function setHtml(id, html) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// Title carry: the concept link clicked in a card or table row morphs into
// the reader's title during the page turn.
var carry = null;
view.addEventListener('click', function (e) {
  var a = e.target.closest('a[href^="#concept/"]');
  var row = a && a.closest('.card, tr');
  carry = row && row.querySelector('.title a, td > a:first-child');
});

// Each route is a page turn (Okb.go): the render runs inside one view
// transition, which captures the new view once the render has settled.
function route() {
  var h = location.hash.slice(1) || 'home';
  var slash = h.indexOf('/');
  var name = slash < 0 ? h : h.slice(0, slash);
  var arg = slash < 0 ? null : decodeURIComponent(h.slice(slash + 1));
  var fn = routes[name] || renderHome;
  var seq = ++gen;
  var shared = name === 'concept' && carry && carry.getAttribute('href') === location.hash ? carry : null;
  carry = null;
  return Okb.go(function () {
    repaint = null;
    document.querySelectorAll('#nav > a').forEach(function (a) { // not the wordmark's link
      var target = a.getAttribute('data-nav') || a.getAttribute('href').slice(1);
      a.classList.toggle('active', target === name || (name === 'editor' && target === 'edit'));
    });
    view.className = name === 'graph' ? 'bare' : '';
    view.scrollTop = 0;
    return fn(arg, seq);
  }, shared);
}
window.addEventListener('hashchange', route);

// ---- shared panels ------------------------------------------------------

// Link suggestions for `id`; `act` decides what a row's button does
// (accept = write via link_accept; insert = editor-local, no write).
async function loadSuggestions(el, id, act, actLabel) {
  Okb.working(el, 'suggesting');
  try {
    var ss = await api('link_suggest', { id: id });
    el.innerHTML = ss.length
      ? ss.map(function (s) {
          return '<div class="row suggestion" data-target="' + esc(s.id) + '">' +
            '<button class="small" data-act="' + act + '">' + actLabel + '</button>' +
            '<span>' + conceptLink(s.id, s.title) +
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

/** Card action buttons shared by review/inbox/home lists. */
function cardActions(id, extra) {
  return '<div class="row">' + (extra || '') +
    '<a href="' + conceptHref(id) + '"><button class="small">Open</button></a>' +
    '<button class="small" data-act="suggest">Suggest links</button>' +
    '<a href="' + graphHref(id) + '"><button class="small">Graph</button></a></div>' +
    '<div class="suggest"></div>';
}

/** Delegated click handling for cards: suggest/accept plus custom acts via `handle(act, id, card)`. */
function wireCards(listEl, handle) {
  listEl.addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var card = btn.closest('[data-id]');
    var id = card.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'suggest') { loadSuggestions(card.querySelector('.suggest'), id, 'accept', 'Link'); return; }
    if (act === 'accept') { acceptSuggestion(btn, id); return; }
    btn.disabled = true;
    try { await handle(act, id, card); }
    catch (err) { btn.disabled = false; listEl.insertAdjacentHTML('afterbegin', errorBox(err)); }
  });
}

// ---- home ----------------------------------------------------------------

async function renderHome(_arg, seq) {
  var name = STATUS ? (STATUS.brain || basename(STATUS.bundle)) : 'your brain';
  view.innerHTML =
    '<div class="stack wide"><h2 class="display">' + esc(name) + '</h2>' +
    '<div id="h-index"></div><div id="h-tiles"></div>' +
    '<form id="h-cap" class="row"><input id="h-cap-text" style="flex:1" placeholder="Capture a thought… (lands in inbox/)">' +
    '<button class="primary">Capture</button><span id="h-cap-msg" class="muted"></span></form>' +
    '<div class="split"><div><h3>Worth another look</h3><div id="h-review" class="list"></div></div>' +
    '<div><h3>Inbox</h3><div id="h-inbox" class="list"></div></div>' +
    '<div><h3>Recently changed</h3><div id="h-recent"></div></div></div>' +
    '<h3>Health</h3><div class="row"><button id="h-doctor">Check conformance</button>' +
    '<a href="#stats"><button>Stats</button></a><a href="#settings"><button>Settings</button></a></div>' +
    '<div id="h-doctor-out"></div></div>';

  if (STATUS && !STATUS.hasIndex) {
    document.getElementById('h-index').innerHTML =
      '<div class="notice">This brain has no search index yet — search, graph, review and stats need one. ' +
      '<button id="h-build" class="primary small">Build index</button></div>';
    document.getElementById('h-build').addEventListener('click', async function () {
      this.disabled = true;
      try { await appWork(api('index', {})); await refreshStatus(); route(); }
      catch (e) { setHtml('h-index', errorBox(e)); }
    });
  }

  document.getElementById('h-cap').addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = document.getElementById('h-cap-text').value.trim();
    if (!text) return;
    var msg = document.getElementById('h-cap-msg');
    Okb.working(msg, 'capturing');
    try {
      var r = await api('capture', { text: text });
      if (stale(seq)) return;
      document.getElementById('h-cap-text').value = '';
      msg.innerHTML = 'captured ' + conceptLink(r.id);
      loadInboxPreview();
      loadTiles();
    } catch (err) { msg.innerHTML = errorBox(err); }
  });

  async function loadTiles() {
    var el = document.getElementById('h-tiles');
    try {
      var s = await api('stats', {});
      var q = await api('review_queue', {});
      var reviewed = s.byTrust['human-reviewed'];
      var before = figures(el);
      el.innerHTML = '<div class="tiles">' +
        tile('Concepts', s.concepts) + tile('Links', s.edges) +
        tile('Review due', q.length, q.length ? 'alert' : '') +
        tile('Inbox', s.inbox, s.inbox ? 'alert' : '') +
        tile('Orphans', s.orphans) +
        tile('Past stale_after', s.expired, s.expired ? 'alert' : '') +
        tile('Drafts', s.byStatus.draft) +
        tile('Human-reviewed', s.concepts ? Math.round((100 * reviewed) / s.concepts) + '%' : '—', 'good') + '</div>';
      flashChanged(el, before);
    } catch (e) { el.innerHTML = ''; }
  }

  async function loadReviewPreview() {
    var el = document.getElementById('h-review');
    try {
      var q = await api('review_queue', {});
      el.innerHTML = q.length
        ? q.map(function (it) {
            return '<div class="card compact" data-id="' + esc(it.id) + '"><div class="title">' +
              conceptLink(it.id, it.title) + '</div><div class="why">' + esc(it.reasons.join('; ')) + '</div>' +
              '<div class="row"><button class="small" data-act="done" title="records a verified event by you">Reviewed ✓</button>' +
              '<button class="small" data-act="snooze">Snooze</button></div></div>';
          }).join('')
        : '<div class="empty">Nothing needs review.</div>';
      Okb.enter(el);
    } catch (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  wireCards(document.getElementById('h-review'), async function (act, id, card) {
    await api(act === 'done' ? 'review_done' : 'review_snooze', { id: id });
    await fileAway(card, act === 'done' ? 'done' : 'snooze', 'Nothing needs review.');
    if (!stale(seq)) loadTiles();
  });

  async function loadInboxPreview(first) {
    var el = document.getElementById('h-inbox');
    try {
      var rows = await api('inbox_list', {});
      el.innerHTML = rows.length
        ? rows.slice(0, 6).map(function (r) {
            return '<div class="card compact" data-id="' + esc(r.id) + '"><div class="title">' +
              conceptLink(r.id, r.title) + '</div><div class="row"><button class="small" data-act="read">Mark read</button></div></div>';
          }).join('') + (rows.length > 6 ? '<p class="muted"><a href="#inbox">' + (rows.length - 6) + ' more…</a></p>' : '')
        : '<div class="empty">Inbox is empty.</div>';
      if (first) Okb.enter(el);
    } catch (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  wireCards(document.getElementById('h-inbox'), async function (act, id, card) {
    await api('inbox_read', { id: id });
    await Okb.fileAway(card, 'done');
    if (stale(seq)) return;
    loadInboxPreview();
    loadTiles();
  });

  async function loadRecent() {
    var el = document.getElementById('h-recent');
    try {
      var rows = await api('list_concepts', { detail: true });
      setTypes(rows.map(function (r) { return r.type; }));
      rows.sort(function (a, b) { return (b.updated || '') < (a.updated || '') ? -1 : 1; });
      el.innerHTML = rows.length
        ? '<table class="tbl">' + rows.slice(0, 8).map(function (r) {
            return '<tr><td>' + conceptLink(r.id, r.title) + '<br>' + badges(r) + '</td>' +
              '<td class="nowrap muted">' + dateOf(r.updated) + '</td></tr>';
          }).join('') + '</table>' + (rows.length > 8 ? '<p class="muted"><a href="#browse">browse all ' + rows.length + '…</a></p>' : '')
        : '<div class="empty">No concepts yet — capture something above or <a href="#edit">write one</a>.</div>';
    } catch (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  document.getElementById('h-doctor').addEventListener('click', async function () {
    var out = document.getElementById('h-doctor-out');
    Okb.working(out, 'checking');
    try { out.innerHTML = doctorSummary(await api('doctor', {})); }
    catch (e) { out.innerHTML = errorBox(e); }
  });

  loadTiles();
  loadReviewPreview();
  loadInboxPreview(true);
  loadRecent();
}

function doctorSummary(r) {
  var sig = r.signals;
  var head = (r.ok ? '✓ conformant' : 'not conformant') + ' — ' + r.concepts + ' concepts, ' +
    r.errors + ' errors, ' + r.warnings + ' warnings · okf_version ' + (r.okfVersion || 'undeclared') +
    '\ntrust: ' + sig.trust['human-reviewed'] + ' human-reviewed, ' + sig.trust['machine-confirmed'] +
    ' machine-confirmed, ' + sig.trust.unverified + ' unverified · status: ' + sig.status.draft + ' draft, ' +
    sig.status.deprecated + ' deprecated · ' + sig.stale + ' past stale_after · ' + sig.legacy + ' still v0.1';
  var lines = r.findings.slice(0, 60).map(function (f) {
    return (f.severity === 'error' ? 'ERROR ' : 'warn  ') + f.path + '  ' + f.message + ' [' + f.check + ']';
  });
  if (r.findings.length > 60) lines.push('… ' + (r.findings.length - 60) + ' more');
  return '<div class="notice">' + esc(head + (lines.length ? '\n\n' + lines.join('\n') : '')) + '</div>' +
    (sig.legacy ? '<p class="muted">v0.1 leftovers can be migrated in <a href="#settings">Settings → Maintenance → Upgrade</a>.</p>' : '');
}

// ---- browse --------------------------------------------------------------

async function renderBrowse(_arg, seq) {
  view.innerHTML =
    '<div class="stack wide"><h2>Browse</h2>' +
    '<div class="toolbar"><input id="b-q" type="search" placeholder="Filter title / id / tags…">' +
    '<select id="b-type"><option value="">all types</option></select>' +
    '<select id="b-status"><option value="">any status</option><option>draft</option><option>stable</option><option>deprecated</option></select>' +
    '<select id="b-sort"><option value="updated">newest first</option><option value="title">title</option><option value="type">type</option></select>' +
    '<span id="b-count" class="muted right"></span></div><div id="b-out"></div></div>';
  var out = document.getElementById('b-out');
  Okb.working(out, 'loading');
  var rows;
  try { rows = await api('list_concepts', { detail: true }); }
  catch (e) { out.innerHTML = errorBox(e); return; }
  if (stale(seq)) return;
  setTypes(rows.map(function (r) { return r.type; }));
  var types = [];
  rows.forEach(function (r) { if (types.indexOf(r.type) < 0) types.push(r.type); });
  types.sort();
  var typeSel = document.getElementById('b-type');
  types.forEach(function (t) {
    var o = document.createElement('option');
    o.value = t;
    o.textContent = t || '(untyped)';
    typeSel.appendChild(o);
  });
  function draw() {
    var q = document.getElementById('b-q').value.trim().toLowerCase();
    var type = typeSel.value, status = document.getElementById('b-status').value;
    var sort = document.getElementById('b-sort').value;
    var list = rows.filter(function (r) {
      if (type && r.type !== type) return false;
      if (status && r.status !== status) return false;
      if (q && (r.id + ' ' + r.title + ' ' + r.tags.join(' ')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    list.sort(function (a, b) {
      if (sort === 'title') return (a.title || a.id).localeCompare(b.title || b.id);
      if (sort === 'type') return a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
      return (b.updated || '') < (a.updated || '') ? -1 : (b.updated || '') > (a.updated || '') ? 1 : a.id.localeCompare(b.id);
    });
    document.getElementById('b-count').textContent = list.length + ' of ' + rows.length;
    out.innerHTML = list.length
      ? '<table class="tbl"><thead><tr><th>Concept</th><th>Type</th><th>Signals</th><th>Updated</th><th>Tags</th></tr></thead><tbody>' +
        list.map(function (r) {
          return '<tr><td>' + conceptLink(r.id, r.title) + '<br><code>' + esc(r.id) + '</code>' +
            (r.description ? '<div class="muted">' + esc(r.description) + '</div>' : '') + '</td>' +
            '<td>' + typeChip(r.type) + '</td><td>' + badges(r) + '</td>' +
            '<td class="nowrap muted">' + dateOf(r.updated) + '</td><td>' + chips(r.tags) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">No concepts match.</div>';
  }
  ['b-q', 'b-type', 'b-status', 'b-sort'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', draw);
    document.getElementById(id).addEventListener('change', draw);
  });
  draw();
  Okb.enter(out.querySelector('tbody'));
}

// ---- concept (reader) ----------------------------------------------------

/** The reader; `was` (the trust tier before an act) stamps a tier that just changed. */
async function renderConcept(id, seq, was) {
  if (!id) { location.hash = '#browse'; return; }
  var c;
  try { c = await api('read_concept', { id: id }); }
  catch (e) { if (!stale(seq)) view.innerHTML = errorBox(e); return; }
  if (stale(seq)) return;
  var fm = c.frontmatter, s = c.signals;
  var tags = Array.isArray(fm.tags) ? fm.tags : (typeof fm.tags === 'string' ? [fm.tags] : []);
  var inInbox = tags.indexOf('inbox') >= 0;
  var verified = Array.isArray(fm.verified) ? fm.verified : (fm.verified ? [fm.verified] : []);
  var sources = Array.isArray(fm.sources) ? fm.sources : (fm.sources ? [fm.sources] : []);
  var isComputation = String(fm.type || '').toLowerCase() === 'attested computation';

  var meta = '<dl class="kv">';
  if (fm.resource) meta += '<dt>Resource</dt><dd><a href="' + esc(fm.resource) + '" target="_blank" rel="noopener">' + esc(fm.resource) + '</a></dd>';
  if (tags.length) meta += '<dt>Tags</dt><dd>' + chips(tags) + '</dd>';
  meta += '<dt>Generated</dt><dd>' + R.actorLine(fm.generated) + (fm.timestamp && !fm.generated ? ' <span class="muted">(v0.1 timestamp ' + esc(fm.timestamp) + ')</span>' : '') + '</dd>';
  meta += '<dt>Verified</dt><dd>' + (verified.length ? verified.map(R.actorLine).join('<br>') : '<span class="muted">never</span>') + '</dd>';
  if (fm.stale_after) meta += '<dt>Stale after</dt><dd>' + esc(fm.stale_after) + '</dd>';
  meta += '<dt>Sources</dt><dd>' + R.sourcesList(sources) + '</dd>';
  if (isComputation) {
    meta += '<dt>Runtime</dt><dd>' + esc(fm.runtime || '(missing — required)') + '</dd>';
    if (fm.parameters) meta += '<dt>Parameters</dt><dd><code>' + esc(JSON.stringify(fm.parameters)) + '</code></dd>';
    if (fm.computation) meta += '<dt>Computation</dt><dd>' + esc(fm.computation) + '</dd>';
    if (fm.executor) meta += '<dt>Executor</dt><dd>' + esc(fm.executor.resource || JSON.stringify(fm.executor)) + '</dd>';
    if (fm.attester) meta += '<dt>Attester</dt><dd>' + esc(fm.attester.resource || JSON.stringify(fm.attester)) + '</dd>';
  }
  if (fm.type === 'claim') {
    meta += '<dt>Confidence</dt><dd>' + esc(fm.confidence) + '%' + (fm.resolve_by ? ' · resolve by ' + esc(fm.resolve_by) : '') +
      (fm.outcome ? ' · <strong>' + esc(fm.outcome) + '</strong>' : ' · open') + '</dd>';
  }
  meta += '</dl>';

  view.innerHTML =
    '<div class="concept-layout"><div>' +
    '<div class="concept-head"><h2>' + esc(fm.title || id) + '</h2>' +
    (fm.description ? '<p class="lead">' + esc(fm.description) + '</p>' : '') +
    '<div class="meta">' + typeChip(fm.type) + '<code>' + esc(id) + '</code>' + badges({ status: s.status, trust: s.trust, stale: s.stale, staleAfter: fm.stale_after }) + '</div>' +
    '<div class="row" id="c-actions">' +
    '<a href="' + editHref(id) + '"><button class="primary small">Edit</button></a>' +
    '<button class="small" data-act="verify" title="records a verified event by you">Verified ✓</button>' +
    (inInbox ? '<button class="small" data-act="read">Mark read</button>' : '') +
    '<button class="small" data-act="suggest">Suggest links</button>' +
    '<a href="' + graphHref(id) + '"><button class="small">Graph</button></a>' +
    (s.status === 'deprecated'
      ? '<button class="small" data-act="restore">Restore (stable)</button>'
      : '<button class="small" data-act="deprecate">Deprecate</button>') +
    '<button class="small danger" data-act="delete">Delete</button>' +
    '<span id="c-msg" class="muted"></span></div></div>' +
    '<div id="c-suggest"></div>' +
    '<div class="concept-body md" id="c-body"></div></div>' +
    '<aside class="concept-side"><div class="card">' + meta + '</div>' +
    '<div class="card" id="c-links"></div></aside></div>';

  renderBody(document.getElementById('c-body'), c.body, id);
  if (was && was !== s.trust) Okb.stamp(view.querySelector('.concept-head .badge.trust-' + s.trust));

  document.getElementById('c-actions').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var msg = document.getElementById('c-msg');
    if (act === 'suggest') { loadSuggestions(document.getElementById('c-suggest'), id, 'accept', 'Link'); return; }
    if (act === 'delete' && !confirm('Delete ' + id + '? The file is removed from the bundle (git history keeps it if you sync).')) return;
    btn.disabled = true;
    try {
      if (act === 'verify') { await api('review_done', { id: id }); if (!stale(seq)) renderConcept(id, seq, s.trust); }
      else if (act === 'read') { await api('inbox_read', { id: id }); if (!stale(seq)) renderConcept(id, seq); }
      else if (act === 'deprecate') { await api('write_concept', { id: id, status: 'deprecated' }); if (!stale(seq)) renderConcept(id, seq); }
      else if (act === 'restore') { await api('write_concept', { id: id, status: 'stable' }); if (!stale(seq)) renderConcept(id, seq); }
      else if (act === 'delete') { await api('delete_concept', { id: id }); location.hash = '#browse'; }
    } catch (err) { btn.disabled = false; msg.innerHTML = errorBox(err); }
  });
  document.getElementById('c-suggest').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act="accept"]');
    if (btn) acceptSuggestion(btn, id);
  });

  var linksEl = document.getElementById('c-links');
  Okb.working(linksEl, 'loading links');
  if (STATUS && !STATUS.hasIndex) {
    linksEl.innerHTML = '<span class="muted">Links to / cited by need a search index — build one on <a href="#home">Home</a>.</span>';
    return;
  }
  try {
    var ns = await api('graph_neighbors', { id: id, depth: 1 });
    var out = ns.filter(function (n) { return n.dir === 'out' || n.dir === 'both'; });
    var back = ns.filter(function (n) { return n.dir === 'in' || n.dir === 'both'; });
    var list = function (arr) {
      return '<ul class="plain">' + arr.map(function (n) { return '<li>' + conceptLink(n.id, n.title) + '</li>'; }).join('') + '</ul>';
    };
    linksEl.innerHTML =
      '<h3>Links to (' + out.length + ')</h3>' + (out.length ? list(out) : '<span class="muted">none</span>') +
      '<h3>Cited by (' + back.length + ')</h3>' + (back.length ? list(back) : '<span class="muted">none</span>');
  } catch (e) {
    linksEl.innerHTML = '<span class="muted">' + esc(e.message) + '</span>';
  }
}

// ---- edit ---------------------------------------------------------------

function field(name, label, value, placeholder, type) {
  return '<label class="field"><span>' + label + '</span><input id="ed-' + name +
    '" type="' + (type || 'text') + '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '"></label>';
}

/** ISO instant ⇄ <input type=datetime-local> (browser-local wall time). */
function isoToLocal(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function localToIso(v) {
  if (!v) return '';
  var d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function renderEdit(id, seq) {
  var fm = {}, body = '', exists = false;
  if (id) {
    try {
      var c = await api('read_concept', { id: id });
      fm = c.frontmatter;
      body = c.body;
      exists = true;
    } catch (e) { if (!stale(seq)) view.innerHTML = errorBox(e); return; }
    if (stale(seq)) return;
  }
  var tags = Array.isArray(fm.tags) ? fm.tags.join(', ') : (fm.tags || '');
  var sources = Array.isArray(fm.sources) ? fm.sources : (fm.sources ? [fm.sources] : []);
  var statusOpts = ['stable', 'draft', 'deprecated'].map(function (s) {
    return '<option' + ((fm.status || 'stable') === s ? ' selected' : '') + '>' + s + '</option>';
  }).join('');

  view.innerHTML =
    '<div class="stack"><h2>' + (exists ? 'Edit concept' : 'New concept') + '</h2>' +
    '<form id="edf" class="stack">' +
    field('id', 'Id' + (exists ? '' : ' (optional — derived from type + title)'), id, 'notes/my-note') +
    '<div class="grid">' + field('type', 'Type', fm.type, 'note') + field('title', 'Title', fm.title, '') + '</div>' +
    field('description', 'Description', fm.description, 'one sentence') +
    '<div class="grid">' + field('tags', 'Tags (comma-separated)', tags, '') + field('resource', 'Resource (URI)', fm.resource, '') + '</div>' +
    '<div class="grid"><label class="field"><span>Status</span><select id="ed-status">' + statusOpts + '</select></label>' +
    field('stale-after', 'Stale after', isoToLocal(fm.stale_after), '', 'datetime-local') + '</div>' +
    '<div class="field"><span>Sources (provenance)</span><div class="sources-editor" id="ed-sources"></div>' +
    '<div class="row"><button type="button" class="small" id="ed-addsrc">Add source</button>' +
    '<span class="muted">attribute claims in the body with [^id]</span></div></div>' +
    '<label class="field"><span>Body (markdown; links normalize on save)</span>' +
    '<textarea id="ed-body" rows="18"></textarea></label>' +
    '<div class="row">' +
    '<button class="primary">Save</button>' +
    '<select id="ed-linkpick"><option value="">insert link to…</option></select>' +
    (exists ? '<button type="button" id="ed-suggest">Suggest links</button>' : '') +
    (exists ? '<a href="' + conceptHref(id) + '"><button type="button">Cancel</button></a>' : '') +
    '<span id="ed-msg" class="muted"></span></div>' +
    (exists ? '<p class="muted">generated: ' + R.actorLine(fm.generated) + ' · verified: ' +
      (Array.isArray(fm.verified) ? fm.verified.length : fm.verified ? 1 : 0) + ' event(s)</p>' : '') +
    '</form><div id="ed-sugg"></div></div>';
  document.getElementById('ed-body').value = body;
  if (exists) document.getElementById('ed-id').readOnly = true;

  var srcEl = document.getElementById('ed-sources');
  function addSource(s) {
    s = s || {};
    srcEl.insertAdjacentHTML('beforeend',
      '<div class="srow"><input placeholder="id" value="' + esc(s.id || '') + '" data-k="id">' +
      '<input placeholder="resource (URL, /path.md, or scope)" value="' + esc(s.resource || '') + '" data-k="resource">' +
      '<input placeholder="title" value="' + esc(s.title || '') + '" data-k="title">' +
      '<input placeholder="author (actor)" value="' + esc(s.author || '') + '" data-k="author">' +
      '<button type="button" class="small" data-del title="remove" aria-label="remove source">✕</button></div>');
  }
  sources.forEach(addSource);
  document.getElementById('ed-addsrc').addEventListener('click', function () { addSource(); });
  srcEl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-del]');
    if (b) b.closest('.srow').remove();
  });
  function collectSources() {
    return Array.prototype.map.call(srcEl.querySelectorAll('.srow'), function (row) {
      var s = {};
      row.querySelectorAll('input').forEach(function (inp) {
        var v = inp.value.trim();
        if (v) s[inp.getAttribute('data-k')] = v;
      });
      return s;
    }).filter(function (s) { return s.resource; });
  }

  var bodyEl = document.getElementById('ed-body');
  var msgEl = document.getElementById('ed-msg');
  function insertAtCursor(text) {
    var st = bodyEl.selectionStart || 0;
    bodyEl.value = bodyEl.value.slice(0, st) + text + bodyEl.value.slice(bodyEl.selectionEnd || st);
    bodyEl.focus();
    bodyEl.selectionStart = bodyEl.selectionEnd = st + text.length;
  }

  // Concept-id link autocomplete: pick a concept, get a normalized link.
  api('list_concepts', {}).then(function (ids) {
    var pick = document.getElementById('ed-linkpick');
    if (!pick || stale(seq)) return;
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

  document.getElementById('edf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var val = function (n) { return document.getElementById('ed-' + n).value.trim(); };
    var params = { body: bodyEl.value, tags: val('tags'), status: val('status') };
    ['type', 'title', 'description', 'resource'].forEach(function (n) { if (val(n)) params[n] = val(n); });
    var sa = localToIso(val('stale-after'));
    params['stale-after'] = sa;
    params.sources = JSON.stringify(collectSources());
    Okb.working(msgEl, 'saving');
    try {
      var r;
      if (val('id')) { params.id = val('id'); r = await api('write_concept', params); }
      else {
        // No id: derive it from type + title (the `new` op), which refuses to clobber.
        if (!params.type || !params.title || !params.description) throw new Error('type, title and description are required');
        delete params['stale-after'];
        delete params.sources;
        r = await api('new_concept', params);
        if (sa || collectSources().length) await api('write_concept', { id: r.id, 'stale-after': sa, sources: JSON.stringify(collectSources()) });
      }
      msgEl.textContent = (r.noop ? 'unchanged ' : r.created ? 'created ' : 'updated ') + r.id;
      location.hash = conceptHref(r.id).slice(1);
    } catch (err) {
      msgEl.textContent = '';
      view.querySelector('.stack').insertAdjacentHTML('afterbegin', errorBox(err));
    }
  });
}

// ---- graph view ---------------------------------------------------------

/** A duration token in ms (0 under prefers-reduced-motion). */
function ms(token) { return parseFloat(Okb.token(token)) || 0; }

async function renderGraph(focusId, seq) {
  view.innerHTML =
    '<div id="gwrap"><div id="gmain">' +
    '<div id="gbar"><input id="gsearch" type="search" placeholder="Filter title / id / tags…">' +
    '<select id="glayout"><option value="cose">cose</option><option value="concentric">concentric</option>' +
    '<option value="breadthfirst">breadth-first</option><option value="circle">circle</option><option value="grid">grid</option></select>' +
    '<button id="gfit">Fit</button><span id="gstats" class="muted"></span></div>' +
    '<div id="gcy"></div><div id="glegend"></div></div>' +
    '<div id="gdetail"><p class="empty">Click a node.</p></div></div>';
  var g;
  // Node labels are canvas text in Literata, and a canvas never loads a face itself.
  try { g = (await Promise.all([api('graph_data', {}), document.fonts.load('9px Literata')]))[0]; }
  catch (e) { if (!stale(seq)) { view.className = ''; view.innerHTML = errorBox(e); } return; }
  if (stale(seq)) return;

  var byId = {}, linksTo = {}, citedBy = {}, typeCount = {};
  g.nodes.forEach(function (n) {
    byId[n.id] = n;
    typeCount[typeName(n.type)] = (typeCount[typeName(n.type)] || 0) + 1;
  });
  g.edges.forEach(function (e) {
    (linksTo[e.src] = linksTo[e.src] || []).push(e.dst);
    (citedBy[e.dst] = citedBy[e.dst] || []).push(e.src);
  });
  setTypes(g.nodes.map(function (n) { return n.type; }));
  document.getElementById('gstats').textContent = g.nodes.length + ' concepts · ' + g.edges.length + ' links';

  // The canvas takes concrete colours: the current theme's, re-read when it flips.
  var fill = {}, tok = {};
  function readTheme() {
    var p = Okb.graphPalette();
    TYPES.forEach(function (t, i) { fill[t] = i < 8 ? p.slots[i] : p.other; });
    ['ink-2', 'surface', 'danger', 'edge-line', 'accent'].forEach(function (k) { tok[k] = Okb.token(k); });
  }
  function themed(k) { return function () { return tok[k]; }; }
  readTheme();

  var cy = cytoscape({
    container: document.getElementById('gcy'),
    elements: g.nodes.map(function (n) {
      return { data: { id: n.id, label: n.title || n.id, type: typeName(n.type),
        status: n.status, stale: n.stale,
        size: 16 + 4 * Math.sqrt(Math.min(n.bodyLen, 20000) / 100) } };
    }).concat(g.edges.map(function (e) {
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
      { selector: '.dim, .faded', style: { opacity: Number(Okb.token('opacity-dim')) } },
    ],
    layout: { name: 'cose', animate: false },
    wheelSensitivity: 0.2,
  });
  window.cy = cy; // console/driver access, like the static viewer
  repaint = function () { readTheme(); cy.style().update(); };

  // Hover dims everything outside the node's neighbourhood.
  cy.on('mouseover', 'node', function (e) { cy.elements().difference(e.target.closedNeighborhood()).addClass('faded'); });
  cy.on('mouseout', 'node', function () { cy.elements().removeClass('faded'); });

  var checked = {};
  var legend = document.getElementById('glegend');
  legend.innerHTML = TYPES.map(function (t) {
    checked[t] = true;
    return '<label><input type="checkbox" checked data-type="' + esc(t) + '"><span class="swatch" style="background:var(--' +
      slotOf(t) + ')"></span>' + esc(t) + '<span class="count">' + typeCount[t] + '</span></label>';
  }).join('');
  var search = document.getElementById('gsearch');
  function applyFilters() {
    var q = search.value.trim().toLowerCase();
    cy.batch(function () {
      cy.nodes().forEach(function (node) {
        node.style('display', checked[node.data('type')] ? 'element' : 'none');
      });
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
  }
  legend.addEventListener('change', function (e) {
    var cb = e.target;
    if (cb.getAttribute('data-type') !== null) { checked[cb.getAttribute('data-type')] = cb.checked; applyFilters(); }
  });
  search.addEventListener('input', applyFilters);
  document.getElementById('glayout').addEventListener('change', function (e) {
    var d = ms('dur-deliberate');
    cy.layout({ name: e.target.value, animate: d > 0 ? 'end' : false, animationDuration: d,
      animationEasing: Okb.token('ease-in-out') }).run();
  });
  document.getElementById('gfit').addEventListener('click', function () { cy.fit(undefined, 40); });

  var detail = document.getElementById('gdetail');
  function conceptList(ids) {
    return '<ul>' + ids.map(function (cid) {
      return '<li><a href="#focus" data-id="' + esc(cid) + '">' + esc((byId[cid] && byId[cid].title) || cid) + '</a></li>';
    }).join('') + '</ul>';
  }
  function showDetail(id) {
    var n = byId[id];
    if (!n) return;
    var h = '<h2>' + esc(n.title || n.id) + '</h2>' +
      '<div class="meta">' + typeChip(n.type) + '<code>' + esc(n.id) + '</code></div>' +
      '<div class="meta">' + badges(n) + '</div>' +
      '<div class="row"><a href="' + conceptHref(id) + '"><button class="small">Open</button></a>' +
      '<a href="' + editHref(id) + '"><button class="small">Edit</button></a></div>';
    if (n.description) h += '<p class="why">' + esc(n.description) + '</p>';
    if (n.tags.length) h += '<div class="meta">' + chips(n.tags) + '</div>';
    h += '<dl class="kv"><dt>Generated</dt><dd>' + R.actorLine(n.generated) + '</dd>' +
      '<dt>Verified</dt><dd>' + (n.verified.length ? n.verified.map(R.actorLine).join('<br>') : '—') + '</dd>' +
      '<dt>Sources</dt><dd>' + R.sourcesList(n.sources) + '</dd></dl>';
    h += '<div class="body md" id="gbody"></div>';
    var out = linksTo[id] || [], back = citedBy[id] || [];
    if (out.length) h += '<h3>Links to</h3>' + conceptList(out);
    if (back.length) h += '<h3>Cited by</h3>' + conceptList(back);
    detail.innerHTML = h;
    var bodyEl = document.getElementById('gbody');
    bodyEl.innerHTML = R.renderMarkdown(n.body);
    // In-graph navigation: internal links focus the node instead of leaving the view.
    R.wireLinks(bodyEl, { baseId: id, hrefFor: function () { return '#focus'; }, known: function (x) { return !!byId[x]; } });
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
  detail.addEventListener('click', function (e) {
    var a = e.target.closest('a[href="#focus"]');
    if (!a) return;
    e.preventDefault();
    focusNode(a.getAttribute('data-id'));
  });
  cy.on('tap', 'node', function (e) { showDetail(e.target.id()); });
  if (focusId) focusNode(focusId);
}

// ---- search view --------------------------------------------------------

function renderSearch(initialQ) {
  view.innerHTML =
    '<div class="stack"><h2>Search</h2>' +
    '<form id="sf" class="row">' +
    '<input id="sq" style="flex:1" placeholder="keyword + vector search…" autofocus>' +
    '<select id="sp"><option value="">balanced</option><option>lean</option><option>max</option></select>' +
    '<button class="primary">Search</button></form>' +
    '<div id="sout" class="list"></div></div>';
  var out = document.getElementById('sout');
  var qEl = document.getElementById('sq');
  document.getElementById('sf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var q = qEl.value.trim();
    if (!q) return;
    Okb.working(out, 'searching');
    var params = { query: q };
    var p = document.getElementById('sp').value;
    if (p) params.profile = p;
    try {
      var hits = await api('search', params);
      out.innerHTML = hits.length
        ? hits.map(function (h) {
            return '<div class="card"><div class="title">' + conceptLink(h.id, h.title) +
              ' <span class="muted">(' + h.score.toFixed(3) + ')</span></div>' +
              '<div class="why"><code>' + esc(h.id) + '</code> · ' + chips(h.sources) + '</div>' +
              (h.description ? '<div class="why">' + esc(h.description) + '</div>' : '') +
              (h.snippet ? '<div class="muted">' + esc(h.snippet.slice(0, 240)) + '…</div>' : '') +
              '<div class="row"><a href="' + conceptHref(h.id) + '"><button class="small">Open</button></a>' +
              '<a href="' + editHref(h.id) + '"><button class="small">Edit</button></a>' +
              '<a href="' + graphHref(h.id) + '"><button class="small">Graph</button></a></div></div>';
          }).join('')
        : '<div class="empty">No hits.</div>';
      Okb.enter(out);
    } catch (err) { out.innerHTML = errorBox(err); }
  });
  if (initialQ) { qEl.value = initialQ; qEl.form.requestSubmit(); }
}

// ---- ask view -----------------------------------------------------------

function citationLinks(citations) {
  return citations.map(function (c) {
    return '<span class="chip">' + conceptLink(c.id, c.title) + ' · <a href="' + graphHref(c.id) + '">graph</a></span>';
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
    Okb.working(ctxEl, 'retrieving');
    outEl.innerHTML = '';
    srcEl.innerHTML = '';
    var url = '/api/ask/stream?token=' + encodeURIComponent(TOKEN) + '&question=' + encodeURIComponent(q);
    var profile = document.getElementById('askp').value;
    if (profile) url += '&profile=' + encodeURIComponent(profile);
    if (BRAIN) url += '&brain=' + encodeURIComponent(BRAIN);
    var es = new EventSource(url);
    Okb.busy(true);
    function end() { es.close(); Okb.busy(false); } // a closed stream fires nothing more
    es.addEventListener('context', function (ev) {
      var ctx = JSON.parse(ev.data);
      ctxEl.innerHTML = ctx.length ? '<span class="muted">reading:</span> ' + citationLinks(ctx) : '';
    });
    es.addEventListener('answer', function (ev) {
      outEl.innerHTML = R.renderMarkdown(JSON.parse(ev.data).answer);
      Okb.settle(outEl);
    });
    es.addEventListener('done', function (ev) {
      var r = JSON.parse(ev.data).result;
      if (r.citations.length) srcEl.innerHTML = '<h3>Sources</h3>' + citationLinks(r.citations);
      end();
    });
    es.addEventListener('error', function (ev) {
      if (ev.data) outEl.innerHTML = errorBox(JSON.parse(ev.data).error);
      else if (!outEl.innerHTML) outEl.innerHTML = errorBox('stream failed');
      end();
    });
  });
}

// ---- review view --------------------------------------------------------

async function renderReview() {
  view.innerHTML = '<div class="stack"><h2>Review</h2>' +
    '<p class="muted">A small daily queue with stated reasons. “Reviewed ✓” records a <code>verified</code> event by you (OKF trust tier: human-reviewed).</p>' +
    '<label class="row"><input type="checkbox" id="rgarnish"> AI garnish (connects items to recent notes)</label>' +
    '<div id="rlist" class="list"></div></div>';
  var listEl = document.getElementById('rlist');
  var garnishEl = document.getElementById('rgarnish');
  async function load() {
    Okb.working(listEl, 'scoring');
    var q;
    try { q = await (garnishEl.checked ? appWork(api('review_queue', { garnish: true })) : api('review_queue', {})); }
    catch (e) { listEl.innerHTML = errorBox(e); return; }
    if (!q.length) { listEl.innerHTML = '<div class="empty">Nothing needs review.</div>'; return; }
    listEl.innerHTML = q.map(function (it) {
      return '<div class="card" data-id="' + esc(it.id) + '">' +
        '<div class="title">' + conceptLink(it.id, it.title) +
        ' <span class="muted">(' + it.score.toFixed(2) + ')</span></div>' +
        '<div class="why">' + esc(it.reasons.join('; ')) + '</div>' +
        (it.garnish ? '<div class="garnish">↳ ' + esc(it.garnish) + '</div>' : '') +
        cardActions(it.id, '<button class="small" data-act="done">Reviewed ✓</button><button class="small" data-act="snooze">Snooze 7d</button>') +
        '</div>';
    }).join('');
    Okb.enter(listEl);
  }
  wireCards(listEl, async function (act, id, card) {
    await api(act === 'done' ? 'review_done' : 'review_snooze', { id: id });
    await fileAway(card, act === 'done' ? 'done' : 'snooze', 'Nothing needs review.');
  });
  garnishEl.addEventListener('change', load);
  load();
}

// ---- inbox view ---------------------------------------------------------

async function renderInbox() {
  view.innerHTML = '<div class="stack"><h2>Inbox</h2><div id="ilist" class="list"></div></div>';
  var listEl = document.getElementById('ilist');
  async function load() {
    Okb.working(listEl, 'loading');
    var rows;
    try { rows = await api('inbox_list', {}); }
    catch (e) { listEl.innerHTML = errorBox(e); return; }
    if (!rows.length) { listEl.innerHTML = '<div class="empty">Inbox is empty.</div>'; return; }
    listEl.innerHTML = rows.map(function (r) {
      return '<div class="card" data-id="' + esc(r.id) + '">' +
        '<div class="title">' + conceptLink(r.id, r.title) + '</div>' +
        '<div class="why"><code>' + esc(r.id) + '</code> · ' + dateOf(r.timestamp) + '</div>' +
        cardActions(r.id, '<button class="small" data-act="read">Mark read</button>') + '</div>';
    }).join('');
    Okb.enter(listEl);
  }
  wireCards(listEl, async function (act, id, card) {
    await api('inbox_read', { id: id });
    await fileAway(card, 'done', 'Inbox is empty.');
  });
  load();
}

// ---- add view (capture / clip / rss / import / bookmarklet) ----------------

/** The clip bookmarklet as a chip to drag to the bookmarks bar (Add, Settings). */
function showBookmarklet() {
  working('bm-out', 'loading');
  get('/api/bookmarklet').then(function (r) {
    var el = document.getElementById('bm-out');
    if (!el) return;
    var a = document.createElement('a');
    a.href = r.bookmarklet;
    a.textContent = 'Clip to okbrain';
    a.className = 'chip';
    a.title = 'drag me to your bookmarks bar';
    el.replaceChildren(a);
    el.insertAdjacentHTML('beforeend', ' <span class="muted">drag this to your bookmarks bar; clicking it on any page clips that page (needs okb serve on port ' + esc(r.port) + ')</span>');
  }).catch(function (e) { setHtml('bm-out', errorBox(e)); });
}

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
    '<label class="row" style="gap:5px"><input type="checkbox" id="clip-auto"> auto-tag (AI)</label>' +
    '<button>Clip</button></form><div id="clip-out"></div>' +
    '<p class="muted">Clipped pages arrive as <code>references/</code> concepts with the page recorded under <code>sources</code>.</p>' +
    '<h3>Bookmarklet</h3><div id="bm-out"></div>' +
    '<h3>Pull RSS feeds</h3><form id="rssf" class="row">' +
    '<input id="rss-url" style="flex:1" placeholder="feed URL (empty = every configured rss.feeds entry)">' +
    '<button>Pull</button></form><div id="rss-out"></div>' +
    '<h3>Import markdown (server-side path)</h3>' +
    '<form id="impf" class="row">' +
    '<input id="imp-path" style="flex:1" placeholder="/path/to/file-or-directory on the okb host">' +
    '<input id="imp-dest" placeholder="dest dir (optional)" style="width:150px">' +
    '<label class="row" style="gap:5px"><input type="checkbox" id="imp-over"> overwrite</label>' +
    '<button>Import</button></form><div id="imp-out"></div></div>';

  var out = setHtml;
  function done(el, id, label) {
    out(el, '<div class="notice">' + esc(label) + ' — ' + conceptLink(id, 'open') + '</div>');
  }
  showBookmarklet();

  document.getElementById('capf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = document.getElementById('cap-text').value.trim();
    if (!text) return;
    var params = { text: text };
    var tags = document.getElementById('cap-tags').value.trim();
    if (tags) params.tags = tags;
    working('cap-out', 'capturing');
    try {
      var r = await api('capture', params);
      var form = document.getElementById('capf');
      if (form) form.reset();
      done('cap-out', r.id, (r.created ? 'captured ' : 'updated ') + r.id);
    } catch (err) { out('cap-out', errorBox(err)); }
  });

  document.getElementById('clipf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var url = document.getElementById('clip-url').value.trim();
    if (!url) return;
    var params = { url: url };
    if (document.getElementById('clip-read').checked) params.read = true;
    if (document.getElementById('clip-auto').checked) params['auto-tag'] = true;
    working('clip-out', 'clipping');
    try {
      var r = await api('clip', params);
      var msg = r.deduped
        ? 'already clipped as ' + r.id + (r.appended ? ' — highlight appended' : '')
        : 'clipped ' + r.id + (r.autoTags && r.autoTags.length ? ' — tagged ' + r.autoTags.join(', ') : '');
      done('clip-out', r.id, msg);
    } catch (err) { out('clip-out', errorBox(err)); }
  });

  document.getElementById('rssf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var url = document.getElementById('rss-url').value.trim();
    working('rss-out', 'pulling');
    try {
      var feeds = await appWork(api('rss', url ? { url: url } : {}));
      out('rss-out', '<div class="notice">' + esc(feeds.map(function (f) {
        if (f.error) return (f.feed || f.url) + ' — failed: ' + f.error;
        return (f.feed || f.url) + ': ' + f.added.length + ' added, ' + f.deduped + ' known';
      }).join('\n')) + '</div>');
    } catch (err) { out('rss-out', errorBox(err)); }
  });

  document.getElementById('impf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var path = document.getElementById('imp-path').value.trim();
    if (!path) return;
    var params = { path: path };
    var dest = document.getElementById('imp-dest').value.trim();
    if (dest) params.dest = dest;
    if (document.getElementById('imp-over').checked) params.overwrite = true;
    working('imp-out', 'importing');
    try {
      var r = await appWork(api('import', params));
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
    if (confidence === '') { document.getElementById('t-msg').textContent = 'confidence is required (0–100)'; return; }
    var params = { statement: statement, confidence: parseInt(confidence, 10) };
    ['resolve-by', 'tags', 'body'].forEach(function (n) {
      var v = document.getElementById('t-' + n).value.trim();
      if (v) params[n] = v;
    });
    working('t-msg', 'staking');
    try {
      var r = await api('take', params);
      var form = document.getElementById('tf');
      if (form) form.reset();
      setHtml('t-msg', 'staked ' + conceptLink(r.id) + ' at ' + r.confidence + '%');
      loadCalibration();
    } catch (err) { setHtml('t-msg', ''); setHtml('c-out', errorBox(err)); }
  });

  async function loadCalibration(first) {
    var el = document.getElementById('c-out');
    if (!el) return;
    if (first) Okb.working(el, 'scoring');
    var before = figures(el);
    var c;
    try { c = await api('calibrate', {}); }
    catch (e) { el.innerHTML = errorBox(e); return; }
    var total = c.open.length + c.correct + c.incorrect + c.void;
    if (!total) { el.innerHTML = '<div class="empty">No claims yet — stake one above.</div>'; return; }
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
          '<div class="title">' + (o.overdue ? '<span class="chip warn">overdue</span> ' : '') + conceptLink(o.id, o.title) + '</div>' +
          '<div class="why">' + (o.confidence === null ? '?' : o.confidence + '%') +
          (o.resolveBy ? ' · resolve by ' + esc(o.resolveBy) : '') + '</div>' +
          '<div class="row"><button class="small" data-act="correct">Correct</button>' +
          '<button class="small" data-act="incorrect">Incorrect</button>' +
          '<button class="small" data-act="void">Void</button></div></div>';
      }).join('');
    }
    el.innerHTML = h;
    flashChanged(el, before);
  }

  document.getElementById('c-out').addEventListener('click', async function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var card = btn.closest('.card');
    btn.closest('.row').querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      await api('resolve', { id: card.getAttribute('data-id'), outcome: btn.getAttribute('data-act') });
      await Okb.fileAway(card, 'done');
      loadCalibration();
    } catch (err) { setHtml('c-out', errorBox(err)); }
  });

  loadCalibration(true);
}

// ---- stats view (stats / orphans / path) --------------------------------

async function renderStats() {
  view.innerHTML =
    '<div class="stack wide"><h2>Stats</h2><div id="st-out"></div>' +
    '<h3>Path between two concepts</h3>' +
    '<form id="pf" class="row">' +
    '<input id="p-from" placeholder="from id"><span class="muted">→</span>' +
    '<input id="p-to" placeholder="to id"><button class="primary">Find path</button></form>' +
    '<div id="p-out"></div>' +
    '<h3>Orphans (no links in or out)</h3><div id="or-out"></div></div>';
  working('st-out', 'counting');
  working('or-out', 'loading');

  try {
    var s = await api('stats', {});
    setTypes(s.byType.map(function (t) { return t.type; }));
    var h = '<div class="tiles">' +
      tile('Concepts', s.concepts) + tile('Links', s.edges + (s.typedEdges ? ' · ' + s.typedEdges + ' typed' : '')) +
      tile('Tags', s.tags) + tile('Orphans', s.orphans) + tile('Inbox', s.inbox) +
      tile('Never reviewed', s.neverReviewed) + tile('Untouched >' + s.staleDays + 'd', s.stale) +
      tile('Past stale_after', s.expired, s.expired ? 'alert' : '') + '</div>' +
      '<h3>Lifecycle &amp; trust (OKF v0.2)</h3><div class="tiles">' +
      tile('Draft', s.byStatus.draft) + tile('Stable', s.byStatus.stable) + tile('Deprecated', s.byStatus.deprecated) +
      tile('Unverified', s.byTrust.unverified) + tile('Machine-confirmed', s.byTrust['machine-confirmed']) +
      tile('Human-reviewed', s.byTrust['human-reviewed'], 'good') + '</div>';
    if (s.byType.length) h += '<h3>By type</h3><div class="row">' +
      s.byType.map(function (t) { return typeChip(t.type, t.count); }).join(' ') + '</div>';
    if (s.topTags.length) h += '<h3>Top tags</h3><div class="row">' +
      s.topTags.map(function (t) { return '<span class="chip">' + esc(t.tag) + ' ' + t.count + '</span>'; }).join(' ') + '</div>';
    if (s.newest) h += '<p class="muted">freshest ' + dateOf(s.newest) + ' · oldest ' + dateOf(s.oldest) + '</p>';
    setHtml('st-out', h);
  } catch (e) { setHtml('st-out', errorBox(e)); }

  document.getElementById('pf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var from = document.getElementById('p-from').value.trim();
    var to = document.getElementById('p-to').value.trim();
    var el = document.getElementById('p-out');
    if (!from || !to) return;
    Okb.working(el, 'searching');
    try {
      var hops = await api('graph_path', { from: from, to: to });
      if (!hops) { el.innerHTML = '<div class="empty">No path found.</div>'; return; }
      el.innerHTML = '<div class="notice">' + hops.map(function (hp, i) {
        return (i === 0 ? '' : ' ' + DIR_MARK[hp.dir] + ' ') + conceptLink(hp.id, hp.title);
      }).join('') + '</div>';
    } catch (err) { el.innerHTML = errorBox(err); }
  });

  try {
    var os = await api('orphans', {});
    setHtml('or-out', os.length
      ? '<ul class="plain">' + os.map(function (o) {
          return '<li>' + conceptLink(o.id, o.title) + ' <a href="' + graphHref(o.id) + '" class="muted">graph</a></li>';
        }).join('') + '</ul>'
      : '<div class="empty">No orphans.</div>');
  } catch (e) { setHtml('or-out', errorBox(e)); }
}

// ---- settings view ------------------------------------------------------

async function renderSettings() {
  var st = STATUS || {};
  var mcpCmd = 'okb mcp --bundle ' + (st.bundle || '<bundle>');
  var mcpJson = JSON.stringify({ mcpServers: { okbrain: { command: 'okb', args: ['mcp', '--bundle', st.bundle || '<bundle>'] } } }, null, 2);
  view.innerHTML =
    '<div class="stack"><h2>Settings</h2>' +
    '<h3>This server</h3><dl class="kv">' +
    '<dt>okbrain</dt><dd>' + esc(st.version || '?') + ' · writes OKF ' + esc(st.okfVersion || '?') + '</dd>' +
    '<dt>Bundle</dt><dd><code>' + esc(st.bundle || '?') + '</code>' + (st.brain ? ' (brain <strong>' + esc(st.brain) + '</strong>)' : '') +
    (st.readonly ? ' <span class="chip warn">read-only</span>' : '') + '</dd>' +
    '<dt>Caches</dt><dd>' + (st.hasIndex ? 'index ✓' : 'no index') + ' · ' + (st.hasVectors ? 'vectors ✓' : 'no vectors') + '</dd>' +
    '<dt>Port</dt><dd>' + esc(st.port || '?') + ' (127.0.0.1 only)</dd></dl>' +
    '<h3>Identity</h3><form id="actf" class="row">' +
    '<label class="field" style="flex:1"><span>Actor (generated.by / verified.by on your writes)</span>' +
    '<input id="act-in" value="' + esc(st.actor || '') + '" placeholder="human:alice"></label>' +
    '<button>Save</button></form><div id="act-out"></div>' +
    '<h3>AI providers (persisted by okb init)</h3>' +
    '<form id="setf" class="stack"><div class="grid">' +
    field('provider', 'Chat provider', '', 'anthropic | openai | gemini | openrouter | local') +
    field('model', 'Chat model', '', 'provider default') +
    field('embed-provider', 'Embed provider', '', 'openai | voyage | gemini | local') +
    field('embed-model', 'Embed model', '', 'provider default') +
    '</div><div class="row"><label class="field"><span>Retrieval profile</span>' +
    '<select id="ed-retrieval-profile"><option value="">(keep)</option>' +
    '<option>lean</option><option>balanced</option><option>max</option></select></label>' +
    '<button>Save</button></div></form>' +
    '<div id="set-out"></div><p class="muted">API keys are read from environment variables only (ANTHROPIC_API_KEY, OPENAI_API_KEY, …); a local provider needs none.</p>' +
    '<h3>Sync (git)</h3><div class="row">' +
    '<button id="sync-status">Status</button><button id="sync-run">Sync now</button></div>' +
    '<div id="sync-out"></div>' +
    '<h3>Enrichment (guardrailed web pass)</h3>' +
    '<form id="enrf" class="stack"><div class="grid">' +
    field('web-seed', 'Seed URLs', '', 'comma-separated http(s) URLs') +
    field('task', 'Task', '', 'what to improve (optional)') +
    field('concept', 'Focus concept', '', 'existing concept id (optional)') +
    field('web-max-pages', 'Max pages', '', '5') +
    field('web-max-depth', 'Max depth', '', '1') +
    field('allow-host', 'Allowed hosts', '', 'default: the seeds’ hosts') +
    field('deny-path', 'Denied path prefixes', '', 'e.g. /admin,/login') +
    '<label class="field"><span>Web</span><select id="ed-no-web"><option value="">on</option><option value="1">off (--no-web)</option></select></label>' +
    '</div><div class="row"><button>Run enrich</button></div></form>' +
    '<div id="enr-out"></div>' +
    '<h3>Maintenance</h3><div class="row">' +
    '<button id="mx-index">Re-index</button><button id="mx-embed">Embed</button>' +
    '<button id="mx-doctor">Doctor</button><button id="mx-viz">Export viz.html</button>' +
    '<button id="mx-rebuild" class="danger">Rebuild (wipe + reindex)</button></div>' +
    '<div class="row"><span class="muted">Jobs:</span>' +
    ['index', 'embed', 'rss', 'review', 'doctor'].map(function (j) {
      return '<label class="row" style="gap:4px"><input type="checkbox" class="jobcb" value="' + j + '" checked> ' + j + '</label>';
    }).join('') + '<button id="mx-jobs">Run jobs</button></div>' +
    '<div class="row"><span class="muted">OKF v0.2 migration:</span><button id="mx-upgrade-dry">Preview upgrade</button>' +
    '<button id="mx-upgrade">Upgrade bundle</button></div><div id="mx-out"></div>' +
    '<h3>Agent access (MCP)</h3><p class="muted">Servers cannot start servers — run this in a terminal (add <code>--trusted</code> to expose write tools to a client you fully trust):</p>' +
    '<pre>' + esc(mcpCmd) + '</pre><p class="muted">Claude Desktop / any MCP client config:</p><pre>' + esc(mcpJson) + '</pre>' +
    '<h3>Bookmarklet</h3><div id="bm-out"></div></div>';

  var show = setHtml;
  showBookmarklet();

  document.getElementById('actf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var actor = document.getElementById('act-in').value.trim();
    if (!actor) return;
    working('act-out', 'saving');
    try {
      var r = await api('init', { actor: actor, 'no-default-bundle': true });
      show('act-out', '<div class="notice">actor: ' + esc(r.actor) + '</div>');
      refreshStatus();
    } catch (err) { show('act-out', errorBox(err)); }
  });
  document.getElementById('setf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var params = { 'no-default-bundle': true };
    ['provider', 'model', 'embed-provider', 'embed-model', 'retrieval-profile'].forEach(function (n) {
      var v = document.getElementById('ed-' + n).value.trim();
      if (v) params[n] = v;
    });
    working('set-out', 'saving');
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
    ['web-seed', 'task', 'concept', 'allow-host', 'deny-path'].forEach(function (n) {
      var v = document.getElementById('ed-' + n).value.trim();
      if (v) params[n] = v;
    });
    ['web-max-pages', 'web-max-depth'].forEach(function (n) {
      var v = document.getElementById('ed-' + n).value.trim();
      if (v) params[n] = parseInt(v, 10);
    });
    if (document.getElementById('ed-no-web').value) params['no-web'] = true;
    working('enr-out', 'enriching');
    try {
      var r = await appWork(api('enrich', params));
      show('enr-out', '<div class="notice">' + esc(
        r.fetched.map(function (u) { return 'fetched ' + u; })
          .concat(r.written.map(function (w) { return (w.created ? 'created ' : 'enriched ') + w.id; }))
          .concat([(r.summary || '(no summary)') + ' — ' + r.steps + ' steps']).join('\n')) + '</div>');
    } catch (err) { show('enr-out', errorBox(err)); }
  });
  document.getElementById('sync-status').addEventListener('click', async function () {
    working('sync-out', 'checking');
    try { show('sync-out', jsonNotice(await api('sync', { status: true }))); }
    catch (e) { show('sync-out', errorBox(e)); }
  });
  document.getElementById('sync-run').addEventListener('click', async function () {
    working('sync-out', 'syncing');
    try { show('sync-out', jsonNotice(await appWork(api('sync', {})))); }
    catch (e) { show('sync-out', errorBox(e)); }
  });
  async function maint(op, verb, params, render) {
    working('mx-out', verb);
    try { show('mx-out', (render || jsonNotice)(await appWork(api(op, params || {})))); await refreshStatus(); }
    catch (e) { show('mx-out', errorBox(e)); }
  }
  document.getElementById('mx-index').addEventListener('click', function () { maint('index', 'indexing'); });
  document.getElementById('mx-embed').addEventListener('click', function () { maint('embed', 'embedding'); });
  document.getElementById('mx-doctor').addEventListener('click', function () { maint('doctor', 'checking', {}, doctorSummary); });
  document.getElementById('mx-viz').addEventListener('click', function () {
    maint('export_viz', 'exporting', {}, function (r) { return '<div class="notice">wrote ' + esc(r.path) + ' (' + r.nodes + ' concepts, ' + r.edges + ' links)</div>'; });
  });
  document.getElementById('mx-rebuild').addEventListener('click', function () {
    if (!confirm('Rebuild wipes the derived index and rebuilds it from the bundle. Continue?')) return;
    maint('rebuild', 'rebuilding', { 'confirm-destructive': true });
  });
  document.getElementById('mx-jobs').addEventListener('click', function () {
    var only = Array.prototype.map.call(document.querySelectorAll('.jobcb:checked'), function (cb) { return cb.value; });
    if (!only.length) return;
    maint('jobs', 'running jobs', { only: only.join(',') }, function (rs) {
      return '<div class="notice">' + esc(rs.map(function (j) {
        return (j.skipped ? '[skip] ' : j.ok ? '[ ok ] ' : '[FAIL] ') + j.name + ' — ' + j.detail;
      }).join('\n')) + '</div>';
    });
  });
  var upgradeRender = function (u) {
    var verb = u.dryRun ? 'would upgrade' : 'upgraded';
    return '<div class="notice">' + esc(u.upgraded.map(function (x) { return verb + ' ' + x.id + ' — ' + x.changes.join(', '); })
      .concat([u.upgraded.length + ' ' + verb + ', ' + u.unchanged + ' already v' + u.okfVersion +
        (u.declared ? '; root index.md declares okf_version ' + u.okfVersion : '')]).join('\n')) + '</div>';
  };
  document.getElementById('mx-upgrade-dry').addEventListener('click', function () { maint('upgrade', 'previewing', { 'dry-run': true }, upgradeRender); });
  document.getElementById('mx-upgrade').addEventListener('click', function () {
    if (!confirm('Rewrite v0.1 conventions (timestamp, # Citations, last_reviewed) as OKF v0.2 frontmatter across the bundle?')) return;
    maint('upgrade', 'upgrading', {}, upgradeRender);
  });
}

// ---- boot ----------------------------------------------------------------

Okb.wordmark(document.querySelector('#nav .brand strong'));
refreshStatus().then(function () { loadBrains(); route(); });
