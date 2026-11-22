/* global api, view, STATUS, esc, errorBox, conceptLink, graphHref */
'use strict';

function mapHref(id) { return '#map/' + encodeURIComponent(id); }

function renderFocusedMap(id) {
  view.innerHTML = '<div class="stack wide"><h2>Focused map</h2>' +
    '<p>Start with a question, project name, or note. The map shows direct links around the strongest local matches.</p>' +
    '<form id="map-form" class="stack"><label class="field"><span>' + (id ? 'Focus note' : 'Question or project') + '</span>' +
    (id ? '<input name="id" value="' + esc(id) + '" readonly><a href="#map">Start with search</a>' :
      '<input name="query" type="search" maxlength="1000" required>') + '</label>' +
    '<div class="row"><label class="field"><span>Source</span><select name="source"><option value="all">All sources</option>' +
    '<option value="notes">Notes</option><option value="web">Web references</option><option value="imports">Imports</option></select></label>' +
    '<label class="field"><span>Updated since</span><input name="since" type="date"></label>' +
    '<label><input type="checkbox" name="private"' + (id && id.startsWith('db_only/') ? ' checked' : '') + '> Include private drafts</label></div>' +
    '<div><button class="primary">Build map</button></div></form>' +
    '<div role="status" id="map-status"></div><div class="stack" id="map-result"></div></div>';
  var form = document.getElementById('map-form');
  var result = document.getElementById('map-result');
  var status = document.getElementById('map-status');
  var generation = 0;
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var current = ++generation;
    if (STATUS && !STATUS.hasIndex) {
      status.innerHTML = 'Build a local index from <a href="#home">Home</a> to map these notes.';
      return;
    }
    var data = new FormData(form);
    var params = { source: data.get('source'), 'include-private': data.has('private') };
    if (id) params.id = id;
    else params.query = data.get('query');
    if (data.get('since')) params.since = data.get('since');
    status.textContent = 'Mapping local notes…';
    result.replaceChildren();
    try {
      var map = await api('focused_map', params);
      if (!form.isConnected || current !== generation) return;
      if (!map.nodes.length) { status.textContent = 'No notes match. Try a narrower phrase or clear the filters.'; return; }
      status.textContent = map.nodes.length + (map.nodes.length === 1 ? ' note' : ' notes') + ', ' + map.edges.length +
        (map.edges.length === 1 ? ' link.' : ' links.') + (map.bounded ? ' Limits reached. Narrow the query or focus a note.' : '');
      draw(map);
    } catch (error) { if (current === generation) status.innerHTML = errorBox(error); }
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

  if (id) form.requestSubmit();
}
