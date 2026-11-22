const { chromium } = require('playwright');
const fs = require('fs');

// ========================================================
// CONFIG
// ========================================================

const URLS = [
  'https://www.google.com',
  'https://www.microsoft.com',
  'https://www.amazon.in',
  'https://www.linkedin.com',
  'https://www.youtube.com',
];

// IMPORTANT:
// Keep 1 when comparing 1-DoH vs 2-DoH.
// Restart dnsmasq before each complete test.
const REPEATS = 1;

// Allow JS/XHR/lazy resources to continue loading after page load.
const SETTLE_TIME_MS = 3000;

// Scroll to trigger lazy-loaded content.
const SCROLL_PAGE = true;

// DNS answers <= this are probably local/cache responses.
// They are still included, but also reported separately.
const CACHE_LIKE_THRESHOLD_MS = 2;

// ========================================================
// HELPERS
// ========================================================

function round(value) {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(value)
  ) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function phase(start, end) {
  if (
    start === undefined ||
    end === undefined ||
    start === null ||
    end === null ||
    start < 0 ||
    end < 0
  ) {
    return null;
  }

  return round(end - start);
}

function percentile(values, p) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);

  const index =
    (sorted.length - 1) * p;

  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return round(sorted[lower]);
  }

  const result =
    sorted[lower] +
    (sorted[upper] - sorted[lower]) *
      (index - lower);

  return round(result);
}

function average(values) {
  if (!values.length) return null;

  return round(
    values.reduce((a, b) => a + b, 0) /
      values.length
  );
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return url;
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);

  if (
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

function writeCSV(filename, rows) {
  if (!rows.length) return;

  const headers = Object.keys(rows[0]);

  const output = [
    headers.join(','),
    ...rows.map(row =>
      headers
        .map(h => csvEscape(row[h]))
        .join(',')
    )
  ];

  fs.writeFileSync(
    filename,
    output.join('\n')
  );
}

function dnsBuckets(values) {
  return {
    lt2:
      values.filter(v => v < 2).length,

    ms2to10:
      values.filter(v => v >= 2 && v < 10).length,

    ms10to50:
      values.filter(v => v >= 10 && v < 50).length,

    ms50to100:
      values.filter(v => v >= 50 && v < 100).length,

    ms100to200:
      values.filter(v => v >= 100 && v < 200).length,

    ms200to500:
      values.filter(v => v >= 200 && v < 500).length,

    gt500:
      values.filter(v => v >= 500).length,
  };
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

async function testPage(url, runNumber) {

  // New browser for every page minimizes Chrome-side
  // DNS/cache/connection reuse.
  const browser = await chromium.launch({
    headless: true
  });

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
        timeout: 45000
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

  await browser.close();

  return {
    summary,
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

(async () => {

  const allSummaries = [];
  const allRequests = [];

  for (
    let run = 1;
    run <= REPEATS;
    run++
  ) {

    for (
      const url of URLS
    ) {

      try {

        const result =
          await testPage(
            url,
            run
          );

        allSummaries.push(
          result.summary
        );

        allRequests.push(
          ...result.requests
        );

      } catch (error) {

        console.error(
          `ERROR testing ${url}:`,
          error.message
        );
      }
    }
  }

  // ------------------------------------------------------
  // WRITE CSV FILES
  // ------------------------------------------------------

  writeCSV(
    'page-summary.csv',
    allSummaries
  );

  writeCSV(
    'request-details.csv',
    allRequests
  );

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
    allSummaries.map(
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
    allRequests
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
    allRequests
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

  console.log(`
Files created:

  page-summary.csv
  request-details.csv
`);
})();
