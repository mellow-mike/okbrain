// Shared graph canvas and note inspector for the app and offline export.
(function () {
  'use strict';

  var R = window.okbRender;
  var esc = R.esc;
  var typeName = function (value) { return value || '(untyped)'; };
  var hrefFor = function (id) { return '#concept:' + encodeURIComponent(id); };
  var ms = function (token) { return parseFloat(Okb.token(token)) || 0; };

  function mount(data, controls, options) {
    var nodes = new Map(data.nodes.map(function (note) { return [note.id, note]; }));
    var outgoing = new Map(), incoming = new Map(), counts = new Map();
    data.nodes.forEach(function (note) {
      var type = typeName(note.type);
      counts.set(type, (counts.get(type) || 0) + 1);
    });
    function connect(map, from, to) {
      var ids = map.get(from) || [];
      ids.push(to);
      map.set(from, ids);
    }
    data.edges.forEach(function (edge) {
      connect(outgoing, edge.src, edge.dst);
      connect(incoming, edge.dst, edge.src);
    });
    var types = [...counts.keys()].sort();
    var activeTypes = new Set(types);
    var fill = new Map(), colors = {};
    function readTheme() {
      var palette = Okb.graphPalette();
      types.forEach(function (type, i) { fill.set(type, palette.slots[i] || palette.other); });
      ['ink-2', 'surface', 'danger', 'edge-line', 'accent'].forEach(function (key) { colors[key] = Okb.token(key); });
    }
    function color(key) { return function () { return colors[key]; }; }
    function swatch(type) {
      var i = types.indexOf(type);
      var slot = i >= 0 && i < 8 ? 'graph-' + (i + 1) : 'graph-other';
      return '<span class="swatch" style="background:var(--' + slot + ')"></span>';
    }
    readTheme();

    var cy = cytoscape({
      container: controls.canvas,
      elements: data.nodes.map(function (note) {
        return { data: { id: note.id, label: note.title || note.id, type: typeName(note.type), status: note.status,
          stale: note.stale, size: 16 + 4 * Math.sqrt(Math.min(note.bodyLen, 20000) / 100) } };
      }).concat(data.edges.map(function (edge) {
        return { data: { id: JSON.stringify([edge.src, edge.dst]), source: edge.src, target: edge.dst } };
      })),
      style: [
        { selector: 'node', style: {
          'background-color': function (node) { return fill.get(node.data('type')); },
          width: 'data(size)', height: 'data(size)', label: 'data(label)',
          'font-family': Okb.token('font-read'), 'font-size': 9, color: color('ink-2'),
          'text-outline-color': color('surface'), 'text-outline-width': 2,
          'text-valign': 'bottom', 'text-margin-y': 4,
          'text-wrap': 'ellipsis', 'text-max-width': '120px' } },
        { selector: 'node[?stale]', style: { 'border-width': 2, 'border-style': 'dashed', 'border-color': color('danger') } },
        { selector: 'node[status = "deprecated"]', style: { opacity: Number(Okb.token('opacity-deprecated')) } },
        { selector: 'edge', style: {
          width: 1.2, 'line-color': color('edge-line'), 'target-arrow-color': color('edge-line'),
          'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier' } },
        { selector: 'node:selected', style: { 'border-width': 2, 'border-style': 'solid', 'border-color': color('accent') } },
        { selector: '.dim, .faded', style: { opacity: Number(Okb.token('opacity-dim')) } },
      ],
      layout: { name: 'cose', animate: false }, wheelSensitivity: 0.2,
    });
    window.cy = cy;

    var listeners = new AbortController();
    function listen(element, event, callback) { element.addEventListener(event, callback, { signal: listeners.signal }); }
    function applyFilters() {
      var term = controls.search.value.trim().toLowerCase();
      cy.batch(function () {
        cy.elements().removeClass('dim');
        if (term) cy.elements().addClass('dim');
        cy.nodes().forEach(function (node) {
          node.style('display', activeTypes.has(node.data('type')) ? 'element' : 'none');
          var note = nodes.get(node.id());
          if (term && (note.id + ' ' + note.title + ' ' + note.tags.join(' ')).toLowerCase().includes(term)) {
            node.removeClass('dim');
            node.connectedEdges().removeClass('dim');
          }
        });
      });
    }
    controls.filters.innerHTML = types.map(function (type) {
      return '<label><input type="checkbox" checked data-type="' + esc(type) + '">' + swatch(type) + esc(type) +
        '<span class="count">' + counts.get(type) + '</span></label>';
    }).join('');
    listen(controls.filters, 'change', function (event) {
      var type = event.target.getAttribute('data-type');
      if (type === null) return;
      if (event.target.checked) activeTypes.add(type);
      else activeTypes.delete(type);
      applyFilters();
    });
    listen(controls.search, 'input', applyFilters);
    listen(controls.layout, 'change', function (event) {
      var duration = ms('dur-deliberate');
      cy.layout({ name: event.target.value, animate: duration > 0 ? 'end' : false,
        animationDuration: duration, animationEasing: Okb.token('ease-in-out') }).run();
    });
    listen(controls.fit, 'click', function () { cy.fit(undefined, 40); });

    function linkList(ids) {
      return '<ul>' + ids.map(function (id) {
        return '<li><a href="' + hrefFor(id) + '">' + esc(nodes.get(id)?.title || id) + '</a></li>';
      }).join('') + '</ul>';
    }
    function showDetail(id) {
      var note = nodes.get(id);
      if (!note) return;
      var type = typeName(note.type);
      var h = '<h2>' + esc(note.title || note.id) + '</h2>' +
        '<div class="meta"><span class="chip">' + swatch(type) + esc(type) + '</span><code>' + esc(note.id) + '</code></div>' +
        '<div class="meta">' + R.badges(note) + '</div>';
      if (options.actions) h += options.actions(note);
      if (note.description) h += '<p class="' + options.descriptionClass + '">' + esc(note.description) + '</p>';
      if (note.tags.length) h += '<div class="meta">' + note.tags.map(function (tag) {
        return '<span class="chip">' + esc(tag) + '</span>';
      }).join(' ') + '</div>';
      h += '<dl class="' + options.metadataClass + '">';
      if (options.showResource && note.resource) h += '<dt>Resource</dt><dd>' + R.resourceLink(note.resource) + '</dd>';
      h += '<dt>Generated</dt><dd>' + R.actorLine(note.generated) + '</dd>' +
        '<dt>Verified</dt><dd>' + (note.verified.length ? note.verified.map(R.actorLine).join('<br>') : '—') + '</dd>' +
        '<dt>Sources</dt><dd>' + R.sourcesList(note.sources) + '</dd></dl>' +
        '<div class="body md">' + R.renderMarkdown(note.body) + '</div>';
      var out = outgoing.get(id), back = incoming.get(id);
      if (out?.length) h += '<h3>Links to</h3>' + linkList(out);
      if (back?.length) h += '<h3>Cited by</h3>' + linkList(back);
      controls.detail.innerHTML = h;
      controls.detail.querySelectorAll('.body, dl').forEach(function (section) {
        R.wireLinks(section, { baseId: id, hrefFor: hrefFor, known: function (other) { return nodes.has(other); } });
      });
    }
    function focus(id) {
      var node = cy.getElementById(id);
      if (!node.nonempty()) return;
      cy.$(':selected').unselect();
      node.select();
      cy.animate({ center: { eles: node } }, { duration: ms('dur-slow'), easing: Okb.token('ease-in-out') });
      showDetail(id);
    }
    listen(controls.detail, 'click', function (event) {
      var link = event.target.closest('a[href^="#concept:"]');
      if (!link) return;
      event.preventDefault();
      var id = R.resolveInternal(link.getAttribute('href'));
      if (id) focus(id);
    });
    cy.on('tap', 'node', function (event) { showDetail(event.target.id()); });
    cy.on('mouseover', 'node', function (event) {
      cy.elements().difference(event.target.closedNeighborhood()).addClass('faded');
      if (!controls.tip) return;
      var note = nodes.get(event.target.id());
      var type = typeName(note.type);
      controls.tip.innerHTML = '<div class="t">' + esc(note.title || note.id) + '</div>' +
        '<div class="meta">' + swatch(type) + esc(type) + (note.stale ? ' · stale' : '') +
        (note.status !== 'stable' ? ' · ' + esc(note.status) : '') + '</div>' +
        (note.description ? '<div class="d">' + esc(note.description) + '</div>' : '');
      var point = event.renderedPosition, box = controls.canvas.getBoundingClientRect();
      controls.tip.style.left = Math.max(0, Math.min(point.x + 14, box.width - 270)) + 'px';
      controls.tip.style.top = Math.max(0, Math.min(point.y + 14, box.height - 90)) + 'px';
      controls.tip.style.display = 'block';
      controls.canvas.style.cursor = 'pointer';
    });
    cy.on('mouseout tap', 'node', function () {
      cy.elements().removeClass('faded');
      if (controls.tip) controls.tip.style.display = 'none';
      controls.canvas.style.cursor = '';
    });
    cy.on('pan zoom', function () { if (controls.tip) controls.tip.style.display = 'none'; });
    return {
      focus: focus,
      repaint: function () { readTheme(); cy.style().update(); },
      destroy: function () { listeners.abort(); cy.destroy(); if (window.cy === cy) window.cy = undefined; },
    };
  }

  window.okbGraphView = { mount: mount };
})();
