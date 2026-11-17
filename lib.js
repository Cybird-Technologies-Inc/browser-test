'use strict';
// Pure helpers (no browser, no file or network access of their own) so that
// node:test can cover them without launching Chromium.

const DEFAULT_URLS = [
  'https://www.google.com',
  'https://www.microsoft.com',
  'https://www.amazon.in',
  'https://www.linkedin.com',
  'https://www.youtube.com',
];

function round(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(value * 100) / 100;
}

function phase(start, end) {
  if (start === undefined || end === undefined || start === null || end === null || start < 0 || end < 0) {
    return null;
  }
  return round(end - start);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round(sorted[lower]);
  return round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

function average(values) {
  if (!values.length) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length);
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return url;
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function dnsBuckets(values) {
  return {
    lt2: values.filter(v => v < 2).length,
    ms2to10: values.filter(v => v >= 2 && v < 10).length,
    ms10to50: values.filter(v => v >= 10 && v < 50).length,
    ms50to100: values.filter(v => v >= 50 && v < 100).length,
    ms100to200: values.filter(v => v >= 100 && v < 200).length,
    ms200to500: values.filter(v => v >= 200 && v < 500).length,
    gt500: values.filter(v => v >= 500).length,
  };
}

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------

function parseBool(raw, fallback, name, errors) {
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  errors.push(`${name}="${raw}" is not a boolean. Use true or false.`);
  return fallback;
}

// Numbers fail fast: a typo such as REPEATS=ten must not silently run the default.
function parseNumber(raw, fallback, name, errors, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    errors.push(
      `${name}="${raw}" is invalid. Use ${integer ? 'an integer' : 'a number'}` +
      `${Number.isFinite(min) ? ` >= ${min}` : ''}${Number.isFinite(max) ? ` and <= ${max}` : ''}.`
    );
    return fallback;
  }
  return n;
}

// A value is a file path if that file exists, otherwise a comma list.
// Files allow one URL per line and # comments, which suits a long list kept in git.
function parseUrlList(raw, name, errors, fsLike) {
  let items;
  if (fsLike.existsSync(raw)) {
    items = fsLike.readFileSync(raw, 'utf8').split('\n')
      .map(l => l.replace(/#.*$/, '').trim());
  } else {
    items = raw.split(',').map(s => s.trim());
  }
  items = items.filter(Boolean);
  for (const u of items) {
    let ok = false;
    try {
      ok = ['http:', 'https:'].includes(new URL(u).protocol);
    } catch (_) { /* reported below */ }
    if (!ok) errors.push(`${name} has an invalid URL "${u}". Use full http(s) URLs.`);
  }
  return items;
}

// Entries are `category=name` or, in files, `category name` (the format of the shield's
// client-test domains.txt). Name = domain or URL; no category means "uncategorized".
// Same sources as URLS: a comma list, or a file with one entry per line and # comments.
function parseBlockedList(raw, errors, fsLike) {
  const lines = fsLike.existsSync(raw)
    ? fsLike.readFileSync(raw, 'utf8').split('\n').map(l => l.replace(/#.*$/, '').trim())
    : raw.split(',').map(x => x.trim());

  const entries = [];
  for (const item of lines.filter(Boolean)) {
    const m = item.match(/^([A-Za-z0-9_-]+)(?:=|\s+)(.+)$/);
    const category = (m ? m[1] : 'uncategorized').toLowerCase();
    const name = m ? m[2] : item;
    let host = null;
    try {
      host = /^[a-z][a-z0-9+.-]*:\/\//i.test(name) ? new URL(name).hostname : new URL(`https://${name}`).hostname;
    } catch (_) { /* reported below */ }
    if (!host || !/^[a-z0-9.-]+$/i.test(host)) {
      errors.push(`BLOCKED_URLS has an invalid domain "${name}". Use category=domain.`);
    } else {
      entries.push({ category, host: host.toLowerCase() });
    }
  }
  return entries;
}

function loadConfig(env, fsLike) {
  const errors = [];
  const num = (key, fallback, opts) => parseNumber(env[key], fallback, key, errors, opts);

  const urls = env.URLS ? parseUrlList(env.URLS, 'URLS', errors, fsLike) : [...DEFAULT_URLS];
  const blocked = env.BLOCKED_URLS ? parseBlockedList(env.BLOCKED_URLS, errors, fsLike) : [];

  const config = {
    urls,
    blocked,
    blockPageIps: (env.BLOCK_PAGE_IPS || '').split(',').map(s => s.trim()).filter(Boolean),
    repeats: num('REPEATS', 1, { min: 1, integer: true }),
    concurrency: num('CONCURRENCY', 1, { min: 1, max: 50, integer: true }),
    settleTimeMs: num('SETTLE_TIME_MS', 3000, { min: 0, integer: true }),
    scrollPage: parseBool(env.SCROLL_PAGE, true, 'SCROLL_PAGE', errors),
    cacheLikeThresholdMs: num('CACHE_LIKE_THRESHOLD_MS', 2, { min: 0 }),
    navTimeoutMs: num('NAV_TIMEOUT_MS', 45000, { min: 1000, integer: true }),
    outDir: env.OUT_DIR || '.',
    resolverLabel: env.RESOLVER_LABEL || 'unlabeled',
    // null means "no limit": thresholds are opt-in so existing runs keep exiting 0.
    maxP95DnsMs: num('MAX_P95_DNS_MS', null, { min: 0 }),
    maxFailRate: num('MAX_FAIL_RATE', null, { min: 0, max: 1 }),
    // Recommended 0 whenever BLOCKED_URLS is set: one answered blocked domain is an alert.
    maxBlockFailed: num('MAX_BLOCK_FAILED', null, { min: 0, integer: true }),
  };

  if (errors.length) {
    const err = new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
    err.configErrors = errors;
    throw err;
  }
  return config;
}

// ------------------------------------------------------------------
// Blocked-domain check (DNS only)
// ------------------------------------------------------------------

// Blocked names are looked up, never opened: feed domains are malware and
// phishing, and a browser must not visit them. A block shows up either as
// NXDOMAIN or as an answer that is only the resolver's sinkhole address.
// Any other answer is a real one, so the block failed. A resolver error
// proves nothing, so it fails the check too (and the detail says why).
function classifyBlocked({ addresses = [], errorCode = null }, { blockPageIps = [] } = {}) {
  if (errorCode === 'ENOTFOUND') return { result: 'blocked_ok', detail: 'NXDOMAIN' };
  if (errorCode) return { result: 'block_failed', detail: `resolver error ${errorCode}` };
  if (addresses.length && addresses.every(a => blockPageIps.includes(a))) {
    return { result: 'blocked_ok', detail: 'sinkhole' };
  }
  return { result: 'block_failed', detail: `real answer ${addresses.join(' ') || 'none'}` };
}

// ------------------------------------------------------------------
// Summary and thresholds
// ------------------------------------------------------------------

// Four decimals: 1/3 must not be rounded to 0.33 before a threshold compares it.
function rate(part, total) {
  return total ? Math.round((part / total) * 1e4) / 1e4 : 0;
}

function dnsStats(values) {
  return {
    count: values.length,
    avg: average(values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? round(Math.max(...values)) : null,
  };
}

function upstreamValues(requests, cacheLikeMs) {
  return requests.map(r => r.dnsMs).filter(v => v !== null && v !== undefined && v > cacheLikeMs);
}

// pages: [{url, failed}] and requests: [{page, dnsMs}], both for normal (non-blocked) URLs only.
function summarizeResults({ pages, requests, cacheLikeMs }) {
  const group = (ps, rs) => ({
    attempts: ps.length,
    failed: ps.filter(p => p.failed).length,
    failureRate: rate(ps.filter(p => p.failed).length, ps.length),
    dns: dnsStats(upstreamValues(rs, cacheLikeMs)),
  });

  const perUrl = {};
  for (const url of new Set(pages.map(p => p.url))) {
    perUrl[url] = group(pages.filter(p => p.url === url), requests.filter(r => r.page === url));
  }
  return { global: group(pages, requests), perUrl };
}

// results: [{host, category, result}]. Per category so a feed that stops
// blocking (for example phishing) is visible even when malware still works.
function summarizeBlocked(results) {
  const tally = rs => {
    const blockedOk = rs.filter(r => r.result === 'blocked_ok').length;
    return { total: rs.length, blockedOk, blockFailed: rs.length - blockedOk };
  };
  const perCategory = {};
  for (const c of new Set(results.map(r => r.category))) {
    perCategory[c] = tally(results.filter(r => r.category === c));
  }
  return {
    ...tally(results),
    perCategory,
    failedDomains: [...new Set(results.filter(r => r.result !== 'blocked_ok').map(r => r.host))],
  };
}

// Returns one message per exceeded limit; empty means pass.
function checkThresholds(global, { maxP95DnsMs = null, maxFailRate = null, maxBlockFailed = null } = {}, blocked = null) {
  const violations = [];
  if (maxP95DnsMs !== null && global.dns.p95 !== null && global.dns.p95 > maxP95DnsMs) {
    violations.push(`MAX_P95_DNS_MS exceeded: P95 DNS ${global.dns.p95} ms > limit ${maxP95DnsMs} ms`);
  }
  if (maxFailRate !== null && global.failureRate > maxFailRate) {
    violations.push(
      `MAX_FAIL_RATE exceeded: failure rate ${global.failureRate} (${global.failed}/${global.attempts}) > limit ${maxFailRate}`
    );
  }
  if (maxBlockFailed !== null && blocked && blocked.blockFailed > maxBlockFailed) {
    violations.push(
      `MAX_BLOCK_FAILED exceeded: ${blocked.blockFailed} of ${blocked.total} blocked domains were answered > limit ${maxBlockFailed}`
    );
  }
  return violations;
}

// Same convention as common uptime monitors: 4xx and 5xx are failures.
function isHttpFailure(status) {
  return typeof status === 'number' && status >= 400;
}

// Hard cap for a hung browser that ignores Playwright's own timeouts.
// Returns the promise's result, or rejects after ms; the timer is always cleared.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  DEFAULT_URLS, parseBlockedList, round, phase, percentile, average, hostnameFromUrl, csvEscape, dnsBuckets,
  loadConfig, parseUrlList, classifyBlocked, rate, dnsStats, summarizeResults, summarizeBlocked, checkThresholds, isHttpFailure, withTimeout,
};
