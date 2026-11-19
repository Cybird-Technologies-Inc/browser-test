#!/usr/bin/env node
// DNS load ramp: sends A queries straight to one resolver in rising steps of parallel
// lookups, and reports latency and errors per step. On demand only (npm run dns-load),
// never part of the 15-minute timer. See README "DNS load ramp".
//
// Safety: needs CONFIRM_LOAD=yes, never exceeds 50 parallel lookups or 20 queries/s,
// stops at the first step whose error rate passes STOP_ERROR_RATE, and uses only
// real, existing names (no random subdomains), so other servers see ordinary traffic.
'use strict';

const fs = require('fs');
const path = require('path');
const { Resolver } = require('node:dns').promises;
const lib = require('./lib');

let config;
try {
  config = lib.loadLoadConfig(process.env, fs);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const rng = lib.makeRng(config.randomSeed);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Direct to the resolver under test (not the OS resolver): the point is that resolver's
// capacity, whatever the host is configured with. tries:1 so a timeout is one failure.
const resolver = new Resolver({ timeout: config.queryTimeoutMs, tries: 1 });
resolver.setServers([config.resolverIp]);

async function runStep(concurrency) {
  const latencies = [];
  const errors = {};
  let noRecord = 0;
  let paced = false;
  const gap = 1000 / config.maxQps;           // global pacing: the queries/s ceiling
  let nextSlot = Date.now();
  const start = Date.now();
  const end = start + config.stepSeconds * 1000;

  async function worker() {
    while (Date.now() < end) {
      // Claim the next send slot (single-threaded JS, so this is race-free).
      const slot = Math.max(nextSlot, Date.now());
      nextSlot = slot + gap;
      if (slot >= end) return;
      if (slot > Date.now()) { paced = true; await sleep(slot - Date.now()); }
      const domain = config.domains[Math.floor(rng() * config.domains.length)];
      const t0 = performance.now();
      try {
        await resolver.resolve4(domain);
        latencies.push(performance.now() - t0);
      } catch (error) {
        const code = error.code || 'UNKNOWN';
        if (code === 'ENODATA' || code === 'ENOTFOUND') {
          // The resolver answered "no such record": real work for it, not a failure of the resolver.
          latencies.push(performance.now() - t0);
          noRecord++;
        } else {
          errors[code] = (errors[code] || 0) + 1;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return lib.summarizeLoadStep({ concurrency, durationMs: Date.now() - start, latencies, errors, noRecord, paced });
}

(async () => {
  const startedAt = new Date().toISOString();
  console.log(
    `DNS load ramp on ${config.resolverLabel}: steps ${config.steps.join(', ')} parallel, ` +
    `${config.stepSeconds} s each, max ${config.maxQps} queries/s, stop at ${config.stopErrorRate * 100}% errors, ` +
    `${config.domains.length} names, seed ${config.randomSeed}.`
  );

  const steps = [];
  let stopped = null;
  let interrupted = false;
  process.once('SIGINT', () => { interrupted = true; });

  for (const concurrency of config.steps) {
    if (interrupted) break;
    const st = await runStep(concurrency);
    steps.push(st);
    console.log(
      `  ${String(concurrency).padStart(3)} parallel: ${st.queries} queries, ${st.achievedQps}/s${st.paced ? ' (held at the queries/s ceiling)' : ''}, ` +
      `P50 ${st.latency.p50} ms, P95 ${st.latency.p95} ms, P99 ${st.latency.p99} ms, ` +
      `errors ${st.failed} (${st.errorRate * 100}%)${st.noRecord ? `, ${st.noRecord} no-record answers` : ''}${st.failed ? ' ' + JSON.stringify(st.errorsByCode) : ''}`
    );
    if (st.errorRate > config.stopErrorRate) {
      stopped = `Stopped at ${concurrency} parallel: error rate ${st.errorRate} is above ${config.stopErrorRate}. Resolver may be saturated or rate-limiting this IP.`;
      console.error(stopped);
      break;
    }
    await sleep(3000); // short rest so one step's backlog does not blur the next
  }

  const degradation = lib.findDegradation(steps, { factor: config.degradeFactor, stopErrorRate: config.stopErrorRate });
  const inconclusive = lib.rampInconclusive(steps);
  const summary = {
    resolver: config.resolverLabel,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      steps: config.steps, stepSeconds: config.stepSeconds, maxQps: config.maxQps,
      stopErrorRate: config.stopErrorRate, queryTimeoutMs: config.queryTimeoutMs,
      degradeFactor: config.degradeFactor, randomSeed: config.randomSeed, domains: config.domains.length,
    },
    steps,
    degradation,
    inconclusive,
    stoppedEarly: stopped,
    interrupted,
  };
  fs.mkdirSync(config.outDir, { recursive: true });
  fs.writeFileSync(path.join(config.outDir, 'load-test-summary.json'), JSON.stringify(summary, null, 2));

  if (inconclusive) {
    console.warn(
      `WARN: every step was held at the ${config.maxQps} queries/s ceiling, so the steps sent the same load ` +
      'and differ only in parallelism. This run does not show capacity. Lower the parallel steps or raise MAX_QPS (hard limit 20) only with the resolver owner\'s agreement.'
    );
  }
  console.log(degradation
    ? `Latency or errors got worse at ${degradation.concurrency} parallel: ${degradation.reason}.`
    : `No degradation found within the tested steps${inconclusive ? ' (inconclusive: see the warning above)' : ''}.`);
  console.log(`Wrote ${path.join(config.outDir, 'load-test-summary.json')}`);
  process.exit(stopped ? 1 : 0);
})();
