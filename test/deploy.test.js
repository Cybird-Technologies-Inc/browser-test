'use strict';
// Offline checks for deploy/. Nothing here calls the network or a real `aws`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const deployDir = path.join(root, 'deploy');

function listFiles(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}
const scripts = listFiles(deployDir, '.sh');

test('deploy scripts exist', () => {
  assert.ok(scripts.length >= 7, `found ${scripts.length} scripts`);
});

test('every deploy script passes bash -n and has the strict header', () => {
  for (const s of scripts) {
    const r = spawnSync('bash', ['-n', s], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${s}: ${r.stderr}`);
    const text = fs.readFileSync(s, 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env bash\n'), `${s}: shebang`);
    assert.ok(/^set -euo pipefail$/m.test(text), `${s}: set -euo pipefail`);
  }
});

// Runs install.sh with a fake `aws` that fails the test if it is ever called.
function runInstall(extraEnv, removeKeys = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  const marker = path.join(dir, 'aws-was-called');
  try {
    const shim = path.join(dir, 'aws');
    fs.writeFileSync(shim, `#!/bin/sh\necho "$@" > "${marker}"\nexit 99\n`, { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      DRY_RUN: '1',
      ALLOW_DIRTY: '1',
      ALERT_EMAIL: 'ops@example.invalid',
      LEOHAT_DNS_IP: '192.0.2.1',
      VPC_ID: 'vpc-00000000',
      SUBNET_ID: 'subnet-00000000',
      ...extraEnv,
    };
    for (const k of removeKeys) delete env[k];
    const r = spawnSync('bash', [path.join(deployDir, 'aws', 'install.sh')], { encoding: 'utf8', env });
    return { r, called: fs.existsSync(marker) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('install.sh DRY_RUN exits 0, prints the plan and never calls aws', () => {
  const { r, called } = runInstall({});
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(called, false, 'aws must not be called in DRY_RUN');
  assert.match(r.stderr, /000000000000/);
  for (const want of ['create private bucket', 'create topic', 'inline policy', 'security group',
    'launch ONE', 'Elastic IP', 'browser-test-heartbeat-missing']) {
    assert.ok(r.stderr.includes(want), `plan mentions "${want}"`);
  }
});

test('install.sh names the missing variable and does not call aws', () => {
  for (const name of ['ALERT_EMAIL', 'LEOHAT_DNS_IP', 'VPC_ID', 'SUBNET_ID']) {
    const { r, called } = runInstall({}, [name]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(name));
    assert.strictEqual(called, false);
  }
});

test('install.sh rejects a malformed DNS IP (hostile input)', () => {
  const { r } = runInstall({ LEOHAT_DNS_IP: "1.2.3.4'; rm -rf /" });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /LEOHAT_DNS_IP/);
});

test('repo holds no alert email or resolver IP values', () => {
  for (const f of [...scripts, path.join(deployDir, 'README.md')]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/[\w.-]+@(?!example)[\w-]+\.[a-z]{2,}/i.test(text.replace(/you@your-domain/g, '')), `${f}: email-like value`);
  }
});

test('systemd units carry the expected keys', () => {
  const sd = path.join(deployDir, 'instance', 'systemd');
  const svc = fs.readFileSync(path.join(sd, 'browser-test.service'), 'utf8');
  for (const k of ['Type=oneshot', 'User=browsertest', 'EnvironmentFile=/etc/browser-test/env',
    'TimeoutStartSec=20min', 'OnFailure=browser-test-alert.service', 'NoNewPrivileges=true',
    'ProtectSystem=strict', 'ReadWritePaths=/var/lib/browser-test', 'PrivateTmp=true', 'ProtectHome=true']) {
    assert.ok(svc.includes(k), `service has ${k}`);
  }
  const timer = fs.readFileSync(path.join(sd, 'browser-test.timer'), 'utf8');
  for (const k of ['OnCalendar=*:0/15', 'RandomizedDelaySec=60', 'Persistent=false']) {
    assert.ok(timer.includes(k), `timer has ${k}`);
  }
  const alert = fs.readFileSync(path.join(sd, 'browser-test-alert.service'), 'utf8');
  assert.ok(alert.includes('Type=oneshot') && alert.includes('alert.sh'));
});

test('IAM policy in install.sh is least privilege', () => {
  const text = fs.readFileSync(path.join(deployDir, 'aws', 'install.sh'), 'utf8');
  assert.ok(!/s3:\*/.test(text), 'no s3:*');
  assert.ok(!/"Action": "\*"/.test(text), 'no wildcard action');
  const wild = text.match(/"Resource": "\*"/g) || [];
  assert.strictEqual(wild.length, 1, 'exactly one wildcard resource');
  const stmt = text.slice(text.indexOf('"Sid": "Heartbeat"'));
  assert.ok(stmt.indexOf('cloudwatch:PutMetricData') < stmt.indexOf('"Resource": "*"'), 'wildcard belongs to PutMetricData');
  assert.ok(stmt.includes('cloudwatch:namespace'), 'namespace condition present');
  assert.ok(text.includes('/results/*') && text.includes('/releases/*'));
});

test('setup.sh keeps DNS safe: empty FallbackDNS, checksum check, env not overwritten', () => {
  const text = fs.readFileSync(path.join(deployDir, 'instance', 'setup.sh'), 'utf8');
  assert.match(text, /^FallbackDNS=$/m);
  assert.ok(text.includes('sha256sum -c'));
  assert.ok(text.includes('[ ! -f "$CONF_DIR/env" ]'));
  assert.ok(text.indexOf('--- 7. DNS, LAST') > text.indexOf('--- 6. systemd units'));
});
