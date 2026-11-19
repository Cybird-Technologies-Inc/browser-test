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
      URLS: 'javascript:alert(1),file:///etc/passwd', BLOCKED_URLS: 'malware=not a domain!',
    }, noFs),
    err => err.configErrors.length === 7 && /REPEATS/.test(err.message)
  );
});

test('classifyBlocked: NXDOMAIN, sinkhole, real answer, mixed answer, resolver error', () => {
  const opts = { blockPageIps: ['10.0.0.1'] };
  assert.deepStrictEqual(lib.classifyBlocked({ errorCode: 'ENOTFOUND' }, opts), { result: 'blocked_ok', detail: 'NXDOMAIN' });
  assert.strictEqual(lib.classifyBlocked({ addresses: ['10.0.0.1'] }, opts).result, 'blocked_ok');
  assert.strictEqual(lib.classifyBlocked({ addresses: ['1.2.3.4'] }, opts).result, 'block_failed');
  // One real address next to the sinkhole is still a leak.
  assert.strictEqual(lib.classifyBlocked({ addresses: ['10.0.0.1', '1.2.3.4'] }, opts).result, 'block_failed');
  // A timeout or SERVFAIL proves nothing, so it must not pass.
  assert.match(lib.classifyBlocked({ errorCode: 'ETIMEOUT' }, opts).detail, /ETIMEOUT/);
  assert.strictEqual(lib.classifyBlocked({ errorCode: 'ESERVFAIL' }, opts).result, 'block_failed');
  // Without a configured sinkhole only NXDOMAIN passes.
  assert.strictEqual(lib.classifyBlocked({ addresses: ['10.0.0.1'] }, {}).result, 'block_failed');
});

test('parseBlockedList: categories, bare domains, URLs, files, bad input', () => {
  const errors = [];
  const list = lib.parseBlockedList('Malware=Bad.Example, phishing=https://p.example/x?a=b, plain.example', errors, noFs);
  assert.deepStrictEqual(list, [
    { category: 'malware', host: 'bad.example' },
    { category: 'phishing', host: 'p.example' },
    { category: 'uncategorized', host: 'plain.example' },
  ]);
  assert.deepStrictEqual(errors, []);
  const fs = { existsSync: () => true, readFileSync: () => '# feed sample\nmalware=m1.example # note\n\nphishing p1.example\n' };
  assert.deepStrictEqual(lib.parseBlockedList('f.txt', [], fs).map(e => e.category), ['malware', 'phishing']);
  const bad = [];
  lib.parseBlockedList('malware=a b;rm -rf', bad, noFs);
  assert.strictEqual(bad.length, 1);
});

test('summarizeBlocked: totals and per-category', () => {
  const s = lib.summarizeBlocked([
    { host: 'm1', category: 'malware', result: 'blocked_ok' },
    { host: 'm2', category: 'malware', result: 'blocked_ok' },
    { host: 'p1', category: 'phishing', result: 'blocked_ok' },
    { host: 'p2', category: 'phishing', result: 'block_failed' },
  ]);
  assert.deepStrictEqual([s.total, s.blockedOk, s.blockFailed], [4, 3, 1]);
  assert.deepStrictEqual(s.perCategory.phishing, { total: 2, blockedOk: 1, allowedOk: 0, overBlocked: 0, blockFailed: 1, expected: 'blocked' });
  assert.deepStrictEqual(s.failedDomains, ['p2']);
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

test('classifyFailure: reasons an operator can act on', () => {
  const f = (loadError, httpStatus) => lib.classifyFailure({ failed: true, loadError, httpStatus });
  assert.strictEqual(lib.classifyFailure({ failed: false }), null);
  assert.strictEqual(f('net::ERR_NAME_NOT_RESOLVED at https://x'), 'dns');
  assert.strictEqual(f('page.goto: Timeout 45000ms exceeded'), 'timeout');
  assert.strictEqual(f('timed out after 80000 ms'), 'timeout');
  assert.strictEqual(f('net::ERR_CERT_DATE_INVALID'), 'tls');
  assert.strictEqual(f('net::ERR_CONNECTION_RESET'), 'connection');
  assert.strictEqual(f(null, 403), 'http_4xx');
  assert.strictEqual(f(null, 503), 'http_5xx');
  assert.strictEqual(f(null, null), 'no_response');
  assert.strictEqual(f('weird'), 'other');
});

test('summarizeFailures: counts by reason and gives advice', () => {
  const s = lib.summarizeFailures([
    { url: 'a', failed: true, reason: 'http_4xx', httpStatus: 403 },
    { url: 'b', failed: false },
    { url: 'c', failed: true, reason: 'dns' },
  ]);
  assert.deepStrictEqual(s.byReason, { http_4xx: 1, dns: 1 });
  assert.strictEqual(s.failedUrls.length, 2);
  assert.match(s.advice.join(' '), /403 bot block/);
});

test('IGNORE_HTTP_STATUS: listed statuses do not fail, bad values are rejected', () => {
  assert.strictEqual(lib.isHttpFailure(403, [403]), false);
  assert.strictEqual(lib.isHttpFailure(500, [403]), true);
  assert.deepStrictEqual(lib.loadConfig({ IGNORE_HTTP_STATUS: '403, 429' }, noFs).ignoreHttpStatus, [403, 429]);
  assert.throws(() => lib.loadConfig({ IGNORE_HTTP_STATUS: '200' }, noFs), /IGNORE_HTTP_STATUS/);
});

test('DNS_DOMAINS and MAX_DNS_CHECK_FAIL_RATE: parsing, summary, threshold, hostile input', () => {
  const c = lib.loadConfig({ DNS_DOMAINS: 'A.example, b.example', DNS_REPEATS: '2', MAX_DNS_CHECK_FAIL_RATE: '0.1' }, noFs);
  assert.deepStrictEqual(c.dnsDomains, ['a.example', 'b.example']);
  assert.throws(() => lib.loadConfig({ DNS_DOMAINS: 'a b;rm -rf /' }, noFs), /DNS_DOMAINS/);
  const d = lib.summarizeDnsChecks([
    { host: 'a.example', ok: true, ms: 10 }, { host: 'a.example', ok: true, ms: 30 },
    { host: 'b.example', ok: false, ms: null, errorCode: 'ETIMEOUT' }, { host: 'b.example', ok: true, ms: 20 },
  ]);
  assert.deepStrictEqual([d.total, d.failed, d.failureRate, d.p50], [4, 1, 0.25, 20]);
  assert.deepStrictEqual(d.failedDomains, ['b.example (ETIMEOUT)']);
  const g = { attempts: 1, failed: 0, failureRate: 0, dns: { p95: 1 } };
  assert.match(lib.checkThresholds(g, { maxDnsCheckFailRate: 0.1 }, null, d)[0], /MAX_DNS_CHECK_FAIL_RATE/);
  assert.deepStrictEqual(lib.checkThresholds(g, {}, null, d), []);
});

test('compareRuns: deltas, newly failing, recovered, and no trend when not comparable', () => {
  const run = (resolver, failureRate, p95, perUrl) => ({
    resolver, startedAt: 't', global: { failureRate, dns: { p95 } }, perUrl,
  });
  const prev = run('r1', 0, 100, { a: { failed: 0 }, b: { failed: 1 } });
  const cur = run('r1', 0.2, 150, { a: { failed: 1 }, b: { failed: 0 } });
  const t = lib.compareRuns(prev, cur);
  assert.strictEqual(t.p95DnsMs.delta, 50);
  assert.deepStrictEqual([t.newlyFailed, t.recovered], [['a'], ['b']]);
  assert.match(t.notes.join(' '), /P95 DNS up 100 -> 150 ms \(50%\)/);
  assert.strictEqual(lib.compareRuns(null, cur), null);
  assert.strictEqual(lib.compareRuns({ junk: true }, cur), null);
  assert.strictEqual(lib.compareRuns(run('other', 0, 1, {}), cur), null); // never compare across resolvers
  assert.deepStrictEqual(lib.compareRuns(cur, cur).notes, []);
  assert.strictEqual(lib.compareRuns(run('r1', 0, null, {}), run('r1', 0, 5, {})).p95DnsMs.delta, null);
});

// ---- random mix and DNS load ramp ----

test('sampleItems: same seed gives the same mix, n caps at list size, no n keeps all', () => {
  const list = ['a', 'b', 'c', 'd', 'e', 'f'];
  const one = lib.sampleItems(list, 3, lib.makeRng(42));
  assert.deepStrictEqual(one, lib.sampleItems(list, 3, lib.makeRng(42)));
  assert.strictEqual(one.length, 3);
  assert.strictEqual(new Set(one).size, 3);
  assert.notDeepStrictEqual(lib.sampleItems(list, 3, lib.makeRng(1)), lib.sampleItems(list, 3, lib.makeRng(2)));
  assert.strictEqual(lib.sampleItems(list, 99, lib.makeRng(1)).length, 6);
  assert.deepStrictEqual(lib.sampleItems(list, null, lib.makeRng(1)), list);
  assert.deepStrictEqual(list, ['a', 'b', 'c', 'd', 'e', 'f']); // input never mutated
});

test('loadConfig: SAMPLE_* picks from the pool, RANDOM_SEED replays, bad values rejected', () => {
  const noFs = { existsSync: () => false };
  const env = { RANDOM_SEED: '7', SAMPLE_URLS: '2', SAMPLE_BLOCKED: '1', BLOCKED_URLS: 'malware=a.example,phishing=b.example,adult=c.example', THINK_TIME_MAX_MS: '500' };
  const a = lib.loadConfig(env, noFs);
  const b = lib.loadConfig(env, noFs);
  assert.strictEqual(a.urls.length, 2);
  assert.strictEqual(a.blocked.length, 3); // 1 per category, 3 categories
  assert.deepStrictEqual(a.urls, b.urls);
  assert.deepStrictEqual(a.blocked, b.blocked);
  assert.strictEqual(a.poolSizes.blocked, 3);
  assert.strictEqual(a.thinkTimeMaxMs, 500);
  assert.throws(() => lib.loadConfig({ SAMPLE_URLS: '0' }, noFs), /SAMPLE_URLS/);
  assert.throws(() => lib.loadConfig({ RANDOM_SEED: '-1' }, noFs), /RANDOM_SEED/);
  assert.throws(() => lib.loadConfig({ THINK_TIME_MAX_MS: '999999999' }, noFs), /THINK_TIME_MAX_MS/);
});

test('compareRuns: a URL missing from the sample is not "recovered"', () => {
  const run = perUrl => ({ resolver: 'r', global: { dns: { p95: 10 }, failureRate: 0 }, perUrl });
  const t = lib.compareRuns(run({ 'https://a': { failed: 1 }, 'https://b': { failed: 1 } }), run({ 'https://b': { failed: 0 } }));
  assert.deepStrictEqual(t.recovered, ['https://b']);
});

test('loadLoadConfig: needs confirmation, a valid IP, domains; ceilings cannot be raised', () => {
  const ok = { RESOLVER_DNS_IP: '10.0.0.1', CONFIRM_LOAD: 'yes', DNS_DOMAINS: 'a.example,b.example' };
  const noFs = { existsSync: () => false };
  const c = lib.loadLoadConfig(ok, noFs);
  assert.deepStrictEqual(c.steps, [5, 10, 25, 50]);
  assert.strictEqual(c.maxQps, 20);
  assert.throws(() => lib.loadLoadConfig({ ...ok, CONFIRM_LOAD: undefined }, noFs), /CONFIRM_LOAD/);
  assert.throws(() => lib.loadLoadConfig({ ...ok, CONFIRM_LOAD: 'true' }, noFs), /CONFIRM_LOAD/);
  assert.throws(() => lib.loadLoadConfig({ ...ok, RESOLVER_DNS_IP: '999.1.1.1' }, noFs), /RESOLVER_DNS_IP/);
  assert.throws(() => lib.loadLoadConfig({ ...ok, RESOLVER_DNS_IP: 'dns.example' }, noFs), /RESOLVER_DNS_IP/);
  assert.throws(() => lib.loadLoadConfig({ ...ok, DNS_DOMAINS: undefined }, noFs), /DNS_DOMAINS/);
  assert.throws(() => lib.loadLoadConfig({ ...ok, MAX_QPS: '21' }, noFs), /MAX_QPS/);
  assert.throws(() => lib.loadLoadConfig({ ...ok, LOAD_STEPS: '5,100' }, noFs), /LOAD_STEPS/);
  assert.throws(() => lib.loadLoadConfig({ ...ok, LOAD_STEPS: '10,5' }, noFs), /increase/);
  assert.deepStrictEqual(lib.loadLoadConfig({ ...ok, LOAD_MAX_CONCURRENCY: '10' }, noFs).steps, [5, 10]);
});

test('summarizeLoadStep and findDegradation', () => {
  const step = (concurrency, lat, errors = {}) => lib.summarizeLoadStep({ concurrency, durationMs: 10000, latencies: lat, errors });
  const s1 = step(5, [10, 20, 30]);
  assert.strictEqual(s1.errorRate, 0);
  assert.strictEqual(s1.achievedQps, 0.3);
  const s2 = step(10, [12, 25, 28]);
  const s3 = step(25, [100, 200, 300]);
  assert.deepStrictEqual(lib.findDegradation([s1, s2]), null);
  assert.strictEqual(lib.findDegradation([s1, s2, s3]).concurrency, 25);
  const bad = step(10, [10], { ETIMEOUT: 9 });
  assert.match(lib.findDegradation([s1, bad]).reason, /error rate/);
  assert.strictEqual(step(5, [], {}).errorRate, 0);
  assert.strictEqual(lib.findDegradation([]), null);
});

test('EXPECT_BLOCKED_CATEGORIES: category decides blocked vs allowed, typos rejected', () => {
  const noFs = { existsSync: () => false };
  const base = { BLOCKED_URLS: 'malware=a.example,malware=a2.example,social=b.example,news=c.example', RANDOM_SEED: '1' };
  const exp = cfg => Object.fromEntries(cfg.blocked.map(e => [e.host, e.expected]));
  assert.deepStrictEqual(Object.values(exp(lib.loadConfig(base, noFs))), ['blocked', 'blocked', 'blocked', 'blocked']); // unset = old behavior
  const some = exp(lib.loadConfig({ ...base, EXPECT_BLOCKED_CATEGORIES: 'malware' }, noFs));
  assert.strictEqual(some['a.example'], 'blocked');
  assert.strictEqual(some['b.example'], 'allowed');
  assert.strictEqual(some['c.example'], 'allowed');
  assert.ok(Object.values(exp(lib.loadConfig({ ...base, EXPECT_BLOCKED_CATEGORIES: 'none' }, noFs))).every(v => v === 'allowed'));
  assert.ok(Object.values(exp(lib.loadConfig({ ...base, EXPECT_BLOCKED_CATEGORIES: 'ALL' }, noFs))).every(v => v === 'blocked'));
  assert.throws(() => lib.loadConfig({ ...base, EXPECT_BLOCKED_CATEGORIES: 'malwre' }, noFs), /malwre/);
  // SAMPLE_BLOCKED=1 keeps every category in the cycle
  const s = lib.loadConfig({ ...base, SAMPLE_BLOCKED: '1' }, noFs);
  assert.deepStrictEqual(new Set(s.blocked.map(e => e.category)), new Set(['malware', 'social', 'news']));
});

test('classifyBlocked with expected=allowed: normal answer passes, any block or error fails', () => {
  const opts = { blockPageIps: ['10.9.9.9'] };
  assert.strictEqual(lib.classifyBlocked({ addresses: ['1.2.3.4'] }, opts, 'allowed').result, 'allowed_ok');
  assert.strictEqual(lib.classifyBlocked({ errorCode: 'ENOTFOUND' }, opts, 'allowed').result, 'over_blocked');
  assert.strictEqual(lib.classifyBlocked({ addresses: ['10.9.9.9'] }, opts, 'allowed').result, 'over_blocked');
  assert.strictEqual(lib.classifyBlocked({ errorCode: 'ETIMEOUT' }, opts, 'allowed').result, 'over_blocked');
  assert.strictEqual(lib.classifyBlocked({ addresses: ['1.2.3.4'] }, opts).result, 'block_failed'); // default unchanged
});

test('summarizeBlocked counts both directions as policy misses', () => {
  const r = lib.summarizeBlocked([
    { host: 'a', category: 'malware', expected: 'blocked', result: 'blocked_ok' },
    { host: 'b', category: 'social', expected: 'allowed', result: 'allowed_ok' },
    { host: 'c', category: 'social', expected: 'allowed', result: 'over_blocked' },
    { host: 'd', category: 'malware', expected: 'blocked', result: 'block_failed' },
  ]);
  assert.strictEqual(r.blockFailed, 2);
  assert.strictEqual(r.overBlocked, 1);
  assert.strictEqual(r.perCategory.social.expected, 'allowed');
  assert.deepStrictEqual(r.failedDomains.sort(), ['c', 'd']);
});

test('summarizeBlocked lists each missed check with its category and detail', () => {
  const s = lib.summarizeBlocked([
    { host: 'a.test', category: 'malware', expected: 'blocked', result: 'block_failed', detail: 'real answer 1.2.3.4' },
    { host: 'b.test', category: 'control', expected: 'allowed', result: 'allowed_ok' },
  ]);
  assert.deepEqual(s.failedChecks, [
    { host: 'a.test', category: 'malware', expected: 'blocked', result: 'block_failed', detail: 'real answer 1.2.3.4' },
  ]);
});

test('maxOf handles huge arrays that Math.max(...x) cannot', () => {
  const big = new Array(500000).fill(1); big[7] = 99;
  assert.strictEqual(lib.maxOf(big), 99);
  assert.throws(() => Math.max(...new Array(5e6).fill(1)), RangeError);
});

test('DNS_LOOKUP_TIMEOUT_MS: default, override and bad input', () => {
  assert.strictEqual(lib.loadConfig({}, noFs).dnsLookupTimeoutMs, 5000);
  assert.strictEqual(lib.loadConfig({ DNS_LOOKUP_TIMEOUT_MS: '2000' }, noFs).dnsLookupTimeoutMs, 2000);
  assert.throws(() => lib.loadConfig({ DNS_LOOKUP_TIMEOUT_MS: '5' }, noFs), /DNS_LOOKUP_TIMEOUT_MS/);
});

test('classifyBlocked: empty answer is never a pass; v6 answer is ignored when only v4 is listed', () => {
  const opts = { blockPageIps: ['10.0.0.1'] };
  assert.strictEqual(lib.classifyBlocked({ addresses: [] }, opts, 'allowed').result, 'over_blocked');
  assert.strictEqual(lib.classifyBlocked({ addresses: [] }, opts, 'blocked').result, 'block_failed');
  assert.match(lib.classifyBlocked({ addresses: [] }, opts).detail, /empty answer/);
  // v4 sinkhole plus an unlisted v6 sinkhole address still counts as blocked.
  assert.strictEqual(lib.classifyBlocked({ addresses: ['10.0.0.1', '2001:db8::1'] }, opts).result, 'blocked_ok');
  // A real v4 address next to a v6 one is still a failed block.
  assert.strictEqual(lib.classifyBlocked({ addresses: ['1.2.3.4', '2001:db8::1'] }, opts).result, 'block_failed');
  // Only v6 returned and no v6 listed: cannot be called a sinkhole.
  assert.strictEqual(lib.classifyBlocked({ addresses: ['2001:db8::1'] }, opts).result, 'block_failed');
});
