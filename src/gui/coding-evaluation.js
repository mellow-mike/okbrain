/* Private evaluation records use saved run inputs and recorded Pi usage. */
(function () {
  'use strict';

  const strategyLabels = { files: 'Explicit files', lexical: 'Lexical', indexed: 'Indexed profile', packages: 'Package reviews' };
  const decisions = { accepted: 'Accepted', changes_requested: 'Changes requested' };
  const number = (value) => value === null ? '—' : value.toLocaleString();
  const reference = ({ path, startLine, endLine }, dash = '–') => path + ':' + startLine + (startLine === endLine ? '' : dash + endLine);

  function element(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }

  function disclosure(name, text) {
    const details = element('details');
    details.append(element('summary', name), element('pre', text));
    return details;
  }

  function composerOptions(slot, { readonly, invalidate, coding, prefix, detached, loadPinnedCase }) {
    const details = element('details');
    details.innerHTML = '<summary>Independent evaluation</summary><div class="stack coding-form">' +
      '<label class="row"><input type="checkbox" data-enroll> Include this request in a measurement series</label>' +
      '<fieldset class="stack" data-case hidden><legend>Evaluation case</legend>' +
      '<div class="coding-grid"><label class="field"><span>Series ID</span><input name="evaluation-series" required maxlength="64" ' +
      'placeholder="vite-v7" spellcheck="false"></label>' +
      '<label class="field"><span>Task ID</span><input name="evaluation-task" required maxlength="64" placeholder="hmr-lifecycle" spellcheck="false"></label></div>' +
      '<label class="field"><span>Expected citations</span><textarea name="evaluation-targets" rows="3" required maxlength="24576" ' +
      'placeholder="src/client.ts:12-18"></textarea></label>' +
      '<p class="muted">Enter one workspace path and line range per line. A different project member will verify citations against the saved preview. These fields stay with the evaluation record.</p>' +
      '</fieldset></div>';
    slot.append(details);
    const enroll = details.querySelector('[data-enroll]');
    const fields = details.querySelector('[data-case]');
    const series = fields.querySelector('[name=evaluation-series]');
    const task = fields.querySelector('[name=evaluation-task]');
    const citations = fields.querySelector('textarea');
    const update = () => { fields.hidden = fields.disabled = !enroll.checked; };
    enroll.disabled = readonly;
    enroll.addEventListener('change', () => {
      update();
      invalidate();
    });
    fields.addEventListener('input', invalidate);
    fields.addEventListener('change', invalidate);
    update();
    mountPinnedRubric(fields.parentElement, { readonly, coding, prefix, detached, loadPinnedCase });
    return {
      load(saved) {
        series.value = saved.series;
        task.value = saved.task;
        citations.value = saved.evidence.map((item) => typeof item === 'string' ? item : reference(item, '-')).join('\n');
        enroll.checked = true;
        details.open = true;
        update();
      },
      value() {
        if (!enroll.checked) return undefined;
        const evidence = citations.value.split('\n').map((item) => item.trim()).filter(Boolean);
        return { series: series.value.trim(), task: task.value.trim(), evidence };
      },
    };
  }

  function mountPinnedRubric(parent, { readonly, coding, prefix, detached, loadPinnedCase }) {
    const disclosure = element('details');
    disclosure.innerHTML = '<summary>Pinned Vite benchmark</summary><div class="stack coding-form">' +
      '<p class="muted">Use a coding project rooted at a clean checkout of this exact Vite revision.</p>' +
      '<div class="muted" data-benchmark-metadata hidden><p data-benchmark-revision></p><p data-benchmark-repository></p></div>' +
      '<div class="coding-grid"><label class="field"><span id="benchmark-study-label">Benchmark study</span>' +
      '<select aria-labelledby="benchmark-study-label" data-study disabled></select></label>' +
      '<label class="field"><span id="benchmark-case-label">Benchmark case</span>' +
      '<select aria-labelledby="benchmark-case-label" data-task disabled></select></label>' +
      '<label class="field"><span id="benchmark-strategy-label">Benchmark strategy</span>' +
      '<select aria-labelledby="benchmark-strategy-label" data-strategy disabled>' +
      '<option value="files">Explicit files</option><option value="lexical">Lexical</option>' +
      '<option value="indexed">Indexed profile</option></select></label></div>' +
      '<p data-task-description hidden></p><div class="row"><button type="button" disabled>Use pinned case</button></div>' +
      '<p class="coding-feedback" role="status"></p></div>';
    parent.append(disclosure);
    const studySelect = disclosure.querySelector('[data-study]');
    const taskSelect = disclosure.querySelector('[data-task]');
    const strategySelect = disclosure.querySelector('[data-strategy]');
    const description = disclosure.querySelector('[data-task-description]');
    const apply = disclosure.querySelector('button');
    const feedback = disclosure.querySelector('[role="status"]');
    let studies;
    let loading = false;
    const selectedStudy = () => studies?.find(({ id }) => id === studySelect.value);
    const selectedTask = () => selectedStudy()?.tasks.find(({ id }) => id === taskSelect.value);

    function showTask() {
      const task = selectedTask();
      description.textContent = task?.description ?? '';
      description.hidden = !description.textContent;
      apply.disabled = readonly || !task;
    }
    function showStudy() {
      const previous = taskSelect.value;
      const tasks = selectedStudy()?.tasks ?? [];
      taskSelect.replaceChildren(...tasks.map(({ id }) => new Option(id, id)));
      if (tasks.some(({ id }) => id === previous)) taskSelect.value = previous;
      taskSelect.disabled = !tasks.length;
      strategySelect.disabled = !tasks.length;
      showTask();
    }
    disclosure.addEventListener('toggle', async () => {
      if (!disclosure.open || studies || loading || detached()) return;
      loading = true;
      feedback.classList.remove('error');
      feedback.textContent = 'Loading the pinned Vite benchmark…';
      try {
        const result = await coding(prefix + '/evaluation-rubric');
        if (detached() || !disclosure.isConnected) return;
        if (result?.version !== 1 || !Array.isArray(result.studies) || !result.studies.length)
          throw new Error('The pinned Vite benchmark could not be loaded.');
        studies = result.studies;
        disclosure.querySelector('[data-benchmark-revision]').textContent = result.tag + ' · ' + result.revision;
        disclosure.querySelector('[data-benchmark-repository]').textContent = result.repository;
        disclosure.querySelector('[data-benchmark-metadata]').hidden = false;
        studySelect.replaceChildren(...studies.map(({ label, id }) => new Option(label, id)));
        studySelect.disabled = false;
        showStudy();
        feedback.textContent = '';
      } catch (error) {
        if (detached() || !disclosure.isConnected) return;
        feedback.classList.add('error');
        feedback.textContent = error.message;
      } finally { loading = false; }
    });
    studySelect.addEventListener('change', showStudy);
    taskSelect.addEventListener('change', showTask);
    apply.addEventListener('click', () => {
      if (apply.disabled || detached()) return;
      const study = selectedStudy();
      const task = selectedTask();
      if (!task) return;
      const loaded = loadPinnedCase(study, task, strategySelect.value);
      feedback.classList.toggle('error', !loaded);
      feedback.textContent = loaded ? '' : 'Wait for the current request to finish sending before loading this pinned case.';
    });
  }

  function summaryGroup(group) {
    const panel = element('article', undefined, 'stack coding-panel');
    const heading = group.series + ' · ' + (strategyLabels[group.strategy] || group.strategy);
    panel.append(element('h4', heading));
    if (group.origin === 'injected') panel.append(element('p', 'Injected provider measurements', 'muted'));
    panel.append(
      element('p', group.attempts + (group.attempts === 1 ? ' attempt · ' : ' attempts · ') + group.reviewed + ' reviewed · ' + group.accepted + ' accepted'),
      element('p', group.cases + (group.cases === 1 ? ' distinct task' : ' distinct tasks'), 'muted'),
      element('p', group.evidenceVerified + '/' + group.evidenceExpected + ' expected citations verified'),
      element('p', 'Preview p50 / p95 ' + number(group.previewP50) + ' / ' + number(group.previewP95) + ' ms · ' + group.previewCount + ' measured', 'muted'),
      element('p', 'Mean approved source ' + number(group.meanSourceBytes) + ' bytes from reviewed runs', 'muted'),
      element('p', [number(group.tokens.input) + ' input', number(group.tokens.output) + ' output',
        number(group.tokens.cacheRead) + ' cache read', number(group.tokens.cacheWrite) + ' cache write'].join(' · '), 'muted'),
      element('p', 'Recorded tokens per accepted result ' + number(group.tokensPerAccepted) + ' · ' + group.usageRecorded + '/' + group.reviewed + ' reviewed runs with usage'),
    );
    return panel;
  }

  function mount(parent, { prefix, coding, readonly, detached, canLoadCase, loadCase }) {
    const panel = element('details', undefined, 'coding-panel coding-evaluations');
    panel.innerHTML = '<summary>Evaluation results</summary><div class="stack coding-form">' +
      '<div class="row"><button type="button" class="small" data-refresh>Refresh evaluations</button>' +
      '<button type="button" class="small" data-copy disabled>Copy metrics as JSON</button></div>' +
      '<label class="field" data-metrics-fallback hidden><span>Evaluation metrics JSON</span>' +
      '<textarea rows="8" readonly spellcheck="false"></textarea></label>' +
      '<div class="stack" data-groups></div><div class="stack coding-runs" data-attempts></div>' +
      '<div class="stack" data-detail></div><p class="coding-feedback" role="status"></p></div>';
    parent.append(panel);
    const groups = panel.querySelector('[data-groups]');
    const attempts = panel.querySelector('[data-attempts]');
    const detail = panel.querySelector('[data-detail]');
    const feedback = panel.querySelector('[role=status]');
    const copy = panel.querySelector('[data-copy]');
    const fallback = panel.querySelector('[data-metrics-fallback]');
    const jsonField = fallback.querySelector('textarea');
    let report;
    let selected;
    let reportGeneration = 0;
    let detailGeneration = 0;
    let copyGeneration = 0;
    let loadingReport = false;

    function message(text, error = false) {
      feedback.classList.toggle('error', error);
      feedback.textContent = text;
    }

    const requestIdentity = (attempt) => ({ session: attempt.session, requestId: attempt.requestId });
    const attemptKey = (attempt) => JSON.stringify([attempt.session, attempt.requestId]);
    const settled = (attempt) => attempt.status === 'done' || attempt.status === 'unanswered';

    function clearMetricsFallback() {
      ++copyGeneration;
      fallback.hidden = true;
      jsonField.value = '';
    }

    async function loadReport() {
      const current = ++reportGeneration;
      loadingReport = true;
      const useCase = detail.querySelector('[data-use-evaluation-case]');
      if (useCase) useCase.disabled = true;
      try {
        const result = await coding(prefix + '/evaluations');
        if (detached() || current !== reportGeneration) return;
        clearMetricsFallback();
        report = result;
        copy.disabled = !report.groups.length;
        groups.replaceChildren();
        attempts.replaceChildren();
        if (selected && !report.attempts.some((attempt) => settled(attempt) && attemptKey(attempt) === selected)) {
          selected = undefined;
          ++detailGeneration;
          detail.replaceChildren();
        }
        if (!report.attempts.length) {
          groups.append(element('p', 'Enroll a new request in Independent evaluation to start measuring.', 'muted'));
          return;
        }
        if (report.truncated) groups.append(element('p', 'Metrics cover the most recent 200 evaluation attempts.', 'muted'));
        groups.append(element('p', report.provider + ' · ' + report.model, 'muted'), ...report.groups.map(summaryGroup));
        for (const attempt of report.attempts) {
          const button = element('button', undefined, 'coding-run');
          button.type = 'button';
          button.disabled = !settled(attempt);
          const labels = element('span');
          labels.append(element('strong', attempt.series + ' / ' + attempt.task),
            element('span', attempt.session + ' · ' + attempt.requestId, 'muted'));
          const status = decisions[attempt.decision] || (button.disabled ? attempt.status : 'Awaiting review');
          button.append(labels, element('span', status));
          button.setAttribute('aria-pressed', String(selected === attemptKey(attempt)));
          button.addEventListener('click', async () => {
            selected = attemptKey(attempt);
            for (const other of attempts.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
            await openReview(attempt);
          });
          attempts.append(button);
        }
      } catch (error) {
        if (!detached() && current === reportGeneration) message(error.message, true);
      } finally {
        if (!detached() && current === reportGeneration) {
          loadingReport = false;
          const button = detail.querySelector('[data-use-evaluation-case]');
          if (button) button.disabled = false;
        }
      }
    }

    function reviewForm(result) {
      const { attempt, evidencePresent } = result;
      const form = element('form', undefined, 'stack');
      const canReview = !readonly && attempt.canReview;
      const evidence = element('fieldset', undefined, 'stack');
      evidence.append(element('legend', 'Expected citations'));
      const checks = [];
      for (const [index, target] of attempt.evidence.entries()) {
        const covered = evidencePresent.includes(index);
        const label = element('label', undefined, 'row');
        const check = element('input');
        check.type = 'checkbox';
        check.checked = attempt.verified.includes(index);
        check.disabled = !canReview || !covered;
        checks.push(check);
        label.append(check, element('span', reference(target) + (covered ? '' : ' · Missing from saved source')));
        evidence.append(label);
      }
      form.append(evidence);
      if (attempt.reviewer) form.append(element('p', decisions[attempt.decision] + ' by ' + attempt.reviewer, 'muted'));
      if (!canReview) {
        if (!attempt.reviewer && !readonly) form.append(element('p', 'A different authenticated project member can record this evaluation.', 'muted'));
        return form;
      }
      const label = element('label', undefined, 'field');
      const decision = element('select');
      decision.required = true;
      decision.append(new Option('Choose a decision', ''), new Option('Accept result', 'accepted'), new Option('Request changes', 'changes_requested'));
      decision.value = attempt.decision || '';
      label.append(element('span', 'Evaluation decision'), decision);
      const save = element('button', 'Save independent evaluation', 'primary');
      save.type = 'submit';
      form.append(label, element('p', 'Confirm a citation only if the response supports it with the approved source. Acceptance requires all expected citations.', 'muted'), save);
      let saving = false;
      const update = () => {
        decision.options[1].disabled = attempt.status !== 'done' || checks.some((check) => !check.checked);
        if (decision.value === 'accepted' && decision.options[1].disabled) decision.value = '';
        save.disabled = saving || !decision.value;
      };
      form.addEventListener('change', update);
      update();
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (save.disabled) return;
        saving = true;
        update();
        try {
          await coding(prefix + '/evaluation-review', {
            ...requestIdentity(attempt), decision: decision.value,
            verified: checks.flatMap((check, index) => check.checked ? [index] : []),
          });
          if (detached()) return;
          message('Independent evaluation saved.');
          await loadReport();
          if (selected === attemptKey(attempt)) await openReview(attempt, false);
        } catch (error) {
          message(error.message, true);
        } finally { saving = false; update(); }
      });
      return form;
    }

    async function openReview(attempt, focus = true) {
      const current = ++detailGeneration;
      const expected = attemptKey(attempt);
      const isCurrent = () => !detached() && panel.isConnected && panel.open && selected === expected && current === detailGeneration;
      detail.replaceChildren(element('p', 'Loading saved evaluation source…', 'muted'));
      try {
        const result = await coding(prefix + '/evaluation-inspect', requestIdentity(attempt));
        if (!isCurrent()) return;
        if (attemptKey(result.attempt) !== expected || !settled(result.attempt)) throw new Error('Refresh the evaluation before opening this case.');
        const heading = element('h4', result.attempt.task + ' · Evaluation');
        const source = element('details');
        source.append(element('summary', 'Approved source used for this request'));
        if (!result.sources.length) source.append(element('p', 'No source was attached.', 'muted'));
        for (const part of result.sources) source.append(disclosure(reference(part), part.content));
        const controls = [heading];
        if (!readonly && loadCase && canLoadCase?.() && typeof result.task === 'string' && result.task.trim() && result.attempt.evidence.length) {
          const actions = element('div', undefined, 'row');
          const button = element('button', 'Use evaluation case', 'small');
          button.type = 'button';
          button.dataset.useEvaluationCase = '';
          button.disabled = loadingReport;
          button.addEventListener('click', () => {
            if (!isCurrent() || loadingReport || !button.isConnected || !canLoadCase()) return;
            const { series, task, evidence } = result.attempt;
            if (!loadCase({ prompt: result.task, series, task, evidence })) {
              message('Wait for the current request to finish sending before loading this evaluation case.', true);
              return;
            }
            message('');
          });
          actions.append(button);
          controls.push(actions);
        }
        detail.replaceChildren(...controls, disclosure('Task sent to the provider', result.task),
          disclosure('Model response', result.response || result.unansweredReason || 'No response was saved.'), source, reviewForm(result));
        if (focus) {
          heading.tabIndex = -1;
          heading.focus();
        }
      } catch (error) {
        if (isCurrent()) detail.replaceChildren(element('p', error.message, 'error'));
      }
    }

    panel.addEventListener('toggle', () => {
      if (panel.open) void loadReport();
      else clearMetricsFallback();
    });
    panel.querySelector('[data-refresh]').addEventListener('click', () => loadReport());
    copy.addEventListener('click', async () => {
      if (!report || copy.disabled) return;
      const current = ++copyGeneration;
      const isCurrent = () => !detached() && panel.isConnected && panel.open && current === copyGeneration;
      const { provider, model, groups, truncated } = report;
      const json = JSON.stringify({ provider, model, groups, truncated }, null, 2);
      try {
        await navigator.clipboard.writeText(json);
        if (!isCurrent()) return;
        clearMetricsFallback();
        message('Evaluation metrics copied.');
      } catch {
        if (!isCurrent()) return;
        jsonField.value = json;
        fallback.hidden = false;
        jsonField.focus();
        jsonField.select();
        message('Clipboard unavailable. Copy the selected evaluation metrics JSON.');
      }
    });
  }

  window.okbCodingEvaluation = { composerOptions, mount };
})();
