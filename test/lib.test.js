'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lib = require('../lib');

const noFs = { existsSync: () => false, readFileSync: () => '' };

test('percentile: empty, single, interpolated', () => {
  assert.strictEqual(lib.percentile([], 0.5), null);
  assert.strictEqual(lib.percentile([7], 0.99), 7);
  assert.strictEqual(lib.percentile([10, 20, 30, 40], 0.5), 25);
  assert.strictEqual(lib.percentile([40, 10, 30, 20], 1), 40); // unsorted input
});

test('loadConfig: defaults equal the previous hardcoded values', () => {
  const c = lib.loadConfig({}, noFs);
  assert.deepStrictEqual(c.urls, lib.DEFAULT_URLS);
  assert.strictEqual(c.repeats, 1);
  assert.strictEqual(c.settleTimeMs, 3000);
  assert.strictEqual(c.scrollPage, true);
  assert.strictEqual(c.cacheLikeThresholdMs, 2);
  assert.strictEqual(c.maxP95DnsMs, null);
  assert.strictEqual(c.maxFailRate, null);
});

test('loadConfig: reads comma list and file with comments', () => {
  const c = lib.loadConfig({ URLS: 'https://a.test, https://b.test' }, noFs);
  assert.deepStrictEqual(c.urls, ['https://a.test', 'https://b.test']);
  const fs = { existsSync: () => true, readFileSync: () => '# list\nhttps://c.test # note\n\nhttps://d.test\n' };
  assert.deepStrictEqual(lib.loadConfig({ URLS: 'urls.txt' }, fs).urls, ['https://c.test', 'https://d.test']);
});

test('loadConfig: hostile or bad input is rejected, all errors reported at once', () => {
  assert.throws(
    () => lib.loadConfig({
      REPEATS: 'ten', CONCURRENCY: '0', SCROLL_PAGE: 'maybe', MAX_FAIL_RATE: '2',
      URLS: 'javascript:alert(1),file:///etc/passwd', BLOCK_PAGE_PATTERN: '(',
    }, noFs),
    err => err.configErrors.length === 7 && /REPEATS/.test(err.message)
  );
});

test('classifyBlocked: NXDOMAIN, block-page IP, pattern, real answer', () => {
  const opts = { blockPageIps: ['10.0.0.1'], blockPagePattern: /blocked by/i };
  assert.strictEqual(lib.classifyBlocked({ loadError: 'net::ERR_NAME_NOT_RESOLVED at x' }, opts), 'blocked_ok');
  assert.strictEqual(lib.classifyBlocked({ remoteIp: '10.0.0.1' }, opts), 'blocked_ok');
  assert.strictEqual(lib.classifyBlocked({ bodyText: 'Site Blocked by policy' }, opts), 'blocked_ok');
  assert.strictEqual(lib.classifyBlocked({ remoteIp: '1.2.3.4', bodyText: 'hello' }, opts), 'block_failed');
  assert.strictEqual(lib.classifyBlocked({ loadError: 'Timeout 45000ms exceeded' }, opts), 'block_failed');
});

test('summarizeResults: per-URL and global failure rate and DNS percentiles', () => {
  const pages = [
    { url: 'u1', failed: false }, { url: 'u1', failed: true },
    { url: 'u2', failed: false }, { url: 'u2', failed: false },
  ];
  const requests = [
    { page: 'u1', dnsMs: 20 }, { page: 'u1', dnsMs: 1 }, { page: 'u1', dnsMs: null },
    { page: 'u2', dnsMs: 40 },
  ];
  const s = lib.summarizeResults({ pages, requests, cacheLikeMs: 2 });
  assert.strictEqual(s.global.failed, 1);
  assert.strictEqual(s.global.failureRate, 0.25);
  assert.strictEqual(s.global.dns.count, 2); // the 1 ms cache-like and null values are excluded
  assert.strictEqual(s.perUrl.u1.failureRate, 0.5);
  assert.strictEqual(s.perUrl.u2.dns.p50, 40);
});

test('checkThresholds: pass, each limit alone, both, unset', () => {
  const g = { attempts: 10, failed: 2, failureRate: 0.2, dns: { p95: 120 } };
  assert.deepStrictEqual(lib.checkThresholds(g, {}), []);
  assert.deepStrictEqual(lib.checkThresholds(g, { maxP95DnsMs: 120, maxFailRate: 0.2 }), []); // equal is a pass
  assert.match(lib.checkThresholds(g, { maxP95DnsMs: 100 })[0], /MAX_P95_DNS_MS/);
  assert.match(lib.checkThresholds(g, { maxFailRate: 0.1 })[0], /MAX_FAIL_RATE/);
  assert.strictEqual(lib.checkThresholds(g, { maxP95DnsMs: 100, maxFailRate: 0.1 }).length, 2);
  // No DNS data must not fail the P95 check: the failure-rate limit covers a dead resolver.
  assert.deepStrictEqual(lib.checkThresholds({ ...g, dns: { p95: null } }, { maxP95DnsMs: 1 }), []);
});

test('checkThresholds: MAX_BLOCK_FAILED', () => {
  const g = { attempts: 1, failed: 0, failureRate: 0, dns: { p95: 1 } };
  const b = { total: 3, blockedOk: 2, blockFailed: 1 };
  assert.match(lib.checkThresholds(g, { maxBlockFailed: 0 }, b)[0], /MAX_BLOCK_FAILED/);
  assert.deepStrictEqual(lib.checkThresholds(g, { maxBlockFailed: 1 }, b), []);
  assert.deepStrictEqual(lib.checkThresholds(g, {}, b), []); // unset = report only
  assert.deepStrictEqual(lib.checkThresholds(g, { maxBlockFailed: 0 }, null), []);
});

test('isHttpFailure: 4xx and 5xx fail, 2xx/3xx and no status do not', () => {
  assert.strictEqual(lib.isHttpFailure(404), true);
  assert.strictEqual(lib.isHttpFailure(503), true);
  assert.strictEqual(lib.isHttpFailure(200), false);
  assert.strictEqual(lib.isHttpFailure(302), false);
  assert.strictEqual(lib.isHttpFailure(null), false);
});

test('withTimeout: resolves in time, rejects when hung, passes errors through', async () => {
  assert.strictEqual(await lib.withTimeout(Promise.resolve(1), 1000, 'x'), 1);
  await assert.rejects(lib.withTimeout(new Promise(() => {}), 20, 'timed out'), /timed out/);
  await assert.rejects(lib.withTimeout(Promise.reject(new Error('boom')), 1000, 'x'), /boom/);
});

test('csvEscape: commas, quotes, newlines, null', () => {
  assert.strictEqual(lib.csvEscape('a,"b"\n'), '"a,""b""\n"');
  assert.strictEqual(lib.csvEscape(null), '');
});
