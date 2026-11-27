/* global BRAIN, STATUS, R, esc, get, headers, basename, conceptHref, mountAnswerActions, showAnswerSources */
(function () {
  'use strict';

  const endpoint = '/api/ask/conversations';
  const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
  const threadId = () => /^#ask(?:-plan)?\/([a-f0-9-]+)$/u.exec(location.hash)?.[1];
  const threadHref = (mode, id) => '#' + (mode === 'ask-plan' ? 'ask-plan' : 'ask') + '/' + (id || 'new');
  let sidebar;

  function conversationApi(input) {
    if (typeof input === 'string') return get(endpoint + '?id=' + encodeURIComponent(input)).then(({ result }) => result);
    if (!input) return get(endpoint).then(({ result }) => result);
    return fetch(endpoint, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(input) })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || response.statusText);
        return payload.result;
      });
  }

  function shortDate(at) {
    return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function mountSidebar(mode, current) {
    sidebar?.remove();
    sidebar = undefined;
    if (!['ask', 'ask-plan', 'browse'].includes(mode)) return;
    const nav = document.getElementById('nav');
    const panel = document.createElement('section');
    panel.className = 'knowledge-navigation';
    panel.innerHTML = '<header class="knowledge-navigation-title"><h2>Knowledge</h2>' +
      '<a class="knowledge-new" aria-label="New conversation" title="New conversation" href="' + threadHref(mode) + '">+</a></header>' +
      '<section class="knowledge-spaces"><div class="knowledge-section-title"><h3>Spaces</h3><a href="#settings/brains" title="Manage brain folders">Manage</a></div>' +
      '<div data-knowledge-spaces></div></section><section class="knowledge-conversations" aria-label="Conversations">' +
      '<div class="knowledge-section-title"><h3>Conversations</h3></div>' +
      '<input type="search" aria-label="Filter conversations" placeholder="Filter conversations">' +
      '<div data-knowledge-list class="knowledge-thread-list"></div></section>';
    nav.querySelector('.group:nth-of-type(2)')?.before(panel);
    if (!panel.isConnected) nav.querySelector('.foot').before(panel);
    sidebar = panel;
    panel.querySelector('.knowledge-new').addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      panel.closest('dialog')?.close();
      if (location.hash === threadHref(mode)) window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const spaceList = panel.querySelector('[data-knowledge-spaces]');
    const spacePicker = document.getElementById('brain');
    for (const choice of spacePicker.options) {
      if (choice.disabled) continue;
      const label = choice.value ? choice.textContent : (STATUS?.brain || basename(STATUS?.bundle) || 'Current brain');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'knowledge-space';
      button.setAttribute('aria-pressed', String(choice.value === BRAIN));
      const mark = document.createElement('span');
      mark.className = 'knowledge-space-icon';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = label.slice(0, 1).toUpperCase();
      button.append(mark, label);
      button.addEventListener('click', () => {
        if (!current() || choice.value === BRAIN) return;
        history.replaceState(null, '', mode === 'browse' ? '#browse' : threadHref(mode));
        spacePicker.value = choice.value;
        spacePicker.dispatchEvent(new Event('change'));
      });
      spaceList.append(button);
    }

    const filter = panel.querySelector('input');
    const list = panel.querySelector('[data-knowledge-list]');
    let rows = [];
    let revision = 0;
    function draw() {
      if (!panel.isConnected || !current()) return;
      const query = filter.value.trim().toLowerCase();
      const active = threadId();
      const visible = rows.filter(({ title }) => title.toLowerCase().includes(query));
      const notes = visible.map(({ id, title, updated, turns }) => {
        const link = document.createElement('a');
        link.href = threadHref(mode, id);
        link.className = 'knowledge-thread';
        if (id === active) link.setAttribute('aria-current', 'page');
        const heading = document.createElement('strong');
        heading.textContent = title;
        const meta = document.createElement('small');
        meta.textContent = turns + (turns === 1 ? ' exchange' : ' exchanges') + ' · ' + shortDate(updated);
        link.append(heading, meta);
        link.addEventListener('click', () => panel.closest('dialog')?.close());
        return link;
      });
      if (!notes.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = query ? 'No conversations match.' : 'No saved conversations.';
        notes.push(empty);
      }
      list.replaceChildren(...notes);
    }
    async function refresh() {
      const version = ++revision;
      try {
        const available = await conversationApi();
        if (current() && version === revision) { rows = available; draw(); }
      } catch (error) { if (current() && version === revision) list.textContent = error.message; }
    }
    panel.addEventListener('knowledge-conversations-changed', refresh);
    filter.addEventListener('input', draw);
    void refresh();
  }

  function attachSidebarDrawer(button) {
    if (!sidebar?.isConnected || !button) return;
    const panel = sidebar;
    const position = document.createComment('Knowledge conversations');
    panel.before(position);
    const dialog = document.createElement('dialog');
    dialog.className = 'workspace-drawer knowledge-drawer';
    dialog.setAttribute('aria-label', 'Conversations');
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close conversations';
    close.addEventListener('click', () => dialog.close());
    dialog.append(close);
    button.after(dialog);
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => { dialog.append(panel); dialog.showModal(); close.focus(); });
    dialog.addEventListener('close', () => {
      if (panel !== sidebar) return;
      position.after(panel);
      button.focus();
    });
  }

  function focusSources(parent, citations, current, drawer, selected) {
    showAnswerSources(parent, citations, current);
    if (drawer?.getClientRects().length && !parent.closest('dialog[open]')) drawer.click();
    const match = selected && Array.from(parent.children).find((card) => card.dataset.knowledgeSource === selected);
    const preview = match && match.querySelector('details');
    if (preview) {
      preview.open = true;
      preview.querySelector('summary').focus();
    } else if (!parent.closest('dialog[open]')) parent.closest('aside')?.querySelector('summary')?.focus();
  }

  function renderAnswer(body, result, sourcePanel, current, drawer) {
    const referenced = new Map(result.citations.map((item, index) => [item.id, { ...item, index }]));
    const markdown = document.createElement('template');
    markdown.innerHTML = R.renderMarkdown(result.answer);
    markdown.content.querySelectorAll('img').forEach((image) => image.replaceWith(image.alt));
    body.replaceChildren(markdown.content);
    R.wireLinks(body, { baseId: '', hrefFor: conceptHref, known: (id) => referenced.has(id) });
    if (!referenced.size) return;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('a,code,pre')) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.textContent;
      const citations = Array.from(text.matchAll(/\[([^\][\n]+)\]/gu)).filter((match) => referenced.has(match[1].trim()));
      if (!citations.length) continue;
      const replacement = document.createDocumentFragment();
      let offset = 0;
      for (const match of citations) {
        const cite = referenced.get(match[1].trim());
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'knowledge-inline-citation';
        button.textContent = cite.index + 1;
        button.setAttribute('aria-label', 'Open source ' + (cite.index + 1) + ', ' + cite.title);
        button.addEventListener('click', () => focusSources(sourcePanel, result.citations, current, drawer, cite.id));
        replacement.append(text.slice(offset, match.index), button);
        offset = match.index + match[0].length;
      }
      replacement.append(text.slice(offset));
      node.replaceWith(replacement);
    }
  }

  function questionCard(question, at) {
    const row = document.createElement('article');
    row.className = 'knowledge-user-message';
    const author = document.createElement('div');
    author.className = 'knowledge-author';
    author.innerHTML = '<span aria-hidden="true">You</span><strong>You</strong>';
    if (at) {
      const date = document.createElement('time');
      date.dateTime = at;
      date.textContent = shortDate(at);
      author.append(date);
    }
    const body = document.createElement('p');
    body.textContent = question;
    row.append(author, body);
    return row;
  }

  function citationsRow(result, sourcePanel, current, drawer) {
    const footer = document.createElement('div');
    footer.className = 'knowledge-answer-footer row';
    const meta = document.createElement('span');
    meta.className = 'muted';
    const count = result.citations.length;
    meta.textContent = count + (count === 1 ? ' source cited' : ' sources cited') + (result.model ? ' · ' + result.model : '');
    footer.append(meta);
    if (count) {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'small';
      show.textContent = 'Inspect citations';
      show.addEventListener('click', () => focusSources(sourcePanel, result.citations, current, drawer));
      footer.append(show);
    }
    return footer;
  }

  function historyFields() {
    return '<details class="knowledge-history-preview" data-knowledge-previous hidden><summary>Previous exchange</summary>' +
      '<pre></pre><label class="row"><input type="checkbox" name="includePrevious"> Include this exchange in the follow-up</label></details>';
  }

  function mountConversation({ root, mode, arg, current, sourcePanel, form }) {
    const title = root.querySelector('[data-knowledge-title]');
    const passage = root.querySelector('[data-knowledge-turns]');
    const live = root.querySelector('[data-knowledge-live]');
    const user = live.querySelector('[data-knowledge-question]');
    const drawer = root.querySelector('[data-answer-drawer]');
    const previousBox = form.querySelector('[data-knowledge-previous]');
    const options = root.querySelector('[data-knowledge-actions]');
    const optionsForm = options?.querySelector('form');
    const threadStatus = root.querySelector('[data-knowledge-thread-status]');
    let id = idPattern.test(arg || '') ? arg : undefined;
    let turns = [];
    let ready = !id;
    let previous = null;
    let inProgress = false;

    function setPrevious(exchange) {
      previous = exchange;
      previousBox.hidden = !exchange || STATUS?.readonly !== false;
      previousBox.querySelector('pre').textContent = exchange ? 'You\n' + exchange.question + '\n\nAnswer\n' + exchange.answer : '';
      form.elements.includePrevious.checked = false;
      previousBox.open = false;
    }

    function setIdentity(name) {
      title.textContent = name;
      if (optionsForm) optionsForm.elements.title.value = name;
      options.hidden = !id || STATUS?.readonly !== false;
      const providerLink = root.querySelector('[data-knowledge-provider-link]');
      providerLink.href = threadHref(mode === 'ask-plan' ? 'ask' : 'ask-plan', id);
      root.querySelector('[data-knowledge-subtitle]').textContent = id
        ? (STATUS?.brain || basename(STATUS?.bundle) || 'Current brain') + ' · ' + turns.length + (turns.length === 1 ? ' exchange' : ' exchanges')
        : 'Ask across the notes in this brain';
    }

    function drawSaved() {
      passage.replaceChildren();
      for (const turn of turns) {
        const entry = document.createElement('section');
        entry.className = 'knowledge-exchange';
        const answer = document.createElement('article');
        answer.className = 'knowledge-answer';
        answer.innerHTML = answerHeading();
        const body = document.createElement('div');
        body.className = 'md';
        renderAnswer(body, turn.result, sourcePanel, current, drawer);
        const actions = document.createElement('div');
        actions.id = 'ask-copy-' + turn.id;
        answer.append(body, citationsRow(turn.result, sourcePanel, current, drawer), actions);
        entry.append(questionCard(turn.question, turn.at), answer);
        passage.append(entry);
        mountAnswerActions(actions, turn.question, turn.result, current);
      }
    }

    function next() {
      if (!ready || STATUS?.readonly !== false) return undefined;
      return { id: id || crypto.randomUUID(), turn: crypto.randomUUID(), previous: turns.at(-1)?.id || null,
        includePrevious: !!previous && form.elements.includePrevious.checked };
    }

    function start(question) {
      inProgress = true;
      options.hidden = true;
      drawSaved();
      user.replaceChildren(questionCard(question));
      root.querySelector('[data-knowledge-empty]').hidden = true;
      live.hidden = false;
      live.scrollIntoView({ block: 'nearest' });
    }

    function finish(question, result) {
      inProgress = false;
      if (result.conversation) {
        const { id: savedId, turn, at } = result.conversation;
        const isNew = !id;
        id = savedId;
        if (!turns.some((item) => item.id === turn)) turns.push({ id: turn, at, question, result });
        setPrevious({ question: question.slice(0, 2000).toWellFormed(), answer: result.answer.slice(0, 6000).toWellFormed() });
        setIdentity(isNew ? Array.from(question.replace(/[\s\p{Cc}]+/gu, ' ').trim()).slice(0, 100).join('') : title.textContent);
        if (isNew) current.replaceHash(threadHref(mode, id));
        sidebar?.dispatchEvent(new Event('knowledge-conversations-changed'));
      } else options.hidden = !id || STATUS?.readonly !== false;
      if (result.conversationError) threadStatus.textContent = result.conversationError;
      live.querySelector('[data-knowledge-answer-footer]').replaceChildren(citationsRow(result, sourcePanel, current, drawer));
      showAnswerSources(sourcePanel, result.citations, current);
    }

    function fail() { inProgress = false; options.hidden = !id || STATUS?.readonly !== false; }

    function showHistory() {
      if (inProgress) return;
      drawSaved();
      live.hidden = true;
    }

    optionsForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!id || !current() || inProgress) return;
      try {
        const renamed = await conversationApi({ action: 'rename', id, title: optionsForm.elements.title.value });
        if (!current()) return;
        setIdentity(renamed.title);
        options.open = false;
        sidebar?.dispatchEvent(new Event('knowledge-conversations-changed'));
        threadStatus.textContent = 'Conversation renamed.';
      } catch (error) { if (current()) threadStatus.textContent = error.message; }
    });
    options.querySelector('[data-delete-conversation]').addEventListener('click', async () => {
      if (!id || !current() || inProgress || !confirm('Delete this saved conversation?')) return;
      try {
        await conversationApi({ action: 'delete', id, confirm: true });
        if (current()) location.hash = threadHref(mode);
      } catch (error) { if (current()) threadStatus.textContent = error.message; }
    });

    root.querySelectorAll('[data-knowledge-suggestion]').forEach((button) => button.addEventListener('click', () => {
      const input = form.elements.question;
      input.value = button.dataset.knowledgeSuggestion;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }));
    form.elements.question.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); }
    });
    attachSidebarDrawer(root.querySelector('[data-knowledge-drawer]'));
    if (id) {
      root.querySelector('[data-knowledge-empty]').hidden = true;
      threadStatus.textContent = 'Opening conversation…';
      void conversationApi(id).then((stored) => {
        if (!current()) return;
        turns = stored.turns;
        ready = true;
        drawSaved();
        setPrevious(stored.previous);
        setIdentity(stored.title);
        threadStatus.textContent = '';
        if (turns.length) showAnswerSources(sourcePanel, turns.at(-1).result.citations, current);
      }, (error) => { if (current()) threadStatus.textContent = error.message; });
    }
    return { ready: () => ready, next, start, finish, fail, showHistory };
  }

  function conversationHeader(title, workLinks) {
    return '<header class="knowledge-main-header"><div><h2 data-knowledge-title>' + title + '</h2>' +
      '<p class="muted" data-knowledge-subtitle>Ask across the notes in this brain</p></div><div class="row knowledge-header-actions">' +
      '<button class="small" type="button" data-knowledge-drawer>Conversations</button>' +
      '<button class="small" type="button" data-answer-drawer>Answer sources</button>' +
      '<details data-knowledge-actions hidden><summary>Conversation options</summary><form class="stack card">' +
      '<label class="field"><span>Conversation title</span><input name="title" maxlength="100" required></label>' +
      '<div class="row"><button type="submit">Rename</button><button class="danger" type="button" data-delete-conversation>Delete conversation</button></div>' +
      '</form></details></div></header><div class="knowledge-provider-row row">' + workLinks +
      '<span data-knowledge-thread-status role="status"></span></div>';
  }

  function conversationEmpty() {
    return '<section class="knowledge-empty stack" data-knowledge-empty><h3>Ask your knowledge base</h3>' +
      '<p class="muted">Find answers in the notes you have added to this brain.</p>' +
      '<div class="knowledge-suggestions">' + ['What have I saved recently?', 'Which topics are covered in my notes?',
        'Summarize the main points in my sources', 'Find related notes and explain the links'].map((item) =>
        '<button type="button" data-knowledge-suggestion="' + esc(item) + '">' + esc(item) + '</button>').join('') + '</div></section>';
  }

  function answerHeading() {
    return '<div class="knowledge-author"><span aria-hidden="true">ok</span><strong>okbrain</strong></div>';
  }

  window.okbKnowledge = { mountSidebar, attachSidebarDrawer, mountConversation, conversationHeader, conversationEmpty, historyFields, renderAnswer, answerHeading };
})();
