// Shared browser-side rendering for the GUI and the static viewer (one
// source, embedded into both via Bun text imports): markdown → HTML through
// `okbMarkdown` (safe-markdown.js: raw HTML escaped to source text, unsafe
// URL schemes dropped), OKF v0.2 footnote attribution, internal-link
// resolution, and the signal badges (status / trust tier / staleness).
// Loaded after marked.js and safe-markdown.js. Plain script, no build step.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** Inline markdown (a footnote definition) without the paragraph wrapper. */
  function inline(md) {
    return okbMarkdown(md).replace(/^<p>([\s\S]*?)<\/p>\s*$/, '$1');
  }

  /**
   * Markdown body → HTML with OKF §5.1 per-claim attribution resolved:
   * `[^id]` references (keyed to sources[].id) become superscript links and
   * their `[^id]: text` definitions collect into a numbered list at the end.
   * marked has no footnote syntax, so definitions are lifted out before
   * parsing and references are swapped in the rendered output — where they
   * survive as literal text — so nothing here ever bypasses the sanitizer.
   */
  function renderMarkdown(md) {
    var defs = {};
    var src = String(md == null ? '' : md).replace(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm, function (_, id, text) {
      defs[id] = text;
      return '';
    });
    var html = okbMarkdown(src);
    var used = [];
    html = html.replace(/\[\^([^\]\s<&]+)\]/g, function (m, id) {
      if (!Object.prototype.hasOwnProperty.call(defs, id)) return m;
      if (used.indexOf(id) < 0) used.push(id);
      return '<sup class="fn"><a href="#fn-' + esc(encodeURIComponent(id)) +
        '" title="' + esc(defs[id]) + '">' + (used.indexOf(id) + 1) + '</a></sup>';
    });
    if (used.length) {
      html += '<ol class="footnotes">' + used.map(function (id) {
        return '<li id="fn-' + esc(encodeURIComponent(id)) + '"><code>' + esc(id) + '</code> ' +
          inline(defs[id]) + '</li>';
      }).join('') + '</ol>';
    }
    return html;
  }

  /**
   * Resolve a link href to a concept id: `#concept:<enc>` anchors (rewired
   * bodies), bundle-absolute `/dir/x.md`, or a path relative to `baseId`.
   * Null for external, anchor-only, and non-`.md` targets.
   */
  function resolveInternal(href, baseId) {
    if (!href) return null;
    if (href.indexOf('#concept:') === 0) return decodeURIComponent(href.slice(9));
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.charAt(0) === '#') return null;
    var t = href.split('#')[0].split('?')[0];
    if (!/\.md$/.test(t)) return null;
    try { t = decodeURIComponent(t); } catch (e) { /* keep raw */ }
    var parts;
    if (t.charAt(0) === '/') parts = t.slice(1).split('/');
    else {
      var base = (baseId || '').split('/');
      base.pop();
      parts = base.concat(t.split('/'));
    }
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '' || p === '.') continue;
      if (p === '..') { if (!out.length) return null; out.pop(); }
      else out.push(p);
    }
    return out.join('/').slice(0, -3);
  }

  /**
   * Point every anchor somewhere sensible: internal links get
   * `opts.hrefFor(id)` (+ class "internal"), everything else opens in a new
   * tab. `opts.known(id)` may veto ids that aren't concepts.
   */
  function wireLinks(container, opts) {
    var anchors = container.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var href = a.getAttribute('href');
      if (href.indexOf('#fn-') === 0) continue;
      var id = resolveInternal(href, opts.baseId);
      if (id !== null && (!opts.known || opts.known(id))) {
        a.setAttribute('href', opts.hrefFor(id));
        a.className = 'internal';
        a.setAttribute('data-id', id);
      } else if (id === null) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
        a.className = 'external';
      } else {
        a.className = 'broken';
        a.title = 'not in this bundle: ' + id;
      }
    }
  }

  /** Status / trust / staleness chips for a concept's signals. */
  function badges(s) {
    var h = '<span class="badge status-' + esc(s.status) + '">' + esc(s.status) + '</span>' +
      '<span class="badge trust-' + esc(s.trust) + '">' + esc(s.trust.replace(/-/g, ' ')) + '</span>';
    if (s.stale) h += '<span class="badge stale">stale' + (s.staleAfter ? ' since ' + esc(String(s.staleAfter).slice(0, 10)) : '') + '</span>';
    else if (s.staleAfter) h += '<span class="badge fresh">stale after ' + esc(String(s.staleAfter).slice(0, 10)) + '</span>';
    return h;
  }

  function actorLine(ev) {
    if (!ev || !ev.by) return '—';
    return esc(ev.by) + (ev.at ? ' <span class="muted">· ' + esc(ev.at) + '</span>' : '');
  }

  /** `sources` entries as a list with credibility signals. */
  function sourcesList(sources) {
    if (!sources || !sources.length) return '<span class="muted">—</span>';
    return '<ul class="sources">' + sources.map(function (s) {
      var label = esc(s.title || s.resource);
      var res = String(s.resource || '');
      var link = /^https?:\/\//i.test(res)
        ? '<a href="' + esc(res) + '" target="_blank" rel="noopener" class="external">' + label + '</a>'
        : '<a href="' + esc(res) + '">' + label + '</a>';
      var sig = [];
      if (s.author) sig.push(esc(s.author));
      if (s.last_modified) sig.push('modified ' + esc(String(s.last_modified).slice(0, 10)));
      if (s.usage_count != null) sig.push(esc(s.usage_count) + ' uses');
      return '<li>' + (s.id ? '<code>' + esc(s.id) + '</code> ' : '') + link +
        (sig.length ? ' <span class="muted">(' + sig.join(' · ') + ')</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  window.okbRender = {
    esc: esc,
    renderMarkdown: renderMarkdown,
    resolveInternal: resolveInternal,
    wireLinks: wireLinks,
    badges: badges,
    actorLine: actorLine,
    sourcesList: sourcesList,
  };
})();
