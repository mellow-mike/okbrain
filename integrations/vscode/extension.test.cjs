'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
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
      if (id === './connection.cjs') return { connect: async () => connection };
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
