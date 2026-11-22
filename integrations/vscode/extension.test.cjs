'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function activateExtension(vscode, connection) {
  const file = require.resolve('./extension.cjs');
  const module = { exports: {} };
  runInNewContext(readFileSync(file, 'utf8'), {
    module,
    URL,
    require(id) {
      if (id === 'vscode') return vscode;
      if (id === './connection.cjs') return { ...require(id), connect: async () => connection };
      return require(id);
    },
  }, { filename: file });
  module.exports.activate({ subscriptions: [] });
}

test('editor review opens approved source in a read-only document only on request', async () => {
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
  let sourceReads = 0;
  let provideSource;
  const commands = new Map();
  const connection = {
    projects: [project],
    async api(path, identity) {
      if (path === '/projects/fixture/runs') return runs;
      if (path === '/projects/fixture/inspect') return { run: runs.find((run) => run.id === identity.requestId) };
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
  selectedRun = 'saved';
  await inspect();
  assert.ok(availableActions.includes('View saved request source'));
  assert.equal(sourceReads, 0);
  assert.ok(!lastDocument.text.includes(source.prompt));

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
