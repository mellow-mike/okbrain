(function () {
  'use strict';

  const providers = {
    drive: { label: 'Google Drive', credential: 'OAuth access token', item: 'Google Doc or text file link or ID',
      guide: 'https://developers.google.com/oauthplayground/', guideLabel: 'Get a Drive access token',
      setup: 'Use a short-lived OAuth access token with the Drive read-only scope (https://www.googleapis.com/auth/drive.readonly).',
      detail: 'Preview one Google Doc, Markdown file, or plain-text file.' },
    slack: { label: 'Slack', credential: 'Slack bot or user token', item: 'Slack channel message link',
      guide: 'https://docs.slack.dev/reference/methods/conversations.history/', guideLabel: 'Slack token and scopes',
      setup: 'Use a Slack bot or user token with channels:history or groups:history. The token must be able to read the selected channel.',
      detail: 'Preview one channel message from its copied Slack link.' },
    linear: { label: 'Linear', credential: 'Read-only personal API key', item: 'Linear issue link, key, or UUID',
      guide: 'https://linear.app/docs/api-and-webhooks', guideLabel: 'Create a Linear API key',
      setup: 'Create a personal API key in Linear Security & Access and select the Read permission.',
      detail: 'Preview the title and description of one issue.' },
  };

  function mount(parent, { readonly, headers, onImport }) {
    const repeats = {};
    for (const [provider, info] of Object.entries(providers)) {
      const panel = document.createElement('details');
      panel.className = 'card source-panel';
      panel.innerHTML = '<summary><strong></strong> <span class="muted" data-connection></span></summary>' +
        '<div class="source-panel" data-body></div><div role="status" data-feedback></div>';
      panel.querySelector('strong').textContent = info.label;
      parent.append(panel);
      const badge = panel.querySelector('[data-connection]');
      const body = panel.querySelector('[data-body]');
      const feedback = panel.querySelector('[data-feedback]');
      let busy = false;
      let connected = false;
      let label = info.label;

      async function call(action, input) {
        const get = input === undefined;
        const response = await fetch('/api/personal/sources/' + provider + '/' + action, {
          method: get ? 'GET' : 'POST', headers: headers(get ? {} : { 'content-type': 'application/json' }),
          cache: 'no-store', body: get ? undefined : JSON.stringify(input),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        return data.result;
      }

      function message(text, error = false) {
        feedback.className = error ? 'error' : '';
        feedback.textContent = text;
      }

      async function work(button, action) {
        if (busy) return;
        busy = true;
        button.disabled = true;
        message('Working…');
        try { await action(); }
        catch (error) { if (panel.isConnected) message(error.message, true); }
        finally { busy = false; button.disabled = false; }
      }

      function link(id, text) {
        const element = document.createElement('a');
        element.href = '#concept/' + encodeURIComponent(id);
        element.textContent = text;
        return element;
      }

      function credentialForm() {
        const form = document.createElement('form');
        form.className = 'source-panel';
        form.innerHTML = '<p></p><a target="_blank" rel="noopener noreferrer"></a>' +
          '<label class="field"><span></span><input name="token" type="password" maxlength="2048" autocomplete="off" spellcheck="false" required></label>' +
          '<label class="row"><input name="allow" type="checkbox" required> Allow okbrain to read items I select.</label>' +
          '<div class="row"><button type="submit"></button></div>';
        form.querySelector('p').textContent = info.setup;
        const instructions = form.querySelector('a');
        instructions.href = info.guide;
        instructions.textContent = info.guideLabel;
        form.querySelector('label span').textContent = info.credential;
        const button = form.querySelector('button');
        button.textContent = connected ? 'Replace credential' : 'Connect ' + info.label;
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void work(button, async () => {
            try {
              show(await call('connect', { token: form.elements.token.value, allow: form.elements.allow.checked }));
              message('Credential saved. Preview a selected item to check access.');
              body.querySelector('input[name=item]')?.focus();
            } finally { form.elements.token.value = ''; }
          });
        });
        return form;
      }

      function show(state) {
        if (!panel.isConnected) return;
        connected = state.connected;
        badge.textContent = connected ? 'Connected' : 'Disconnected';
        body.replaceChildren();
        const details = document.createElement('p');
        details.textContent = info.detail;
        body.append(details);
        if (readonly) return;
        if (!connected) {
          body.append(credentialForm());
          return;
        }

        const form = document.createElement('form');
        form.className = 'source-panel';
        form.innerHTML = '<div class="grid"><label class="field"><span></span><input name="item" maxlength="2048" spellcheck="false" required></label>' +
          '<label class="field"><span>Source name</span><input name="label" maxlength="80" required></label></div>' +
          '<div class="row"><button type="submit">Preview item</button><button type="button" data-disconnect>Disconnect</button></div>';
        form.querySelector('label span').textContent = info.item;
        const selection = form.elements.namedItem('item');
        form.elements.label.value = label;
        const preview = document.createElement('div');
        preview.className = 'source-panel';
        const replace = document.createElement('details');
        replace.innerHTML = '<summary>Replace credential</summary>';
        replace.append(credentialForm());
        body.append(form, preview, replace);
        let revision = 0;
        form.addEventListener('input', () => { revision++; preview.replaceChildren(); message(''); });
        const disconnect = form.querySelector('[data-disconnect]');
        disconnect.addEventListener('click', () => void work(disconnect, async () => {
          show(await call('disconnect', {}));
          message(info.label + ' disconnected.');
          body.querySelector('input[name=token]')?.focus();
        }));
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (busy) return;
          const attempt = ++revision;
          const button = form.querySelector('[type=submit]');
          label = form.elements.label.value;
          const input = { item: selection.value, name: label };
          preview.replaceChildren();
          void work(button, async () => {
            const result = await call('preview', input);
            if (!panel.isConnected || revision !== attempt) { if (panel.isConnected) message('Selection changed. Preview it again.'); return; }
            const row = result.rows[0];
            const title = document.createElement('strong');
            title.textContent = row.title;
            const excerpt = document.createElement('details');
            excerpt.innerHTML = '<summary>Preview Markdown</summary><pre class="source-markdown"></pre>';
            excerpt.open = true;
            excerpt.querySelector('pre').textContent = result.markdown;
            preview.append(title, excerpt);
            if (row.status === 'unchanged') {
              preview.append(link(row.id, 'Open saved draft'));
              message('This version is already saved.');
              return;
            }
            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'primary';
            save.textContent = row.status === 'changed' ? 'Save as a new private draft' : 'Save private draft';
            preview.append(save);
            message(row.status === 'changed' ? 'Item changed. Earlier drafts keep their edits.' : 'Preview ready.');
            save.addEventListener('click', () => void work(save, async () => {
              if (revision !== attempt) return;
              const imported = await call('import', { previewId: result.previewId });
              if (!panel.isConnected || revision !== attempt) return;
              if (imported.imported.length) {
                const saved = link(imported.imported[0], 'Open ' + row.title);
                preview.replaceChildren(saved);
                saved.focus();
                message('Private draft saved.');
                onImport();
              }
            }));
          });
        });
      }

      badge.textContent = 'Checking…';
      call('status').then(show, (error) => { show({ connected: false }); message(error.message, true); });
      repeats[provider] = (name) => {
        if (busy || readonly) return;
        panel.open = true;
        label = name;
        const input = body.querySelector('input[name=item]');
        if (input) {
          body.querySelector('input[name=label]').value = name;
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        } else body.querySelector('input[name=token]')?.focus();
      };
    }
    return (provider, label) => repeats[provider]?.(label);
  }

  window.okbLiveSources = { mount, has: (kind) => Object.hasOwn(providers, kind) };
})();
