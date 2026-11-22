/* Local owner UI for Pi sessions shared with the standalone CLI. */
(function () {
  'use strict';

  const prefix = '/standalone';
  const esc = window.okbRender.esc;
  const statusLabels = {
    running: 'Running', interrupted: 'Interrupted', queued: 'Interrupted', placed: 'Interrupted',
    done: 'Ready to review', unanswered: 'Unanswered', failed: 'Could not start', cancelled: 'Cancelled',
  };
  const statusLabel = (status) => statusLabels[status] || status || 'Saved';

  async function mount(parent, { coding, readonly, detached, defaultModels, entries, field, previewContents,
    report, sessionUsage, usageText, showTaskProgress, taskProgressPanel, mountContextReset }) {
    const header = parent.querySelector('header');
    header.innerHTML = '<div class="row coding-project-links"><a href="#coding">Project workspace</a></div>' +
      '<h2 class="display">Standalone sessions</h2><p class="muted">Open sessions from this app or the CLI.</p>';
    const grid = document.createElement('div');
    grid.className = 'coding-workspace-grid';
    grid.innerHTML = '<section class="coding-panel stack"><h3>New request</h3><form class="stack">' +
      field('Absolute workspace path', '', 'text', 'name="workspace" maxlength="4096" autocomplete="off" spellcheck="false" required') +
      '<div class="coding-grid">' +
      field('Session name', 'main', 'text', 'name="session" required pattern="[a-z0-9][a-z0-9_\\-]{0,63}" spellcheck="false"') +
      field('Request ID', crypto.randomUUID(), 'text', 'name="requestId" required pattern="[a-zA-Z0-9][a-zA-Z0-9._\\-]{0,127}" spellcheck="false"') +
      '</div><div class="coding-grid"><label class="field"><span>Provider</span><select name="provider" required></select></label>' +
      '<label class="field"><span>Model</span><select name="model" required></select></label>' +
      '<label class="field"><span>Reasoning</span><select name="thinkingLevel"></select></label></div>' +
      '<p class="muted" data-credential></p>' +
      '<label class="field"><span>Task</span><textarea name="prompt" rows="4" maxlength="16384" required></textarea></label>' +
      '<label class="field"><span>Source</span><select name="source"><option value="files">Explicit files</option>' +
      '<option value="repository">Tracked repository excerpts</option></select></label>' +
      '<div class="stack" data-files>' + field('Workspace-relative files', '', 'text', 'name="files" spellcheck="false" placeholder="src/app.ts, README.md"') +
      '<p class="muted">Separate paths with commas. Leave empty to send only the task and active history.</p></div>' +
      '<div class="stack" data-repository hidden>' +
      field('Search source', '', 'search', 'name="query" maxlength="1024" placeholder="Identifier, path, or terms"') +
      '<details><summary>Scope and budget</summary><div class="stack coding-form">' +
      field('Directories', '.', 'text', 'name="projects" spellcheck="false"') +
      field('Estimated excerpt tokens', '4096', 'number', 'name="contextTokens" min="1" max="16384"') +
      '<label class="field"><span>Project profile (optional JSON)</span><textarea name="profile" rows="3" spellcheck="false"></textarea></label>' +
      '</div></details></div>' +
      '<label class="row"><input name="approvedSourceLookup" type="checkbox"><span>Let the model look up lines within the approved source</span></label>' +
      '<div class="row"><button type="button" data-preview disabled>Preview source</button></div>' +
      '<div class="coding-preview stack" data-preview-content aria-live="polite"></div>' +
      '<label class="row" data-approve hidden><input type="checkbox" name="approved"><span></span></label>' +
      '<div class="row"><button type="submit" class="primary" disabled>Send request</button></div>' +
      '<div class="coding-feedback" role="status"></div></form></section>' +
      '<section class="coding-panel stack"><div class="row"><h3>Run history</h3><button type="button" class="small right" data-refresh>Refresh sessions</button></div>' +
      '<label class="field"><span>Saved session</span><select data-sessions><option value="">Loading sessions…</option></select></label>' +
      '<label class="field" data-request-picker hidden><span>Saved request</span><select data-requests></select></label>' +
      '<div data-inspect class="stack" aria-live="polite"></div>' +
      (readonly ? '' : '<section class="stack" data-context-reset hidden></section>') +
      '<details data-delete-session hidden><summary>Delete standalone session</summary><form class="stack coding-form">' +
      '<p>Permanently delete the saved requests, source snapshots, and responses for <code data-delete-name></code> from this device.</p>' +
      '<p class="muted" data-delete-state></p><label class="field"><span>Type the session name to confirm</span>' +
      '<input name="confirmation" maxlength="64" autocomplete="off" spellcheck="false" required></label>' +
      '<div class="row"><button type="submit" class="danger" disabled>Delete session</button></div></form></details>' +
      '<div data-history-feedback class="coding-feedback" role="status"></div></section>';
    parent.append(grid);

    const form = grid.querySelector('form');
    const controls = form.elements;
    const feedback = form.querySelector('[role="status"]');
    const credential = form.querySelector('[data-credential]');
    const previewButton = form.querySelector('[data-preview]');
    const previewContent = form.querySelector('[data-preview-content]');
    const approve = form.querySelector('[data-approve]');
    const send = form.querySelector('button[type="submit"]');
    const sessionsSelect = grid.querySelector('[data-sessions]');
    const requestPicker = grid.querySelector('[data-request-picker]');
    const requestsSelect = grid.querySelector('[data-requests]');
    const inspectEl = grid.querySelector('[data-inspect]');
    const historyFeedback = grid.querySelector('[data-history-feedback]');
    const refreshButton = grid.querySelector('[data-refresh]');
    const deletePanel = grid.querySelector('[data-delete-session]');
    const deleteForm = deletePanel.querySelector('form');
    const deleteName = deletePanel.querySelector('[data-delete-name]');
    const deleteNotice = deletePanel.querySelector('[data-delete-state]');
    const deleteInput = deleteForm.elements.confirmation;
    const deleteButton = deleteForm.querySelector('button');
    let catalog = [];
    let sessions = [];
    let sessionName = '';
    let requestId = '';
    let binding = null;
    let busy = false;
    let previewing = false;
    let running = false;
    let refreshing = false;
    let runActionPending = false;
    let deleting = false;
    let pendingWork = false;
    let sessionState = '';
    let preview = null;
    let revision = 0;
    let generation = 0;
    let timer;
    let inspected;
    const resetPanel = grid.querySelector('[data-context-reset]');
    const setResetSession = resetPanel ? mountContextReset(resetPanel, {
      prefix, detached,
      clearConsent() {
        controls.approvedSourceLookup.checked = false;
        invalidate();
      },
      async refresh() {
        const selected = sessionName;
        const request = requestId;
        const sourceWasOpen = inspectEl.querySelector('[data-saved-task]')?.open;
        await inspect();
        if (!detached() && sessionName === selected && requestId === request && sourceWasOpen) {
          const saved = inspectEl.querySelector('[data-saved-task]');
          if (saved) saved.open = true;
        }
      },
    }) : null;

    function selectedProvider() {
      return catalog.find((entry) => entry.provider === controls.provider.value);
    }

    function providerName(id) {
      return catalog.find((entry) => entry.provider === id)?.label || id;
    }

    function updateControls() {
      const waiting = !!sessionName && !binding;
      const key = selectedProvider()?.credential;
      previewButton.disabled = busy || running || waiting || previewing || deleting || sessionState === 'deleting';
      send.disabled = readonly || previewButton.disabled || !preview || !form.checkValidity() ||
        !controls.approved.checked || (key !== 'saved' && key !== 'environment');
      controls.workspace.readOnly = !!binding;
      controls.session.readOnly = !!sessionName;
      for (const control of [controls.provider, controls.model, controls.thinkingLevel]) control.disabled = !!binding;
      sessionsSelect.disabled = deleting;
      requestsSelect.disabled = running || deleting || sessionState === 'deleting';
      refreshButton.disabled = refreshing || deleting;
      deletePanel.hidden = readonly || !sessionName;
      deleteName.textContent = sessionName;
      deleteNotice.textContent = deleting ? 'Deleting the transcript…' : running || busy || runActionPending
        ? 'Wait for the current invocation to finish before deleting this session.'
        : sessionState === 'deleting' ? 'Deletion started. Confirm the session name again to finish.' : '';
      deleteButton.textContent = sessionState === 'deleting' ? 'Retry deletion' : 'Delete session';
      deleteInput.disabled = deletePanel.hidden || busy || running || refreshing || runActionPending || deleting ||
        !['ready', 'deleting', 'unavailable'].includes(sessionState);
      deleteButton.disabled = deleteInput.disabled || deleteInput.value !== sessionName;
      setResetSession?.(sessionState === 'ready' && !busy && !running && !pendingWork && !refreshing &&
        !runActionPending && !deleting ? sessionName : null);
    }

    function invalidate() {
      ++revision;
      preview = null;
      controls.approved.checked = false;
      approve.hidden = true;
      previewContent.replaceChildren();
      updateControls();
    }

    function syncThinking(previous = '') {
      const levels = selectedProvider()?.models.find((entry) => entry.id === controls.model.value)?.thinkingLevels || [];
      const chosen = binding ? binding.thinkingLevel || '' : previous;
      const options = [...new Set([...levels, ...(binding && chosen ? [chosen] : [])])].map((level) => new Option(level, level));
      controls.thinkingLevel.replaceChildren(new Option('Provider default', ''), ...options);
      if (options.some((option) => option.value === chosen)) controls.thinkingLevel.value = chosen;
    }

    function syncModels(prior = '') {
      const models = selectedProvider()?.models || [];
      const options = models.map((entry) => new Option(entry.name, entry.id));
      const preferred = binding?.model || prior || defaultModels[controls.provider.value];
      if (binding && !models.some((entry) => entry.id === preferred)) options.push(new Option(preferred, preferred));
      controls.model.replaceChildren(...options);
      if (options.some((option) => option.value === preferred)) controls.model.value = preferred;
      const status = selectedProvider()?.credential;
      credential.innerHTML = status === 'missing'
        ? 'Add this provider’s API key in <a href="#settings">Settings</a> to send a request.'
        : status === 'saved' ? 'Using a key saved in Settings.' : status === 'environment' ? 'Using a local environment key.' : '';
      syncThinking(controls.model.value === prior ? controls.thinkingLevel.value : '');
      updateControls();
    }

    function fillBinding(value) {
      if (JSON.stringify(binding) === JSON.stringify(value)) return;
      binding = value;
      if (binding) controls.workspace.value = binding.workspace;
      syncProviderList();
      invalidate();
    }

    function syncProviderList() {
      const previous = binding?.provider || controls.provider.value;
      const options = catalog.filter((entry) => entry.models.length || entry.provider === previous)
        .map((entry) => new Option(entry.label, entry.provider));
      if (previous && !options.some((option) => option.value === previous)) options.push(new Option(previous, previous));
      const priorModel = controls.model.value;
      controls.provider.replaceChildren(...options);
      if (options.some((option) => option.value === previous)) controls.provider.value = previous;
      syncModels(priorModel);
    }

    function showSessions() {
      sessionsSelect.replaceChildren(new Option('New standalone session', ''),
        ...sessions.map(({ session, state }) => new Option(session + (state && state !== 'ready' ? ' · ' + state : ''), session)));
      if (sessionName && !sessions.some((entry) => entry.session === sessionName))
        sessionsSelect.append(new Option(sessionName, sessionName));
      sessionsSelect.value = sessionName;
    }

    function syncSource() {
      for (const group of ['files', 'repository']) {
        const fields = form.querySelector('[data-' + group + ']');
        fields.hidden = controls.source.value !== group;
        fields.querySelectorAll('input, textarea').forEach((control) => { control.disabled = fields.hidden; });
      }
    }

    function sourceInput() {
      const workspace = controls.workspace.value.trim();
      if (controls.source.value === 'files') {
        const files = entries(controls.files.value);
        if (!files.length && controls.approvedSourceLookup.checked)
          throw new Error('Choose at least one file to allow source lookup.');
        return { workspace, source: 'files', files };
      }
      const query = controls.query.value.trim();
      if (!query) throw new Error('Enter a query to select repository excerpts.');
      if (controls.profile.value.trim()) {
        let profile;
        try { profile = JSON.parse(controls.profile.value); }
        catch (_) { throw new Error('Enter valid JSON for the project profile.'); }
        if (!profile || typeof profile !== 'object' || Array.isArray(profile))
          throw new Error('Enter a JSON object for the project profile.');
        return { workspace, source: 'repository', query, profile };
      }
      const projects = entries(controls.projects.value);
      const budget = controls.contextTokens.value;
      return { workspace, source: 'repository', query, projects, ...(budget ? { contextTokens: Number(budget) } : {}) };
    }

    function showRequests(requests) {
      const next = requests.map((entry) => [entry.requestId, entry.requestId + ' · ' + statusLabel(entry.status)]);
      const prior = Array.from(requestsSelect.options, (option) => [option.value, option.textContent]);
      if (JSON.stringify(next) !== JSON.stringify(prior))
        requestsSelect.replaceChildren(...next.map(([id, label]) => new Option(label, id)));
      requestPicker.hidden = !next.length;
      if (requestId) requestsSelect.value = requestId;
    }

    function showInspection({ pi, active, identity, state }, pending) {
      const request = pi?.request;
      const savedSource = request?.savedSource;
      const savedPrompt = request?.savedPrompt;
      const receipt = request?.receipt || active?.receipt;
      const status = active?.cancelled ? 'cancelled' : active?.status || request?.status;
      const progress = active?.taskProgress ?? request?.taskProgress;
      const runKey = sessionName + '/' + requestId;
      const live = inspectEl.querySelector('[data-live-answer]');
      if (status === 'running' && inspectEl.dataset.running === runKey && live) {
        showLiveAnswer(live, active.liveAnswer);
        showTaskProgress(inspectEl.querySelector('[data-task-progress]'), progress, true);
        return;
      }
      const snapshot = JSON.stringify({ pi, active, identity, state, pending, requestId });
      if (inspected === snapshot) return;
      inspected = snapshot;
      inspectEl.dataset.running = status === 'running' ? runKey : '';
      if (state === 'busy') {
        inspectEl.textContent = 'This session is open in another invocation.';
        return;
      }
      if (state === 'deleting') {
        inspectEl.textContent = 'Deletion is incomplete for this session.';
        return;
      }
      if (!requestId) {
        inspectEl.textContent = sessionName ? 'No saved requests in this session.' : 'Choose a saved session to inspect its requests.';
        return;
      }
      const answer = receipt?.text;
      const explanation = active?.error || receipt?.reason || request?.reason;
      const references = request?.repositoryContext?.files || [];
      inspectEl.innerHTML = '<div class="coding-result stack"><h4>' + esc(requestId) + '</h4>' +
        '<p>' + esc(statusLabel(status)) + '</p>' +
        (explanation ? '<p class="notice">' + esc(explanation) + '</p>' : '') +
        taskProgressPanel +
        (status === 'running' ? '<div data-live-answer hidden><p class="muted"></p><pre></pre></div>' : '') +
        (answer ? '<pre data-answer></pre>' : '') +
        (request?.stopReason === 'length' ? '<p class="muted">The model reached its output limit.</p>' : '') +
        (request?.approvedSourceLookup ? '<p class="muted">Approved source lookup enabled.</p>' : '') +
        (pi ? '<p class="muted">Request usage · ' + esc(usageText(request?.usage)) + '</p><p class="muted">' +
          esc(pi.context.estimatedTokens.toLocaleString()) + ' active context tokens' +
          (pi.context.historyCompacted ? ' · Older turns compacted' : '') + '</p>' + sessionUsage(pi) : '') +
        (savedPrompt || savedSource ? '<details data-saved-task><summary>Saved task and source</summary>' +
          (savedPrompt ? '<pre data-saved-prompt></pre>' : '') +
          (savedSource ? '<div class="coding-preview stack" data-saved-source></div>' : '') + '</details>' :
          references.length ? '<details><summary>Source references</summary><ul>' + references.map((entry) =>
            '<li><code>' + esc(entry.path + ':' + entry.startLine + '–' + entry.endLine) + '</code></li>').join('') + '</ul></details>' : '') +
        '<div class="row" data-run-actions></div></div>';
      showTaskProgress(inspectEl.querySelector('[data-task-progress]'), progress, status === 'running');
      if (answer) inspectEl.querySelector('[data-answer]').textContent = answer;
      if (status === 'running') showLiveAnswer(inspectEl.querySelector('[data-live-answer]'), active.liveAnswer);
      if (savedPrompt) inspectEl.querySelector('[data-saved-prompt]').textContent = savedPrompt;
      if (savedSource) previewContents(inspectEl.querySelector('[data-saved-source]'), savedSource);
      const bar = inspectEl.querySelector('[data-run-actions]');
      if (receipt?.text) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy response';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(receipt.text);
            historyFeedback.textContent = 'Response copied.';
          } catch (error) { report(historyFeedback, error); }
        });
        bar.append(copy);
      }
      if (readonly) return;
      if (status === 'running' || pending) addRunAction(bar, 'Cancel request', 'cancel');
      if (pending && status !== 'running') {
        const confirm = document.createElement('label');
        confirm.className = 'row';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.disabled = catalog.find((entry) => entry.provider === binding?.provider)?.credential === 'missing';
        confirm.append(check, 'Approve sending the saved task, source, and active history to ' + providerName(binding?.provider || '') + '.');
        bar.before(confirm);
        addRunAction(bar, 'Resume request', 'resume', check);
      }
    }

    function showLiveAnswer(element, answer) {
      element.hidden = !answer;
      const caption = answer?.truncated ? 'Response in progress · Preview limit reached' : 'Response in progress';
      const heading = element.querySelector('p');
      const text = element.querySelector('pre');
      if (heading.textContent !== caption) heading.textContent = caption;
      if (text.textContent !== (answer?.text || '')) text.textContent = answer?.text || '';
    }

    function addRunAction(bar, label, action, approval) {
      const session = sessionName;
      const target = requestId;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = !!approval;
      approval?.addEventListener('change', () => { button.disabled = !approval.checked; });
      bar.append(button);
      button.addEventListener('click', async () => {
        if (session !== sessionName || target !== requestId || deleting || runActionPending || (approval && !approval.checked)) return;
        button.disabled = true;
        runActionPending = true;
        updateControls();
        report(historyFeedback);
        try {
          await coding(prefix + '/' + action, { session, requestId: target, ...(approval ? { approved: true } : {}) });
          if (!detached() && session === sessionName && target === requestId) {
            inspected = undefined;
            await inspect();
          }
        } catch (error) { if (!detached() && session === sessionName) report(historyFeedback, error); }
        finally {
          runActionPending = false;
          button.disabled = !!approval && !approval.checked;
          updateControls();
        }
      });
    }

    async function inspect() {
      clearTimeout(timer);
      const current = ++generation;
      if (detached() || (deleting && sessionName)) return;
      if (!sessionName) {
        showRequests([]);
        showInspection({}, false);
        return;
      }
      try {
        const result = await coding(prefix + '/inspect', { session: sessionName, ...(requestId ? { requestId } : {}) });
        if (detached() || current !== generation) return;
        sessionState = result.state || (result.identity ? 'ready' : '');
        if (sessionState === 'deleting') {
          requestId = '';
          deletePanel.open = !readonly;
        }
        fillBinding(result.identity || binding);
        running = result.active?.status === 'running' || result.state === 'busy';
        pendingWork = !!result.pi?.pendingRequestIds.length;
        updateControls();
        const requests = [...(result.requests || [])];
        const knownActive = result.active?.requestId;
        if (knownActive && !requests.some((entry) => entry.requestId === knownActive))
          requests.unshift({ requestId: knownActive, status: result.active.status });
        if ((!requestId && requests.length) || (running && knownActive && knownActive !== requestId)) {
          requestId = knownActive || requests[0].requestId;
          showRequests(requests);
          return inspect();
        }
        showRequests(requests);
        showInspection(result, result.pi?.pendingRequestIds.includes(requestId) === true);
        if (running) timer = setTimeout(inspect, 1200);
      } catch (error) {
        if (detached() || current !== generation) return;
        pendingWork = true;
        if (sessions.some((entry) => entry.session === sessionName && entry.state === 'unavailable')) {
          sessionState = 'unavailable';
        }
        updateControls();
        report(historyFeedback, error);
      }
    }

    async function selectSession(value) {
      sessionName = value;
      requestId = '';
      binding = null;
      running = false;
      pendingWork = false;
      sessionState = '';
      deleteInput.value = '';
      deletePanel.open = false;
      controls.session.value = value || 'main';
      controls.requestId.value = crypto.randomUUID();
      controls.workspace.value = '';
      controls.prompt.value = '';
      controls.approvedSourceLookup.checked = false;
      syncProviderList();
      invalidate();
      showRequests([]);
      inspectEl.replaceChildren();
      inspected = undefined;
      report(historyFeedback);
      await inspect();
    }

    async function refresh(initial = false) {
      if (refreshing || deleting) return;
      refreshing = true;
      updateControls();
      report(historyFeedback);
      try {
        const response = await coding(prefix);
        if (detached()) return;
        catalog = response.models;
        sessions = response.sessions;
        syncProviderList();
        if (initial && sessions.length) {
          await selectSession(sessions[0].session);
          if (detached()) return;
        } else await inspect();
        showSessions();
      } catch (error) { if (!detached()) report(historyFeedback, error); }
      finally { refreshing = false; updateControls(); }
    }

    deleteInput.addEventListener('input', updateControls);
    deleteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (deleteButton.disabled || !sessionName) return;
      const session = sessionName;
      const confirmation = deleteInput.value;
      deleting = true;
      deleteInput.value = '';
      requestId = '';
      ++generation;
      clearTimeout(timer);
      showRequests([]);
      inspectEl.replaceChildren();
      inspected = undefined;
      invalidate();
      historyFeedback.textContent = 'Deleting standalone session…';
      try {
        await coding(prefix + '/delete-session', { session, confirm: confirmation });
        if (detached()) return;
        sessions = sessions.filter((entry) => entry.session !== session);
        await selectSession('');
        showSessions();
        historyFeedback.textContent = 'Deleted standalone session ' + session + '.';
      } catch (error) {
        deleting = false;
        if (!detached()) {
          await inspect();
          report(historyFeedback, error);
        }
      } finally {
        deleting = false;
        if (!detached()) {
          updateControls();
          if (sessionName) deleteInput.focus();
          else sessionsSelect.focus();
        }
      }
    });

    form.addEventListener('input', (event) => { if (event.target !== controls.approved) invalidate(); });
    controls.approved.addEventListener('change', updateControls);
    controls.source.addEventListener('change', syncSource);
    controls.provider.addEventListener('change', () => syncModels());
    controls.model.addEventListener('change', () => syncThinking());
    sessionsSelect.addEventListener('change', () => { void selectSession(sessionsSelect.value); });
    requestsSelect.addEventListener('change', () => {
      requestId = requestsSelect.value;
      setResetSession?.(null);
      inspected = undefined;
      inspectEl.replaceChildren();
      report(historyFeedback);
      void inspect();
    });
    refreshButton.addEventListener('click', () => { void refresh(); });
    previewButton.addEventListener('click', async () => {
      if (!controls.workspace.reportValidity()) return;
      invalidate();
      const current = revision;
      previewing = true;
      updateControls();
      report(feedback);
      feedback.textContent = 'Reading selected source…';
      try {
        const selection = sourceInput();
        const result = await coding(prefix + '/preview', selection);
        if (detached() || revision !== current) return;
        previewContents(previewContent, result);
        if (result.source === 'repository' && !result.excerpts.length) return;
        if (readonly || !form.checkValidity()) return;
        preview = {
          ...selection,
          previewId: result.id || result.manifest?.id,
          session: controls.session.value, requestId: controls.requestId.value,
          provider: controls.provider.value, model: controls.model.value, prompt: controls.prompt.value,
          ...(controls.thinkingLevel.value ? { thinkingLevel: controls.thinkingLevel.value } : {}),
          ...(controls.approvedSourceLookup.checked ? { approvedSourceLookup: true } : {}),
        };
        approve.querySelector('span').textContent = 'Approve sending the task, selected source, and active history to ' +
          providerName(preview.provider) + '.' + (preview.approvedSourceLookup ? ' Allow line lookups in the selected source.' : '');
        approve.hidden = false;
        controls.approved.focus();
      } catch (error) { if (!detached() && revision === current) report(feedback, error); }
      finally {
        previewing = false;
        if (feedback.textContent === 'Reading selected source…') report(feedback);
        updateControls();
      }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (send.disabled) return;
      const approved = preview;
      const previousSession = sessionName;
      busy = true;
      updateControls();
      report(feedback);
      try {
        const result = await coding(prefix + '/run', { ...approved, approved: true });
        if (detached() || previousSession !== sessionName) return;
        sessionName = result.session;
        requestId = result.requestId;
        // Keep the admitted binding stable while Pi holds the transcript lock.
        fillBinding({
          session: sessionName, workspace: approved.workspace, provider: approved.provider,
          model: approved.model, ...(approved.thinkingLevel ? { thinkingLevel: approved.thinkingLevel } : {}),
        });
        showSessions();
        inspectEl.replaceChildren();
        inspected = undefined;
        if (result.status !== 'failed') controls.requestId.value = crypto.randomUUID();
        if (result.status !== 'failed') controls.approvedSourceLookup.checked = false;
        invalidate();
        offerRun(result);
        await inspect();
      } catch (error) { if (!detached() && previousSession === sessionName) report(feedback, error); }
      finally { busy = false; updateControls(); }
    });

    function offerRun(active) {
      running = active.status === 'running';
      showRequests([{ requestId: active.requestId, status: active.status }]);
      showInspection({ active, identity: binding }, false);
    }

    if (readonly) feedback.textContent = 'This brain mount is read-only.';
    syncSource();
    await refresh(true);
  }

  window.okbCodingStandalone = { mount };
})();
