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
  assert.ok(scripts.length >= 9, `found ${scripts.length} scripts`);
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
      RESOLVER_DNS_IP: '192.0.2.1',
      RESOLVER_LABEL: 'isp-example',
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
    'launch ONE', 'Elastic IP', 'browser-test-heartbeat-isp-example']) {
    assert.ok(r.stderr.includes(want), `plan mentions "${want}"`);
  }
});

test('install.sh names the missing variable and does not call aws', () => {
  for (const name of ['ALERT_EMAIL', 'RESOLVER_DNS_IP', 'RESOLVER_LABEL', 'VPC_ID', 'SUBNET_ID']) {
    const { r, called } = runInstall({}, [name]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(name));
    assert.strictEqual(called, false);
  }
});

test('install.sh rejects a malformed DNS IP (hostile input)', () => {
  const { r } = runInstall({ RESOLVER_DNS_IP: "1.2.3.4'; rm -rf /" });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /RESOLVER_DNS_IP/);
});

test('install.sh accepts the deprecated LEOHAT_DNS_IP name with a warning', () => {
  const { r, called } = runInstall({ LEOHAT_DNS_IP: '192.0.2.9' }, ['RESOLVER_DNS_IP']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr + r.stdout, /deprecated/i);
  assert.strictEqual(called, false);
});

test('install.sh rejects a hostile resolver label', () => {
  const { r } = runInstall({ RESOLVER_LABEL: "a'; rm -rf /" });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /RESOLVER_LABEL/);
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
  for (const k of ['Type=oneshot', 'User=root', 'ExecStart=/opt/browser-test/current/deploy/instance/run-all.sh',
    'TimeoutStartSec=90min', 'OnFailure=browser-test-alert.service', 'NoNewPrivileges=true',
    'ProtectSystem=strict', 'ReadWritePaths=/etc/systemd/resolved.conf.d /var/lib/browser-test /run', 'PrivateTmp=true', 'ProtectHome=true']) {
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

// ---------- many-target model ----------

// Runs a deploy/aws script in DRY_RUN with a fake aws that fails the test if called.
function runAws(script, args, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
  const marker = path.join(dir, 'aws-was-called');
  try {
    fs.writeFileSync(path.join(dir, 'aws'), `#!/bin/sh\necho "$@" > "${marker}"\nexit 99\n`, { mode: 0o755 });
    const r = spawnSync('bash', [path.join(deployDir, 'aws', script), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DRY_RUN: '1', ...extraEnv },
    });
    return { r, called: fs.existsSync(marker) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('add-target.sh and remove-target.sh DRY_RUN: exit 0, no aws call', () => {
  let x = runAws('add-target.sh', ['isp-a', '192.0.2.7']);
  assert.strictEqual(x.r.status, 0, x.r.stderr);
  assert.strictEqual(x.called, false);
  assert.match(x.r.stderr, /targets\/isp-a\.env/);
  assert.match(x.r.stderr, /browser-test-heartbeat-isp-a/);
  x = runAws('remove-target.sh', ['isp-a']);
  assert.strictEqual(x.r.status, 0, x.r.stderr);
  assert.strictEqual(x.called, false);
});

test('add-target.sh and remove-target.sh reject bad input', () => {
  const bad = [
    ['add-target.sh', []], ['add-target.sh', ['isp-a']], ['add-target.sh', ['bad label', '192.0.2.7']],
    ['add-target.sh', ['../x', '192.0.2.7']], ['add-target.sh', ['isp-a', '999.1.1.1']],
    ['add-target.sh', ['isp-a', "1.2.3.4;id"]], ['add-target.sh', ['a'.repeat(41), '192.0.2.7']],
    ['remove-target.sh', []], ['remove-target.sh', ['a b']], ['remove-target.sh', ['x;y']],
  ];
  for (const [script, args] of bad) {
    const { r, called } = runAws(script, args);
    assert.notStrictEqual(r.status, 0, `${script} ${args.join(' ')}`);
    assert.strictEqual(called, false);
  }
});

test('uninstall.sh DRY_RUN lists alarms by prefix and calls no aws', () => {
  const { r, called } = runAws('uninstall.sh', []);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(called, false);
  assert.match(r.stderr, /browser-test-heartbeat-/);
});

// Sets up a fake instance layout and fake commands, then runs run-all.sh.
function runAll({ targets, npmRc = {}, lockHeld = false, noBucket = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runall-test-'));
  try {
    const conf = path.join(dir, 'conf');
    const state = path.join(dir, 'state');
    const app = path.join(dir, 'app');
    for (const d of [path.join(conf, 'targets'), state, app]) fs.mkdirSync(d, { recursive: true });
    if (!noBucket) fs.writeFileSync(path.join(conf, 'bucket'), 'test-bucket\n');
    fs.writeFileSync(path.join(conf, 'region'), 'ap-south-1\n');
    // The stale RESOLVER_LABEL must be ignored: the label comes from the file name.
    fs.writeFileSync(path.join(conf, 'env'), 'RESOLVER_LABEL=stale\nREPEATS=1\n');
    for (const [name, body] of Object.entries(targets)) fs.writeFileSync(path.join(conf, 'targets', name), body);
    const log = path.join(dir, 'calls.log');
    const rcFile = path.join(dir, 'rc.json');
    fs.writeFileSync(rcFile, JSON.stringify(npmRc));
    const mk = (name, body) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
      return p;
    };
    // Fake npm: records the label, writes summary.json, exits with the configured code.
    const npm = mk('fake-npm', `echo "npm label=$RESOLVER_LABEL out=$OUT_DIR" >> "${log}"
rc=$(node -e 'console.log((JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])||0)' "${rcFile}" "$RESOLVER_LABEL")
echo '{"thresholdViolations":[]}' > "$OUT_DIR/summary.json"; echo x > "$OUT_DIR/page-summary.csv"; echo x > "$OUT_DIR/request-details.csv"
exit $rc`);
    const aws = mk('fake-aws', `echo "aws $*" >> "${log}"`);
    const alert = mk('fake-alert', `echo "alert $*" >> "${log}"`);
    const sw = mk('fake-switch', `echo "switch $*" >> "${log}"`);
    let holder = null;
    if (lockHeld) {
      holder = require('node:child_process').spawn('bash', ['-c', `exec 9>"${path.join(state, 'run.lock')}"; flock 9; sleep 30`]);
      spawnSync('bash', ['-c', 'sleep 0.5']);
    }
    const r = spawnSync('bash', [path.join(deployDir, 'instance', 'run-all.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env, CONF_DIR: conf, APP: app, STATE_DIR: state, NPM_CMD: npm, AWS_CMD: aws,
        ALERT_CMD: alert, SET_RESOLVER_CMD: sw, RUN_AS: '', GETENT_CMD: 'true', TARGET_TIMEOUT: '30s',
      },
    });
    if (holder) holder.kill();
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { r, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('run-all.sh: sorted loop, per-target alerts, heartbeat rules, invalid names skipped', () => {
  const { r, calls } = runAll({
    targets: {
      'c-ok.env': 'RESOLVER_DNS_IP=192.0.2.3\n',
      'a-thr.env': 'RESOLVER_DNS_IP=192.0.2.1\n',
      'b-cfg.env': 'RESOLVER_DNS_IP=192.0.2.2\n',
      'bad name.env': 'RESOLVER_DNS_IP=192.0.2.9\n',
    },
    npmRc: { 'a-thr': 1, 'b-cfg': 2 },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /Skipping target file 'bad name\.env'/);
  const npmOrder = calls.filter((c) => c.startsWith('npm ')).map((c) => c.match(/label=(\S+)/)[1]);
  assert.deepStrictEqual(npmOrder, ['a-thr', 'b-cfg', 'c-ok']);
  assert.ok(calls.filter((c) => c.startsWith('npm ')).every((c) => /out=\S+\/(a-thr|b-cfg|c-ok)$/.test(c)));
  assert.deepStrictEqual(calls.filter((c) => c.startsWith('switch ')), ['switch 192.0.2.1', 'switch 192.0.2.2', 'switch 192.0.2.3']);
  const alerts = calls.filter((c) => c.startsWith('alert '));
  assert.strictEqual(alerts.length, 2);
  assert.match(alerts[0], /^alert a-thr 1 results\/resolver=a-thr\//);
  assert.match(alerts[1], /^alert b-cfg 2 results\/resolver=b-cfg\//);
  const metrics = calls.filter((c) => c.includes('put-metric-data'));
  assert.strictEqual(metrics.length, 2);
  assert.ok(metrics.some((m) => m.includes('Resolver=a-thr')) && metrics.some((m) => m.includes('Resolver=c-ok')));
  assert.ok(!metrics.some((m) => m.includes('Resolver=b-cfg')), 'no heartbeat for exit 2');
  assert.ok(calls.some((c) => /s3 cp .*summary\.json s3:\/\/test-bucket\/results\/resolver=c-ok\/latest\.json/.test(c)));
  assert.ok(!calls.some((c) => c.includes('stale')), 'stale RESOLVER_LABEL ignored');
});

test('run-all.sh: a crash code (exit 7) alerts and the cycle still exits 0', () => {
  const { r, calls } = runAll({ targets: { 'x.env': 'RESOLVER_DNS_IP=192.0.2.1\n' }, npmRc: { x: 7 } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(calls.some((c) => c.startsWith('alert x 7 ')));
  assert.ok(!calls.some((c) => c.includes('put-metric-data')));
});

test('run-all.sh: an invalid IP in a target file alerts as config error and the rest still runs', () => {
  const { r, calls } = runAll({ targets: { 'a.env': 'RESOLVER_DNS_IP=nope\n', 'b.env': 'RESOLVER_DNS_IP=192.0.2.2\n' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(calls.some((c) => c.startsWith('alert a 2 ')));
  assert.ok(calls.some((c) => c.startsWith('npm label=b ')));
});

test('run-all.sh: no target files exits non-zero', () => {
  const { r, calls } = runAll({ targets: {} });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /No target files/);
  assert.strictEqual(calls.length, 0);
});

test('run-all.sh: missing bucket config exits non-zero', () => {
  const { r } = runAll({ targets: { 'a.env': 'RESOLVER_DNS_IP=192.0.2.1\n' }, noBucket: true });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /bucket/);
});

test('run-all.sh: a held lock exits 0 without running anything', () => {
  const { r, calls } = runAll({ targets: { 'a.env': 'RESOLVER_DNS_IP=192.0.2.1\n' }, lockHeld: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /Previous cycle still running/);
  assert.strictEqual(calls.length, 0);
});

test('setup.sh takes the run lock and uses the VPC resolver before any download', () => {
  const t = fs.readFileSync(path.join(deployDir, 'instance', 'setup.sh'), 'utf8');
  const lock = t.indexOf('flock -w');
  const vpc = t.indexOf('DNS=%s');
  const apt = t.indexOf('apt-get update');
  assert.ok(lock > 0 && vpc > 0 && apt > 0);
  assert.ok(lock < apt && vpc < apt, 'lock and VPC DNS must come before the first download');
});

test('add-target.sh writes the env line without printf escapes (a literal "n" once ended the IP)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'aws', 'add-target.sh'), 'utf8');
  assert.doesNotMatch(src, /printf RESOLVER_DNS_IP/);
});

test('IAM: the runner may read only latest.json under results/ (for the trend), not all results', () => {
  const text = fs.readFileSync(path.join(deployDir, 'aws', 'install.sh'), 'utf8');
  assert.match(text, /s3:GetObject",\n\s+"Resource": "arn:aws:s3:::'"\$BUCKET"'\/results\/resolver=\*\/latest\.json"/);
  assert.ok(!/GetObject[^}]*results\/\*/.test(text), 'no GetObject on results/*');
});
