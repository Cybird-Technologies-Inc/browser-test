'use strict';
// Pure logic for run.js: argument parsing, timing helpers, aggregation and the HTML report.
// No I/O here, so node:test can cover it without a browser or a network.
const net = require('node:net');
const lib = require('./lib');

// "90s", "10m", "2h" or plain milliseconds are NOT accepted: a unit is always required.
function parseDuration(raw, name) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(String(raw).trim());
  if (!m) throw new Error(`${name}="${raw}" is not a duration. Use a number and a unit, for example 90s, 10m or 2h.`);
  const ms = Math.round(parseFloat(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]]);
  if (ms <= 0) throw new Error(`${name} must be greater than zero.`);
  return ms;
}

// "HH:MM" in the host's local time -> the next time that clock reading occurs (today, else tomorrow).
function nextOccurrence(hhmm, now = new Date()) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm).trim());
  if (!m) throw new Error(`--start-at="${hhmm}" is not a time. Use HH:MM (24 hour, this machine's local time).`);
  const t = new Date(now);
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

// A resolver is "ip" or "ip:port" (port 53 when omitted).
function parseHostPort(raw, flag, errors) {
  const m = /^([0-9.]+)(?::(\d{1,5}))?$/.exec(String(raw));
  const port = m && m[2] !== undefined ? Number(m[2]) : 53;
  if (!m || !net.isIPv4(m[1]) || port < 1 || port > 65535) {
    errors.push(`${flag} "${raw}" is not an IPv4 address (optionally with :port, for example 203.0.113.10 or 127.0.0.1:5353).`);
    return null;
  }
  return { ip: m[1], port };
}

// Lowest allowed time between cycle starts: a guard so a typo cannot hammer a live ISP resolver.
const MIN_INTERVAL_MS = 10000;

const FLAGS = {
  '--label': 'label', '--duration': 'duration', '--rounds': 'rounds', '--gap': 'gap', '--interval': 'interval',
  '--start-at': 'startAt', '--out': 'out', '--dns-domains': 'dnsDomains', '--blocked-urls': 'blockedUrls',
  '--expect-blocked': 'expectBlocked', '--block-page-ips': 'blockPageIps', '--sample-dns': 'sampleDns',
  '--sample-blocked': 'sampleBlocked', '--compare': 'compare', '--compare-label': 'compareLabel', '--dns-repeats': 'dnsRepeats', '--cycle-timeout': 'cycleTimeout',
};

// argv: process.argv.slice(2). Returns a validated options object; throws one Error listing every problem.
function parseArgs(argv) {
  const errors = [];
  const o = { ip: null, label: null, duration: '10m', rounds: '1', gap: '0s', interval: '60s', cycleTimeout: '5m' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a.startsWith('--')) {
      const key = FLAGS[a];
      if (!key) { errors.push(`Unknown option ${a}. See --help.`); continue; }
      if (i + 1 >= argv.length) { errors.push(`${a} needs a value.`); continue; }
      o[key] = argv[++i];
    } else if (o.ip === null) {
      o.ip = a;
    } else {
      errors.push(`Unexpected argument "${a}". Only one resolver IP is accepted.`);
    }
  }
  if (o.help) return o;
  o.target = o.ip;
  if (!o.ip) errors.push('Give the resolver IPv4 address, for example: node run.js <ip> --duration 10m --rounds 2');
  else { const hp = parseHostPort(o.ip, 'The resolver', errors); if (hp) { o.ip = hp.ip; o.port = hp.port; } }

  const dur = (key, flag) => { try { return parseDuration(o[key], flag); } catch (e) { errors.push(e.message); return null; } };
  o.durationMs = dur('duration', '--duration');
  o.intervalMs = dur('interval', '--interval');
  if (o.intervalMs !== null && o.intervalMs < MIN_INTERVAL_MS) errors.push(`--interval="${o.interval}" is below the 10s minimum. Cycles closer together than that put needless load on a live resolver.`);
  o.cycleTimeoutMs = dur('cycleTimeout', '--cycle-timeout');
  // A gap of 0 is meaningful, so it is parsed on its own.
  o.gapMs = /^0+(s|m|h)?$/.test(String(o.gap)) ? 0 : dur('gap', '--gap');
  o.roundsN = Number(o.rounds);
  if (!Number.isInteger(o.roundsN) || o.roundsN < 1 || o.roundsN > 100) errors.push(`--rounds="${o.rounds}" must be a whole number from 1 to 100.`);
  if (o.startAt !== undefined) { try { nextOccurrence(o.startAt); } catch (e) { errors.push(e.message); } }
  if (o.blockPageIps) {
    for (const a of o.blockPageIps.split(',').map(s => s.trim()).filter(Boolean)) {
      if (!net.isIP(a)) errors.push(`--block-page-ips: "${a}" is not an IP address.`);
    }
  }
  if (o.compare !== undefined) {
    const hp = parseHostPort(o.compare, '--compare', errors);
    if (hp) {
      o.compareTarget = o.compare;
      if (hp.ip === o.ip && hp.port === o.port) errors.push('--compare must be a different resolver from the one under test.');
      o.compare = hp.ip; o.comparePort = hp.port;
    }
  } else if (o.compareLabel !== undefined) errors.push('--compare-label needs --compare.');
  if (o.expectBlocked && !o.blockedUrls) errors.push('--expect-blocked needs --blocked-urls (the pool the categories come from).');
  if (errors.length) { const e = new Error(`Invalid options:\n  - ${errors.join('\n  - ')}`); e.optionErrors = errors; throw e; }
  return o;
}

// Which child-process environment one cycle gets. Only what the options say is set: no ISP name, no default pools.
// `who` = { ip, label, reference: bool, seed }. The reference resolver gets the same names (same seed) but no
// category check: it does not carry the resolver-under-test's blocking policy.
function cycleEnv(o, outDir, baseEnv = process.env, who = {}) {
  const env = {
    ...baseEnv,
    RESOLVER_DNS_IP: who.ip || o.ip,
    RESOLVER_DNS_PORT: String(who.port || o.port || 53),
    RESOLVER_LABEL: who.label || o.label || o.ip,
    PAGE_LOADS: 'false',
    OUT_DIR: outDir,
  };
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') env[k] = String(v); };
  set('DNS_DOMAINS', o.dnsDomains);
  set('SAMPLE_DNS', o.sampleDns);
  set('DNS_REPEATS', o.dnsRepeats);
  set('RANDOM_SEED', who.seed);
  if (!who.reference) {
    set('BLOCKED_URLS', o.blockedUrls);
    set('SAMPLE_BLOCKED', o.sampleBlocked);
    set('EXPECT_BLOCKED_CATEGORIES', o.expectBlocked);
    set('BLOCK_PAGE_IPS', o.blockPageIps);
  }
  return env;
}

// Why a cycle has no result. `stopping` = the user pressed Ctrl+C; `timedOut` = our own cycle timer fired.
function cycleFailureReason({ code, signal, timedOut, stopping, timeoutMs }) {
  if (timedOut) return `timed out after ${timeoutMs} ms (see --cycle-timeout)`;
  if (signal) return stopping ? 'stopped by user' : `killed by signal ${signal}`;
  if (code === 2) return 'invalid configuration; see run.log';
  return null;
}

// Preflight: one real lookup. Only a missing answer (timeout, refused, server failure) means "cannot test from here".
// "No such name" proves the resolver answered, so it is fine.
function classifyPreflight(error) {
  if (!error) return { ok: true };
  const code = error.code || 'UNKNOWN';
  if (['ENOTFOUND', 'ENODATA'].includes(code)) return { ok: true };
  const hints = {
    ETIMEOUT: 'no answer. The resolver may only answer approved networks, or the IP/port is wrong.',
    ECONNREFUSED: 'connection refused. Nothing is listening on that IP and port.',
    EREFUSED: 'the resolver refused the query. This network is probably not approved.',
    ESERVFAIL: 'the resolver returned a server failure for a normal name.',
  };
  return { ok: false, code, hint: hints[code] || `unexpected error ${code}.` };
}

// Merge the per-cycle DNS summaries of one round (or the whole run) into combined numbers.
// `samples` are the raw first/repeat P95 values per cycle: the report shows the spread, not just a mean.
function aggregate(cycles) {
  const ok = cycles.filter(c => c.summary && c.summary.dnsChecks);
  const pick = (kind, key) => ok.map(c => c.summary.dnsChecks[kind]?.[key]).filter(v => typeof v === 'number');
  const stat = (values) => ({
    min: values.length ? Math.min(...values) : null,
    median: lib.percentile(values, 0.5),
    max: values.length ? Math.max(...values) : null,
  });
  const sum = (key) => ok.reduce((n, c) => n + (c.summary.dnsChecks[key] || 0), 0);
  const total = sum('total');
  const failed = sum('failed');
  const blocked = ok.map(c => c.summary.blocked).filter(Boolean);
  const failedDomains = {};
  for (const c of ok) for (const d of c.summary.dnsChecks.failedDomains || []) failedDomains[d] = (failedDomains[d] || 0) + 1;
  // Names that were among a cycle's slowest first lookups: how often, typical and worst time.
  const byName = {};
  for (const c of ok) for (const x of c.summary.dnsChecks.slowest || []) (byName[x.host] ||= []).push(x.ms);
  const slowestNames = Object.entries(byName)
    .map(([host, v]) => ({ host, cycles: v.length, median: lib.percentile(v, 0.5), worst: Math.max(...v) }))
    .sort((a, b) => b.median - a.median || b.cycles - a.cycles).slice(0, 8);
  return {
    cycles: cycles.length,
    cyclesFailed: cycles.length - ok.length,
    lookups: total,
    failed,
    failureRate: total ? Math.round((failed / total) * 1e4) / 1e4 : 0,
    firstP50: stat(pick('first', 'p50')),
    firstP95: stat(pick('first', 'p95')),
    repeatP95: stat(pick('repeat', 'p95')),
    failedDomains,
    slowestNames,
    categoryChecks: blocked.some(b => b.total > 0) ? {
      total: blocked.reduce((n, b) => n + b.total, 0),
      // Timeouts and resolver errors are shown apart: they prove nothing about the policy.
      noAnswer: blocked.reduce((n, b) => n + (b.noAnswer || 0), 0),
      wrong: blocked.reduce((n, b) => n + b.blockFailed - (b.noAnswer || 0), 0),
    } : null,
  };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const ms = v => (v === null || v === undefined ? '–' : `${v}`);

// Dependency-free line chart of first-lookup P95 per cycle, one line per series.
// Gaps (failed cycles) are skipped, not drawn as zero.
function chartSvg(series) {
  const W = 720, H = 240, L = 48, R = 12, T = 12, B = 44;
  const n = Math.max(...series.map(s => s.points.length));
  const vals = series.flatMap(s => s.points.map(p => p.v)).filter(v => typeof v === 'number');
  if (!vals.length) return '<p class="muted">Nothing to chart: no successful cycle.</p>';
  const top = Math.max(...vals) * 1.1 || 1;
  const x = i => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = v => T + (H - T - B) * (1 - v / top);
  const ticks = [0, 0.5, 1].map(f => {
    const v = Math.round(top * f);
    return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
  }).join('');
  const lines = series.map((s, k) => {
    const pts = s.points.map((p, i) => (typeof p.v === 'number' ? [x(i), y(p.v), p] : null)).filter(Boolean);
    const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const dots = pts.map(([px, py, p]) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" class="s${k}"><title>${esc(s.name)}, ${esc(p.label)}: ${p.v} ms</title></circle>`).join('');
    return `<polyline points="${line}" class="line s${k}"/>${dots}`;
  }).join('');
  const legend = series.map((s, k) => `<text x="${L + k * 200}" y="${H - 6}" class="lg${k}">● ${esc(s.name)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="First-lookup P95 per cycle in milliseconds">${ticks}${lines}<text x="${L}" y="${H - 22}">cycle 1</text><text x="${W - R}" y="${H - 22}" text-anchor="end">cycle ${n}</text>${legend}</svg>`;
}

// run: { ip, label, startedAt, finishedAt, options, rounds: [{n, startedAt, finishedAt, cycles: [...]}], interrupted }
function renderHtml(run) {
  const html = renderFull(run);
  // No cycle ran: zero-filled cards and tables would only mislead, so keep the banner and the settings.
  return run.preflight && run.preflight.ok === false ? html.replace(/<!--detail-->[\s\S]*?<!--\/detail-->/, '') : html;
}

function renderFull(run) {
  // A failed preflight means no cycle ran: tell the person who ran it exactly what to fix first.
  const pf = run.preflight && run.preflight.ok === false ? run.preflight : null;
  const preflightBanner = pf ? `<div class="alert" role="alert"><h2>Action needed: the test did not start</h2>
<p>Resolver <b>${esc(pf.resolver)}</b> (${esc(pf.address)}) did not answer a test lookup.</p>
<p>Reason: ${esc(pf.hint)} <span class="muted">(${esc(pf.code)})</span></p>
<p><b>Fix before running again:</b> ask the resolver owner to approve this machine's public IP, check the IP and port, then run the same command again. No test cycles were run.</p></div>` : '';
  const slowCycles = run.intervalMs ? run.rounds.flatMap(r => r.cycles).filter(c => c.durationMs > run.intervalMs).length : 0;
  const all = run.rounds.flatMap(r => r.cycles);
  const total = aggregate(all);
  const rows = (fn, items) => items.map(fn).join('');
  const range = s => `${ms(s.min)} / ${ms(s.median)} / ${ms(s.max)}`;
  const cmp = !!run.compare;
  const refCycles = cmp ? all.map(c => ({ round: c.round, cycle: c.cycle, summary: c.ref?.summary || null })) : [];
  const refTotal = cmp ? aggregate(refCycles) : null;
  const firstP95 = c => c?.summary?.dnsChecks?.first?.p95 ?? null;
  const series = [{ name: run.label, points: all.map(c => ({ v: firstP95(c), label: `round ${c.round}, cycle ${c.cycle}` })) }];
  if (cmp) series.push({ name: `${run.compare.label} (reference)`, points: refCycles.map(c => ({ v: firstP95(c), label: `round ${c.round}, cycle ${c.cycle}` })) });
  // Difference per cycle: positive = the resolver under test is slower than the reference.
  const deltas = cmp ? all.map((c, i) => (firstP95(c) !== null && firstP95(refCycles[i]) !== null ? Math.round((firstP95(c) - firstP95(refCycles[i])) * 100) / 100 : null)).filter(v => v !== null) : [];
  const medianDelta = deltas.length ? lib.percentile(deltas, 0.5) : null;
  const slower = deltas.filter(d => d > 0).length;
  // Cycle 1 is the closest to a cold cache; later cycles ask the same names, so the resolver may already hold them.
  const medianOf = list => { const v = list.map(firstP95).filter(x => x !== null); return v.length ? lib.percentile(v, 0.5) : null; };
  const cold = { a: firstP95(all[0]), b: cmp ? firstP95(refCycles[0]) : null };
  const warm = { a: medianOf(all.slice(1)), b: cmp ? medianOf(refCycles.slice(1)) : null };
  // Say plainly what this run did not test, so nobody reads a DNS-speed report as a blocking result.
  const notChecked = total.categoryChecks ? '' : '<p class="muted"><b>Not checked in this run:</b> blocking of malware, phishing and other categories (add <code>--blocked-urls</code> and <code>--expect-blocked</code>), and page loads.</p>\n';
  const refCells = c => {
    const rd = c.ref?.summary?.dnsChecks;
    const d = firstP95(c) !== null && rd?.first?.p95 != null ? Math.round((firstP95(c) - rd.first.p95) * 100) / 100 : null;
    return `<td>${ms(rd?.first?.p95)}</td><td class="${rd?.failed ? 'bad' : ''}">${rd ? rd.failed : esc(c.ref?.error || '–')}</td><td class="${d > 0 ? 'bad' : ''}">${d === null ? '–' : (d > 0 ? '+' : '') + d}</td>`;
  };
  const failedDomains = Object.entries(total.failedDomains).sort((a, b) => b[1] - a[1]);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DNS resolver test ${esc(run.label)}</title>
<style>
:root{--bg:#fff;--fg:#1a1d21;--muted:#5b6470;--line:#d9dde3;--accent:#1f6feb;--bad:#b42318;--ok:#067647;--card:#f6f8fa;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ec;--muted:#9aa4af;--line:#2d333b;--accent:#58a6ff;--bad:#ff7b72;--ok:#56d364;--card:#1c2128;--warn:#f0a53b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.alert{border:2px solid var(--bad);border-radius:8px;padding:12px 14px;margin:12px 0;background:var(--card)}.alert h2{margin:0 0 6px;color:var(--bad)}.muted{color:var(--muted)}.bad{color:var(--bad)}.ok{color:var(--ok)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.card b{display:block;font-size:20px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:right;white-space:nowrap}
th:first-child,td:first-child,td.l,th.l{text-align:left}
td.wrap{white-space:normal;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.nm{display:block}
svg{width:100%;min-width:560px;height:auto;color:var(--muted)}svg text{fill:currentColor;font-size:11px}
.grid{stroke:var(--line)}.line{fill:none;stroke-width:2}.line.s0{stroke:var(--accent)}.line.s1{stroke:var(--warn);stroke-dasharray:5 3}circle.s0{fill:var(--accent)}circle.s1{fill:var(--warn)}svg text.lg0{fill:var(--accent)}svg text.lg1{fill:var(--warn)}
</style></head><body><main>
<h1>DNS resolver test: ${esc(run.label)}</h1>
${preflightBanner}<p class="muted">Resolver ${esc(run.ip)} · ${esc(run.startedAt)} to ${esc(run.finishedAt)} (UTC)${run.interrupted ? ' · <b class="bad">stopped early</b>' : ''}</p>

<!--detail-->${cmp ? comparisonSection(run, total, refTotal, medianDelta, slower, deltas.length, cold, warm) : ''}${notChecked}<div class="cards">
<div class="card">Cycles<b>${total.cycles}${total.cyclesFailed ? ` <span class="bad">(${total.cyclesFailed} failed)</span>` : ''}</b></div>
<div class="card">Lookups<b>${total.lookups}</b></div>
<div class="card">Failed lookups<b class="${total.failed ? 'bad' : 'ok'}">${total.failed} (${(total.failureRate * 100).toFixed(1)}%)</b></div>
<div class="card">First lookup P95, median of cycles<b>${ms(total.firstP95.median)} ms</b></div>
<div class="card">Repeat lookup P95, median of cycles<b>${ms(total.repeatP95.median)} ms</b></div>
<div class="card">Cycle 1 first P95 (closest to a cold start)<b>${ms(firstP95(all[0]))} ms${cmp ? ` <span class="muted">vs ${ms(firstP95(refCycles[0]))}</span>` : ''}</b></div>
${cmp ? `<div class="card">Reference (${esc(run.compare.label)}) first P95, median<b>${ms(refTotal.firstP95.median)} ms</b></div>
<div class="card">Difference in first P95, median (positive = slower than reference)<b class="${medianDelta > 0 ? 'bad' : 'ok'}">${medianDelta === null ? '–' : (medianDelta > 0 ? '+' : '') + medianDelta} ms</b></div>
<div class="card">Cycles slower than reference<b>${slower} of ${deltas.length}</b></div>
<div class="card">Reference failed lookups<b class="${refTotal.failed ? 'bad' : 'ok'}">${refTotal.failed} (${(refTotal.failureRate * 100).toFixed(1)}%)</b></div>` : ''}
</div>
${cmp ? `<p class="muted">Comparison: each cycle asks ${esc(run.ip)} and then ${esc(run.compare.ip)} (${esc(run.compare.label)}) for the same names. A reference answer is a cache hit or miss on that resolver's own side, so it shows what a typical public resolver does, not a fixed baseline.</p>` : ''}

${slowCycles ? `<p class="alert">${slowCycles} cycle(s) took longer than the ${Math.round(run.intervalMs / 1000)} s interval, so they ran back to back and put more load on the resolver than planned.</p>` : ''}
<h2>How to read this</h2>
<p class="muted">A <b>first</b> lookup is the first time a cycle asks for a name. It shows the resolver's own answering time, and is slow when the name is not cached. The same names are asked in every cycle, so after cycle 1 the resolver may already hold them: later first lookups can look faster than a true cold lookup, and cycle 1 is the best cold-start figure. A <b>repeat</b> lookup asks the same name again straight after, so it shows the cache. P95 means 95 out of 100 lookups were at least this fast. Ranges below are min / median / max across cycles, in milliseconds.</p>

<h2>First-lookup P95 per cycle (ms)</h2>
<div class="scroll">${chartSvg(series)}</div>

<h2>Per round</h2>
<div class="scroll"><table><thead><tr><th>Round</th><th>Cycles</th><th>Lookups</th><th>Failed</th><th>First P50 (min / med / max)</th><th>First P95 (min / med / max)</th><th>Repeat P95 (min / med / max)</th>${cmp ? '<th>Reference first P95 (min / med / max)</th>' : ''}</tr></thead><tbody>
${rows(r => { const a = aggregate(r.cycles); const ra = cmp ? aggregate(r.cycles.map(c => ({ summary: c.ref?.summary || null }))) : null; return `<tr><td>${r.n}</td><td>${a.cycles}</td><td>${a.lookups}</td><td class="${a.failed ? 'bad' : ''}">${a.failed}</td><td>${range(a.firstP50)}</td><td>${range(a.firstP95)}</td><td>${range(a.repeatP95)}</td>${cmp ? `<td>${range(ra.firstP95)}</td>` : ''}</tr>`; }, run.rounds)}
<tr><td><b>All</b></td><td>${total.cycles}</td><td>${total.lookups}</td><td class="${total.failed ? 'bad' : ''}">${total.failed}</td><td>${range(total.firstP50)}</td><td>${range(total.firstP95)}</td><td>${range(total.repeatP95)}</td>${cmp ? `<td>${range(refTotal.firstP95)}</td>` : ''}</tr>
</tbody></table></div>

<h2>Per cycle</h2>
<div class="scroll"><table><thead><tr><th>Round</th><th>Cycle</th><th>Started (UTC)</th><th>Seed</th><th>Lookups</th><th>Failed</th><th>First P50</th><th>First P95</th><th>Repeat P95</th><th>Result</th>${cmp ? '<th>Ref first P95</th><th>Ref failed</th><th>Difference</th>' : ''}</tr></thead><tbody>
${rows(c => { const d = c.summary?.dnsChecks; return `<tr><td>${c.round}</td><td>${c.cycle}</td><td class="l">${esc(c.startedAt)}</td><td>${esc(c.summary?.config?.randomSeed ?? '–')}</td><td>${d ? d.total : '–'}</td><td class="${d?.failed ? 'bad' : ''}">${d ? d.failed : '–'}</td><td>${ms(d?.first?.p50)}</td><td>${ms(d?.first?.p95)}</td><td>${ms(d?.repeat?.p95)}</td><td class="l ${d ? 'ok' : 'bad'}">${d ? 'ok' : esc(c.error || 'no result')}</td>${cmp ? refCells(c) : ''}</tr>`; }, all)}
</tbody></table></div>

${failedDomains.length ? `<h2>Names that failed</h2><div class="scroll"><table><thead><tr><th class="l">Name (error)</th><th>Cycles affected</th></tr></thead><tbody>${rows(([d, n]) => `<tr><td class="l">${esc(d)}</td><td>${n}</td></tr>`, failedDomains)}</tbody></table></div>` : '<h2>Names that failed</h2><p class="muted">None.</p>'}

${total.categoryChecks ? `<h2>Category check</h2><p>${total.categoryChecks.total} checks, <b class="${total.categoryChecks.wrong ? 'bad' : 'ok'}">${total.categoryChecks.wrong} wrong</b>${total.categoryChecks.noAnswer ? `, <b class="bad">${total.categoryChecks.noAnswer} no answer</b> (timeout or resolver error, not counted as wrong)` : ''}. Expected blocked: ${esc(run.options.expectBlocked || 'all categories')}.</p>
<div class="scroll"><table><thead><tr><th>Category</th><th>Expected</th><th>Checks</th><th>Correct</th><th>No answer</th></tr></thead><tbody>${rows(([c, v]) => `<tr><td class="l">${esc(c)}</td><td>${esc(v.expected)}</td><td>${v.total}</td><td class="${v.correct < v.total ? 'bad' : 'ok'}">${v.correct}</td><td class="${v.noAnswer ? 'bad' : ''}">${v.noAnswer}</td></tr>`, Object.entries(categoryTotals(all)))}</tbody></table></div>` : ''}

<!--/detail--><h2>Settings used</h2>
<div class="scroll"><table><tbody>
${rows(([k, v]) => `<tr><td class="l">${esc(k)}</td><td class="l">${esc(v)}</td></tr>`, Object.entries(run.options))}
</tbody></table></div>
<p class="muted">Lookups ask ${esc(run.ip)} directly, so the test machine's own resolver and cache are not involved. The resolver only answers networks it has approved, so a run from an unapproved network shows every lookup as failed. No page loads were run.${cmp ? ' The reference resolver is not checked for blocked categories.' : ''}</p>
</main></body></html>
`;
}

// A gap this small is noise from one window, so the sentence calls it the same.
const SAME_WITHIN_MS = 20;

// Side-by-side summary of the resolver under test and the reference. Facts only: no verdict word, because
// one window from one network is not enough to call a resolver good or bad.
function slowTable(title, x) {
  if (!x.slowestNames.length) return '';
  return `<h3>Slowest names on ${esc(title)}</h3>
<div class="scroll"><table><thead><tr><th class="l">Name</th><th>Cycles in its 5 slowest</th><th>Median first lookup (ms)</th><th>Worst (ms)</th></tr></thead><tbody>${x.slowestNames.map(n => `<tr><td class="l">${esc(n.host)}</td><td>${n.cycles}</td><td>${n.median}</td><td>${n.worst}</td></tr>`).join('')}</tbody></table></div>`;
}

function comparisonSection(run, a, b, medianDelta, slower, compared, cold, warm) {
  const range = x => `${ms(x.min)} / ${ms(x.median)} / ${ms(x.max)}`;
  const fmt = v => (v === null || v === undefined ? '–' : `${v}`);
  const pct = x => `${(x.failureRate * 100).toFixed(2)}%`;
  const names = x => { const e = Object.entries(x.failedDomains); return e.length ? e.map(([d, n]) => `<span class="nm">${esc(d)} (${n})</span>`).join('') : 'none'; };
  const row = (label, va, vb, cls = '') => `<tr><td class="l">${label}</td><td${cls}>${va}</td><td${cls}>${vb}</td></tr>`;
  let sentence = 'There were no cycles with a reading from both resolvers, so no difference can be shown.';
  if (medianDelta !== null) {
    const same = Math.abs(medianDelta) <= SAME_WITHIN_MS;
    const dir = same ? `about the same (within ${SAME_WITHIN_MS} ms)` : medianDelta > 0 ? 'higher (slower)' : 'lower (faster)';
    sentence = `On first lookups the median P95 of ${esc(run.label)} is ${fmt(a.firstP95.median)} ms and of ${esc(run.compare.label)} is ${fmt(b.firstP95.median)} ms: ${same ? `${Math.abs(medianDelta)} ms, ${dir}` : `${Math.abs(medianDelta)} ms ${dir} for ${esc(run.label)}`}. ${esc(run.label)} was slower in ${slower} of ${compared} cycles. Failed lookups: ${a.failed} of ${a.lookups} (${pct(a)}) against ${b.failed} of ${b.lookups} (${pct(b)}).`;
  }
  return `<h2>Resolver comparison</h2>
<p>${sentence}</p>
<div class="scroll"><table><thead><tr><th class="l">Measure</th><th>${esc(run.label)}</th><th>${esc(run.compare.label)} (reference)</th></tr></thead><tbody>
${row('Cycles with a result', a.cycles - a.cyclesFailed, b.cycles - b.cyclesFailed)}
${row('Lookups', a.lookups, b.lookups)}
${row('Failed lookups', `<span class="${a.failed ? 'bad' : ''}">${a.failed} (${pct(a)})</span>`, `<span class="${b.failed ? 'bad' : ''}">${b.failed} (${pct(b)})</span>`)}
${row('First lookup P95, cycle 1 (closest to a cold cache, ms)', fmt(cold.a), fmt(cold.b))}
${row('First lookup P95, later cycles, median (cache may be warm, ms)', fmt(warm.a), fmt(warm.b))}
${row('First lookup P50 (min / med / max, ms)', range(a.firstP50), range(b.firstP50))}
${row('First lookup P95 (min / med / max, ms)', range(a.firstP95), range(b.firstP95))}
${row('Repeat lookup P95 (min / med / max, ms)', range(a.repeatP95), range(b.repeatP95))}
${row('Names that failed (cycles affected)', names(a), names(b), ' class="wrap"')}
</tbody></table></div>
${slowTable(run.label, a)}${slowTable(`${run.compare.label} (reference)`, b)}
<p class="muted">Based on this window from this network only. Repeat the run at another time before drawing a conclusion.</p>`;
}

function categoryTotals(cycles) {
  const out = {};
  for (const c of cycles) {
    for (const [cat, v] of Object.entries(c.summary?.blocked?.perCategory || {})) {
      const o = (out[cat] ||= { expected: v.expected, total: 0, correct: 0, noAnswer: 0 });
      o.total += v.total;
      o.noAnswer += v.noAnswer || 0;
      o.correct += v.expected === 'blocked' ? v.blockedOk : v.allowedOk;
    }
  }
  return out;
}

module.exports = { MIN_INTERVAL_MS, parseHostPort, cycleFailureReason, classifyPreflight, parseDuration, nextOccurrence, parseArgs, cycleEnv, aggregate, renderHtml, categoryTotals };
