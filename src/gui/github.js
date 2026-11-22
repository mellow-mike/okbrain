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

  function mount(parent, { project, coding, readonly }) {
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
        (state.connection ? '<button type="button" data-disconnect>Disconnect</button>' : '') + '</div></form></details>';
    }

    function handoff() {
      if (readonly) return '';
      return '<details data-github-handoff><summary>Prepare GitHub review</summary><form class="stack coding-form">' +
        '<p class="muted">Choose an accepted coding request and branches that are already on GitHub. ' +
        'Review the comparison and open the pull request in GitHub.</p>' +
        '<label class="field"><span>Accepted request</span><select name="request" required></select></label>' +
        '<div class="row"><button type="button" data-load-runs>Refresh accepted requests</button></div>' +
        '<div class="coding-grid"><label class="field"><span>Base branch</span><input name="base" maxlength="255" required></label>' +
        '<label class="field"><span>Head branch</span><input name="head" maxlength="255" required></label></div>' +
        '<div class="row"><button type="submit">Prepare comparison</button></div><div data-comparison></div></form></details>';
    }

    function show(state) {
      const connection = state.connection;
      area.className = 'stack';
      area.innerHTML = (connection ?
        '<div class="row"><strong>' + external(connection.url, connection.repository) + '</strong><span class="muted">' +
        esc(connection.remote) + (connection.hasToken ? ' · project token saved' : ' · public access') + '</span></div>' +
        '<div class="row"><button type="button" data-github-refresh>Refresh GitHub activity</button></div>' +
        '<div data-github-activity class="stack"></div>' + handoff() :
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
      let accepted = [];
      async function loadRuns() {
        const rows = await coding('/projects/' + encodeURIComponent(project.id) + '/runs');
        accepted = rows.filter((run) => run.status === 'done' && run.review === 'accepted');
        request.replaceChildren(...accepted.map((run, index) => new Option(run.session + ' / ' + run.id, String(index))));
        if (!accepted.length) request.replaceChildren(new Option('Accept a run in Review first', ''));
        submit.disabled = !accepted.length;
      }
      submit.disabled = true;
      prepare.addEventListener('toggle', () => {
        if (prepare.open) perform(load, loadRuns);
      });
      load.addEventListener('click', () => perform(load, loadRuns));
      form.addEventListener('input', () => comparison.replaceChildren());
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
    }

    coding(path + 'status').then(show, (error) => {
      area.replaceChildren();
      notice(error.message, true);
    });
  }

  window.okbGitHub = { mount };
})();
