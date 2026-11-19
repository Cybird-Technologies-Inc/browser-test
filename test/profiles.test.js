'use strict';
// Guards the example profiles against typos: each must pass the real config loader.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib');

const dir = path.join(__dirname, '..', 'profiles');

function parseEnvFile(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.env'))) {
  test(`profile ${file} is a valid config`, () => {
    const env = parseEnvFile(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(Object.keys(env).length > 0, 'profile sets nothing');
    lib.loadConfig(env, fs);
  });
}
