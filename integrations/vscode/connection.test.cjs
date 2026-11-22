'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { localUrl, projectFile } = require('./connection.cjs');

test('editor credentials are restricted to a local server origin', () => {
  assert.equal(localUrl('http://127.0.0.1:6522/').origin, 'http://127.0.0.1:6522');
  for (const address of [
    'https://127.0.0.1:6522/', 'http://127.0.0.1:6522@evil.example/',
    'http://user@127.0.0.1:6522/', 'http://127.0.0.1:6522/?redirect=https://evil.example/',
    'http://192.168.1.1:6522/', 'http://127.0.0.1:6522/elsewhere',
  ]) assert.throws(() => localUrl(address));
});

test('only a contained absolute file resolves to a project-relative path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'okbrain-editor-'));
  try {
    const repo = join(base, 'repo');
    await mkdir(join(repo, 'lib'), { recursive: true });
    const local = join(repo, 'lib', 'note.txt');
    const outside = join(base, 'outside.txt');
    await writeFile(local, 'local');
    await writeFile(outside, 'outside');
    assert.equal(await projectFile(repo, local), 'lib/note.txt');
    assert.equal(await projectFile(repo, outside), null);
  } finally { await rm(base, { recursive: true, force: true }); }
});
