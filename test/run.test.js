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
