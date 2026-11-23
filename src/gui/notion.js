(function () {
  'use strict';

  const esc = window.okbRender.esc;
  const connectGuide = 'https://developers.notion.com/docs/authorization#internal-connection-auth-flow-set-up';

  function mount(parent, { readonly, headers, onImport }) {
    const path = '/api/personal/sources/notion/';
    let label = 'Notion pages';
    let busy = false;
    let connected = false;
    parent.innerHTML = '<h3>Live Notion pages</h3><div class="source-panel" data-notion-body></div>' +
      '<div role="status" data-notion-status></div>';
    const view = parent.querySelector('[data-notion-body]');
    const message = parent.querySelector('[data-notion-status]');
    const noteLink = (id, title) => '<a href="#concept/' + encodeURIComponent(id) + '">' + esc(title) + '</a>';

    async function call(action, input) {
      const get = input === undefined;
      const response = await fetch(path + action, {
        method: get ? 'GET' : 'POST',
        headers: headers(get ? {} : { 'content-type': 'application/json' }),
        cache: 'no-store',
        body: get ? undefined : JSON.stringify(input),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data.result;
    }

    function status(text, error = false) {
      message.className = error ? 'error' : '';
      message.textContent = text;
    }

    async function perform(button, fn) {
      if (busy) return;
      busy = button.disabled = true;
      status('Working…');
      try {
        await fn();
      } catch (error) {
        if (parent.isConnected) status(error.message, true);
      } finally {
        busy = button.disabled = false;
      }
    }

    function show(state) {
      if (!parent.isConnected) return;
      connected = state.connected;
      if (readonly) {
        view.innerHTML = '<p class="muted">' + (connected ? 'Notion is connected. ' : '') +
          'Choose a writable brain to connect and save drafts.</p>';
        return;
      }
      if (!connected) {
        view.innerHTML = '<p>Create an internal Notion connection with Read content access and share only the pages you plan to import. ' +
          '<a href="' + connectGuide + '" target="_blank" rel="noopener noreferrer">Set up an internal connection</a>.</p>' +
          '<form class="source-panel"><label class="field"><span>Internal connection token</span>' +
          '<input name="token" type="password" maxlength="280" autocomplete="off" spellcheck="false" required></label>' +
          '<label class="row"><input name="allow" type="checkbox" required> Allow okbrain to read the pages I select.</label>' +
          '<div class="row"><button type="submit">Connect Notion</button></div></form>';
        const form = view.querySelector('form');
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          perform(form.querySelector('button'), async () => {
            try {
              show(await call('connect', { token: form.elements.token.value, allow: form.elements.allow.checked }));
              status('Notion connected.');
            } finally {
              form.elements.token.value = '';
            }
          });
        });
        return;
      }

      view.innerHTML = '<p>Choose a page shared with this connection. The app fetches it from Notion when you preview.</p>' +
        '<form class="source-panel"><div class="grid"><label class="field"><span>Notion page URL or ID</span>' +
        '<input name="page" maxlength="512" spellcheck="false" required></label><label class="field"><span>Source name</span>' +
        '<input name="label" value="' + esc(label) + '" maxlength="80" required></label></div>' +
        '<div class="row"><button type="submit">Preview page</button>' +
        '<button type="button" data-notion-disconnect>Disconnect Notion</button></div></form>' +
        '<div class="source-panel" data-notion-preview></div>';
      const form = view.querySelector('form');
      const preview = view.querySelector('[data-notion-preview]');
      const disconnect = view.querySelector('[data-notion-disconnect]');
      form.addEventListener('input', () => preview.replaceChildren());
      disconnect.addEventListener('click', () => perform(disconnect, async () => {
        show(await call('disconnect', {}));
        status('Notion disconnected.');
      }));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const submitted = { page: form.elements.page.value, name: form.elements.label.value };
        const button = form.querySelector('button[type=submit]');
        label = submitted.name;
        preview.replaceChildren();
        perform(button, async () => {
          const response = await call('preview', submitted);
          if (!parent.isConnected) return;
          if (form.elements.page.value !== submitted.page || form.elements.label.value !== submitted.name) {
            status('The page selection changed. Preview it again.');
            return;
          }
          const row = response.rows[0];
          const ready = row.status === 'new' || row.status === 'changed';
          status(ready ? 'Page preview ready.' : row.reason || 'This version is already saved.');
          preview.innerHTML = '<strong>' + esc(row.title || 'Notion page') + '</strong>' +
            (response.partial ? '<p class="notice">Notion reported missing or truncated blocks. Review the available text before saving.</p>' : '') +
            '<details><summary>Preview Markdown</summary><pre class="source-markdown"></pre></details>' +
            (row.status === 'unchanged' ? noteLink(row.id, 'Open saved draft') : '') +
            (row.previous ? '<p>Earlier drafts keep their edits.</p>' : '') +
            (ready ? '<div class="row"><button type="button" class="primary" data-notion-save>' +
              (row.status === 'changed' ? 'Save as a new draft' : 'Save private draft') + '</button></div>' : '');
          preview.querySelector('pre').textContent = response.markdown;
          const save = preview.querySelector('[data-notion-save]');
          if (!save) return;
          save.addEventListener('click', () => perform(save, async () => {
            const result = await call('import', { previewId: response.previewId });
            if (!parent.isConnected) return;
            if (result.imported.length) {
              status('Private Notion draft saved.');
              preview.innerHTML = noteLink(result.imported[0], 'Open ' + row.title);
              preview.querySelector('a').focus();
              onImport();
            }
          }));
        });
      });
    }

    view.textContent = 'Loading Notion connection…';
    call('status').then((state) => {
      show(state);
      status('');
    }, (error) => {
      show({ connected: false });
      status(error.message, true);
    });
    return function repeat(name) {
      if (busy || readonly) return;
      label = name;
      if (connected) {
        const form = view.querySelector('form');
        form.elements.label.value = name;
        form.elements.page.value = '';
        view.querySelector('[data-notion-preview]').replaceChildren();
        form.elements.page.focus();
      } else view.querySelector('input')?.focus();
    };
  }

  window.okbNotion = { mount };
})();
