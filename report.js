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

const FLAGS = {
  '--label': 'label', '--duration': 'duration', '--rounds': 'rounds', '--gap': 'gap', '--interval': 'interval',
  '--start-at': 'startAt', '--out': 'out', '--dns-domains': 'dnsDomains', '--blocked-urls': 'blockedUrls',
  '--expect-blocked': 'expectBlocked', '--block-page-ips': 'blockPageIps', '--sample-dns': 'sampleDns',
  '--sample-blocked': 'sampleBlocked', '--dns-repeats': 'dnsRepeats', '--cycle-timeout': 'cycleTimeout',
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
  if (!o.ip) errors.push('Give the resolver IPv4 address, for example: node run.js <ip> --duration 10m --rounds 2');
  else if (!net.isIPv4(o.ip)) errors.push(`"${o.ip}" is not an IPv4 address.`);

  const dur = (key, flag) => { try { return parseDuration(o[key], flag); } catch (e) { errors.push(e.message); return null; } };
  o.durationMs = dur('duration', '--duration');
  o.intervalMs = dur('interval', '--interval');
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
  if (o.expectBlocked && !o.blockedUrls) errors.push('--expect-blocked needs --blocked-urls (the pool the categories come from).');
  if (errors.length) { const e = new Error(`Invalid options:\n  - ${errors.join('\n  - ')}`); e.optionErrors = errors; throw e; }
  return o;
}

// Which child-process environment one cycle gets. Only what the options say is set: no ISP name, no default pools.
function cycleEnv(o, outDir, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    RESOLVER_DNS_IP: o.ip,
    RESOLVER_LABEL: o.label || o.ip,
    PAGE_LOADS: 'false',
    OUT_DIR: outDir,
  };
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') env[k] = String(v); };
  set('DNS_DOMAINS', o.dnsDomains);
  set('SAMPLE_DNS', o.sampleDns);
  set('DNS_REPEATS', o.dnsRepeats);
  set('BLOCKED_URLS', o.blockedUrls);
  set('SAMPLE_BLOCKED', o.sampleBlocked);
  set('EXPECT_BLOCKED_CATEGORIES', o.expectBlocked);
  set('BLOCK_PAGE_IPS', o.blockPageIps);
  return env;
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
    categoryChecks: blocked.length ? {
      total: blocked.reduce((n, b) => n + b.total, 0),
      wrong: blocked.reduce((n, b) => n + b.blockFailed, 0),
    } : null,
  };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const ms = v => (v === null || v === undefined ? '–' : `${v}`);

// Dependency-free line chart of first-lookup P95 per cycle. Gaps (failed cycles) are skipped, not drawn as zero.
function chartSvg(points) {
  const W = 720, H = 220, L = 48, R = 12, T = 12, B = 28;
  const vals = points.map(p => p.v).filter(v => typeof v === 'number');
  if (!vals.length) return '<p class="muted">Nothing to chart: no successful cycle.</p>';
  const top = Math.max(...vals) * 1.1 || 1;
  const x = i => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = v => T + (H - T - B) * (1 - v / top);
  const pts = points.map((p, i) => (typeof p.v === 'number' ? [x(i), y(p.v), p] : null)).filter(Boolean);
  const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const ticks = [0, 0.5, 1].map(f => {
    const v = Math.round(top * f);
    return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
  }).join('');
  const dots = pts.map(([px, py, p]) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3"><title>${esc(p.label)}: ${p.v} ms</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="First-lookup P95 per cycle in milliseconds">${ticks}<polyline points="${line}" class="line"/>${dots}<text x="${L}" y="${H - 6}">cycle 1</text><text x="${W - R}" y="${H - 6}" text-anchor="end">cycle ${points.length}</text></svg>`;
}

// run: { ip, label, startedAt, finishedAt, options, rounds: [{n, startedAt, finishedAt, cycles: [...]}], interrupted }
function renderHtml(run) {
  const all = run.rounds.flatMap(r => r.cycles);
  const total = aggregate(all);
  const rows = (fn, items) => items.map(fn).join('');
  const range = s => `${ms(s.min)} / ${ms(s.median)} / ${ms(s.max)}`;
  const points = all.map(c => ({ v: c.summary?.dnsChecks?.first?.p95 ?? null, label: `round ${c.round}, cycle ${c.cycle}` }));
  const failedDomains = Object.entries(total.failedDomains).sort((a, b) => b[1] - a[1]);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DNS resolver test ${esc(run.label)}</title>
<style>
:root{--bg:#fff;--fg:#1a1d21;--muted:#5b6470;--line:#d9dde3;--accent:#1f6feb;--bad:#b42318;--ok:#067647;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ec;--muted:#9aa4af;--line:#2d333b;--accent:#58a6ff;--bad:#ff7b72;--ok:#56d364;--card:#1c2128}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.muted{color:var(--muted)}.bad{color:var(--bad)}.ok{color:var(--ok)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.card b{display:block;font-size:20px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:right;white-space:nowrap}
th:first-child,td:first-child,td.l,th.l{text-align:left}
svg{width:100%;height:auto;color:var(--muted)}svg text{fill:currentColor;font-size:11px}
.grid{stroke:var(--line)}.line{fill:none;stroke:var(--accent);stroke-width:2}svg circle{fill:var(--accent)}
</style></head><body><main>
<h1>DNS resolver test: ${esc(run.label)}</h1>
<p class="muted">Resolver ${esc(run.ip)} · ${esc(run.startedAt)} to ${esc(run.finishedAt)}${run.interrupted ? ' · <b class="bad">stopped early</b>' : ''}</p>

<div class="cards">
<div class="card">Cycles<b>${total.cycles}${total.cyclesFailed ? ` <span class="bad">(${total.cyclesFailed} failed)</span>` : ''}</b></div>
<div class="card">Lookups<b>${total.lookups}</b></div>
<div class="card">Failed lookups<b class="${total.failed ? 'bad' : 'ok'}">${total.failed} (${(total.failureRate * 100).toFixed(1)}%)</b></div>
<div class="card">First lookup P95, median of cycles<b>${ms(total.firstP95.median)} ms</b></div>
<div class="card">Repeat lookup P95, median of cycles<b>${ms(total.repeatP95.median)} ms</b></div>
</div>

<h2>How to read this</h2>
<p class="muted">A <b>first</b> lookup is the first time a cycle asks for a name. It shows the resolver's own answering time, and is slow when the name is not cached. A <b>repeat</b> lookup asks the same name again straight after, so it shows the cache. P95 means 95 out of 100 lookups were at least this fast. Ranges below are min / median / max across cycles, in milliseconds.</p>

<h2>First-lookup P95 per cycle (ms)</h2>
${chartSvg(points)}

<h2>Per round</h2>
<div class="scroll"><table><thead><tr><th>Round</th><th>Cycles</th><th>Lookups</th><th>Failed</th><th>First P50 (min / med / max)</th><th>First P95 (min / med / max)</th><th>Repeat P95 (min / med / max)</th></tr></thead><tbody>
${rows(r => { const a = aggregate(r.cycles); return `<tr><td>${r.n}</td><td>${a.cycles}</td><td>${a.lookups}</td><td class="${a.failed ? 'bad' : ''}">${a.failed}</td><td>${range(a.firstP50)}</td><td>${range(a.firstP95)}</td><td>${range(a.repeatP95)}</td></tr>`; }, run.rounds)}
<tr><td><b>All</b></td><td>${total.cycles}</td><td>${total.lookups}</td><td class="${total.failed ? 'bad' : ''}">${total.failed}</td><td>${range(total.firstP50)}</td><td>${range(total.firstP95)}</td><td>${range(total.repeatP95)}</td></tr>
</tbody></table></div>

<h2>Per cycle</h2>
<div class="scroll"><table><thead><tr><th>Round</th><th>Cycle</th><th>Started</th><th>Seed</th><th>Lookups</th><th>Failed</th><th>First P50</th><th>First P95</th><th>Repeat P95</th><th>Result</th></tr></thead><tbody>
${rows(c => { const d = c.summary?.dnsChecks; return `<tr><td>${c.round}</td><td>${c.cycle}</td><td class="l">${esc(c.startedAt)}</td><td>${esc(c.summary?.config?.randomSeed ?? '–')}</td><td>${d ? d.total : '–'}</td><td class="${d?.failed ? 'bad' : ''}">${d ? d.failed : '–'}</td><td>${ms(d?.first?.p50)}</td><td>${ms(d?.first?.p95)}</td><td>${ms(d?.repeat?.p95)}</td><td class="l ${d ? 'ok' : 'bad'}">${d ? 'ok' : esc(c.error || 'no result')}</td></tr>`; }, all)}
</tbody></table></div>

${failedDomains.length ? `<h2>Names that failed</h2><div class="scroll"><table><thead><tr><th class="l">Name (error)</th><th>Cycles affected</th></tr></thead><tbody>${rows(([d, n]) => `<tr><td class="l">${esc(d)}</td><td>${n}</td></tr>`, failedDomains)}</tbody></table></div>` : '<h2>Names that failed</h2><p class="muted">None.</p>'}

${total.categoryChecks ? `<h2>Category check</h2><p>${total.categoryChecks.total} checks, <b class="${total.categoryChecks.wrong ? 'bad' : 'ok'}">${total.categoryChecks.wrong} wrong</b>. Expected blocked: ${esc(run.options.expectBlocked || 'all categories')}.</p>
<div class="scroll"><table><thead><tr><th>Category</th><th>Expected</th><th>Checks</th><th>Correct</th></tr></thead><tbody>${rows(([c, v]) => `<tr><td class="l">${esc(c)}</td><td>${esc(v.expected)}</td><td>${v.total}</td><td class="${v.correct < v.total ? 'bad' : 'ok'}">${v.correct}</td></tr>`, Object.entries(categoryTotals(all)))}</tbody></table></div>` : ''}

<h2>Settings used</h2>
<div class="scroll"><table><tbody>
${rows(([k, v]) => `<tr><td class="l">${esc(k)}</td><td class="l">${esc(v)}</td></tr>`, Object.entries(run.options))}
</tbody></table></div>
<p class="muted">Lookups ask ${esc(run.ip)} directly, so the test machine's own resolver and cache are not involved. The resolver only answers networks it has approved, so a run from an unapproved network shows every lookup as failed. No page loads were run.</p>
</main></body></html>
`;
}

function categoryTotals(cycles) {
  const out = {};
  for (const c of cycles) {
    for (const [cat, v] of Object.entries(c.summary?.blocked?.perCategory || {})) {
      const o = (out[cat] ||= { expected: v.expected, total: 0, correct: 0 });
      o.total += v.total;
      o.correct += v.expected === 'blocked' ? v.blockedOk : v.allowedOk;
    }
  }
  return out;
}

module.exports = { parseDuration, nextOccurrence, parseArgs, cycleEnv, aggregate, renderHtml, categoryTotals };
