'use strict';
// Placeholder guard until the pure helpers are exported (PR 1 item 8):
// proves the script parses without launching a browser.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('browser-test.js has valid syntax', () => {
  const file = path.join(__dirname, '..', 'browser-test.js');
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});
