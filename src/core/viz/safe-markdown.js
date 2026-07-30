// Shared markdown → HTML for both viewers (the viz.html export and the GUI).
//
// Concept bodies are untrusted input: they arrive via `okb clip` (arbitrary web
// pages), `okb rss` (arbitrary feeds), `okb import`, and git-synced bundles from
// other devices/collaborators — and markdown permits inline HTML by spec, which
// marked passes through verbatim. Rendering that into innerHTML is a stored-XSS
// channel: in the GUI the page holds the API token (window.OKB_TOKEN), so a
// payload there reaches every write/admin op; in viz.html it can exfiltrate the
// whole graph. So raw HTML renders as escaped source text, and only vetted URL
// schemes survive on links/images. Markdown itself is unaffected.
//
// Loaded after marked.js by both surfaces; exposes `window.okbMarkdown(md)`.

(function (global) {
  'use strict';

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  // Anything scheme-less (relative links, the viewer's own `#concept:` anchors)
  // is fine; anything that declares a scheme must declare one of these.
  var SAFE_SCHEME = /^(?:https?|mailto|ftp):/i;
  var HAS_SCHEME = /^[a-z][a-z0-9+.\-]*:/i;

  /** The href to emit, or null when the scheme is not one we render. */
  function safeUrl(href) {
    var u = String(href == null ? '' : href).trim();
    // Control characters can split a scheme past the regex ("java\nscript:"),
    // and browsers strip them back out before navigating.
    if (/[\u0000-\u001f\u007f]/.test(u)) return null;
    if (HAS_SCHEME.test(u) && !SAFE_SCHEME.test(u)) return null;
    return u;
  }

  function build(Marked) {
    var md = new Marked();
    md.use({
      renderer: {
        // Both block and inline raw HTML land here — show the source, don't run it.
        html: function (token) { return esc(token.text); },
        link: function (token) {
          var text = this.parser.parseInline(token.tokens);
          var href = safeUrl(token.href);
          if (href === null) return text; // keep the label, drop the navigation
          return '<a href="' + esc(href) + '"' +
            (token.title ? ' title="' + esc(token.title) + '"' : '') + '>' + text + '</a>';
        },
        image: function (token) {
          var href = safeUrl(token.href);
          if (href === null) return esc(token.text);
          return '<img src="' + esc(href) + '" alt="' + esc(token.text) + '"' +
            (token.title ? ' title="' + esc(token.title) + '"' : '') + '>';
        },
      },
    });
    return function (markdown) { return md.parse(String(markdown == null ? '' : markdown)); };
  }

  global.okbMarkdown = build(global.marked.Marked);
  // Exported for the unit tests, which load this file outside a browser.
  global.okbSafeUrl = safeUrl;
})(typeof globalThis !== 'undefined' ? globalThis : this);
