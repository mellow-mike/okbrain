/* The coding workspace uses its own API and storage, separate from brain notes. */
(function () {
  'use strict';

  const esc = window.okbRender.esc;
  const codingPath = '/api/coding';
  let teamToken = null;

  async function coding(path, data) {
    const requestHeaders = teamToken
      ? { authorization: 'Bearer ' + teamToken }
      : { 'x-okb-token': window.OKB_TOKEN };
    const brain = document.querySelector('#brain')?.value;
    if (brain) requestHeaders['x-okb-brain'] = brain;
    const options = { cache: 'no-store', headers: requestHeaders };
    if (data !== undefined) {
      options.method = 'POST';
      options.body = JSON.stringify(data);
      requestHeaders['content-type'] = 'application/json';
    }
    const res = await fetch(codingPath + path, options);
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'The coding request failed.');
    return payload.result;
  }

  const projectUrl = (id) => '/projects/' + encodeURIComponent(id);
  const projectHref = (id) => '#coding/' + encodeURIComponent(id);
  const entries = (text) => text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  const statuses = {
    running: 'Running', interrupted: 'Interrupted', done: 'Ready for review', unanswered: 'Unanswered',
    failed: 'Could not start', cancelled: 'Cancelled', accepted: 'Accepted', changes_requested: 'Changes requested',
  };
  const labelStatus = (run) => statuses[run.review || run.status] || run.status;
  const identity = (run) => ({ session: run.session, requestId: run.id });
  const time = (iso) => new Date(iso).toLocaleString();
  const report = (node, error) => {
    node.className = error ? 'error coding-feedback' : 'coding-feedback';
    node.textContent = error ? error.message || String(error) : '';
  };

  function field(label, value, shape = 'text', attributes = '') {
    return '<label class="field"><span>' + esc(label) + '</span><input type="' + shape + '" value="' +
      esc(value || '') + '" ' + attributes + '></label>';
  }

  function usageText(usage) {
    if (!usage) return 'No provider usage recorded';
    return [
      usage.input.toLocaleString() + ' input',
      usage.output.toLocaleString() + ' output',
      usage.cacheRead.toLocaleString() + ' cache read',
      usage.cacheWrite.toLocaleString() + ' cache write',
    ].join(' · ');
  }

  function register(parent, models, suggestedWorkspace, readonly) {
    const dialog = document.createElement('details');
    dialog.className = 'coding-panel';
    dialog.open = !!suggestedWorkspace || !parent.querySelector('[data-project-link]');
    dialog.innerHTML =
      '<summary>Add a project</summary>' +
      '<form class="stack coding-form">' +
      field('Project name', '', 'text', 'name="title" maxlength="128" required') +
      field('Absolute workspace path', suggestedWorkspace, 'text', 'name="workspace" autocomplete="off" spellcheck="false" required') +
      field('Permitted directories', '.', 'text', 'name="scopes" autocomplete="off" spellcheck="false" required') +
      '<p class="muted">Enter relative directories separated by commas. Use <code>.</code> for the entire workspace.</p>' +
      '<div class="coding-grid"><label class="field"><span>Provider</span><select name="provider"></select></label>' +
      '<label class="field"><span>Model</span><select name="model"></select></label>' +
      '<label class="field"><span>Reasoning</span><select name="thinking"></select></label></div>' +
      field('Project API key (optional)', '', 'password', 'name="apiKey" autocomplete="off" maxlength="4096"') +
      '<p class="muted">Project keys stay in local application data. You can also use an existing provider environment key for local runs.</p>' +
      '<div class="row"><button class="primary" type="submit">Add project</button></div><div class="coding-feedback" role="status"></div></form>';
    parent.append(dialog);
    const form = dialog.querySelector('form');
    const { provider, model, thinking } = form.elements;
    const submit = form.querySelector('button[type="submit"]');
    const feedback = form.querySelector('[role="status"]');

    function syncThinking() {
      const catalog = models.find((entry) => entry.provider === provider.value);
      const levels = catalog?.models.find((entry) => entry.id === model.value)?.thinkingLevels || [];
      const options = [new Option('Provider default', '')];
      levels.forEach((level) => options.push(new Option(level, level)));
      thinking.replaceChildren(...options);
    }

    function syncModels() {
      const catalog = models.find((entry) => entry.provider === provider.value);
      model.replaceChildren(...(catalog?.models || []).map((item) => new Option(item.name, item.id)));
      const defaultModel = provider.value === 'openai' ? 'gpt-5-mini' : 'claude-sonnet-4-6';
      if ([...model.options].some((item) => item.value === defaultModel)) model.value = defaultModel;
      syncThinking();
      submit.disabled = readonly || !model.options.length;
    }

    provider.replaceChildren(...models.filter((entry) => entry.models.length).map((entry) =>
      new Option(entry.provider === 'openai' ? 'OpenAI' : 'Anthropic', entry.provider)));
    provider.addEventListener('change', syncModels);
    model.addEventListener('change', syncThinking);
    syncModels();

    if (readonly) feedback.textContent = 'This brain mount is read-only.';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      data.scopes = entries(data.scopes);
      if (!data.apiKey) delete data.apiKey;
      if (!data.thinking) delete data.thinking;
      submit.disabled = true;
      report(feedback);
      try {
        const project = await coding('/projects', data);
        form.elements.apiKey.value = '';
        location.hash = projectHref(project.id);
      } catch (error) {
        report(feedback, error);
      } finally {
        submit.disabled = readonly;
      }
    });
  }

  function previewContents(el, preview) {
    if (preview.packages) {
      const sections = preview.packages.map((entry) => {
        const section = document.createElement('section');
        section.className = 'stack';
        const title = document.createElement('h4');
        title.textContent = entry.project;
        const items = document.createElement('div');
        items.className = 'stack';
        previewContents(items, entry);
        section.append(title, items);
        return section;
      });
      el.replaceChildren(...sections);
      return;
    }
    const content = preview.excerpts || preview.files;
    const manifest = preview.manifest;
    if (!content.length) {
      el.textContent = manifest ? 'No source matches. Try a narrower scope or a different query.' : 'This request includes your task and active conversation history.';
      return;
    }
    const title = document.createElement('p');
    title.textContent = manifest
      ? content.length + ' excerpts · ' + manifest.estimatedTokens.toLocaleString() + ' estimated tokens'
      : content.length + ' files';
    const pieces = [title];
    if (manifest && Object.values(manifest.limitsReached).some(Boolean)) {
      const limited = document.createElement('p');
      limited.className = 'muted';
      limited.textContent = 'The selection reached a scan or context limit. Narrow the directories or refine your query for more precise excerpts.';
      pieces.push(limited);
    }
    if (preview.guidance) pieces.push(disclosure('Project guidance', preview.guidance));
    content.forEach((part, index) => {
      const lines = part.startLine === undefined ? '' : ':' + part.startLine + '–' + part.endLine;
      const reason = manifest?.files[index]?.reason;
      pieces.push(disclosure(part.path + lines, part.content, reason));
    });
    el.replaceChildren(...pieces);
  }

  function disclosure(label, value, reason) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const pre = document.createElement('pre');
    summary.textContent = label;
    pre.textContent = value;
    details.append(summary);
    if (reason) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = Array.isArray(reason) ? reason.join(' · ') : reason;
      details.append(p);
    }
    details.append(pre);
    return details;
  }

  function composer(parent, project, readonly, detached, selectRun) {
    const prefix = projectUrl(project.id);
    const panel = document.createElement('section');
    panel.className = 'coding-panel coding-composer stack';
    panel.innerHTML =
      '<h3>New request</h3><form class="stack">' +
      '<label class="field"><span>Task</span><textarea name="prompt" rows="4" required placeholder="Describe the change or review you want"></textarea></label>' +
      '<div class="coding-grid">' + field('Session', 'main', 'text', 'name="session" required pattern="[a-z0-9][a-z0-9_\\-]{0,63}"') +
      field('Request ID', crypto.randomUUID(), 'text', 'name="requestId" required maxlength="128" spellcheck="false"') + '</div>' +
      '<label class="field"><span id="coding-source-label">Source</span><select name="source" aria-labelledby="coding-source-label"><option value="repository">Tracked repository excerpts</option>' +
      '<option value="files">Explicit files</option><option value="packages">Independent package review</option></select></label>' +
      '<div class="stack" data-repository>' +
      field('Search source', '', 'search', 'name="query" maxlength="1024" placeholder="Identifier, path, or terms"') +
      '<details><summary>Scope and budget</summary><div class="stack coding-form">' +
      field('Directories', project.scopes.join(', '), 'text', 'name="projects" spellcheck="false"') +
      field('Estimated excerpt tokens', '4096', 'number', 'name="tokenBudget" min="1" max="16384"') +
      '<label class="field"><span>Project profile (optional JSON)</span><textarea name="profile" rows="3" spellcheck="false"></textarea></label>' +
      '<p class="muted">A profile can set project directories, permitted shared dependencies, exclusions, budgets, and short guidance.</p>' +
      '</div></details></div><div class="stack" data-files hidden>' +
      field('Files inside the permitted directories', '', 'text', 'name="files" spellcheck="false" placeholder="src/app.ts, README.md"') +
      '<p class="muted">Separate paths with commas, or leave empty to send only the task in this session.</p></div>' +
      '<div class="stack" data-packages hidden><p class="muted">Use two or three separate package directories. Each gets its own conversation and sees only its previewed excerpts and the shared task.</p>' +
      [1, 2, 3].map((part) => '<fieldset data-package class="coding-grid"><legend>Package ' + part + (part === 3 ? ' (optional)' : '') + '</legend>' +
        field('Directory', part === 3 || project.scopes[part - 1] === '.' ? '' : project.scopes[part - 1], 'text', 'data-package-project spellcheck="false"') +
        field('Search source', '', 'search', 'data-package-query maxlength="1024"') +
        field('Estimated excerpt tokens', '', 'number', 'data-package-budget min="1" max="4096" placeholder="2048"') + '</fieldset>').join('') + '</div>' +
      '<div class="row"><button type="button" data-preview>Preview source</button></div>' +
      '<div class="coding-preview stack" aria-live="polite" data-preview-content></div>' +
      '<label class="row" data-approve hidden><input type="checkbox" name="approved"><span data-approve-text></span></label>' +
      '<div class="row"><button type="submit" class="primary" disabled>Send request</button><span class="muted">' + esc(project.model) +
      '</span></div><div class="coding-feedback" role="status"></div></form>';
    parent.append(panel);

    const form = panel.querySelector('form');
    const { source, projects, tokenBudget, profile, files, session, requestId, prompt, approved } = form.elements;
    const previewButton = form.querySelector('[data-preview]');
    const send = form.querySelector('button[type="submit"]');
    const previewEl = form.querySelector('[data-preview-content]');
    const approve = form.querySelector('[data-approve]');
    const approveText = form.querySelector('[data-approve-text]');
    const packageFields = Array.from(form.querySelectorAll('[data-package]'));
    const feedback = form.querySelector('[role="status"]');
    let preview = null;
    let revision = 0;
    let busy = false;

    function clearPreview() {
      revision++;
      preview = null;
      previewEl.replaceChildren();
      approved.checked = false;
      approve.hidden = true;
      send.disabled = true;
    }

    function sourceInput() {
      if (source.value === 'files') return { source: 'files', files: entries(files.value) };
      if (source.value === 'packages') {
        const packages = packageFields.map((row) => {
          const project = row.querySelector('[data-package-project]').value.trim();
          const query = row.querySelector('[data-package-query]').value.trim();
          const budget = row.querySelector('[data-package-budget]').value;
          return { project, query, ...(budget ? { tokenBudget: Number(budget) } : {}) };
        }).filter((part) => part.project || part.query || part.tokenBudget);
        return { source: 'packages', packages };
      }
      const data = { source: 'repository', query: form.elements.query.value };
      if (profile.value.trim()) {
        try { data.profile = JSON.parse(profile.value); }
        catch (_) { throw new Error('Enter valid JSON for the project profile.'); }
      } else {
        data.projects = entries(projects.value);
        if (tokenBudget.value) data.tokenBudget = Number(tokenBudget.value);
      }
      return data;
    }

    for (const input of [source, projects, tokenBudget, profile, files, session, requestId, prompt, form.elements.query, ...form.querySelectorAll('[data-package] input')])
      input.addEventListener('input', clearPreview);
    source.addEventListener('change', () => {
      form.querySelector('[data-repository]').hidden = source.value !== 'repository';
      form.querySelector('[data-files]').hidden = source.value !== 'files';
      form.querySelector('[data-packages]').hidden = source.value !== 'packages';
    });
    approved.addEventListener('change', () => {
      send.disabled = readonly || busy || project.credential === 'missing' || !preview || !approved.checked;
    });

    previewButton.addEventListener('click', async () => {
      clearPreview();
      const current = revision;
      previewButton.disabled = true;
      report(feedback);
      feedback.textContent = 'Reading selected source…';
      try {
        const selection = sourceInput();
        const result = await coding(prefix + '/preview', selection);
        if (current !== revision || detached()) return;
        previewContents(previewEl, result);
        if (result.source === 'repository' && !result.excerpts.length) return;
        if (result.source === 'packages' && result.packages.some((part) => !part.excerpts.length)) return;
        preview = { selection, id: result.manifest?.id || result.id };
        const provider = project.provider === 'openai' ? 'OpenAI' : 'Anthropic';
        approveText.textContent = result.source === 'packages'
          ? 'Approve sending the shared task and each package’s selected text to ' + provider + '.'
          : 'Approve sending the task, selected text, and active session history to ' + provider + '.';
        approve.hidden = false;
        approved.focus();
      } catch (error) {
        report(feedback, error);
      } finally {
        previewButton.disabled = false;
        if (feedback.textContent === 'Reading selected source…') report(feedback);
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (readonly || busy || !preview || !approved.checked) return;
      busy = true;
      send.disabled = true;
      report(feedback);
      try {
        const run = await coding(prefix + '/run', {
          ...preview.selection, approved: true, previewId: preview.id, prompt: prompt.value,
          session: session.value, requestId: requestId.value,
        });
        if (detached()) return;
        await selectRun(run);
        if (run.status !== 'failed') {
          requestId.value = crypto.randomUUID();
          clearPreview();
          feedback.textContent = 'Request ' + run.id + ' is tracked in Run history.';
        }
      } catch (error) {
        report(feedback, error);
      } finally {
        busy = false;
        send.disabled = readonly || !preview || !approved.checked;
      }
    });

    panel.updateProject = (current) => {
      project = current;
      send.disabled = readonly || busy || project.credential === 'missing' || !preview || !approved.checked;
      if (project.credential === 'missing') feedback.textContent = 'Add a provider API key in Project settings to send a request.';
      else if (feedback.textContent.startsWith('Add a provider API key')) report(feedback);
    };
    panel.updateProject(project);
  }

  function activity(parent, project, readonly, detached) {
    const prefix = projectUrl(project.id);
    const panel = document.createElement('section');
    panel.className = 'coding-panel coding-activity stack';
    panel.innerHTML = '<div class="row"><h3>Run history</h3><button type="button" class="small right" data-refresh>Refresh</button></div>' +
      '<div class="stack coding-runs" data-runs></div><div class="stack" data-inspect aria-live="polite"></div>' +
      '<div class="coding-feedback" role="status"></div>';
    parent.append(panel);
    const list = panel.querySelector('[data-runs]');
    const inspected = panel.querySelector('[data-inspect]');
    const feedback = panel.querySelector('[role="status"]');
    let selected = null;
    let timer;
    let generation = 0;

    async function readRun(run, current) {
      const result = await coding(prefix + '/inspect', identity(run));
      if (detached() || current !== generation) return;
      const pi = result.pi;
      const row = result.run;
      const receipt = pi?.request?.receipt;
      const error = row.error || receipt?.reason;
      const snippet = receipt?.repositoryContext?.files || pi?.request?.repositoryContext?.files || [];
      if (row.status === 'running' && inspected.dataset.run === row.id && inspected.dataset.status === 'running') return;
      inspected.dataset.run = row.id;
      inspected.dataset.status = row.status;
      inspected.innerHTML = '<div class="coding-result stack"><h4>' + esc(row.id) + '</h4>' +
        '<p>' + esc(labelStatus(row)) + ' · ' + esc(row.session) + ' · ' + esc(row.actor) + '</p>' +
        (row.reviewer ? '<p class="muted">Reviewed by ' + esc(row.reviewer) + ' · ' + esc(time(row.reviewed)) + '</p>' : '') +
        (error ? '<div class="notice">' + esc(error) + '</div>' : '') +
        (result.admissionMissing ? '<p class="muted">Pi did not save this request. Resume will make this ID available for resubmission.</p>' : '') +
        (pi ? '<p class="muted">' + esc(usageText(pi.request?.usage)) + '</p><p class="muted">' +
          esc(pi.context.estimatedTokens.toLocaleString()) + ' active context tokens' +
          (pi.context.historyCompacted ? ' · Older turns compacted' : '') + '</p>' : '') +
        (receipt?.stopReason === 'length' ? '<p class="muted">The model reached its output limit.</p>' : '') +
        (receipt?.text ? '<pre data-answer></pre><div class="row"><button type="button" data-copy>Copy response</button></div>' : '') +
        (snippet.length ? '<details><summary>Source references</summary><ul>' + snippet.map((file) =>
          '<li><code>' + esc(file.path + ':' + file.startLine + '–' + file.endLine) + '</code></li>').join('') + '</ul></details>' : '') +
        '<div class="row" data-actions></div></div>';
      if (receipt?.text) {
        inspected.querySelector('[data-answer]').textContent = receipt.text;
        inspected.querySelector('[data-copy]').addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(receipt.text);
            feedback.textContent = 'Response copied.';
          } catch (error) { report(feedback, error); }
        });
      }
      const bar = inspected.querySelector('[data-actions]');
      for (const child of receipt?.packageReviews ?? []) {
        const sources = (child.sources ?? []).map((file) => file.path + ':' + file.startLine + '–' + file.endLine);
        bar.before(disclosure(child.project + ' · ' + child.requestId, child.summary || child.reason || '', [usageText(child.usage), ...sources]));
      }
      if (readonly) return;
      if (row.status === 'running') appendAction(bar, 'Cancel run', '/cancel', row);
      if (row.status === 'interrupted') {
        appendAction(bar, 'Resume', '/resume', row);
        appendAction(bar, 'Cancel run', '/cancel', row);
      }
      if (row.status === 'done') {
        appendAction(bar, 'Accept result', '/review', row, { decision: 'accepted' });
        appendAction(bar, 'Request changes', '/review', row, { decision: 'changes_requested' });
      }
    }

    function appendAction(container, label, action, row, extras) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      container.append(button);
      button.addEventListener('click', async () => {
        button.disabled = true;
        report(feedback);
        try {
          await coding(prefix + action, { ...identity(row), ...extras });
          await refresh();
        } catch (error) { report(feedback, error); }
        finally { button.disabled = false; }
      });
    }

    async function refresh(focusResult = false) {
      clearTimeout(timer);
      const current = ++generation;
      try {
        const rows = await coding(prefix + '/runs');
        if (detached() || current !== generation) return;
        const active = rows.some((row) => row.status === 'running');
        const target = selected && rows.find((row) => row.session === selected.session && row.id === selected.id);
        const markup = rows.length ? rows.map((row, index) =>
          '<button type="button" class="coding-run" aria-pressed="' + (row === target) + '" data-run="' + index + '">' +
          '<span><strong>' + esc(row.id) + '</strong><span class="muted">' + esc(row.session) + '</span></span>' +
          '<span>' + esc(labelStatus(row)) + '</span></button>').join('') : '<p class="empty">No requests in this project.</p>';
        if (list.dataset.markup !== markup) {
          const focused = list.contains(document.activeElement);
          list.innerHTML = markup;
          list.dataset.markup = markup;
          if (focused) list.querySelector('button[aria-pressed=true]')?.focus();
          list.querySelectorAll('[data-run]').forEach((button) => {
            button.addEventListener('click', () => selectRun(rows[Number(button.dataset.run)]));
          });
        }
        if (target) await readRun(target, current);
        else { selected = null; inspected.replaceChildren(); }
        if (focusResult && target && current === generation) {
          const heading = inspected.querySelector('h4');
          heading?.setAttribute('tabindex', '-1');
          heading?.focus();
        }
        if (active && current === generation && !detached()) timer = setTimeout(refresh, 1200);
      } catch (error) {
        if (!detached() && current === generation) report(feedback, error);
      }
    }

    function selectRun(row) {
      selected = row;
      report(feedback);
      return refresh(true);
    }

    panel.querySelector('[data-refresh]').addEventListener('click', () => refresh());
    refresh();
    return { refresh, selectRun };
  }

  function settings(parent, project, readonly, projectChanged, runsChanged) {
    const prefix = projectUrl(project.id);
    const panel = document.createElement('details');
    panel.className = 'coding-panel';
    panel.innerHTML = '<summary>Project settings</summary><div class="stack coding-form">' +
      '<h3>Provider credentials</h3><p class="muted" data-credential></p><form class="stack" data-key>' +
      field('Project API key', '', 'password', 'name="apiKey" autocomplete="off" maxlength="4096" required') +
      '<div class="row"><button type="submit">Save key</button><button type="button" data-remove>Remove project key</button></div></form>' +
      '<h3>Team access</h3><p class="muted">Project tokens expire after seven days. Team members need a project-specific provider key to run requests.</p>' +
      '<form class="row" data-add-member>' + field('Member name', '', 'text', 'name="name" maxlength="48" required') +
      '<button type="submit">Create project token</button></form><div class="stack" data-token></div><div class="stack" data-members></div>' +
      '<h3>Transcript retention</h3><form class="stack" data-delete>' +
      field('Session to delete', '', 'text', 'name="session" maxlength="64" required') +
      field('Type the session name again', '', 'text', 'name="confirm" maxlength="64" required') +
      '<div class="row"><button type="submit" class="danger">Delete session and transcript</button></div></form>' +
      '<details data-audit><summary>Audit events</summary><ol class="coding-audit"></ol></details>' +
      '<div class="coding-feedback" role="status"></div></div>';
    parent.append(panel);
    const feedback = panel.querySelector('[role="status"]');
    const keyForm = panel.querySelector('[data-key]');
    const removeKey = panel.querySelector('[data-remove]');
    const addMember = panel.querySelector('[data-add-member]');
    const members = panel.querySelector('[data-members]');
    const token = panel.querySelector('[data-token]');
    const audit = panel.querySelector('[data-audit]');
    const deleteSession = panel.querySelector('[data-delete]');
    const credential = panel.querySelector('[data-credential]');
    panel.querySelectorAll('button').forEach((button) => button.disabled = readonly);

    function setProject(current) {
      project = current;
      const messages = {
        project: 'A key is saved for this project.',
        environment: 'Local runs use the environment key.',
        missing: 'This project needs a provider key before it can send requests.',
      };
      credential.textContent = messages[current.credential];
      removeKey.disabled = readonly || current.credential !== 'project';
      projectChanged(current);
    }

    async function changeKey(apiKey) {
      report(feedback);
      try {
        setProject(await coding(prefix + '/credential', { apiKey }));
        keyForm.reset();
        feedback.textContent = apiKey ? 'Project key saved.' : 'Project key removed.';
      } catch (error) { report(feedback, error); }
    }

    async function loadMembers() {
      try {
        const rows = await coding(prefix + '/members');
        members.replaceChildren(...rows.map((member) => {
          const row = document.createElement('div');
          row.className = 'row';
          const name = document.createElement('span');
          name.textContent = member.actor + (member.expires ? ' · Expires ' + time(member.expires) : ' · Expired');
          const revoke = document.createElement('button');
          revoke.type = 'button';
          revoke.className = 'small';
          revoke.disabled = readonly;
          revoke.textContent = 'Revoke access';
          row.append(name, revoke);
          revoke.addEventListener('click', async () => {
            revoke.disabled = true;
            report(feedback);
            try {
              await coding(prefix + '/members', { revoke: member.id });
              if (token.dataset.member === member.id) token.replaceChildren();
              await loadMembers();
            } catch (error) {
              revoke.disabled = false;
              report(feedback, error);
            }
          });
          return row;
        }));
      } catch (error) { report(feedback, error); }
    }

    panel.addEventListener('toggle', () => {
      if (panel.open) loadMembers();
      else token.replaceChildren();
    });
    keyForm.addEventListener('submit', (event) => {
      event.preventDefault();
      changeKey(keyForm.elements.apiKey.value);
    });
    removeKey.addEventListener('click', () => changeKey(null));
    addMember.addEventListener('submit', async (event) => {
      event.preventDefault();
      report(feedback);
      try {
        const member = await coding(prefix + '/members', { name: addMember.elements.name.value });
        token.dataset.member = member.id;
        token.replaceChildren(disclosure('New token · copy before closing settings', member.token));
        token.querySelector('details').open = true;
        addMember.reset();
        await loadMembers();
      } catch (error) { report(feedback, error); }
    });
    deleteSession.addEventListener('submit', async (event) => {
      event.preventDefault();
      report(feedback);
      try {
        const result = await coding(prefix + '/delete-session', Object.fromEntries(new FormData(deleteSession)));
        feedback.textContent = 'Deleted transcript for session ' + result.session + '.';
        deleteSession.reset();
        await runsChanged();
      } catch (error) { report(feedback, error); }
    });
    audit.addEventListener('toggle', async () => {
      if (!audit.open) return;
      try {
        const events = await coding(prefix + '/audit');
        const items = events.map((event) => {
          const item = document.createElement('li');
          item.textContent = [time(event.at), event.kind.replaceAll('_', ' '), event.actor, event.session, event.request_id].filter(Boolean).join(' · ');
          return item;
        });
        audit.querySelector('ol').replaceChildren(...items);
      } catch (error) { report(feedback, error); }
    });
    setProject(project);
  }

  function teamSettings(parent, readonly, isDetached) {
    const panel = document.createElement('details');
    panel.className = 'coding-panel';
    panel.innerHTML = '<summary>Team browser access</summary><form class="stack coding-form">' +
      '<p class="muted">Start a separate local listener for team members with project tokens.</p>' +
      '<div class="coding-grid">' +
      field('Local port', '6524', 'number', 'name="port" min="0" max="65535" required') +
      field('HTTPS proxy origin (optional)', '', 'url', 'name="publicOrigin" placeholder="https://coding.example.com"') +
      '</div><div class="row"><button type="submit">Start team listener</button>' +
      '<button type="button" data-stop hidden>Stop listener</button></div>' +
      '<div class="coding-feedback" role="status"></div></form>';
    parent.append(panel);
    const form = panel.querySelector('form');
    const feedback = form.querySelector('[role="status"]');
    const start = form.querySelector('button[type="submit"]');
    const stop = form.querySelector('[data-stop]');
    let status = null;

    function update(value) {
      status = value;
      if (isDetached()) return;
      report(feedback);
      start.hidden = status !== null;
      stop.hidden = status === null;
      start.disabled = stop.disabled = readonly;
      form.elements.port.disabled = form.elements.publicOrigin.disabled = status !== null;
      if (!status) return;
      form.elements.port.value = status.port;
      form.elements.publicOrigin.value = status.publicOrigin || '';
      feedback.append('Team workspace ', Object.assign(document.createElement('a'), {
        href: status.publicOrigin || status.url, textContent: status.publicOrigin || status.url,
        target: '_blank', rel: 'noopener noreferrer',
      }));
      if (status.publicOrigin) feedback.append(' · Local upstream ' + status.url);
    }

    panel.addEventListener('toggle', async () => {
      if (!panel.open) return;
      try { update(await coding('/team')); } catch (error) { report(feedback, error); }
    });
    start.disabled = readonly;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (readonly || status) return;
      start.disabled = true;
      try {
        update(await coding('/team', {
          action: 'start', port: Number(form.elements.port.value), publicOrigin: form.elements.publicOrigin.value,
        }));
      } catch (error) { start.disabled = false; report(feedback, error); }
    });
    stop.addEventListener('click', async () => {
      if (readonly || !status) return;
      stop.disabled = true;
      try { update(await coding('/team', { action: 'stop' })); }
      catch (error) { stop.disabled = false; report(feedback, error); }
    });
  }

  async function mount(view, arg, isDetached, readonly, teamMode = false) {
    view.innerHTML =
      '<div class="stack wide coding-page"><header><h2 class="display">Coding workspace</h2>' +
      '<p class="muted">Review repository context, run a Pi Durable request, and record your decision.</p></header>' +
      '<div class="stack coding-projects"><p class="muted" aria-live="polite">Loading projects…</p></div></div>';
    const page = view.querySelector('.coding-page');
    const projectsEl = page.querySelector('.coding-projects');
    let projects;
    let models;
    try {
      [projects, models] = await Promise.all([coding('/projects'), teamMode ? Promise.resolve([]) : coding('/models')]);
    } catch (error) {
      if (!isDetached()) report(projectsEl, error);
      return;
    }
    if (isDetached()) return;
    const suggestedWorkspace = arg?.startsWith('workspace=') ? arg.slice('workspace='.length) : '';
    const project = projects.find((item) => item.id === arg || (suggestedWorkspace && item.workspace === suggestedWorkspace)) ||
      (!arg ? projects[0] : null);
    projectsEl.innerHTML = !teamMode && projects.length ?
      '<div class="row coding-project-links" aria-label="Coding projects">' + projects.map((item) =>
        '<a href="' + projectHref(item.id) + '" data-project-link' + (item.id === project?.id ? ' aria-current="page"' : '') +
        '>' + esc(item.title) + '</a>').join('') + '</div>' : '';
    if (!teamMode) {
      register(projectsEl, models, suggestedWorkspace, readonly);
      teamSettings(projectsEl, readonly, isDetached);
    }
    if (!project) return;
    const intro = document.createElement('header');
    intro.className = 'coding-project-header stack';
    intro.innerHTML = '<h3>' + esc(project.title) + '</h3>' + (project.workspace
      ? '<p><code>' + esc(project.workspace) + '</code></p>' : '') +
      '<p class="muted">Permitted scope · ' + esc(project.scopes.join(', ')) + '</p>';
    page.append(intro);
    const grid = document.createElement('div');
    grid.className = 'coding-workspace-grid';
    page.append(grid);
    const left = document.createElement('div');
    left.className = 'stack coding-left';
    const right = document.createElement('div');
    right.className = 'stack coding-right';
    grid.append(left, right);
    const runs = activity(right, project, readonly, isDetached);
    composer(left, project, readonly, isDetached, runs.selectRun);
    const composerPanel = left.querySelector('.coding-composer');
    if (!teamMode) settings(left, project, readonly, composerPanel.updateProject, runs.refresh);
    const github = document.createElement('div');
    github.dataset.codingGithub = '';
    left.append(github);
    window.okbGitHub?.mount(github, { project, coding, readonly });
  }

  window.okbCoding = { mount };

  const entrance = document.querySelector('#team-entrance');
  if (entrance) {
    const form = entrance.querySelector('form');
    const feedback = form.querySelector('[role="status"]');
    const submit = form.querySelector('button[type="submit"]');
    const disconnect = document.querySelector('#team-disconnect');
    const teamView = document.querySelector('#team-view');
    let generation = 0;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      teamToken = form.elements.token.value.trim();
      submit.disabled = true;
      report(feedback);
      try {
        await coding('/projects');
        const sequence = ++generation;
        form.reset();
        entrance.hidden = true;
        teamView.hidden = disconnect.hidden = false;
        teamView.focus();
        await mount(teamView, null, () => sequence !== generation, false, true);
      } catch (error) {
        teamToken = null;
        report(feedback, error);
      } finally { submit.disabled = false; }
    });
    disconnect.addEventListener('click', () => {
      ++generation;
      teamToken = null;
      teamView.replaceChildren();
      teamView.hidden = disconnect.hidden = true;
      entrance.hidden = false;
      report(feedback);
      form.elements.token.focus();
    });
  }
})();
