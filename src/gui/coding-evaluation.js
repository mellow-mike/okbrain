/* Private evaluation records use saved run inputs and recorded Pi usage. */
(function () {
  'use strict';

  const strategyLabels = { files: 'Explicit files', lexical: 'Lexical', indexed: 'Indexed profile', packages: 'Package reviews' };
  const decisions = { accepted: 'Accepted', changes_requested: 'Changes requested' };
  const number = (value) => value === null ? '—' : value.toLocaleString();
  const reference = ({ path, startLine, endLine }) => path + ':' + startLine + (startLine === endLine ? '' : '–' + endLine);

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

  function composerOptions(slot, readonly) {
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
    const update = () => { fields.hidden = fields.disabled = !enroll.checked; };
    enroll.disabled = readonly;
    enroll.addEventListener('change', update);
    update();
    return {
      enabled: () => enroll.checked,
      value() {
        if (!enroll.checked) return undefined;
        const series = fields.querySelector('[name=evaluation-series]').value.trim();
        const task = fields.querySelector('[name=evaluation-task]').value.trim();
        const evidence = fields.querySelector('textarea').value.split('\n').map((item) => item.trim()).filter(Boolean);
        return { series, task, evidence };
      },
    };
  }

  function summaryGroup(group) {
    const panel = element('article', undefined, 'stack coding-panel');
    const heading = group.series + ' · ' + (strategyLabels[group.strategy] || group.strategy);
    panel.append(element('h4', heading));
    if (group.origin === 'injected') panel.append(element('p', 'Injected provider measurements', 'muted'));
    panel.append(
      element('p', group.attempts + ' attempts · ' + group.reviewed + ' reviewed · ' + group.accepted + ' accepted'),
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

  function mount(parent, { prefix, coding, readonly, detached }) {
    const panel = element('details', undefined, 'coding-panel coding-evaluations');
    panel.innerHTML = '<summary>Evaluation results</summary><div class="stack coding-form">' +
      '<div class="row"><button type="button" class="small" data-refresh>Refresh evaluations</button>' +
      '<button type="button" class="small" data-copy disabled>Copy metrics as JSON</button></div>' +
      '<div class="stack" data-groups></div><div class="stack coding-runs" data-attempts></div>' +
      '<div class="stack" data-detail></div><p class="coding-feedback" role="status"></p></div>';
    parent.append(panel);
    const groups = panel.querySelector('[data-groups]');
    const attempts = panel.querySelector('[data-attempts]');
    const detail = panel.querySelector('[data-detail]');
    const feedback = panel.querySelector('[role=status]');
    const copy = panel.querySelector('[data-copy]');
    let report;
    let selected;
    let reportGeneration = 0;
    let detailGeneration = 0;

    function message(text, error = false) {
      feedback.classList.toggle('error', error);
      feedback.textContent = text;
    }

    const requestIdentity = (attempt) => ({ session: attempt.session, requestId: attempt.requestId });
    const attemptKey = (attempt) => JSON.stringify([attempt.session, attempt.requestId]);

    async function loadReport() {
      const current = ++reportGeneration;
      try {
        const result = await coding(prefix + '/evaluations');
        if (detached() || current !== reportGeneration) return;
        report = result;
        copy.disabled = !report.groups.length;
        groups.replaceChildren();
        attempts.replaceChildren();
        if (!report.attempts.length) {
          groups.append(element('p', 'Enroll a new request in Independent evaluation to start measuring.', 'muted'));
          return;
        }
        if (report.truncated) groups.append(element('p', 'Metrics cover the most recent 200 evaluation attempts.', 'muted'));
        groups.append(element('p', report.provider + ' · ' + report.model, 'muted'), ...report.groups.map(summaryGroup));
        for (const attempt of report.attempts) {
          const button = element('button', undefined, 'coding-run');
          button.type = 'button';
          button.disabled = attempt.status !== 'done' && attempt.status !== 'unanswered';
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
      detail.replaceChildren(element('p', 'Loading saved evaluation source…', 'muted'));
      try {
        const result = await coding(prefix + '/evaluation-inspect', requestIdentity(attempt));
        if (detached() || current !== detailGeneration) return;
        const heading = element('h4', result.attempt.task + ' · Evaluation');
        const source = element('details');
        source.append(element('summary', 'Approved source used for this request'));
        if (!result.sources.length) source.append(element('p', 'No source was attached.', 'muted'));
        for (const part of result.sources) source.append(disclosure(reference(part), part.content));
        detail.replaceChildren(heading, disclosure('Task sent to the provider', result.task),
          disclosure('Model response', result.response || result.unansweredReason || 'No response was saved.'), source, reviewForm(result));
        if (focus) {
          heading.tabIndex = -1;
          heading.focus();
        }
      } catch (error) {
        if (!detached() && current === detailGeneration) detail.replaceChildren(element('p', error.message, 'error'));
      }
    }

    panel.addEventListener('toggle', () => { if (panel.open) void loadReport(); });
    panel.querySelector('[data-refresh]').addEventListener('click', () => loadReport());
    copy.addEventListener('click', async () => {
      if (!report) return;
      const { provider, model, groups, truncated } = report;
      try {
        await navigator.clipboard.writeText(JSON.stringify({ provider, model, groups, truncated }, null, 2));
        message('Evaluation metrics copied.');
      } catch (error) { message(error.message, true); }
    });
  }

  window.okbCodingEvaluation = { composerOptions, mount };
})();
