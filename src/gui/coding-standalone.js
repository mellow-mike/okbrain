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

  function disclosure(title, children) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = title;
    details.append(summary, ...children);
    return details;
  }

  function textBlock(value) {
    const block = document.createElement('pre');
    block.textContent = value;
    return block;
  }

  function rankedCandidates(rows) {
    const list = document.createElement('ul');
    list.className = 'stack';
    for (const row of rows) {
      const item = document.createElement('li');
      const name = document.createElement('code');
      name.textContent = row.path + ':' + row.startLine + '–' + row.endLine + ' · ' + row.name;
      const lanes = Object.entries(row.lanes).map(([key, value]) => key + ' ' + value).join(' · ');
      item.append(name, ' · ' + (row.selected ? 'selected' : 'candidate') + ' · ' + row.slot + ' · score ' + row.evidence,
        document.createElement('br'), lanes);
      list.append(item);
    }
    return disclosure('Ranked source candidates', [list]);
  }

  function savedGroups(panel, input) {
    if (input.guidance) panel.append(disclosure('Saved project guidance', [textBlock(input.guidance)]));
    for (const group of input.groups) {
      const section = document.createElement('section');
      section.className = 'stack';
      if (group.label) {
        const heading = document.createElement('h5');
        heading.textContent = group.label;
        section.append(heading);
      }
      for (const file of group.files) {
        const lines = file.startLine === undefined ? '' : ':' + file.startLine + '–' + file.endLine;
        section.append(disclosure(file.path + lines, [textBlock(file.text)]));
      }
      for (const [label, lines] of [['Saved repository map', group.map], ['Saved repository facts', group.facts],
        ['Links to other work orders', group.interfaces]]) {
        if (lines?.length) section.append(disclosure(label, [textBlock(lines.join('\n'))]));
      }
      for (const file of group.deferred || [])
        section.append(disclosure('On request · ' + file.path + ':' + file.startLine + '–' + file.endLine, [textBlock(file.text)]));
      panel.append(section);
    }
  }

  function mountLearnReview(parent, identity, coding, entries, active, refresh, report) {
    const form = document.createElement('form');
    form.className = 'stack coding-form';
    form.innerHTML = '<label class="field"><span>Review outcome</span><select name="outcome">' +
      '<option value="accepted">Accepted</option><option value="changes_requested">Changes requested</option></select></label>' +
      '<label class="field"><span>Additional files used (optional)</span><input name="used" placeholder="Comma-separated paths" spellcheck="false"></label>' +
      '<div class="row"><button type="submit">Record review for the repository map</button></div><p role="status"></p>';
    const button = form.querySelector('button');
    const feedback = form.querySelector('[role="status"]');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (button.disabled || !active()) return;
      button.disabled = true;
      feedback.textContent = 'Recording review…';
      const used = entries(form.elements.used.value);
      try {
        const result = await coding(prefix + '/repository', { ...identity, action: 'learn', outcome: form.elements.outcome.value,
          ...(used.length ? { used } : {}) });
        if (!active()) return;
        const rows = result.learned || [];
        const summary = rows.length ? rows.map((row) => row.learned ? row.requestId + ' recorded · lane weights ' + row.laneUpdate
          : row.requestId + ' already recorded · decision updated').join('. ') : 'No repository map learning was recorded for this request.';
        feedback.textContent = summary + (result.routes ? ' Updated ' + result.routes + ' model route outcomes.' : '');
        void refresh();
      } catch (error) { if (active()) report(feedback, error); }
      finally { button.disabled = false; }
    });
    parent.before(disclosure('Teach the repository map from this review', [form]));
  }

  function mountRepositoryMap(panel, { coding, readonly, detached, entries, field, workspace, changed }) {
    panel.innerHTML = '<summary>Repository map settings</summary><div class="stack coding-form">' +
      '<p class="muted">Manage the map for this workspace. Import reads tracked files and identifies declared checks.</p>' +
      '<div class="row"><button type="button" data-map-refresh>Refresh map</button>' +
      (readonly ? '' : '<button type="button" data-map-cancel hidden>Cancel import</button>') + '</div>' +
      '<p data-map-feedback role="status"></p><div class="stack" data-map-info></div>' +
      (readonly ? '' : '<form class="stack" data-map-import><div class="coding-grid">' +
        field('Directories to import', '', 'text', 'name="directories" placeholder="Whole repository" spellcheck="false"') +
        field('History commits', '', 'number', 'name="history" min="0" step="1" placeholder="2000"') + '</div>' +
        '<label class="row"><input type="checkbox" name="full"><span>Read every file again and rebuild term statistics</span></label>' +
        '<div class="row"><button type="submit">Import repository map</button></div></form>' +
        '<div class="stack" data-map-learning hidden><form class="stack" data-map-lesson>' +
        '<label class="field"><span>Lesson for future requests</span><textarea name="text" rows="2" maxlength="600" required></textarea></label>' +
        field('Lesson paths (optional)', '', 'text', 'name="anchors" placeholder="Comma-separated paths" spellcheck="false"') +
        '<div class="row"><button type="submit">Record lesson</button></div></form>' +
        '<details><summary>Manage learned state</summary><form class="stack coding-form" data-map-forget>' +
        field('Session to forget', '', 'text', 'name="session" maxlength="64" spellcheck="false" required') +
        '<div class="row"><button type="submit">Forget session episodes</button>' +
        '<button type="button" data-map-rollback>Roll back parameters</button>' +
        '<button type="button" class="danger" data-map-reset>Reset all learning</button></div></form></details></div>') +
      '<div class="stack" data-map-skills></div></div>';
    const info = panel.querySelector('[data-map-info]');
    const skills = panel.querySelector('[data-map-skills]');
    const feedback = panel.querySelector('[data-map-feedback]');
    const refreshButton = panel.querySelector('[data-map-refresh]');
    const cancel = panel.querySelector('[data-map-cancel]');
    const importForm = panel.querySelector('[data-map-import]');
    const lessons = panel.querySelector('[data-map-lesson]');
    const forget = panel.querySelector('[data-map-forget]');
    const learning = panel.querySelector('[data-map-learning]');
    const importButton = importForm?.querySelector('button');
    let current = '';
    let state;
    let busy = '';
    let timer;
    let revision = 0;
    const isRunning = () => ['running', 'cancelling'].includes(state?.status);

    function controls() {
      refreshButton.disabled = !current || Boolean(busy);
      if (importButton) importButton.disabled = !current || Boolean(busy) || isRunning();
      if (cancel) {
        cancel.hidden = !isRunning();
        cancel.disabled = Boolean(busy) || state?.status === 'cancelling';
      }
      if (learning) learning.hidden = !state?.imported;
      for (const button of panel.querySelectorAll('[data-map-learning] button, [data-map-skills] button'))
        button.disabled = Boolean(busy) || isRunning();
    }

    function renderSkills(rows) {
      const list = document.createElement('ul');
      list.className = 'stack';
      for (const skill of rows || []) {
        const item = document.createElement('li');
        item.className = 'stack';
        const title = document.createElement('strong');
        title.textContent = skill.title;
        const metadata = document.createElement('p');
        metadata.className = 'muted';
        metadata.textContent = skill.id + ' · ' + skill.kind + ' · ' + skill.state + ' · delivered ' +
          skill.shownAccepted + '/' + skill.shown + ' accepted · withheld ' + skill.withheldAccepted + '/' + skill.withheld +
          (skill.confidence === undefined ? '' : ' · ' + Math.round(skill.confidence * 100) + '% likely to help');
        item.append(title, metadata);
        if (!readonly) {
          const action = document.createElement('button');
          action.type = 'button';
          action.className = 'small';
          action.textContent = skill.state === 'disabled' ? (skill.kind === 'built-in' ? 'Enable' : 'Enable on trial') : 'Disable';
          action.setAttribute('aria-label', action.textContent + ' ' + skill.title);
          action.addEventListener('click', () => void mutate({ action: 'skills', id: skill.id,
            state: skill.state === 'disabled' ? 'trial' : 'disabled' }, 'Skill delivery updated.'));
          const row = document.createElement('div');
          row.className = 'row';
          row.append(action);
          item.append(row);
        }
        list.append(item);
      }
      const wasOpen = skills.querySelector('details')?.open;
      skills.replaceChildren();
      if (list.children.length) {
        const items = disclosure('Skills and lessons (' + list.children.length + ')', [list]);
        items.open = Boolean(wasOpen);
        skills.append(items);
      }
      controls();
    }

    function render(next, message = '') {
      const previous = state;
      state = next;
      const progress = next.progress;
      const label = next.status === 'running' ? 'Importing' : next.status === 'cancelling' ? 'Cancelling import' : '';
      feedback.textContent = message || next.error || (label ? label + (progress ? ' · ' + progress.phase + ' ' + progress.done + '/' + progress.total : '…')
        : next.status === 'cancelled' ? 'Repository import cancelled.' : next.status === 'completed' ? 'Repository map imported.' : '');
      if (previous && previous.meta?.generation !== next.meta?.generation) changed();
      const meta = next.meta;
      info.replaceChildren();
      const description = document.createElement('p');
      description.textContent = meta ? meta.files + ' tracked files · ' + meta.units + ' source units · ' + meta.packages + ' packages' +
        (meta.revision ? ' · ' + meta.revision.slice(0, 12) : '') : 'This repository has no completed map yet.';
      info.append(description);
      if (next.knowledge) info.append(textBlock(next.knowledge));
      if (next.packages?.length) info.append(disclosure('Largest packages', [textBlock(next.packages.map((item) =>
        item.root + ' · ' + item.name + ' (' + item.ecosystem + ') · ' + item.files + ' files').join('\n'))]));
      if (next.learning) {
        const { episodes, accepted, aliases, pendingAliases, params } = next.learning;
        const lanes = Object.entries(params.lanes).map(([name, weight]) => name + ' ' + weight.toFixed(2)).join(' · ');
        info.append(disclosure('Learning · ' + episodes + ' reviews', [textBlock(accepted + ' accepted · ' + aliases + ' active aliases · ' +
          pendingAliases + ' awaiting confirmation\nParameters v' + params.version + '\n' + lanes)]));
      }
      if (next.report) {
        const r = next.report;
        const limited = Object.entries(r.limitsReached).filter(([, value]) => value).map(([limit]) => limit);
        info.append(disclosure('Last import report', [textBlock(r.changedFiles + ' read · ' + r.unchangedFiles + ' unchanged · ' +
          r.removedFiles + ' removed · ' + r.skippedFiles + ' skipped · ' + r.durationMs + ' ms\n' + r.importEdges + ' import links · ' +
          r.testEdges + ' test links · ' + r.couplingEdges + ' change links across ' + r.historyCommits + ' commits · ' +
          r.tools + ' declared commands' + (limited.length ? '\nLimits reached · ' + limited.join(', ') : ''))]));
      }
      renderSkills(next.skills);
    }

    function workspaceChanged() {
      const next = workspace();
      if (next === current) return;
      current = next;
      ++revision;
      clearTimeout(timer);
      busy = '';
      state = undefined;
      info.replaceChildren();
      skills.replaceChildren();
      feedback.textContent = current ? '' : 'Enter a workspace path to view its repository map.';
      controls();
      void refresh();
    }

    async function run(input, message = '') {
      clearTimeout(timer);
      if (busy || !current || detached()) return;
      const version = revision;
      busy = input.action;
      controls();
      try {
        const result = await coding(prefix + '/repository', { workspace: current, ...input });
        if (detached() || version !== revision) return;
        if (input.action === 'import' || input.action === 'cancel' || input.action === 'status') render(result, message);
        else {
          if (input.action === 'skills') renderSkills(result);
          changed();
          const refreshed = await coding(prefix + '/repository', { workspace: current, action: 'status' });
          if (!detached() && version === revision) render(refreshed, typeof message === 'function' ? message(result) : message);
        }
        return result;
      } catch (error) { if (!detached() && version === revision) feedback.textContent = error.message; }
      finally {
        if (version === revision) {
          busy = '';
          controls();
          if (panel.open && isRunning() && !detached()) timer = setTimeout(refresh, 700);
        }
      }
    }

    function refresh() {
      if (panel.open && !busy) return run({ action: 'status' });
    }

    function mutate(input, message) {
      if (!readonly && !busy && (input.action === 'cancel' || !isRunning())) return run(input, message);
    }

    panel.addEventListener('toggle', () => { if (panel.open) void refresh(); else clearTimeout(timer); });
    refreshButton.addEventListener('click', refresh);
    cancel?.addEventListener('click', () => void mutate({ action: 'cancel' }));
    importForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const projects = entries(importForm.elements.directories.value);
      const history = importForm.elements.history.value;
      void mutate({ action: 'import', ...(projects.length ? { projects } : {}),
        ...(history ? { historyCommits: Number(history) } : {}), ...(importForm.elements.full.checked ? { full: true } : {}) });
    });
    lessons?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const activeRevision = revision;
      const anchors = entries(lessons.elements.anchors.value);
      const result = await mutate({ action: 'lesson', text: lessons.elements.text.value, ...(anchors.length ? { anchors } : {}) },
        ({ created, id }) => created ? 'Lesson ' + id + ' recorded on trial.' : 'The existing lesson was kept.');
      if (result && revision === activeRevision) lessons.reset();
    });
    forget?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (confirm('Forget the recorded episodes for this session?'))
        void mutate({ action: 'forget', session: forget.elements.session.value }, ({ episodes }) => 'Forgot ' + episodes + ' session episodes.');
    });
    forget?.querySelector('[data-map-rollback]').addEventListener('click', () => {
      void mutate({ action: 'forget', rollback: true }, ({ rollback, params }) => rollback
        ? 'Restored the best readout parameters as v' + params + '.' : 'Nothing has been learned for this repository.');
    });
    forget?.querySelector('[data-map-reset]').addEventListener('click', () => {
      if (confirm('Delete all learning for this repository? Its map and knowledge bundle will be kept.'))
        void mutate({ action: 'forget', everything: true, confirm: true }, ({ reset }) => reset
          ? 'Deleted all learned state.' : 'Nothing had been learned for this repository.');
    });
    feedback.textContent = 'Enter a workspace path to view its repository map.';
    controls();
    return { workspaceChanged, refresh };
  }

  async function mount(parent, { coding, readonly, detached, defaultModels, entries, field, previewContents, mountSourceManifest,
    report, sessionUsage, usageText, contextSummary, showTaskProgress, taskProgressPanel, mountContextControls, mountRunCopies,
    sourceLookupSummary, mountTree }) {
    const header = parent.querySelector('header');
    header.innerHTML = '<div class="row coding-project-links"><a href="#coding">Project workspace</a></div>' +
      '<h2 class="display">Standalone sessions</h2><p class="muted">Open sessions from this app or the CLI.</p>';
    const grid = document.createElement('div');
    grid.className = 'coding-workspace-grid coding-standalone-grid';
    grid.innerHTML = '<aside class="work-sidebar-slot" data-standalone-side></aside>' +
      '<section class="coding-panel stack" data-standalone-composer><h3>New request</h3><form class="stack">' +
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
      '<option value="repository">Tracked repository excerpts</option><option value="atlas">Repository map</option>' +
      '<option value="orchestrated">Orchestrated repository plan</option></select></label>' +
      '<div class="stack" data-files>' + field('Workspace-relative files', '', 'text', 'name="files" spellcheck="false" placeholder="src/app.ts, README.md"') +
      '<p class="muted">Separate paths with commas. Leave empty to send only the task and active history.</p></div>' +
      '<div class="stack" data-repository hidden>' +
      field('Search source', '', 'search', 'name="query" maxlength="1024" placeholder="Identifier, path, or terms"') +
      '<details><summary>Scope and budget</summary><div class="stack coding-form">' +
      field('Directories', '.', 'text', 'name="projects" spellcheck="false"') +
      field('Estimated excerpt tokens', '4096', 'number', 'name="contextTokens" min="1" max="16384"') +
      '<label class="field"><span>Project profile (optional JSON)</span><textarea name="profile" rows="3" spellcheck="false"></textarea></label>' +
      '</div></details></div>' +
      '<div class="stack" data-map-scope hidden><div class="coding-grid">' +
      field('Map directories', '', 'text', 'name="mapProjects" spellcheck="false" placeholder="All imported directories"') +
      field('Map token budget', '4096', 'number', 'name="mapBudget" min="1" max="16384"') + '</div></div>' +
      '<div class="stack" data-atlas hidden>' +
      field('Map search text', '', 'search', 'name="mapQuery" maxlength="2048" placeholder="Defaults to the task"') +
      field('Exclude map directories', '', 'text', 'name="mapExclude" spellcheck="false" placeholder="Comma-separated directories"') +
      '<label class="row"><input name="mapDeferred" type="checkbox"><span>Also approve further excerpts the model may look up by path and line</span></label></div>' +
      '<div class="stack" data-orchestrated hidden>' +
      '<label class="field"><span>Workers</span><select name="mapWorkers"><option value="auto">Decide from the task</option>' +
      '<option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>' +
      '<label class="field"><span>Routing policy (optional JSON)</span><textarea name="mapRouting" rows="4" spellcheck="false"></textarea></label></div>' +
      '<label class="row" data-file-lookup><input name="approvedSourceLookup" type="checkbox"><span>Let the model look up lines within the approved source</span></label>' +
      '<div class="row"><button type="button" data-preview disabled>Preview source</button></div>' +
      '<div class="coding-preview stack" data-preview-content aria-live="polite"></div>' +
      '<label class="row" data-approve hidden><input type="checkbox" name="approved"><span></span></label>' +
      '<div class="row"><button type="submit" class="primary" disabled>Send request</button></div>' +
      '<p class="muted" data-send-compaction-notice hidden>Finish local compaction in Run history before sending in this session.</p>' +
      '<div class="coding-feedback" role="status"></div></form><details data-standalone-map></details></section>' +
      '<section class="coding-panel stack" data-standalone-history><div class="row"><h3>Run history</h3><button type="button" class="small right" data-refresh>Refresh sessions</button></div>' +
      '<label class="field"><span>Saved session</span><select data-sessions><option value="">Loading sessions…</option></select></label>' +
      '<label class="field" data-request-picker hidden><span>Saved request</span><select data-requests></select></label>' +
      '<div data-inspect class="stack" aria-live="polite"></div>' +
      '<div data-standalone-checks></div>' +
      (readonly ? '' : '<section class="stack" data-context-controls hidden></section>') +
      '<details data-delete-session hidden><summary>Delete standalone session</summary><form class="stack coding-form">' +
      '<p>Permanently delete the saved requests, source snapshots, and responses for <code data-delete-name></code> from this device.</p>' +
      '<p class="muted" data-delete-state></p><label class="field"><span>Type the session name to confirm</span>' +
      '<input name="confirmation" maxlength="64" autocomplete="off" spellcheck="false" required></label>' +
      '<div class="row"><button type="submit" class="danger" disabled>Delete session</button></div></form></details>' +
      '<div data-history-feedback class="coding-feedback" role="status"></div></section>';
    parent.append(grid);

    const form = grid.querySelector('form');
    const composerPanel = grid.querySelector('[data-standalone-composer]');
    const controls = form.elements;
    const feedback = form.querySelector('[role="status"]');
    const credential = form.querySelector('[data-credential]');
    const previewButton = form.querySelector('[data-preview]');
    const previewContent = form.querySelector('[data-preview-content]');
    const approve = form.querySelector('[data-approve]');
    const send = form.querySelector('button[type="submit"]');
    const compactionNotice = form.querySelector('[data-send-compaction-notice]');
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
    let compactionPending = false;
    let sessionState = '';
    let preview = null;
    let revision = 0;
    let generation = 0;
    let timer;
    let inspected;
    let refreshTree;
    const repository = mountRepositoryMap(grid.querySelector('[data-standalone-map]'), {
      coding, readonly, detached, entries, field, workspace: () => controls.workspace.value.trim(),
      changed() {
        if (['atlas', 'orchestrated'].includes(controls.source.value)) invalidate();
        void refreshTree?.();
      },
    });
    const contextPanel = grid.querySelector('[data-context-controls]');
    const setContextSession = contextPanel ? mountContextControls(contextPanel, {
      prefix, detached, provider: () => providerName(binding?.provider),
      markCompactionPending,
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

    function attachmentChange() {
      composerPanel.dispatchEvent(new Event('coding-attachments'));
    }

    composerPanel.attachedTrackedFile = (path) => controls.source.value === 'files' && entries(controls.files.value).includes(path);
    composerPanel.toggleTrackedFile = (path) => {
      if (readonly || running || busy) return;
      const attached = controls.source.value === 'files' ? entries(controls.files.value) : [];
      const hasPath = attached.includes(path);
      if (!hasPath && attached.length >= 12) {
        report(feedback, new Error('Attach at most 12 workspace files per request.'));
        return;
      }
      controls.source.value = 'files';
      controls.files.value = (hasPath ? attached.filter((item) => item !== path) : attached.concat(path)).join(', ');
      syncSource();
      report(feedback);
    };

    const sidebar = grid.querySelector('[data-standalone-side]');
    const declared = grid.querySelector('[data-standalone-checks]');
    refreshTree = mountTree?.(sidebar, {
      readonly, detached, composerPanel,
      readFiles() {
        const workspace = controls.workspace.value.trim();
        return workspace ? coding(prefix + '/repository', { workspace, action: 'files' }) : { paths: [], limited: false, commands: [] };
      },
      showCommands(commands) {
        declared.replaceChildren();
        if (!commands?.length) return;
        const list = document.createElement('ul');
        list.className = 'stack';
        for (const command of commands) {
          const item = document.createElement('li');
          item.textContent = command.name + ' · ' + command.source.path + ':' + command.source.line;
          item.append(textBlock(JSON.stringify(command.argv)));
          list.append(item);
        }
        declared.append(disclosure('Declared repository checks', [list]));
      },
    });
    if (!mountTree) sidebar.hidden = true;

    function workspaceUpdated() {
      repository.workspaceChanged();
      void refreshTree?.();
    }

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
      compactionNotice.hidden = !compactionPending;
      send.disabled = readonly || previewButton.disabled || compactionPending || !preview || !form.checkValidity() ||
        !controls.approved.checked || (preview.source !== 'orchestrated' && key !== 'saved' && key !== 'environment');
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
      setContextSession?.(sessionState === 'ready' && !busy && !running && !pendingWork && !refreshing &&
        !runActionPending && !deleting ? sessionName : null, compactionPending);
    }

    function invalidate() {
      ++revision;
      preview = null;
      controls.approved.checked = false;
      approve.hidden = true;
      previewContent.replaceChildren();
      updateControls();
    }

    function markCompactionPending(name, pending) {
      if (name !== sessionName || pending === compactionPending) return;
      compactionPending = pending;
      controls.approvedSourceLookup.checked = false;
      invalidate();
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
      workspaceUpdated();
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
      const mode = controls.source.value;
      const mapped = mode === 'atlas' || mode === 'orchestrated';
      for (const group of ['files', 'repository', 'atlas', 'orchestrated', 'map-scope', 'file-lookup']) {
        const fields = form.querySelector('[data-' + group + ']');
        fields.hidden = group === 'map-scope' ? !mapped : group === 'file-lookup' ? mapped : mode !== group;
        fields.querySelectorAll('input, textarea, select').forEach((control) => { control.disabled = fields.hidden; });
      }
      previewButton.textContent = mode === 'orchestrated' ? 'Preview plan' : 'Preview source';
      invalidate();
      attachmentChange();
    }

    function sourceInput() {
      const workspace = controls.workspace.value.trim();
      const source = controls.source.value;
      if (source === 'atlas' || source === 'orchestrated') {
        const projects = entries(controls.mapProjects.value);
        const budget = controls.mapBudget.value;
        const prompt = controls.prompt.value;
        const input = { workspace, source, ...(prompt.trim() ? { prompt } : {}), ...(projects.length ? { projects } : {}),
          ...(budget ? { contextTokens: Number(budget) } : {}) };
        if (source === 'atlas') {
          const exclude = entries(controls.mapExclude.value);
          const query = controls.mapQuery.value.trim();
          return { ...input, ...(query ? { query } : {}), ...(exclude.length ? { exclude } : {}),
            ...(controls.mapDeferred.checked ? { deferred: true } : {}) };
        }
        const routingText = controls.mapRouting.value.trim();
        let routing;
        if (routingText) {
          try { routing = JSON.parse(routingText); }
          catch (_) { throw new Error('Enter valid JSON for the routing policy.'); }
          if (!routing || typeof routing !== 'object' || Array.isArray(routing)) throw new Error('Enter a JSON object for the routing policy.');
        }
        const workers = controls.mapWorkers.value;
        return { ...input, provider: controls.provider.value, model: controls.model.value,
          ...(controls.thinkingLevel.value ? { thinkingLevel: controls.thinkingLevel.value } : {}),
          workers: workers === 'auto' ? workers : Number(workers), ...(routing ? { routing } : {}) };
      }
      if (source === 'files') {
        const files = entries(controls.files.value);
        if (!files.length && controls.approvedSourceLookup.checked)
          throw new Error('Choose at least one file to allow source lookup.');
        return { workspace, source: 'files', files };
      }
      const query = controls.query.value.trim();
      if (!query) throw new Error('Enter a query to select repository excerpts.');
      const budget = controls.contextTokens.value;
      if (controls.profile.value.trim()) {
        let profile;
        try { profile = JSON.parse(controls.profile.value); }
        catch (_) { throw new Error('Enter valid JSON for the project profile.'); }
        if (!profile || typeof profile !== 'object' || Array.isArray(profile))
          throw new Error('Enter a JSON object for the project profile.');
        return { workspace, source, query, profile, ...(budget ? { contextTokens: Number(budget) } : {}) };
      }
      const projects = entries(controls.projects.value);
      return { workspace, source, query, projects, ...(budget ? { contextTokens: Number(budget) } : {}) };
    }

    function showRequests(requests) {
      const next = requests.map((entry) => [entry.requestId, entry.requestId + ' · ' + statusLabel(entry.status)]);
      const prior = Array.from(requestsSelect.options, (option) => [option.value, option.textContent]);
      if (JSON.stringify(next) !== JSON.stringify(prior))
        requestsSelect.replaceChildren(...next.map(([id, label]) => new Option(label, id)));
      requestPicker.hidden = !next.length;
      if (requestId) requestsSelect.value = requestId;
    }

    function showInspection({ pi, active, identity, state, report: runReport, savedInput }, pending) {
      const request = pi?.request;
      const savedSource = request?.savedSource;
      const savedPrompt = request?.savedPrompt ?? savedInput?.prompt;
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
      const snapshot = JSON.stringify({ pi, active, identity, state, pending, requestId, runReport, savedInput });
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
        (answer ? '<pre data-answer></pre>' : '') + '<div class="row" data-run-copy-actions hidden></div>' +
        (request?.stopReason === 'length' ? '<p class="muted">The model reached its output limit.</p>' : '') +
        sourceLookupSummary(request) +
        (pi ? '<p class="muted">Request usage · ' + esc(usageText(request?.usage)) + '</p>' +
          contextSummary(pi.context) + sessionUsage(pi) : '') +
        (savedPrompt || savedSource || savedInput ? '<details data-saved-task><summary>Saved task and source</summary>' +
          (savedPrompt ? '<pre data-saved-prompt></pre>' : '') +
          (savedSource || savedInput ? '<div class="coding-preview stack" data-saved-source></div>' : '') + '</details>' :
          references.length ? '<details><summary>Source references</summary><ul>' + references.map((entry) =>
            '<li><code>' + esc(entry.path + ':' + entry.startLine + '–' + entry.endLine) + '</code></li>').join('') + '</ul></details>' : '') +
        '<div class="row" data-run-actions></div></div>';
      showTaskProgress(inspectEl.querySelector('[data-task-progress]'), progress, status === 'running');
      if (answer) inspectEl.querySelector('[data-answer]').textContent = answer;
      mountRunCopies(inspectEl.querySelector('[data-run-copy-actions]'), {
        answer, runReport, session: sessionName, requestId, status, feedback: historyFeedback,
      });
      if (status === 'running') showLiveAnswer(inspectEl.querySelector('[data-live-answer]'), active.liveAnswer);
      if (savedPrompt) inspectEl.querySelector('[data-saved-prompt]').textContent = savedPrompt;
      if (savedSource) previewContents(inspectEl.querySelector('[data-saved-source]'), savedSource);
      else if (savedInput) savedGroups(inspectEl.querySelector('[data-saved-source]'), savedInput);
      const bar = inspectEl.querySelector('[data-run-actions]');
      if (readonly) return;
      if (status === 'done' && identity?.workspace && (request?.repositoryContext?.atlas || receipt?.orchestration)) {
        const reviewed = { workspace: identity.workspace, session: sessionName, requestId };
        mountLearnReview(bar, reviewed, coding, entries,
          () => !detached() && sessionName === reviewed.session && requestId === reviewed.requestId, repository.refresh, report);
      }
      if (status === 'running' || pending) addRunAction(bar, 'Cancel request', 'cancel');
      if (pending && status !== 'running') {
        const confirm = document.createElement('label');
        confirm.className = 'row';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.disabled = !savedInput && catalog.find((entry) => entry.provider === binding?.provider)?.credential === 'missing';
        confirm.append(check, savedInput ? 'Approve sending the saved task and source under the approved plan.'
          : 'Approve sending the saved task, source, and active history to ' + providerName(binding?.provider || '') + '.');
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
        if (result.pi && !readonly) markCompactionPending(sessionName, result.pi.context?.compactionPending === true);
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
      compactionPending = false;
      sessionState = '';
      deleteInput.value = '';
      deletePanel.open = false;
      controls.session.value = value || 'main';
      controls.requestId.value = crypto.randomUUID();
      controls.workspace.value = '';
      workspaceUpdated();
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
    controls.workspace.addEventListener('change', workspaceUpdated);
    controls.files.addEventListener('input', attachmentChange);
    controls.approved.addEventListener('change', updateControls);
    controls.source.addEventListener('change', syncSource);
    controls.provider.addEventListener('change', () => syncModels());
    controls.model.addEventListener('change', () => syncThinking());
    sessionsSelect.addEventListener('change', () => { void selectSession(sessionsSelect.value); });
    requestsSelect.addEventListener('change', () => {
      requestId = requestsSelect.value;
      setContextSession?.(null);
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
        const result = await coding(prefix + '/preview', selection.source === 'orchestrated' ? { ...selection, requestId: controls.requestId.value } : selection);
        if (detached() || revision !== current) return;
        previewContents(previewContent, result);
        if (result.ranked?.length) previewContent.append(rankedCandidates(result.ranked));
        mountSourceManifest(previewContent, result, feedback);
        if (['repository', 'atlas'].includes(result.source) && !result.excerpts.length) return;
        if (result.source === 'orchestrated' && !result.plan?.orders.length) return;
        if (readonly || !form.checkValidity()) return;
        preview = {
          ...selection,
          previewId: result.id || result.manifest?.id,
          session: controls.session.value, requestId: controls.requestId.value,
          provider: controls.provider.value, model: controls.model.value, prompt: controls.prompt.value,
          ...(controls.thinkingLevel.value ? { thinkingLevel: controls.thinkingLevel.value } : {}),
          ...(!controls.approvedSourceLookup.disabled && controls.approvedSourceLookup.checked ? { approvedSourceLookup: true } : {}),
        };
        approve.querySelector('span').textContent = preview.source === 'orchestrated'
          ? 'Approve sending the task and selected source under this plan to the providers shown.'
          : 'Approve sending the task, selected source, and active history to ' + providerName(preview.provider) + '.' +
            (preview.approvedSourceLookup || preview.deferred ? ' Allow the line lookups shown in this preview.' : '');
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
        if (result.status !== 'failed') controls.mapDeferred.checked = false;
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
