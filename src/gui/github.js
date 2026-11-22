(function () {
  'use strict';

  const esc = window.okbRender.esc;
  const external = (url, label) => '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';

  function activityList(items, empty) {
    if (!items.length) return '<p class="muted">' + esc(empty) + '</p>';
    return '<ul class="plain stack">' + items.map((item) =>
      '<li>' + external(item.url, '#' + item.number + ' ' + item.title) +
      (item.draft ? ' <span class="chip">Draft</span>' : '') + '</li>').join('') + '</ul>';
  }

  function mount(parent, { project, coding, readonly, target }) {
    const path = '/projects/' + encodeURIComponent(project.id) + '/github-';
    parent.className = 'coding-panel stack';
    parent.innerHTML = '<h3>GitHub</h3><div data-github-body><p class="muted">Loading connection…</p></div>' +
      '<div class="coding-feedback" role="status"></div>';
    const area = parent.querySelector('[data-github-body]');
    const feedback = parent.querySelector('[role="status"]');
    let busy = false;

    function notice(message, error = false) {
      feedback.className = error ? 'coding-feedback error' : 'coding-feedback';
      feedback.textContent = message;
    }

    async function perform(button, action) {
      if (busy) return;
      busy = button.disabled = true;
      notice('');
      try {
        await action();
      } catch (error) {
        notice(error.message, true);
      } finally {
        busy = button.disabled = false;
      }
    }

    function settings(state) {
      if (!state.canConfigure || readonly) return '';
      return '<details' + (state.connection ? '' : ' open') + ' data-github-settings><summary>Connection settings</summary>' +
        '<form class="stack coding-form"><p class="muted">Select a repository from this workspace’s Git remotes. ' +
        'For private repositories, use a fine-grained token limited to this repository with Issues and Pull requests read access.</p>' +
        '<div class="row"><button type="button" data-detect>Detect GitHub remotes</button></div>' +
        '<label class="field"><span>Git remote</span><select name="remote" required disabled><option>Detect remotes first</option></select></label>' +
        '<label class="field"><span>Fine-grained token (optional for public repositories)</span>' +
        '<input type="password" name="token" autocomplete="off" spellcheck="false" maxlength="280"></label>' +
        '<div class="row"><button type="submit" disabled>Save connection</button>' +
        (state.connection ? '<button type="button" data-disconnect>Disconnect</button>' : '') + '</div></form>' +
        (state.connection ? '<form class="stack coding-form" data-pr-token><p class="muted">To publish pull requests, use a separate fine-grained token limited to this repository with Pull requests write access.</p>' +
        '<label class="field"><span>Pull request publishing token</span><input type="password" name="token" required autocomplete="off" spellcheck="false" maxlength="280"></label>' +
        '<div class="row"><button type="submit">Save publishing token</button>' +
        (state.connection.hasPublishToken ? '<button type="button" data-remove-pr-token>Remove publishing token</button>' : '') +
        '</div></form>' : '') + '</details>';
    }

    function handoff(state) {
      if (readonly) return '';
      return '<details data-github-handoff><summary>Prepare GitHub review</summary><form class="stack coding-form">' +
        '<p class="muted">Choose an accepted coding request and branches that are already on GitHub. ' +
        'Open the comparison to review the proposed branch changes.</p>' +
        '<label class="field"><span>Accepted request</span><select name="request" required></select></label>' +
        '<div class="row"><button type="button" data-load-runs>Refresh accepted requests</button></div>' +
        '<div class="coding-grid"><label class="field"><span>Base branch</span><input name="base" maxlength="255" required></label>' +
        '<label class="field"><span>Head branch</span><input name="head" maxlength="255" required></label></div>' +
        '<div class="row"><button type="submit">Prepare comparison</button></div><div data-comparison></div>' +
        (state.canConfigure ? '<details data-pr-options><summary>Create a pull request</summary><div class="stack coding-form">' +
        (state.connection.hasPublishToken ? '<label class="field"><span>Pull request title</span><input name="prTitle" maxlength="256"></label>' +
        '<label class="field"><span>Pull request Markdown</span><textarea name="prBody" rows="5" maxlength="16384"></textarea></label>' +
        '<label class="row"><input type="checkbox" name="prDraft" checked><span>Open as a draft</span></label>' +
        '<div class="row"><button type="button" data-preview-pr>Preview pull request</button>' :
        '<p class="muted">Save a publishing token in Connection settings to create pull requests.</p><div class="row">') +
        '<button type="button" data-recover-pr>Find or recover pull request</button></div><div class="stack" data-pr-receipt></div></div></details>' : '') +
        '</form></details>';
    }

    function show(state) {
      const connection = state.connection;
      area.className = 'stack';
      area.innerHTML = (connection ?
        '<div class="row"><strong>' + external(connection.url, connection.repository) + '</strong><span class="muted">' +
        esc(connection.remote) + (connection.hasToken ? ' · project token saved' : ' · public access') + '</span></div>' +
        '<div class="row"><button type="button" data-github-refresh>Refresh GitHub activity</button></div>' +
        '<div data-github-activity class="stack"></div>' + handoff(state) :
        '<p class="muted">This project has no connected GitHub repository.</p>') + settings(state);

      const configuration = area.querySelector('[data-github-settings] form');
      if (configuration) {
        const select = configuration.elements.remote;
        const save = configuration.querySelector('button[type=submit]');
        const token = configuration.elements.token;
        const detect = configuration.querySelector('[data-detect]');
        let options = [];
        detect.addEventListener('click', () => perform(detect, async () => {
          options = await coding(path + 'remotes');
          const choices = options.map((option, index) =>
            new Option(option.remote + ' · ' + option.repository, String(index)));
          select.replaceChildren(...choices);
          const active = options.findIndex((option) => option.remote === connection?.remote);
          if (active >= 0) select.value = String(active);
          select.disabled = save.disabled = !options.length;
          notice(options.length ? 'Choose a remote and save the connection.' : 'No supported GitHub remotes were found in this workspace.');
        }));
        configuration.addEventListener('submit', (event) => {
          event.preventDefault();
          const option = options[Number(select.value)];
          if (!option) return;
          perform(save, async () => {
            try {
              show(await coding(path + 'connect', { ...option, token: token.value }));
              notice('GitHub connection saved.');
            } finally {
              token.value = '';
            }
          });
        });
        const disconnect = configuration.querySelector('[data-disconnect]');
        if (disconnect) disconnect.addEventListener('click', () => perform(disconnect, async () => {
          show(await coding(path + 'disconnect', {}));
          notice('GitHub connection removed.');
        }));
      }

      const prToken = area.querySelector('[data-pr-token]');
      if (prToken) {
        const token = prToken.elements.token;
        const save = prToken.querySelector('button[type=submit]');
        prToken.addEventListener('submit', (event) => {
          event.preventDefault();
          perform(save, async () => {
            try {
              show(await coding(path + 'pr-credential', { token: token.value }));
              notice('Pull request publishing token saved.');
            } finally { token.value = ''; }
          });
        });
        const remove = prToken.querySelector('[data-remove-pr-token]');
        remove?.addEventListener('click', () => perform(remove, async () => {
          show(await coding(path + 'pr-credential', { token: '' }));
          notice('Pull request publishing token removed.');
        }));
      }

      const prepare = area.querySelector('[data-github-handoff]');
      const form = prepare?.querySelector('form');
      const refresh = area.querySelector('[data-github-refresh]');
      if (refresh) refresh.addEventListener('click', () => perform(refresh, async () => {
        const activity = area.querySelector('[data-github-activity]');
        const response = await coding(path + 'activity');
        activity.innerHTML = '<details open><summary>Recent open issues</summary>' +
          activityList(response.issues, response.issuesEnabled ? 'No open issues in this result.' : 'Issues are disabled.') +
          '</details><details open><summary>Recent open pull requests</summary>' +
          activityList(response.pulls, 'No open pull requests in this result.') + '</details>';
        if (form && !form.elements.base.value) form.elements.base.value = response.defaultBranch;
        notice('GitHub activity refreshed.');
      }));
      if (!prepare || !form) return;

      const request = form.elements.request;
      const comparison = form.querySelector('[data-comparison]');
      const load = form.querySelector('[data-load-runs]');
      const submit = form.querySelector('button[type=submit]');
      const previewPr = form.querySelector('[data-preview-pr]');
      const recoverPr = form.querySelector('[data-recover-pr]');
      const prReceipt = form.querySelector('[data-pr-receipt]');
      let accepted = [];
      let revision = 0;
      async function loadRuns() {
        const selected = accepted[Number(request.value)] ?? target;
        const rows = await coding('/projects/' + encodeURIComponent(project.id) + '/runs');
        accepted = rows.filter((run) => run.status === 'done' && run.review === 'accepted');
        request.replaceChildren(...accepted.map((run, index) => new Option(run.session + ' / ' + run.id, String(index))));
        if (!accepted.length) request.replaceChildren(new Option('Accept a run in Review first', ''));
        const index = selected && accepted.findIndex((run) => run.session === selected.session && run.id === selected.id);
        if (index >= 0) request.value = String(index);
        else clearPreview();
        submit.disabled = !accepted.length;
        if (previewPr) previewPr.disabled = !accepted.length;
        if (recoverPr) recoverPr.disabled = !accepted.length;
      }
      submit.disabled = true;
      if (previewPr) previewPr.disabled = true;
      if (recoverPr) recoverPr.disabled = true;
      prepare.addEventListener('toggle', () => {
        if (prepare.open) perform(load, loadRuns);
      });
      load.addEventListener('click', () => perform(load, loadRuns));
      function clearPreview() {
        revision++;
        comparison.replaceChildren();
        prReceipt?.replaceChildren();
      }
      form.addEventListener('input', (event) => {
        if (!prReceipt?.contains(event.target)) clearPreview();
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const run = accepted[Number(request.value)];
        if (!run) return;
        perform(submit, async () => {
          const receipt = await coding(path + 'handoff', {
            session: run.session, requestId: run.id, base: form.elements.base.value, head: form.elements.head.value,
          });
          comparison.innerHTML = external(receipt.url, 'Open GitHub comparison');
          comparison.querySelector('a').focus();
        });
      });

      function showReceipt(result) {
        prReceipt.replaceChildren();
        if (result?.receipt) {
          prReceipt.innerHTML = external(result.receipt.url, 'Open pull request #' + result.receipt.number);
          prReceipt.querySelector('a').focus();
        } else {
          const message = document.createElement('p');
          message.className = 'muted';
          message.textContent = result ? 'GitHub has not returned this receipt. You can check again or preview the same details to retry.'
            : 'This accepted request has no publishing approval yet.';
          prReceipt.append(message);
        }
      }

      recoverPr?.addEventListener('click', () => {
        const run = accepted[Number(request.value)];
        if (!run) return;
        const identity = { session: run.session, requestId: run.id };
        const current = revision;
        perform(recoverPr, async () => {
          const saved = await coding(path + 'pr-inspect', identity);
          const result = saved && !saved.receipt ? await coding(path + 'pr-recover', identity) : saved;
          if (revision === current) showReceipt(result);
        });
      });

      previewPr?.addEventListener('click', () => {
        const run = accepted[Number(request.value)];
        if (!run || !form.reportValidity()) return;
        const details = { session: run.session, requestId: run.id, base: form.elements.base.value, head: form.elements.head.value,
          title: form.elements.prTitle.value, body: form.elements.prBody.value, draft: form.elements.prDraft.checked };
        const current = revision;
        perform(previewPr, async () => {
          const preview = await coding(path + 'pr-preview', details);
          if (revision !== current) return;
          prReceipt.innerHTML = '<p data-pr-summary></p><pre data-pr-markdown></pre>' +
            '<div>' + external(preview.comparison, 'Review the comparison on GitHub') + '</div>' +
            '<label class="row"><input type="checkbox" data-pr-confirm><span>Approve this exact title, Markdown and branch comparison</span></label>' +
            '<div class="row"><button type="button" class="primary" data-pr-publish disabled>Publish to GitHub</button></div>';
          prReceipt.querySelector('[data-pr-summary]').textContent = preview.title + ' · ' + preview.repository +
            ' · ' + preview.head + ' → ' + preview.base + (preview.draft ? ' · Draft' : '');
          prReceipt.querySelector('[data-pr-markdown]').textContent = preview.body;
          const confirm = prReceipt.querySelector('[data-pr-confirm]');
          const publish = prReceipt.querySelector('[data-pr-publish]');
          confirm.addEventListener('change', () => { publish.disabled = !confirm.checked; });
          confirm.focus();
          publish.addEventListener('click', () => {
            if (!confirm.checked || revision !== current) return;
            perform(publish, async () => {
              const result = await coding(path + 'pr-publish', { ...details, approval: preview.approval, approved: true });
              if (revision === current) {
                showReceipt(result);
                notice('GitHub pull request recorded.');
              }
            });
          });
        });
      });
      if (target) {
        prepare.open = true;
        const pullOptions = prepare.querySelector('[data-pr-options]');
        if (pullOptions) pullOptions.open = true;
        (pullOptions || prepare).querySelector('summary').focus();
      }
    }

    coding(path + 'status').then(show, (error) => {
      area.replaceChildren();
      notice(error.message, true);
    });
  }

  window.okbGitHub = { mount };
})();
