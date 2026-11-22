/* global headers, errorBox, esc, view, STATUS, R, conceptLink, citationLinks, answerViewCurrent, mountAnswerActions */
'use strict';

async function planApi(action, data) {
  var options = data === undefined ? { headers: headers() } : {
    method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(data),
  };
  var reply = await fetch('/api/plan/' + action, options);
  var payload = await reply.json();
  if (!reply.ok) throw new Error(payload.error || reply.statusText);
  return payload.result;
}

function accountOptions(status) {
  return status.accounts.map(function (label) {
    return '<option value="' + esc(label) + '"' + (label === status.account ? ' selected' : '') + '>' + esc(label) + '</option>';
  }).join('');
}

function renderProviderKeys(parent, readonly) {
  if (!parent) return;
  parent.innerHTML = '<h3>Provider API keys</h3><p>Saved keys stay in local app data. Environment keys take precedence when present.</p>' +
    '<form class="row"><label class="field"><span>API provider</span><select name="provider" required></select></label>' +
    '<label class="field"><span>API key</span><input name="key" type="password" autocomplete="off" maxlength="4096" required></label>' +
    '<button>Save key</button><button type="button" data-remove>Remove saved key</button></form><p role="status"></p>';
  var form = parent.querySelector('form');
  var status = parent.querySelector('[role="status"]');
  var select = form.elements.provider;
  var remove = form.querySelector('[data-remove]');
  var list = [];

  function setStatus() {
    var item = list.find(function (row) { return row.provider === select.value; });
    if (!item) return;
    status.textContent = (item.saved ? 'Key saved locally.' : 'No saved key.') + (item.environment ? ' An environment key is active.' : '');
    remove.disabled = readonly || !item.saved;
  }

  async function request(data) {
    var options = data === undefined ? { headers: headers() } : {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(data),
    };
    var res = await fetch('/api/provider-keys', options);
    var decoded = await res.json();
    if (!res.ok) throw new Error(decoded.error || res.statusText);
    list = decoded.result;
  }

  async function update(key) {
    form.inert = true;
    try {
      await request({ provider: select.value, key: key });
      form.elements.key.value = '';
      setStatus();
    } catch (error) { status.innerHTML = errorBox(error); }
    finally { form.inert = readonly; }
  }

  form.inert = true;
  void request().then(function () {
    select.replaceChildren(...list.map(function (row) { return new Option(row.provider, row.provider); }));
    setStatus();
    form.inert = readonly;
  }).catch(function (error) { status.innerHTML = errorBox(error); });
  select.addEventListener('change', function () { form.elements.key.value = ''; setStatus(); });
  form.addEventListener('submit', function (event) { event.preventDefault(); void update(form.elements.key.value); });
  remove.addEventListener('click', function () { void update(null); });
}

function renderAccounts() {
  view.innerHTML = '<div class="stack"><h2>Accounts</h2>' +
    '<section class="card stack" id="plan-account"><h3>ChatGPT plan</h3>' +
    '<p>Connect an eligible ChatGPT account to answer questions using your plan. ' +
    '<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage plan usage</a></p>' +
    '<div id="plan-account-state"></div><div id="plan-account-actions"></div><div id="plan-account-message" role="status"></div>' +
    '<p><a href="#ask-plan">Ask with ChatGPT</a> · <a href="#settings">API and local model settings</a></p></section></div>';
  var section = document.getElementById('plan-account');
  var state = document.getElementById('plan-account-state');
  var actions = document.getElementById('plan-account-actions');
  var message = document.getElementById('plan-account-message');
  var readonly = STATUS && STATUS.readonly;

  async function refresh() {
    try {
      var status = await planApi('status');
      if (!section.isConnected) return;
      state.innerHTML = status.connected
        ? '<p>Connected as <strong>' + esc(status.email || status.account) + '</strong> (' + esc(status.account) + ').' +
          (status.sharing ? '' : ' Plan usage permission is unavailable.') + '</p>'
        : '<p>No connected account is selected.</p>';
      if (readonly) return;
      actions.innerHTML = (status.accounts.length ?
        '<form id="plan-select" class="row"><label class="field"><span>Saved account</span><select name="account">' +
        accountOptions(status) + '</select></label><button>Use account</button>' +
        (status.connected ? '<button type="button" id="plan-disconnect">Sign out</button>' : '') + '</form>' : '') +
        '<form id="plan-connect" class="row"><label class="field"><span>Account label</span>' +
        '<input name="account" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,39}" maxlength="40" placeholder="' + esc(status.account || 'default') + '"></label>' +
        '<button class="primary">Start ChatGPT sign-in</button></form>';
      var choose = actions.querySelector('#plan-select');
      choose && choose.addEventListener('submit', async function (event) {
        event.preventDefault();
        await operate('use', { account: new FormData(choose).get('account') }, 'Account selected.');
      });
      var disconnect = actions.querySelector('#plan-disconnect');
      disconnect && disconnect.addEventListener('click', function () { void operate('disconnect', { account: status.account }); });
      actions.querySelector('#plan-connect').addEventListener('submit', start);
    } catch (error) { message.innerHTML = errorBox(error); }
  }

  async function operate(action, data, done) {
    actions.inert = true;
    message.textContent = action === 'disconnect' ? 'Signing out…' : 'Selecting account…';
    try {
      var result = await planApi(action, data);
      message.textContent = done || (result.revoked ? 'Signed out.' : 'Signed out here. Remove remaining access in ChatGPT usage settings.');
      await refresh();
    } catch (error) { message.innerHTML = errorBox(error); }
    finally { actions.inert = false; }
  }

  async function start(event) {
    event.preventDefault();
    var account = new FormData(event.currentTarget).get('account');
    actions.inert = true;
    message.textContent = 'Preparing sign-in…';
    try {
      var pending = await planApi('connect', { account: account });
      if (!section.isConnected) { await planApi('sign-in', { id: pending.id, cancel: true }); return; }
      message.innerHTML = '<div class="row"><a href="' + esc(pending.url) + '" target="_blank" rel="noopener noreferrer">Continue with ChatGPT</a>' +
        '<button type="button" id="plan-cancel">Cancel sign-in</button></div>';
      var cancel = message.querySelector('#plan-cancel');
      cancel.addEventListener('click', async function () {
        cancel.disabled = true;
        try { await planApi('sign-in', { id: pending.id, cancel: true }); }
        catch (error) { message.innerHTML = errorBox(error); }
      });
      while (section.isConnected) {
        await new Promise(function (resolve) { setTimeout(resolve, 1000); });
        var result = await planApi('sign-in', { id: pending.id });
        if (result.state === 'pending') continue;
        if (result.state === 'failed') throw new Error(result.error);
        message.textContent = result.state === 'done' ? 'ChatGPT plan connected.' : 'Sign-in cancelled.';
        await refresh();
        return;
      }
      await planApi('sign-in', { id: pending.id, cancel: true });
    } catch (error) { message.innerHTML = errorBox(error); }
    finally { actions.inert = false; }
  }

  void refresh();
}

async function renderPlanAsk(_arg, seq) {
  var sameView = answerViewCurrent(seq);
  view.innerHTML = '<div class="stack"><h2>Ask with ChatGPT</h2><p><a href="#accounts">Manage ChatGPT accounts</a> · ' +
    '<a href="#ask">Ask with your configured provider</a></p><div id="plan-ask-setup" role="status">Checking account…</div>' +
    '<form id="plan-question" class="stack" hidden><label class="field"><span>Question</span><textarea name="question" maxlength="8000" required></textarea></label>' +
    '<label class="field"><span>ChatGPT model</span><select name="model" required></select></label>' +
    '<label><input type="checkbox" name="includePrivate"> Include private drafts in source search</label>' +
    '<div><button class="primary">Preview sources</button></div></form><div class="stack" id="plan-preview" aria-live="polite"></div>' +
    '<div class="stack" id="plan-answer" aria-live="polite"></div><div id="plan-answer-copy" hidden></div></div>';
  var setup = document.getElementById('plan-ask-setup');
  var form = document.getElementById('plan-question');
  var preview = document.getElementById('plan-preview');
  var answer = document.getElementById('plan-answer');
  var copy = document.getElementById('plan-answer-copy');
  var account;
  var generation = 0;
  try {
    var status = await planApi('status');
    if (!sameView()) return;
    if (!status.connected || !status.sharing || !status.account) {
      setup.textContent = 'Connect an eligible account to continue.';
      return;
    }
    account = status.account;
    var models = await planApi('models', { account: account });
    if (!sameView()) return;
    if (!models.length) { setup.textContent = 'No text models are available for this plan.'; return; }
    setup.innerHTML = '<p>Plan account <strong>' + esc(status.email || account) + '</strong> · ' + esc(account) + '</p>';
    form.elements.model.innerHTML = models.map(function (model) {
      return '<option value="' + esc(model.slug) + '">' + esc(model.name) + '</option>';
    }).join('');
    form.hidden = false;
  } catch (error) { if (sameView()) setup.innerHTML = errorBox(error); return; }
  function clearAnswer() {
    answer.replaceChildren();
    copy.hidden = true;
    copy.replaceChildren();
  }
  form.addEventListener('input', function () { generation++; preview.replaceChildren(); clearAnswer(); });
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!sameView()) return;
    var current = ++generation;
    clearAnswer();
    preview.textContent = 'Searching the local index…';
    var fields = new FormData(form);
    try {
      var result = await planApi('preview', { account: account, model: fields.get('model'),
        question: fields.get('question'), includePrivate: fields.has('includePrivate') });
      if (!sameView() || current !== generation) return;
      if (!result.sources.length) { preview.textContent = 'No matching sources. Try another question or add notes.'; return; }
      preview.innerHTML = '<h3>Sources to send</h3><p>OpenAI will receive your question and the excerpts below through ' +
        esc(result.account) + ' using ' + esc(result.model) + '.</p>' +
        result.sources.map(function (source) {
          return '<details class="card"><summary>' + esc(source.title) +
            (source.private ? ' (private)' : '') + '</summary><pre>' + esc(source.text) + '</pre><p>' +
            conceptLink(source.id, 'Open note') + '</p></details>';
        }).join('') + '<div><button class="primary" type="button">Send question and excerpts</button></div>';
      var send = preview.querySelector('button');
      send.addEventListener('click', async function () {
        if (!sameView() || current !== generation) return;
        send.disabled = true;
        answer.textContent = 'Waiting for ChatGPT…';
        try {
          var response = await planApi('answer', { id: result.id });
          if (!sameView() || current !== generation) return;
          answer.innerHTML = '<div class="md">' + R.renderMarkdown(response.answer) + '</div>' +
            (response.citations.length ? '<h3>Citations</h3><div>' + citationLinks(response.citations) + '</div>' : '');
          mountAnswerActions(copy, String(fields.get('question')).trim(), response,
            function () { return sameView() && current === generation; });
        } catch (error) {
          if (sameView() && current === generation) answer.innerHTML = errorBox(error);
        }
      });
    } catch (error) { if (sameView() && current === generation) preview.innerHTML = errorBox(error); }
  });
}
