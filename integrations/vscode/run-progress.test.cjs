'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taskProgressLines } = require('./run-progress.cjs');

test('editor inspection prints only recognized Pi stage counts', () => {
  const progress = { stages: [
    { kind: 'package-review', pending: 0, running: 0, waiting: 1, completing: 0, payload: 'private source' },
    { kind: 'package-work', pending: 1, running: 2, waiting: 0, completing: 1 },
    { kind: 'unexpected-stage', running: 1 },
    { kind: { toString: 'private checkpoint' }, running: 1 },
    { kind: 'source-lookup', pending: 0, running: -1, waiting: '<tool output>' },
  ] };
  const lines = ['Package review · 1 waiting', 'Package work · 1 pending, 2 running, 1 finishing'];
  assert.deepEqual(taskProgressLines(progress, true), ['Current Pi tasks', ...lines]);
  assert.deepEqual(taskProgressLines(progress, false), ['Saved Pi task state', ...lines]);
  assert.deepEqual(taskProgressLines({ stages: [] }, true), []);
  assert.deepEqual(taskProgressLines(undefined, true), []);
});
