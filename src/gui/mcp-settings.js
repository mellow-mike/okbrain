(function () {
  'use strict';

  async function mount(panel, { readonly, requestHeaders }) {
    panel.innerHTML =
      '<h3>MCP agent access</h3>' +
      '<p class="muted">Connect a local client that supports Streamable HTTP and an Authorization header. Clients can read notes in the selected brain, including private drafts.</p>' +
      '<form class="stack"><div class="row"><label class="field"><span>Local port</span>' +
      '<input name="port" type="number" min="0" max="65535" value="6523" required></label></div>' +
      '<label class="row"><input name="trusted" type="checkbox"> Allow trusted clients to write to this brain</label>' +
      '<div class="row"><button type="submit">Start MCP HTTP</button><button type="button" data-stop hidden>Stop MCP HTTP</button></div></form>' +
      '<p data-bound hidden></p><details data-details hidden><summary>Connection details</summary>' +
      '<div class="stack"><pre></pre>' +
      '<div class="row"><button type="button" data-copy>Copy HTTP connection details</button></div></div></details>' +
      '<p data-message role="status"></p>';
    const form = panel.querySelector('form');
    const start = form.querySelector('button[type="submit"]');
    const stop = form.querySelector('[data-stop]');
    const bound = panel.querySelector('[data-bound]');
    const details = panel.querySelector('[data-details]');
    const message = panel.querySelector('[data-message]');
    const { port, trusted } = form.elements;
    let active = null;
    let pending = true;

    function draw() {
      start.hidden = !!active;
      stop.hidden = !active;
      port.disabled = pending || !!active;
      trusted.disabled = pending || readonly || !!active;
      if (readonly) trusted.checked = false;
      start.disabled = stop.disabled = pending;
      details.hidden = !active || active.mountChanged;
      bound.hidden = !active;
      bound.textContent = !active ? '' : active.mountChanged
        ? 'The brain mount changed. Restart MCP HTTP to use the updated mount.'
        : (active.trusted ? 'Read and write' : 'Read-only') + ' access to ' + (active.brain || active.bundle) + ' · ' + active.url;
      const output = details.querySelector('pre');
      output.textContent = !details.hidden
        ? JSON.stringify({ type: 'http', url: active.url, headers: { Authorization: active.auth } }, null, 2)
        : '';
      if (details.hidden) details.open = false;
    }

    async function update(params) {
      pending = true;
      draw();
      message.textContent = '';
      try {
        const res = await fetch('/api/mcp/http', params ? {
          method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(params),
        } : { headers: requestHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'MCP HTTP settings are unavailable.');
        active = data.result;
        if (params) message.textContent = active ? 'MCP HTTP started.' : 'MCP HTTP stopped.';
      } catch (error) {
        message.textContent = error.message || String(error);
      } finally {
        pending = false;
        draw();
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!pending) update({ action: 'start', port: Number(port.value), trusted: trusted.checked });
    });
    stop.addEventListener('click', () => { if (!pending) update({ action: 'stop' }); });
    details.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(details.querySelector('pre').textContent);
        message.textContent = 'MCP HTTP connection details copied.';
      } catch {
        message.textContent = 'Select and copy the HTTP connection details above.';
      }
    });
    await update();
  }

  window.okbMcpSettings = { mount };
})();
