/* global api, view, STATUS, BRAIN, stale, buildLocalIndex, esc, errorBox, conceptLink, graphHref */
'use strict';

function mapHref(id) { return '#map/' + encodeURIComponent(id); }

function renderFocusedMap(id, seq) {
  var brain = BRAIN;
  var bundle = STATUS?.bundle;
  var hash = location.hash;
  var needsIndex = STATUS?.hasIndex === false;
  if (needsIndex && STATUS.readonly) {
    view.innerHTML = '<div class="stack"><h2>Focused map</h2><p class="notice">This read-only brain has no local search index. ' +
      (id ? conceptLink(id, 'Open the note') : '<a href="#browse">Browse its notes</a>') + '.</p></div>';
    return;
  }
  view.innerHTML = '<div class="stack wide"><h2>Focused map</h2>' +
    '<p>Start with a question, project name, or note. The map shows direct links around the strongest local matches.</p>' +
    '<form id="map-form" class="stack"><label class="field"><span>' + (id ? 'Focus note' : 'Question or project') + '</span>' +
    (id ? '<input name="id" value="' + esc(id) + '" readonly><a href="#map">Start with search</a>' :
      '<input name="query" type="search" maxlength="1000" required>') + '</label>' +
    '<div class="row"><label class="field"><span>Source</span><select name="source"><option value="all">All sources</option>' +
    '<option value="notes">Notes</option><option value="web">Web references</option><option value="imports">Imports</option></select></label>' +
    '<label class="field"><span>Updated since</span><input name="since" type="date"></label>' +
    '<label><input type="checkbox" name="private"' + (id && id.startsWith('db_only/') ? ' checked' : '') + '> Include private drafts</label></div>' +
    '<div><button class="primary">' + (needsIndex ? 'Build index and map' : 'Build map') + '</button></div></form>' +
    '<div role="status" id="map-status"></div><div class="stack" id="map-result" tabindex="-1"></div></div>';
  var form = document.getElementById('map-form');
  var submit = form.querySelector('button');
  var result = document.getElementById('map-result');
  var status = document.getElementById('map-status');
  var busy = false;
  function current() { return !stale(seq) && brain === BRAIN && hash === location.hash && form.isConnected; }
  function focusStayed() { return document.activeElement === document.body || form.contains(document.activeElement); }
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy || !current()) return;
    var data = new FormData(form);
    var params = { source: data.get('source'), 'include-private': data.has('private') };
    if (id) params.id = id;
    else {
      params.query = data.get('query').trim();
      if (!params.query) return;
    }
    if (data.get('since')) params.since = data.get('since');
    var restoreFocus = needsIndex && form.contains(document.activeElement);
    var controls = Array.from(form.elements);
    busy = true;
    controls.forEach(function (control) { control.disabled = true; });
    result.replaceChildren();
    try {
      if (needsIndex) {
        status.textContent = 'Building the local index…';
        await buildLocalIndex(brain);
        if (!current()) return;
        if (bundle !== STATUS?.bundle) throw new Error('The selected brain changed. Open Focused map again to map it.');
        if (!STATUS.hasIndex) throw new Error('The local index is unavailable. Check the search cache in Settings and try again.');
        needsIndex = false;
        submit.textContent = 'Build map';
      }
      status.textContent = 'Mapping local notes…';
      var map = await api('focused_map', params);
      if (!current()) return;
      if (!map.nodes.length) { status.textContent = 'No notes match. Try a narrower phrase or clear the filters.'; return; }
      status.textContent = map.nodes.length + (map.nodes.length === 1 ? ' note' : ' notes') + ', ' + map.edges.length +
        (map.edges.length === 1 ? ' link.' : ' links.') + (map.bounded ? ' Limits reached. Narrow the query or focus a note.' : '');
      draw(map);
      if (restoreFocus && focusStayed()) (result.querySelector('h3 a') || result).focus();
    } catch (error) { if (current()) status.innerHTML = errorBox(error); }
    finally {
      busy = false;
      controls.forEach(function (control) { control.disabled = false; });
      if (current() && restoreFocus && focusStayed()) submit.focus();
    }
  });

  function draw(map) {
    var nodes = new Map(map.nodes.map(function (node) { return [node.id, node]; }));
    result.innerHTML = map.nodes.filter(function (item) { return item.root; }).map(function (root) {
      var rows = map.edges.filter(function (edge) { return edge.src === root.id || edge.dst === root.id; });
      return '<section class="card stack"><h3>' + conceptLink(root.id, root.title) + '</h3>' +
        (root.description ? '<p>' + esc(root.description) + '</p>' : '') +
        '<div class="row"><span class="chip">' + esc(root.source) + (root.private ? ' · private' : '') + '</span>' +
        '<a href="' + graphHref(root.id) + '">Open full graph</a></div>' +
        (rows.length ? '<ul>' + rows.map(function (edge) {
          var outbound = edge.src === root.id;
          var linked = nodes.get(outbound ? edge.dst : edge.src);
          return '<li>' + (outbound ? 'Links to ' : 'Linked from ') + conceptLink(linked.id, linked.title) +
            (edge.rel ? ' <span class="chip">' + esc(edge.rel) + '</span>' : '') +
            ' · <a href="' + mapHref(linked.id) + '" aria-label="Focus on ' + esc(linked.title) + '">Focus</a></li>';
        }).join('') + '</ul>' : '<p>No direct links match the filters.</p>') + '</section>';
    }).join('');
  }

  if (id && !needsIndex) form.requestSubmit();
}
