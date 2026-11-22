'use strict';

const { readFile, realpath } = require('node:fs/promises');
const { homedir } = require('node:os');
const { isAbsolute, join, relative, sep } = require('node:path');

function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a local okbrain address such as http://127.0.0.1:6522/.');
  }
  return url;
}

function configDirectory() {
  return join(process.platform === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'okbrain');
}

async function connect(override) {
  if (override) localUrl(override.trim());
  const directory = configDirectory();
  const token = await readFile(join(directory, 'serve-token'), 'utf8').catch(() => '');
  const address = await readFile(join(directory, 'desktop-url'), 'utf8').catch(() => '');
  if (!token.trim()) throw new Error('Open okbrain and its Coding workspace first.');

  for (const candidate of override ? [override] : [address, 'http://127.0.0.1:6522/']) {
    if (!candidate.trim()) continue;
    try {
      const url = localUrl(candidate.trim());
      async function api(path, data) {
        const request = new URL('/api/coding' + path, url);
        const response = await fetch(request, {
          method: data === undefined ? 'GET' : 'POST',
          redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { 'x-okb-token': token.trim(), ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `okbrain returned HTTP ${response.status}.`);
        return payload.result;
      }
      const projects = await api('/projects');
      if (!Array.isArray(projects)) continue;
      return { url, api, projects };
    } catch {
      // An ephemeral desktop address can survive an app exit. Try the standard address.
    }
  }
  throw new Error('Open okbrain, or set its current loopback address in the okbrain.server setting.');
}

async function projectFile(workspace, file) {
  const [root, path] = await Promise.all([realpath(workspace), realpath(file)]);
  const inside = relative(root, path);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) return null;
  return inside.split(sep).join('/');
}

module.exports = { connect, localUrl, projectFile };
