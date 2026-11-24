'use strict';
// Offline tests for run.js helpers (report.js): no network, no browser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const lib = require('../lib');
const r = require('../report');

test('parseDuration needs a unit and a positive value', () => {
  assert.strictEqual(r.parseDuration('10m', 'x'), 600000);
  assert.strictEqual(r.parseDuration('90s', 'x'), 90000);
  assert.strictEqual(r.parseDuration('1.5h', 'x'), 5400000);
  for (const bad of ['10', 'ten', '0m', '-5m', '', '5 minutes']) assert.throws(() => r.parseDuration(bad, '--d'), /--d/);
});

test('nextOccurrence picks today if still ahead, else tomorrow, and rejects bad input', () => {
  const now = new Date(2026, 0, 10, 12, 0, 0);
  assert.strictEqual(r.nextOccurrence('14:30', now).getDate(), 10);
  assert.strictEqual(r.nextOccurrence('09:00', now).getDate(), 11);
  assert.strictEqual(r.nextOccurrence('12:00', now).getDate(), 11);
  for (const bad of ['25:00', '12:60', 'noon', '1230']) assert.throws(() => r.nextOccurrence(bad), /HH:MM/);
});

test('parseArgs accepts the documented form', () => {
  const o = r.parseArgs(['203.0.113.10', '--duration', '10m', '--rounds', '2', '--gap', '5m', '--label', 'x']);
  assert.deepStrictEqual([o.ip, o.durationMs, o.roundsN, o.gapMs, o.label], ['203.0.113.10', 600000, 2, 300000, 'x']);
  assert.strictEqual(r.parseArgs(['203.0.113.10']).gapMs, 0);
});

test('parseArgs lists every problem and never accepts a non-IPv4, extra argument or unknown flag', () => {
  assert.throws(() => r.parseArgs([]), /resolver IPv4/);
  assert.throws(() => r.parseArgs(['dns.example.com']), /not an IPv4/);
  assert.throws(() => r.parseArgs(['1.2.3.4', '5.6.7.8']), /Only one resolver IP/);
  assert.throws(() => r.parseArgs(['1.2.3.4', '--bogus', '1']), /Unknown option/);
  assert.throws(() => r.parseArgs(['1.2.3.4', '--duration']), /needs a value/);
  assert.throws(() => r.parseArgs(['1.2.3.4', '--rounds', '0']), /whole number/);
  assert.throws(() => r.parseArgs(['1.2.3.4', '--expect-blocked', 'malware']), /--blocked-urls/);
  assert.throws(() => r.parseArgs(['1.2.3.4', '--block-page-ips', 'nope']), /not an IP/);
  try { r.parseArgs(['x', '--rounds', 'a', '--duration', 'b']); assert.fail('should throw'); } catch (e) { assert.ok(e.optionErrors.length >= 3); }
});

test('parseArgs treats an IP with shell-like text as invalid (hostile input)', () => {
  assert.throws(() => r.parseArgs(['1.2.3.4; rm -rf /']), /not an IPv4/);
});

test('cycleEnv is DNS-only, passes the IP, and sets nothing the user did not ask for', () => {
  const o = r.parseArgs(['203.0.113.10']);
  const env = r.cycleEnv(o, '/tmp/x', { PATH: 'p' });
  assert.strictEqual(env.PAGE_LOADS, 'false');
  assert.strictEqual(env.RESOLVER_DNS_IP, '203.0.113.10');
  assert.strictEqual(env.RESOLVER_LABEL, '203.0.113.10');
  for (const k of ['BLOCKED_URLS', 'EXPECT_BLOCKED_CATEGORIES', 'BLOCK_PAGE_IPS', 'SAMPLE_DNS']) assert.ok(!(k in env), k);
  // The child's config loader must accept it.
  lib.loadConfig({ ...env, DNS_DOMAINS: 'a.example.com' }, fs);
});

test('PAGE_LOADS=false removes every page from the config; bad value is rejected', () => {
  assert.strictEqual(lib.loadConfig({ PAGE_LOADS: 'false' }, fs).urls.length, 0);
  assert.ok(lib.loadConfig({}, fs).urls.length > 0);
  assert.throws(() => lib.loadConfig({ PAGE_LOADS: 'maybe' }, fs), /PAGE_LOADS/);
});

const cyc = (round, cycle, first, repeat, failed = 0, failedDomains = []) => ({
  round, cycle, startedAt: '2026-01-01T00:00:00Z',
  summary: { config: { randomSeed: 7 }, dnsChecks: { total: 24, failed, failedDomains, first: { p50: first / 2, p95: first }, repeat: { p50: 1, p95: repeat } }, blocked: null },
});

test('aggregate sums lookups, ranges P95 across cycles and counts failed cycles', () => {
  const a = r.aggregate([cyc(1, 1, 100, 3), cyc(1, 2, 300, 5, 2, ['a.com (ETIMEOUT)']), { round: 1, cycle: 3, error: 'killed', summary: null }]);
  assert.strictEqual(a.cycles, 3);
  assert.strictEqual(a.cyclesFailed, 1);
  assert.strictEqual(a.lookups, 48);
  assert.strictEqual(a.failed, 2);
  assert.deepStrictEqual([a.firstP95.min, a.firstP95.max], [100, 300]);
  assert.strictEqual(a.failedDomains['a.com (ETIMEOUT)'], 1);
});

test('aggregate with no successful cycle gives nulls, not NaN', () => {
  const a = r.aggregate([{ round: 1, cycle: 1, error: 'x', summary: null }]);
  assert.strictEqual(a.lookups, 0);
  assert.strictEqual(a.firstP95.median, null);
  assert.strictEqual(a.failureRate, 0);
});

test('renderHtml escapes hostile text and survives an all-failed run', () => {
  const evil = '<script>alert(1)</script>';
  const run = {
    ip: '1.2.3.4', label: evil, startedAt: 's', finishedAt: 'f', interrupted: true,
    options: { label: evil },
    rounds: [{ n: 1, cycles: [{ round: 1, cycle: 1, startedAt: 's', summary: null, error: evil }] }],
  };
  const html = r.renderHtml(run);
  assert.ok(!html.includes(evil), 'raw script tag must not appear');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('stopped early'));
  assert.ok(html.includes('Nothing to chart') || html.includes('nothing to chart'));
});

test('renderHtml shows rounds, cycles, failed names and the category table', () => {
  const c = cyc(1, 1, 120, 3, 1, ['bad.example (ENOTFOUND)']);
  c.summary.blocked = { total: 4, blockFailed: 1, perCategory: { malware: { expected: 'blocked', total: 4, blockedOk: 3, allowedOk: 0 } } };
  const html = r.renderHtml({ ip: '1.2.3.4', label: 'L', startedAt: 's', finishedAt: 'f', interrupted: false, options: { expectBlocked: 'malware' }, rounds: [{ n: 1, cycles: [c, cyc(1, 2, 140, 4)] }] });
  for (const t of ['bad.example (ENOTFOUND)', 'Category check', 'malware', '<polyline', 'Per round', 'Per cycle']) assert.ok(html.includes(t), t);
});

test('parseArgs: --compare must be a different IPv4; --compare-label needs --compare', () => {
  const o = r.parseArgs(['1.2.3.4', '--compare', '8.8.8.8', '--compare-label', 'pub']);
  assert.deepStrictEqual([o.compare, o.compareLabel], ['8.8.8.8', 'pub']);
  assert.throws(() => r.parseArgs(['1.2.3.4', '--compare', 'dns.google']), /not an IPv4/);
  assert.throws(() => r.parseArgs(['1.2.3.4', '--compare', '1.2.3.4']), /different resolver/);
  assert.throws(() => r.parseArgs(['1.2.3.4', '--compare-label', 'x']), /needs --compare/);
});

test('cycleEnv: reference gets the same seed and names, its own IP, and no category policy', () => {
  const o = r.parseArgs(['1.2.3.4', '--blocked-urls', 'p.txt', '--expect-blocked', 'malware', '--block-page-ips', '10.0.0.1', '--sample-dns', '5']);
  const t = r.cycleEnv(o, '/x', { PATH: 'p' }, { seed: 42 });
  const f = r.cycleEnv(o, '/x/ref', { PATH: 'p' }, { ip: '8.8.8.8', label: 'pub', reference: true, seed: 42 });
  assert.deepStrictEqual([t.RANDOM_SEED, f.RANDOM_SEED], ['42', '42']);
  assert.deepStrictEqual([t.RESOLVER_DNS_IP, f.RESOLVER_DNS_IP, f.RESOLVER_LABEL], ['1.2.3.4', '8.8.8.8', 'pub']);
  assert.strictEqual(t.SAMPLE_DNS, f.SAMPLE_DNS);
  assert.strictEqual(t.EXPECT_BLOCKED_CATEGORIES, 'malware');
  for (const k of ['BLOCKED_URLS', 'EXPECT_BLOCKED_CATEGORIES', 'BLOCK_PAGE_IPS', 'SAMPLE_BLOCKED']) assert.ok(!(k in f), k);
});

test('same RANDOM_SEED gives target and reference the same DNS names', () => {
  const names = Array.from({ length: 30 }, (_, i) => `n${i}.example.com`).join(',');
  const pick = seed => lib.loadConfig({ DNS_DOMAINS: names, SAMPLE_DNS: '8', RANDOM_SEED: String(seed), PAGE_LOADS: 'false' }, fs).dnsDomains;
  assert.deepStrictEqual(pick(99), pick(99));
});

test('renderHtml with a reference shows both lines, the difference and survives a failed reference cycle', () => {
  const a = cyc(1, 1, 200, 3); a.ref = cyc(1, 1, 50, 20);
  const b = cyc(1, 2, 100, 3); b.ref = { summary: null, error: 'killed' };
  const html = r.renderHtml({ ip: '1.2.3.4', label: 'T', compare: { ip: '8.8.8.8', label: 'Pub' }, startedAt: 's', finishedAt: 'f', interrupted: false, options: {}, rounds: [{ n: 1, cycles: [a, b] }] });
  for (const t of ['Pub (reference)', 'class="line s1"', '+150', 'Cycles slower than reference', 'Reference first P95']) assert.ok(html.includes(t), t);
  assert.ok(!html.includes('NaN'));
});

test('renderHtml without a reference has no comparison parts', () => {
  const html = r.renderHtml({ ip: '1.2.3.4', label: 'T', compare: null, startedAt: 's', finishedAt: 'f', interrupted: false, options: {}, rounds: [{ n: 1, cycles: [cyc(1, 1, 100, 3)] }] });
  assert.ok(!html.includes('Reference'));
});

test('parseHostPort and ip:port for the resolver and the reference', () => {
  assert.deepStrictEqual(r.parseHostPort('1.2.3.4', 'x', []), { ip: '1.2.3.4', port: 53 });
  assert.deepStrictEqual(r.parseHostPort('127.0.0.1:5353', 'x', []), { ip: '127.0.0.1', port: 5353 });
  for (const bad of ['1.2.3', 'a.b.c.d', '1.2.3.4:0', '1.2.3.4:70000', '1.2.3.4:x', '1.2.3.4:53:1']) { const e = []; assert.strictEqual(r.parseHostPort(bad, 'x', e), null, bad); assert.strictEqual(e.length, 1); }
  const o = r.parseArgs(['1.2.3.4:5300', '--compare', '1.2.3.4:5301']);
  assert.deepStrictEqual([o.ip, o.port, o.compare, o.comparePort], ['1.2.3.4', 5300, '1.2.3.4', 5301]);
  assert.throws(() => r.parseArgs(['1.2.3.4:5300', '--compare', '1.2.3.4:5300']), /different resolver/);
  assert.strictEqual(r.cycleEnv(o, '/x', {}, { ip: o.compare, port: o.comparePort, reference: true }).RESOLVER_DNS_PORT, '5301');
  assert.strictEqual(r.cycleEnv(r.parseArgs(['1.2.3.4']), '/x', {}).RESOLVER_DNS_PORT, '53');
});

test('RESOLVER_DNS_PORT: default 53, range checked, serverAddress formats ip:port', () => {
  assert.strictEqual(lib.loadConfig({}, fs).resolverPort, 53);
  assert.strictEqual(lib.loadConfig({ RESOLVER_DNS_PORT: '5353' }, fs).resolverPort, 5353);
  for (const bad of ['0', '70000', 'x', '53.5']) assert.throws(() => lib.loadConfig({ RESOLVER_DNS_PORT: bad }, fs), /RESOLVER_DNS_PORT/);
  assert.strictEqual(lib.serverAddress({ resolverIp: '1.2.3.4', resolverPort: 53 }), '1.2.3.4');
  assert.strictEqual(lib.serverAddress({ resolverIp: '1.2.3.4', resolverPort: 5353 }), '1.2.3.4:5353');
});

test('--interval has a 10 s floor', () => {
  assert.throws(() => r.parseArgs(['1.2.3.4', '--interval', '5s']), /10s minimum/);
  assert.strictEqual(r.parseArgs(['1.2.3.4', '--interval', '10s']).intervalMs, 10000);
});

test('cycleFailureReason: timeout, user stop and other signals are told apart', () => {
  assert.match(r.cycleFailureReason({ timedOut: true, signal: 'SIGKILL', timeoutMs: 1000 }), /timed out after 1000 ms/);
  assert.strictEqual(r.cycleFailureReason({ signal: 'SIGTERM', stopping: true }), 'stopped by user');
  assert.match(r.cycleFailureReason({ signal: 'SIGSEGV' }), /SIGSEGV/);
  assert.match(r.cycleFailureReason({ code: 2 }), /invalid configuration/);
  assert.strictEqual(r.cycleFailureReason({ code: 0 }), null);
});

test('classifyPreflight: only a missing answer needs action; "no such name" proves the resolver answered', () => {
  assert.strictEqual(r.classifyPreflight(null).ok, true);
  assert.strictEqual(r.classifyPreflight({ code: 'ENOTFOUND' }).ok, true);
  for (const code of ['ETIMEOUT', 'EREFUSED', 'ECONNREFUSED', 'ESERVFAIL', 'WEIRD']) { const x = r.classifyPreflight({ code }); assert.strictEqual(x.ok, false); assert.ok(x.hint); }
});

test('renderHtml: failed preflight shows an alert; slow cycles are called out', () => {
  const base = { ip: '1.2.3.4', label: 'T', compare: null, startedAt: 's', finishedAt: 'f', interrupted: false, options: {}, rounds: [] };
  const pf = r.renderHtml({ ...base, preflight: { ok: false, resolver: 'T', address: '1.2.3.4:53', code: 'ETIMEOUT', hint: 'no answer.' } });
  assert.ok(pf.includes('Action needed: the test did not start') && pf.includes('role="alert"'));
  const slow = cyc(1, 1, 100, 3); slow.durationMs = 90000;
  const html = r.renderHtml({ ...base, intervalMs: 60000, rounds: [{ n: 1, cycles: [slow] }] });
  assert.ok(html.includes('took longer than the 60 s interval'));
  assert.ok(!r.renderHtml({ ...base, rounds: [] }).includes('Action needed'));
});
