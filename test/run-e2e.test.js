'use strict';
// End-to-end tests for run.js against fake DNS servers on 127.0.0.1 (UDP). Offline: no internet, no real resolver.
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUN = path.join(__dirname, '..', 'run.js');

// mode: 'answer' answers every name (bad.example gets NXDOMAIN); 'silent' never replies;
// 'only-ok' answers only ok.example, so a long list stalls on the other names.
function fakeDns(mode) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      // Question name: length-prefixed labels from byte 12, then a zero byte, QTYPE and QCLASS.
      let i = 12; const labels = [];
      while (msg[i] !== 0) { labels.push(msg.toString('ascii', i + 1, i + 1 + msg[i])); i += msg[i] + 1; }
      const name = labels.join('.');
      const qEnd = i + 5;
      if (mode === 'silent' || (mode === 'only-ok' && name !== 'ok.example')) return;
      const head = Buffer.from(msg.subarray(0, 12));
      const nx = name === 'bad.example';
      head.writeUInt16BE(nx ? 0x8183 : 0x8180, 2);       // response; NXDOMAIN rcode 3
      head.writeUInt16BE(nx ? 0 : 1, 6);                   // answer count
      const q = msg.subarray(12, qEnd);
      const answer = nx ? Buffer.alloc(0) : Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 1]);
      sock.send(Buffer.concat([head, q, answer]), rinfo.port, rinfo.address);
    });
    sock.bind(0, '127.0.0.1', () => resolve({ port: sock.address().port, close: () => new Promise(r => sock.close(r)) }));
  });
}

function runCli(args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [RUN, ...args], { env: { ...process.env, DNS_LOOKUP_TIMEOUT_MS: '500', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('exit', code => resolve({ code, out, err }));
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'run-e2e-'));
const rm = d => fs.rmSync(d, { recursive: true, force: true });

test('2 rounds with --compare: results, reference columns, NXDOMAIN counted as failed name', async () => {
  const a = await fakeDns('answer'), b = await fakeDns('answer'), out = tmp();
  try {
    const r = await runCli([`127.0.0.1:${a.port}`, '--compare', `127.0.0.1:${b.port}`, '--compare-label', 'ref', '--label', 'tgt',
      '--duration', '1s', '--rounds', '2', '--dns-domains', 'ok.example,bad.example', '--dns-repeats', '2', '--out', out]);
    assert.strictEqual(r.code, 0, r.err + r.out);
    const res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    assert.strictEqual(res.rounds.length, 2);
    const c = res.rounds[0].cycles[0];
    assert.strictEqual(c.summary.dnsChecks.total, 4);
    assert.strictEqual(c.summary.dnsChecks.failed, 2);                    // bad.example, both passes
    assert.ok(c.ref.summary.dnsChecks.first.p95 !== null);
    assert.deepStrictEqual(c.summary.dnsChecks.slowest.map(x => x.host), ['ok.example']);   // answered names only
    const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
    for (const t of ['ref (reference)', 'bad.example (ENOTFOUND)', 'Cycle 1 first P95', '(UTC)', 'Slowest names on tgt']) assert.ok(html.includes(t), t);
  } finally { await a.close(); await b.close(); rm(out); }
});

test('a single domain is accepted as a list (was wrongly "file not found")', async () => {
  const a = await fakeDns('answer'), out = tmp();
  try {
    const r = await runCli([`127.0.0.1:${a.port}`, '--duration', '1s', '--dns-domains', 'ok.example', '--out', out]);
    assert.strictEqual(r.code, 0, r.err + r.out);
  } finally { await a.close(); rm(out); }
});

test('a missing file path and a bad name are rejected with exit 2', async () => {
  const a = await fakeDns('answer'), out = tmp();
  try {
    const r1 = await runCli([`127.0.0.1:${a.port}`, '--dns-domains', path.join(out, 'nope.txt'), '--out', path.join(out, 'o1')]);
    assert.strictEqual(r1.code, 2); assert.match(r1.err, /file not found/);
    const r2 = await runCli([`127.0.0.1:${a.port}`, '--dns-domains', 'bad name!', '--out', path.join(out, 'o2')]);
    assert.strictEqual(r2.code, 2); assert.match(r2.err, /invalid domain/);
  } finally { await a.close(); rm(out); }
});

test('preflight: a silent resolver stops the run with a loud ACTION NEEDED message and a report banner (exit 3)', async () => {
  const a = await fakeDns('silent'), out = tmp();
  try {
    const t0 = Date.now();
    const r = await runCli([`127.0.0.1:${a.port}`, '--duration', '1s', '--dns-domains', 'ok.example', '--label', 'dead', '--out', out]);
    assert.strictEqual(r.code, 3);
    assert.ok(Date.now() - t0 < 10000, 'must fail fast');
    for (const t of ['ACTION NEEDED BEFORE THE TEST CAN START', 'dead', 'approve THIS machine']) assert.ok(r.err.includes(t), t);
    const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
    assert.ok(html.includes('Action needed: the test did not start'));
    assert.strictEqual(fs.existsSync(path.join(out, 'round-1')), false, 'no cycle may run');
  } finally { await a.close(); rm(out); }
});

test('preflight also covers the reference resolver', async () => {
  const a = await fakeDns('answer'), b = await fakeDns('silent'), out = tmp();
  try {
    const r = await runCli([`127.0.0.1:${a.port}`, '--compare', `127.0.0.1:${b.port}`, '--compare-label', 'refdead', '--dns-domains', 'ok.example', '--out', out]);
    assert.strictEqual(r.code, 3);
    assert.ok(r.err.includes('refdead'));
  } finally { await a.close(); await b.close(); rm(out); }
});

test('an output folder that already holds a run is refused', async () => {
  const a = await fakeDns('answer'), out = tmp();
  try {
    const args = [`127.0.0.1:${a.port}`, '--duration', '1s', '--dns-domains', 'ok.example', '--out', out];
    assert.strictEqual((await runCli(args)).code, 0);
    const again = await runCli(args);
    assert.strictEqual(again.code, 2); assert.match(again.err, /already holds a run/);
  } finally { await a.close(); rm(out); }
});

test('a stale summary.json in a reused cycle folder is never reported as the new result', async () => {
  // Resolver answers only ok.example (the preflight name); the long list then stalls, so the 1 s cycle timeout fires.
  const a = await fakeDns('only-ok'), out = tmp();
  try {
    const dir = path.join(out, 'round-1', 'cycle-01');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ dnsChecks: { total: 3, failed: 0, first: { p95: 31.57 } } }));
    const r = await runCli([`127.0.0.1:${a.port}`, '--duration', '1s', '--cycle-timeout', '1s', '--dns-repeats', '3',
      '--dns-domains', 'ok.example,s1.example,s2.example,s3.example,s4.example,s5.example', '--out', out], { DNS_LOOKUP_TIMEOUT_MS: '2000' });
    assert.strictEqual(r.code, 0, r.err);
    const res = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    const c = res.rounds[0].cycles[0];
    assert.strictEqual(c.summary, null, 'old numbers must not appear');
    assert.match(c.error, /timed out after 1000 ms/);
  } finally { await a.close(); rm(out); }
});
