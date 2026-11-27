/* Registry-backed forms for the same operations and parameters used by the CLI. */
(function () {
  'use strict';

  const effect = {
    graph_data: 'Include all graph data, including private notes, in this result.',
    export_viz: 'Write a graph viewer to the brain folder.',
    ask: 'Send the question and the notes selected for it to the configured model.',
  };

  function parameterControl(spec) {
    const label = document.createElement('label');
    label.className = spec.type === 'boolean' ? 'row' : 'field';
    const caption = document.createElement('span');
    caption.textContent = (spec.positional ? spec.name : '--' + spec.name) + ' · ' + spec.description;
    const secret = spec.name === 'connection';
    const multiline = spec.type === 'string' && !secret;
    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.name = spec.name;
    input.required = Boolean(spec.required);
    if (multiline) input.rows = 2;
    else input.type = secret ? 'password' : spec.type === 'boolean' ? 'checkbox' : 'number';
    if (spec.type === 'int') input.step = '1';
    if (secret) input.autocomplete = 'off';
    if (spec.type === 'boolean') label.append(input, caption);
    else label.append(caption, input);

    let empty;
    if (multiline && !input.required) {
      const option = document.createElement('label');
      option.className = 'row muted';
      empty = document.createElement('input');
      empty.type = 'checkbox';
      empty.setAttribute('aria-label', 'Send an empty value for ' + spec.name);
      empty.addEventListener('change', () => { input.disabled = empty.checked; });
      option.append(empty, 'Send an empty value');
      const group = document.createElement('div');
      group.className = 'stack';
      group.append(label, option);
      return { node: group, read: () => empty.checked ? '' : input.value || undefined };
    }
    return { node: label, read: () => spec.type === 'boolean' ? input.checked || undefined
      : spec.type === 'int' ? (input.value ? input.valueAsNumber : undefined) : input.value || undefined,
      ...(secret ? { clear: () => { input.value = ''; } } : {}) };
  }

  function mount(panel, { api, headers, readonly, saveFile, detached, readAnswerEvents }) {
    panel.innerHTML = '<summary>Advanced operations</summary><div class="stack brain-mount-body">' +
      '<p class="muted">Run an operation with the same parameters as the <code>okb</code> CLI and inspect its JSON result.</p>' +
      '<label class="field"><span>Operation</span><select data-command disabled></select></label>' +
      '<form class="stack" hidden><p data-summary></p><div class="stack" data-parameters></div>' +
      '<label class="row" data-confirm hidden><input name="confirm-operation" type="checkbox"><span></span></label>' +
      '<div class="row"><button type="submit" class="primary">Run operation</button>' +
      '<button type="button" data-stop hidden>Stop answer</button></div></form>' +
      '<p role="status"></p><pre data-result hidden></pre><div class="row"><button data-download type="button" hidden>Save JSON</button></div></div>';
    const select = panel.querySelector('[data-command]');
    const form = panel.querySelector('form');
    const parameters = panel.querySelector('[data-parameters]');
    const consent = panel.querySelector('[data-confirm]');
    const approval = consent.querySelector('input');
    const submit = form.querySelector('[type="submit"]');
    const stop = panel.querySelector('[data-stop]');
    const status = panel.querySelector('[role="status"]');
    const output = panel.querySelector('[data-result]');
    const download = panel.querySelector('[data-download]');
    let commands;
    let current;
    let fields = [];
    let unavailable = Boolean(readonly);
    let busy = false;
    let stream;

    function clearResult() {
      output.textContent = '';
      output.hidden = download.hidden = true;
    }

    function choose() {
      current = commands.find(({ name }) => name === select.value);
      fields = [];
      clearResult();
      status.textContent = '';
      form.hidden = !current;
      if (!current) return;
      fields = current.params.map((spec) => ({ ...parameterControl(spec), name: spec.name }));
      parameters.replaceChildren(...fields.map(({ node }) => node));
      form.querySelector('[data-summary]').textContent = current.summary;
      const confirmation = effect[current.name] || (current.scope === 'read' ? '' : 'Run this operation on the selected brain.');
      consent.hidden = !confirmation;
      consent.querySelector('span').textContent = confirmation;
      approval.required = Boolean(confirmation);
      approval.checked = false;
    }

    async function load() {
      if (commands || !panel.open || busy) return;
      busy = true;
      status.textContent = 'Loading operations…';
      try {
        const response = await fetch('/api/local/commands', { headers: headers(), cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load operations.');
        if (detached()) return;
        commands = data.commands;
        unavailable ||= data.readonly === true;
        select.replaceChildren(new Option('Choose an operation', ''), ...commands.map((command) => {
          const option = new Option(command.cliName, command.name);
          option.disabled = unavailable && command.scope !== 'read';
          return option;
        }));
        select.disabled = false;
        status.textContent = unavailable ? 'This brain is read-only. Operations that write are unavailable.' : '';
      } catch (error) {
        if (!detached()) status.textContent = error.message;
      } finally { busy = false; }
    }

    async function runStream(input) {
      stream = new AbortController();
      stop.hidden = false;
      output.hidden = false;
      const response = await fetch('/api/ask/stream', {
        method: 'POST', headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(input), signal: stream.signal,
      });
      let result;
      await readAnswerEvents(response, (event, data) => {
        if (detached()) { stream.abort(); return; }
        if (event === 'delta') output.append(data.text);
        if (event === 'done') {
          const { draftReceipt: _receipt, ...answer } = data.result;
          result = answer;
        }
      });
      return result;
    }

    panel.addEventListener('toggle', () => {
      if (panel.open) void load();
      else stream?.abort();
    });
    select.addEventListener('change', choose);
    form.addEventListener('input', (event) => { if (event.target !== approval) approval.checked = false; });
    stop.addEventListener('click', () => stream?.abort());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!current || busy || detached() || !form.reportValidity() || (unavailable && current.scope !== 'read')) return;
      const input = {};
      for (const field of fields) {
        const value = field.read();
        if (value !== undefined) input[field.name] = value;
        field.clear?.();
      }
      clearResult();
      busy = select.disabled = submit.disabled = true;
      approval.checked = false;
      status.textContent = 'Running ' + current.cliName + '…';
      try {
        const result = current.name === 'ask' && input.stream ? await runStream(input) : await api(current.name, input);
        if (detached()) return;
        output.textContent = JSON.stringify(result, null, 2) ?? 'null';
        output.hidden = download.hidden = false;
        status.textContent = 'Operation finished.';
      } catch (error) {
        if (!detached()) status.textContent = stream?.signal.aborted ? 'Answer stopped.' : error.message;
      } finally {
        stream = undefined;
        stop.hidden = true;
        busy = select.disabled = submit.disabled = false;
      }
    });
    download.addEventListener('click', () => saveFile('okbrain-' + current.cliName.replaceAll(' ', '-') + '.json',
      output.textContent + '\n', 'application/json'));
    void load();
  }

  window.okbAdvancedSettings = { mount };
})();
