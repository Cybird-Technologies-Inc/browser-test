#!/usr/bin/env node
'use strict';
// Point-and-shoot DNS resolver test: give it a resolver IP, it runs timed rounds and writes one HTML report.
// Nothing is uploaded or emailed; everything stays in the output folder.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const report = require('./report');

const HELP = `Usage: node run.js <resolver-ip> [options]

Runs DNS checks against the resolver for the given time, as many rounds as you ask,
then writes report.html (open it in a browser). Run it from a network the resolver approves.

  --duration 10m        length of each round (units s, m, h)               default 10m
  --rounds 2            number of rounds                                    default 1
  --gap 5m              pause between rounds                                default 0s
  --interval 60s        time between cycle starts inside a round            default 60s
  --start-at 14:30      wait until this local time (HH:MM) before starting  default: start now
  --label NAME          name shown in the report                            default: the IP
  --dns-domains FILE    names to time (one per line, or a comma list)       default: profiles/pool-dns.txt
  --sample-dns N        use N random names from that list each cycle        default: all
  --dns-repeats N       lookups per name per cycle (1 first + N-1 repeats)  default 3
  --blocked-urls FILE   category list for the block check (category domain) default: no block check
  --expect-blocked LIST categories the resolver should block, e.g. malware,phishing
  --block-page-ips LIST resolver's sinkhole IPs, if it answers with one
  --sample-blocked N    names per category per cycle
  --cycle-timeout 5m    stop one cycle that hangs
  --out DIR             output folder                                       default: out/run-<timestamp>
`;

const DEFAULT_DNS = path.join(__dirname, 'profiles', 'pool-dns.txt');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const slug = d => d.toISOString().replace(/[:.]/g, '-');

let stopping = false;
let child = null;
process.on('SIGINT', () => { stopping = true; if (child) child.kill('SIGTERM'); console.log('\nStopping after the current step; the report will cover what finished.'); });

// One cycle = one browser-test.js run (DNS only). The child's console output goes to a log file.
function runCycle(o, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, 'run.log'), 'w');
  return new Promise(resolve => {
    child = spawn(process.execPath, [path.join(__dirname, 'browser-test.js')], {
      env: report.cycleEnv(o, dir), stdio: ['ignore', log, log],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), o.cycleTimeoutMs);
    const finish = (error) => {
      clearTimeout(timer); fs.closeSync(log); child = null;
      let summary = null;
      try { summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); } catch { /* reported below */ }
      // Exit 1 only means a threshold was exceeded and none is set here; a missing summary is the real failure.
      resolve({ summary, error: summary ? null : (error || 'cycle produced no summary.json; see run.log in this cycle folder') });
    };
    child.on('error', e => finish(`could not start: ${e.message}`));
    child.on('exit', (code, signal) => finish(signal ? `killed (${signal}), timeout ${o.cycleTimeoutMs} ms` : (code === 2 ? 'invalid configuration; see run.log' : null)));
  });
}

async function main() {
  let o;
  try { o = report.parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.help) { console.log(HELP); return; }
  o.dnsDomains = o.dnsDomains || DEFAULT_DNS;
  for (const f of [o.dnsDomains, o.blockedUrls].filter(Boolean)) {
    // A value that is not an existing file is a comma list; the loader validates it.
    if (!f.includes(',') && !fs.existsSync(f) && /[/\\.]/.test(f)) { console.error(`File not found: ${f}`); process.exit(2); }
  }

  const startedWall = new Date();
  const outDir = path.resolve(o.out || path.join('out', `run-${slug(startedWall)}`));
  fs.mkdirSync(outDir, { recursive: true });

  if (o.startAt) {
    const at = report.nextOccurrence(o.startAt);
    console.log(`Waiting until ${at.toString()} to start.`);
    while (!stopping && Date.now() < at.getTime()) await sleep(Math.min(1000, at.getTime() - Date.now()));
  }

  const run = {
    ip: o.ip, label: o.label || o.ip, startedAt: stamp(), finishedAt: null, interrupted: false, rounds: [],
    // Shown in the report; only what the user set or the tool defaulted, never secrets.
    options: Object.fromEntries(Object.entries({
      duration: o.duration, rounds: o.rounds, gap: o.gap, interval: o.interval, cycleTimeout: o.cycleTimeout,
      dnsDomains: o.dnsDomains, sampleDns: o.sampleDns, dnsRepeats: o.dnsRepeats || '3 (tool default)',
      blockedUrls: o.blockedUrls, expectBlocked: o.expectBlocked, blockPageIps: o.blockPageIps, sampleBlocked: o.sampleBlocked,
    }).filter(([, v]) => v !== undefined)),
  };
  const write = () => {
    run.finishedAt = stamp(); run.interrupted = stopping;
    fs.writeFileSync(path.join(outDir, 'report.html'), report.renderHtml(run));
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(run, null, 2));
  };

  console.log(`Testing resolver ${o.ip}: ${o.roundsN} round(s) of ${o.duration}, a cycle every ${o.interval}. Output: ${outDir}`);
  for (let n = 1; n <= o.roundsN && !stopping; n++) {
    const round = { n, startedAt: stamp(), finishedAt: null, cycles: [] };
    run.rounds.push(round);
    const roundStart = Date.now();
    for (let c = 1; !stopping; c++) {
      const cycleStart = Date.now();
      const dir = path.join(outDir, `round-${n}`, `cycle-${String(c).padStart(2, '0')}`);
      console.log(`${stamp()} round ${n}/${o.roundsN} cycle ${c}`);
      const startedAt = stamp();
      const r = await runCycle(o, dir);
      round.cycles.push({ round: n, cycle: c, startedAt, ...r });
      const d = r.summary?.dnsChecks;
      console.log(d ? `  ${d.failed}/${d.total} failed, first P95 ${d.first.p95 ?? '-'} ms, repeat P95 ${d.repeat?.p95 ?? '-'} ms` : `  FAILED: ${r.error}`);
      write(); // a crash or Ctrl+C never loses finished cycles
      // Next cycle only if it can still start inside this round.
      const nextStart = cycleStart + o.intervalMs;
      if (nextStart - roundStart >= o.durationMs) break;
      while (!stopping && Date.now() < nextStart) await sleep(Math.min(500, nextStart - Date.now()));
    }
    round.finishedAt = stamp();
    if (n < o.roundsN && !stopping && o.gapMs) {
      console.log(`Round ${n} done. Pausing ${o.gap}.`);
      const until = Date.now() + o.gapMs;
      while (!stopping && Date.now() < until) await sleep(Math.min(500, until - Date.now()));
    }
  }
  write();
  console.log(`\nDone${stopping ? ' (stopped early)' : ''}. Report: ${path.join(outDir, 'report.html')}`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
