'use strict';
// Pure helpers (no browser, no file or network access of their own) so that
// node:test can cover them without launching Chromium.

const DEFAULT_URLS = [
  'https://www.google.com',
  'https://www.microsoft.com',
  'https://www.amazon.in',
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

function parseStatusList(raw, errors) {
  if (!raw) return [];
  return raw.split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 400 || n > 599) errors.push(`IGNORE_HTTP_STATUS has "${x}". Use HTTP error codes 400-599.`);
    return n;
  });
}

// Plain domains, comma list or file (one per line, # comments).
function parseDomainList(raw, errors, fsLike) {
  const items = (fsLike.existsSync(raw)
    ? fsLike.readFileSync(raw, 'utf8').split('\n').map(l => l.replace(/#.*$/, '').trim())
    : raw.split(',').map(x => x.trim())).filter(Boolean);
  for (const d of items) {
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(d) || d.length > 253) errors.push(`DNS_DOMAINS has an invalid domain "${d}".`);
  }
  return items.map(d => d.toLowerCase());
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
    // Optional summary.json of the previous run, for the trend. The runner downloads it.
    previousSummary: env.PREVIOUS_SUMMARY || null,
    resolverLabel: env.RESOLVER_LABEL || 'unlabeled',
    // HTTP statuses that are NOT counted as failures, e.g. 403 when a site blocks datacenter
    // clients. Empty by default: 4xx and 5xx fail, as before.
    ignoreHttpStatus: parseStatusList(env.IGNORE_HTTP_STATUS, errors),
    // DNS-only lookups of plain domains, timed through the same OS resolver the browser uses.
    dnsDomains: env.DNS_DOMAINS ? parseDomainList(env.DNS_DOMAINS, errors, fsLike) : [],
    dnsRepeats: num('DNS_REPEATS', 3, { min: 1, max: 100, integer: true }),
    maxDnsCheckFailRate: num('MAX_DNS_CHECK_FAIL_RATE', null, { min: 0, max: 1 }),
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
function checkThresholds(global, { maxP95DnsMs = null, maxFailRate = null, maxBlockFailed = null, maxDnsCheckFailRate = null } = {}, blocked = null, dnsChecks = null) {
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
  if (maxDnsCheckFailRate !== null && dnsChecks && dnsChecks.failureRate > maxDnsCheckFailRate) {
    violations.push(
      `MAX_DNS_CHECK_FAIL_RATE exceeded: DNS-only failure rate ${dnsChecks.failureRate} (${dnsChecks.failed}/${dnsChecks.total}) > limit ${maxDnsCheckFailRate}`
    );
  }
  return violations;
}

// Compares this run with the previous run of the same resolver. Report only: no
// threshold, so a trend never changes the exit code. Returns null when there is
// nothing usable to compare with (first run, other resolver, damaged file).
function compareRuns(prev, cur) {
  const usable = x => x && typeof x === 'object' && x.global && x.global.dns && x.perUrl;
  if (!usable(prev) || !usable(cur) || prev.resolver !== cur.resolver) return null;
  const pair = (a, b) => ({ previous: a, current: b, delta: a === null || b === null ? null : round(b - a) });
  const failedUrls = r => new Set(Object.entries(r.perUrl).filter(([, v]) => v.failed > 0).map(([u]) => u));
  const before = failedUrls(prev);
  const after = failedUrls(cur);
  const newlyFailed = [...after].filter(u => !before.has(u));
  const recovered = [...before].filter(u => !after.has(u));
  const failureRate = pair(prev.global.failureRate, cur.global.failureRate);
  const p95DnsMs = pair(prev.global.dns.p95, cur.global.dns.p95);
  const notes = [];
  if (failureRate.delta) notes.push(`failure rate ${failureRate.delta > 0 ? 'up' : 'down'} ${prev.global.failureRate} -> ${cur.global.failureRate}`);
  if (p95DnsMs.delta) {
    const pct = prev.global.dns.p95 ? ` (${Math.round((p95DnsMs.delta / prev.global.dns.p95) * 100)}%)` : '';
    notes.push(`P95 DNS ${p95DnsMs.delta > 0 ? 'up' : 'down'} ${prev.global.dns.p95} -> ${cur.global.dns.p95} ms${pct}`);
  }
  if (newlyFailed.length) notes.push(`newly failing: ${newlyFailed.join(', ')}`);
  if (recovered.length) notes.push(`recovered: ${recovered.join(', ')}`);
  return { previousStartedAt: prev.startedAt || null, failureRate, p95DnsMs, newlyFailed, recovered, notes };
}

// Same convention as common uptime monitors: 4xx and 5xx are failures.
function isHttpFailure(status, ignore = []) {
  return typeof status === 'number' && status >= 400 && !ignore.includes(status);
}

// Why a page failed, in terms an operator can act on. null = not failed.
// 'dns' and 'timeout' point at the resolver or network; 'http_*' says the site
// answered, so the resolver did its job.
function classifyFailure({ failed, loadError, httpStatus }) {
  if (!failed) return null;
  const e = String(loadError || '');
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND/i.test(e)) return 'dns';
  if (/Timeout|timed out|ERR_TIMED_OUT/i.test(e)) return 'timeout';
  if (/ERR_CERT|ERR_SSL|SSL_|ERR_BAD_SSL/i.test(e)) return 'tls';
  if (/ERR_CONNECTION|ERR_ADDRESS|ERR_INTERNET|ERR_NETWORK|ERR_PROXY|ERR_TUNNEL/i.test(e)) return 'connection';
  if (typeof httpStatus === 'number' && httpStatus >= 500) return 'http_5xx';
  if (typeof httpStatus === 'number' && httpStatus >= 400) return 'http_4xx';
  return e ? 'other' : 'no_response';
}

const ADVICE = {
  dns: 'Name lookups failed: check the resolver and that this host\'s IP is approved on it.',
  timeout: 'Pages timed out: the resolver or the path is slow or dropping packets; compare with the DNS-only checks.',
  tls: 'TLS errors: usually the site or a middlebox, not DNS. Check the site from another network.',
  connection: 'Connections failed after DNS worked: network path or the site, not the resolver name lookup.',
  http_4xx: 'The site answered with a client error (for example a 403 bot block). DNS worked. If this is a site policy, drop the URL or set IGNORE_HTTP_STATUS.',
  http_5xx: 'The site answered with a server error. DNS worked; usually the site, not the resolver.',
  other: 'Unclassified load error: see loadError in page-summary.csv.',
  no_response: 'No main response: see loadError in page-summary.csv.',
};

// pages: [{url, failed, reason, httpStatus, loadError}]
function summarizeFailures(pages) {
  const failedPages = pages.filter(p => p.failed);
  const byReason = {};
  for (const p of failedPages) byReason[p.reason] = (byReason[p.reason] || 0) + 1;
  return {
    byReason,
    failedUrls: failedPages.map(p => ({ url: p.url, reason: p.reason, httpStatus: p.httpStatus ?? null })),
    advice: Object.keys(byReason).map(r => `${r} (${byReason[r]}): ${ADVICE[r] || ADVICE.other}`),
  };
}

// results: [{host, ok, ms, errorCode}] from DNS-only lookups.
function summarizeDnsChecks(results) {
  const ok = results.filter(r => r.ok);
  const ms = ok.map(r => r.ms);
  return {
    total: results.length,
    failed: results.length - ok.length,
    failureRate: rate(results.length - ok.length, results.length),
    p50: percentile(ms, 0.5),
    p95: percentile(ms, 0.95),
    max: ms.length ? round(Math.max(...ms)) : null,
    failedDomains: [...new Set(results.filter(r => !r.ok).map(r => `${r.host} (${r.errorCode})`))],
  };
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
  compareRuns, classifyFailure, summarizeFailures, summarizeDnsChecks, parseDomainList,
};
