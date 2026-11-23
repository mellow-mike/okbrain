(function () {
  'use strict';

  const runtime = 'okbrain/csv-aggregate-v1';
  const sample = {
    parameters: [{ name: 'year', type: 'integer', required: true }],
    executor: { source: 'data/revenue.csv', operation: 'sum', column: 'cents',
      filters: [{ column: 'year', parameter: 'year' }] },
  };
  const formatted = (value) => JSON.stringify(value, null, 2);

  function parameterInput({ name, type }) {
    const label = document.createElement('label');
    const text = document.createElement('span');
    label.className = 'field';
    text.textContent = name + ' (' + type + ')';
    let input;
    if (type === 'boolean') {
      input = document.createElement('select');
      input.append(new Option('Choose a value', ''), new Option('True', 'true'), new Option('False', 'false'));
      input.required = true;
    } else {
      input = document.createElement('input');
      input.type = type === 'integer' ? 'number' : 'text';
      if (type === 'integer') {
        input.required = true;
        input.step = '1';
      } else input.maxLength = 256;
    }
    label.append(text, input);
    return { name, type, input, label };
  }

  function mount(panel, { id, frontmatter, readonly, api, detached, reload }) {
    const current = frontmatter.runtime;
    panel.className = 'card stack';
    if ((current && current !== runtime) || readonly) {
      panel.innerHTML = '<h3>Computation</h3><p class="muted"></p>';
      panel.querySelector('p').textContent = current && current !== runtime ? 'This runtime is available for reference.'
        : 'Open a writable brain to use local computation.';
      return;
    }

    const ready = current === runtime && Array.isArray(frontmatter.parameters) && frontmatter.parameters.length <= 4
      && frontmatter.parameters.every((field) => field && typeof field.name === 'string' && ['string', 'integer', 'boolean'].includes(field.type));
    panel.innerHTML = '<h3>Computation</h3>' +
      '<details data-config' + (ready ? '' : ' open') + '><summary>Configure CSV computation</summary><form class="stack">' +
      '<p class="muted">Place a CSV in this brain folder, enter its relative path, and declare the count or integer sum and any typed filters.</p>' +
      '<label class="field"><span>CSV contract (JSON)</span><textarea name="contract" rows="8" required spellcheck="false"></textarea></label>' +
      '<div class="row"><button type="submit">Save CSV contract</button></div></form></details>' +
      (ready ? '<form class="stack" data-params><div data-fields></div><div class="row">' +
        '<button type="submit">Preview computation</button></div></form>' +
        '<div data-preview hidden><div class="stack"><pre data-plan></pre><details open><summary>Exact CSV source</summary>' +
        '<pre data-csv></pre></details>' +
        '<label class="row"><input data-compute-approval type="checkbox"><span>Approve this contract, source, and parameter values</span></label>' +
        '<div class="row"><button type="button" data-compute disabled>Run approved computation</button></div></div></div>' +
        '<form class="stack" data-verify><label class="field"><span>Computation receipt (JSON)</span><textarea name="receipt" rows="7" required spellcheck="false"></textarea></label>' +
        '<div class="row"><button type="submit">Verify receipt</button></div></form>' +
        '<div data-verified hidden><div class="stack"><p data-outcome></p>' +
        '<label class="row"><input data-attest-approval type="checkbox"><span>Approve recording the verified result on this concept</span></label>' +
        '<div class="row"><button type="button" data-attest disabled>Record process verification</button></div></div></div>' : '') +
      '<p role="status" data-computation-status></p>';
    const status = panel.querySelector('[data-computation-status]');
    const configuration = panel.querySelector('[data-config] form');
    configuration.elements.contract.value = formatted(ready ? { parameters: frontmatter.parameters, executor: frontmatter.executor } : sample);

    async function perform(button, action) {
      button.disabled = true;
      status.className = 'muted';
      status.textContent = '';
      try { await action(); }
      catch (error) {
        if (detached()) return;
        status.className = 'error';
        status.textContent = error.message;
      } finally { button.disabled = false; }
    }

    configuration.addEventListener('submit', (event) => {
      event.preventDefault();
      perform(configuration.querySelector('button'), async () => {
        await api('computation_configure', { id, contract: configuration.elements.contract.value });
        if (!detached()) reload();
      });
    });
    if (!ready) return;

    const paramsForm = panel.querySelector('[data-params]');
    const parameters = frontmatter.parameters.map(parameterInput);
    paramsForm.querySelector('[data-fields]').append(...parameters.map(({ label }) => label));
    const preview = panel.querySelector('[data-preview]');
    const compute = panel.querySelector('[data-compute]');
    const computeApproval = panel.querySelector('[data-compute-approval]');
    const verifyForm = panel.querySelector('[data-verify]');
    const receipt = verifyForm.elements.receipt;
    const verified = panel.querySelector('[data-verified]');
    const attest = panel.querySelector('[data-attest]');
    const attestApproval = panel.querySelector('[data-attest-approval]');
    let revision = 0;
    let receiptRevision = 0;
    let plan;
    let attestation;

    function clearPreview() {
      revision++;
      plan = undefined;
      preview.hidden = compute.disabled = true;
      computeApproval.checked = false;
    }
    function clearVerification() {
      receiptRevision++;
      attestation = undefined;
      verified.hidden = attest.disabled = true;
      attestApproval.checked = false;
    }
    paramsForm.addEventListener('input', clearPreview);
    receipt.addEventListener('input', clearVerification);
    computeApproval.addEventListener('change', () => { compute.disabled = !computeApproval.checked; });
    attestApproval.addEventListener('change', () => { attest.disabled = !attestApproval.checked; });

    paramsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      clearPreview();
      const revisionAtStart = revision;
      const values = JSON.stringify(Object.fromEntries(parameters.map(({ name, type, input }) =>
        [name, type === 'integer' ? Number(input.value) : type === 'boolean' ? input.value === 'true' : input.value])));
      perform(paramsForm.querySelector('button'), async () => {
        const reviewed = await api('computation_preview', { id, parameters: values });
        if (detached() || revisionAtStart !== revision) return;
        const { text, ...source } = reviewed.source;
        preview.querySelector('[data-plan]').textContent = formatted({ contract: reviewed.contract, parameters: reviewed.parameters, source });
        preview.querySelector('[data-csv]').textContent = text;
        plan = { id, parameters: values, approval: reviewed.approval };
        preview.hidden = false;
        computeApproval.focus();
      });
    });
    compute.addEventListener('click', () => {
      if (!plan || !computeApproval.checked) return;
      const revisionAtStart = revision;
      perform(compute, async () => {
        const result = await api('computation_run', plan);
        if (detached() || revisionAtStart !== revision) return;
        clearVerification();
        receipt.value = formatted(result);
        status.textContent = 'Computed ' + result.result.value + ' from ' + result.result.matchedRows + ' matching rows.';
        verifyForm.querySelector('button').focus();
      }).finally(() => { compute.disabled = !plan || !computeApproval.checked; });
    });
    verifyForm.addEventListener('submit', (event) => {
      event.preventDefault();
      clearVerification();
      const revisionAtStart = receiptRevision;
      const claimed = receipt.value;
      perform(verifyForm.querySelector('button'), async () => {
        const outcome = await api('computation_verify', { id, receipt: claimed });
        if (detached() || receiptRevision !== revisionAtStart) return;
        attestation = { id, receipt: claimed, approval: outcome.approval, confirm: true };
        verified.querySelector('[data-outcome]').textContent =
          'Recomputed and verified ' + outcome.receipt.result.value + ' from the original source.';
        verified.hidden = false;
        attestApproval.focus();
      });
    });
    attest.addEventListener('click', () => {
      if (!attestation || !attestApproval.checked) return;
      perform(attest, async () => {
        await api('computation_attest', attestation);
        if (!detached()) reload();
      }).finally(() => { attest.disabled = !attestation || !attestApproval.checked; });
    });
  }

  window.okbComputation = { mount };
})();
