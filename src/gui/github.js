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

    function credentialForm(kind, label, explanation, saveLabel, hasToken) {
      return '<form class="stack coding-form" data-github-credential="' + kind + '"><p class="muted">' + explanation + '</p>' +
        '<label class="field"><span>' + label + '</span><input type="password" name="token" required autocomplete="off" spellcheck="false" maxlength="280"></label>' +
        '<div class="row"><button type="submit">' + saveLabel + '</button>' +
        (hasToken ? '<button type="button" data-remove-token>Remove ' + label.toLowerCase() + '</button>' : '') + '</div></form>';
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
        (state.connection ?
          credentialForm('branch', 'Branch publishing token', 'Use a separate fine-grained token limited to this repository with Contents write access.',
            'Save branch publishing token', state.connection.hasContentsToken) +
          credentialForm('pr', 'Pull request publishing token', 'Use a separate fine-grained token limited to this repository with Pull requests write access.',
            'Save publishing token', state.connection.hasPublishToken) : '') + '</details>';
    }

    function branchOptions(connection) {
      return '<details data-branch-options><summary>Create branch from applied patch</summary><div class="stack">' +
        (connection.hasContentsToken ? '<p class="muted">Enter a new head branch above. Review the exact file contents before creating the branch.</p>' +
        '<label class="field"><span>Commit message</span><input name="branchMessage" maxlength="512"></label>' +
        '<div class="row"><button type="button" data-preview-branch>Preview branch</button>' :
        '<p class="muted">Save a branch publishing token in Connection settings to create branches.</p><div class="row">') +
        '<button type="button" data-recover-branch>Find or recover branch</button></div><div data-branch-result class="coding-preview stack" aria-live="polite"></div>' +
        '</div></details>';
    }

    function handoff(state) {
      if (readonly) return '';
      return '<details data-github-handoff><summary>Prepare GitHub review</summary><form class="stack coding-form">' +
        '<p class="muted">Choose an accepted coding request and the GitHub branches for its review.</p>' +
        '<label class="field"><span>Accepted request</span><select name="request" required></select></label>' +
        '<div class="row"><button type="button" data-load-runs>Refresh accepted requests</button></div>' +
        '<div class="coding-grid"><label class="field"><span>Base branch</span><input name="base" maxlength="255" required></label>' +
        '<label class="field"><span>Head branch</span><input name="head" maxlength="255" required></label></div>' +
        '<div class="row"><button type="submit">Prepare comparison</button></div><div data-comparison></div>' +
        (state.canConfigure ? branchOptions(state.connection) +
          '<details data-pr-options><summary>Create a pull request</summary><div class="stack coding-form">' +
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

      for (const credential of area.querySelectorAll('[data-github-credential]')) {
        const kind = credential.dataset.githubCredential;
        const label = kind === 'branch' ? 'Branch publishing token' : 'Pull request publishing token';
        const token = credential.elements.token;
        const save = credential.querySelector('button[type=submit]');
        credential.addEventListener('submit', (event) => {
          event.preventDefault();
          perform(save, async () => {
            try {
              show(await coding(path + kind + '-credential', { token: token.value }));
              notice(label + ' saved.');
            } finally { token.value = ''; }
          });
        });
        const remove = credential.querySelector('[data-remove-token]');
        remove?.addEventListener('click', () => perform(remove, async () => {
          show(await coding(path + kind + '-credential', { token: '' }));
          notice(label + ' removed.');
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
      const previewBranch = form.querySelector('[data-preview-branch]');
      const recoverBranch = form.querySelector('[data-recover-branch]');
      const branchResult = form.querySelector('[data-branch-result]');
      const pullOptions = prepare.querySelector('[data-pr-options]');
      let accepted = [];
      let revision = 0;
      let branchRevision = 0;
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
        for (const button of [previewBranch, recoverBranch, previewPr, recoverPr]) {
          if (button) button.disabled = !accepted.length;
        }
      }
      submit.disabled = true;
      for (const button of [previewBranch, recoverBranch, previewPr, recoverPr]) {
        if (button) button.disabled = true;
      }
      prepare.addEventListener('toggle', () => {
        if (prepare.open) perform(load, loadRuns);
      });
      load.addEventListener('click', () => perform(load, loadRuns));
      function clearPullPreview() {
        revision++;
        comparison.replaceChildren();
        prReceipt?.replaceChildren();
      }
      function clearBranchPreview() {
        branchRevision++;
        branchResult?.replaceChildren();
      }
      function clearPreview() {
        clearPullPreview();
        clearBranchPreview();
      }
      form.addEventListener('input', (event) => {
        if (branchResult?.contains(event.target) || prReceipt?.contains(event.target)) return;
        if (event.target.name === 'branchMessage') clearBranchPreview();
        else if (['prTitle', 'prBody', 'prDraft'].includes(event.target.name)) clearPullPreview();
        else clearPreview();
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

      function showBranchReceipt(result) {
        if (!result?.receipt) {
          branchResult.textContent = result
            ? 'GitHub has not confirmed this branch yet. Check again or retry the approved preview.'
            : 'This accepted request has no branch approval yet.';
          return;
        }
        const { base, head, receipt } = result;
        clearPreview();
        form.elements.base.value = base;
        form.elements.head.value = head;
        branchResult.innerHTML = '<p data-branch-commit></p><div>' + external(receipt.url, 'Open branch on GitHub') + '</div>';
        branchResult.querySelector('[data-branch-commit]').textContent = head + ' · ' + receipt.commitSha;
        if (pullOptions) pullOptions.open = true;
        branchResult.querySelector('a').focus();
      }

      recoverBranch?.addEventListener('click', () => {
        const run = accepted[Number(request.value)];
        if (!run) return;
        const identity = { session: run.session, requestId: run.id };
        const current = branchRevision;
        perform(recoverBranch, async () => {
          const saved = await coding(path + 'branch-inspect', identity);
          const result = saved && !saved.receipt ? await coding(path + 'branch-recover', identity) : saved;
          if (branchRevision === current) showBranchReceipt(result);
        });
      });

      previewBranch?.addEventListener('click', () => {
        const run = accepted[Number(request.value)];
        if (!run || !form.reportValidity()) return;
        const details = { session: run.session, requestId: run.id, base: form.elements.base.value, head: form.elements.head.value,
          message: form.elements.branchMessage.value };
        const current = branchRevision;
        perform(previewBranch, async () => {
          const preview = await coding(path + 'branch-preview', details);
          if (branchRevision !== current) return;
          branchResult.innerHTML = '<p>Accepted request <code data-branch-run></code></p><p data-branch-summary></p>' +
            '<p>Pinned base <code data-branch-base-sha></code></p><pre aria-label="Commit message preview" data-commit-message></pre>' +
            '<div class="stack" data-branch-files></div>' +
            '<label class="row"><input type="checkbox" data-branch-confirm><span>Approve sending these exact file contents and commit message to this new branch</span></label>' +
            '<div class="row"><button type="button" class="primary" data-branch-publish disabled>Publish branch</button></div>';
          branchResult.querySelector('[data-branch-run]').textContent = run.session + ' / ' + run.id;
          branchResult.querySelector('[data-branch-summary]').textContent = preview.repository + ' · ' + preview.head + ' from ' + preview.base;
          branchResult.querySelector('[data-branch-base-sha]').textContent = preview.baseSha;
          branchResult.querySelector('[data-commit-message]').textContent = preview.message;
          const files = branchResult.querySelector('[data-branch-files]');
          for (const { path, before, content } of preview.files) {
            const file = document.createElement('details');
            const summary = document.createElement('summary');
            const text = document.createElement('pre');
            summary.textContent = path + (before === null ? ' · New file' : '');
            text.textContent = content;
            file.append(summary, text);
            files.append(file);
          }
          const confirm = branchResult.querySelector('[data-branch-confirm]');
          const publish = branchResult.querySelector('[data-branch-publish]');
          confirm.addEventListener('change', () => { publish.disabled = !confirm.checked; });
          confirm.focus();
          publish.addEventListener('click', () => {
            if (!confirm.checked || branchRevision !== current) return;
            void perform(publish, async () => {
              const result = await coding(path + 'branch-publish', { ...details, approval: preview.approval, approved: true });
              if (branchRevision !== current) return;
              showBranchReceipt(result);
              if (result?.receipt) notice('GitHub branch recorded.');
            }).finally(() => { publish.disabled = !confirm.checked; });
          });
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
