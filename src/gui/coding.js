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
    if (!res.ok) throw Object.assign(new Error(payload.error || 'The coding request failed.'), { status: res.status });
    return payload.result;
  }

  const projectUrl = (id) => '/projects/' + encodeURIComponent(id);
  const projectHref = (id) => '#coding/' + encodeURIComponent(id);
  const runSessionName = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
  const runRequestId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
  const entries = (text) => text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  const statuses = {
    running: 'Running', interrupted: 'Interrupted', done: 'Ready for review', unanswered: 'Unanswered',
    failed: 'Could not start', cancelled: 'Cancelled', accepted: 'Accepted', changes_requested: 'Changes requested',
  };
  const taskLabels = {
    model: 'Model response', 'source-lookup': 'Approved source lookup', 'package-review': 'Package review',
    'package-work': 'Package work', orchestration: 'Orchestration', 'work-order': 'Work orders', context: 'Context maintenance', work: 'Run work',
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
  const alternativeSessionName = /^alt-[a-f0-9]{60}$/u;
  const branchVersionId = /^[a-f0-9]{64}$/u;
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

  function sourceLookupSummary(request) {
    if (!request?.approvedSourceLookup) return '';
    const lookup = request.sourceLookup;
    if (!Array.isArray(lookup?.served)) return '<p class="muted">Approved source lookup enabled.</p>';
    const ranges = lookup.served.map(({ path, startLine, endLine }) => '<li><code>' +
      esc(path + ':' + startLine + (endLine === startLine ? '' : '–' + endLine)) + '</code></li>').join('');
    const counts = [lookup.served.length + ' served', lookup.refused + ' refused', lookup.incomplete + ' incomplete'];
    if (lookup.truncated) counts.push('Receipt limit reached');
    return '<details data-source-lookup-receipt><summary>Approved source lookups</summary><p>' + esc(counts.join(' · ')) + '</p>' +
      (ranges ? '<ul class="plain">' + ranges + '</ul>' : '') + '</details>';
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

  function checkoutRepository(url) {
    if (typeof url !== 'string') return;
    const match = /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100}?)(?:\.git)?\/?$/iu.exec(url);
    if (!match || match[2] === '.' || match[2] === '..') return;
    return (match[1] + '/' + match[2]).toLowerCase();
  }

  function renderCheckoutFields(panel, fields) {
    panel.innerHTML = fields.map(([label, value]) => '<div><dt class="muted">' + label +
      '</dt><dd><code>' + esc(value) + '</code></dd></div>').join('');
    panel.hidden = false;
  }

  function validCheckoutWorkspace(result) {
    return typeof result?.workspace === 'string' && /^(?:\/(?!\/)|[a-z]:[/\\])/iu.test(result.workspace) &&
      !/[\x00-\x1f\x7f]/u.test(result.workspace) && typeof result.reused === 'boolean';
  }

  function checkoutRegistration(registration, detached) {
    const brain = document.querySelector('#brain')?.value;
    const current = () => registration.isConnected && !detached() && document.querySelector('#brain')?.value === brain;
    const { workspace, title } = registration.elements;
    let workspaceEdits = 0;
    workspace.addEventListener('input', () => { workspaceEdits++; });
    function preparePrefill() {
      const editsAtApproval = workspaceEdits;
      const workspaceAtApproval = workspace.value;
      return (path, titleSuggestion) => {
        if (!current() || workspaceEdits !== editsAtApproval || workspace.value !== workspaceAtApproval) return false;
        workspace.value = path;
        workspaceEdits++;
        if (!title.value.trim()) title.value = titleSuggestion;
        return true;
      };
    }
    return { current, preparePrefill };
  }

  function checkoutFeedback(feedback, status, prefilled) {
    report(feedback, undefined, status + (prefilled ? ' Choose your project scope and model, then add the project.' :
      ' Your workspace field has changed. The prepared path is shown below.'));
  }

  function mountGitHubCheckout(registration, { current, preparePrefill }) {
    const panel = document.createElement('details');
    panel.dataset.githubCheckout = '';
    panel.innerHTML = '<summary>Prepare GitHub checkout</summary><form class="stack coding-form">' +
      '<p class="muted">Create a shallow checkout of one branch in private app data. Preparing the same repository and branch again can reopen the existing local copy.</p>' +
      field('GitHub repository URL', '', 'url', 'name="url" maxlength="2048" required spellcheck="false" placeholder="https://github.com/owner/repository"') +
      field('GitHub branch', '', 'text', 'name="branch" maxlength="255" required spellcheck="false" placeholder="main"') +
      field('GitHub login (optional)', '', 'text', 'name="login" maxlength="39" autocomplete="off" spellcheck="false"') +
      field('Contents-read token (optional)', '', 'password', 'name="token" maxlength="280" autocomplete="off"') +
      '<p class="muted">For a private repository, enter your GitHub login and a short-lived fine-grained token for this repository with Contents read access. The checkout uses it once.</p>' +
      '<label class="row"><input type="checkbox" name="approved"><span>Prepare a shallow checkout in private app data</span></label>' +
      '<div class="row"><button type="submit" disabled>Prepare checkout</button></div>' +
      '<div class="coding-feedback" role="status"></div><dl class="coding-grid coding-deployment-summary" hidden></dl></form>';
    registration.before(panel);
    const form = panel.querySelector('form');
    const { url, branch, login, token, approved } = form.elements;
    const submit = form.querySelector('button');
    const feedback = form.querySelector('[role="status"]');
    const receipt = form.querySelector('dl');
    let busy = false;

    function update() {
      for (const field of [url, branch, login, token, approved]) field.disabled = busy;
      submit.disabled = busy || !approved.checked;
    }

    for (const field of [url, branch, login, token]) field.addEventListener('input', () => {
      approved.checked = false;
      update();
    });
    approved.addEventListener('change', update);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy || !approved.checked || !current()) return;
      const endpoint = url.value.trim();
      const repository = checkoutRepository(endpoint);
      const selectedBranch = branch.value.trim();
      const username = login.value.trim();
      const credential = token.value.trim();
      if (!repository || !selectedBranch) {
        report(feedback, new Error('Enter a GitHub.com HTTPS repository URL and the exact branch name.'));
        return;
      }
      if (!!username !== !!credential) {
        report(feedback, new Error('Enter both a GitHub login and a token for a private repository.'));
        return;
      }

      const prefill = preparePrefill();
      login.value = token.value = '';
      approved.checked = false;
      busy = true;
      update();
      receipt.hidden = true;
      receipt.replaceChildren();
      report(feedback, undefined, 'Preparing GitHub checkout…');
      try {
        const result = await coding('/github-checkouts', { url: endpoint, branch: selectedBranch, approved: true,
          ...(credential ? { login: username, token: credential } : {}) });
        if (!current()) return;
        if (!validCheckoutWorkspace(result) || typeof result.repository !== 'string' || result.repository.toLowerCase() !== repository ||
            checkoutRepository(result.origin) !== repository || result.branch !== selectedBranch || typeof result.commit !== 'string' ||
            !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(result.commit))
          throw new Error('The checkout receipt did not match the approved repository and branch.');
        const prefilled = prefill(result.workspace, result.repository.split('/')[1]);
        renderCheckoutFields(receipt, [['Repository', result.origin], ['Branch', result.branch], ['Imported commit', result.commit],
          ['Local workspace', result.workspace]]);
        const status = result.reused ? 'Existing checkout reopened.' : 'GitHub checkout prepared.';
        checkoutFeedback(feedback, status, prefilled);
      } catch (error) {
        if (current()) report(feedback, error);
      } finally {
        busy = false;
        if (current()) update();
      }
    });
  }

  function mountBenchmarkCheckout(registration, { current, preparePrefill }) {
    const panel = document.createElement('details');
    panel.dataset.benchmarkCheckout = '';
    panel.innerHTML = '<summary>Prepare Vite benchmark checkout</summary><form class="stack coding-form">' +
      '<p class="muted">Prepare the pinned benchmark revision in private app data. You can reopen a clean checkout for that revision.</p>' +
      '<dl class="coding-grid coding-deployment-summary" data-benchmark-descriptor hidden></dl>' +
      '<label class="row"><input type="checkbox" name="approved" disabled><span>Use this exact benchmark revision</span></label>' +
      '<div class="row"><button type="submit" disabled>Prepare benchmark checkout</button></div>' +
      '<div class="coding-feedback" role="status"></div><dl class="coding-grid coding-deployment-summary" data-benchmark-receipt hidden></dl></form>';
    registration.before(panel);
    const form = panel.querySelector('form');
    const approved = form.elements.approved;
    const submit = form.querySelector('button');
    const feedback = form.querySelector('[role="status"]');
    const details = form.querySelector('[data-benchmark-descriptor]');
    const receipt = form.querySelector('[data-benchmark-receipt]');
    const path = '/benchmark-checkout';
    let descriptor;
    let revision = 0;
    let busy = false;

    function update() {
      approved.disabled = busy || !descriptor;
      submit.disabled = approved.disabled || !approved.checked;
    }

    panel.addEventListener('toggle', async () => {
      const attempt = ++revision;
      approved.checked = false;
      update();
      if (!panel.open || busy || !current()) return;
      const active = () => attempt === revision && panel.open && current();
      descriptor = undefined;
      details.hidden = true;
      receipt.hidden = true;
      update();
      report(feedback, undefined, 'Reading the pinned benchmark revision…');
      try {
        const result = await coding(path);
        if (!active()) return;
        if (result?.origin !== 'https://github.com/vitejs/vite.git' || result.repository !== 'vitejs/vite' ||
            typeof result.tag !== 'string' || !result.tag.trim() || typeof result.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(result.commit))
          throw new Error('Could not verify the pinned Vite benchmark revision.');
        descriptor = result;
        renderCheckoutFields(details, [['Repository', result.origin], ['Tag', result.tag], ['Pinned commit', result.commit]]);
        report(feedback);
      } catch (error) { if (active()) report(feedback, error); }
      finally { if (active()) update(); }
    });

    approved.addEventListener('change', update);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy || !descriptor || !approved.checked || !current() || !panel.open) return;
      const { origin, repository, tag, commit } = descriptor;
      const prefill = preparePrefill();
      approved.checked = false;
      busy = true;
      update();
      receipt.hidden = true;
      report(feedback, undefined, 'Preparing the pinned Vite benchmark checkout…');
      try {
        const result = await coding(path, { approved: true, commit });
        if (!current()) return;
        if (!validCheckoutWorkspace(result) || result.origin !== origin || result.repository !== repository ||
            result.tag !== tag || result.commit !== commit)
          throw new Error('The checkout receipt did not match the approved Vite benchmark revision.');
        const prefilled = prefill(result.workspace, 'Vite benchmark');
        renderCheckoutFields(receipt, [['Local workspace', result.workspace]]);
        checkoutFeedback(feedback, result.reused ? 'Existing benchmark checkout reopened.' : 'Vite benchmark checkout prepared.', prefilled);
      } catch (error) { if (current()) report(feedback, error); }
      finally { busy = false; if (current()) update(); }
    });
  }

  function register(parent, models, suggestedWorkspace, readonly, detached) {
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
    if (!readonly) {
      const checkout = checkoutRegistration(form, detached);
      mountGitHubCheckout(form, checkout);
      mountBenchmarkCheckout(form, checkout);
    }
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

  function listBlock(title, lines) {
    const block = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = title;
    const list = document.createElement('ul');
    list.className = 'coding-map';
    for (const line of lines) {
      const item = document.createElement('li');
      item.textContent = line;
      list.append(item);
    }
    block.append(summary, list);
    return block;
  }

  function routeLabel(route) {
    const name = (model) => model.provider + '/' + model.model;
    const chosen = name(route.choice);
    return chosen + (chosen === name(route.baseline) ? '' : ' (first choice ' + name(route.baseline) + ')') +
      (route.fallbacks.length ? ', then ' + route.fallbacks.map(name).join(', ') + ' if its provider fails' : '');
  }

  function planContents(el, plan) {
    const summary = document.createElement('p');
    summary.textContent = (plan.mode === 'fan-out' ? plan.orders.length + ' workers. ' : 'One worker. ') + plan.reason + ' About ' +
      plan.estimatedTokens.toLocaleString() + ' estimated input tokens across all planned calls.';
    const pieces = [summary];
    for (const warning of plan.warnings || []) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.setAttribute('role', 'note');
      note.textContent = warning;
      pieces.push(note);
    }
    for (const order of plan.orders) {
      const section = document.createElement('section');
      section.className = 'stack';
      section.dataset.workOrder = order.id;
      const title = document.createElement('h4');
      title.textContent = order.scope === '.' ? 'Whole selection' : order.scope;
      const model = document.createElement('p');
      model.className = 'muted';
      model.textContent = 'Model: ' + routeLabel(order.route) + '. ' + order.route.reason;
      const items = document.createElement('div');
      items.className = 'stack';
      previewContents(items, order);
      section.append(title, model, items);
      if (order.interfaces.length) section.append(listBlock('Links to other work orders', order.interfaces));
      pieces.push(section);
    }
    if (plan.synthesis) {
      const combine = document.createElement('p');
      combine.className = 'muted';
      combine.textContent = 'The reports are combined by ' + routeLabel(plan.synthesis.route) + '.';
      pieces.push(combine);
    }
    el.replaceChildren(...pieces);
  }

  function previewContents(el, preview) {
    if (preview.plan) return planContents(el, preview.plan);
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
    // What a repository map selection adds beside the excerpts. All of it is sent with the request.
    if (preview.map?.length) pieces.push(listBlock('Map sent with the excerpts', preview.map));
    const facts = preview.facts || preview.skills?.map((skill) => skill.text + (skill.trial ? ' (on trial)' : ''));
    if (facts?.length) pieces.push(listBlock('Facts from the repository map', facts));
    for (const part of preview.deferred || [])
      pieces.push(disclosure('On request · ' + part.path + ':' + part.startLine + '–' + part.endLine, part.content, 'Sent only if the model looks it up'));
    const stale = manifest?.atlas?.staleFiles;
    if (stale) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = stale + ' selected files changed since the repository was imported. These excerpts are their current text. Import again to refresh the map.';
      pieces.push(note);
    }
    el.replaceChildren(...pieces);
  }

  /** Offer the manifest of a preview that has source: the selection and its digests, without the selected text. */
  function mountSourceManifest(el, preview, feedback) {
    const manifest = preview?.sourceManifest;
    const id = preview?.manifest?.id || preview?.id;
    const selected = Array.isArray(preview?.packages)
      ? preview.packages.length > 0 && preview.packages.every((part) => part.excerpts?.length)
      : (preview?.excerpts || preview?.files || []).length > 0;
    if (!selected || manifest?.version !== 1 || manifest.source !== preview.source || typeof id !== 'string' || manifest.id !== id) return;
    const row = document.createElement('div');
    row.className = 'row';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Copy source manifest';
    row.append(button);
    const fallback = document.createElement('label');
    fallback.className = 'field';
    fallback.hidden = true;
    fallback.dataset.sourceManifestFallback = '';
    fallback.innerHTML = '<span>Source manifest JSON</span><textarea rows="8" readonly spellcheck="false"></textarea>';
    const jsonField = fallback.querySelector('textarea');
    const json = JSON.stringify(manifest, null, 2);
    let attempt = 0;
    // Copying reads the preview already on screen. It sends nothing and keeps the approval as it is.
    button.addEventListener('click', async () => {
      const current = ++attempt;
      try {
        await navigator.clipboard.writeText(json);
        if (!button.isConnected || current !== attempt) return;
        fallback.hidden = true;
        jsonField.value = '';
        report(feedback, undefined, 'Source manifest copied.');
      } catch {
        if (!button.isConnected || current !== attempt) return;
        jsonField.value = json;
        fallback.hidden = false;
        jsonField.focus();
        jsonField.select();
        report(feedback, undefined, 'Copy the selected JSON using your browser or system Copy command.');
      }
    });
    el.append(row, fallback);
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

  function composer(parent, project, readonly, detached, selectRun, ownerWritable) {
    const prefix = projectUrl(project.id);
    const panel = document.createElement('section');
    panel.className = 'coding-panel coding-composer stack';
    panel.innerHTML =
      '<h3>New request</h3><form class="stack">' +
      '<label class="field"><span>Task</span><textarea name="prompt" rows="4" required placeholder="Describe the change or review you want"></textarea></label>' +
      '<div class="coding-grid">' + field('Session', 'main', 'text', 'name="session" required pattern="[a-z0-9][a-z0-9_\\-]{0,63}"') +
      field('Request ID', crypto.randomUUID(), 'text', 'name="requestId" required maxlength="128" spellcheck="false"') + '</div>' +
      '<label class="field"><span id="coding-source-label">Source</span><select name="source" aria-labelledby="coding-source-label"><option value="repository">Tracked repository excerpts</option>' +
      '<option value="atlas">Repository map</option><option value="files">Explicit files</option><option value="packages">Independent package review</option>' +
      '<option value="orchestrated">Orchestrated plan</option></select></label>' +
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
      '<div class="stack" data-atlas hidden><p class="muted" data-atlas-hint>The repository map selects source for the task from an import of this project. Import it under Project settings → Repository map.</p>' +
      '<div data-atlas-query>' + field('Search source (optional)', '', 'search', 'name="mapQuery" maxlength="2048" placeholder="Defaults to the task"') + '</div>' +
      '<div class="coding-grid">' + field('Directories', project.scopes.join(', '), 'text', 'name="mapProjects" spellcheck="false"') +
      field('Estimated tokens', '4096', 'number', 'name="mapBudget" min="1" max="16384"') + '</div>' +
      '<label class="field" data-atlas-workers><span>Workers</span><select name="mapWorkers"><option value="auto">Decide from the task</option><option value="1">1</option>' +
      '<option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>' +
      '<label class="row" data-atlas-deferred><input type="checkbox" name="mapDeferred"><span>Also approve further excerpts the model may look up by path and line</span></label></div>' +
      '<label class="row" data-source-lookup><input type="checkbox" name="approvedSourceLookup"><span>Let the model look up line numbers within this request’s approved source</span></label>' +
      '<div class="row"><button type="button" data-preview>Preview source</button></div>' +
      '<div class="coding-preview stack" aria-live="polite" data-preview-content></div>' +
      '<div data-evaluation-options></div>' +
      '<label class="row" data-approve hidden><input type="checkbox" name="approved"><span data-approve-text></span></label>' +
      '<div class="row"><button type="submit" class="primary" disabled>Send request</button><span class="muted">' + esc(project.model) +
      '</span></div><p class="muted" data-send-compaction-notice hidden>Finish local compaction in Run history before sending in this session.</p>' +
      '<p class="muted" data-branch-notice hidden></p>' +
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
    const branchNotice = form.querySelector('[data-branch-notice]');
    const packageFields = Array.from(form.querySelectorAll('[data-package]'));
    const feedback = form.querySelector('[data-composer-feedback]');
    const evaluation = window.okbCodingEvaluation.composerOptions(form.querySelector('[data-evaluation-options]'), {
      readonly, coding, prefix, detached, invalidate: clearPreview,
      loadPinnedCase: (study, task, strategy) => panel.loadEvaluationCase(
        { prompt: task.prompt, series: study.series, task: task.id, evidence: task.evidence }, { study, task, strategy }),
    });
    let preview = null;
    let revision = 0;
    let busy = false;
    let evaluationPrompt;
    const pendingCompactions = new Set();
    const draftPrompt = () => evaluationPrompt?.displayed === prompt.value ? evaluationPrompt.saved : prompt.value;
    const onBranch = () => alternativeSessionName.test(session.value.trim());
    const enrollment = form.querySelector('[data-enroll]');

    function updateSend() {
      const pending = pendingCompactions.has(session.value.trim());
      compactionNotice.hidden = !pending;
      send.disabled = readonly || busy || project.credential === 'missing' || !preview || !approved.checked || pending || (onBranch() && !ownerWritable);
    }

    function clearPreview() {
      revision++;
      preview = null;
      previewEl.replaceChildren();
      approved.checked = false;
      approve.hidden = true;
      previewButton.disabled = onBranch() && !ownerWritable;
      if (feedback.textContent === 'Reading selected source…') report(feedback);
      updateSend();
    }

    function sourceInput() {
      if (source.value === 'atlas' || source.value === 'orchestrated') {
        const { mapQuery, mapProjects, mapBudget, mapWorkers, mapDeferred } = form.elements;
        const data = { source: source.value, projects: entries(mapProjects.value) };
        if (mapBudget.value) data.tokenBudget = Number(mapBudget.value);
        if (source.value === 'atlas') {
          if (mapQuery.value.trim()) data.query = mapQuery.value.trim();
          if (mapDeferred.checked) data.deferred = true;
        } else data.workers = mapWorkers.value === 'auto' ? 'auto' : Number(mapWorkers.value);
        return data;
      }
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
      prefix, manage: ownerWritable, detached, inRepository: () => source.value === 'repository',
      readDraft: (name) => {
        const selection = sourceInput();
        if (!prompt.value.trim() || !selection.query.trim()) throw new Error('Enter a task and source query to save a preset.');
        return { prompt: prompt.value, query: selection.query, profile: selection.profile !== undefined ? selection.profile : {
          version: 1, name, projects: selection.projects,
          ...(selection.tokenBudget === undefined ? {} : { tokenBudget: selection.tokenBudget }),
        } };
      },
      loadDraft: (preset) => {
        evaluationPrompt = undefined;
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

    prompt.addEventListener('input', () => { evaluationPrompt = undefined; });
    for (const input of [source, projects, tokenBudget, profile, files, requestId, prompt, approvedSourceLookup,
      form.elements.query, ...form.querySelectorAll('[data-package] input'), ...form.querySelectorAll('[data-atlas] input, [data-atlas] select')])
      input.addEventListener('input', clearPreview);
    function updateSourceFields() {
      const mapped = source.value === 'atlas' || source.value === 'orchestrated';
      form.querySelector('[data-repository]').hidden = source.value !== 'repository';
      form.querySelector('[data-files]').hidden = source.value !== 'files';
      form.querySelector('[data-packages]').hidden = source.value !== 'packages';
      form.querySelector('[data-atlas]').hidden = !mapped;
      form.querySelector('[data-atlas-query]').hidden = source.value !== 'atlas';
      form.querySelector('[data-atlas-deferred]').hidden = source.value !== 'atlas';
      form.querySelector('[data-atlas-workers]').hidden = source.value !== 'orchestrated';
      // The map has its own lookup choice, and the other two modes send each part once.
      form.querySelector('[data-source-lookup]').hidden = source.value === 'packages' || mapped;
      if (source.value === 'packages' || mapped) approvedSourceLookup.checked = false;
      previewButton.textContent = source.value === 'orchestrated' ? 'Preview plan' : 'Preview source';
    }
    source.addEventListener('change', updateSourceFields);
    function updateBranchMode() {
      const branch = onBranch();
      if (branch) evaluationPrompt = undefined;
      branchNotice.hidden = !branch;
      branchNotice.textContent = ownerWritable
        ? 'Review the branch’s current context with your new source before sending.'
        : 'The project owner continues alternative review sessions from the local app.';
      for (const mode of ['packages', 'atlas', 'orchestrated']) source.querySelector('option[value="' + mode + '"]').disabled = branch;
      if (branch && ['packages', 'atlas', 'orchestrated'].includes(source.value)) {
        source.value = 'files';
        files.value = '';
        updateSourceFields();
      }
      enrollment.disabled = readonly || branch;
      if (branch && enrollment.checked) {
        enrollment.checked = false;
        enrollment.dispatchEvent(new Event('change'));
      }
      clearPreview();
    }
    session.addEventListener('input', updateBranchMode);
    approved.addEventListener('change', updateSend);

    previewButton.addEventListener('click', async () => {
      if (previewButton.disabled) return;
      clearPreview();
      const current = revision;
      const isCurrent = () => current === revision && !detached();
      previewButton.disabled = true;
      report(feedback);
      feedback.textContent = 'Reading selected source…';
      try {
        const selection = sourceInput();
        const branchSession = onBranch() ? session.value.trim() : undefined;
        const lookup = approvedSourceLookup.checked;
        if (lookup && selection.source === 'files' && !selection.files.length)
          throw new Error('Choose at least one file to allow approved source lookup.');
        const evaluationCase = evaluation.value();
        const pinned = evaluationCase?.series.startsWith('pinned-vite-');
        const mapped = selection.source === 'atlas' || selection.source === 'orchestrated';
        const result = await coding(prefix + '/preview', {
          ...selection, ...(mapped ? { prompt: draftPrompt() } : {}),
          ...(branchSession ? { session: branchSession } : {}), ...(evaluationCase ? { measurePreview: true } : {}),
          ...(pinned ? { evaluation: evaluationCase, prompt: draftPrompt(), ...(lookup ? { approvedSourceLookup: true } : {}) } : {}),
        });
        if (!isCurrent()) return;
        const branchContext = branchSession ? result.branchContext : undefined;
        if (branchSession && (!validBranchHistory(branchContext) || !branchVersionId.test(branchContext.id))) {
          throw new Error('Could not review this branch’s current context. Preview source again.');
        }
        previewContents(previewEl, result);
        mountSourceManifest(previewEl, result, feedback);
        if (branchContext) previewEl.append(branchHistory(branchContext, 'Context already in this branch'));
        if ((result.source === 'repository' || result.source === 'atlas') && !result.excerpts.length) return;
        if (result.source === 'packages' && result.packages.some((part) => !part.excerpts.length)) return;
        preview = { selection, lookup, id: result.manifest?.id || result.id, branchContextId: branchContext?.id };
        const provider = project.providerLabel;
        approveText.textContent = result.source === 'packages'
          ? 'Approve sending the shared task and each package’s selected text to ' + provider + '.'
          : result.source === 'orchestrated'
            ? 'Approve sending the task and each work order’s selected text to ' + provider + ', using the models shown.'
            : result.source === 'atlas'
              ? 'Approve sending the task, the selected text, the map and facts shown, and active session history to ' + provider + '.' +
                (result.deferred?.length ? ' The excerpts marked “on request” are sent only if the model looks them up.' : '')
              : 'Approve sending the task, selected text, and ' + (branchContext ? 'reviewed branch context' : 'active session history') + ' to ' + provider + '.';
        if (lookup) approveText.textContent += ' Allow lookups within this request’s selected text.';
        approve.hidden = false;
        approved.focus();
      } catch (error) {
        if (isCurrent()) report(feedback, error);
      } finally {
        if (isCurrent()) {
          previewButton.disabled = false;
          if (feedback.textContent === 'Reading selected source…') report(feedback);
        }
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
          ...preview.selection, approved: true, previewId: preview.id,
          prompt: draftPrompt(),
          session: session.value, requestId: requestId.value, evaluation: evaluation.value(),
          ...(preview.branchContextId ? { branchContextId: preview.branchContextId } : {}),
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
    panel.canLoadEvaluationCase = () => !readonly && panel.isConnected && !detached();
    panel.loadEvaluationCase = (saved, recipe) => {
      if (busy || !panel.canLoadEvaluationCase()) return false;
      session.value = 'eval-' + crypto.randomUUID();
      updateBranchMode();
      if (recipe) {
        const { study, task, strategy } = recipe;
        source.value = strategy === 'files' ? 'files' : 'repository';
        files.value = strategy === 'files' ? task.files.join(', ') : '';
        form.elements.query.value = strategy === 'files' ? '' : task.query;
        const roots = strategy === 'lexical' ? [...new Set([...task.projects, ...task.sharedProjects])] : task.projects;
        projects.value = roots.join(', ');
        tokenBudget.value = study.tokenBudget;
        profile.value = strategy === 'indexed' ? JSON.stringify({
          version: 1, name: 'Vite benchmark', projects: task.projects, sharedProjects: task.sharedProjects, tokenBudget: study.tokenBudget,
        }, null, 2) : '';
        updateSourceFields();
      }
      evaluation.load(saved);
      prompt.value = saved.prompt;
      // Textareas normalize line endings. Keep the saved prompt exact until the user edits it.
      evaluationPrompt = { saved: saved.prompt, displayed: prompt.value };
      requestId.value = crypto.randomUUID();
      approvedSourceLookup.checked = false;
      clearPreview();
      report(feedback, undefined, recipe ? 'Pinned evaluation case loaded. Preview source before sending.'
        : 'Evaluation case loaded. Preview source again before sending.');
      prompt.focus();
      return true;
    };
    panel.useBranchSession = (name) => {
      if (busy || !ownerWritable || detached() || !alternativeSessionName.test(name)) return false;
      session.value = name;
      requestId.value = crypto.randomUUID();
      approvedSourceLookup.checked = false;
      updateBranchMode();
      report(feedback, undefined, 'Alternative review branch selected. Preview source before sending.');
      prompt.focus();
      return true;
    };
    panel.loadReviewFollowUp = (name, note) => {
      if (busy || readonly || detached() || (alternativeSessionName.test(name) && !ownerWritable)) return false;
      const hasDraft = preview || prompt.value.trim() || enrollment.checked || approvedSourceLookup.checked ||
        session.value !== session.defaultValue || requestId.value !== requestId.defaultValue;
      if (hasDraft && !confirm('Replace the current task and use this review note in session ' + name + '?')) return;
      session.value = name;
      requestId.value = crypto.randomUUID();
      evaluationPrompt = undefined;
      prompt.value = note;
      approvedSourceLookup.checked = false;
      if (enrollment.checked) {
        enrollment.checked = false;
        enrollment.dispatchEvent(new Event('change'));
      }
      updateBranchMode();
      report(feedback, undefined, 'Review note loaded. Preview source before sending.');
      prompt.focus();
      return true;
    };
    panel.loadGitHubIssue = (issue) => {
      if (busy || readonly || detached() || !panel.isConnected) return false;
      const task = ['GitHub issue #' + issue.number + ' · ' + issue.title, issue.url, issue.body].filter(Boolean).join('\n\n');
      if (new TextEncoder().encode(task).length > 16384) throw new Error('The issue text exceeds the task limit. Open the issue on GitHub to copy a shorter excerpt.');
      const hasDraft = preview || [...form.querySelectorAll('input, textarea')].some((input) => input.type === 'checkbox'
        ? input.checked !== input.defaultChecked : input.value !== input.defaultValue) || source.value !== 'repository';
      if (hasDraft && !confirm('Replace the current task and source selection with a new draft for issue #' + issue.number + '?')) return;
      form.reset();
      evaluationPrompt = undefined;
      session.value = 'issue-' + issue.number + '-' + crypto.randomUUID();
      requestId.value = crypto.randomUUID();
      prompt.value = task;
      form.elements.query.value = issue.title;
      updateSourceFields();
      enrollment.dispatchEvent(new Event('change'));
      updateBranchMode();
      report(feedback, undefined, 'Issue #' + issue.number + ' loaded. Preview source before sending.');
      prompt.focus();
      return true;
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

  function validBranchHistory(context) {
    return Number.isSafeInteger(context?.inheritedEntries) && context.inheritedEntries >= 0 &&
      Number.isSafeInteger(context.estimatedTokens) && context.estimatedTokens >= 0 && typeof context.providerContinuity === 'boolean' &&
      Array.isArray(context.history) && context.history.every((entry) =>
        typeof entry?.role === 'string' && typeof entry.text === 'string');
  }

  function branchHistory(context, label) {
    const section = document.createElement('section');
    section.className = 'stack';
    section.innerHTML = '<h4></h4><p class="muted"></p><p class="muted" data-provider-continuity hidden>' +
      'Provider-managed reasoning or signatures will accompany the visible history.</p>' +
      '<div class="stack coding-branch-history" role="region" tabindex="0"></div>';
    section.querySelector('h4').textContent = label;
    section.querySelector('p').textContent = context.inheritedEntries.toLocaleString() +
      (context.inheritedEntries === 1 ? ' saved entry' : ' saved entries') + ' · ' + context.estimatedTokens.toLocaleString() + ' estimated context tokens';
    section.querySelector('[data-provider-continuity]').hidden = context.providerContinuity !== true;
    const history = section.querySelector('.coding-branch-history');
    history.setAttribute('aria-label', label);
    for (const entry of context.history) {
      const role = document.createElement('p');
      role.className = 'muted';
      role.textContent = entry.role;
      const text = document.createElement('pre');
      text.textContent = entry.text;
      history.append(role, text);
    }
    return section;
  }

  function matchingBranchReceipt(result, { session, requestId, branchSession }) {
    return result?.created === true && result.session === session && result.requestId === requestId && result.branchSession === branchSession;
  }

  function mountSavedBranches(panel, { prefix, detached, useBranch }) {
    panel.innerHTML = '<summary>Alternative review branches</summary><div class="stack coding-form">' +
      '<p class="muted">Continue these sessions from the local owner app. Team members can inspect and review their runs.</p>' +
      '<ul class="stack plain"></ul><div class="coding-feedback" role="status"></div></div>';
    const list = panel.querySelector('ul');
    const feedback = panel.querySelector('[role="status"]');
    let revision = 0;
    async function refresh() {
      if (!panel.open || detached()) return;
      const current = ++revision;
      report(feedback, undefined, 'Loading alternative sessions…');
      try {
        const rows = await coding(prefix + '/branches');
        if (detached() || current !== revision) return;
        list.replaceChildren();
        for (const row of rows) {
          if (!alternativeSessionName.test(row.branchSession) || (row.status !== 'ready' && row.status !== 'pending')) continue;
          const item = document.createElement('li');
          item.className = 'stack';
          item.innerHTML = '<strong></strong><p class="muted"></p><div class="row"><button type="button">Use branch session</button></div>';
          item.querySelector('strong').textContent = row.branchSession;
          item.querySelector('p').textContent = 'From ' + row.session + ' · ' + row.requestId + (row.createdAt ? ' · ' + time(row.createdAt) : '');
          const button = item.querySelector('button');
          button.textContent = row.status === 'pending' ? 'Finish creating branch' : 'Use branch session';
          button.disabled = row.status === 'pending' && !branchVersionId.test(row.previewId);
          button.dataset.branchAlias = row.branchSession;
          button.addEventListener('click', async () => {
            if (detached() || button.disabled) return;
            if (row.status !== 'pending') {
              if (!useBranch(row.branchSession)) report(feedback, new Error('Wait for the current request to finish sending.'));
              return;
            }
            const { session, requestId, previewId } = row;
            button.disabled = true;
            report(feedback, undefined, 'Finishing alternative branch…');
            try {
              const result = await coding(prefix + '/branches', { session, requestId, previewId });
              if (!matchingBranchReceipt(result, row)) throw new Error('Could not verify the branch receipt. Reopen Alternative review branches.');
              if (detached()) return;
              await refresh();
              list.querySelector('[data-branch-alias="' + row.branchSession + '"]')?.focus();
            } catch (error) { if (!detached() && button.isConnected) report(feedback, error); }
            finally { button.disabled = false; }
          });
          list.append(item);
        }
        report(feedback, undefined, list.childElementCount ? '' : 'No alternative review branches yet.');
      } catch (error) {
        if (!detached() && current === revision) report(feedback, error);
      }
    }
    panel.addEventListener('toggle', refresh);
    return refresh;
  }

  function mountBranchPreview(panel, { prefix, detached, useBranch, refreshBranches }) {
    panel.innerHTML = '<div class="row"><button type="button" data-branch-start>Preview alternative branch</button></div>' +
      '<div class="stack" data-branch-review hidden><p data-branch-scope></p><div data-branch-history></div>' +
      '<label class="row"><input type="checkbox"> Create a separate session with this inherited context</label>' +
      '<div class="row" data-branch-actions><button type="button" data-branch-create disabled>Create alternative branch</button>' +
      '<button type="button" data-branch-cancel>Cancel branch preview</button></div></div>' +
      '<div class="stack" data-branch-created hidden><p></p><div class="row"><button type="button">Use branch session</button></div></div>' +
      '<div class="coding-feedback" role="status"></div>';
    const start = panel.querySelector('[data-branch-start]');
    const review = panel.querySelector('[data-branch-review]');
    const scope = panel.querySelector('[data-branch-scope]');
    const history = panel.querySelector('[data-branch-history]');
    const approval = review.querySelector('input');
    const create = panel.querySelector('[data-branch-create]');
    const cancel = panel.querySelector('[data-branch-cancel]');
    const created = panel.querySelector('[data-branch-created]');
    const use = created.querySelector('button');
    const feedback = panel.querySelector('[role="status"]');
    let target = null;
    let preview = null;
    let receipt = null;
    let revision = 0;
    let busy = false;

    function update() {
      panel.hidden = !target;
      start.parentElement.hidden = Boolean(preview || receipt);
      start.disabled = approval.disabled = cancel.disabled = busy;
      review.hidden = !preview;
      created.hidden = !receipt;
      create.disabled = busy || !preview || !approval.checked;
    }
    function clear() {
      ++revision;
      preview = receipt = null;
      busy = false;
      approval.checked = false;
      history.replaceChildren();
      update();
      report(feedback);
    }
    const current = (attempt) => !detached() && panel.isConnected && attempt === revision;
    start.addEventListener('click', async () => {
      if (!target || busy || detached()) return;
      const expected = target;
      const attempt = ++revision;
      busy = true;
      update();
      report(feedback, undefined, 'Reading inherited context…');
      try {
        const result = await coding(prefix + '/branches-preview', expected);
        if (!current(attempt)) return;
        if (!validBranchHistory(result) || result.session !== expected.session || result.requestId !== expected.requestId ||
            !alternativeSessionName.test(result.branchSession) || !branchVersionId.test(result.previewId) ||
            typeof result.provider !== 'string' || typeof result.model !== 'string') throw new Error('Could not verify the alternative branch preview.');
        preview = result;
        scope.textContent = 'Session ' + result.branchSession + ' branches from ' + result.session + ' · ' + result.requestId +
          ' with ' + result.provider + ' / ' + result.model + '.';
        history.replaceChildren(branchHistory(result, 'Inherited context'));
        report(feedback);
      } catch (error) {
        if (current(attempt)) report(feedback, error);
      } finally {
        if (current(attempt)) {
          busy = false;
          update();
          if (preview) approval.focus();
        }
      }
    });
    approval.addEventListener('change', update);
    cancel.addEventListener('click', () => {
      if (busy) return;
      clear();
      start.focus();
    });
    create.addEventListener('click', async () => {
      if (create.disabled || detached()) return;
      const approved = preview;
      const { session, requestId, branchSession, previewId } = approved;
      const attempt = ++revision;
      busy = true;
      update();
      report(feedback, undefined, 'Creating alternative branch…');
      try {
        const result = await coding(prefix + '/branches', { session, requestId, previewId });
        if (!matchingBranchReceipt(result, approved))
          throw new Error('Could not verify the branch receipt. Check Alternative review branches in Run history.');
        void refreshBranches();
        if (!current(attempt)) return;
        clear();
        receipt = result;
        created.querySelector('p').textContent = (result.replayed === true ? 'Alternative branch ready · ' : 'Alternative branch created · ') + branchSession;
        update();
        use.focus();
      } catch (error) {
        if (!current(attempt)) return;
        clear();
        report(feedback, error);
        start.focus();
      }
    });
    use.addEventListener('click', () => {
      if (!receipt || detached()) return;
      if (!useBranch(receipt.branchSession)) report(feedback, new Error('Wait for the current request to finish sending.'));
    });
    update();
    return (row) => {
      const next = row ? identity(row) : null;
      if (next?.session === target?.session && next?.requestId === target?.requestId) return;
      target = next;
      clear();
    };
  }

  function mountBranchComparison(panel, { project, prefix, detached, selectRun }) {
    panel.innerHTML = '<button type="button" aria-haspopup="dialog">Compare with original</button>' +
      '<dialog class="coding-panel coding-comparison" aria-labelledby="coding-comparison-title" data-branch-comparison>' +
      '<div class="stack"><div class="row"><h3 id="coding-comparison-title">Compare review results</h3>' +
      '<button type="button" class="small right" data-close-comparison>Close</button></div>' +
      '<p class="coding-feedback" role="status"></p><div class="coding-comparison-grid" data-comparison-results></div></div></dialog>';
    const open = panel.querySelector('button');
    const dialog = panel.querySelector('dialog');
    const close = dialog.querySelector('[data-close-comparison]');
    const feedback = dialog.querySelector('[role="status"]');
    const results = dialog.querySelector('[data-comparison-results]');
    let target = null;
    let revision = 0;

    function clear() {
      ++revision;
      results.replaceChildren();
      report(feedback);
    }
    function matches(side, expected) {
      return side?.session === expected.session && side.requestId === expected.requestId && side.status === 'done' &&
        typeof side.answer?.text === 'string' && typeof side.answer.truncated === 'boolean' &&
        side.report?.version === 1 && side.report.projectId === project && side.report.session === side.session &&
        side.report.request?.requestId === side.requestId && side.report.runStatus === side.status;
    }
    function card(kind, side) {
      const article = document.createElement('article');
      article.className = 'stack coding-comparison-side';
      article.dataset.comparisonSide = kind.toLowerCase();
      article.innerHTML = '<h4></h4><p class="muted" data-comparison-run></p><p data-comparison-review></p>' +
        '<h5>Task</h5><pre data-comparison-task></pre><h5>Response</h5><pre data-comparison-answer></pre>' +
        '<p class="muted" data-comparison-truncated hidden>Response excerpt limit reached. Open this run to read the full response.</p>' +
        '<p class="muted" data-comparison-usage></p><h5>Source references</h5><ul class="plain" data-comparison-sources></ul>' +
        '<p class="muted" data-comparison-empty hidden>No saved source references.</p>' +
        '<div class="row"><button type="button" class="small"></button></div>';
      article.querySelector('h4').textContent = kind;
      article.querySelector('[data-comparison-run]').textContent = side.session + ' · ' + side.requestId;
      const review = side.review ? statuses[side.review] || side.review : 'Awaiting review';
      article.querySelector('[data-comparison-review]').textContent = 'Completed · ' + review;
      article.querySelector('[data-comparison-task]').textContent = typeof side.task === 'string' && side.task ? side.task : 'No saved task.';
      article.querySelector('[data-comparison-answer]').textContent = side.answer.text || 'No saved response text.';
      article.querySelector('[data-comparison-truncated]').hidden = !side.answer.truncated;
      article.querySelector('[data-comparison-usage]').textContent = 'Request usage · ' + usageText(side.report.request.usage ?? side.report.receipt?.usage);
      const references = side.report.request.repositoryContext?.files ?? side.report.request.files ?? [];
      const sources = article.querySelector('[data-comparison-sources]');
      for (const ref of references) {
        const item = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = ref.path + (ref.startLine === undefined ? '' : ':' + ref.startLine +
          (ref.endLine === ref.startLine ? '' : '–' + ref.endLine));
        item.append(code);
        sources.append(item);
      }
      sources.hidden = !sources.childElementCount;
      article.querySelector('[data-comparison-empty]').hidden = !!sources.childElementCount;
      const openRun = article.querySelector('button');
      openRun.textContent = 'Open ' + kind.toLowerCase() + ' run';
      openRun.addEventListener('click', () => {
        dialog.close();
        if (!detached()) void selectRun({ session: side.session, id: side.requestId });
      });
      return article;
    }

    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { if (!dialog.open) clear(); });
    open.addEventListener('click', async () => {
      if (!target || detached() || dialog.open) return;
      clear();
      const current = revision;
      const { original, alternative } = target;
      const isCurrent = () => !detached() && panel.isConnected && dialog.open && current === revision;
      report(feedback, undefined, 'Loading saved comparison…');
      dialog.showModal();
      dialog.scrollTop = 0;
      close.focus();
      try {
        const comparison = await coding(prefix + '/branch-comparison-inspect', alternative);
        if (!isCurrent()) return;
        if (!matches(comparison?.original, original) || !matches(comparison.alternative, alternative))
          throw new Error('Could not verify the saved comparison. Close it and select the alternative run again.');
        results.replaceChildren(card('Original', comparison.original), card('Alternative', comparison.alternative));
        report(feedback);
      } catch (error) { if (isCurrent()) report(feedback, error); }
    });
    return (row) => {
      const next = row?.branch && row.status === 'done' && row.admitted
        ? { original: row.branch, alternative: identity(row) } : null;
      if (next?.original.session === target?.original.session && next?.original.requestId === target?.original.requestId &&
          next?.alternative.session === target?.alternative.session && next?.alternative.requestId === target?.alternative.requestId) return;
      target = next;
      clear();
      panel.hidden = !target;
      if (dialog.open) dialog.close();
    };
  }

  function mountRunReview(panel, { prefix, readonly, detached, refresh, loadFollowUp, afterAccepted }) {
    panel.innerHTML = '<details data-review-history hidden><summary>Review history</summary><ol class="coding-review-history"></ol>' +
      '<p class="muted" data-review-capped hidden>Showing the most recent review decisions.</p></details>' +
      '<div class="row" data-review-follow-up hidden><button type="button">Use review note in follow-up</button></div>' +
      '<div class="stack" data-review-draft hidden><label class="field"><span>Review note (optional)</span>' +
      '<textarea rows="3" maxlength="4096" aria-describedby="coding-review-limit"></textarea></label>' +
      '<p class="muted" id="coding-review-limit"></p><div class="row">' +
      '<button type="button" data-review-decision="accepted">Accept result</button>' +
      '<button type="button" data-review-decision="changes_requested">Request changes</button></div></div>' +
      '<div class="coding-feedback" role="status"></div>';
    const historyPanel = panel.querySelector('[data-review-history]');
    const historyList = historyPanel.querySelector('ol');
    const capped = panel.querySelector('[data-review-capped]');
    const draft = panel.querySelector('[data-review-draft]');
    const note = panel.querySelector('textarea');
    const limit = panel.querySelector('#coding-review-limit');
    const decisions = [...panel.querySelectorAll('[data-review-decision]')];
    const followUpRow = panel.querySelector('[data-review-follow-up]');
    const followUp = followUpRow.querySelector('button');
    const feedback = panel.querySelector('[role="status"]');
    const encoder = new TextEncoder();
    const brain = document.querySelector('#brain')?.value;
    const currentView = () => panel.isConnected && !detached() && document.querySelector('#brain')?.value === brain;
    let target = null;
    let history = null;
    let snapshot = '';
    let revision = 0;
    let pending = null;
    let busy = false;
    let needsRefresh = false;

    function latestNote() {
      const latest = history?.entries[0];
      return latest?.id === history?.latestId && latest?.decision === 'changes_requested' && typeof latest.note === 'string' &&
        latest.note.trim() ? latest.note : '';
    }

    function update() {
      const bytes = encoder.encode(note.value).length;
      const invalidText = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ud800-\udfff]/u.test(note.value);
      limit.textContent = invalidText ? 'Use plain text with tabs or line breaks.' : bytes.toLocaleString() + ' of 4,096 UTF-8 bytes';
      const editable = target && history && !readonly;
      draft.hidden = !editable;
      note.disabled = busy;
      for (const button of decisions) button.disabled = !editable || busy || needsRefresh || bytes > 4096 || invalidText;
      followUpRow.hidden = !target?.canFollowUp || !latestNote();
      followUp.disabled = busy || needsRefresh;
    }

    function showHistory() {
      const entries = history?.entries ?? [];
      const shown = JSON.stringify(entries);
      if (shown !== snapshot) {
        snapshot = shown;
        historyList.replaceChildren(...entries.map((entry) => {
          const item = document.createElement('li');
          const summary = document.createElement('p');
          summary.textContent = [statuses[entry.decision], entry.reviewer, time(entry.reviewed)].join(' · ');
          item.append(summary);
          if (entry.note) {
            const text = document.createElement('p');
            text.className = 'coding-review-note';
            text.textContent = entry.note;
            item.append(text);
          }
          return item;
        }));
      }
      if (historyPanel.hidden && entries.length) historyPanel.open = true;
      historyPanel.hidden = !entries.length;
      capped.hidden = history?.hasEarlier !== true;
    }

    note.addEventListener('input', update);
    followUp.addEventListener('click', () => {
      if (!target || followUpRow.hidden || followUp.disabled || !currentView()) return;
      if (loadFollowUp(target.session, latestNote()) === false)
        report(feedback, new Error('Wait for the current request to finish sending before using this review note.'));
    });
    for (const button of decisions) button.addEventListener('click', async () => {
      if (!target || button.disabled || !currentView()) return;
      const current = revision;
      const isCurrent = () => current === revision && currentView();
      const decision = button.dataset.reviewDecision;
      const text = note.value || undefined;
      if (!pending || pending.decision !== decision || pending.note !== text) {
        const { session, requestId } = target;
        pending = { session, requestId, decision, reviewId: crypto.randomUUID().replaceAll('-', ''),
          expectedReviewId: history.latestId, ...(text === undefined ? {} : { note: text }) };
      }
      busy = true;
      update();
      report(feedback, undefined, 'Saving review…');
      try {
        await coding(prefix + '/review', pending);
        if (!isCurrent()) return;
        pending = null;
        note.value = '';
        needsRefresh = true;
        await refresh();
        if (!isCurrent()) return;
        report(feedback, undefined, 'Review saved.');
        if (decision === 'accepted') afterAccepted();
      } catch (error) {
        if (!isCurrent()) return;
        if (error.status === 409) {
          pending = null;
          needsRefresh = true;
          await refresh();
          if (isCurrent()) report(feedback, new Error(error.message + ' Read the latest decisions and choose again.'));
        } else {
          const uncertain = !error.status || error.status >= 500;
          report(feedback, uncertain ? new Error(error.message + ' Use the same decision to retry this review.') : error);
        }
      } finally {
        if (isCurrent()) {
          busy = false;
          update();
        }
      }
    });

    return (row, savedHistory, canFollowUp) => {
      const next = row?.status === 'done' ? { ...identity(row), canFollowUp } : null;
      if (next?.session !== target?.session || next?.requestId !== target?.requestId) {
        revision++;
        pending = null;
        busy = false;
        note.value = '';
        historyPanel.hidden = true;
        report(feedback);
      }
      target = next;
      history = next && Array.isArray(savedHistory?.entries) && (savedHistory.latestId === null || typeof savedHistory.latestId === 'string')
        ? savedHistory : null;
      needsRefresh = !history;
      panel.hidden = !target || !history;
      showHistory();
      update();
    };
  }

  function activity(parent, project, readonly, detached, { reviewPatch, ownerActions, initialRun, loadReviewFollowUp }) {
    const prefix = projectUrl(project.id);
    const panel = document.createElement('section');
    panel.className = 'coding-panel coding-activity stack';
    panel.innerHTML = '<div class="row"><h3>Run history</h3><button type="button" class="small right" data-refresh>Refresh</button></div>' +
      '<details data-find-saved-run><summary>Find saved request</summary><form class="stack coding-form">' +
      field('Session name', '', 'text', 'name="session" maxlength="64" spellcheck="false" required') +
      field('Request ID', '', 'text', 'name="requestId" maxlength="128" spellcheck="false" required') +
      '<div class="row"><button type="submit">Open saved request</button></div></form></details>' +
      '<div class="stack coding-runs" data-runs></div><div class="stack" data-inspect aria-live="polite"></div>' +
      '<section class="stack" data-run-review hidden></section>' +
      '<div class="row" data-compare-branch hidden></div>' +
      '<section class="stack" data-saved-request-source hidden></section>' +
      (ownerActions ? '<section class="stack" data-branch-preview hidden></section>' +
        '<details data-saved-branches></details><section class="stack" data-context-controls hidden></section>' : '') +
      '<div class="coding-feedback" role="status"></div>';
    parent.append(panel);
    const list = panel.querySelector('[data-runs]');
    const inspected = panel.querySelector('[data-inspect]');
    const feedback = panel.querySelector('[role="status"]');
    const finder = panel.querySelector('[data-find-saved-run] form');
    const setRunReview = mountRunReview(panel.querySelector('[data-run-review]'), {
      prefix, readonly, detached, refresh, loadFollowUp: loadReviewFollowUp,
      afterAccepted: () => inspected.querySelector('[data-review-patch]')?.focus(),
    });
    const setSavedSourceRun = mountSavedSource(panel.querySelector('[data-saved-request-source]'), prefix, detached);
    const contextPanel = panel.querySelector('[data-context-controls]');
    const setContextSession = contextPanel ? mountContextControls(contextPanel, {
      prefix, detached, provider: () => project.providerLabel, ...ownerActions, refresh,
    }) : null;
    const branchPanel = panel.querySelector('[data-branch-preview]');
    const setBranchTarget = branchPanel ? mountBranchPreview(branchPanel, {
      prefix, detached, useBranch: ownerActions.useBranch,
      refreshBranches: mountSavedBranches(panel.querySelector('[data-saved-branches]'), { prefix, detached, useBranch: ownerActions.useBranch }),
    }) : null;
    const setComparisonRun = mountBranchComparison(panel.querySelector('[data-compare-branch]'), {
      project: project.id, prefix, detached, selectRun,
    });
    let selected = initialRun || null;
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
      if (row?.session !== run.session || row?.id !== run.id || row?.project !== project.id)
        throw new Error('The saved run did not match the selected request.');
      const compactionPending = pi?.context?.compactionPending === true;
      const branch = row.branch || alternativeSessionName.test(row.session);
      setRunReview(row, result.reviewHistory, !readonly && (!branch || !!ownerActions));
      setComparisonRun(row);
      if (pi && !branch) ownerActions?.markCompactionPending(row.session, compactionPending);
      setContextSession?.(!branch && idle && row.status !== 'running' && row.status !== 'interrupted' &&
        pi && !pi.pendingRequestIds.length ? row.session : null, compactionPending);
      setBranchTarget?.(!branch && result.alternativeBranchEligible === true ? row : null);
      const canViewSource = row.status !== 'running' &&
        (row.admitted || pi?.request || (row.status === 'interrupted' && !result.admissionMissing));
      setSavedSourceRun(canViewSource ? row : null);
      const receipt = pi?.request?.receipt;
      const error = row.error || receipt?.reason;
      const branchReason = ownerActions && typeof result.alternativeBranchReason === 'string' ? result.alternativeBranchReason : '';
      const snippet = receipt?.repositoryContext?.files || pi?.request?.repositoryContext?.files || [];
      const progress = result.taskProgress ?? pi?.request?.taskProgress;
      const live = inspected.querySelector('[data-live-answer]');
      if (row.status === 'running' && inspected.dataset.run === row.id && inspected.dataset.session === row.session && live) {
        showLiveAnswer(live, result.liveAnswer);
        showTaskProgress(inspected.querySelector('[data-task-progress]'), progress, true);
        return row;
      }
      inspected.dataset.run = row.id;
      inspected.dataset.session = row.session;
      inspected.innerHTML = '<div class="coding-result stack"><h4>' + esc(row.id) + '</h4>' +
        '<p>' + esc(labelStatus(row)) + ' · ' + esc(row.session) + ' · ' + esc(row.actor) + '</p>' +
        (row.branch ? '<p class="muted">Alternative to ' + esc(row.branch.session) + ' · ' + esc(row.branch.requestId) + '</p>' : '') +
        (row.reviewer && !result.reviewHistory?.entries?.length ? '<p class="muted">Reviewed by ' + esc(row.reviewer) + ' · ' + esc(time(row.reviewed)) + '</p>' : '') +
        (branchReason ? '<p class="muted">' + esc(branchReason) + '</p>' : '') +
        (error ? '<div class="notice">' + esc(error) + '</div>' : '') +
        (result.admissionMissing ? '<p class="muted">Pi did not save this request. Resume will make this ID available for resubmission.</p>' : '') +
        (pi ? '<p class="muted">Request usage · ' + esc(usageText(pi.request?.usage)) + '</p>' + contextSummary(pi.context) : '') +
        sourceLookupSummary(pi?.request) +
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
      if (readonly) return row;
      if ((!branch || ownerActions) && row.status === 'running') appendAction(bar, 'Cancel run', '/cancel', row);
      if ((!branch || ownerActions) && row.status === 'interrupted') {
        appendAction(bar, 'Resume', '/resume', row);
        appendAction(bar, 'Cancel run', '/cancel', row);
      }
      if (row.status === 'done') {
        if (row.review === 'accepted' && reviewPatch) {
          const patch = document.createElement('button');
          patch.type = 'button';
          patch.dataset.reviewPatch = '';
          patch.textContent = 'Review proposed patch';
          patch.addEventListener('click', () => reviewPatch(row));
          bar.append(patch);
        }
      }
      return row;
    }

    function appendAction(container, label, action, row) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      container.append(button);
      button.addEventListener('click', async () => {
        button.disabled = true;
        report(feedback);
        try {
          await coding(prefix + action, identity(row));
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
        const recent = selected && rows.find((row) => row.session === selected.session && row.id === selected.id);
        const target = recent || selected;
        const markup = rows.length ? rows.map((row, index) =>
          '<button type="button" class="coding-run" aria-pressed="' + (row === recent) + '" data-run="' + index + '">' +
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
        let opened;
        if (target) {
          const idle = !rows.some((row) => row.session === target.session && (row.status === 'running' || row.status === 'interrupted'));
          if (!idle) setContextSession?.(null);
          try { opened = await readRun(target, current, idle); }
          catch (error) {
            if (detached() || current !== generation) return;
            if (error.status !== 404 && error.status !== 410) throw error;
            selected = null;
            clearInspection();
            list.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
            const message = error.status === 410 ? 'This saved request expired under the project’s retention policy.' :
              'No saved request has that session and request ID.';
            report(feedback, new Error(message));
          }
        }
        if (focusResult && opened && current === generation) {
          const heading = inspected.querySelector('h4');
          heading?.setAttribute('tabindex', '-1');
          const branchButton = initialRun === selected && !branchPanel?.hidden ? branchPanel?.querySelector('[data-branch-start]') : null;
          (branchButton || heading)?.focus();
        }
        if ((active || opened?.status === 'running') && current === generation && !detached()) timer = setTimeout(refresh, 1200);
      } catch (error) {
        if (!detached() && current === generation) report(feedback, error);
      }
    }

    function clearInspection() {
      setSavedSourceRun(null);
      setContextSession?.(null);
      setBranchTarget?.(null);
      setComparisonRun(null);
      setRunReview(null);
      inspected.replaceChildren();
    }

    function selectRun(row) {
      if (selected?.id !== row.id || selected.session !== row.session) clearInspection();
      selected = row;
      report(feedback);
      return refresh(true);
    }

    finder.addEventListener('submit', (event) => {
      event.preventDefault();
      if (detached()) return;
      const session = finder.elements.session.value.trim();
      const id = finder.elements.requestId.value.trim();
      if (!runSessionName.test(session) || !runRequestId.test(id)) {
        report(feedback, new Error('Enter a valid session name and request ID.'));
        return;
      }
      void selectRun({ session, id });
    });
    panel.querySelector('[data-refresh]').addEventListener('click', () => refresh());
    refresh(Boolean(initialRun));
    return { refresh, selectRun };
  }

  function mountProviderCheck(panel, { prefix, readonly, current, opened }) {
    panel.innerHTML = '<div class="row"><button type="button" aria-expanded="false" aria-controls="provider-check-consent">Test provider connection</button></div>' +
      '<p class="muted" data-provider-network-required hidden>Testing the provider connection requires a network-enabled worker.</p>' +
      '<div id="provider-check-consent" class="card stack" hidden><p id="provider-check-scope"></p>' +
      '<div class="row"><button type="button" class="primary" aria-describedby="provider-check-scope">Run provider check</button>' +
      '<button type="button">Cancel</button></div></div>' +
      '<div class="coding-feedback" role="status"></div>';
    const [start, run, cancel] = panel.querySelectorAll('button');
    const consent = panel.querySelector('#provider-check-consent');
    const scope = panel.querySelector('#provider-check-scope');
    const networkRequired = panel.querySelector('[data-provider-network-required]');
    const feedback = panel.querySelector('[role="status"]');
    let target = null;
    let approved = null;
    let running = false;
    let offline = false;

    function update() {
      panel.hidden = !target && !offline;
      start.parentElement.hidden = !target;
      networkRequired.hidden = !offline;
      consent.hidden = !approved;
      start.setAttribute('aria-expanded', String(!!approved));
      start.disabled = run.disabled = cancel.disabled = !target || running;
    }

    start.addEventListener('click', () => {
      if (!current() || !opened() || !target || running) return;
      approved = target;
      const { worker, provider, model, credential } = approved;
      const boundary = worker.mode === 'docker' ? 'The Docker worker on network ' + worker.network : 'The local worker';
      const key = credential === 'project' ? 'the saved project key' : 'the server environment key';
      scope.textContent = 'Look up model ' + model + ' at ' + provider + ' over HTTPS. ' + boundary +
        ' uses ' + key + ' to authenticate this single model metadata request.';
      report(feedback);
      update();
      run.focus();
    });
    cancel.addEventListener('click', () => {
      if (running || !approved) return;
      approved = null;
      update();
      start.focus();
    });
    run.addEventListener('click', async () => {
      if (!current() || !opened() || !approved || target !== approved || running) return;
      const checked = approved;
      const active = () => current() && opened() && target === checked;
      running = true;
      update();
      report(feedback, undefined, 'Checking provider connection…');
      try {
        const result = await coding(prefix + '/provider-check', { approved: true, binding: checked.providerCheckBinding });
        if (!active()) return;
        const network = checked.worker.mode === 'docker' ? checked.worker.network : null;
        if (result.provider !== checked.provider || result.model !== checked.model || result.worker !== checked.worker.mode || result.network !== network)
          throw new Error('The deployment configuration changed. Reopen Deployment checks before trying again.');
        const passed = result.status === 'passed';
        const message = [result.message || (passed ? 'Provider connection verified.' : 'The provider connection check failed.'),
          !passed && Number.isSafeInteger(result.httpStatus) ? 'HTTP ' + result.httpStatus : '',
          typeof result.checkedAt === 'string' && Number.isFinite(Date.parse(result.checkedAt)) ? 'Checked ' + time(result.checkedAt) : '',
        ].filter(Boolean).join(' · ');
        report(feedback, passed ? undefined : new Error(message), message);
      } catch (error) { if (active()) report(feedback, error); }
      finally {
        running = false;
        if (active()) {
          approved = null;
          update();
          if (document.activeElement === document.body || consent.contains(document.activeElement)) start.focus();
        } else if (current()) update();
      }
    });

    return (settings) => {
      target = !readonly && (settings?.credential === 'project' || settings?.credential === 'environment') ? settings : null;
      offline = target?.worker.mode === 'docker' && target.worker.network === 'none';
      const binding = target?.providerCheckBinding;
      if (offline || typeof binding !== 'string' || !/^[a-f0-9]{64}$/u.test(binding)) target = null;
      approved = null;
      scope.textContent = '';
      report(feedback);
      update();
    };
  }

  function mountDeploymentChecks(panel, prefix, readonly, isDetached) {
    panel.innerHTML = '<summary>Deployment checks</summary><div class="stack coding-form">' +
      '<dl class="coding-grid coding-deployment-summary" hidden></dl>' +
      '<div class="coding-feedback" role="status" data-deployment-status></div>' +
      '<section class="stack" data-provider-check hidden></section>' +
      '<div class="stack" data-offline-worker hidden>' +
      '<p class="muted">The test container runs the configured local image with networking disabled. ' +
      'The configured network is checked for availability. Provider connectivity and backup recovery need separate checks.</p>' +
      '<div class="row"><button type="button" disabled>Run offline worker check</button></div>' +
      '<div class="coding-feedback" role="status" data-worker-status></div>' +
      '<section class="stack" hidden><h4>Offline worker check</h4><p></p><ul class="plain"></ul></section></div></div>';
    const brain = document.querySelector('#brain')?.value;
    const current = () => panel.isConnected && !isDetached() && document.querySelector('#brain')?.value === brain;
    const endpoint = prefix + '/deployment-check';
    const configuration = panel.querySelector('dl');
    const settingsFeedback = panel.querySelector('[data-deployment-status]');
    const workerFeedback = panel.querySelector('[data-worker-status]');
    const workerPanel = panel.querySelector('[data-offline-worker]');
    const button = workerPanel.querySelector('button');
    const result = workerPanel.querySelector('section');
    const projectSettings = panel.parentElement.closest('details');
    const opened = () => projectSettings.open && panel.open;
    const setProviderCheck = mountProviderCheck(panel.querySelector('[data-provider-check]'), { prefix, readonly, current, opened });
    let version = 0;
    let visible = false;
    let available = false;
    let running = false;

    function updateAction() {
      button.disabled = !available || running;
      workerPanel.hidden = !available;
    }

    async function refresh() {
      if (!opened() || !current()) return;
      const attempt = ++version;
      available = false;
      updateAction();
      setProviderCheck(null);
      configuration.hidden = true;
      report(settingsFeedback, undefined, 'Loading deployment configuration…');
      const [settings, listener] = await Promise.allSettled([coding(endpoint), coding('/team')]);
      if (attempt !== version || !current() || !opened()) return;
      if (settings.status === 'rejected') {
        report(settingsFeedback, settings.reason);
        return;
      }
      const { worker, retention, provider, model, credential } = settings.value;
      const docker = worker.mode === 'docker';
      const listenerText = listener.status === 'rejected' ? 'Status unavailable' : listener.value
        ? 'Running on local port ' + listener.value.port + (listener.value.publicOrigin ? ' · HTTPS proxy configured' : '')
        : 'Stopped';
      const credentialLabels = { project: 'Saved project key', environment: 'Server environment key', missing: 'Missing' };
      const keep = retention.days === null ? 'Keep until manually deleted' : retention.days + (retention.days === 1 ? ' day' : ' days');
      const fields = [['Worker isolation', docker ? 'Docker' : 'Local process · Server OS account']];
      if (docker) fields.push(['Worker image', worker.image], ['Configured network', worker.network]);
      fields.push(['Transcript retention', retention.active ? keep : 'Automatic cleanup unavailable · ' + keep],
        ['Provider and model', provider + ' / ' + model], ['Provider credential', credentialLabels[credential] || 'Status unavailable'],
        ['Team listener', listenerText]);
      configuration.innerHTML = fields.map(([label, value]) => '<div><dt class="muted">' + esc(label) + '</dt><dd>' +
        esc(value) + '</dd></div>').join('');
      configuration.hidden = false;
      available = docker && !readonly;
      updateAction();
      setProviderCheck(settings.value);
      report(settingsFeedback);
    }

    function visibilityChanged() {
      const open = opened();
      if (visible === open) return;
      visible = open;
      if (open) void refresh();
      else setProviderCheck(null);
    }
    projectSettings.addEventListener('toggle', visibilityChanged);
    panel.addEventListener('toggle', visibilityChanged);
    button.addEventListener('click', async () => {
      if (!current() || !projectSettings.open || !panel.open || button.disabled) return;
      running = true;
      updateAction();
      result.hidden = true;
      report(workerFeedback, undefined, 'Running offline worker check…');
      try {
        const check = await coding(endpoint, {});
        if (!current()) return;
        const labels = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', unavailable: 'Unavailable' };
        result.querySelector('p').textContent = labels[check.status] + ' · ' + time(check.checkedAt);
        result.querySelector('ul').replaceChildren(...check.checks.map((entry) => {
          const item = document.createElement('li');
          item.textContent = entry.label + ' · ' + labels[entry.status] + (entry.message ? ' · ' + entry.message : '');
          return item;
        }));
        result.hidden = false;
        report(workerFeedback, undefined, 'Offline worker check ' + check.status + '.');
      } catch (error) { if (current()) report(workerFeedback, error); }
      finally { running = false; if (current()) updateAction(); }
    });
    return refresh;
  }

  function mountRepositoryMap(panel, prefix, readonly, isDetached, feedback) {
    const importButton = panel.querySelector('[data-import-map]');
    const progress = panel.querySelector('[data-map-progress]');
    const summary = panel.querySelector('[data-map-summary]');
    const skills = panel.querySelector('[data-map-skills]');
    const lesson = panel.querySelector('[data-lesson]');
    const routing = panel.querySelector('[data-routing]');
    const phases = { list: 'Listing tracked files', read: 'Reading files', link: 'Linking imports and tests', history: 'Reading change history',
      embed: 'Encoding units', publish: 'Publishing the map', knowledge: 'Writing the knowledge bundle' };
    let timer;
    let loaded = false;

    function show(state) {
      const running = state.status === 'running';
      importButton.disabled = readonly || running;
      importButton.textContent = state.imported ? 'Import again' : 'Import repository map';
      progress.textContent = running
        ? (phases[state.progress?.phase] || 'Importing') + (state.progress?.total > 1 ? ' · ' + state.progress.done.toLocaleString() + ' of ' + state.progress.total.toLocaleString() : '') + '…'
        : state.status === 'failed' ? state.error : '';
      const rows = [];
      if (state.imported) {
        rows.push(['Imported', state.map.files.toLocaleString() + ' files · ' + state.map.units.toLocaleString() + ' units · ' + state.map.packages + ' packages' +
          (state.map.importedAt ? ' · ' + time(state.map.importedAt) : '')]);
        if (state.map.limited) rows.push(['Limits', 'The import reached a size limit. Narrow the project’s permitted directories.']);
        if (state.knowledge) rows.push(['Knowledge bundle', state.knowledge]);
        if (state.learning) rows.push(['Learned from', state.learning.episodes + ' reviewed requests · ' + state.learning.aliases + ' aliases · parameters v' + state.learning.params]);
      } else rows.push(['Imported', 'Not yet']);
      summary.replaceChildren(...rows.flatMap(([name, value]) => {
        const term = document.createElement('dt');
        term.textContent = name;
        const detail = document.createElement('dd');
        detail.textContent = value;
        return [term, detail];
      }));
      const measured = (state.skills || []).filter((skill) => skill.kind !== 'built-in');
      skills.replaceChildren(...(measured.length ? [listBlock('Skills and lessons (' + measured.length + ')', measured.map((skill) =>
        skill.title + ' · ' + skill.state + (skill.shown + skill.withheld
          ? ' · accepted ' + skill.shownAccepted + ' of ' + skill.shown + ' when sent, ' + skill.withheldAccepted + ' of ' + skill.withheld + ' when withheld' : '')))] : []));
      lesson.querySelector('button').disabled = readonly || !state.imported;
      clearTimeout(timer);
      if (running && !isDetached()) timer = setTimeout(refresh, 1000);
    }

    async function refresh() {
      if (isDetached()) return;
      try { show(await coding(prefix + '/import')); }
      catch (error) { report(feedback, error); }
    }

    panel.addEventListener('toggle', async () => {
      if (!panel.open || loaded) return;
      loaded = true;
      await refresh();
      try {
        const saved = await coding(prefix + '/routing');
        if (!isDetached() && saved.policy) routing.elements.policy.value = JSON.stringify(saved.policy, null, 2);
      } catch (_) { /* Project members cannot read routing settings. */ }
    });
    importButton.addEventListener('click', async () => {
      report(feedback);
      importButton.disabled = true;
      try {
        await coding(prefix + '/import', {});
        await refresh();
      } catch (error) { report(feedback, error); importButton.disabled = readonly; }
    });
    lesson.addEventListener('submit', async (event) => {
      event.preventDefault();
      report(feedback);
      try {
        const anchors = entries(lesson.elements.anchors.value);
        await coding(prefix + '/lesson', { text: lesson.elements.text.value, ...(anchors.length ? { anchors } : {}) });
        lesson.reset();
        feedback.textContent = 'Lesson recorded on trial.';
        await refresh();
      } catch (error) { report(feedback, error); }
    });
    routing.addEventListener('submit', async (event) => {
      event.preventDefault();
      report(feedback);
      try {
        const text = routing.elements.policy.value.trim();
        let policy = null;
        if (text) {
          try { policy = JSON.parse(text); }
          catch (_) { throw new Error('Enter valid JSON for the routing policy.'); }
        }
        await coding(prefix + '/routing', { policy });
        feedback.textContent = policy ? 'Routing policy saved.' : 'Routing policy cleared. Orchestrated requests use the project model.';
      } catch (error) { report(feedback, error); }
    });
  }

  function settings(parent, project, readonly, projectChanged, runsChanged, isDetached) {
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
      '<p class="muted" data-branch-transcript hidden>Transcript deletion includes the original session and all of its alternative branches.</p>' +
      '<div class="row"><button type="submit" class="danger">Delete session and transcript</button></div></form>' +
      '<details data-repository-map><summary>Repository map</summary><div class="stack coding-form">' +
      '<p class="muted">Importing reads the tracked files in this project’s permitted directories on this computer and builds a map of packages, declarations, links, and tests. It makes no model call. Requests that use the map still show you exactly what they send.</p>' +
      '<div class="row"><button type="button" data-import-map>Import repository map</button><span class="muted" data-map-progress role="status"></span></div>' +
      '<dl class="coding-facts" data-map-summary></dl><div class="stack" data-map-skills></div>' +
      '<form class="stack" data-lesson>' + field('Lesson for future requests', '', 'text', 'name="text" maxlength="600" required placeholder="Something reviewers keep having to say about this code"') +
      field('Applies to directories (optional)', '', 'text', 'name="anchors" spellcheck="false"') +
      '<div class="row"><button type="submit">Record lesson</button></div><p class="muted">A lesson starts on trial. It is sent with about half of the matching requests until review outcomes show whether it helps.</p></form>' +
      '<form class="stack" data-routing><label class="field"><span>Routing policy (optional JSON)</span><textarea name="policy" rows="4" spellcheck="false" placeholder=\'{"version":1,"roles":{"worker":[{"provider":"' + esc(project.provider) + '","model":"…"}]}}\'></textarea></label>' +
      '<p class="muted">Lists the models an orchestrated request may use for its workers and for combining their reports. Every model must come from this project’s provider. Leave empty to use the project model for everything.</p>' +
      '<div class="row"><button type="submit">Save routing policy</button></div></form></div></details>' +
      '<details data-deployment-checks></details>' +
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
    const deleteTranscript = deleteSession.querySelector('button');
    const branchTranscript = deleteSession.querySelector('[data-branch-transcript]');
    const retention = panel.querySelector('[data-retention]');
    const saveRetention = retention.querySelector('button');
    const credential = panel.querySelector('[data-credential]');
    panel.querySelectorAll('button').forEach((button) => button.disabled = readonly);
    saveRetention.disabled = true;
    const refreshDeployment = mountDeploymentChecks(panel.querySelector('[data-deployment-checks]'), prefix, readonly, isDetached);
    mountRepositoryMap(panel.querySelector('[data-repository-map]'), prefix, readonly, isDetached, feedback);

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
        void refreshDeployment();
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
        void refreshDeployment();
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
    deleteSession.elements.session.addEventListener('input', () => {
      const branch = alternativeSessionName.test(deleteSession.elements.session.value.trim());
      branchTranscript.hidden = !branch;
      deleteTranscript.disabled = readonly || branch;
    });
    deleteSession.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (deleteTranscript.disabled) return;
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
    return refreshDeployment;
  }

  function teamSettings(parent, readonly, isDetached, listenerChanged) {
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
      listenerChanged();
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
      const active = () => !detached() && panel.open && current === runsRevision;
      try {
        const accepted = (await coding(prefix + '/runs')).filter((entry) => entry.status === 'done' && entry.review === 'accepted');
        if (!active()) return false;
        const targeted = (entry) => entry.session === target.session && entry.id === target.requestId;
        if (target && intent === proposalRevision && !accepted.some(targeted)) {
          const { run: saved } = await coding(prefix + '/inspect', target);
          if (!active() || intent !== proposalRevision) return false;
          if (saved?.project === project.id && targeted(saved) && saved.status === 'done' && saved.review === 'accepted')
            accepted.unshift(saved);
        }
        const selected = target && intent === proposalRevision ? JSON.stringify(target) : run.value;
        run.replaceChildren(new Option(accepted.length ? 'Choose a result' : 'No accepted results', ''),
          ...accepted.map((entry) => new Option(entry.session + ' · ' + entry.id, JSON.stringify(identity(entry)))));
        run.value = accepted.length === 1 && !selected ? run.options[1].value : selected;
        clear();
        return !target || run.value === JSON.stringify(target);
      } catch (error) {
        if (!active()) return false;
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
        coding, readonly, detached: isDetached, defaultModels, entries, field, previewContents, mountSourceManifest, report, sessionUsage, usageText, contextSummary,
        showTaskProgress, taskProgressPanel, mountContextControls, mountRunCopies, sourceLookupSummary,
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
    const runRoute = /^([a-f0-9-]{36})\?(.+)$/u.exec(arg || '');
    const params = new URLSearchParams(runRoute?.[2]);
    const requestedSession = params.get('session');
    const requestedRun = params.get('request');
    const initialRun = runSessionName.test(requestedSession || '') && runRequestId.test(requestedRun || '')
      ? { session: requestedSession, id: requestedRun } : undefined;
    const projectId = actionRoute?.[1] || runRoute?.[1] || arg;
    const project = projects.find((item) => item.id === projectId || (suggestedWorkspace && item.workspace === suggestedWorkspace)) ||
      (!arg ? projects[0] : null);
    projectsEl.innerHTML = !teamMode && projects.length ?
      '<div class="row coding-project-links" aria-label="Coding projects">' + projects.map((item) =>
        '<a href="' + projectHref(item.id) + '" data-project-link' + (item.id === project?.id ? ' aria-current="page"' : '') +
        '>' + esc(item.title) + '</a>').join('') + '</div>' : '';
    let refreshDeployment;
    if (!teamMode) {
      projectsEl.insertAdjacentHTML('beforeend', '<div class="row coding-project-links"><a href="#coding/standalone">Standalone sessions</a></div>');
      register(projectsEl, models, suggestedWorkspace, readonly, isDetached);
      teamSettings(projectsEl, readonly, isDetached, () => { if (refreshDeployment) void refreshDeployment(); });
    }
    if (!project) {
      if (teamMode) report(projectsEl, new Error('This request link does not match the connected project.'));
      return;
    }
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
    const runs = activity(right, project, readonly, isDetached, {
      initialRun,
      reviewPatch: teamMode ? undefined : (row) => openPatch(row),
      loadReviewFollowUp: (session, note) => composerPanel.loadReviewFollowUp(session, note),
      ownerActions: teamMode || readonly ? undefined : {
        clearConsent: (session) => clearComposerConsent(session),
        markCompactionPending: (session, pending) => composerPanel.setCompactionPending(session, pending),
        useBranch: (session) => composerPanel.useBranchSession(session),
      },
    });
    const clearComposerConsent = composer(left, project, readonly, isDetached, runs.selectRun, !teamMode && !readonly);
    composerPanel = left.querySelector('.coding-composer');
    window.okbCodingEvaluation.mount(right, {
      prefix: projectUrl(project.id), coding, readonly, detached: isDetached,
      canLoadCase: composerPanel.canLoadEvaluationCase, loadCase: composerPanel.loadEvaluationCase,
    });
    if (!teamMode) {
      window.okbCodingEvaluation.mountRetrievalBenchmark(right, {
        prefix: projectUrl(project.id), coding, readonly, detached: isDetached,
      });
      refreshDeployment = settings(left, project, readonly, composerPanel.updateProject, runs.refresh, isDetached);
    }
    const github = document.createElement('div');
    github.dataset.codingGithub = '';
    left.append(github);
    const target = actionRoute ? { session: actionRoute[3], id: actionRoute[4] } : undefined;
    window.okbGitHub?.mount(github, { project, coding, readonly, detached: isDetached, loadIssue: composerPanel.loadGitHubIssue,
      target: actionRoute?.[2] === 'github' ? target : undefined });
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
    function mountTeam() {
      const sequence = ++generation;
      const route = /^#coding\/[a-f0-9-]{36}\?/u.test(window.location.hash) ? window.location.hash.slice('#coding/'.length) : null;
      return mount(teamView, route, () => sequence !== generation, false, true);
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      teamToken = form.elements.token.value.trim();
      submit.disabled = true;
      report(feedback);
      try {
        await coding('/projects');
        form.reset();
        entrance.hidden = true;
        teamView.hidden = disconnect.hidden = false;
        teamView.focus();
        await mountTeam();
      } catch (error) {
        teamToken = null;
        report(feedback, error);
      } finally { submit.disabled = false; }
    });
    window.addEventListener('hashchange', () => { if (teamToken && !teamView.hidden) void mountTeam(); });
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
