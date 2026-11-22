'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function activateExtension(vscode, connection, options = {}) {
  const file = require.resolve('./extension.cjs');
  const module = { exports: {} };
  vscode.workspace.onDidChangeWorkspaceFolders ??= () => {};
  vscode.window.onDidChangeActiveTextEditor ??= () => {};
  runInNewContext(readFileSync(file, 'utf8'), {
    module,
    URL,
    Buffer,
    require(id) {
      if (id === 'vscode') return vscode;
      if (id === './connection.cjs') return { ...require(id), connect: async () => connection };
      if (id === './team-connection.cjs' && options.connectTeam) return { ...require(id), connectTeam: options.connectTeam };
      return require(id);
    },
  }, { filename: file });
  module.exports.activate({ subscriptions: [], secrets: options.secrets ?? { onDidChange() {} } });
}

test('editor inspection shows the context budget and opens approved source only on request', async () => {
  const project = { id: 'fixture', title: 'Project fixture' };
  const runs = [
    { id: 'active', session: 'main', status: 'running', admitted: true },
    { id: 'saved', session: 'main', status: 'done', admitted: true },
  ];
  const source = {
    prompt: 'Review the saved input.', guidance: 'Project rules.',
    groups: [{ label: 'Package fixture', files: [{ path: 'package/example.ts', startLine: 3, endLine: 9, text: '<source>&</source>' }] }],
  };
  let selectedRun = 'active';
  let openSource = false;
  let availableActions;
  let lastDocument;
  let savedContext = { estimatedTokens: 1050, limitTokens: 2400, maxOutputTokens: 400, modelWindowTokens: 3200, historyCompacted: true };
  let sourceReads = 0;
  let provideSource;
  const commands = new Map();
  const connection = {
    projects: [project],
    async api(path, identity) {
      if (path === '/projects/fixture/runs') return runs;
      if (path === '/projects/fixture/inspect') return { run: runs.find((run) => run.id === identity.requestId),
        ...(identity.requestId === 'saved' ? { pi: { context: savedContext, usage: { models: {} } } } : {}) };
      assert.equal(path, '/projects/fixture/source-inspect');
      assert.equal(identity.session, 'main');
      assert.equal(identity.requestId, 'saved');
      sourceReads++;
      return source;
    },
  };
  const vscode = {
    Uri: { from: (file) => ({ ...file, toString: () => `${file.scheme}:${file.path}?${file.query}` }) },
    commands: { registerCommand: (name, run) => commands.set(name, run) },
    env: {},
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ inspect: () => undefined }),
      registerTextDocumentContentProvider(scheme, provider) {
        assert.equal(scheme, 'okbrain-saved-source');
        provideSource = provider.provideTextDocumentContent;
      },
      async openTextDocument(input) {
        return input.scheme
          ? { uri: input, languageId: 'plaintext', text: provideSource(input) }
          : { languageId: input.language, text: input.content };
      },
    },
    window: {
      async showTextDocument(document) { lastDocument = document; },
      async showQuickPick(choices, options) {
        if (options.placeHolder === 'Choose a request to inspect') return choices.find((choice) => choice.label === selectedRun);
        availableActions = Array.from(choices, (choice) => choice.label);
        if (openSource) return choices.find((choice) => choice.label === 'View saved request source');
      },
      async showErrorMessage(message) { throw new Error(message); },
    },
  };
  activateExtension(vscode, connection);
  const inspect = commands.get('okbrain.runs');

  await inspect();
  assert.ok(!availableActions.includes('View saved request source'));
  assert.doesNotMatch(lastDocument.text, /Session context budget/);
  selectedRun = 'saved';
  await inspect();
  assert.ok(availableActions.includes('View saved request source'));
  assert.equal(sourceReads, 0);
  assert.ok(!lastDocument.text.includes(source.prompt));
  assert.ok(lastDocument.text.includes([
    'Session context budget',
    `Estimated active context: ${(1050).toLocaleString()} tokens`,
    `Input token cap: ${(2400).toLocaleString()} tokens`,
    `Output reserve: ${(400).toLocaleString()} tokens`,
    `Model window: ${(3200).toLocaleString()} tokens`,
    'Earlier turns are compacted. Saved requests remain in Run history.',
    '', 'Recorded session usage',
  ].join('\n')));

  savedContext = { estimatedTokens: 0, limitTokens: '2400', maxOutputTokens: -1, modelWindowTokens: 3200.5, historyCompacted: 'true' };
  await inspect();
  assert.ok(lastDocument.text.includes(`Estimated active context: ${(0).toLocaleString()} tokens`));
  assert.doesNotMatch(lastDocument.text, /Input token cap|Output reserve|Model window|Older turns|Earlier turns/);
  savedContext = { estimatedTokens: 12, limitTokens: 400 };
  await inspect();
  assert.ok(lastDocument.text.includes(`Estimated active context: ${(12).toLocaleString()} tokens\nInput token cap: ${(400).toLocaleString()} tokens`));
  assert.doesNotMatch(lastDocument.text, /Output reserve|Model window/);

  openSource = true;
  await inspect();
  assert.equal(sourceReads, 1);
  assert.equal(lastDocument.uri.scheme, 'okbrain-saved-source');
  assert.equal(lastDocument.languageId, 'plaintext');
  assert.ok(lastDocument.text.includes(source.prompt));
  assert.ok(lastDocument.text.includes('Project guidance\nProject rules.'));
  assert.ok(lastDocument.text.includes('Package fixture\n\npackage/example.ts:3–9\n<source>&</source>'));
  assert.equal(provideSource(lastDocument.uri), '');
});

test('editor sends the accepted request to patch review without calling another API', async () => {
  const project = { id: 'e2bb15ce-a12d-4630-8d72-bbbdbb986ba8', title: 'Project fixture' };
  const runs = [
    { id: 'review.1', session: 'main_branch', status: 'done' },
    { id: 'review.2', session: 'main_branch', status: 'done', review: 'changes_requested' },
    { id: 'review.3', session: 'branch-two', status: 'done', review: 'accepted' },
  ];
  const url = new URL('http://127.0.0.1:6522/');
  const commands = new Map();
  const opened = [];
  const calls = [];
  const patch = 'Review proposed patch in okbrain';
  const github = 'Prepare GitHub pull request in okbrain';
  let runId = runs[0].id;
  let nextAction = patch;
  let availableActions;
  const vscode = {
    Uri: { parse: (href) => new URL(href) },
    commands: { registerCommand: (name, run) => commands.set(name, run) },
    env: { openExternal: async (target) => { opened.push(target.href); return true; } },
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ inspect: () => undefined }),
      registerTextDocumentContentProvider() {},
      async openTextDocument(input) { return input; },
    },
    window: {
      async showTextDocument() {},
      async showQuickPick(choices, options) {
        if (options.placeHolder === 'Choose a request to inspect') return choices.find((choice) => choice.label === runId);
        availableActions = Array.from(choices, (choice) => choice.label);
        return choices.find((choice) => choice.label === nextAction);
      },
      async showErrorMessage(message) { throw new Error(message); },
    },
  };
  activateExtension(vscode, {
    url,
    projects: [project],
    async api(path, identity) {
      calls.push(path);
      if (path === `/projects/${project.id}/runs`) return runs;
      assert.equal(path, `/projects/${project.id}/inspect`);
      return { run: runs.find(({ id, session }) => id === identity.requestId && session === identity.session) };
    },
  });
  const inspect = commands.get('okbrain.runs');

  for (const { id } of runs.slice(0, 2)) {
    runId = id;
    await inspect();
    assert.ok(!availableActions.includes(patch));
    assert.ok(!availableActions.includes(github));
  }
  assert.deepEqual(opened, []);
  calls.length = 0;
  const accepted = runs[2];
  runId = accepted.id;
  await inspect();
  assert.ok(availableActions.includes(patch));
  assert.ok(availableActions.includes(github));
  assert.deepEqual(calls, [`/projects/${project.id}/runs`, `/projects/${project.id}/inspect`]);
  assert.deepEqual(opened, [`${url.href}#coding/${project.id}/patch/${accepted.session}/${accepted.id}`]);

  nextAction = github;
  await inspect();
  assert.equal(opened[1], `${url.href}#coding/${project.id}/github/${accepted.session}/${accepted.id}`);
});

test('editor previews a matching preset, requires approval, and retries exactly one stable request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'okbrain-editor-preset-'));
  try {
    const workspace = join(root, 'project');
    const separate = join(root, 'other');
    await Promise.all([mkdir(workspace), mkdir(separate)]);
    const activeFile = join(workspace, 'active.ts');
    const otherFile = join(separate, 'other.ts');
    await Promise.all([writeFile(activeFile, 'active'), writeFile(otherFile, 'separate')]);
    const folder = { uri: { scheme: 'file', fsPath: workspace } };
    const otherFolder = { uri: { scheme: 'file', fsPath: separate } };
    const project = { id: 'fixture', title: 'Project fixture', workspace, provider: 'openai', model: 'fixture-model' };
    const otherProject = { ...project, id: 'other', workspace: separate };
    const profile = { version: 1, name: 'Focused profile', projects: ['src'], guidance: 'Previewed guidance.' };
    const preset = { id: 'preset-1', name: 'Review API', prompt: 'Review <exact> request.', query: 'lookupApi', profile };
    const preview = { source: 'repository', manifest: { id: 'a'.repeat(64) }, guidance: profile.guidance,
      excerpts: [{ path: 'src/example.ts', startLine: 8, endLine: 9, content: '<exact>\n  spaced text' }] };
    const expectedSource = { source: 'repository', query: preset.query, profile };
    const calls = [];
    const commands = new Map();
    const errors = [];
    const submitted = [];
    let provideText;
    let lastDocument;
    let mode;
    const vscode = {
      Uri: { from: (value) => ({ ...value, toString: () => `${value.scheme}:${value.path}?${value.query}` }) },
      commands: { registerCommand: (name, run) => commands.set(name, run) },
      env: {},
      ProgressLocation: { Notification: 1 },
      workspace: {
        isTrusted: true,
        workspaceFolders: [folder, otherFolder],
        getWorkspaceFolder(uri) { return new Map([[activeFile, folder], [otherFile, otherFolder]]).get(uri.fsPath); },
        getConfiguration: () => ({ inspect: () => undefined }),
        registerTextDocumentContentProvider(_scheme, provider) { provideText = provider.provideTextDocumentContent; },
        async openTextDocument(uri) { return { uri, languageId: 'plaintext', text: provideText(uri) }; },
      },
      window: {
        async showTextDocument(document) {
          lastDocument = document;
          this.activeTextEditor = { document };
        },
        async showInputBox() { return 'preset-review'; },
        async withProgress(_options, work) { return work(); },
        async showQuickPick(items, options) {
          if (options.placeHolder === 'Choose a saved request preset') return mode === 'dismiss-preset' ? undefined : items[0];
          assert.equal(options.placeHolder, 'Choose source lookup for this request');
          if (mode === 'dismiss-lookup') return undefined;
          return items[mode === 'send-lookup' ? 1 : 0];
        },
        async showInformationMessage(message, ...actions) {
          if (!actions.includes('Send Request')) return undefined;
          assert.match(message, /active session history/);
          assert.equal(lastDocument.uri.scheme, 'okbrain-saved-source');
          assert.ok(lastDocument.text.includes('Task\n' + preset.prompt));
          assert.ok(lastDocument.text.includes('Project guidance\n' + profile.guidance));
          assert.ok(lastDocument.text.includes('src/example.ts:8–9\n' + preview.excerpts[0].content));
          assert.ok(lastDocument.text.includes(mode === 'send-lookup' ? 'Source lookup: Allowed within the approved excerpts' : 'Source lookup: Off'));
          if (mode === 'switch-workspace') this.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: otherFile } } };
          return mode === 'dismiss-send' ? undefined : 'Send Request';
        },
        async showErrorMessage(message, ...actions) {
          if (actions.includes('Try Same Request')) return 'Try Same Request';
          errors.push(message);
        },
      },
    };
    activateExtension(vscode, {
      projects: [otherProject, project],
      async api(path, input) {
        calls.push(path);
        if (path === '/projects/fixture/presets') {
          assert.equal(input, undefined);
          return { presets: [preset] };
        }
        if (path === '/projects/fixture/preview') {
          assert.deepEqual(JSON.parse(JSON.stringify(input)), expectedSource);
          return preview;
        }
        assert.equal(path, '/projects/fixture/run');
        submitted.push(JSON.parse(JSON.stringify(input)));
        if (submitted.length === 1) throw new Error('First response lost');
        return { id: input.requestId, status: 'running' };
      },
    });
    const launch = commands.get('okbrain.runPreset');
    const launchFrom = async (state, fsPath = activeFile) => {
      mode = state;
      vscode.window.activeTextEditor = { document: { uri: { scheme: 'file', fsPath } } };
      calls.length = 0;
      await launch();
    };

    await launchFrom('non-project', join(root, 'unregistered.ts'));
    assert.deepEqual(calls, []);
    assert.match(errors.pop(), /Open the registered project folder/);
    await launchFrom('dismiss-preset');
    assert.deepEqual(calls, ['/projects/fixture/presets']);
    await launchFrom('dismiss-lookup');
    assert.deepEqual(calls, ['/projects/fixture/presets', '/projects/fixture/preview']);
    await launchFrom('dismiss-send');
    assert.deepEqual(calls, ['/projects/fixture/presets', '/projects/fixture/preview']);
    await launchFrom('switch-workspace');
    assert.deepEqual(calls, ['/projects/fixture/presets', '/projects/fixture/preview']);
    assert.match(errors.pop(), /open workspace changed/);
    assert.deepEqual(submitted, []);

    await launchFrom('send-lookup');
    assert.deepEqual(calls, ['/projects/fixture/presets', '/projects/fixture/preview', '/projects/fixture/run', '/projects/fixture/run']);
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[0], submitted[1]);
    const { requestId, ...request } = submitted[0];
    assert.match(requestId, /^ide-[a-f0-9-]{36}$/);
    assert.deepEqual(request, { ...expectedSource, session: 'preset-review', prompt: preset.prompt,
      previewId: preview.manifest.id, approved: true, approvedSourceLookup: true });
    await launchFrom('send-no-lookup');
    assert.equal(Object.hasOwn(submitted[2], 'approvedSourceLookup'), false);
    assert.notEqual(submitted[2].requestId, requestId);
    assert.deepEqual(errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('team commands bind SecretStorage to one project and gate server-side previews and review on that binding', async () => {
  const projectId = 'e2bb15ce-a12d-4630-8d72-bbbdbb986ba8';
  const newProjectId = 'e2bb15ce-a12d-4630-8d72-bbbdbb986ba9';
  const origin = 'https://workspace.example.test';
  const credential = 'okbp_' + 'a'.repeat(43);
  const project = { id: projectId, title: 'Shared project', provider: 'openai', model: 'team-model', scopes: ['core', 'tests', 'docs,examples'] };
  const preset = { name: 'Inspect core', prompt: 'Check the core code.', query: 'boot', profile: { version: 1, name: 'Core', projects: ['core'] } };
  const preview = { source: 'repository', manifest: { id: 'a'.repeat(64) },
    excerpts: [{ path: 'core/sample.ts', startLine: 3, endLine: 4, content: '<literal source>' }] };
  const done = { id: 'result', session: 'team', status: 'done', review: 'accepted', admitted: true };
  const interrupted = { id: 'interrupted', session: 'team', status: 'interrupted', admitted: true };
  const active = { id: 'active', session: 'team', status: 'running', admitted: true };
  const commands = new Map();
  const entries = new Map();
  const calls = [];
  const connections = [];
  const opened = [];
  const errors = [];
  let changed;
  const secrets = {
    onDidChange(listener) { changed = listener; },
    async get(key) { return entries.get(key); },
    async store(key, value) { entries.set(key, value); changed({ key }); },
    async delete(key) { entries.delete(key); changed({ key }); },
  };
  let mode;
  let provideText;
  let lastDocument;
  let selectedRun = done;
  let nextRunAction = 'View saved request source';
  let lookup = false;
  let manualAttempts = 0;
  let availableActions;
  const cloned = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const invoke = (command) => commands.get(`okbrain.${command}`)();
  const vscode = {
    Uri: { from: (value) => ({ ...value, toString: () => `${value.scheme}:${value.path}?${value.query}` }), parse: (value) => new URL(value) },
    commands: { registerCommand: (name, run) => commands.set(name, run) },
    env: { openExternal: async (url) => { opened.push(url.href); return true; } },
    ProgressLocation: { Notification: 1 },
    workspace: {
      isTrusted: true,
      workspaceFolders: [],
      getConfiguration() { throw new Error('Team actions must not open owner settings.'); },
      registerTextDocumentContentProvider(_scheme, provider) { provideText = provider.provideTextDocumentContent; },
      async openTextDocument(uri) { return { uri, languageId: 'plaintext', text: provideText(uri) }; },
    },
    window: {
      async showTextDocument(document) { lastDocument = document; },
      async showInputBox(options) {
        if (options.prompt === 'Team workspace HTTPS address') {
          assert.ok(options.validateInput('http://workspace.example.test'));
          if (mode === 'dismiss-connect') return undefined;
          return origin;
        }
        if (options.prompt.startsWith('Project token for ')) {
          assert.equal(options.password, true);
          return credential;
        }
        if (options.prompt === 'What should Pi review or propose?') return 'Manual team task';
        if (options.prompt === 'Search the team repository for source') return 'server query';
        if (options.prompt === 'Narrow to repository subdirectories (optional)') {
          assert.ok(options.validateInput('../outside'));
          assert.ok(options.validateInput('core/outside-scope'));
          return mode === 'manual-literal' ? '' : 'tests/allocator, tests/edge';
        }
        assert.equal(options.prompt, 'Coding session name');
        return 'editor-team';
      },
      async withProgress(_options, work) { return work(); },
      async showQuickPick(items, options) {
        if (options.placeHolder === `Choose a request for ${project.title}`) return items[mode.startsWith('manual') ? 0 : 1];
        if (options.placeHolder === 'Choose approved team repository directories') return [items[mode === 'manual-literal' ? 2 : 1]];
        if (options.placeHolder === 'Choose source lookup for this request') return items[lookup ? 1 : 0];
        if (options.placeHolder === 'Choose a request to inspect') return items.find(({ label }) => label === selectedRun.id);
        assert.equal(options.placeHolder, 'Choose a run action');
        availableActions = Array.from(items, ({ label }) => label);
        return items.find(({ label }) => label === nextRunAction);
      },
      async showInformationMessage(message, ...actions) {
        assert.ok(!message.includes(credential));
        if (!actions.includes('Send Request')) return undefined;
        assert.ok(message.includes(origin));
        assert.match(lastDocument.text, /<literal source>/);
        assert.match(lastDocument.text, /Source lookup:/);
        assert.equal(lastDocument.uri.scheme, 'okbrain-saved-source');
        if (mode === 'disconnect-approval') await invoke('disconnectTeam');
        return mode === 'dismiss-approval' ? undefined : 'Send Request';
      },
      async showWarningMessage() {
        if (mode === 'disconnect-resume') await invoke('disconnectTeam');
        return 'Resume';
      },
      async showErrorMessage(message, ...actions) {
        assert.ok(!message.includes(credential));
        if (actions.includes('Try Same Request')) {
          if (mode === 'replace-retry') await secrets.store('okbrain.team.connection', JSON.stringify({ origin, projectId: newProjectId, token: credential }));
          return 'Try Same Request';
        }
        errors.push(message);
      },
    },
  };
  const connectTeam = async (url, token, expected) => {
    connections.push([url, token, expected]);
    if (expected && expected !== projectId) throw new Error('The token belongs to a different project.');
    assert.equal(url, origin);
    assert.equal(token, credential);
    const prefix = `/projects/${projectId}/`;
    return { url: new URL(url), mode: 'team', projectId, projects: [project], async api(path, data) {
      assert.ok(path.startsWith(prefix));
      const action = path.slice(prefix.length);
      calls.push([action, cloned(data)]);
      if (action === 'presets') return { presets: [preset] };
      if (action === 'preview') return preview;
      if (action === 'run') {
        if ((mode === 'manual' && manualAttempts++ === 0) || mode === 'replace-retry') throw new Error('Response lost');
        if (mode === 'denied-retry') throw Object.assign(new Error('The team token expired.'), { status: 401 });
        return { id: data.requestId, status: 'running' };
      }
      if (action === 'runs') return [done, interrupted, active];
      if (action === 'inspect') return { run: selectedRun, pi: { pendingRequestIds: [], request: { receipt: { text: 'Shared result.' } } } };
      if (action === 'source-inspect') return { prompt: 'Saved shared task.', groups: [{ files: [{ path: 'core/sample.ts', text: '<literal source>' }] }] };
      if (action === 'cancel' || action === 'resume') return selectedRun;
      assert.equal(action, 'review');
      return { ...done, review: data.decision };
    } };
  };
  activateExtension(vscode, undefined, { secrets, connectTeam });

  mode = 'dismiss-connect';
  await invoke('connectTeam');
  assert.equal(connections.length, 0);
  mode = 'connect';
  await invoke('connectTeam');
  assert.deepEqual(JSON.parse(entries.get('okbrain.team.connection')), { origin, projectId, token: credential });
  await invoke('openTeam');
  assert.deepEqual(opened, [origin + '/']);
  assert.deepEqual(connections, [[origin, credential, undefined]]);

  mode = 'dismiss-approval';
  await invoke('runTeam');
  assert.deepEqual(connections.at(-1), [origin, credential, projectId]);
  assert.deepEqual(calls.splice(0), [['presets', undefined], ['preview', { source: 'repository', query: preset.query, profile: preset.profile }]]);
  mode = 'manual';
  lookup = true;
  await invoke('runTeam');
  const manual = calls.splice(0);
  assert.deepEqual(manual[1], ['preview', { source: 'repository', query: 'server query', projects: ['tests/allocator', 'tests/edge'] }]);
  assert.deepEqual(manual[2], manual[3]);
  const { requestId, ...body } = manual[2][1];
  assert.match(requestId, /^ide-[a-f0-9-]{36}$/);
  assert.deepEqual(body, { ...manual[1][1], session: 'editor-team', prompt: 'Manual team task', previewId: preview.manifest.id,
    approved: true, approvedSourceLookup: true });
  mode = 'manual-literal';
  await invoke('runTeam');
  assert.deepEqual(calls.splice(0)[1], ['preview', { source: 'repository', query: 'server query', projects: ['docs,examples'] }]);
  mode = 'preset';
  lookup = false;
  await invoke('runTeam');
  const presetCalls = calls.splice(0);
  assert.deepEqual(presetCalls.map(([action]) => action), ['presets', 'preview', 'run']);
  assert.deepEqual(presetCalls[2][1].profile, preset.profile);
  assert.equal(presetCalls[2][1].prompt, preset.prompt);
  assert.ok(!Object.hasOwn(presetCalls[2][1], 'approvedSourceLookup'));
  mode = 'denied-retry';
  await invoke('runTeam');
  assert.deepEqual(calls.splice(0).map(([action]) => action), ['presets', 'preview', 'run']);
  assert.match(errors.pop(), /token expired/);

  mode = 'disconnect-approval';
  await invoke('runTeam');
  assert.deepEqual(calls.splice(0).map(([action]) => action), ['presets', 'preview']);
  assert.equal(entries.size, 0);
  mode = 'connect';
  await invoke('connectTeam');
  mode = 'replace-retry';
  await invoke('runTeam');
  assert.deepEqual(calls.splice(0).map(([action]) => action), ['presets', 'preview', 'run']);
  await invoke('teamRuns');
  assert.match(errors.pop(), /different project/);

  mode = 'connect';
  await invoke('connectTeam');
  await invoke('teamRuns');
  assert.ok(availableActions.includes('Request changes'));
  assert.ok(!availableActions.includes('Review proposed patch in okbrain'));
  assert.ok(!availableActions.includes('Prepare GitHub pull request in okbrain'));
  assert.ok(!availableActions.includes('Start fresh context'));
  assert.equal(lastDocument.uri.scheme, 'okbrain-saved-source');
  assert.match(lastDocument.text, /Saved shared task/);
  assert.deepEqual(calls.splice(0).map(([action]) => action), ['runs', 'inspect', 'source-inspect']);
  nextRunAction = 'Request changes';
  await invoke('teamRuns');
  assert.deepEqual(calls.pop(), ['review', { session: done.session, requestId: done.id, decision: 'changes_requested' }]);
  calls.length = 0;
  selectedRun = active;
  nextRunAction = 'Cancel request';
  await invoke('teamRuns');
  assert.deepEqual(calls.pop(), ['cancel', { session: active.session, requestId: active.id }]);
  calls.length = 0;
  selectedRun = interrupted;
  nextRunAction = 'Resume from saved context';
  await invoke('teamRuns');
  assert.deepEqual(calls.pop(), ['resume', { session: interrupted.session, requestId: interrupted.id }]);
  calls.length = 0;
  mode = 'disconnect-resume';
  await invoke('teamRuns');
  assert.deepEqual(calls.map(([action]) => action), ['runs', 'inspect']);
  assert.equal(entries.size, 0);
  assert.deepEqual(errors, []);
});

test('owner starts fresh context with the exact optional handoff only after confirming the current idle session', async () => {
  const project = { id: 'fixture', title: 'Project fixture' };
  const first = { session: 'original', id: 'request-one', status: 'done', admitted: true };
  const other = { session: 'other', id: 'request-two', status: 'done', admitted: true };
  const calls = [];
  const notices = [];
  const errors = [];
  const commands = new Map();
  const title = 'Start fresh context';
  const folder = { uri: { scheme: 'file', fsPath: '/fixture' } };
  const inspectedEditor = { document: { uri: { scheme: 'untitled' } } };
  const handoff = '  Review cache ownership before editing <new> & `old`.  ';
  let selected = first;
  let chooseReset = true;
  let mode = 'cancel-input';
  let version = 0;
  let availableActions;
  let foldersChanged;
  let editorChanged;
  let inputPrompts = 0;
  let confirmations = 0;
  const invoke = () => commands.get('okbrain.runs')();
  const vscode = {
    commands: { registerCommand: (name, run) => commands.set(name, run) },
    env: {},
    workspace: {
      isTrusted: true,
      workspaceFolders: [folder],
      getConfiguration: () => ({ inspect: () => undefined }),
      registerTextDocumentContentProvider() {},
      onDidChangeWorkspaceFolders(listener) { foldersChanged = listener; },
      async openTextDocument(value) { return value; },
    },
    window: {
      activeTextEditor: inspectedEditor,
      onDidChangeActiveTextEditor(listener) { editorChanged = listener; },
      async showTextDocument() {},
      async showQuickPick(items, options) {
        if (options.placeHolder === 'Choose a request to inspect') return items.find((item) => item.label === selected.id);
        availableActions = Array.from(items, (item) => item.label);
        return chooseReset ? items.find((item) => item.label === title) : undefined;
      },
      async showInputBox(options) {
        inputPrompts++;
        assert.equal(options.prompt, 'Optional handoff for the next request');
        assert.match(options.placeHolder, /One line/);
        assert.equal(options.validateInput(handoff), null);
        assert.match(options.validateInput('two\nlines'), /single line/);
        assert.equal(options.validateInput('é'.repeat(1024)), null);
        assert.match(options.validateInput('é'.repeat(1025)), /2,048 UTF-8 bytes/);
        if (mode === 'cancel-input') return undefined;
        if (mode === 'editor-changed-in-input') {
          this.activeTextEditor = undefined;
          editorChanged(undefined);
          this.activeTextEditor = inspectedEditor;
          editorChanged(inspectedEditor);
        }
        if (mode === 'blank') return '';
        return mode === 'whitespace-only' ? '  ' : handoff;
      },
      async showWarningMessage(message, options, button) {
        confirmations++;
        assert.match(message, /session original\?/);
        assert.match(message, /Saved runs stay available/);
        assert.equal(options.modal, true);
        assert.equal(button, 'Start Fresh Context');
        if (mode === 'blank' || mode === 'whitespace-only') assert.equal('detail' in options, false);
        else {
          assert.equal(options.detail, handoff);
          assert.match(message, /The next request you start.*include the handoff shown below/);
        }
        if (mode === 'decline') return undefined;
        if (mode === 'other-inspection') {
          chooseReset = false;
          selected = other;
          await invoke();
        }
        if (mode === 'workspace-changed') {
          vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: '/new-workspace' } }];
          foldersChanged();
          vscode.workspace.workspaceFolders = [folder];
          foldersChanged();
        }
        if (mode === 'editor-changed') {
          this.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: '/fixture/other.ts' } } };
          editorChanged(this.activeTextEditor);
          this.activeTextEditor = inspectedEditor;
          editorChanged(inspectedEditor);
        }
        return button;
      },
      async showInformationMessage(message) { notices.push(message); },
      async showErrorMessage(message, ...actions) {
        assert.equal(actions.length, 0);
        errors.push(message);
      },
    },
  };
  activateExtension(vscode, { projects: [project], async api(path, data) {
    assert.ok(path.startsWith('/projects/fixture/'));
    const action = path.slice('/projects/fixture/'.length);
    if (action === 'runs') return [first, other];
    if (action === 'inspect') return { run: data.requestId === first.id ? first : other,
      pi: { pendingRequestIds: mode === 'pending' ? ['still-running'] : [] } };
    calls.push([action, JSON.parse(JSON.stringify(data))]);
    if (action === 'reset-context-preview') return { version: `preview-${++version}`,
      ...(mode === 'preview-dropped-note' || data.handoff === undefined ? {} : {
        handoff: mode === 'preview-altered-note' ? data.handoff.trim() : data.handoff,
      }) };
    assert.equal(action, 'reset-context');
    if (mode === 'network-failure') throw new Error('Connection lost');
    return { reset: true, version: data.version };
  } });

  await invoke();
  assert.deepEqual(calls, []);
  assert.equal(confirmations, 0);
  mode = 'editor-changed-in-input';
  await invoke();
  assert.deepEqual(calls, []);
  assert.equal(confirmations, 0);
  mode = 'decline';
  await invoke();
  const withNote = { session: first.session, handoff };
  assert.deepEqual(calls.splice(0), [['reset-context-preview', withNote]]);
  assert.deepEqual(notices, []);
  mode = 'pending';
  await invoke();
  assert.ok(!availableActions.includes(title));
  assert.equal(inputPrompts, 3);
  assert.deepEqual(calls, []);
  mode = 'other-inspection';
  await invoke();
  assert.deepEqual(calls.splice(0), [['reset-context-preview', withNote]]);
  chooseReset = true;
  selected = first;
  mode = 'workspace-changed';
  await invoke();
  assert.deepEqual(calls.splice(0), [['reset-context-preview', withNote]]);
  mode = 'editor-changed';
  await invoke();
  assert.deepEqual(calls.splice(0), [['reset-context-preview', withNote]]);
  for (mode of ['preview-dropped-note', 'preview-altered-note']) {
    await invoke();
    assert.deepEqual(calls.splice(0), [['reset-context-preview', withNote]]);
    assert.deepEqual(errors.splice(0), ['Could not preview the handoff for this session. Update okbrain or leave the handoff blank.']);
  }
  mode = 'approve';
  await invoke();
  assert.deepEqual(calls.splice(0), [['reset-context-preview', withNote],
    ['reset-context', { ...withNote, version: 'preview-7' }]]);
  mode = 'blank';
  await invoke();
  assert.deepEqual(calls.splice(0), [['reset-context-preview', { session: first.session }],
    ['reset-context', { session: first.session, version: 'preview-8' }]]);
  mode = 'whitespace-only';
  await invoke();
  assert.deepEqual(calls.splice(0), [['reset-context-preview', { session: first.session }],
    ['reset-context', { session: first.session, version: 'preview-9' }]]);
  assert.match(notices[0], /Saved runs remain/);
  assert.ok(notices.every((message) => !message.includes(handoff)));
  mode = 'network-failure';
  await invoke();
  assert.deepEqual(calls.map(([action]) => action), ['reset-context-preview', 'reset-context']);
  assert.deepEqual(errors, ['Connection lost']);
});
