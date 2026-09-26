// okbrain motion and theme helpers: window.Okb, from the design system's
// bundle (R5), shared by the GUI and the static viewer like render.js. One
// classic script, no dependencies, no network. Every helper degrades to an
// instant change when the browser lacks the API or the reader asks for
// reduced motion. Durations and easings are read from tokens.css.
(function () {
  'use strict';

  var root = document.documentElement;
  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function reduced() { return !!(motionQuery && motionQuery.matches); }
  function token(name) { return getComputedStyle(root).getPropertyValue('--' + name).trim(); }
  function ms(name) { return parseFloat(token(name)) || 0; }
  function transitions() { return typeof document.startViewTransition === 'function' && !reduced(); }
  function restart(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth; // reflow so the animation runs again
    el.classList.add(cls);
  }
  function number(el, cls) {
    if (!el) return;
    for (var i = 0; i < el.children.length; i++) el.children[i].style.setProperty('--i', i);
    restart(el, cls);
  }

  /** Dark unless the person chose light. The new theme floods out from `origin`. */
  var theme = {
    key: 'okb-gui-theme',
    get: function () { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; },
    restore: function () {
      var saved = null;
      try { saved = localStorage.getItem(theme.key); } catch (e) { /* storage blocked: stay dark */ }
      root.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
      return theme.get();
    },
    set: function (mode, origin) {
      function apply() {
        root.setAttribute('data-theme', mode);
        try { localStorage.setItem(theme.key, mode); } catch (e) { /* not persisted */ }
      }
      function done() { root.classList.remove('flooding'); }
      if (!origin || !transitions()) { apply(); return Promise.resolve(); }
      var box = origin.getBoundingClientRect();
      var x = box.left + box.width / 2, y = box.top + box.height / 2;
      var r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.classList.add('flooding');
      var t = document.startViewTransition(apply);
      t.ready.then(function () {
        root.animate(
          { clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + r + 'px at ' + x + 'px ' + y + 'px)'] },
          { duration: ms('dur-deliberate'), easing: token('ease-ink'), pseudoElement: '::view-transition-new(root)' });
      }, done);
      return t.finished.then(done, done);
    },
    toggle: function (origin) { return theme.set(theme.get() === 'dark' ? 'light' : 'dark', origin); },
  };

  /**
   * Page turn: run `update` (it may return a promise) as one view transition.
   * `shared` (a card or row title) morphs into the new view's concept title.
   */
  function go(update, shared) {
    if (!transitions()) return Promise.resolve(update());
    if (shared) shared.style.viewTransitionName = 'concept-title';
    var t = document.startViewTransition(function () {
      if (shared) shared.style.viewTransitionName = '';
      return update();
    });
    return t.updateCallbackDone;
  }

  /** File a card away: 'done' lifts it up and out, 'snooze' slides it aside; the list closes the gap. */
  function fileAway(el, kind) {
    if (!el) return Promise.resolve();
    if (reduced() || !el.animate) { el.remove(); return Promise.resolve(); }
    var cs = getComputedStyle(el);
    var gap = parseFloat(getComputedStyle(el.parentNode).rowGap) || 0;
    var edge = el.nextElementSibling ? 'marginBottom' : 'marginTop';
    var away = kind === 'snooze' ? 'translateX(32px)' : 'translateY(-8px)';
    var h = el.offsetHeight + 'px';
    var from = { opacity: 1, transform: 'none', height: h, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
      borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth };
    var to = { opacity: 0, transform: away, height: '0px', paddingTop: '0px', paddingBottom: '0px',
      borderTopWidth: '0px', borderBottomWidth: '0px' };
    from[edge] = '0px';
    to[edge] = -gap + 'px';
    el.style.overflow = 'hidden';
    var a = el.animate([from, { opacity: 0, transform: away, height: h, offset: 0.45 }, to],
      { duration: ms('dur-slow') + ms('dur-base'), easing: token('ease-in-out'), fill: 'forwards' });
    return a.finished.then(function () { el.remove(); }, function () { el.remove(); });
  }

  /** "scoring" with three breathing dots; the verb alone is announced. */
  function working(el, verb) {
    var s = document.createElement('span');
    s.className = 'working';
    s.setAttribute('role', 'status');
    s.textContent = verb || 'working';
    var dots = document.createElement('span');
    dots.className = 'dots';
    dots.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 3; i++) dots.appendChild(document.createElement('i')).textContent = '.';
    s.appendChild(dots);
    el.replaceChildren(s);
  }

  /** Split the sidebar wordmark into letters so busy() can wave it. */
  function wordmark(el) {
    if (!el || el.classList.contains('wm')) return;
    var text = el.textContent.trim();
    el.setAttribute('aria-label', text);
    el.classList.add('wm');
    el.replaceChildren.apply(el, text.split('').map(function (c, i) {
      var s = document.createElement('span');
      s.setAttribute('aria-hidden', 'true');
      s.style.setProperty('--i', i);
      s.textContent = c;
      return s;
    }));
  }

  var pending = 0;
  /** App-level work (index, embed, ask): the wordmark waves until each busy(true) has its busy(false). */
  function busy(on) {
    pending = Math.max(0, pending + (on ? 1 : -1));
    root.classList.toggle('busy', pending > 0);
  }

  /** The eight graph slots and the overflow grey for the current theme. */
  function graphPalette() {
    var slots = [];
    for (var i = 1; i <= 8; i++) slots.push(token('graph-' + i));
    return { slots: slots, other: token('graph-other') };
  }

  window.Okb = {
    theme: theme,
    go: go,
    fileAway: fileAway,
    enter: function (list) { number(list, 'enter'); },
    settle: function (el) { number(el, 'settle'); },
    flash: function (el) { restart(el, 'flash'); },
    stamp: function (badge) { restart(badge, 'just'); },
    working: working,
    wordmark: wordmark,
    busy: busy,
    graphPalette: graphPalette,
    token: token,
    reduced: reduced,
  };
})();
