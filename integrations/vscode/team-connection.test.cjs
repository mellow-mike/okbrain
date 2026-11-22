'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connectTeam, isTeamToken, teamUrl, TeamConnectionError } = require('./team-connection.cjs');

const origin = 'https://team.example.test:8443';
const token = `okbp_${'a'.repeat(41)}_-`;
const projectId = '773447c4-ef90-423a-9e58-34af0350fdcc';
const otherProjectId = '7919da63-4e97-4659-a6ee-bbee1a7d01e4';
const project = { id: projectId, title: 'Engine', provider: 'openai', model: 'gpt-5', scopes: ['app', 'lib/core'] };
const projectPath = `/projects/${projectId}`;
const identity = { session: 'ide-review', requestId: 'ide-1' };
const run = { project: projectId, id: identity.requestId, session: identity.session, status: 'done' };

const result = (value) => Response.json({ result: value });

function transportTest(name, check) {
  test(name, async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = (respond) => {
      let calls = 0;
      globalThis.fetch = (...args) => {
        calls++;
        return respond(...args);
      };
      return () => calls;
    };
    try { await check(mockFetch); }
    finally { globalThis.fetch = originalFetch; }
  });
}

test('team endpoints require an explicit canonical HTTPS root', () => {
  assert.equal(teamUrl('https://team.example.test').href, 'https://team.example.test/');
  assert.equal(teamUrl(`${origin}/`).origin, origin);
  assert.equal(teamUrl('HTTPS://Team.Example.Test:443/').href, 'https://team.example.test/');
  assert.equal(teamUrl('https://[::1]:8443').origin, 'https://[::1]:8443');
  for (const value of [undefined, {}, '', 'team.example.test', 'http://team.example.test', 'https:team.example.test',
    `${origin}//`, `${origin}/api`, `${origin}/folder/..`, `${origin}/.`, `${origin}/%2e`, `${origin}?`, `${origin}/?a=b`,
    `${origin}#`, `${origin}/#coding`, `${origin}\\`, `${origin}\n`, 'https://@team.example.test',
    'https://member:credential@team.example.test', 'https://team.example.test@other.example.test/',
    'https://team.example.test:0443', 'https://%74eam.example.test']) {
    assert.throws(() => teamUrl(value), TeamConnectionError);
  }
});

transportTest('only the exact project-token format can reach a team server', async (mockFetch) => {
  const calls = mockFetch(() => assert.fail('invalid credentials reached the network'));
  assert.equal(isTeamToken(token), true);
  for (const invalid of [null, 48, '', ` ${token}`, `${token}\n`, token.slice(0, -1), `${token}a`, `${token.slice(0, -1)}!`, 'x'.repeat(48)]) {
    assert.equal(isTeamToken(invalid), false);
    await assert.rejects(connectTeam(origin, invalid), TeamConnectionError);
  }
  await assert.rejects(connectTeam('http://team.example.test', token), TeamConnectionError);
  await assert.rejects(connectTeam(origin, token, 'not-a-project-id'), TeamConnectionError);
  assert.equal(calls(), 0);
});

transportTest('the HTTPS project connection supports scoped previews, runs, and reviews', async (mockFetch) => {
  const requests = [];
  const repoSource = { source: 'repository', query: 'Find the renderer', projects: ['app'] };
  const preview = { source: 'repository', manifest: { id: 'preview-1' }, excerpts: [{ path: 'app/view.ts', content: 'buildView()' }] };
  const presets = { presets: [{ id: 'preset-1', name: 'Renderer', profile: { version: 1, projects: ['app'] } }] };
  const view = { ...project, workspace: '/private/engine', api_key: 'owner-secret', providerLabel: 'OpenAI', credential: 'project' };
  mockFetch(async (url, options) => {
    assert.equal(url.origin, origin);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, {
      authorization: `Bearer ${token}`,
      ...(options.method === 'POST' ? { 'content-type': 'application/json' } : {}),
    });
    const action = url.pathname.split('/').at(-1);
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    requests.push({ path: url.pathname, method: options.method, body });
    if (action === 'projects') return result([view]);
    if (action === 'presets') return result(presets);
    if (action === 'preview') return result(preview);
    if (action === 'runs') return result([run]);
    if (action === 'inspect') return result({ run });
    if (action === 'source-inspect') return result({ prompt: 'Review the renderer', groups: [] });
    return result(run);
  });

  const connection = await connectTeam(`${origin}/`, token, projectId);
  assert.equal(connection.url.origin, origin);
  assert.equal(connection.mode, 'team');
  assert.equal(connection.projectId, projectId);
  assert.deepEqual(connection.projects, [{ ...project, providerLabel: 'OpenAI', credential: 'project' }]);
  const api = (action, data) => connection.api(`${projectPath}/${action}`, data);
  assert.deepEqual(await api('presets'), presets);
  assert.deepEqual(await api('preview', repoSource), preview);
  const runRequest = { ...repoSource, ...identity, prompt: 'Review the renderer', previewId: preview.manifest.id, approved: true };
  assert.deepEqual(await api('run', runRequest), run);
  assert.deepEqual(await api('runs'), [run]);
  assert.deepEqual(await api('inspect', identity), { run });
  assert.deepEqual(await api('source-inspect', identity), { prompt: 'Review the renderer', groups: [] });
  assert.deepEqual(await api('review', { ...identity, decision: 'accepted' }), run);
  assert.deepEqual(await api('resume', identity), run);
  assert.deepEqual(await api('cancel', identity), run);
  assert.deepEqual(requests, [
    { path: '/api/coding/projects', method: 'GET', body: undefined },
    ...[
      ['presets', undefined], ['preview', repoSource], ['run', runRequest], ['runs', undefined], ['inspect', identity],
      ['source-inspect', identity], ['review', { ...identity, decision: 'accepted' }], ['resume', identity], ['cancel', identity],
    ].map(([action, body]) => ({ path: `/api/coding${projectPath}/${action}`, method: body === undefined ? 'GET' : 'POST', body })),
  ]);
});

transportTest('bound team connections refuse other projects, owner actions, and editor-file bodies before fetch', async (mockFetch) => {
  const calls = mockFetch(async (url) => {
    assert.equal(url.origin, origin);
    return result(url.pathname === '/api/coding/projects' ? [project] : [run]);
  });
  const connection = await connectTeam(origin, token);
  connection.url.hostname = 'other.example.test';
  connection.projects[0].id = otherProjectId;
  assert.deepEqual(await connection.api(`${projectPath}/runs`), [run]);
  for (const [path, body] of [
    ['/projects'], [`/projects/${otherProjectId}/runs`], [`${projectPath}/runs?project=${otherProjectId}`],
    [`${projectPath}/runs#x`], [`${projectPath}/runs\n`], [`${projectPath}/%72uns`], [`${projectPath}/../runs`],
    [`https://other.example.test${projectPath}/runs`], [`//other.example.test${projectPath}/runs`],
    ['/standalone/sessions'], ['/team', { action: 'stop' }], [`${projectPath}/retention`],
    [`${projectPath}/credential`, { apiKey: 'x' }], [`${projectPath}/patch-apply`, identity],
    [`${projectPath}/presets`, { action: 'remove' }], [`${projectPath}/runs`, {}], [`${projectPath}/inspect`],
    [`${projectPath}/preview`, { source: 'files', files: ['app/view.ts'] }],
    [`${projectPath}/preview`, { source: 'repository', query: 'views', files: ['app/view.ts'] }],
    [`${projectPath}/run`, { source: 'packages', packages: [] }],
    [`${projectPath}/run`, { source: 'repository', query: token }],
  ]) await assert.rejects(connection.api(path, body), TeamConnectionError);
  assert.equal(calls(), 2);
});

transportTest('discovery requires one validated project and preserves the expected binding', async (mockFetch) => {
  let projects = [project];
  mockFetch(async () => result(projects));
  await assert.rejects(connectTeam(origin, token, otherProjectId), /different project/);
  for (const invalid of [[], [project, { ...project, id: otherProjectId }], [{ ...project, id: 'bad-id' }],
    [{ ...project, provider: null }], [{ ...project, scopes: [] }], [{ ...project, scopes: ['/private'] }],
    [{ ...project, scopes: ['app/../private'] }], [{ ...project, scopes: ['C:\\Users\\name'] }]]) {
    projects = invalid;
    await assert.rejects(connectTeam(origin, token), /invalid okbrain team workspace response/);
  }
});

transportTest('redirects, rejected tokens, and malformed responses expose only local messages', async (mockFetch) => {
  let response;
  const calls = mockFetch(async (url, { redirect }) => {
    assert.equal(url.origin, origin);
    assert.equal(redirect, 'error');
    if (response instanceof Error) throw response;
    return response;
  });
  for (const status of [401, 403, 409, 410, 500]) {
    response = Response.json({ error: `server detail ${token}` }, { status });
    await assert.rejects(connectTeam(origin, token), (error) => {
      assert.ok(error instanceof TeamConnectionError);
      assert.equal(error.status, status);
      assert.equal(error.statusCode, status);
      assert.doesNotMatch(error.message, /server detail|okbp_/);
      if (status === 401) assert.match(error.message, /expired, or revoked/);
      return true;
    });
  }
  response = Response.redirect(`https://other.example.test/${token}`, 307);
  await assert.rejects(connectTeam(origin, token), /serve its API directly over HTTPS/);
  response = Response.redirect(`${origin}/follow`, 302);
  await assert.rejects(connectTeam(origin, token), /serve its API directly over HTTPS/);
  response = new Error(`network cause has ${token}`);
  await assert.rejects(connectTeam(origin, token), (error) => {
    assert.match(error.message, /Could not reach/);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack, /okbp_/);
    return true;
  });
  response = new Response('<html>not a team endpoint</html>');
  await assert.rejects(connectTeam(origin, token), /invalid okbrain team workspace response/);
  response = Response.json({ error: `server detail ${token}` });
  await assert.rejects(connectTeam(origin, token), /invalid okbrain team workspace response/);
  assert.equal(calls(), 10);
});

transportTest('a successful response cannot reflect the bearer or replace the selected run', async (mockFetch) => {
  let response;
  mockFetch(async (url) => url.pathname === '/api/coding/projects' ? result([project]) : response);
  const { api } = await connectTeam(origin, token, projectId);
  response = new Response(JSON.stringify({ result: { prompt: token, groups: [] } }).replace('okbp_', '\\u006fkbp_'));
  await assert.rejects(api(`${projectPath}/source-inspect`, identity), (error) => error instanceof TeamConnectionError &&
    /invalid okbrain team workspace response/.test(error.message) && !error.message.includes(token));
  response = result({ run: { ...run, project: otherProjectId } });
  await assert.rejects(api(`${projectPath}/inspect`, identity), /invalid okbrain team workspace response/);
  response = result({ run: { ...run, id: 'another-request' } });
  await assert.rejects(api(`${projectPath}/inspect`, identity), /invalid okbrain team workspace response/);
  response = result(null);
  assert.equal(await api(`${projectPath}/source-inspect`, identity), null);
});

transportTest('branch comparison POST stays on the bound project and verifies both reported sides', async (mockFetch) => {
  const alternative = { session: 'alternative', requestId: identity.requestId };
  const side = (runIdentity) => ({ ...runIdentity, status: 'done', review: null, answer: { text: 'Saved answer', truncated: false },
    report: { version: 1, projectId, session: runIdentity.session, request: { requestId: runIdentity.requestId }, runStatus: 'done' } });
  const comparison = { original: side(identity), alternative: side(alternative) };
  let returned = comparison;
  const calls = mockFetch(async (url, options) => {
    if (url.pathname === '/api/coding/projects') return result([project]);
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, `/api/coding${projectPath}/branch-comparison-inspect`);
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), alternative);
    return result(returned);
  });
  const { api } = await connectTeam(origin, token, projectId);
  const path = `${projectPath}/branch-comparison-inspect`;
  await assert.rejects(api(`/projects/${otherProjectId}/branch-comparison-inspect`, alternative), /connected coding project/);
  await assert.rejects(api(path, { ...alternative, original: identity }), /Choose one saved alternative/);
  assert.equal(calls(), 1);
  assert.deepEqual(await api(path, alternative), comparison);
  for (returned of [
    { ...comparison, alternative: side({ ...alternative, requestId: 'another-id' }) },
    { ...comparison, original: { ...comparison.original, report: { ...comparison.original.report, projectId: otherProjectId } } },
    { ...comparison, original: comparison.alternative },
  ]) await assert.rejects(api(path, alternative), /invalid okbrain team workspace response/);
});
