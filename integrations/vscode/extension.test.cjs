'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

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
  const file = require.resolve('./extension.cjs');
  const module = { exports: {} };
  runInNewContext(readFileSync(file, 'utf8'), {
    module,
    require(id) {
      if (id === 'vscode') return vscode;
      if (id === './connection.cjs') return { connect: async () => connection };
      return require(id);
    },
  }, { filename: file });
  module.exports.activate({ subscriptions: [] });
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
