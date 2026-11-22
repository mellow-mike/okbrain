// okbrain GUI: a vanilla single-page app over the local API. No build step,
// no framework — served as-is by api.ts and embedded into the compiled
// binary via Bun text imports. Every data access goes through /api/op/* (the
// ops contract) or one of the small server routes (status, brain mounts,
// bookmarklet, personal source uploads); this file is presentation only. Rendering helpers shared
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

async function get(path, scoped) {
  var res = await fetch(path, { headers: scoped === false ? { 'x-okb-token': TOKEN } : headers(), cache: 'no-store' });
  var body = await res.json();
  if (!res.ok) {
    var error = new Error(body.error || res.statusText);
    error.code = body.code;
    throw error;
  }
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
var activeGraph = null;
function themeChanged() {
  themeBtn.textContent = Okb.theme.get() === 'dark' ? '☼ light' : '☾ dark';
  activeGraph?.repaint();
}
themeChanged();
new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
themeBtn.addEventListener('click', function () { Okb.theme.toggle(themeBtn); });

// ---- shell: status, brains, quick search ------------------------------------

function rememberBrain(name) {
  BRAIN = name;
  try {
    if (name) localStorage.setItem('okb-gui-brain', name);
    else localStorage.removeItem('okb-gui-brain');
  } catch (err) {}
}

async function refreshStatus() {
  var el = document.getElementById('nav-status');
  var selected = BRAIN;
  try {
    var status = await get('/api/status');
    if (selected !== BRAIN) return;
    STATUS = status;
    document.getElementById('nav-brain').textContent = STATUS.brain || basename(STATUS.bundle);
    el.innerHTML =
      '<div><span class="dot' + (STATUS.hasIndex ? ' on' : '') + '"></span>index' +
      ' <span class="dot' + (STATUS.hasVectors ? ' on' : '') + '"></span>vectors</div>' +
      '<div>okb ' + esc(STATUS.version) + ' · OKF ' + esc(STATUS.okfVersion) +
      (STATUS.readonly ? ' · <span class="chip warn">read-only</span>' : '') + '</div>';
  } catch (e) {
    if (selected !== BRAIN) return;
    if (selected && e.code === 'unknown_brain') {
      rememberBrain('');
      await loadBrains().catch(function () {});
      return refreshStatus();
    }
    STATUS = null;
    el.innerHTML = '<span class="error">' + esc(e.message) + '</span>';
  }
}

async function loadBrains() {
  var sel = document.getElementById('brain');
  try {
    var r = await get('/api/brains', false);
    if (BRAIN && !r.brains.some(function (mount) { return mount.name === BRAIN && mount.exists; }))
      rememberBrain('');
    sel.innerHTML = '<option value="">served bundle</option>' + r.brains.map(function (b) {
      return '<option value="' + esc(b.name) + '"' + (b.name === BRAIN ? ' selected' : '') + (b.exists ? '' : ' disabled') + '>' +
        esc(b.name) + (b.readonly ? ' (read-only)' : '') + (b.exists ? '' : ' (missing)') + '</option>';
    }).join('');
    sel.hidden = !r.brains.length;
    return r;
  } catch (e) {
    sel.hidden = true;
    throw e;
  }
}
document.getElementById('brain').addEventListener('change', function (e) {
  rememberBrain(e.target.value);
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
  coding: (arg, seq) => window.okbCoding.mount(view, arg, () => stale(seq), STATUS?.readonly === true),
  home: renderHome, browse: renderBrowse, concept: renderConcept, edit: renderEdit,
  editor: renderEdit, graph: renderGraph, search: renderSearch, ask: renderAsk,
  accounts: renderAccounts, 'ask-plan': renderPlanAsk, map: renderFocusedMap,
  add: renderAdd, sources: renderSources, review: renderReview, inbox: renderInbox, 'inbox-file': renderInboxFiling, claims: renderClaims,
  stats: renderStats, settings: renderSettings,
};

var DIR_MARK = { out: '→', in: '←', both: '↔' };

// Every render gets a generation number; async work checks `stale(seq)` after
// each await so a render abandoned by navigation never touches the new view.
var gen = 0;
var activeAsk = null;
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
  activeAsk?.abort();
  activeAsk = null;
  var h = location.hash.slice(1) || 'home';
  var slash = h.indexOf('/');
  var name = slash < 0 ? h : h.slice(0, slash);
  var arg = null;
  try { if (slash >= 0) arg = decodeURIComponent(h.slice(slash + 1)); }
  catch (error) { name = 'home'; }
  if (!Object.hasOwn(routes, name)) name = 'home';
  var fn = routes[name];
  var seq = ++gen;
  var shared = name === 'concept' && carry && carry.getAttribute('href') === location.hash ? carry : null;
  carry = null;
  return Okb.go(function () {
    activeGraph?.destroy();
    activeGraph = null;
    document.querySelectorAll('#nav > a').forEach(function (a) { // not the wordmark's link
      var target = a.getAttribute('data-nav') || a.getAttribute('href').slice(1);
      var active = target === name || (name === 'editor' && target === 'edit') || (name === 'ask-plan' && target === 'ask') ||
        (name === 'inbox-file' && target === 'inbox');
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    view.className = name === 'graph' ? 'bare' : '';
    view.scrollTop = 0;
    return fn(arg, seq);
  }, shared);
}
window.addEventListener('hashchange', route);
document.querySelector('.skip-link').addEventListener('click', function (event) {
  event.preventDefault();
  view.focus();
});

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
    '<a href="' + conceptHref(id) + '" class="link-button small">Open</a>' +
    '<button class="small" data-act="suggest">Suggest links</button>' +
    '<a href="' + graphHref(id) + '" class="link-button small">Graph</a></div>' +
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

async function mountBrainStarter(panel, seq) {
  try {
    var templates = await api('brain_templates', {});
    if (stale(seq) || panel.hidden || !templates.length) return;
    panel.innerHTML = '<form class="card stack"><h3>Start with a template</h3>' +
      '<label class="field"><span>Starter template</span><select name="template" required>' +
      '<option value="">Choose a starter</option>' + templates.map(function (template) {
        return '<option value="' + esc(template.name) + '">' + esc(template.title) + '</option>';
      }).join('') + '</select></label><div data-template-preview aria-live="polite"></div>' +
      '<div class="row"><button type="submit" disabled>Create starter guide</button><span role="status"></span></div></form>';
    var form = panel.querySelector('form');
    var select = form.elements.template;
    var submit = form.querySelector('button');
    var preview = form.querySelector('[data-template-preview]');
    var message = form.querySelector('[role="status"]');
    select.addEventListener('change', function () {
      var template = templates.find(function (option) { return option.name === select.value; });
      submit.disabled = !template;
      message.textContent = '';
      preview.innerHTML = template
        ? '<p class="muted">' + esc(template.description) + ' This adds one editable Markdown guide.</p>' + chips(template.tags)
        : '';
    });
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!select.value || submit.disabled) return;
      select.disabled = submit.disabled = true;
      Okb.working(message, 'creating guide');
      var brain = BRAIN;
      try {
        var result = await api('init', { template: select.value, 'no-default-bundle': true });
        if (!stale(seq) && BRAIN === brain) location.hash = conceptHref(result.starter.id);
      } catch (error) {
        if (!stale(seq)) message.innerHTML = errorBox(error);
      } finally { select.disabled = submit.disabled = false; }
    });
  } catch (error) {
    if (!stale(seq) && !panel.hidden) panel.innerHTML = errorBox(error);
  }
}

async function renderHome(_arg, seq) {
  var name = STATUS ? (STATUS.brain || basename(STATUS.bundle)) : 'your brain';
  var readonly = STATUS && STATUS.readonly;
  view.innerHTML =
    '<div class="stack wide"><h2 class="display">' + esc(name) + '</h2>' +
    '<div id="h-index"></div><div id="h-tiles"></div><section id="h-starter" hidden></section>' +
    (readonly ? '' : '<form id="h-cap" class="card stack"><label class="field"><span>Quick note</span>' +
    '<textarea rows="2" id="h-cap-text" placeholder="Capture a thought…" required></textarea></label>' +
    '<div class="row"><button class="primary">Capture</button><span id="h-cap-msg" class="muted" role="status"></span></div></form>') +
    '<div class="split"><div><h3>Worth another look</h3><div id="h-review" class="list"></div></div>' +
    '<div><h3>Inbox</h3><div id="h-inbox" class="list"></div></div>' +
    '<div><h3>Recently changed</h3><div id="h-recent"></div></div></div>' +
    '<h3>Health</h3><div class="row"><button id="h-doctor">Check conformance</button>' +
    '<a href="#stats" class="link-button">Stats</a><a href="#settings" class="link-button">Settings</a></div>' +
    '<div id="h-doctor-out"></div></div>';

  if (STATUS && !STATUS.hasIndex) {
    if (readonly) document.getElementById('h-index').innerHTML =
      '<div class="notice">This read-only brain has no local search index. <a href="#browse">Browse its notes</a>.</div>';
    else document.getElementById('h-index').innerHTML =
      '<section class="card start-panel" aria-labelledby="h-start"><h3 id="h-start">Get started</h3>' +
      '<p>Capture a quick note or import a source. Build the local index to search, map, and review your notes offline.</p>' +
      '<div class="row"><a href="#sources">Import a source</a>' +
      '<button id="h-build" class="primary small" type="button">Enable search and review</button></div><div id="h-build-out" role="status"></div></section>';
  }
  if (document.getElementById('h-build')) {
    document.getElementById('h-build').addEventListener('click', async function () {
      this.disabled = true;
      working('h-build-out', 'building the local index');
      try {
        await appWork(api('index', {}));
        await refreshStatus();
        if (!stale(seq)) {
          await route();
          var summary = document.getElementById('h-index');
          if (summary) {
            summary.innerHTML = '<p role="status">Local index ready. <a href="#search">Search notes</a> · <a href="#review">Open review queue</a></p>';
            summary.querySelector('a').focus();
          }
        }
      } catch (e) {
        if (!stale(seq)) setHtml('h-build-out', errorBox(e));
        this.disabled = false;
      }
    });
  }

  var capture = document.getElementById('h-cap');
  if (capture) capture.addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = document.getElementById('h-cap-text').value.trim();
    if (!text) return;
    var msg = document.getElementById('h-cap-msg');
    var submit = capture.querySelector('button');
    submit.disabled = true;
    Okb.working(msg, 'capturing');
    try {
      var r = await api('capture', { text: text });
      if (stale(seq)) return;
      document.getElementById('h-cap-text').value = '';
      msg.innerHTML = 'Note saved. ' + conceptLink(r.id, 'Open saved note') + ' · <a href="#inbox">Open inbox</a>';
      msg.querySelector('a').focus();
      loadInboxPreview();
      loadTiles();
      loadRecent();
    } catch (err) { msg.innerHTML = errorBox(err); }
    finally { submit.disabled = false; }
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
              '<div class="row">' + reviewClaimLink(it) + '<button class="small" data-act="done" title="records a verified event by you">Reviewed ✓</button>' +
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
      if (stale(seq)) return;
      var starter = document.getElementById('h-starter');
      starter.hidden = !!readonly || rows.length > 0;
      if (!starter.hidden && !starter.hasChildNodes()) mountBrainStarter(starter, seq);
      setTypes(rows.map(function (r) { return r.type; }));
      rows.sort(function (a, b) { return (b.updated || '') < (a.updated || '') ? -1 : 1; });
      el.innerHTML = rows.length
        ? '<table class="tbl">' + rows.slice(0, 8).map(function (r) {
            return '<tr><td>' + conceptLink(r.id, r.title) + '<br>' + badges(r) + '</td>' +
              '<td class="nowrap muted">' + dateOf(r.updated) + '</td></tr>';
          }).join('') + '</table>' + (rows.length > 8 ? '<p class="muted"><a href="#browse">browse all ' + rows.length + '…</a></p>' : '')
        : '<div class="empty">No notes yet.' + (readonly ? '' : ' Capture one above or <a href="#sources">import conversations</a>.') + '</div>';
    } catch (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  document.getElementById('h-doctor').addEventListener('click', async function () {
    var out = document.getElementById('h-doctor-out');
    Okb.working(out, 'checking');
    try { out.innerHTML = doctorSummary(await api('doctor', {})); }
    catch (e) { out.innerHTML = errorBox(e); }
  });

  if (STATUS && STATUS.hasIndex) {
    loadTiles();
    loadReviewPreview();
  } else {
    setHtml('h-review', '<div class="empty">Review suggestions appear once this brain is indexed.</div>');
  }
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

async function renderBrowse(initialType, seq) {
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
  if (initialType && types.indexOf(initialType) < 0) types.push(initialType);
  types.sort();
  var typeSel = document.getElementById('b-type');
  types.forEach(function (t) {
    var o = document.createElement('option');
    o.value = t;
    o.textContent = t || '(untyped)';
    typeSel.appendChild(o);
  });
  if (initialType) typeSel.value = initialType;
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
  if (fm.type === 'forwarding' && typeof fm.filed_to === 'string') {
    view.innerHTML = '<div class="stack"><h2>' + esc(fm.title || id) + '</h2>' +
      '<p>This capture was filed at ' + conceptLink(fm.filed_to) + '.</p></div>';
    return;
  }
  var tags = Array.isArray(fm.tags) ? fm.tags : (typeof fm.tags === 'string' ? [fm.tags] : []);
  var inInbox = tags.indexOf('inbox') >= 0;
  var verified = Array.isArray(fm.verified) ? fm.verified : (fm.verified ? [fm.verified] : []);
  var sources = Array.isArray(fm.sources) ? fm.sources : (fm.sources ? [fm.sources] : []);
  var isComputation = String(fm.type || '').toLowerCase() === 'attested computation';

  var meta = '<dl class="kv">';
  if (fm.resource) meta += '<dt>Resource</dt><dd>' + R.resourceLink(fm.resource) + '</dd>';
  if (tags.length) meta += '<dt>Tags</dt><dd>' + chips(tags) + '</dd>';
  meta += '<dt>Generated</dt><dd>' + R.actorLine(fm.generated) + (fm.timestamp && !fm.generated ? ' <span class="muted">(v0.1 timestamp ' + esc(fm.timestamp) + ')</span>' : '') + '</dd>';
  meta += '<dt>Verified</dt><dd>' + (verified.length ? verified.map(R.actorLine).join('<br>') : '<span class="muted">never</span>') + '</dd>';
  if (fm.stale_after) meta += '<dt>Stale after</dt><dd>' + esc(fm.stale_after) + '</dd>';
  if (c.localUsage) {
    var uses = c.localUsage.note;
    meta += '<dt>Local usage</dt><dd>' + esc(uses.opens) + ' ' + (uses.opens === 1 ? 'open' : 'opens') + ' · ' +
      esc(uses.citations) + ' Ask ' + (uses.citations === 1 ? 'citation' : 'citations') +
      '<br><span class="muted">' + esc(uses.usage_window.from.slice(0, 10) + ' to ' + uses.usage_window.to.slice(0, 10)) + '</span></dd>';
  }
  meta += '<dt>Sources</dt><dd>' + R.sourcesList(sources, c.localUsage?.sources) + '</dd>';
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
    '<a href="' + editHref(id) + '" class="link-button primary small">Edit</a>' +
    '<button class="small" data-act="verify" title="records a verified event by you">Verified ✓</button>' +
    (inInbox ? '<button class="small" data-act="read">Mark read</button>' : '') +
    (inInbox ? inboxFileLink(id) : '') +
    '<button class="small" data-act="suggest">Suggest links</button>' +
    '<a href="' + graphHref(id) + '" class="link-button small">Graph</a>' +
    '<a href="' + mapHref(id) + '" class="link-button small">Focused map</a>' +
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
  var privateNote = fm.db_only === true || String(id || '').toLowerCase().split('/').slice(0, -1).includes('db_only');
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
    (!exists && !STATUS?.readonly ? '<label class="row"><input id="ed-private" type="checkbox"> Keep this note private</label>' : '') +
    '<div class="row">' +
    '<button class="primary">Save</button>' +
    '<select id="ed-linkpick"><option value="">insert link to…</option></select>' +
    (exists ? '<button type="button" id="ed-suggest">Suggest links</button>' : '') +
    (exists ? '<a href="' + conceptHref(id) + '" class="link-button">Cancel</a>' : '') +
    '<span id="ed-msg" class="muted"></span></div>' +
    (exists ? '<p class="muted">generated: ' + R.actorLine(fm.generated) + ' · verified: ' +
      (Array.isArray(fm.verified) ? fm.verified.length : fm.verified ? 1 : 0) + ' event(s)</p>' : '') +
    '</form>' + (exists && !STATUS?.readonly ? '<section class="card stack"><h3>Note privacy</h3>' +
      (privateNote ? '<p>Private to this brain by default.</p>' : '<p>Keep an unpublished note out of Git sync and shared exports.</p>' +
        '<div><button id="ed-keep-private" type="button">Keep note private</button></div><p id="ed-private-status" role="status"></p>') +
      '</section>' : '') + '<div id="ed-sugg"></div></div>';
  document.getElementById('ed-body').value = body;
  if (exists) document.getElementById('ed-id').readOnly = true;
  var protect = document.getElementById('ed-keep-private');
  if (protect) protect.addEventListener('click', async function () {
    if (!confirm('Keep this note private in this brain? Git history will stay as it is.')) return;
    protect.disabled = true;
    var status = document.getElementById('ed-private-status');
    try {
      await api('keep_private', { id: id });
      if (!stale(seq)) { protect.hidden = true; status.textContent = 'Private to this brain by default.'; }
    } catch (error) {
      if (!stale(seq)) status.innerHTML = errorBox(error);
      protect.disabled = false;
    }
  });

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
      if (document.getElementById('ed-private')?.checked) {
        if (!val('id')) throw new Error('Enter a concept ID to create a private note.');
        params.private = true;
      }
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

  setTypes(g.nodes.map(function (note) { return note.type; }));
  document.getElementById('gstats').textContent = g.nodes.length + ' concepts · ' + g.edges.length + ' links';
  activeGraph = window.okbGraphView.mount(g, {
    canvas: document.getElementById('gcy'),
    detail: document.getElementById('gdetail'),
    filters: document.getElementById('glegend'),
    search: document.getElementById('gsearch'),
    layout: document.getElementById('glayout'),
    fit: document.getElementById('gfit'),
  }, {
    descriptionClass: 'why',
    metadataClass: 'kv',
    actions: function (note) {
      return '<div class="row"><a href="' + conceptHref(note.id) + '" class="link-button small">Open</a>' +
        (STATUS?.readonly ? '' : '<a href="' + editHref(note.id) + '" class="link-button small">Edit</a>') + '</div>';
    },
  });
  if (focusId) activeGraph.focus(focusId);
}

// ---- search view --------------------------------------------------------

function renderSearch(initialQ) {
  view.innerHTML =
    '<div class="stack"><h2>Search</h2>' +
    '<form id="sf" class="stack">' +
    '<label class="field"><span>Search notes</span><input id="sq" type="search" placeholder="Search by keyword…" required></label>' +
    '<div class="row"><button class="primary">Search</button>' +
    '<label><input id="s-semantic" type="checkbox"> Use configured semantic retrieval</label>' +
    '<label class="field" id="s-profile-field" hidden><span>Retrieval profile</span>' +
    '<select id="s-profile"><option value="">Configured default</option><option>lean</option>' +
    '<option>balanced</option><option>max</option></select></label></div></form>' +
    '<div id="sout" class="list" aria-live="polite"></div></div>';
  var out = document.getElementById('sout');
  var qEl = document.getElementById('sq');
  var semantic = document.getElementById('s-semantic');
  var profile = document.getElementById('s-profile');
  semantic.addEventListener('change', function () {
    document.getElementById('s-profile-field').hidden = !semantic.checked;
  });
  document.getElementById('sf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var q = qEl.value.trim();
    if (!q) return;
    if (STATUS && !STATUS.hasIndex) {
      out.innerHTML = 'Build a local index from <a href="#home">Home</a> to search this brain.';
      return;
    }
    Okb.working(out, 'searching');
    var params = { query: q, 'keyword-only': !semantic.checked };
    if (semantic.checked && profile.value) params.profile = profile.value;
    try {
      var hits = await api('search', params);
      out.innerHTML = hits.length
        ? hits.map(function (h) {
            return '<div class="card"><div class="title">' + conceptLink(h.id, h.title) +
              ' <span class="muted">(' + h.score.toFixed(3) + ')</span></div>' +
              '<div class="why"><code>' + esc(h.id) + '</code> · ' + chips(h.sources) + '</div>' +
              (h.description ? '<div class="why">' + esc(h.description) + '</div>' : '') +
              (h.keywordExcerpt?.length ? '<div class="muted search-excerpt">' + h.keywordExcerpt.map(function (part) {
                return part.match ? '<mark>' + esc(part.text) + '</mark>' : esc(part.text);
              }).join('') + '</div>' : h.snippet ? '<div class="muted">' + esc(h.snippet.slice(0, 240)) + '…</div>' : '') +
              '<div class="row"><a href="' + conceptHref(h.id) + '" class="link-button small">Open</a>' +
              '<a href="' + editHref(h.id) + '" class="link-button small">Edit</a>' +
              '<a href="' + mapHref(h.id) + '">Focused map</a></div></div>';
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

async function readAnswerEvents(response, receive) {
  if (!response.ok) throw new Error((await response.json()).error || 'Could not start the answer.');
  if (!response.body) throw new Error('The answer stream is unavailable.');
  var reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  var buffer = '';
  try {
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      var end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        var frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        var newline = frame.indexOf('\n');
        if (newline < 0 || !frame.startsWith('event: ') || !frame.startsWith('data: ', newline + 1)) continue;
        var event = frame.slice(7, newline);
        var data = JSON.parse(frame.slice(newline + 7));
        if (event === 'error') throw new Error(data.error);
        receive(event, data);
        if (event === 'done') return;
      }
    }
    throw new Error('The answer stream ended early.');
  } finally {
    await reader.cancel().catch(function () {});
  }
}

function renderAsk(_arg, seq) {
  view.innerHTML =
    '<div class="stack"><h2>Ask your brain</h2>' +
    '<p><a href="#ask-plan">Ask with a ChatGPT plan</a></p>' +
    '<form id="askf" class="row">' +
    '<input id="askq" style="flex:1" aria-label="Question" placeholder="What do my notes say about…" maxlength="8000" required autofocus>' +
    '<select id="askp" aria-label="Retrieval profile"><option value="">Configured default</option><option>lean</option><option>balanced</option><option>max</option></select>' +
    '<label class="row"><input id="ask-private" type="checkbox"> Include private notes</label>' +
    '<button id="asksend" class="primary">Ask</button><button id="askstop" type="button" hidden>Stop</button></form>' +
    '<p id="askstatus" role="status"></p><div id="askctx"></div><div id="askout" class="md"></div><div id="asksrc"></div></div>';
  var ctxEl = document.getElementById('askctx');
  var outEl = document.getElementById('askout');
  var srcEl = document.getElementById('asksrc');
  var statusEl = document.getElementById('askstatus');
  var submit = document.getElementById('asksend');
  var stop = document.getElementById('askstop');
  stop.addEventListener('click', function () { activeAsk?.abort(); });
  document.getElementById('askf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var q = document.getElementById('askq').value.trim();
    if (!q || activeAsk) return;
    var request = new AbortController();
    activeAsk = request;
    submit.disabled = true;
    stop.hidden = false;
    statusEl.textContent = 'Finding sources…';
    var draft = document.createTextNode('');
    outEl.classList.add('ask-partial');
    outEl.replaceChildren(draft);
    ctxEl.replaceChildren();
    srcEl.replaceChildren();
    var profile = document.getElementById('askp').value;
    Okb.busy(true);
    try {
      var response = await fetch('/api/ask/stream', {
        method: 'POST', headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ question: q, profile: profile || undefined,
          'include-private': document.getElementById('ask-private').checked }), signal: request.signal,
      });
      await readAnswerEvents(response, function (event, data) {
        if (stale(seq)) return;
        if (event === 'context') {
          statusEl.textContent = 'Writing the answer…';
          ctxEl.innerHTML = data.length ? '<span class="muted">Reading</span> ' + citationLinks(data) : '';
        } else if (event === 'delta') {
          draft.appendData(data.text);
        } else if (event === 'done') {
          var result = data.result;
          statusEl.textContent = 'Answer ready.';
          outEl.classList.remove('ask-partial');
          outEl.innerHTML = R.renderMarkdown(result.answer);
          if (result.citations.length) srcEl.innerHTML = '<h3>Sources</h3>' + citationLinks(result.citations);
          Okb.settle(outEl);
        }
      });
    } catch (error) {
      if (!stale(seq)) statusEl.textContent = request.signal.aborted ? 'Answer stopped.' : error.message;
    } finally {
      if (activeAsk === request) activeAsk = null;
      submit.disabled = false;
      stop.hidden = true;
      Okb.busy(false);
    }
  });
}

// ---- review view --------------------------------------------------------

function reviewClaimLink(item) {
  return item.overdueClaim && !STATUS?.readonly
    ? '<a href="#claims/' + encodeURIComponent(item.id) + '" class="link-button small">Resolve claim</a>' : '';
}

async function renderReview() {
  view.innerHTML = '<div class="stack"><h2>Review</h2>' +
    '<p class="muted">A small daily queue with stated reasons. “Reviewed ✓” records a <code>verified</code> event by you (OKF trust tier: human-reviewed).</p>' +
    '<form id="rform" class="stack"><div class="row">' +
    '<label class="field">Queue size<input id="rlimit" type="number" min="1" step="1" placeholder="Default"></label>' +
    '<label class="field">Retrieval profile<select id="rprofile"><option value="">Default</option>' +
    '<option value="lean">Lean</option><option value="balanced">Balanced</option><option value="max">Max</option></select></label></div>' +
    '<label class="row"><input type="checkbox" id="rgarnish"> Ask the configured model to connect items to recent notes</label>' +
    '<div class="row"><button id="rload" type="submit">Update queue</button></div></form>' +
    (STATUS?.readonly ? '' : '<div class="row"><label class="field">Snooze days<input id="rdays" type="number" min="1" step="1" value="7" required></label></div>') +
    '<div id="rlist" class="list"></div></div>';
  var listEl = document.getElementById('rlist');
  var limitEl = document.getElementById('rlimit');
  var profileEl = document.getElementById('rprofile');
  var garnishEl = document.getElementById('rgarnish');
  var snoozeEl = document.getElementById('rdays');
  var loadButton = document.getElementById('rload');
  async function load() {
    var params = { garnish: garnishEl.checked };
    if (limitEl.value) params.limit = limitEl.valueAsNumber;
    if (profileEl.value) params.profile = profileEl.value;
    loadButton.disabled = true;
    Okb.working(listEl, 'scoring');
    var q;
    try { q = await (params.garnish ? appWork(api('review_queue', params)) : api('review_queue', params)); }
    catch (e) { listEl.innerHTML = errorBox(e); return; }
    finally { loadButton.disabled = false; }
    if (!q.length) { listEl.innerHTML = '<div class="empty">Nothing needs review.</div>'; return; }
    listEl.innerHTML = q.map(function (it) {
      return '<div class="card" data-id="' + esc(it.id) + '">' +
        '<div class="title">' + conceptLink(it.id, it.title) +
        ' <span class="muted">(' + it.score.toFixed(2) + ')</span></div>' +
        '<div class="why">' + esc(it.reasons.join('; ')) + '</div>' +
        (it.garnish ? '<div class="garnish">↳ ' + esc(it.garnish) + '</div>' : '') +
        cardActions(it.id, reviewClaimLink(it) + (snoozeEl ? '<button class="small" data-act="done">Reviewed ✓</button><button class="small" data-act="snooze">Snooze</button>' : '')) +
        '</div>';
    }).join('');
    Okb.enter(listEl);
  }
  wireCards(listEl, async function (act, id, card) {
    if (act === 'snooze' && !snoozeEl.reportValidity()) {
      card.querySelector('[data-act="snooze"]').disabled = false;
      return;
    }
    if (act === 'snooze') await api('review_snooze', { id: id, days: snoozeEl.valueAsNumber });
    else await api('review_done', { id: id });
    await fileAway(card, act === 'done' ? 'done' : 'snooze', 'Nothing needs review.');
  });
  document.getElementById('rform').addEventListener('submit', function (event) { event.preventDefault(); load(); });
  load();
}

// ---- inbox view ---------------------------------------------------------

function inboxFileLink(id) {
  return !STATUS?.readonly && id.split('/').at(-2) === 'inbox'
    ? '<a href="#inbox-file/' + encodeURIComponent(id) + '" class="link-button small">File note</a>' : '';
}

async function renderInboxFiling(id, seq) {
  if (!id || STATUS?.readonly) {
    view.innerHTML = '<p>Choose a capture from a writable <a href="#inbox">Inbox</a>.</p>';
    return;
  }
  view.innerHTML = '<div class="stack"><h2>File inbox note</h2>' +
    '<p>From ' + conceptLink(id) + '</p><form class="card stack">' +
    '<label class="field"><span>Destination concept ID</span><input name="destination" required maxlength="400" ' +
    'placeholder="projects/my-note" spellcheck="false" autocomplete="off"></label>' +
    '<p class="muted">Use a lowercase path without .md. A forwarding note will remain at the original address.</p>' +
    '<div class="row"><button type="submit">Preview filing</button><button type="button" data-file-confirm class="primary" disabled>Confirm filing</button></div>' +
    '<div role="status"></div></form><a href="#inbox">Back to Inbox</a></div>';
  var form = view.querySelector('form');
  var destination = form.elements.destination;
  var review = form.querySelector('[type="submit"]');
  var apply = form.querySelector('[data-file-confirm]');
  var result = form.querySelector('[role="status"]');
  var approved = null;
  var busy = false;
  destination.addEventListener('input', function () {
    approved = null;
    apply.disabled = true;
    result.textContent = '';
  });
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var path = destination.value.trim();
    if (!path || busy) return;
    busy = review.disabled = apply.disabled = true;
    approved = null;
    Okb.working(result, 'checking destination');
    try {
      var preview = await api('inbox_file', { id: id, destination: path });
      if (stale(seq) || destination.value.trim() !== path) return;
      approved = preview;
      result.innerHTML = '<strong>' + esc(preview.title) + '</strong> → <code>' + esc(preview.destination) + '</code>' +
        (preview.status === 'resume' ? '<p>The copy is saved. Confirm to finish filing the original.</p>' : '') +
        (preview.status === 'filed' ? '<p>Already filed. ' + conceptLink(preview.destination, 'Open filed note') + '</p>' : '');
    } catch (error) {
      if (!stale(seq) && destination.value.trim() === path) result.innerHTML = errorBox(error);
    } finally {
      busy = review.disabled = false;
      apply.disabled = !approved;
    }
  });
  apply.addEventListener('click', async function () {
    if (!approved || busy) return;
    busy = review.disabled = apply.disabled = destination.disabled = true;
    Okb.working(result, 'filing note');
    try {
      var filing = await api('inbox_file', { id: id, destination: approved.destination, confirm: approved.preview });
      if (!stale(seq)) {
        result.innerHTML = 'Note filed. ' + conceptLink(filing.destination, 'Open filed note');
        result.querySelector('a').focus();
      }
    } catch (error) {
      if (!stale(seq)) result.innerHTML = errorBox(error);
    } finally {
      approved = null;
      busy = review.disabled = destination.disabled = false;
    }
  });
}

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
        cardActions(r.id, '<button class="small" data-act="read">Mark read</button>' + inboxFileLink(r.id)) + '</div>';
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

function mountRssSettings(panel) {
  var form = panel.querySelector('form');
  var input = form.elements.feeds;
  var save = form.querySelector('button');
  var feedback = panel.querySelector('[role="status"]');
  function setEnabled(enabled) { input.disabled = save.disabled = !enabled; }
  function populate(result) { input.value = result.feeds.join('\n'); }
  get('/api/rss-settings').then(function (payload) {
    populate(payload.result);
    feedback.textContent = '';
    setEnabled(true);
  }).catch(function (error) { feedback.textContent = error.message; });
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    setEnabled(false);
    feedback.textContent = 'Saving feed URLs…';
    try {
      var response = await fetch('/api/rss-settings', {
        method: 'POST', headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ feeds: input.value }),
      });
      var payload = await response.json();
      if (!response.ok) throw new Error(payload.error || response.statusText);
      populate(payload.result);
      feedback.textContent = payload.result.feeds.length ? 'Feed URLs saved.' : 'Saved feed list cleared.';
    } catch (error) { feedback.textContent = error.message; }
    finally { setEnabled(true); }
  });
}

function renderAdd() {
  view.innerHTML =
    '<div class="stack"><h2>Add to your brain</h2>' +
    '<p>To bring over chats from ChatGPT or Claude, <a href="#sources">import conversations</a>.</p>' +
    '<h3>Quick capture</h3>' +
    '<form id="capf" class="stack">' +
    '<label class="field"><span>Note</span><textarea id="cap-text" rows="4" required></textarea></label>' +
    '<div class="grid"><label class="field"><span>Title</span><input id="cap-title" placeholder="First line by default"></label>' +
    '<label class="field"><span>Tags</span><input id="cap-tags" placeholder="Comma-separated"></label></div><div class="row">' +
    '<button class="primary">Capture</button></div></form><div id="cap-out"></div>' +
    '<h3>Clip a web page</h3>' +
    '<form id="clipf" class="stack">' +
    '<label class="field"><span>Page URL</span><input id="clip-url" type="url" placeholder="https://…" required></label>' +
    '<details><summary>Highlights and tags</summary><div class="stack">' +
    '<label class="field"><span>Quote</span><textarea id="clip-quote" rows="3"></textarea></label>' +
    '<label class="field"><span>Comment</span><textarea id="clip-note" rows="2"></textarea></label>' +
    '<label class="field"><span>Tags</span><input id="clip-tags" placeholder="Comma-separated"></label></div></details>' +
    '<div class="row">' +
    '<label class="row" style="gap:5px"><input type="checkbox" id="clip-read"> already read</label>' +
    '<label class="row" style="gap:5px"><input type="checkbox" id="clip-auto"> auto-tag (AI)</label>' +
    '<button>Clip</button></div></form><div id="clip-out"></div>' +
    '<p class="muted">Clipped pages arrive as <code>references/</code> concepts with the page recorded under <code>sources</code>.</p>' +
    '<h3>Bookmarklet</h3><div id="bm-out"></div>' +
    '<h3>Pull RSS feeds</h3><form id="rssf" class="stack"><div class="grid">' +
    '<label class="field"><span>Feed URL</span><input id="rss-url" type="url" placeholder="All configured feeds"></label>' +
    '<label class="field"><span>Max new items per feed</span><input id="rss-limit" type="number" min="0" placeholder="Configured default"></label>' +
    '</div><div class="row"><button>Pull</button></div></form><div id="rss-out"></div>' +
    (STATUS?.readonly ? '' : '<details id="rss-settings"><summary>Manage saved feeds</summary>' +
    '<form class="stack"><label class="field"><span>Feed URLs (one per line)</span>' +
    '<textarea name="feeds" rows="4" spellcheck="false" disabled></textarea></label>' +
    '<p class="muted">The saved list is shared across brain folders on this device. Pull saves entries in the selected brain.</p>' +
    '<div class="row"><button disabled>Save feed URLs</button><span role="status">Loading feed URLs…</span></div></form></details>') +
    '<h3>Import Markdown from disk</h3>' +
    '<form id="impf" class="stack">' +
    '<label class="field"><span>File or folder path on the okbrain server</span><input id="imp-path" required></label>' +
    '<div class="grid"><label class="field"><span>Destination folder</span><input id="imp-dest" placeholder="Brain root by default"></label>' +
    '<label class="field"><span>Type for files without one</span><input id="imp-type" placeholder="Note by default"></label></div><div class="row">' +
    '<label class="row" style="gap:5px"><input type="checkbox" id="imp-over"> overwrite</label>' +
    '<button>Import</button></div></form><div id="imp-out"></div></div>';

  var out = setHtml;
  function done(el, id, label) {
    out(el, '<div class="notice">' + esc(label) + ' — ' + conceptLink(id, 'open') + '</div>');
  }
  showBookmarklet();
  var rssSettings = document.getElementById('rss-settings');
  if (rssSettings) mountRssSettings(rssSettings);

  document.getElementById('capf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = document.getElementById('cap-text').value.trim();
    if (!text) return;
    var params = { text: text };
    var title = document.getElementById('cap-title').value.trim();
    var tags = document.getElementById('cap-tags').value.trim();
    if (title) params.title = title;
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
    ['quote', 'note', 'tags'].forEach(function (field) {
      var value = document.getElementById('clip-' + field).value.trim();
      if (value) params[field] = value;
    });
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
    var limit = document.getElementById('rss-limit').valueAsNumber;
    var params = url ? { url: url } : {};
    if (Number.isFinite(limit)) params.limit = limit;
    working('rss-out', 'pulling');
    try {
      var feeds = await appWork(api('rss', params));
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
    var type = document.getElementById('imp-type').value.trim();
    if (dest) params.dest = dest;
    if (type) params.type = type;
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

// ---- sources ------------------------------------------------------------

async function uploadConversations(file, provider, preview) {
  var requestHeaders = headers({ 'content-type': 'application/json' });
  if (preview) requestHeaders['x-okb-preview'] = preview;
  var res = await fetch('/api/conversations/upload?provider=' + encodeURIComponent(provider), {
    method: 'POST', headers: requestHeaders, body: file,
  });
  if (res.status === 413) throw new Error('Choose a conversations JSON file up to 128 MiB.');
  var body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body.result;
}

async function uploadSourceFiles(files, folder, kind, name, confirmation) {
  var requestHeaders = headers();
  var form = new FormData();
  form.set('name', name);
  form.set('paths', JSON.stringify(files.map(function (file) {
    return folder ? file.webkitRelativePath.split('/').slice(1).join('/') || file.name : file.name;
  })));
  for (var file of files) form.append('files', file, file.name);
  if (confirmation) {
    requestHeaders['x-okb-preview'] = confirmation.preview;
    form.set('selected', JSON.stringify(confirmation.selected));
  }
  var res = await fetch('/api/personal/sources/upload?kind=' + encodeURIComponent(kind), {
    method: 'POST', headers: requestHeaders, body: form,
  });
  var body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body.result;
}

var SOURCE_LABELS = { bookmarks: 'Browser bookmarks', markdown: 'Markdown library', notion: 'Notion workspace', email: 'Email archive', calendar: 'Calendar export' };
var SOURCE_EXTENSIONS = { email: '.eml', calendar: '.ics' };

function sourceFilesPanel(name, readonly) {
  return '<section class="card source-panel" aria-labelledby="source-files"><h3 id="source-files">Import files</h3>' +
    '<p>Preview bookmarks, Markdown, a Notion export, email, or calendar events. ' +
    'The selected items become private drafts in <strong>' + esc(name) + '</strong>.</p>' +
    (readonly ? '<p class="notice">Choose a writable brain to import files.</p>' :
    '<form id="source-files-form" class="source-panel"><div class="grid">' +
    '<label class="field"><span>File format</span><select id="source-kind">' +
    '<option value="bookmarks">Browser bookmarks (HTML)</option><option value="markdown">Markdown</option><option value="notion">Notion export</option>' +
    '<option value="email">Email (.eml)</option><option value="calendar">Calendar (.ics)</option></select></label>' +
    '<label class="field"><span>Source name</span><input id="source-name" maxlength="80" value="Browser bookmarks" required></label></div>' +
    '<p class="muted" id="source-name-guide">Use the same source name next time to see what changed.</p>' +
    '<p class="muted" id="source-offline-guide" hidden></p>' +
    '<label class="field"><span>Export files</span><input id="source-pick-files" type="file" accept=".html,.htm,text/html"></label>' +
    '<label class="field" id="source-folder-picker" hidden><span>Or choose the extracted folder</span>' +
    '<input id="source-pick-folder" type="file" webkitdirectory multiple></label>' +
    '<div class="row"><button class="primary" id="source-files-preview">Preview files</button></div>' +
    '<div id="source-files-status" role="status"></div></form><div id="source-files-result" class="source-panel"></div>') +
    '</section>';
}

function setupSourceFiles(seq, brain, onImport) {
  var form = document.getElementById('source-files-form');
  var name = document.getElementById('source-name');
  var kind = document.getElementById('source-kind');
  var filesInput = document.getElementById('source-pick-files');
  var folderInput = document.getElementById('source-pick-folder');
  var folderPicker = document.getElementById('source-folder-picker');
  var offlineGuide = document.getElementById('source-offline-guide');
  var status = document.getElementById('source-files-status');
  var result = document.getElementById('source-files-result');
  var previewButton = document.getElementById('source-files-preview');
  var preview = null;
  var busy = false;

  function clear() {
    preview = null;
    status.textContent = '';
    result.innerHTML = '';
  }

  function updateFormat() {
    var bookmarks = kind.value === 'bookmarks';
    var extension = SOURCE_EXTENSIONS[kind.value];
    filesInput.accept = extension || (bookmarks ? '.html,.htm,text/html' : '.md,.markdown,text/markdown');
    filesInput.multiple = !bookmarks;
    folderPicker.hidden = bookmarks || !('webkitdirectory' in folderInput);
    offlineGuide.hidden = !extension;
    offlineGuide.textContent = kind.value === 'email' ? 'Import readable message text from files up to 2 MiB each. Attachments are skipped.' :
      kind.value === 'calendar' ? 'Import event snapshots from files up to 2 MiB each. Recurring series stay as single drafts.' : '';
    filesInput.value = folderInput.value = '';
    clear();
  }

  function reviewRows(rows) {
    var chosen = rows.filter(function (row) { return row.status === 'new' || row.status === 'changed'; });
    var other = rows.filter(function (row) { return row.status === 'unchanged' || row.status === 'skipped'; });
    var content = '';
    if (chosen.length) {
      content += '<fieldset class="source-choices"><legend>Choose drafts to import</legend>' +
        '<div class="row"><button type="button" id="source-select-all">Select all</button>' +
        '<button type="button" id="source-select-none">Clear selection</button></div>' +
        '<ul class="source-rows source-checklist">' + chosen.map(function (row) {
          return '<li><label class="source-choice"><input type="checkbox" value="' + row.row + '" ' +
            (row.status === 'new' ? 'checked' : '') + '><span><strong>' + esc(row.title) + '</strong>' +
            '<span class="muted source-entry-detail">' + esc(row.status === 'changed' ? 'New version · ' : 'New · ') + esc(row.path) + '</span>' +
            (row.excerpt ? '<span class="source-entry-detail">' + esc(row.excerpt) + '</span>' : '') + '</span></label>' +
            (row.previous ? '<span class="source-previous">' + conceptLink(row.previous, 'Open earlier draft') + '</span>' : '') + '</li>';
        }).join('') + '</ul></fieldset><div class="row"><button type="button" class="primary" id="source-files-confirm">Import selected drafts</button>' +
        '<span role="status" id="source-chosen-count" class="muted"></span></div>';
    }
    if (other.length) {
      content += '<details' + (chosen.length ? '' : ' open') + '><summary>Already imported and skipped (' + other.length + ')</summary>' +
        '<ul class="source-rows">' + other.map(function (row) {
          return '<li>' + (row.id ? conceptLink(row.id, row.title) : esc(row.title || row.path)) +
            '<span class="muted"> · ' + esc(row.reason || 'This version is already saved.') + '</span></li>';
        }).join('') + '</ul></details>';
    }
    result.innerHTML = content;
    if (!chosen.length) return;
    var checkboxes = Array.from(result.querySelectorAll('input[type=checkbox]'));
    var confirmButton = document.getElementById('source-files-confirm');
    function selection() {
      return checkboxes.filter(function (input) { return input.checked; }).map(function (input) { return Number(input.value); });
    }
    function updateCount() {
      var count = selection().length;
      confirmButton.disabled = !count;
      document.getElementById('source-chosen-count').textContent = count + ' selected';
    }
    function chooseAll(checked) {
      checkboxes.forEach(function (input) { input.checked = checked; });
      updateCount();
    }
    result.querySelector('fieldset').addEventListener('change', updateCount);
    document.getElementById('source-select-all').addEventListener('click', function () { chooseAll(true); });
    document.getElementById('source-select-none').addEventListener('click', function () { chooseAll(false); });
    confirmButton.addEventListener('click', function () { run(selection()); });
    updateCount();
    result.querySelector('legend').setAttribute('tabindex', '-1');
    result.querySelector('legend').focus();
  }

  async function run(selected) {
    var folder = folderInput.files.length > 0;
    var files = Array.from(folder ? folderInput.files : filesInput.files);
    var extension = SOURCE_EXTENSIONS[kind.value];
    if (folder && extension) files = files.filter(function (file) { return file.name.toLowerCase().endsWith(extension); });
    if (busy || stale(seq) || brain !== BRAIN || (selected && !preview)) return;
    if (!files.length || files.length > 500) {
      status.innerHTML = errorBox('Choose between 1 and 500 export files.');
      return;
    }
    if (files.reduce(function (size, file) { return size + file.size; }, 0) > 24 * 1024 * 1024) {
      status.innerHTML = errorBox('Choose a selection up to 24 MiB.');
      return;
    }
    if (extension && files.some(function (file) { return file.size > 2 * 1024 * 1024; })) {
      status.innerHTML = errorBox('Choose email and calendar files up to 2 MiB each.');
      return;
    }
    var confirmation = selected ? { preview: preview, selected: selected } : null;
    clear();
    busy = true;
    filesInput.disabled = folderInput.disabled = name.disabled = kind.disabled = previewButton.disabled = true;
    Okb.working(status, selected ? 'saving private drafts' : 'reading local files');
    try {
      var response = await uploadSourceFiles(files, folder, kind.value, name.value, confirmation);
      if (stale(seq) || brain !== BRAIN) return;
      if (selected) {
        var saved = response.rows.filter(function (row) { return row.status === 'imported'; });
        status.textContent = saved.length + (saved.length === 1 ? ' private draft saved.' : ' private drafts saved.');
        result.innerHTML = '<ul class="source-rows">' + saved.map(function (row) {
          return '<li>' + conceptLink(row.id, row.title) + '</li>';
        }).join('') + '</ul>';
        if (saved.length && STATUS && !STATUS.hasIndex) result.insertAdjacentHTML('beforeend',
          '<p><a href="#home">Enable search on Home</a> to find text in these drafts.</p>');
        onImport();
      } else {
        preview = response.preview;
        status.textContent = response.rows.length + (response.rows.length === 1 ? ' item reviewed.' : ' items reviewed.') +
          ' Changed items are saved as separate drafts when selected.';
        reviewRows(response.rows);
      }
    } catch (error) {
      if (!stale(seq) && brain === BRAIN) status.innerHTML = errorBox(error);
    } finally {
      busy = false;
      filesInput.disabled = folderInput.disabled = name.disabled = kind.disabled = previewButton.disabled = false;
    }
  }

  filesInput.addEventListener('change', function () { folderInput.value = ''; clear(); });
  folderInput.addEventListener('change', function () { filesInput.value = ''; clear(); });
  kind.addEventListener('change', function () {
    if (Object.values(SOURCE_LABELS).includes(name.value)) name.value = SOURCE_LABELS[kind.value];
    updateFormat();
  });
  name.addEventListener('input', clear);
  form.addEventListener('submit', function (event) { event.preventDefault(); run(null); });
  return function (item) {
    if (busy) return;
    kind.value = item.kind;
    name.value = item.source;
    updateFormat();
    filesInput.focus();
  };
}

async function showSourceHistory(seq, brain, repeat) {
  var area = document.getElementById('source-history');
  try {
    var response = await get('/api/personal/sources/history');
    if (stale(seq) || brain !== BRAIN || !area) return;
    var groups = new Map();
    for (var item of response.result) {
      var key = JSON.stringify([item.kind, item.source]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    var sources = Array.from(groups.values());
    area.innerHTML = sources.length ? sources.map(function (runs, index) {
      var source = runs[0];
      return '<details><summary>' + esc(source.source) + ' <span class="muted">· ' +
        runs.length + (runs.length === 1 ? ' import' : ' imports') + '</span></summary>' +
        (repeat ? '<button class="ghost" type="button" data-source-repeat="' + index + '">Import from this source again</button>' : '') +
        '<ul class="source-rows">' + runs.map(function (run) {
          return '<li><strong>' + (run.at ? esc(new Date(run.at).toLocaleString()) : 'Earlier imports') + '</strong>' +
            ' <span class="muted">· ' + run.count + (run.count === 1 ? ' draft' : ' drafts') + '</span>' +
            '<ul class="source-rows">' + run.notes.map(function (note) {
              return '<li>' + conceptLink(note.id, note.title) + '</li>';
            }).join('') + '</ul>' +
            (run.count > run.notes.length ? '<span class="muted">Showing ' + run.notes.length + ' of ' + run.count + ' drafts.</span>' : '') + '</li>';
        }).join('') + '</ul></details>';
    }).join('') : '<p class="muted">Successful imports will appear here.</p>';
    if (repeat) area.querySelectorAll('[data-source-repeat]').forEach(function (button) {
      button.addEventListener('click', function () { repeat(sources[Number(button.dataset.sourceRepeat)][0]); });
    });
  } catch (error) {
    if (!stale(seq) && brain === BRAIN && area) area.innerHTML = errorBox(error);
  }
}

function renderSources(_arg, seq) {
  var brain = BRAIN;
  var name = STATUS ? (STATUS.brain || basename(STATUS.bundle)) : 'the selected brain';
  var readonly = STATUS && STATUS.readonly;
  view.innerHTML =
    '<div class="stack source-page"><h2>Sources</h2>' +
    '<section class="card source-panel" aria-labelledby="source-chats"><h3 id="source-chats">Conversation exports</h3>' +
    '<p>Save ChatGPT or Claude conversations to <strong>' + esc(name) + '</strong> as private drafts. ' +
    'Extract your export and select one conversations JSON file up to 128 MiB. The app reads it locally.</p>' +
    '<div class="source-links"><a href="https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data" target="_blank" rel="noopener noreferrer">How to export from ChatGPT</a>' +
    '<a href="https://support.claude.com/en/articles/9450526-export-your-claude-data" target="_blank" rel="noopener noreferrer">How to export from Claude</a></div>' +
    (readonly ? '<p class="notice">Choose a writable brain to import conversations.</p>' :
    '<form id="source-form" class="source-panel"><div class="grid">' +
    '<label class="field"><span>Export provider</span><select id="source-provider"><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option></select></label>' +
    '<label class="field"><span>Conversations file</span><input id="source-file" type="file" accept=".json,application/json" required></label></div>' +
    '<div class="row"><button id="source-preview" class="primary">Preview import</button>' +
    '<button id="source-confirm" class="primary" type="button" hidden>Import drafts</button></div>' +
    '<div id="source-status" role="status"></div><div id="source-result" class="source-panel"></div></form>') +
    '<a href="#browse/conversation">Browse conversation drafts</a></section>' +
    sourceFilesPanel(name, readonly) +
    '<section class="card source-panel" id="source-notion"></section>' +
    '<section class="card source-panel" aria-labelledby="source-history-title"><h3 id="source-history-title">Import history</h3>' +
    '<div class="source-panel" id="source-history" aria-live="polite">Loading import history…</div></section>' +
    '<section class="card source-panel" aria-labelledby="source-web"><h3 id="source-web">Web pages and feeds</h3>' +
    '<p>Save a page to your inbox, install the browser bookmarklet, or pull an RSS feed.</p><a href="#add">Open capture tools</a></section>' +
    '<section class="card source-panel" aria-labelledby="source-ai"><h3 id="source-ai">AI accounts</h3>' +
    '<p>Connect an eligible ChatGPT plan for hosted answers, or configure an API provider or local model.</p>' +
    '<div class="source-links"><a href="#accounts">Manage ChatGPT accounts</a><a href="#settings">Open AI settings</a></div></section></div>';
  var repeatNotion = window.okbNotion.mount(document.getElementById('source-notion'), { readonly: readonly, headers: headers, onImport: refreshHistory });
  if (readonly) {
    showSourceHistory(seq, brain);
    return;
  }

  var form = document.getElementById('source-form');
  var fileInput = document.getElementById('source-file');
  var providerInput = document.getElementById('source-provider');
  var previewButton = document.getElementById('source-preview');
  var confirmButton = document.getElementById('source-confirm');
  var status = document.getElementById('source-status');
  var result = document.getElementById('source-result');
  var receipt = null;
  var busy = false;

  var repeatFiles = setupSourceFiles(seq, brain, refreshHistory);
  function refreshHistory() {
    showSourceHistory(seq, brain, function (item) {
      if (item.kind === 'chatgpt' || item.kind === 'claude') {
        if (busy) return;
        providerInput.value = item.kind;
        fileInput.value = '';
        clearPreview();
        fileInput.focus();
      } else if (item.kind === 'notion-live') repeatNotion(item.source);
      else repeatFiles(item);
    });
  }
  refreshHistory();

  function clearPreview() {
    receipt = null;
    confirmButton.hidden = true;
    previewButton.classList.add('primary');
    status.innerHTML = '';
    result.innerHTML = '';
  }

  function resultList(items, format) {
    // Long archives can contain thousands of rows. Keep the page responsive.
    var shown = items.slice(0, 50);
    return '<ol class="source-rows">' + shown.map(format).join('') + '</ol>' +
      (shown.length < items.length ? '<p class="muted">Showing the first ' + shown.length + ' of ' + items.length + '.</p>' : '');
  }

  async function run(commit) {
    var file = fileInput.files[0];
    if (busy || !file || stale(seq) || brain !== BRAIN || (commit && !receipt)) return;
    if (file.size > 128 * 1024 * 1024) {
      status.innerHTML = errorBox('Choose a conversations JSON file up to 128 MiB.');
      return;
    }
    var selectedReceipt = commit ? receipt : null;
    clearPreview();
    busy = true;
    fileInput.disabled = providerInput.disabled = previewButton.disabled = true;
    Okb.working(status, commit ? 'importing private drafts' : 'reading export');
    try {
      var r = await uploadConversations(file, providerInput.value, selectedReceipt);
      if (stale(seq) || brain !== BRAIN) return;
      var count = commit ? r.imported.length : r.planned.length;
      status.textContent = count + (count === 1 ? ' draft ' : ' drafts ') +
        (commit ? 'imported' : 'ready to import') + (r.skipped.length ? '. ' + r.skipped.length + ' skipped.' : '.');
      if (count > 0) {
        result.innerHTML = resultList(r.drafts, function (draft) {
          return '<li value="' + esc(draft.row) + '">' + (commit ? conceptLink(draft.id, draft.title) : esc(draft.title)) +
            '<span class="muted">' + (draft.createdAt ? ' · ' + dateOf(draft.createdAt) : '') + ' · ' +
            esc(draft.messages) + (draft.messages === 1 ? ' message' : ' messages') + '</span></li>';
        });
      }
      if (r.skipped.length > 0) {
        result.insertAdjacentHTML('beforeend', '<details' + (count === 0 ? ' open' : '') + '><summary>Skipped conversations</summary>' +
          resultList(r.skipped, function (row) {
            return '<li value="' + esc(row.row) + '">' + esc(row.reason) + '</li>';
          }) + '</details>');
      }
      if (commit) {
        form.reset();
        refreshHistory();
        if (count > 0 && STATUS && !STATUS.hasIndex)
          result.insertAdjacentHTML('beforeend', '<p><a href="#home">Enable search on Home</a> to find text in these drafts.</p>');
      } else if (count > 0) {
        receipt = r.preview;
        confirmButton.hidden = false;
        previewButton.classList.remove('primary');
      }
    } catch (err) {
      if (!stale(seq) && brain === BRAIN) status.innerHTML = errorBox(err);
    } finally {
      busy = false;
      fileInput.disabled = providerInput.disabled = previewButton.disabled = false;
    }
  }

  fileInput.addEventListener('change', clearPreview);
  providerInput.addEventListener('change', clearPreview);
  form.addEventListener('submit', function (e) { e.preventDefault(); run(false); });
  confirmButton.addEventListener('click', function () { run(true); });
}

// ---- claims view (take / resolve / calibrate) ---------------------------

async function renderClaims(focusId, seq) {
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
    if (stale(seq)) return;
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
    if (first && focusId) {
      var focused = Array.from(el.querySelectorAll('[data-id]')).find(function (card) { return card.dataset.id === focusId; });
      if (focused) {
        focused.querySelector('.title a')?.focus();
        focused.scrollIntoView({ block: 'center' });
      }
    }
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

async function renderBrainMounts(parent, readonly, seq) {
  parent.innerHTML = '<h3 id="brain-mount-heading" tabindex="-1">Brain folders</h3>' +
    '<p>Use named mounts to switch between local brains. Removing a mount keeps its files.</p>' +
    '<div role="status" id="brain-mount-feedback"></div><div class="stack" data-mounts-list></div>';
  var feedback = parent.querySelector('[role="status"]');
  var list = parent.querySelector('[data-mounts-list]');
  var selected = BRAIN;
  var busy = false;
  try {
    var response = await loadBrains();
    var mounts = response.brains;
    if (stale(seq)) return;
    if (selected !== BRAIN) {
      await refreshStatus();
      if (!stale(seq)) await route();
      return;
    }
  } catch (error) {
    feedback.innerHTML = errorBox(error);
    return;
  }

  function nameField(name) {
    return '<label class="field"><span>Mount name</span><input name="mountName" value="' + esc(name) +
      '" maxlength="64" required autocomplete="off" spellcheck="false"></label>';
  }

  function accessField(checked) {
    return '<label class="row"><input type="checkbox" name="readOnly"' + (checked ? ' checked' : '') + '> Read-only</label>';
  }

  function profileField(current) {
    return '<label class="field"><span>Default retrieval profile</span><select name="retrievalProfile">' +
      [['', 'Use app default'], ['lean', 'Lean'], ['balanced', 'Balanced'], ['max', 'Max']].map(function (option) {
        return '<option value="' + option[0] + '"' + (option[0] === current ? ' selected' : '') + '>' + option[1] + '</option>';
      }).join('') + '</select></label>';
  }

  function aiFields(defaults) {
    var ai = defaults || {};
    function provider(name, label, options) {
      var selected = ai[name] === 'local' ? 'ollama' : ai[name];
      return '<label class="field"><span>' + label + '</span><select name="' + name + '">' +
        '<option value="">Use app default</option>' + options.map(function (option) {
          return '<option' + (option === selected ? ' selected' : '') + '>' + esc(option) + '</option>';
        }).join('') + '</select></label>';
    }
    function model(name, label) {
      return '<label class="field"><span>' + label + '</span><input name="' + name + '" value="' + esc(ai[name] || '') +
        '" placeholder="Use default model" maxlength="256" autocomplete="off" spellcheck="false"></label>';
    }
    return '<details><summary>AI defaults for this brain</summary><div class="grid">' +
      provider('provider', 'Brain chat provider', response.providers.chat) + model('model', 'Brain chat model') +
      provider('embedProvider', 'Brain embedding provider', response.providers.embed) + model('embedModel', 'Brain embedding model') +
      '</div></details>';
  }

  function readAiDefaults(form) {
    return { provider: form.elements.provider.value, model: form.elements.model.value,
      embedProvider: form.elements.embedProvider.value, embedModel: form.elements.embedModel.value };
  }

  async function finish(next, message, showHome) {
    rememberBrain(next);
    await loadBrains();
    await refreshStatus();
    if (stale(seq)) return;
    if (showHome) { location.hash = '#home'; return; }
    await route();
    if (location.hash === '#settings') {
      var notice = document.getElementById('brain-mount-feedback');
      if (notice) notice.textContent = message;
      document.getElementById('brain-mount-heading')?.focus();
    }
  }

  async function change(button, input, next, message) {
    if (busy) return;
    busy = button.disabled = true;
    feedback.textContent = 'Saving mount settings…';
    try {
      var response = await fetch('/api/brains/mounts', {
        method: 'POST', cache: 'no-store', headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(input),
      });
      var payload = await response.json();
      if (!response.ok) throw new Error(payload.error || response.statusText);
      if (!stale(seq) && BRAIN === selected) await finish(next(payload.result), message, input.action === 'create');
    } catch (error) {
      if (!stale(seq)) feedback.innerHTML = errorBox(error);
    } finally {
      busy = button.disabled = false;
    }
  }

  list.innerHTML = (mounts.length ? mounts.map(function (mount, index) {
    return '<details class="card brain-mount-card" data-mount="' + index + '"><summary><strong>' + esc(mount.name) +
      '</strong>' + (mount.readonly ? ' <span class="muted">· Read-only</span>' : '') +
      (mount.exists ? '' : ' <span class="muted">· Folder missing</span>') + '</summary>' +
      '<div class="stack brain-mount-body">' +
      (mount.exists && mount.name !== BRAIN ? '<div><button type="button" data-mount-open>Open brain</button></div>' : '') +
      (readonly ? '' : '<form class="stack" data-mount-edit><div class="grid">' + nameField(mount.name) + profileField(mount.retrievalProfile) +
        '</div>' + accessField(mount.readonly) + aiFields(mount.ai) +
        '<div class="row"><button type="submit">Save mount</button><button type="button" data-mount-remove>Remove mount</button></div></form>') +
      '</div></details>';
  }).join('') : '<p class="muted">No named brain folders.</p>') +
    (readonly ? '<p class="notice">Switch to a writable brain to change the mount registry.</p>' :
      '<details class="card brain-mount-card"><summary>Add a brain folder</summary><form class="stack brain-mount-body" data-mount-add>' +
      '<div class="grid">' + nameField('') + '<label class="field"><span>Folder action</span><select name="action">' +
      '<option value="register">Register an existing folder</option><option value="create">Create a new brain folder</option>' +
      '</select></label></div><label class="field"><span>Absolute folder path</span>' +
      '<input name="path" maxlength="4096" required autocomplete="off" spellcheck="false"></label>' +
      '<p class="muted">Create accepts a new path or an empty folder.</p>' + profileField() + accessField(false) + aiFields() +
      '<div class="row"><button type="submit" class="primary">Add brain folder</button></div></form></details>');

  list.querySelectorAll('[data-mount]').forEach(function (row) {
    var mount = mounts[Number(row.dataset.mount)];
    var open = row.querySelector('[data-mount-open]');
    var form = row.querySelector('[data-mount-edit]');
    if (open) open.addEventListener('click', function () {
      if (busy) return;
      busy = open.disabled = true;
      finish(mount.name, 'Opened ' + mount.name + '.').catch(function (error) {
        if (!stale(seq)) feedback.innerHTML = errorBox(error);
      }).finally(function () { busy = open.disabled = false; });
    });
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = { action: 'update', previous: mount.name, name: form.elements.mountName.value,
        readonly: form.elements.readOnly.checked, retrievalProfile: form.elements.retrievalProfile.value, ai: readAiDefaults(form) };
      change(form.querySelector('button[type=submit]'), input, function (result) {
        return selected === mount.name ? result.name : selected;
      }, 'Mount settings saved.');
    });
    row.querySelector('[data-mount-remove]').addEventListener('click', function (event) {
      change(event.currentTarget, { action: 'remove', previous: mount.name }, function () {
        return selected === mount.name ? '' : selected;
      }, 'Mount removed. Its files are still in the folder.');
    });
  });
  var add = list.querySelector('[data-mount-add]');
  if (add) add.addEventListener('submit', function (event) {
    event.preventDefault();
    var input = {
      action: add.elements.action.value, name: add.elements.mountName.value,
      path: add.elements.path.value, readonly: add.elements.readOnly.checked, retrievalProfile: add.elements.retrievalProfile.value, ai: readAiDefaults(add),
    };
    change(add.querySelector('button[type=submit]'), input, function (result) { return result.name; }, 'Brain folder added.');
  });
}

function mountBundleWatch(panel, readonly, seq) {
  var start = panel.querySelector('[data-start-watch]');
  var stop = panel.querySelector('[data-stop-watch]');
  var message = panel.querySelector('[role="status"]');
  var status = null;
  var running;
  var timer;
  var active = function () { return !stale(seq) && panel.isConnected; };

  function paint(error) {
    start.disabled = Boolean(running || readonly || status?.active);
    stop.disabled = Boolean(running || !status?.active);
    var text = error || status?.error;
    if (!text) {
      if (readonly && !status?.active) text = 'Watching requires a writable brain.';
      else if (status?.indexing) text = 'Refreshing search and graph…';
      else if (status?.active && status.lastIndexedAt) text = 'Watching. Last refresh ' + new Date(status.lastIndexedAt).toLocaleTimeString() + '.';
      else text = status?.active ? 'Watching.' : 'Watching is off.';
    }
    if (message.textContent !== text) message.textContent = text;
  }

  async function update(action) {
    if (!active() || running) return;
    clearTimeout(timer);
    running = true;
    if (action) paint(action === 'start' ? 'Starting watch…' : 'Stopping watch…');
    var error;
    try {
      var res = await fetch('/api/brains/watch', action ? {
        method: 'POST', headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ action: action }),
      } : { headers: headers(), cache: 'no-store' });
      var payload = await res.json();
      if (!res.ok) throw new Error(payload.error || res.statusText);
      status = payload.result;
      if (active() && status?.lastIndexedAt && !STATUS?.hasIndex) void refreshStatus();
    } catch (e) {
      error = e.message;
    } finally {
      running = false;
      if (active()) {
        paint(error);
        if (status?.active) timer = setTimeout(update, 1200);
      }
    }
  }

  start.addEventListener('click', function () { void update('start'); });
  stop.addEventListener('click', function () { void update('stop'); });
  void update();
}

function mountNoteUsageSettings(panel) {
  var enable = panel.querySelector('[data-usage-enable]');
  var disable = panel.querySelector('[data-usage-disable]');
  var status = panel.querySelector('[role="status"]');
  async function update(enabled) {
    enable.disabled = disable.disabled = true;
    try {
      var state = await api('note_usage_settings', enabled === undefined ? {} : { mode: enabled ? 'on' : 'off' });
      enable.hidden = state.enabled;
      disable.hidden = !state.enabled;
      status.textContent = state.enabled ? 'Counting local usage.' : 'Local counts are off.';
    } catch (error) { status.textContent = error.message; }
    finally { enable.disabled = disable.disabled = false; }
  }
  enable.addEventListener('click', function () { void update(true); });
  disable.addEventListener('click', function () { void update(false); });
  void update();
}

async function renderSettings(_arg, seq) {
  var st = STATUS || {};
  var mcpArgs = st.brain ? ['--brain', st.brain, 'mcp'] : ['--bundle', st.bundle || '<bundle>', 'mcp'];
  var mcpJson = JSON.stringify({ mcpServers: { okbrain: { command: 'okb', args: mcpArgs } } }, null, 2);
  view.innerHTML =
    '<div class="stack"><h2>Settings</h2>' +
    '<h3>This server</h3><dl class="kv">' +
    '<dt>okbrain</dt><dd>' + esc(st.version || '?') + ' · writes OKF ' + esc(st.okfVersion || '?') + '</dd>' +
    '<dt>Bundle</dt><dd><code>' + esc(st.bundle || '?') + '</code>' + (st.brain ? ' (brain <strong>' + esc(st.brain) + '</strong>)' : '') +
    (st.readonly ? ' <span class="chip warn">read-only</span>' : '') + '</dd>' +
    '<dt>Caches</dt><dd>' + (st.hasIndex ? 'index ✓' : 'no index') + ' · ' + (st.hasVectors ? 'vectors ✓' : 'no vectors') + '</dd>' +
    '<dt>Retrieval profile</dt><dd>' + esc(st.retrievalProfile || 'balanced') + '</dd>' +
    '<dt>Port</dt><dd>' + esc(st.port || '?') + ' (127.0.0.1 only)</dd></dl>' +
    '<section id="brain-mount-settings" class="stack"></section>' +
    (st.readonly ? '' : '<div class="row"><button id="set-default-brain" type="button"' + (st.isDefaultBundle ? ' disabled' : '') +
      '>Use as default brain</button><span id="default-brain-status" role="status">' +
      (st.isDefaultBundle ? 'This folder is the default.' : 'Used when okb starts without a folder argument.') + '</span></div>') +
    (st.readonly ? '' : '<section id="note-usage-settings" class="stack"><h3>Local note usage</h3>' +
      '<p class="muted">Count opens and verified Ask citations for this brain on this device. The last 30 days of counts appear on notes.</p>' +
      '<div class="row"><button data-usage-enable type="button" hidden>Turn on local counts</button>' +
      '<button data-usage-disable type="button" hidden>Turn off and clear counts</button></div><div role="status"></div></section>') +
    '<h3>Identity</h3><form id="actf" class="row">' +
    '<label class="field" style="flex:1"><span>Actor (generated.by / verified.by on your writes)</span>' +
    '<input id="act-in" value="' + esc(st.actor || '') + '" placeholder="human:alice"></label>' +
    '<button>Save</button></form><div id="act-out"></div>' +
    '<h3>AI providers</h3>' +
    '<form id="setf" class="stack"><div class="grid">' +
    field('provider', 'Chat provider', '', 'anthropic | openai | gemini | openrouter | local') +
    field('model', 'Chat model', '', 'provider default') +
    field('base-url', 'Chat endpoint (optional)', '', 'provider default') +
    field('embed-provider', 'Embed provider', '', 'openai | voyage | gemini | local') +
    field('embed-model', 'Embed model', '', 'provider default') +
    field('embed-base-url', 'Embedding endpoint (optional)', '', 'provider default') +
    '</div><div class="row">' +
    '<label><input id="reset-chat-endpoint" type="checkbox" aria-controls="ed-base-url"> Restore default chat endpoint</label>' +
    '<label><input id="reset-embed-endpoint" type="checkbox" aria-controls="ed-embed-base-url"> Restore default embedding endpoint</label></div>' +
    '<div class="row"><label class="field"><span>Retrieval profile</span>' +
    '<select id="ed-retrieval-profile"><option value="">(keep)</option>' +
    '<option>lean</option><option>balanced</option><option>max</option></select></label>' +
    '<button>Save</button></div></form>' +
    '<div id="set-out"></div><p class="muted">A local provider needs no API key.</p><section id="provider-keys" class="stack"></section>' +
    '<h3>Sync (git)</h3><form id="syncf" class="stack">' +
    field('sync-message', 'Commit message (optional)', '', 'Automatic timestamped message') +
    '<div class="row"><button id="sync-status" type="button">Status</button><button type="submit">Sync now</button></div></form>' +
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
    '<button id="mx-index">Re-index</button>' +
    '<button id="mx-doctor">Doctor</button>' +
    '<button id="mx-rebuild" class="danger">Rebuild (wipe + reindex)</button></div>' +
    (st.readonly ? '' : '<form id="folder-log-form" class="stack"><h4>Folder change log</h4>' +
      '<p class="muted">Record future changes to a folder and its subfolders in a separate log.md.</p>' +
      '<label class="field"><span>Folder path in this brain</span><input name="folder" placeholder="notes/projects" required></label>' +
      '<div class="row"><button type="submit">Enable folder log</button></div><div role="status"></div></form>') +
    (st.readonly ? '' : '<form id="manifest-style-form" class="stack"><h4>Markdown indexes</h4>' +
      '<div class="row"><label class="field"><span id="manifest-style-label">Index format</span><select name="style" aria-labelledby="manifest-style-label" required>' +
      '<option value="">Choose a format</option><option value="grouped">Grouped headings</option>' +
      '<option value="reference">OKF reference headings and relative links</option></select></label>' +
      '<button type="submit">Update index files</button></div><div role="status"></div></form>') +
    '<form id="embedf" class="stack"><h4>Embeddings</h4><div class="grid">' +
    field('run-embed-provider', 'Provider override', '', 'Configured provider') +
    field('run-embed-model', 'Model override', '', 'Configured model') +
    '<label class="field"><span>Max notes this run</span><input id="embed-limit" type="number" min="0" placeholder="All pending notes"></label>' +
    '</div><p class="muted">Changing the provider or model rebuilds the vector cache.</p>' +
    '<label class="row"><input type="checkbox" id="embed-private"> Include private notes in embeddings</label>' +
    '<div class="row"><button>Embed</button></div><div id="embed-out" aria-live="polite"></div></form>' +
    '<section id="bundle-watch" class="stack"><h4>Watch brain folder</h4>' +
    '<p class="muted">Keep keyword search and graph links current when you edit Markdown in another app.</p>' +
    '<div class="row"><button data-start-watch disabled>Start watching</button><button data-stop-watch disabled>Stop watching</button></div>' +
    '<p role="status">Checking watch status…</p></section>' +
    '<div class="row"><button id="mx-viz">Export viz.html</button>' +
    '<label><input id="mx-viz-fonts" type="checkbox"> Embed app fonts in graph export</label>' +
    (st.readonly ? '' : '<label><input id="mx-viz-private" type="checkbox"> Include private drafts in graph export</label>') + '</div>' +
    '<section class="stack" aria-labelledby="markdown-export-heading"><h4 id="markdown-export-heading">Markdown and Obsidian export</h4>' +
    (st.readonly ? '<p>Open a writable brain to export its notes.</p>' :
      '<form id="markdown-export" class="stack"><label class="field"><span>New export folder (absolute path)</span>' +
      '<input name="destination" autocomplete="off" spellcheck="false" maxlength="4096" required aria-describedby="markdown-export-help"></label>' +
      '<p class="muted" id="markdown-export-help">Choose a new folder outside this brain. Open it as an Obsidian vault or browse the Markdown in any editor.</p>' +
      '<label class="row"><input type="checkbox" name="private"> Include private drafts in Markdown export</label>' +
      '<div class="row"><button type="submit">Export Markdown</button><span role="status"></span></div></form>') + '</section>' +
    '<div class="row"><span class="muted">Jobs:</span>' +
    ['index', 'embed', 'rss', 'review', 'doctor'].map(function (j) {
      return '<label class="row" style="gap:4px"><input type="checkbox" class="jobcb" value="' + j + '" checked> ' + j + '</label>';
    }).join('') + '<button id="mx-jobs">Run jobs</button></div>' +
    '<div class="row"><span class="muted">OKF v0.2 migration:</span><button id="mx-upgrade-dry">Preview upgrade</button>' +
    '<button id="mx-upgrade">Upgrade bundle</button></div><div id="mx-out"></div>' +
    '<section id="mcp-settings" class="stack"></section>' +
    '<details><summary>MCP stdio client configuration</summary>' +
    '<p class="muted">A stdio client launches okbrain using an executable path on this computer.</p><pre>' + esc(mcpJson) + '</pre></details>' +
    '<h3>Bookmarklet</h3><div id="bm-out"></div></div>';

  var show = setHtml;
  var usagePanel = document.getElementById('note-usage-settings');
  if (usagePanel) mountNoteUsageSettings(usagePanel);
  showBookmarklet();
  mountBundleWatch(document.getElementById('bundle-watch'), Boolean(st.readonly), seq);
  renderBrainMounts(document.getElementById('brain-mount-settings'), Boolean(st.readonly), seq);
  renderProviderKeys(document.getElementById('provider-keys'), Boolean(st.readonly));
  window.okbMcpSettings.mount(document.getElementById('mcp-settings'), { readonly: Boolean(st.readonly), requestHeaders: headers });

  var folderLog = document.getElementById('folder-log-form');
  folderLog?.addEventListener('submit', async function (event) {
    event.preventDefault();
    var status = folderLog.querySelector('[role="status"]');
    var button = folderLog.querySelector('button');
    button.disabled = true;
    try {
      var result = await api('create_directory_log', { folder: folderLog.elements.folder.value });
      status.textContent = result.folder + '/log.md ' + (result.created ? 'created.' : 'is already enabled.');
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });

  var manifestStyle = document.getElementById('manifest-style-form');
  manifestStyle?.addEventListener('submit', async function (event) {
    event.preventDefault();
    var status = manifestStyle.querySelector('[role="status"]');
    var button = manifestStyle.querySelector('button');
    button.disabled = true;
    try {
      await appWork(api('set_index_style', { style: manifestStyle.elements.style.value }));
      status.textContent = 'Markdown index files updated.';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });

  var setDefault = document.getElementById('set-default-brain');
  if (setDefault) setDefault.addEventListener('click', async function () {
    setDefault.disabled = true;
    var status = document.getElementById('default-brain-status');
    try {
      await api('brain_default', {});
      status.textContent = 'This folder is the default.';
      await refreshStatus();
    } catch (error) {
      setDefault.disabled = false;
      status.textContent = error.message;
    }
  });

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
  var endpointResets = [['reset-chat-endpoint', 'base-url'], ['reset-embed-endpoint', 'embed-base-url']].map(function (pair) {
    var checkbox = document.getElementById(pair[0]);
    var input = document.getElementById('ed-' + pair[1]);
    checkbox.addEventListener('change', function () { input.disabled = checkbox.checked; });
    return { checkbox: checkbox, input: input, param: pair[1] };
  });
  document.getElementById('setf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var params = { 'no-default-bundle': true };
    ['provider', 'model', 'base-url', 'embed-provider', 'embed-model', 'embed-base-url', 'retrieval-profile'].forEach(function (n) {
      var v = document.getElementById('ed-' + n).value.trim();
      if (v) params[n] = v;
    });
    var restoring = endpointResets.filter(function (reset) { return reset.checkbox.checked; });
    restoring.forEach(function (reset) { params[reset.param] = ''; });
    working('set-out', 'saving');
    try {
      var r = await api('init', params);
      restoring.forEach(function (reset) {
        reset.input.value = '';
        reset.input.disabled = false;
        reset.checkbox.checked = false;
      });
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
  document.getElementById('syncf').addEventListener('submit', async function (e) {
    e.preventDefault();
    var message = document.getElementById('ed-sync-message').value.trim();
    working('sync-out', 'syncing');
    try { show('sync-out', jsonNotice(await appWork(api('sync', message ? { message: message } : {})))); }
    catch (e) { show('sync-out', errorBox(e)); }
  });
  async function maint(op, verb, params, render, output) {
    var target = output || 'mx-out';
    working(target, verb);
    try { show(target, (render || jsonNotice)(await appWork(api(op, params || {})))); await refreshStatus(); }
    catch (e) { show(target, errorBox(e)); }
  }
  document.getElementById('mx-index').addEventListener('click', function () { maint('index', 'indexing'); });
  document.getElementById('embedf').addEventListener('submit', function (e) {
    e.preventDefault();
    var params = {};
    var provider = document.getElementById('ed-run-embed-provider').value.trim();
    var model = document.getElementById('ed-run-embed-model').value.trim();
    var limit = document.getElementById('embed-limit').valueAsNumber;
    if (provider) params.provider = provider;
    if (model) params.model = model;
    if (Number.isFinite(limit)) params.limit = limit;
    if (document.getElementById('embed-private').checked) params['include-private'] = true;
    maint('embed', 'embedding', params, null, 'embed-out');
  });
  document.getElementById('mx-doctor').addEventListener('click', function () { maint('doctor', 'checking', {}, doctorSummary); });
  document.getElementById('mx-viz').addEventListener('click', function () {
    var includePrivate = Boolean(document.getElementById('mx-viz-private')?.checked);
    if (includePrivate && !confirm('The exported HTML will contain private draft text. Export it?')) return;
    var fonts = document.getElementById('mx-viz-fonts').checked;
    maint('export_viz', 'exporting', { 'include-private': includePrivate, fonts: fonts }, function (r) {
      return '<div class="notice">wrote ' + esc(r.path) + ' (' + r.nodes + ' concepts, ' + r.edges + ' links)</div>';
    });
  });
  var markdown = document.getElementById('markdown-export');
  if (markdown) markdown.addEventListener('submit', async function (event) {
    event.preventDefault();
    var destination = markdown.elements.destination.value.trim();
    var includePrivate = markdown.elements.private.checked;
    var button = markdown.querySelector('button');
    var status = markdown.querySelector('[role="status"]');
    if (!destination || button.disabled) return;
    if (includePrivate && !confirm('The Markdown export will contain private drafts. Export them?')) return;
    button.disabled = true;
    Okb.working(status, 'exporting notes');
    try {
      var result = await appWork(api('export_markdown', { destination: destination, 'include-private': includePrivate }));
      if (!stale(seq)) status.textContent = 'Exported ' + result.notes + (result.notes === 1 ? ' note to ' : ' notes to ') + result.path;
    } catch (error) {
      if (!stale(seq)) status.innerHTML = errorBox(error);
    } finally { button.disabled = false; }
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
loadBrains().catch(function () {}).then(refreshStatus).then(route);
