#!/usr/bin/env node
'use strict';
// Point-and-shoot DNS resolver test: give it a resolver IP, it runs timed rounds and writes one HTML report.
// Nothing is uploaded or emailed; everything stays in the output folder.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const dns = require('node:dns');
const lib = require('./lib');
const report = require('./report');

const HELP = `Usage: node run.js <resolver-ip[:port]> [options]

Runs DNS checks against the resolver for the given time, as many rounds as you ask,
then writes report.html (open it in a browser). Run it from a network the resolver approves.
Before any cycle it sends one test lookup; if the resolver does not answer, it stops with a
red ACTION NEEDED message (exit code 3) so the problem is fixed before the test.

  --duration 10m        length of each round (units s, m, h)               default 10m
  --rounds 2            number of rounds                                    default 1
  --gap 5m              pause between rounds                                default 0s
  --interval 60s        time between cycle starts inside a round (min 10s)  default 60s
  --start-at 14:30      wait until this local time (HH:MM) before starting  default: start now
  --compare IP[:port]   also test this public reference resolver with the same names each cycle,
                        and show both side by side (for example a public resolver you trust)
  --compare-label NAME  name for the reference in the report                default: its IP
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
process.on('SIGINT', () => {
  // A second Ctrl+C exits at once; finished cycles are already in the report (it is rewritten after each cycle).
  if (stopping) process.exit(130);
  stopping = true;
  if (child) child.kill('SIGTERM');
  console.log('\nStopping; the report will cover what finished. Press Ctrl+C again to exit now.');
});

const RED = process.stderr.isTTY ? '\x1b[1;37;41m' : '';
const RESET = process.stderr.isTTY ? '\x1b[0m' : '';
// Loud, boxed message for problems the person running the test must fix BEFORE the test can start.
function banner(lines) {
  const w = Math.max(...lines.map(l => l.length)) + 4;
  const bar = '#'.repeat(w);
  console.error(`\n${RED}${bar}${RESET}`);
  for (const l of lines) console.error(`${RED}# ${l.padEnd(w - 4)} #${RESET}`);
  console.error(`${RED}${bar}${RESET}\n`);
}

// One real lookup to the resolver before any round starts, so a dead or unapproved resolver fails in seconds.
async function preflight(ip, port, name, timeoutMs) {
  const r = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  r.setServers([lib.serverAddress({ resolverIp: ip, resolverPort: port })]);
  try { await r.resolve4(name); return report.classifyPreflight(null); } catch (e) { return report.classifyPreflight(e); }
}

// One cycle = one browser-test.js run (DNS only). The child's console output goes to a log file.
function runCycle(o, dir, who) {
  fs.mkdirSync(dir, { recursive: true });
  // Never trust a summary left from an earlier run in this folder: only this cycle's child may write it.
  fs.rmSync(path.join(dir, 'summary.json'), { force: true });
  const log = fs.openSync(path.join(dir, 'run.log'), 'w');
  return new Promise(resolve => {
    let timedOut = false;
    child = spawn(process.execPath, [path.join(__dirname, 'browser-test.js')], {
      env: report.cycleEnv(o, dir, process.env, who), stdio: ['ignore', log, log],
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, o.cycleTimeoutMs);
    const finish = (error) => {
      clearTimeout(timer); fs.closeSync(log); child = null;
      let summary = null;
      try { summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); } catch { /* reported below */ }
      // Exit 1 only means a threshold was exceeded and none is set here; a missing summary is the real failure.
      resolve({ summary, error: summary ? null : (error || 'cycle produced no summary.json; see run.log in this cycle folder') });
    };
    child.on('error', e => finish(`could not start: ${e.message}`));
    child.on('exit', (code, signal) => finish(report.cycleFailureReason({ code, signal, timedOut, stopping, timeoutMs: o.cycleTimeoutMs })));
  });
}

async function main() {
  let o;
  try { o = report.parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.help) { console.log(HELP); return; }
  o.dnsDomains = o.dnsDomains || DEFAULT_DNS;
  // A value with a path separator or a .txt ending is meant as a file: say so if it is missing instead of
  // treating a typo as a domain name. Anything else is a file if it exists, else a comma list (the loader's rule).
  for (const [flag, f] of [['--dns-domains', o.dnsDomains], ['--blocked-urls', o.blockedUrls]]) {
    if (f && !fs.existsSync(f) && (/[/\\]/.test(f) || /\.txt$/i.test(f))) { console.error(`${flag}: file not found: ${f}`); process.exit(2); }
  }

  const outDir = path.resolve(o.out || path.join('out', `run-${slug(new Date())}`));
  // A folder that already holds a run would mix two runs' files.
  if (fs.existsSync(path.join(outDir, 'results.json'))) { console.error(`--out ${outDir} already holds a run. Choose a new folder or remove that one.`); process.exit(2); }
  fs.mkdirSync(outDir, { recursive: true });

  // Validate the lists once with the real loader, so a bad list stops here with its own message, not in every cycle.
  let cfg;
  try {
    cfg = lib.loadConfig({ ...report.cycleEnv(o, outDir, {}, { seed: 1 }) }, fs);
    if (o.compare) lib.loadConfig({ ...report.cycleEnv(o, outDir, {}, { ip: o.compare, port: o.comparePort, reference: true, seed: 1 }) }, fs);
  } catch (e) { console.error(e.message); process.exit(2); }
  if (!cfg.dnsDomains.length) { console.error('The DNS name list is empty. Give --dns-domains with at least one name.'); process.exit(2); }

  const run = {
    ip: o.target, label: o.label || o.target, intervalMs: o.intervalMs, preflight: null,
    compare: o.compare ? { ip: o.compareTarget, label: o.compareLabel || o.compareTarget } : null, startedAt: stamp(), finishedAt: null, interrupted: false, rounds: [],
    // Shown in the report; only what the user set or the tool defaulted, never secrets.
    options: Object.fromEntries(Object.entries({
      duration: o.duration, rounds: o.rounds, gap: o.gap, interval: o.interval, cycleTimeout: o.cycleTimeout,
      dnsDomains: o.dnsDomains, sampleDns: o.sampleDns, dnsRepeats: o.dnsRepeats || '3 (tool default)',
      compare: o.compareTarget, compareLabel: o.compareLabel, blockedUrls: o.blockedUrls, expectBlocked: o.expectBlocked, blockPageIps: o.blockPageIps, sampleBlocked: o.sampleBlocked,
    }).filter(([, v]) => v !== undefined)),
  };
  const write = () => {
    run.finishedAt = stamp(); run.interrupted = stopping;
    fs.writeFileSync(path.join(outDir, 'report.html'), report.renderHtml(run));
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(run, null, 2));
  };

  // Preflight BEFORE any waiting: the person running this must fix an unapproved or dead resolver first.
  const probe = cfg.dnsDomains[0];
  const checks = [{ name: run.label, ip: o.ip, port: o.port }, ...(o.compare ? [{ name: run.compare.label, ip: o.compare, port: o.comparePort }] : [])];
  for (const c of checks) {
    const res = await preflight(c.ip, c.port, probe, cfg.dnsLookupTimeoutMs);
    if (!res.ok) {
      run.preflight = { ok: false, resolver: c.name, address: `${c.ip}:${c.port}`, code: res.code, hint: res.hint };
      write();
      banner([
        'ACTION NEEDED BEFORE THE TEST CAN START',
        `Resolver ${c.name} (${c.ip}:${c.port}) did not answer a test lookup.`,
        `Reason: ${res.hint} (${res.code})`,
        'Fix: ask the resolver owner to approve THIS machine\'s public IP, check the IP/port,',
        'then run the same command again. No test cycles were run.',
      ]);
      console.error(`Details: ${path.join(outDir, 'report.html')}`);
      process.exit(3);
    }
  }
  console.log('Preflight OK: every resolver answered a test lookup.');

  if (o.startAt) {
    const at = report.nextOccurrence(o.startAt);
    console.log(`Waiting until ${at.toString()} (local) = ${at.toISOString()} (UTC) to start.`);
    while (!stopping && Date.now() < at.getTime()) await sleep(Math.min(1000, at.getTime() - Date.now()));
  }
  run.startedAt = stamp();

  console.log(`Testing resolver ${o.target}: ${o.roundsN} round(s) of ${o.duration}, a cycle every ${o.interval}. Output: ${outDir}`);
  for (let n = 1; n <= o.roundsN && !stopping; n++) {
    const round = { n, startedAt: stamp(), finishedAt: null, cycles: [] };
    run.rounds.push(round);
    const roundStart = Date.now();
    for (let c = 1; !stopping; c++) {
      const cycleStart = Date.now();
      const dir = path.join(outDir, `round-${n}`, `cycle-${String(c).padStart(2, '0')}`);
      console.log(`${stamp()} round ${n}/${o.roundsN} cycle ${c}`);
      const startedAt = stamp();
      // One seed per cycle, shared with the reference, so both resolvers are asked the same names.
      const seed = crypto.randomInt(0, 2 ** 32);
      const r = await runCycle(o, dir, { seed });
      const cycleRec = { round: n, cycle: c, startedAt, seed, ...r };
      if (o.compare && !stopping) cycleRec.ref = await runCycle(o, path.join(dir, 'reference'), { ip: o.compare, port: o.comparePort, label: run.compare.label, reference: true, seed });
      cycleRec.durationMs = Date.now() - cycleStart;
      round.cycles.push(cycleRec);
      const d = r.summary?.dnsChecks;
      console.log(d ? `  ${run.label}: ${d.failed}/${d.total} failed, first P95 ${d.first.p95 ?? '-'} ms, repeat P95 ${d.repeat?.p95 ?? '-'} ms` : `  ${run.label}: FAILED: ${r.error}`);
      if (cycleRec.ref) {
        const rd = cycleRec.ref.summary?.dnsChecks;
        console.log(rd ? `  ${run.compare.label}: ${rd.failed}/${rd.total} failed, first P95 ${rd.first.p95 ?? '-'} ms, repeat P95 ${rd.repeat?.p95 ?? '-'} ms` : `  ${run.compare.label}: FAILED: ${cycleRec.ref.error}`);
      }
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
