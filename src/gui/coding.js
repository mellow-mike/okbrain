/* The coding workspace uses its own API and storage, separate from brain notes. */
(function () {
  'use strict';

  const esc = window.okbRender.esc;
  const codingPath = '/api/coding';
  const defaultModels = { openai: 'gpt-5-mini', anthropic: 'claude-sonnet-4-6', google: 'gemini-3.5-flash-lite' };
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
  const taskLabels = {
    model: 'Model response', 'source-lookup': 'Approved source lookup', 'package-review': 'Package review',
    'package-work': 'Package work', context: 'Context maintenance', work: 'Run work',
  };
  const taskStates = [['pending', 'pending'], ['running', 'running'], ['waiting', 'waiting'], ['completing', 'finishing']];

  function showTaskProgress(panel, progress, active) {
    const stages = Array.isArray(progress?.stages) ? progress.stages : [];
    const lines = stages.flatMap((stage) => {
      if (typeof stage?.kind !== 'string' || !Object.hasOwn(taskLabels, stage.kind)) return [];
      const counts = taskStates.filter(([key]) => Number.isSafeInteger(stage[key]) && stage[key] > 0)
        .map(([key, label]) => stage[key] + ' ' + label);
      return counts.length ? [taskLabels[stage.kind] + ' · ' + counts.join(', ')] : [];
    });
    const title = active ? 'Current Pi tasks' : 'Saved Pi task state';
    const snapshot = [title, ...lines].join('\n');
    if (panel.dataset.snapshot === snapshot) return;
    panel.dataset.snapshot = snapshot;
    panel.hidden = !lines.length;
    panel.querySelector('h5').textContent = title;
    panel.querySelector('ul').replaceChildren(...lines.map((line) => {
      const item = document.createElement('li');
      item.textContent = line;
      return item;
    }));
  }

  const taskProgressPanel = '<section data-task-progress hidden><h5></h5><ul class="plain"></ul></section>';
  const labelStatus = (run) => statuses[run.review || run.status] || run.status;
  const identity = (run) => ({ session: run.session, requestId: run.id });
  const time = (iso) => new Date(iso).toLocaleString();
  const report = (node, error, message = '') => {
    node.className = error ? 'error coding-feedback' : 'coding-feedback';
    node.textContent = error ? error.message || String(error) : message;
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

  function contextSummary(context) {
    const tokens = (value) => value.toLocaleString() + ' tokens';
    const positiveLimit = (value) => Number.isSafeInteger(value) && value > 0;
    const estimate = context?.estimatedTokens;
    const estimated = Number.isSafeInteger(estimate) && estimate >= 0 ? tokens(estimate) : 'unavailable';
    const limits = [
      ['Input limit', context?.limitTokens],
      ['Output reserve', context?.maxOutputTokens],
      ['Model window', context?.modelWindowTokens],
    ];
    const budget = limits.some(([, value]) => positiveLimit(value))
      ? limits.map(([label, value]) => label + ' ' + (positiveLimit(value) ? tokens(value) : 'unavailable')).join(' · ')
      : 'Model context budget unavailable';
    return '<div class="muted" data-context-budget><p>Estimated active context · ' + esc(estimated) +
      (context?.historyCompacted === true ? ' · Older turns compacted' : '') + '</p><p>' + esc(budget) + '</p></div>';
  }

  function mountRunCopies(actions, { answer, runReport, projectId, session, requestId, status, feedback }) {
    function addButton(label) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      actions.append(button);
      actions.hidden = false;
      return button;
    }
    if (answer) {
      const copyResponse = addButton('Copy response');
      copyResponse.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(answer);
          if (copyResponse.isConnected) report(feedback, undefined, 'Response copied.');
        } catch (error) { if (copyResponse.isConnected) report(feedback, error); }
      });
    }
    if (typeof status !== 'string' || status === 'running' || runReport?.version !== 1 ||
        runReport.runStatus !== status || runReport.projectId !== projectId ||
        runReport.session !== session || runReport.request?.requestId !== requestId) return;
    const copyReport = addButton('Copy run report');
    actions.insertAdjacentHTML('afterend', '<label class="field" data-run-report-fallback hidden><span>Run report JSON</span>' +
      '<textarea rows="8" readonly spellcheck="false"></textarea></label>');
    const fallback = actions.nextElementSibling;
    const jsonField = fallback.querySelector('textarea');
    const json = JSON.stringify(runReport, null, 2);
    let attempt = 0;
    copyReport.addEventListener('click', async () => {
      const current = ++attempt;
      try {
        await navigator.clipboard.writeText(json);
        if (!copyReport.isConnected || current !== attempt) return;
        fallback.hidden = true;
        jsonField.value = '';
        report(feedback, undefined, 'Run report copied.');
      } catch {
        if (!copyReport.isConnected || current !== attempt) return;
        jsonField.value = json;
        fallback.hidden = false;
        jsonField.focus();
        jsonField.select();
        report(feedback, undefined, 'Copy the selected JSON using your browser or system Copy command.');
      }
    });
  }

  function sessionCounters(usage) {
    const counters = [usage.totalTokens.toLocaleString() + ' total tokens', usageText(usage)];
    if (usage.reasoning !== undefined) counters.push(usage.reasoning.toLocaleString() + ' reasoning within output');
    if (usage.cacheWrite1h !== undefined) counters.push(usage.cacheWrite1h.toLocaleString() + ' one-hour cache write');
    if (usage.cost?.total > 0) counters.push('$' + usage.cost.total.toLocaleString(undefined, { maximumFractionDigits: 8 }) + ' estimated USD');
    return counters.join(' · ');
  }

  function childCounters(total, main) {
    if (!main) return total;
    const subtract = (field) => Math.max(0, total[field] - (main[field] ?? 0));
    const child = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].map((field) => [field, subtract(field)]));
    for (const field of ['reasoning', 'cacheWrite1h']) if (total[field] !== undefined) child[field] = subtract(field);
    child.cost = { total: Math.max(0, (total.cost?.total ?? 0) - (main.cost?.total ?? 0)) };
    return child;
  }

  function sessionUsage(pi) {
    const scopes = [['models', 'Models'], ['tools', 'Tools']].map(([key, label]) => {
      const rows = Object.entries(pi.usage?.[key] ?? {}).sort(([a], [b]) => a.localeCompare(b));
      if (!rows.length) return '';
      return '<h5>' + label + '</h5><ul class="plain">' + rows.map(([name, total]) => {
        const main = pi.rootUsage?.[key]?.[name];
        const child = pi.rootUsage && childCounters(total, main);
        const fromChildren = child && (child.totalTokens > 0 || child.cost?.total > 1e-9);
        return '<li><strong>' + esc(name) + '</strong><p>' + esc(sessionCounters(total)) + '</p>' +
          (fromChildren && main ? '<p class="muted">Main conversation · ' + esc(sessionCounters(main)) + '</p>' : '') +
          (fromChildren ? '<p class="muted">Child conversations · ' + esc(sessionCounters(child)) + '</p>' : '') + '</li>';
      }).join('') + '</ul>';
    }).join('');
    return '<details><summary>Session usage</summary>' + (scopes
      ? '<p class="muted">Recorded across this session, including failed or cancelled attempts when usage was saved.</p>' + scopes
      : '<p class="muted">No provider or tool usage recorded for this session.</p>') + '</details>';
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
      const defaultModel = defaultModels[provider.value];
      if ([...model.options].some((item) => item.value === defaultModel)) model.value = defaultModel;
      syncThinking();
      submit.disabled = readonly || !model.options.length;
    }

    provider.replaceChildren(...models.filter((entry) => entry.models.length).map((entry) =>
      new Option(entry.label, entry.provider)));
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

  function savedSourceContents(panel, source) {
    const task = document.createElement('h5');
    task.textContent = 'Saved task';
    const prompt = document.createElement('pre');
    prompt.textContent = source.prompt;
    panel.replaceChildren(task, prompt);
    if (source.guidance) panel.append(disclosure('Project guidance', source.guidance));
    if (!source.groups.length) {
      const description = document.createElement('p');
      description.className = 'muted';
      description.textContent = 'No source files were included in this request.';
      panel.append(description);
    }
    for (const group of source.groups) {
      if (group.label) {
        const heading = document.createElement('h5');
        heading.textContent = group.label;
        panel.append(heading);
      }
      for (const file of group.files) {
        const lines = file.startLine === undefined ? '' : ':' + file.startLine + '–' + file.endLine;
        panel.append(disclosure(file.path + lines, file.text));
      }
    }
  }

  function mountSavedSource(panel, prefix, detached) {
    panel.innerHTML = '<div class="row"><button type="button" aria-expanded="false" aria-controls="coding-saved-source-content">' +
      'View saved request source</button></div><div role="status" class="coding-feedback"></div>' +
      '<div id="coding-saved-source-content" class="coding-preview stack" hidden></div>';
    const button = panel.querySelector('button');
    const feedback = panel.querySelector('[role="status"]');
    const content = panel.querySelector('#coding-saved-source-content');
    let run = null;
    let pending = null;

    function clear() {
      pending = null;
      button.textContent = 'View saved request source';
      button.setAttribute('aria-expanded', 'false');
      content.hidden = true;
      content.replaceChildren();
      report(feedback);
    }

    button.addEventListener('click', async () => {
      if (!run || detached()) return;
      if (button.getAttribute('aria-expanded') === 'true') {
        clear();
        return;
      }
      const request = identity(run);
      pending = request;
      button.textContent = 'Hide saved request source';
      button.setAttribute('aria-expanded', 'true');
      feedback.textContent = 'Reading saved request source…';
      try {
        const source = await coding(prefix + '/source-inspect', request);
        if (pending !== request || detached()) return;
        if (!source) {
          clear();
          feedback.textContent = 'No saved request source is available.';
          return;
        }
        savedSourceContents(content, source);
        content.hidden = false;
        report(feedback);
      } catch (error) {
        if (pending !== request || detached()) return;
        clear();
        report(feedback, error);
      }
    });

    return (nextRun) => {
      if (run?.id === nextRun?.id && run?.session === nextRun?.session) return;
      run = nextRun;
      clear();
      panel.hidden = !run;
    };
  }

  function mountRunPresets(panel, { prefix, manage, detached, inRepository, readDraft, loadDraft, clearPreview }) {
    panel.innerHTML = '<summary>Run presets</summary><div class="stack coding-form">' +
      '<label class="field"><span id="coding-preset-label">Saved preset</span><select form="" aria-labelledby="coding-preset-label"></select></label>' +
      '<div class="row"><button type="button" data-load-preset>Load preset</button></div>' +
      (manage ? field('Preset name', '', 'text', 'data-preset-name form="" maxlength="120"') +
        '<p class="muted">Presets share the task, query, and profile with project members. A blank profile uses the current scope and budget.</p>' +
        '<div class="row"><button type="button" data-save-preset>Save new preset</button>' +
        '<button type="button" data-remove-preset>Remove preset</button></div>' : '') +
      '<div class="coding-feedback" role="status"></div></div>';
    const select = panel.querySelector('select');
    const name = panel.querySelector('[data-preset-name]');
    const load = panel.querySelector('[data-load-preset]');
    const save = panel.querySelector('[data-save-preset]');
    const remove = panel.querySelector('[data-remove-preset]');
    const feedback = panel.querySelector('[role="status"]');
    let rows = [];
    let loading = false;
    let busy = false;
    const selected = () => rows.find((entry) => entry.id === select.value);
    const canUse = () => !loading && !busy && !detached() && inRepository();

    function update() {
      const choice = selected();
      select.disabled = loading || busy;
      load.disabled = loading || busy || !choice;
      if (manage) {
        name.disabled = busy;
        save.disabled = loading || busy;
        remove.disabled = loading || busy || !choice;
        save.textContent = choice ? 'Update preset' : 'Save new preset';
      }
    }
    function show(result, id, preserveDraft = false) {
      const priorId = select.value;
      const changedName = name && name.value !== (selected()?.name || '');
      rows = result.presets;
      select.replaceChildren(new Option(manage ? 'New preset' : 'Choose a preset', ''),
        ...rows.map((entry) => new Option(entry.name, entry.id)));
      select.value = rows.some((entry) => entry.id === id) ? id : '';
      if (name && (!preserveDraft || !changedName || select.value !== priorId)) name.value = selected()?.name || '';
    }
    async function perform(message, action) {
      if (!canUse()) return;
      busy = true;
      update();
      report(feedback);
      feedback.textContent = message;
      try { return await action(); }
      catch (error) { if (!detached()) report(feedback, error); }
      finally {
        busy = false;
        update();
      }
    }

    show({ presets: [] });
    update();
    panel.addEventListener('toggle', async () => {
      if (!panel.open || !canUse()) return;
      loading = true;
      update();
      report(feedback);
      feedback.textContent = 'Loading run presets…';
      try {
        const result = await coding(prefix + '/presets');
        if (detached()) return;
        show(result, select.value, true);
        feedback.textContent = result.presets.length || manage ? '' : 'No presets for this project yet.';
      } catch (error) { if (!detached()) report(feedback, error); }
      finally {
        loading = false;
        update();
      }
    });
    select.addEventListener('change', () => {
      if (name) name.value = selected()?.name || '';
      report(feedback);
      update();
    });
    load.addEventListener('click', () => {
      const choice = selected();
      if (!canUse() || !choice) return;
      loadDraft(choice);
      feedback.textContent = 'Loaded ' + choice.name + '. Preview source before sending.';
    });
    if (!manage) return;
    name.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      if (canUse()) save.click();
    });
    save.addEventListener('click', () => {
      void perform('Saving preset…', async () => {
        const label = name.value.trim();
        if (!label) throw new Error('Enter a preset name.');
        const choice = selected();
        const draft = readDraft(label);
        clearPreview();
        const known = new Set(rows.map(({ id }) => id));
        const result = await coding(prefix + '/presets', { action: 'save', id: choice?.id, name: label, ...draft });
        if (detached()) return;
        show(result, choice?.id || result.presets.find((entry) => !known.has(entry.id) && entry.name === label)?.id);
        feedback.textContent = 'Preset saved.';
      });
    });
    remove.addEventListener('click', () => {
      const choice = selected();
      if (!canUse() || !choice || !confirm('Remove ' + choice.name + ' from this project’s presets?')) return;
      void perform('Removing preset…', async () => {
        const result = await coding(prefix + '/presets', { action: 'remove', id: choice.id });
        if (detached()) return;
        show(result);
        feedback.textContent = 'Preset removed.';
        return true;
      }).then((removed) => { if (removed && canUse()) select.focus(); });
    });
  }

  function composer(parent, project, readonly, detached, selectRun, managePresets) {
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
      '<details data-run-presets></details>' +
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
      '<label class="row" data-source-lookup><input type="checkbox" name="approvedSourceLookup"><span>Let the model look up line numbers within this request’s approved source</span></label>' +
      '<div class="row"><button type="button" data-preview>Preview source</button></div>' +
      '<div class="coding-preview stack" aria-live="polite" data-preview-content></div>' +
      '<div data-evaluation-options></div>' +
      '<label class="row" data-approve hidden><input type="checkbox" name="approved"><span data-approve-text></span></label>' +
      '<div class="row"><button type="submit" class="primary" disabled>Send request</button><span class="muted">' + esc(project.model) +
      '</span></div><p class="muted" data-send-compaction-notice hidden>Finish local compaction in Run history before sending in this session.</p>' +
      '<div data-composer-feedback class="coding-feedback" role="status"></div></form>';
    parent.append(panel);

    const form = panel.querySelector('form');
    const { source, projects, tokenBudget, profile, files, session, requestId, prompt, approved, approvedSourceLookup } = form.elements;
    const previewButton = form.querySelector('[data-preview]');
    const send = form.querySelector('button[type="submit"]');
    const previewEl = form.querySelector('[data-preview-content]');
    const approve = form.querySelector('[data-approve]');
    const approveText = form.querySelector('[data-approve-text]');
    const compactionNotice = form.querySelector('[data-send-compaction-notice]');
    const packageFields = Array.from(form.querySelectorAll('[data-package]'));
    const feedback = form.querySelector('[data-composer-feedback]');
    const evaluation = window.okbCodingEvaluation.composerOptions(form.querySelector('[data-evaluation-options]'), readonly);
    let preview = null;
    let revision = 0;
    let busy = false;
    const pendingCompactions = new Set();

    function updateSend() {
      const pending = pendingCompactions.has(session.value.trim());
      compactionNotice.hidden = !pending;
      send.disabled = readonly || busy || project.credential === 'missing' || !preview || !approved.checked || pending;
    }

    function clearPreview() {
      revision++;
      preview = null;
      previewEl.replaceChildren();
      approved.checked = false;
      approve.hidden = true;
      updateSend();
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

    mountRunPresets(form.querySelector('[data-run-presets]'), {
      prefix, manage: managePresets, detached, inRepository: () => source.value === 'repository',
      readDraft: (name) => {
        const selection = sourceInput();
        if (!prompt.value.trim() || !selection.query.trim()) throw new Error('Enter a task and source query to save a preset.');
        return { prompt: prompt.value, query: selection.query, profile: selection.profile !== undefined ? selection.profile : {
          version: 1, name, projects: selection.projects,
          ...(selection.tokenBudget === undefined ? {} : { tokenBudget: selection.tokenBudget }),
        } };
      },
      loadDraft: (preset) => {
        prompt.value = preset.prompt;
        form.elements.query.value = preset.query;
        profile.value = JSON.stringify(preset.profile, null, 2);
        projects.value = preset.profile.projects.join(', ');
        tokenBudget.value = preset.profile.tokenBudget ?? '';
        approvedSourceLookup.checked = false;
        clearPreview();
      },
      clearPreview,
    });

    for (const input of [source, projects, tokenBudget, profile, files, session, requestId, prompt, approvedSourceLookup,
      form.elements.query, ...form.querySelectorAll('[data-package] input')])
      input.addEventListener('input', clearPreview);
    source.addEventListener('change', () => {
      form.querySelector('[data-repository]').hidden = source.value !== 'repository';
      form.querySelector('[data-files]').hidden = source.value !== 'files';
      form.querySelector('[data-packages]').hidden = source.value !== 'packages';
      form.querySelector('[data-source-lookup]').hidden = source.value === 'packages';
      if (source.value === 'packages') approvedSourceLookup.checked = false;
    });
    approved.addEventListener('change', updateSend);

    previewButton.addEventListener('click', async () => {
      clearPreview();
      const current = revision;
      previewButton.disabled = true;
      report(feedback);
      feedback.textContent = 'Reading selected source…';
      try {
        const selection = sourceInput();
        const lookup = approvedSourceLookup.checked;
        if (lookup && selection.source === 'files' && !selection.files.length)
          throw new Error('Choose at least one file to allow approved source lookup.');
        const result = await coding(prefix + '/preview', { ...selection, ...(evaluation.enabled() ? { measurePreview: true } : {}) });
        if (current !== revision || detached()) return;
        previewContents(previewEl, result);
        if (result.source === 'repository' && !result.excerpts.length) return;
        if (result.source === 'packages' && result.packages.some((part) => !part.excerpts.length)) return;
        preview = { selection, lookup, id: result.manifest?.id || result.id };
        const provider = project.providerLabel;
        approveText.textContent = result.source === 'packages'
          ? 'Approve sending the shared task and each package’s selected text to ' + provider + '.'
          : 'Approve sending the task, selected text, and active session history to ' + provider + '.';
        if (lookup) approveText.textContent += ' Allow lookups within this request’s selected text.';
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
      if (send.disabled) return;
      busy = true;
      send.disabled = true;
      report(feedback);
      try {
        const run = await coding(prefix + '/run', {
          ...preview.selection, approved: true, previewId: preview.id, prompt: prompt.value,
          session: session.value, requestId: requestId.value, evaluation: evaluation.value(),
          ...(preview.lookup ? { approvedSourceLookup: true } : {}),
        });
        if (detached()) return;
        await selectRun(run);
        if (run.status !== 'failed') {
          requestId.value = crypto.randomUUID();
          approvedSourceLookup.checked = false;
          clearPreview();
          feedback.textContent = 'Request ' + run.id + ' is tracked in Run history.';
        }
      } catch (error) {
        report(feedback, error);
      } finally {
        busy = false;
        updateSend();
      }
    });

    panel.updateProject = (current) => {
      project = current;
      updateSend();
      if (project.credential === 'missing') feedback.textContent = 'Add a provider API key in Project settings to send a request.';
      else if (feedback.textContent.startsWith('Add a provider API key')) report(feedback);
    };
    panel.setCompactionPending = (name, pending) => {
      if (pendingCompactions.has(name) === pending) return;
      if (pending) pendingCompactions.add(name);
      else pendingCompactions.delete(name);
      if (name !== session.value.trim()) return;
      approvedSourceLookup.checked = false;
      clearPreview();
    };
    panel.updateProject(project);
    return (targetSession) => {
      if (session.value !== targetSession) return;
      approvedSourceLookup.checked = false;
      clearPreview();
    };
  }

  function mountContextControls(panel, { prefix, detached, provider, clearConsent, markCompactionPending, refresh }) {
    panel.innerHTML = '<details data-reset-note><summary>Add a handoff note</summary><div class="stack coding-form">' +
      '<label class="field"><span>Handoff note (optional)</span><textarea rows="4" maxlength="4096" aria-describedby="context-reset-note-limit"></textarea></label>' +
      '<p class="muted" id="context-reset-note-limit"></p></div></details>' +
      '<p class="muted" data-context-pending hidden>Local compaction was interrupted. Finish it before starting fresh context or sending a new request.</p>' +
      '<div class="row" data-context-actions><button type="button" data-start-reset>Start fresh context</button>' +
      '<button type="button" data-start-compact>Compact context locally</button></div>' +
      '<div data-reset-confirmation hidden><div class="stack"><p data-reset-session></p>' +
      '<div data-reset-handoff-review hidden><h5>Handoff note to send</h5><p data-reset-destination></p>' +
      '<pre class="source-markdown" data-reset-handoff></pre></div>' +
      '<label class="row"><input type="checkbox"><span data-context-approval></span></label>' +
      '<div class="row"><button type="button" data-reset-apply disabled>Reset context</button>' +
      '<button type="button" data-reset-cancel>Cancel reset</button></div></div></div>' +
      '<div class="coding-feedback" role="status"></div>';
    const entry = panel.querySelector('[data-context-actions]');
    const start = entry.querySelector('[data-start-reset]');
    const compact = entry.querySelector('[data-start-compact]');
    const pendingNotice = panel.querySelector('[data-context-pending]');
    const confirmation = panel.querySelector('[data-reset-confirmation]');
    const approval = confirmation.querySelector('input');
    const approvalLabel = confirmation.querySelector('[data-context-approval]');
    const apply = confirmation.querySelector('[data-reset-apply]');
    const cancel = confirmation.querySelector('[data-reset-cancel]');
    const scope = confirmation.querySelector('[data-reset-session]');
    const noteDetails = panel.querySelector('[data-reset-note]');
    const note = noteDetails.querySelector('textarea');
    const byteCount = noteDetails.querySelector('p');
    const handoffReview = confirmation.querySelector('[data-reset-handoff-review]');
    const handoffText = handoffReview.querySelector('[data-reset-handoff]');
    const destination = handoffReview.querySelector('[data-reset-destination]');
    const noteLimit = 2048;
    const encoder = new TextEncoder();
    const feedback = panel.querySelector('[role="status"]');
    let session = null;
    let preview = null;
    let revision = 0;
    let phase = '';
    let action = '';
    let compactionPending = false;

    function update() {
      const bytes = encoder.encode(note.value).byteLength;
      const busy = !!phase;
      byteCount.textContent = bytes + ' / ' + noteLimit + ' UTF-8 bytes' + (bytes > noteLimit ? '. Shorten the note to continue.' : '');
      note.setAttribute('aria-invalid', String(bytes > noteLimit));
      panel.hidden = !session;
      entry.hidden = !!preview;
      confirmation.hidden = !preview;
      pendingNotice.hidden = !compactionPending || !!preview;
      noteDetails.hidden = compactionPending || action === 'compact-context';
      start.hidden = compactionPending;
      start.disabled = busy || bytes > noteLimit;
      compact.disabled = busy;
      approval.disabled = cancel.disabled = busy;
      note.disabled = phase === 'applying';
      apply.disabled = busy || !preview || !approval.checked;
    }
    function clear() {
      revision++;
      preview = null;
      approval.checked = false;
      phase = '';
      action = '';
      handoffText.textContent = '';
      update();
    }
    function discard() {
      note.value = '';
      noteDetails.open = false;
      clear();
    }
    function current(expected, attempt) {
      return !detached() && panel.isConnected && session === expected && revision === attempt;
    }
    async function review(method, button) {
      if (button.disabled || button.hidden || !session || detached()) return;
      const expected = session;
      const reset = method === 'reset-context';
      const draft = reset ? note.value : '';
      const attempt = ++revision;
      phase = 'previewing';
      action = method;
      update();
      report(feedback);
      feedback.textContent = 'Checking session context…';
      try {
        const { version, handoff, recovering } = await coding(prefix + '/' + method + '-preview', {
          session: expected, ...(draft ? { handoff: draft } : {}),
        });
        if (!current(expected, attempt) || (reset && note.value !== draft)) return;
        if (typeof version !== 'string' || !version) throw new Error('Could not preview this session’s active context.');
        if (reset && handoff !== (draft.trim() ? draft : undefined)) throw new Error('The preview did not match your handoff note. Preview this session again before resetting.');
        const approvedNote = reset ? handoff : undefined;
        preview = { draft, request: { session: expected, version, ...(approvedNote === undefined ? {} : { handoff: approvedNote }) } };
        if (!reset && recovering === true) {
          compactionPending = true;
          markCompactionPending(expected, true);
        }
        scope.textContent = reset
          ? 'Future requests in ' + expected + ' will start with fresh context. Saved requests, source snapshots, and responses stay in Run history.'
          : (recovering === true ? 'Finish the interrupted compaction in ' : 'Compact older context in ') + expected +
            '. The recap is generated entirely on this device. Recent turns stay in context and the original runs remain in Run history. Short sessions may have too little history to compact.';
        approvalLabel.textContent = reset ? 'Clear active context and keep saved run history' : 'Compact older context and keep saved run history';
        apply.textContent = reset ? 'Reset context' : recovering === true ? 'Finish compaction' : 'Compact context';
        cancel.textContent = reset ? 'Cancel reset' : 'Cancel compaction';
        handoffReview.hidden = approvedNote === undefined;
        if (approvedNote !== undefined) {
          handoffText.textContent = approvedNote;
          destination.textContent = 'The note will accompany the next request in this session to ' + (provider() || 'the session’s provider') + '.';
        }
        report(feedback);
      } catch (error) {
        if (current(expected, attempt)) report(feedback, error);
      } finally {
        if (current(expected, attempt)) {
          phase = '';
          if (!preview) action = '';
          update();
          if (preview) approval.focus();
        }
      }
    }
    start.addEventListener('click', () => review('reset-context', start));
    compact.addEventListener('click', () => review('compact-context', compact));
    note.addEventListener('input', () => {
      if (phase === 'applying' || action === 'compact-context') return;
      clear();
      report(feedback);
    });
    approval.addEventListener('change', update);
    cancel.addEventListener('click', () => {
      if (phase) return;
      const reset = action === 'reset-context';
      if (reset) discard();
      else clear();
      report(feedback);
      (reset ? start : compact).focus();
    });
    apply.addEventListener('click', async () => {
      const reset = action === 'reset-context';
      if (apply.disabled || !preview || detached() || preview.request.session !== session || (reset && preview.draft !== note.value)) return;
      const approved = preview.request;
      const attempt = ++revision;
      const button = reset ? start : compact;
      phase = 'applying';
      update();
      report(feedback);
      feedback.textContent = reset ? 'Resetting active context…' : 'Compacting context locally…';
      try {
        clearConsent(approved.session);
        const result = await coding(prefix + '/' + action, approved);
        if (!current(approved.session, attempt)) return;
        if (!reset && (result?.version !== approved.version || typeof result.compacted !== 'boolean'))
          throw new Error('Could not confirm the local compaction result. Refresh Run history before trying again.');
        if (!reset) {
          compactionPending = false;
          markCompactionPending(approved.session, false);
        }
        await refresh();
        if (!current(approved.session, attempt)) return;
        if (reset) discard();
        else clear();
        feedback.textContent = reset ? 'Active context cleared. Saved history is still available.' : result.compacted
          ? 'Older context compacted locally. Saved history is still available.'
          : 'This session has too little older context to compact.';
        button.focus();
      } catch (error) {
        if (!current(approved.session, attempt)) return;
        clear();
        report(feedback, error);
        button.focus();
        if (!reset) await refresh();
      }
    });
    update();
    return (next, pending = false) => {
      if (session === next && compactionPending === pending) return;
      const changedSession = session !== next;
      session = next;
      compactionPending = pending;
      if (changedSession) {
        discard();
        report(feedback);
      } else clear();
    };
  }

  function activity(parent, project, readonly, detached, reviewPatch, contextActions) {
    const prefix = projectUrl(project.id);
    const panel = document.createElement('section');
    panel.className = 'coding-panel coding-activity stack';
    panel.innerHTML = '<div class="row"><h3>Run history</h3><button type="button" class="small right" data-refresh>Refresh</button></div>' +
      '<div class="stack coding-runs" data-runs></div><div class="stack" data-inspect aria-live="polite"></div>' +
      '<section class="stack" data-saved-request-source hidden></section>' +
      (contextActions && !readonly ? '<section class="stack" data-context-controls hidden></section>' : '') +
      '<div class="coding-feedback" role="status"></div>';
    parent.append(panel);
    const list = panel.querySelector('[data-runs]');
    const inspected = panel.querySelector('[data-inspect]');
    const feedback = panel.querySelector('[role="status"]');
    const setSavedSourceRun = mountSavedSource(panel.querySelector('[data-saved-request-source]'), prefix, detached);
    const contextPanel = panel.querySelector('[data-context-controls]');
    const setContextSession = contextPanel ? mountContextControls(contextPanel, {
      prefix, detached, provider: () => project.providerLabel, ...contextActions, refresh,
    }) : null;
    let selected = null;
    let timer;
    let generation = 0;

    function showLiveAnswer(preview, answer) {
      preview.hidden = !answer;
      const label = preview.querySelector('p');
      const text = preview.querySelector('pre');
      const caption = answer?.truncated ? 'Response in progress · Preview limit reached' : 'Response in progress';
      if (label.textContent !== caption) label.textContent = caption;
      if (text.textContent !== (answer?.text ?? '')) text.textContent = answer?.text ?? '';
    }

    async function readRun(run, current, idle) {
      const result = await coding(prefix + '/inspect', identity(run));
      if (detached() || current !== generation) return;
      const pi = result.pi;
      const row = result.run;
      const compactionPending = pi?.context?.compactionPending === true;
      if (pi) contextActions?.markCompactionPending(row.session, compactionPending);
      setContextSession?.(idle && pi && !pi.pendingRequestIds.length ? row.session : null, compactionPending);
      const canViewSource = row.status !== 'running' &&
        (row.admitted || pi?.request || (row.status === 'interrupted' && !result.admissionMissing));
      setSavedSourceRun(canViewSource ? row : null);
      const receipt = pi?.request?.receipt;
      const error = row.error || receipt?.reason;
      const snippet = receipt?.repositoryContext?.files || pi?.request?.repositoryContext?.files || [];
      const progress = result.taskProgress ?? pi?.request?.taskProgress;
      const live = inspected.querySelector('[data-live-answer]');
      if (row.status === 'running' && inspected.dataset.run === row.id && inspected.dataset.session === row.session && live) {
        showLiveAnswer(live, result.liveAnswer);
        showTaskProgress(inspected.querySelector('[data-task-progress]'), progress, true);
        return;
      }
      inspected.dataset.run = row.id;
      inspected.dataset.session = row.session;
      inspected.innerHTML = '<div class="coding-result stack"><h4>' + esc(row.id) + '</h4>' +
        '<p>' + esc(labelStatus(row)) + ' · ' + esc(row.session) + ' · ' + esc(row.actor) + '</p>' +
        (row.reviewer ? '<p class="muted">Reviewed by ' + esc(row.reviewer) + ' · ' + esc(time(row.reviewed)) + '</p>' : '') +
        (error ? '<div class="notice">' + esc(error) + '</div>' : '') +
        (result.admissionMissing ? '<p class="muted">Pi did not save this request. Resume will make this ID available for resubmission.</p>' : '') +
        (pi ? '<p class="muted">Request usage · ' + esc(usageText(pi.request?.usage)) + '</p>' + contextSummary(pi.context) : '') +
        (pi?.request?.approvedSourceLookup ? '<p class="muted">Approved source lookup enabled for this request.</p>' : '') +
        (receipt?.stopReason === 'length' ? '<p class="muted">The model reached its output limit.</p>' : '') +
        taskProgressPanel +
        (row.status === 'running' ? '<div data-live-answer hidden><p class="muted"></p><pre></pre></div>' : '') +
        (receipt?.text ? '<pre data-answer></pre>' : '') + '<div class="row" data-run-copy-actions hidden></div>' +
        (pi ? sessionUsage(pi) : '') +
        (snippet.length ? '<details><summary>Source references</summary><ul>' + snippet.map((file) =>
          '<li><code>' + esc(file.path + ':' + file.startLine + '–' + file.endLine) + '</code></li>').join('') + '</ul></details>' : '') +
        '<div class="row" data-actions></div></div>';
      showTaskProgress(inspected.querySelector('[data-task-progress]'), progress, row.status === 'running');
      if (row.status === 'running') showLiveAnswer(inspected.querySelector('[data-live-answer]'), result.liveAnswer);
      if (receipt?.text) inspected.querySelector('[data-answer]').textContent = receipt.text;
      mountRunCopies(inspected.querySelector('[data-run-copy-actions]'), {
        answer: receipt?.text, runReport: result.report, projectId: project.id,
        session: row.session, requestId: row.id, status: row.status, feedback,
      });
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
        if (row.review === 'accepted' && reviewPatch) {
          const patch = document.createElement('button');
          patch.type = 'button';
          patch.dataset.reviewPatch = '';
          patch.textContent = 'Review proposed patch';
          patch.addEventListener('click', () => reviewPatch(row));
          bar.append(patch);
        }
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
          if (extras?.decision === 'accepted' && !detached() && selected?.id === row.id && selected.session === row.session)
            inspected.querySelector('[data-review-patch]')?.focus();
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
        if (target) {
          const idle = !rows.some((row) => row.session === target.session && (row.status === 'running' || row.status === 'interrupted'));
          if (!idle) setContextSession?.(null);
          await readRun(target, current, idle);
        }
        else {
          selected = null;
          setSavedSourceRun(null);
          setContextSession?.(null);
          inspected.replaceChildren();
        }
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
      if (selected?.id !== row.id || selected.session !== row.session) {
        setSavedSourceRun(null);
        setContextSession?.(null);
        inspected.replaceChildren();
      }
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
      '<h3>Transcript retention</h3><form class="stack" data-retention>' +
      field('Days to keep inactive transcripts', '', 'number', 'name="days" min="1" max="365" step="1"') +
      '<p class="muted">Leave blank to keep transcripts until you delete them. Saving an age limit can remove already expired sessions. Running or interrupted sessions stay available.</p>' +
      '<div class="row"><button type="submit">Save retention policy</button></div></form><form class="stack" data-delete>' +
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
    const retention = panel.querySelector('[data-retention]');
    const saveRetention = retention.querySelector('button');
    const credential = panel.querySelector('[data-credential]');
    panel.querySelectorAll('button').forEach((button) => button.disabled = readonly);
    saveRetention.disabled = true;

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
      if (panel.open) { loadMembers(); loadRetention(); }
      else token.replaceChildren();
    });
    async function loadRetention() {
      try {
        const policy = await coding(prefix + '/retention');
        retention.elements.days.value = policy.days ?? '';
        retention.elements.days.disabled = saveRetention.disabled = readonly || !policy.active;
      } catch (error) { report(feedback, error); }
    }
    retention.addEventListener('submit', async (event) => {
      event.preventDefault();
      saveRetention.disabled = true;
      report(feedback);
      try {
        const value = retention.elements.days.value;
        const { removed } = await coding(prefix + '/retention', { days: value === '' ? null : Number(value) });
        feedback.textContent = removed === 1 ? 'Retention saved. One transcript expired.' :
          removed > 1 ? 'Retention saved. ' + removed + ' transcripts expired.' : 'Retention policy saved.';
        await runsChanged();
      } catch (error) { report(feedback, error); }
      finally { saveRetention.disabled = readonly; }
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
    panel.innerHTML = '<summary>Team browser access</summary><div class="stack coding-form">' +
      '<p class="muted">The team listener accepts project tokens.</p><form class="stack">' +
      '<div class="coding-grid">' +
      field('Local port', '6524', 'number', 'name="port" min="0" max="65535" required') +
      field('HTTPS proxy origin (optional)', '', 'url', 'name="publicOrigin" placeholder="https://coding.example.com"') +
      '</div><label class="row"><input type="checkbox" name="startOnLaunch"><span>Start on launch</span></label>' +
      '<p class="muted">Startup uses a fixed local port. Use port 0 to let the app choose a port for this run.</p>' +
      '<div class="row"><button type="submit" disabled>Start team listener</button></div></form>' +
      '<div data-team-live></div><div data-team-startup hidden><p data-team-startup-summary></p><p class="error" data-team-startup-error hidden></p></div>' +
      '<div class="row" data-team-actions hidden><button type="button" data-enable hidden>Enable startup</button>' +
      '<button type="button" data-disable hidden>Disable startup</button><button type="button" data-retry hidden>Retry startup</button>' +
      '<button type="button" data-stop hidden>Stop listener</button></div>' +
      '<div class="coding-feedback" role="status"></div>' +
      '<div class="stack"><h3>Connect VS Code or Cursor</h3>' +
      '<p>Use <strong>Extensions → Install from VSIX</strong> to install <code>okbrain-coding.vsix</code>. ' +
      'From a trusted local editor window, choose <strong>okbrain: Connect to Team Workspace</strong> in the Command Palette.</p>' +
      '<p class="muted" data-team-editor-help>Set an HTTPS proxy origin when starting the listener to connect an editor.</p></div></div>';
    parent.append(panel);
    const form = panel.querySelector('form');
    const feedback = panel.querySelector('[role="status"]');
    const start = form.querySelector('button[type="submit"]');
    const stop = panel.querySelector('[data-stop]');
    const enable = panel.querySelector('[data-enable]');
    const disable = panel.querySelector('[data-disable]');
    const retry = panel.querySelector('[data-retry]');
    const live = panel.querySelector('[data-team-live]');
    const startup = panel.querySelector('[data-team-startup]');
    const startupSummary = panel.querySelector('[data-team-startup-summary]');
    const startupError = panel.querySelector('[data-team-startup-error]');
    const actions = panel.querySelector('[data-team-actions]');
    const editorHelp = panel.querySelector('[data-team-editor-help]');
    const { port, publicOrigin, startOnLaunch } = form.elements;
    const brain = document.querySelector('#brain')?.value;
    const current = () => panel.isConnected && !isDetached() && document.querySelector('#brain')?.value === brain;
    let status = null;
    let prefs = null;
    let busy = false;

    function paint() {
      if (!current()) return;
      const saved = prefs?.startup;
      const locked = readonly || busy || !prefs;
      form.hidden = !!status || !!saved;
      start.disabled = port.disabled = publicOrigin.disabled = startOnLaunch.disabled = locked;
      stop.hidden = !status;
      enable.hidden = !status || !!saved;
      disable.hidden = !saved;
      retry.hidden = !!status || !saved;
      stop.disabled = enable.disabled = disable.disabled = retry.disabled = locked;
      actions.hidden = readonly || (!status && !saved);
      startup.hidden = !saved && !prefs?.startupError;
      startupSummary.textContent = saved ? 'Startup enabled on local port ' + saved.port +
        (saved.publicOrigin ? ' · HTTPS proxy ' + saved.publicOrigin : '') + '.' +
        (status ? ' Stop listener also disables startup.' : '') : '';
      startupError.textContent = prefs?.startupError || '';
      startupError.hidden = !prefs?.startupError;
      editorHelp.textContent = status?.publicOrigin
        ? 'In the editor, enter the HTTPS team origin shown above and a project token from Project settings → Team access.'
        : saved?.publicOrigin ? 'Start the team listener before connecting an editor.'
        : 'Set an HTTPS proxy origin when starting the listener to connect an editor.';
      live.replaceChildren();
      live.hidden = !status;
      if (!status) return;
      live.append(status.publicOrigin ? 'HTTPS team origin ' : 'Local team browser ', Object.assign(document.createElement('a'), {
        href: status.publicOrigin || status.url, textContent: status.publicOrigin || status.url,
        target: '_blank', rel: 'noopener noreferrer',
      }));
      if (status.publicOrigin) live.append(' · Local upstream ' + status.url);
    }

    function setStatus(next) {
      if (status && !next) startOnLaunch.checked = false;
      status = next;
      if (status) {
        port.value = status.port;
        publicOrigin.value = status.publicOrigin || '';
      }
      port.min = startOnLaunch.checked ? '1' : '0';
    }
    async function read() {
      const [next, preferences] = await Promise.all([coding('/team'), coding('/team/preferences')]);
      if (!current()) return;
      setStatus(next);
      prefs = preferences;
    }
    async function perform(action, message = '', refreshOnError = false) {
      if (busy || !current()) return;
      busy = true;
      paint();
      report(feedback);
      let focusAfter;
      try {
        focusAfter = await action();
        if (current()) feedback.textContent = typeof message === 'function' ? message() : message;
      } catch (error) {
        if (refreshOnError && current()) await read().catch(() => {});
        if (current()) report(feedback, error);
      } finally {
        busy = false;
        paint();
        if (current()) focusAfter?.focus();
      }
    }
    function changeListener(input, message) {
      if (readonly || !prefs) return;
      void perform(async () => {
        const next = await coding('/team', input);
        if (!current()) return;
        setStatus(next);
        prefs = await coding('/team/preferences');
        return status ? stop : start;
      }, message, true);
    }
    function changeStartup(input, message) {
      if (readonly || !prefs) return;
      void perform(async () => {
        const next = await coding('/team/preferences', input);
        if (!current()) return;
        prefs = next;
        if (input.action === 'retry') {
          const resumed = await coding('/team');
          if (!current()) return;
          setStatus(resumed);
          return status ? stop : retry;
        }
        return input.action === 'enable' ? disable : status ? enable : start;
      }, message, true);
    }

    panel.addEventListener('toggle', () => {
      if (panel.open) void perform(read);
    });
    startOnLaunch.addEventListener('change', () => {
      port.min = startOnLaunch.checked ? '1' : '0';
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (start.disabled || status || prefs?.startup) return;
      changeListener({
        action: 'start', port: Number(port.value), publicOrigin: publicOrigin.value, startOnLaunch: startOnLaunch.checked,
      }, startOnLaunch.checked ? 'Team listener started and startup saved.' : 'Team listener started.');
    });
    stop.addEventListener('click', () => {
      if (status) changeListener({ action: 'stop' }, prefs?.startup
        ? 'Team listener stopped and startup disabled.' : 'Team listener stopped.');
    });
    enable.addEventListener('click', () => {
      if (status && !prefs?.startup)
        changeStartup({ action: 'enable', port: status.port, publicOrigin: status.publicOrigin }, 'Startup saved.');
    });
    disable.addEventListener('click', () => {
      if (prefs?.startup) changeStartup({ action: 'disable' }, 'Startup disabled.');
    });
    retry.addEventListener('click', () => {
      if (!status && prefs?.startup) changeStartup({ action: 'retry' }, () => status ? 'Team listener started.' : '');
    });
    paint();
  }

  function patchReview(parent, project, readonly, detached) {
    const prefix = projectUrl(project.id);
    const panel = document.createElement('details');
    panel.className = 'coding-panel';
    panel.innerHTML = '<summary>Apply a reviewed patch</summary><form class="stack coding-form">' +
      '<label class="field"><span id="patch-accepted-label">Accepted result</span><select name="run" aria-labelledby="patch-accepted-label"><option value="">Choose a result</option></select></label>' +
      '<div data-proposals></div>' +
      '<label class="field"><span>Git unified diff</span><textarea name="diff" rows="9" spellcheck="false" placeholder="diff --git a/src/example.ts b/src/example.ts"></textarea></label>' +
      '<p class="muted">Edit tracked text files or add text files inside this project. This changes the local worktree and leaves the staging area alone.</p>' +
      '<div class="row"><button type="button" data-check>Preview patch</button></div><div data-summary aria-live="polite"></div>' +
      '<label class="row" data-confirm hidden><input type="checkbox" name="approved"><span>Apply this exact diff to the listed files.</span></label>' +
      '<div class="row"><button type="submit" class="primary" disabled>Apply to worktree</button></div><div class="coding-feedback" role="status"></div></form>';
    parent.append(panel);
    const form = panel.querySelector('form');
    const { run, diff, approved } = form.elements;
    const check = panel.querySelector('[data-check]');
    const summary = panel.querySelector('[data-summary]');
    const confirm = panel.querySelector('[data-confirm]');
    const submit = panel.querySelector('[type="submit"]');
    const feedback = panel.querySelector('[role="status"]');
    const proposalArea = panel.querySelector('[data-proposals]');
    const heading = panel.querySelector('summary');
    let preview = null;
    let revision = 0;
    let runsRevision = 0;
    let proposalRevision = 0;
    let fromProposal = false;
    let loading = false;
    let busy = false;
    function update() {
      check.disabled = readonly || busy || loading || !run.value || !diff.value;
      submit.disabled = readonly || busy || !preview || !approved.checked;
    }
    function clear() {
      revision++;
      preview = null;
      approved.checked = false;
      confirm.hidden = true;
      summary.replaceChildren();
      update();
    }
    function cancelProposalLoad() {
      proposalRevision++;
      loading = false;
    }
    function resetProposals() {
      proposalArea.replaceChildren();
      if (fromProposal) diff.value = '';
      fromProposal = false;
    }
    async function loadRuns(target, intent) {
      const current = ++runsRevision;
      try {
        const accepted = (await coding(prefix + '/runs')).filter((entry) => entry.status === 'done' && entry.review === 'accepted');
        if (detached() || !panel.open || current !== runsRevision) return false;
        const selected = target && intent === proposalRevision ? JSON.stringify(target) : run.value;
        run.replaceChildren(new Option(accepted.length ? 'Choose a result' : 'No accepted results', ''),
          ...accepted.map((entry) => new Option(entry.session + ' · ' + entry.id, JSON.stringify(identity(entry)))));
        run.value = accepted.length === 1 && !selected ? run.options[1].value : selected;
        clear();
        return !target || run.value === JSON.stringify(target);
      } catch (error) {
        if (detached() || !panel.open || current !== runsRevision) return false;
        throw error;
      }
    }
    function loadDiff(proposal) {
      diff.value = proposal.diff;
      fromProposal = true;
      clear();
      diff.focus();
    }
    async function openRun(row) {
      if (readonly || busy || detached()) return;
      const target = identity(row);
      const current = ++proposalRevision;
      const active = () => current === proposalRevision && !detached() && panel.open;
      panel.open = true;
      heading.focus();
      resetProposals();
      loading = true;
      clear();
      feedback.textContent = 'Reading proposed patches from the saved response…';
      try {
        const accepted = await loadRuns(target, current);
        if (!active()) return;
        if (!accepted) {
          feedback.textContent = 'Choose an accepted result to review its patch.';
          return;
        }
        const { proposals } = await coding(prefix + '/patch-proposals', target);
        if (!active()) return;
        if (!proposals.length) {
          feedback.textContent = 'The saved response has no supported patch. Enter a Git unified diff to continue.';
          diff.focus();
        } else if (proposals.length === 1 && !diff.value.trim()) {
          feedback.textContent = 'Proposed diff loaded for review.';
          loadDiff(proposals[0]);
        } else {
          proposalArea.innerHTML = '<label class="field"><span id="patch-proposal-label">Proposed diff</span>' +
            '<select aria-labelledby="patch-proposal-label"></select></label>';
          const choice = proposalArea.querySelector('select');
          choice.replaceChildren(new Option('Choose a proposed diff', ''),
            ...proposals.map(({ paths }, index) => new Option('Proposal ' + (index + 1) + ' · ' + paths.join(', '), String(index))));
          choice.addEventListener('change', () => {
            if (choice.value === '') {
              if (fromProposal) diff.value = '';
              fromProposal = false;
              clear();
              return;
            }
            loadDiff(proposals[Number(choice.value)]);
          });
          report(feedback);
          choice.focus();
        }
      } catch (error) {
        if (active()) report(feedback, error);
      } finally {
        if (active()) { loading = false; update(); }
      }
    }
    heading.addEventListener('click', () => {
      if (panel.open || readonly) return;
      loadRuns().catch((error) => report(feedback, error));
    });
    panel.addEventListener('toggle', () => {
      if (panel.open) return;
      runsRevision++;
      cancelProposalLoad();
      clear();
      report(feedback);
    });
    run.addEventListener('change', () => {
      cancelProposalLoad();
      resetProposals();
      clear();
      report(feedback);
    });
    diff.addEventListener('input', () => {
      if (loading) { cancelProposalLoad(); report(feedback); }
      clear();
    });
    approved.addEventListener('change', update);
    check.addEventListener('click', async () => {
      if (check.disabled) return;
      clear();
      const current = revision;
      const input = { ...JSON.parse(run.value), diff: diff.value };
      busy = true;
      update();
      report(feedback);
      try {
        const result = await coding(prefix + '/patch-preview', input);
        if (revision !== current || detached()) return;
        if (result.applied) {
          summary.textContent = 'Applied ' + time(result.applied) + '.';
          return;
        }
        const list = document.createElement('ul');
        for (const { path, before } of result.files) {
          const item = document.createElement('li');
          item.textContent = before === null ? path + ' · New file' : path;
          list.append(item);
        }
        summary.replaceChildren(list);
        preview = { ...input, previewId: result.id };
        confirm.hidden = false;
        approved.focus();
      } catch (error) {
        if (revision === current && !detached()) report(feedback, error);
      } finally { busy = false; update(); }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const current = revision;
      busy = true;
      update();
      report(feedback);
      try {
        const result = await coding(prefix + '/patch-apply', { ...preview, approved: true });
        if (revision !== current || detached()) return;
        clear();
        feedback.textContent = 'Applied to the local worktree ' + time(result.applied) + '.';
      } catch (error) {
        if (revision === current && !detached()) {
          clear();
          report(feedback, error);
        }
      }
      finally { busy = false; update(); }
    });
    update();
    return openRun;
  }

  async function mount(view, arg, isDetached, readonly, teamMode = false) {
    view.innerHTML =
      '<div class="stack wide coding-page"><header><h2 class="display">Coding workspace</h2>' +
      '<p class="muted">Review repository context, run a Pi Durable request, and record your decision.</p></header>' +
      '<div class="stack coding-projects"><p class="muted" aria-live="polite">Loading projects…</p></div></div>';
    const page = view.querySelector('.coding-page');
    const projectsEl = page.querySelector('.coding-projects');
    if (!teamMode && arg === 'standalone') {
      projectsEl.remove();
      await window.okbCodingStandalone.mount(page, {
        coding, readonly, detached: isDetached, defaultModels, entries, field, previewContents, report, sessionUsage, usageText, contextSummary,
        showTaskProgress, taskProgressPanel, mountContextControls, mountRunCopies,
      });
      return;
    }
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
    const actionRoute = /^([a-f0-9-]{36})\/(github|patch)\/([a-z0-9][a-z0-9_-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.exec(arg || '');
    const projectId = actionRoute?.[1] || arg;
    const project = projects.find((item) => item.id === projectId || (suggestedWorkspace && item.workspace === suggestedWorkspace)) ||
      (!arg ? projects[0] : null);
    projectsEl.innerHTML = !teamMode && projects.length ?
      '<div class="row coding-project-links" aria-label="Coding projects">' + projects.map((item) =>
        '<a href="' + projectHref(item.id) + '" data-project-link' + (item.id === project?.id ? ' aria-current="page"' : '') +
        '>' + esc(item.title) + '</a>').join('') + '</div>' : '';
    if (!teamMode) {
      projectsEl.insertAdjacentHTML('beforeend', '<div class="row coding-project-links"><a href="#coding/standalone">Standalone sessions</a></div>');
      register(projectsEl, models, suggestedWorkspace, readonly);
      teamSettings(projectsEl, readonly, isDetached);
    }
    if (!project) return;
    const intro = document.createElement('header');
    intro.className = 'coding-project-header stack';
    intro.innerHTML = '<h3>' + esc(project.title) + '</h3>' + (project.workspace
      ? '<p><code>' + esc(project.workspace) + '</code></p>' : '') +
      '<p class="muted">Permitted scope · ' + esc(project.scopes.join(', ')) + '</p>' +
      '<p class="muted">' + (project.workerIsolation === 'docker' ? 'Docker worker · Only this session is mounted' : 'Local worker · Server OS account') + '</p>';
    page.append(intro);
    const grid = document.createElement('div');
    grid.className = 'coding-workspace-grid';
    page.append(grid);
    const left = document.createElement('div');
    left.className = 'stack coding-left';
    const right = document.createElement('div');
    right.className = 'stack coding-right';
    grid.append(left, right);
    let openPatch;
    let composerPanel;
    const runs = activity(right, project, readonly, isDetached, teamMode ? undefined : (row) => openPatch(row), teamMode || readonly ? undefined : {
      clearConsent: (session) => clearComposerConsent(session),
      markCompactionPending: (session, pending) => composerPanel.setCompactionPending(session, pending),
    });
    window.okbCodingEvaluation.mount(right, { prefix: projectUrl(project.id), coding, readonly, detached: isDetached });
    const clearComposerConsent = composer(left, project, readonly, isDetached, runs.selectRun, !teamMode && !readonly);
    composerPanel = left.querySelector('.coding-composer');
    if (!teamMode) settings(left, project, readonly, composerPanel.updateProject, runs.refresh);
    const github = document.createElement('div');
    github.dataset.codingGithub = '';
    left.append(github);
    const target = actionRoute ? { session: actionRoute[3], id: actionRoute[4] } : undefined;
    window.okbGitHub?.mount(github, { project, coding, readonly, target: actionRoute?.[2] === 'github' ? target : undefined });
    if (!teamMode) {
      openPatch = patchReview(left, project, readonly, isDetached);
      if (actionRoute?.[2] === 'patch') void openPatch(target);
    }
  }

  window.okbCoding = { mount };

  const entrance = document.querySelector('#team-entrance');
  if (entrance) {
    const editorOrigin = entrance.querySelector('[data-team-editor-origin]');
    if (editorOrigin && window.location.protocol === 'https:') {
      const address = document.createElement('code');
      address.textContent = window.location.origin;
      editorOrigin.replaceChildren('Enter ', address, ' and your project token in the editor.');
    }
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
