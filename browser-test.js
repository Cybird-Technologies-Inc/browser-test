const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const lib = require('./lib');
const {
  round, phase, percentile, average, hostnameFromUrl, csvEscape, dnsBuckets,
} = lib;

// ========================================================
// CONFIG (environment variables; see README for the table)
// ========================================================

let CONFIG;
try {
  CONFIG = lib.loadConfig(process.env, fs);
  if (CONFIG.blocked.length && !CONFIG.blockPageIps.length) {
    console.warn(
      'WARN: BLOCKED_URLS is set but BLOCK_PAGE_IPS is not. Only NXDOMAIN counts as blocked; ' +
      'a resolver that answers blocked names with a sinkhole IP will show block FAILED. ' +
      'Set BLOCK_PAGE_IPS to that IP.'
    );
  }
} catch (error) {
  console.error(error.message);
  console.error('Fix the variables above and run again. Exit code 2 = configuration error.');
  process.exit(2);
}

const {
  repeats: REPEATS,
  settleTimeMs: SETTLE_TIME_MS,
  scrollPage: SCROLL_PAGE,
  cacheLikeThresholdMs: CACHE_LIKE_THRESHOLD_MS,
  navTimeoutMs: NAV_TIMEOUT_MS,
  resolverLabel: RESOLVER_LABEL,
} = CONFIG;

// ========================================================
// HELPERS
// ========================================================

function writeCSV(filename, rows) {
  if (!rows.length) return;

  // Failure and blocked rows carry different fields. Start from the widest
  // row so the existing column order is kept whichever row comes first, then
  // append columns only other rows have.
  const widest = rows.reduce((a, b) => (Object.keys(b).length > Object.keys(a).length ? b : a));
  const headers = [...new Set([...Object.keys(widest), ...rows.flatMap(r => Object.keys(r))])];

  const output = [
    headers.join(','),
    ...rows.map(row => headers.map(h => csvEscape(row[h])).join(',')),
  ];

  fs.writeFileSync(filename, output.join('\n'));
}

async function scrollPage(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const distance = 500;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);

        total += distance;

        const max =
          Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight
          );

        if (
          total >= max ||
          total >= 12000
        ) {
          clearInterval(timer);

          window.scrollTo(0, 0);

          resolve();
        }
      }, 100);
    });
  });
}

// ========================================================
// TEST ONE PAGE
// ========================================================

async function testPage(browser, url, runNumber) {

  const context = await browser.newContext({
    ignoreHTTPSErrors: true
  });

  const page = await context.newPage();

  const cdp =
    await context.newCDPSession(page);

  await cdp.send('Network.enable', {
    maxTotalBufferSize: 100000000
  });

  await cdp.send(
    'Network.setCacheDisabled',
    { cacheDisabled: true }
  );

  const requests = new Map();

  // ------------------------------------------------------
  // REQUEST START
  // ------------------------------------------------------

  cdp.on(
    'Network.requestWillBeSent',
    event => {

      // A requestId can be reused for redirects.
      // Store most recent URL information.
      const existing =
        requests.get(event.requestId);

      requests.set(
        event.requestId,
        {
          ...(existing || {}),

          requestId:
            event.requestId,

          url:
            event.request.url,

          hostname:
            hostnameFromUrl(
              event.request.url
            ),

          method:
            event.request.method,

          type:
            event.type,

          startTimestamp:
            event.timestamp,

          status:
            null,

          protocol:
            null,

          remoteIP:
            null,

          timing:
            null,

          finishTimestamp:
            null,

          bytes:
            0,

          failed:
            false,

          failureReason:
            null,

          connectionReused:
            false,

          fromDiskCache:
            false,

          fromServiceWorker:
            false
        }
      );
    }
  );

  // ------------------------------------------------------
  // RESPONSE
  // ------------------------------------------------------

  cdp.on(
    'Network.responseReceived',
    event => {

      const r =
        requests.get(
          event.requestId
        );

      if (!r) return;

      r.status =
        event.response.status;

      r.protocol =
        event.response.protocol;

      r.remoteIP =
        event.response.remoteIPAddress;

      r.timing =
        event.response.timing;

      r.connectionReused =
        !!event.response.connectionReused;

      r.fromDiskCache =
        !!event.response.fromDiskCache;

      r.fromServiceWorker =
        !!event.response.fromServiceWorker;
    }
  );

  // ------------------------------------------------------
  // FINISHED
  // ------------------------------------------------------

  cdp.on(
    'Network.loadingFinished',
    event => {

      const r =
        requests.get(
          event.requestId
        );

      if (!r) return;

      r.finishTimestamp =
        event.timestamp;

      r.bytes =
        event.encodedDataLength || 0;
    }
  );

  // ------------------------------------------------------
  // FAILED
  // ------------------------------------------------------

  cdp.on(
    'Network.loadingFailed',
    event => {

      const r =
        requests.get(
          event.requestId
        );

      if (!r) return;

      r.failed = true;

      r.failureReason =
        event.errorText;

      r.finishTimestamp =
        event.timestamp;
    }
  );

  console.log(
    '\n=================================================='
  );

  console.log(
    `Run ${runNumber}: ${url}`
  );

  console.log(
    '=================================================='
  );

  const testStart =
    Date.now();

  let mainResponse = null;
  let loadError = null;

  try {

    mainResponse =
      await page.goto(url, {
        waitUntil: 'load',
        timeout: NAV_TIMEOUT_MS
      });

  } catch (error) {

    loadError =
      error.message;

    console.log(
      `LOAD ERROR: ${error.message}`
    );
  }

  // Give loadEventEnd a chance to update.
  await page.waitForTimeout(250);

  if (SCROLL_PAGE) {
    try {
      await scrollPage(page);
    } catch (_) {}
  }

  await page.waitForTimeout(
    SETTLE_TIME_MS
  );

  const settledMs =
    Date.now() - testStart;

  // ======================================================
  // MAIN NAVIGATION TIMING
  // ======================================================

  const navigation =
    await page.evaluate(() => {

      const nav =
        performance
          .getEntriesByType(
            'navigation'
          )[0];

      if (!nav) return null;

      return {
        domainLookupStart:
          nav.domainLookupStart,

        domainLookupEnd:
          nav.domainLookupEnd,

        connectStart:
          nav.connectStart,

        secureConnectionStart:
          nav.secureConnectionStart,

        connectEnd:
          nav.connectEnd,

        requestStart:
          nav.requestStart,

        responseStart:
          nav.responseStart,

        responseEnd:
          nav.responseEnd,

        domContentLoadedEventEnd:
          nav.domContentLoadedEventEnd,

        loadEventEnd:
          nav.loadEventEnd
      };
    })
    .catch(() => null);

  const navMetrics = {};

  if (navigation) {

    navMetrics.dns =
      round(
        navigation.domainLookupEnd -
        navigation.domainLookupStart
      );

    navMetrics.tcp =
      round(
        navigation.connectEnd -
        navigation.connectStart
      );

    navMetrics.tls =
      navigation.secureConnectionStart > 0
        ? round(
            navigation.connectEnd -
            navigation.secureConnectionStart
          )
        : 0;

    navMetrics.ttfb =
      round(
        navigation.responseStart -
        navigation.requestStart
      );

    navMetrics.download =
      round(
        navigation.responseEnd -
        navigation.responseStart
      );

    navMetrics.domContentLoaded =
      round(
        navigation
          .domContentLoadedEventEnd
      );

    navMetrics.load =
      navigation.loadEventEnd > 0
        ? round(
            navigation.loadEventEnd
          )
        : null;
  }

  // ======================================================
  // PROCESS ALL REQUESTS
  // ======================================================

  const detailedRequests = [];

  for (
    const r of requests.values()
  ) {

    const t = r.timing;

    let dnsMs = null;
    let tcpMs = null;
    let tlsMs = null;
    let ttfbMs = null;
    let downloadMs = null;

    if (t) {

      dnsMs =
        phase(
          t.dnsStart,
          t.dnsEnd
        );

      if (
        t.connectStart >= 0
      ) {

        if (
          t.sslStart >= 0
        ) {

          tcpMs =
            phase(
              t.connectStart,
              t.sslStart
            );

        } else {

          tcpMs =
            phase(
              t.connectStart,
              t.connectEnd
            );
        }
      }

      tlsMs =
        phase(
          t.sslStart,
          t.sslEnd
        );

      ttfbMs =
        phase(
          t.sendEnd,
          t.receiveHeadersStart
        );

      if (
        r.finishTimestamp &&
        t.requestTime &&
        t.receiveHeadersEnd >= 0
      ) {

        const headersEnd =
          t.requestTime * 1000 +
          t.receiveHeadersEnd;

        const finished =
          r.finishTimestamp * 1000;

        downloadMs =
          round(
            finished -
            headersEnd
          );

        if (
          downloadMs < 0
        ) {
          downloadMs = null;
        }
      }
    }

    let totalMs = null;

    if (
      r.startTimestamp &&
      r.finishTimestamp
    ) {

      totalMs =
        round(
          (
            r.finishTimestamp -
            r.startTimestamp
          ) * 1000
        );
    }

    detailedRequests.push({
      run:
        runNumber,

      page:
        url,

      hostname:
        r.hostname,

      type:
        r.type,

      requestUrl:
        r.url,

      status:
        r.status,

      protocol:
        r.protocol,

      remoteIP:
        r.remoteIP,

      dnsMs,

      dnsClassification:
        dnsMs === null
          ? 'No DNS phase'
          : dnsMs <=
            CACHE_LIKE_THRESHOLD_MS
          ? 'Cache/local-like'
          : 'Upstream-like',

      tcpMs,

      tlsMs,

      ttfbMs,

      downloadMs,

      totalMs,

      bytes:
        r.bytes,

      connectionReused:
        r.connectionReused,

      diskCache:
        r.fromDiskCache,

      serviceWorker:
        r.fromServiceWorker,

      failed:
        r.failed,

      failureReason:
        r.failureReason
    });
  }

  // ======================================================
  // DNS ANALYSIS
  // ======================================================

  const allDnsValues =
    detailedRequests
      .map(r => r.dnsMs)
      .filter(
        value =>
          value !== null &&
          value >= 0
      );

  const actualDnsValues =
    allDnsValues.filter(
      value =>
        value >
        CACHE_LIKE_THRESHOLD_MS
    );

  const cacheLikeValues =
    allDnsValues.filter(
      value =>
        value <=
        CACHE_LIKE_THRESHOLD_MS
    );

  const buckets =
    dnsBuckets(
      allDnsValues
    );

  const failedRequests =
    detailedRequests.filter(
      r => r.failed
    );

  const totalBytes =
    detailedRequests.reduce(
      (sum, r) =>
        sum +
        (r.bytes || 0),
      0
    );

  // Slowest DNS requests
  const slowest =
    detailedRequests
      .filter(
        r =>
          r.dnsMs !== null &&
          r.dnsMs >
            CACHE_LIKE_THRESHOLD_MS
      )
      .sort(
        (a, b) =>
          b.dnsMs -
          a.dnsMs
      )
      .slice(0, 10);

  const summary = {

    run:
      runNumber,

    url,

    httpStatus:
      mainResponse
        ? mainResponse.status()
        : null,

    mainDnsMs:
      navMetrics.dns ??
      null,

    mainTcpMs:
      navMetrics.tcp ??
      null,

    mainTlsMs:
      navMetrics.tls ??
      null,

    mainTtfbMs:
      navMetrics.ttfb ??
      null,

    mainDownloadMs:
      navMetrics.download ??
      null,

    domContentLoadedMs:
      navMetrics
        .domContentLoaded ??
      null,

    loadEventMs:
      navMetrics.load ??
      null,

    settledMs,

    totalRequests:
      detailedRequests.length,

    failedRequests:
      failedRequests.length,

    dnsMeasurements:
      allDnsValues.length,

    cacheLikeDns:
      cacheLikeValues.length,

    upstreamLikeDns:
      actualDnsValues.length,

    avgDnsMs:
      average(
        actualDnsValues
      ),

    p50DnsMs:
      percentile(
        actualDnsValues,
        0.50
      ),

    p90DnsMs:
      percentile(
        actualDnsValues,
        0.90
      ),

    p95DnsMs:
      percentile(
        actualDnsValues,
        0.95
      ),

    p99DnsMs:
      percentile(
        actualDnsValues,
        0.99
      ),

    maxDnsMs:
      actualDnsValues.length
        ? round(
            Math.max(
              ...actualDnsValues
            )
          )
        : null,

    dns_lt_2ms:
      buckets.lt2,

    dns_2_10ms:
      buckets.ms2to10,

    dns_10_50ms:
      buckets.ms10to50,

    dns_50_100ms:
      buckets.ms50to100,

    dns_100_200ms:
      buckets.ms100to200,

    dns_200_500ms:
      buckets.ms200to500,

    dns_gt_500ms:
      buckets.gt500,

    downloadedMB:
      round(
        totalBytes /
        1024 /
        1024
      ),

    loadError
  };

  // A page with no main response, or an HTTP 4xx/5xx, is a failed test
  // even if Playwright did not throw.
  summary.failed = !mainResponse || !!loadError || lib.isHttpFailure(mainResponse.status(), CONFIG.ignoreHttpStatus);
  summary.failureReason = lib.classifyFailure({
    failed: summary.failed, loadError, httpStatus: mainResponse ? mainResponse.status() : null,
  });

  // ======================================================
  // DISPLAY RESULTS
  // ======================================================

  console.log(`
MAIN DOCUMENT
-------------
DNS             : ${summary.mainDnsMs ?? '-'} ms
TCP             : ${summary.mainTcpMs ?? '-'} ms
TLS             : ${summary.mainTlsMs ?? '-'} ms
TTFB            : ${summary.mainTtfbMs ?? '-'} ms
Download        : ${summary.mainDownloadMs ?? '-'} ms

PAGE
----
DOM Loaded      : ${summary.domContentLoadedMs ?? '-'} ms
Load Event      : ${summary.loadEventMs ?? '-'} ms
Settled         : ${summary.settledMs} ms
Requests        : ${summary.totalRequests}
Failed          : ${summary.failedRequests}
Downloaded      : ${summary.downloadedMB} MB

DNS
---
Measurements    : ${summary.dnsMeasurements}
Cache/local <=2 : ${summary.cacheLikeDns}
Upstream-like   : ${summary.upstreamLikeDns}

Average         : ${summary.avgDnsMs ?? '-'} ms
P50             : ${summary.p50DnsMs ?? '-'} ms
P90             : ${summary.p90DnsMs ?? '-'} ms
P95             : ${summary.p95DnsMs ?? '-'} ms
P99             : ${summary.p99DnsMs ?? '-'} ms
Maximum         : ${summary.maxDnsMs ?? '-'} ms

DNS DISTRIBUTION
----------------
< 2 ms          : ${summary.dns_lt_2ms}
2 - 10 ms       : ${summary.dns_2_10ms}
10 - 50 ms      : ${summary.dns_10_50ms}
50 - 100 ms     : ${summary.dns_50_100ms}
100 - 200 ms    : ${summary.dns_100_200ms}
200 - 500 ms    : ${summary.dns_200_500ms}
>= 500 ms       : ${summary.dns_gt_500ms}
`);

  console.log(
    'SLOWEST DNS LOOKUPS'
  );

  console.log(
    '-------------------'
  );

  if (!slowest.length) {

    console.log(
      'No upstream-like DNS lookups detected.'
    );

  } else {

    console.table(
      slowest.map(r => ({
        Host:
          r.hostname,

        DNS_ms:
          r.dnsMs,

        Type:
          r.type,

        Status:
          r.status
      }))
    );
  }

  // Block-check inputs: only the main document matters, and only
  // when the load did not fail outright.
  let remoteIp = null;
  let bodyText = null;

  if (mainResponse) {
    try {
      const addr = await mainResponse.serverAddr();
      remoteIp = addr ? addr.ipAddress : null;
      bodyText = (await page.content()).slice(0, 100000);
    } catch (_) {}
  }

  return {
    summary,
    remoteIp,
    bodyText,
    requests:
      detailedRequests
  };
}

// ========================================================
// GLOBAL SUMMARY
// ========================================================

function printGlobalDNS(
  requests
) {

  const values =
    requests
      .map(r => r.dnsMs)
      .filter(
        v =>
          v !== null &&
          v >
            CACHE_LIKE_THRESHOLD_MS
      );

  if (!values.length) {

    console.log(
      '\nNo upstream-like DNS measurements.'
    );

    return;
  }

  const buckets =
    dnsBuckets(values);

  console.log(`
==================================================
GLOBAL DNS SUMMARY
==================================================

Upstream-like DNS lookups : ${values.length}

Average : ${average(values)} ms
P50     : ${percentile(values, 0.50)} ms
P90     : ${percentile(values, 0.90)} ms
P95     : ${percentile(values, 0.95)} ms
P99     : ${percentile(values, 0.99)} ms
Maximum : ${round(Math.max(...values))} ms

Distribution
------------
2 - 10 ms      : ${buckets.ms2to10}
10 - 50 ms     : ${buckets.ms10to50}
50 - 100 ms    : ${buckets.ms50to100}
100 - 200 ms   : ${buckets.ms100to200}
200 - 500 ms   : ${buckets.ms200to500}
>= 500 ms      : ${buckets.gt500}
`);
}

// ========================================================
// MAIN
// ========================================================

// One fresh browser per page keeps DNS/connection reuse out of the numbers.
// The hard cap covers a hung browser that ignores Playwright's own timeouts,
// so one bad site cannot stall the whole run.
async function testPageIsolated(url, runNumber) {
  const hardCapMs = NAV_TIMEOUT_MS + SETTLE_TIME_MS + 30000;
  const browser = await chromium.launch({ headless: true });

  try {
    const work = testPage(browser, url, runNumber);
    // Closing the browser on timeout makes `work` reject; swallow it.
    work.catch(() => {});

    return await lib.withTimeout(work, hardCapMs, `timed out after ${hardCapMs} ms`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// Blocked names are only looked up, never opened: they are malware/phishing
// domains. getaddrinfo is what Chromium uses too, so the answer matches.
async function runBlockedCheck({ host, category, run }) {
  const timestamp = new Date().toISOString();
  const started = performance.now();
  let answer;

  try {
    const records = await dns.promises.lookup(host, { all: true });
    answer = { addresses: records.map(r => r.address) };
  } catch (error) {
    answer = { errorCode: error.code || 'UNKNOWN' };
  }

  const dnsMs = round(performance.now() - started);
  const { result, detail } = lib.classifyBlocked(answer, CONFIG);

  console.log(`BLOCKED CHECK [${category}] ${host}: ${result} (${detail}, ${dnsMs} ms)`);

  return {
    blocked: true,
    host,
    category,
    requests: [],
    summary: {
      run,
      url: host,
      mainDnsMs: dnsMs,
      failed: false, // a correct block is not a page failure
      resolver: RESOLVER_LABEL,
      timestamp,
      kind: 'blocked',
      category,
      blockResult: result,
      blockDetail: detail,
    },
  };
}

// DNS-only timing of plain domains through the OS resolver (getaddrinfo, same as Chromium).
// Run after the page tests so the two never compete for the resolver.
async function runDnsChecks() {
  const jobs = [];
  for (let i = 0; i < CONFIG.dnsRepeats; i++) for (const host of CONFIG.dnsDomains) jobs.push(host);
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONFIG.concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      const started = performance.now();
      try {
        await dns.promises.lookup(jobs[i], { all: true });
        out[i] = { host: jobs[i], ok: true, ms: round(performance.now() - started) };
      } catch (error) {
        out[i] = { host: jobs[i], ok: false, ms: null, errorCode: error.code || 'UNKNOWN' };
      }
    }
  }));
  return lib.summarizeDnsChecks(out);
}

async function runTask({ url, run, blocked, host, category }) {
  if (blocked) return runBlockedCheck({ host, category, run });

  const timestamp = new Date().toISOString();
  const stamp = row => ({ ...row, resolver: RESOLVER_LABEL, timestamp, kind: 'normal' });

  try {
    const result = await testPageIsolated(url, run);
    return { blocked, summary: stamp(result.summary), requests: result.requests.map(stamp) };
  } catch (error) {
    console.error(
      `ERROR testing ${url} (run ${run}): ${error.message}. ` +
      'Counted as failed; check network access and the resolver, then run again.'
    );
    // Failure stub keeps the failed attempt visible in the CSV and counted.
    return {
      blocked,
      summary: stamp({
        run, url, failed: true, loadError: error.message,
        failureReason: lib.classifyFailure({ failed: true, loadError: error.message }),
      }),
      requests: [],
    };
  }
}

(async () => {

  const startedAt = new Date().toISOString();

  // Blocked URLs run once per repeat like the others, but are scored
  // separately so a correct block never counts as a failure.
  const tasks = [];
  for (let run = 1; run <= REPEATS; run++) {
    for (const url of CONFIG.urls) tasks.push({ url, run, blocked: false });
    for (const b of CONFIG.blocked) tasks.push({ ...b, run, blocked: true });
  }

  // Simple worker pool: no dependency, results kept in task order.
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONFIG.concurrency, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await runTask(tasks[i]);
      }
    })
  );

  const normal = results.filter(r => !r.blocked);
  const allSummaries = results.map(r => r.summary);
  const allRequests = results.flatMap(r => r.requests);
  const normalRequests = normal.flatMap(r => r.requests);

  // ------------------------------------------------------
  // WRITE CSV FILES
  // ------------------------------------------------------

  fs.mkdirSync(CONFIG.outDir, { recursive: true });

  writeCSV(path.join(CONFIG.outDir, 'page-summary.csv'), allSummaries);
  writeCSV(path.join(CONFIG.outDir, 'request-details.csv'), allRequests);

  // ------------------------------------------------------
  // FINAL TABLE
  // ------------------------------------------------------

  console.log(
    '\n=================================================='
  );

  console.log(
    'PAGE SUMMARY'
  );

  console.log(
    '=================================================='
  );

  console.table(
    normal.map(r => r.summary).map(
      r => ({
        URL:
          r.url,

        DNS:
          r.mainDnsMs,

        TTFB:
          r.mainTtfbMs,

        Load:
          r.loadEventMs,

        Requests:
          r.totalRequests,

        Failed:
          r.failedRequests,

        DNSLookups:
          r.upstreamLikeDns,

        AvgDNS:
          r.avgDnsMs,

        P50:
          r.p50DnsMs,

        P95:
          r.p95DnsMs,

        P99:
          r.p99DnsMs,

        MaxDNS:
          r.maxDnsMs
      })
    )
  );

  // ------------------------------------------------------
  // GLOBAL DNS RESULTS
  // ------------------------------------------------------

  printGlobalDNS(
    normalRequests
  );

  // ------------------------------------------------------
  // GLOBAL SLOW DNS HOSTS
  // ------------------------------------------------------

  console.log(
    '\nTOP 20 SLOWEST DNS LOOKUPS'
  );

  console.log(
    '=========================='
  );

  const globalSlow =
    normalRequests
      .filter(
        r =>
          r.dnsMs !== null &&
          r.dnsMs >
            CACHE_LIKE_THRESHOLD_MS
      )
      .sort(
        (a, b) =>
          b.dnsMs -
          a.dnsMs
      )
      .slice(0, 20);

  console.table(
    globalSlow.map(
      r => ({
        Page:
          hostnameFromUrl(
            r.page
          ),

        Host:
          r.hostname,

        DNS_ms:
          r.dnsMs,

        Type:
          r.type
      })
    )
  );

  // ------------------------------------------------------
  // SUMMARY JSON AND THRESHOLDS
  // ------------------------------------------------------

  const stats = lib.summarizeResults({
    pages: normal.map(r => ({ url: r.summary.url, failed: r.summary.failed })),
    requests: normalRequests.map(r => ({ page: r.page, dnsMs: r.dnsMs })),
    cacheLikeMs: CACHE_LIKE_THRESHOLD_MS,
  });

  const failures = lib.summarizeFailures(
    normal.map(r => ({
      url: r.summary.url, failed: r.summary.failed, reason: r.summary.failureReason,
      httpStatus: r.summary.httpStatus, loadError: r.summary.loadError,
    }))
  );

  const dnsChecks = await runDnsChecks();

  const blocked = lib.summarizeBlocked(
    results.filter(r => r.blocked).map(r => ({ host: r.host, category: r.category, result: r.summary.blockResult }))
  );

  const violations = lib.checkThresholds(stats.global, CONFIG, blocked, CONFIG.dnsDomains.length ? dnsChecks : null);

  const summaryJson = {
    resolver: RESOLVER_LABEL,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      repeats: REPEATS,
      concurrency: CONFIG.concurrency,
      settleTimeMs: SETTLE_TIME_MS,
      cacheLikeThresholdMs: CACHE_LIKE_THRESHOLD_MS,
      maxP95DnsMs: CONFIG.maxP95DnsMs,
      maxFailRate: CONFIG.maxFailRate,
      maxBlockFailed: CONFIG.maxBlockFailed,
      maxDnsCheckFailRate: CONFIG.maxDnsCheckFailRate,
      ignoreHttpStatus: CONFIG.ignoreHttpStatus,
    },
    global: stats.global,
    perUrl: stats.perUrl,
    blocked,
    failures,
    dnsChecks: CONFIG.dnsDomains.length ? dnsChecks : null,
    thresholdViolations: violations,
    trend: null,
    exitCode: violations.length ? 1 : 0,
  };

  // A missing or damaged previous file only means "no trend"; it must never fail the run.
  if (CONFIG.previousSummary) {
    try {
      summaryJson.trend = lib.compareRuns(JSON.parse(fs.readFileSync(CONFIG.previousSummary, 'utf8')), summaryJson);
    } catch (error) {
      console.warn(`WARN: previous summary ignored (${error.message}); no trend this run.`);
    }
  }

  fs.writeFileSync(
    path.join(CONFIG.outDir, 'summary.json'),
    JSON.stringify(summaryJson, null, 2)
  );

  console.log(`
Files created in ${CONFIG.outDir}:

  page-summary.csv
  request-details.csv
  summary.json

Resolver ${RESOLVER_LABEL}: ${stats.global.failed}/${stats.global.attempts} pages failed, P95 DNS ${stats.global.dns.p95 ?? '-'} ms
${failures.advice.map(a => `Why: ${a}`).join('\n')}${CONFIG.dnsDomains.length ? `\nDNS-only checks: ${dnsChecks.failed}/${dnsChecks.total} failed, P95 ${dnsChecks.p95 ?? '-'} ms` : ''}
${summaryJson.trend ? `Trend vs ${summaryJson.trend.previousStartedAt}: ${summaryJson.trend.notes.join('; ') || 'no change'}\n` : ''}Blocked-domain checks: ${blocked.blockedOk} blocked OK, ${blocked.blockFailed} block FAILED (of ${blocked.total})
${Object.entries(blocked.perCategory).map(([c, v]) => `  ${c}: ${v.blockedOk}/${v.total} blocked`).join('\n')}
`);

  for (const v of violations) console.error(`THRESHOLD: ${v}`);

  // Set, do not call process.exit: lets open handles flush first.
  process.exitCode = violations.length ? 1 : 0;
})();
