# browser-test

Tests how fast and how reliably a DNS resolver answers. Give it a resolver IP and a
time to run; it writes one web page with the results. It can also time page loads
with Playwright (Chromium) and run a DNS load ramp. Nothing is uploaded or emailed.

## Quick start: point and shoot

```bash
npm ci                                   # once
node run.js <resolver-ip> --duration 10m --rounds 2
# then open out/run-<timestamp>/report.html in a browser
```

Run it from a network the resolver approves. The resolver answers only approved networks,
so from any other network every lookup shows as failed. No browser download is needed for this mode (`npm ci` is enough).

### Before the test starts

Before any cycle, `run.js` sends one real lookup to the resolver (and to the `--compare` resolver). If it gets
no answer, the test does **not** start. You get:

- a red **ACTION NEEDED BEFORE THE TEST CAN START** box in the terminal, naming the resolver and the reason;
- the same message as a banner at the top of `report.html`;
- exit code `3`.

Typical cause: the resolver only answers approved networks and this machine's public IP is not approved yet.
Ask the resolver owner to approve it, then run the same command again. A "no such name" answer counts as a reply.

### What it does

- A **cycle** asks the resolver for a list of names directly (the machine's own DNS and cache are not used). The first time a cycle asks for a name is the **first lookup**; the next asks are **repeat lookups**, which hit the resolver's cache.
- A **round** repeats cycles for `--duration`. A new cycle starts every `--interval`. The cycle in progress always finishes.
- The run does `--rounds` rounds, with `--gap` between them.
- Only the IP you give is tested. A second resolver is tested only if you add `--compare`.

### Examples

| Goal | Command |
|------|---------|
| One resolver, one 10-minute round | `node run.js 203.0.113.10` |
| Test a public resolver on its own | `node run.js 8.8.8.8` (it is just an IP; no comparison happens) |
| 2 rounds of 10 minutes, 5 minutes apart | `node run.js 203.0.113.10 --duration 10m --rounds 2 --gap 5m` |
| Start at a set time (this machine's local time) | `node run.js 203.0.113.10 --start-at 14:30` |
| Compare with a public resolver | `node run.js 203.0.113.10 --compare 8.8.8.8 --compare-label public-ref` |
| Add the blocked-category check | `node run.js 203.0.113.10 --blocked-urls profiles/pool-blocked.txt --expect-blocked malware,phishing` |
| Random 8 names per cycle, named report | `node run.js 203.0.113.10 --sample-dns 8 --label my-isp` |

### Options

| Option | Default | Meaning |
|--------|---------|---------|
| `<resolver-ip>` | required | IPv4 address of the resolver to test, optionally with a port (`203.0.113.10` or `127.0.0.1:5353`; port 53 if omitted) |
| `--duration` | `10m` | Length of each round. Units `s`, `m`, `h` (a unit is required) |
| `--rounds` | `1` | Number of rounds (1 to 100) |
| `--gap` | `0s` | Pause between rounds |
| `--interval` | `60s` | Time between cycle starts inside a round. Minimum `10s`, to keep load on a live resolver gentle |
| `--start-at HH:MM` | start now | Wait for this local time; if it has passed today, tomorrow |
| `--label` | the IP | Name shown in the report |
| `--compare IP[:port]` | none | Also test this reference resolver each cycle, with the same names (same seed), and show both side by side. Must differ from the resolver under test |
| `--compare-label` | its IP | Name of the reference in the report |
| `--dns-domains` | `profiles/pool-dns.txt` | Names to time: a file (one per line, `#` comments) or a comma list |
| `--sample-dns N` | all | Use N random names from the list each cycle |
| `--dns-repeats N` | `3` | Lookups per name per cycle: 1 first, then N-1 repeats |
| `--blocked-urls FILE` | no check | Category list (`category domain` per line) for the blocked-name check |
| `--expect-blocked LIST` | all | Categories the resolver should block, such as `malware,phishing`. The other categories must resolve normally. Needs `--blocked-urls` |
| `--block-page-ips LIST` | none | The resolver's sinkhole IPs, if it answers blocked names with one |
| `--sample-blocked N` | all | Names per category per cycle |
| `--cycle-timeout` | `5m` | Stops one cycle that hangs; it is recorded as failed |
| `--out DIR` | `out/run-<timestamp>` | Output folder |

`node run.js --help` prints the same list. Ctrl+C stops early and still writes the report.

### Without `--compare`

Only the IP you give is tested. The report has no reference columns, no second chart line and no
difference figures. Use this to point and run at any single resolver, including a public one such as `8.8.8.8`.

### With `--compare`

Each cycle asks your resolver, then the reference, for the same names. The report adds:

- a **Resolver comparison** section at the top: one summary sentence and a side-by-side table (failed lookups, first and repeat P95, cycle 1 against later cycles, failed names). It states facts only, with no good or bad verdict;
- the reference's first-lookup P95 (median across cycles) and its failures;
- the difference in first P95 (positive = your resolver is slower) and "cycles slower than reference: X of Y";
- reference columns in the per-round and per-cycle tables, and a second dashed line on the chart.

The reference is not given the blocked-category check, because it does not carry your resolver's policy.
A cycle takes about twice as long, because both resolvers are asked. A reference answer comes from that
resolver's own cache, so it shows what a typical public resolver does, not a fixed baseline.

### Reading the report

The same names are asked in every cycle, so after cycle 1 the resolver may already hold them in cache. Later
"first" lookups can then look faster than a true cold lookup. The report shows **cycle 1's first P95** as its own
figure: it is the closest to a cold start. All times in the report are UTC; `--start-at` uses this machine's local time
and prints both when the run starts.

| Part | Meaning |
|------|---------|
| Cards | Cycles, lookups, failed lookups, median first and repeat P95 (and the reference and difference with `--compare`) |
| First-lookup P95 chart | One point per cycle. A gap is a failed cycle, not zero |
| Per round / per cycle | Lookups, failures, first P50 and P95, repeat P95 (ranges are min / median / max across cycles) |
| Names that failed | Name, error code and how many cycles it failed in |
| Category check | Only with `--blocked-urls`: how many checks were right per category |
| Settings used | Every option the run used |

P95 means 95 out of 100 lookups were at least this fast. A big gap between first and repeat P95 means
cache misses are slow. A failed cycle (a timeout or crash) is listed with its reason, never hidden.

### Exit codes of `run.js`

| Code | Meaning |
|------|---------|
| `0` | The run finished (even if some lookups failed: read the report) |
| `2` | Bad option, bad name list, missing file, or the `--out` folder already holds a run |
| `3` | Preflight failed: a resolver did not answer. Action needed before the test (see above) |

### Output files

| File | Content |
|------|---------|
| `report.html` | The report: one self-contained page, no internet needed |
| `results.json` | All cycles of the run, for your own tools |
| `round-N/cycle-NN/summary.json` | Full numbers for one cycle (the reference is in `reference/`) |
| `round-N/cycle-NN/run.log` | Console output of that cycle |

The report and results are rewritten after every cycle, so a crash never loses finished cycles.

### Limits and safety

- Query load is light: a few dozen lookups per cycle, one cycle per `--interval`. Do not lower `--interval` against a live ISP resolver without its owner's agreement.
- This mode runs no page loads and starts no browser. Page-load timing needs the host's DNS to be the resolver under test (see below).
- Nothing leaves the machine except the DNS queries to the IPs you name.

---

## Reference: page-load timer and load ramp

The sections below describe the underlying tools: the Playwright page-load timer
(`npm start`) and the DNS load ramp (`npm run dns-load`). `run.js` uses the timer with
`PAGE_LOADS=false`.

## Usage

```bash
RESOLVER_LABEL=isp-a REPEATS=3 CONCURRENCY=2 MAX_P95_DNS_MS=150 MAX_FAIL_RATE=0.1 npm start
```

Chromium uses the host's DNS resolver, so run it on a machine whose resolver
is the one under test (and whose IP the resolver accepts).

### Environment variables

Every variable is optional. Defaults equal the old hardcoded values.

| Variable | Default | Meaning |
|----------|---------|---------|
| `URLS` | 4 built-in sites | Comma list of `http(s)` URLs, or a path to a file (one URL per line, `#` comments) |
| `REPEATS` | `1` | Passes over the URL list |
| `CONCURRENCY` | `1` | Parallel browsers (max 50). Console output interleaves when above 1 |
| `SETTLE_TIME_MS` | `3000` | Wait after load for lazy resources |
| `SCROLL_PAGE` | `true` | Scroll to trigger lazy content |
| `CACHE_LIKE_THRESHOLD_MS` | `2` | DNS answers at or below this count as cache-like and are left out of percentiles |
| `NAV_TIMEOUT_MS` | `45000` | Page load timeout. A hard cap of this + settle + 30 s stops a hung browser |
| `OUT_DIR` | `.` | Folder for the output files (created if missing, files overwritten) |
| `RESOLVER_LABEL` | `unlabeled` | Label written to every CSV row and `summary.json` |
| `MAX_P95_DNS_MS` | unset | Fail if the global P95 DNS (ms) is above this |
| `MAX_FAIL_RATE` | unset | Fail if failed pages / attempts (0 to 1) is above this |
| `IGNORE_HTTP_STATUS` | unset | Comma list of HTTP error codes (400-599) that do not count as failures, for example `403` for a site that blocks datacenter clients |
| `DNS_DOMAINS` | unset | Plain domains for DNS-only timing (comma list or file). Runs after the page tests, no browser |
| `DNS_REPEATS` | `3` | Lookups per `DNS_DOMAINS` entry |
| `DNS_LOOKUP_TIMEOUT_MS` | `5000` | Per-lookup limit for DNS-only checks; a timeout counts as a failed lookup |
| `DNS_CHECK_LOOKUP` | `resolver` if `RESOLVER_DNS_IP` is set, else `system` | How `DNS_DOMAINS` are timed. `resolver` asks that resolver directly (no host cache), so `summary.json` can split `dnsChecks.first` from `dnsChecks.repeat`. `system` uses the OS resolver, whose cache hides the resolver's own times |
| `MAX_DNS_CHECK_FAIL_RATE` | unset | Fail if DNS-only lookups that failed / total (0 to 1) is above this |
| `BLOCKED_URLS` | unset | Domains the resolver should block, as `category=domain` entries (comma list, or a file). See below |
| `MAX_BLOCK_FAILED` | unset | Fail if more than this many blocked domains were answered. Use `0` whenever `BLOCKED_URLS` is set |
| `EXPECT_BLOCKED_CATEGORIES` | unset | Categories switched ON in the resolver's panel: `all`, `none` or a comma list. Names in them must be blocked, names in every other category must resolve normally. Unset = all expected blocked |
| `RESOLVER_DNS_PORT` | `53` | Port of `RESOLVER_DNS_IP` (for a resolver on another port, or a local test server) |
| `PAGE_LOADS` | `true` | `false` = DNS-only run: no page is opened and no browser starts (what `run.js` sets) |
| `SAMPLE_URLS` / `SAMPLE_BLOCKED` / `SAMPLE_DNS` | unset | Random real-user mix: use this many from the `URLS` / `DNS_DOMAINS` pool, or this many per category from the `BLOCKED_URLS` pool. Unset = use all |
| `RANDOM_SEED` | random | Seed for the mix. It is logged and written to `summary.json`, so a run can be replayed |
| `THINK_TIME_MAX_MS` | `0` | Each page waits a random 0 to this many ms after the first ones, like a user reading |
| `BLOCKED_LOOKUP` | `resolver` if `RESOLVER_DNS_IP` is set, else `system` | `resolver` or `system`; see Blocked-domain check |
| `BLOCK_PAGE_IPS` | unset | Comma list of the resolver's sinkhole IPs (list both IPv4 and IPv6 if it answers both) |

A page counts as **failed** if it throws, times out, gets no main response, or
answers with HTTP 4xx or 5xx (the convention of common uptime monitors). Some
sites answer datacenter clients with 4xx (for example a 403 bot block); drop such
sites from `URLS`, or list their code in `IGNORE_HTTP_STATUS`.

Every failure gets a reason in `summary.json` (`failures.byReason`, `failedUrls`,
`advice`): `dns`, `timeout`, `tls`, `connection`, `http_4xx`, `http_5xx`, `other`
or `no_response`. A `dns` or `timeout` points at the resolver; `http_*` means the
site answered, so DNS worked. The alert email lists the failed URLs and the advice.
`MAX_P95_DNS_MS`, `MAX_FAIL_RATE` and `MAX_DNS_CHECK_FAIL_RATE` exit 1 when exceeded.

**Trend.** If `PREVIOUS_SUMMARY` points to the previous run's `summary.json`, the new
`summary.json` gets a `trend` block: change in failure rate and P95 DNS, newly failing
and recovered URLs. It is report only and never changes the exit code. A missing,
damaged or other-resolver file means no trend.

### Blocked domains (feed categories)

`BLOCKED_URLS` checks that each feed category really blocks. Entries look like
`malware=bad.example,phishing=worse.example`, or one per line in a file:
`malware bad.example` or `malware=bad.example`, with `#` comments. The format
of the shield's `client-test-results/<run>/domains.txt` works as is.

These names are **only looked up in DNS, never opened in a browser**: they are
malware and phishing domains. For each lookup:

| Answer | Result |
|--------|--------|
| NXDOMAIN | blocked OK |
| Only addresses listed in `BLOCK_PAGE_IPS` (the sinkhole) | blocked OK |
| Any other address, or a mix of sinkhole and real addresses | **block FAILED** |
| Timeout or SERVFAIL | **block FAILED** (the resolver proved nothing) |
| Empty answer (no addresses, no error) | **block FAILED** (or `over_blocked` for an allowed category): it proves nothing |

Only the IP families listed in `BLOCK_PAGE_IPS` are compared. If you list only IPv4 sinkhole
addresses, an extra IPv6 address in the answer is ignored; list the IPv6 address too if you
want it judged.

`BLOCKED_LOOKUP` picks how blocked names are looked up. `resolver` (the default whenever
`RESOLVER_DNS_IP` is set) asks that resolver directly, so a host cache can
never answer for it. `system` uses the OS resolver like Chromium and can return cached answers.
The page tests always use the OS resolver.

Names on the pool are checked by exact name against the feed sources. A source that lists
`malware.example` does not block `example`; use the listed name.

The summary reports totals and a count per category, so a feed that stops
blocking shows up even while the others still work. A warning is logged if
`BLOCKED_URLS` is set without `BLOCK_PAGE_IPS`, or when an allowed-expected category is
in use without it (over-blocking cannot be seen then). Blocked entries never count in
the DNS percentiles or the page failure rate. Set `MAX_BLOCK_FAILED=0` to alert.

**Category switch test.** Every pool entry has a category, and the category decides the
expected answer. With `EXPECT_BLOCKED_CATEGORIES=malware,phishing`, malware and phishing
names must be blocked, and names in all other categories (social, gambling, news and so on)
must resolve normally. A blocked name that should resolve counts as `over_blocked`. Both
directions count in `MAX_BLOCK_FAILED`. To test the panel: switch a category in the panel,
add it to (or remove it from) the list, and watch the next cycles. A change needs time to
reach the resolver and to leave caches, so expect a few wrong cycles right after a switch.
`SAMPLE_BLOCKED` picks per category, so every
category is checked in every cycle. Pool files: `profiles/pool-urls.txt`,
`profiles/pool-blocked.txt`, `profiles/pool-dns.txt`.

### First and repeat lookups

With `DNS_DOMAINS` and `DNS_REPEATS` of 2 or more, each name is looked up in passes. `dnsChecks.first`
is the first pass and `dnsChecks.repeat` the later ones (total, failed, P50, P95, max). With
`DNS_CHECK_LOOKUP=resolver` these are the resolver's own times: the first is its cache-miss time
unless a subscriber asked for the name just before, and the repeat is its cache-hit time. Read the
first-lookup P95 against a cold-lookup baseline, not against a big public resolver's warm cache.
The page tests still use the OS resolver, and their P95 (`MAX_P95_DNS_MS`) is unchanged.

### DNS load ramp (on demand)

`npm run dns-load` sends A queries straight to one resolver in rising steps of parallel
lookups (default 5, 10, 25, 50, each `STEP_SECONDS=30`), and writes `load-test-summary.json`
with P50/P95/P99, errors and achieved queries per second per step, plus the first step where
P95 passes `DEGRADE_FACTOR` (2) times the first step's, or errors pass `STOP_ERROR_RATE`
(0.05). The ramp stops at that error rate. It is never run by the timer.

The queries/s ceiling (`MAX_QPS`, at most 20) is global, so it can hold several steps at the
same load. A step held at the ceiling is marked `paced`. If every step is paced, the summary
sets `inconclusive: true` and the run prints a warning: the steps differ only in parallelism,
and "no degradation" does not show capacity. Answers of "no such name" (NXDOMAIN) or "no A
record" count as answered load (`noRecord`), not as errors. `LOAD_MAX_CONCURRENCY` below 5
without `LOAD_STEPS` is a config error (exit 2).

| Variable | Default | Meaning |
|----------|---------|---------|
| `RESOLVER_DNS_IP` | required | IPv4 of the resolver under test (queried directly, not the OS resolver) |
| `CONFIRM_LOAD` | required | Must be `yes`: the owner of the resolver has agreed to the load |
| `DNS_DOMAINS` | required | Names to query (list or file, for example `profiles/pool-dns.txt`) |
| `LOAD_STEPS` | `5,10,25,50` | Parallel lookups per step, rising |
| `STEP_SECONDS` | `30` | Length of each step (5 to 600) |
| `MAX_QPS` | `20` | Queries per second ceiling. Cannot be set above 20 |
| `LOAD_MAX_CONCURRENCY` | `50` | Cap on parallel lookups. Cannot be set above 50 |
| `QUERY_TIMEOUT_MS` | `3000` | A lookup with no answer by then is an error |

Run it only when the resolver's owner has agreed, one run at a time.

### Output files (in `OUT_DIR`)

| File | Content |
|------|---------|
| `page-summary.csv`, `request-details.csv` | Existing columns first, then `resolver`, `timestamp`, `kind` (and `failed`, `category`, `blockResult`, `blockDetail` on pages) |
| `summary.json` | Per URL and global: attempts, failed, failure rate, DNS count/avg/P50/P95/P99/max; blocked counts; threshold violations |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Run finished, no threshold exceeded |
| `1` | `MAX_P95_DNS_MS`, `MAX_FAIL_RATE`, `MAX_DNS_CHECK_FAIL_RATE` or `MAX_BLOCK_FAILED` exceeded (the message says which) |
| `2` | Invalid configuration (all problems are listed) |

### Example profiles

Ready-made settings in `profiles/`. Load one with `set -a; . profiles/light.env; set +a`
, and set `RESOLVER_LABEL` yourself.

| File | Load | Use |
|------|------|-----|
| `light.env` | 1 browser x 1 pass | Scheduled monitoring, about every 15 minutes |
| `heavy-start.env` | 2 browsers x 5 repeats | First step of an on-demand load test |
| `heavy.env` | 10 browsers x 20 repeats | Full load. Reach it by ramping up, never as a first run |

The thresholds in the profiles are starting values: tune them after baseline runs.
Do not run the heavy profiles against a live ISP resolver without agreement. It serves real subscribers.

## Development setup

Requires Node 22 or newer (`nvm use` reads `.nvmrc`).

| Step | Command |
|------|---------|
| Install dependencies | `npm ci` |
| Install the browser | `npx playwright install chromium` |
| Enable the pre-commit hook (once per clone) | `npm run setup` |
| Run the script | `npm start` |
| Run local checks (syntax, lint, tests) | `npm run verify` |
| Dependency audit (also run by CI) | `npm audit --audit-level=high` |

## Guard rails

| Guard | Where | What it stops |
|-------|-------|---------------|
| Pre-commit hook | `.githooks/pre-commit` | Secrets, result files and archives in a commit; syntax errors; failing tests |
| CI | `.github/workflows/ci.yml` | Same checks plus `npm audit` and a gitleaks secret scan, on every PR. The `secret-scan` job needs the repository secret `GITLEAKS_LICENSE` (a Cybird admin sets it in the repo's Actions secrets); without it that job fails. |
| `.gitignore` | repo root | Results (`*.csv`, `out/`), archives, `.env`, `node_modules` |
| Dependabot | `.github/dependabot.yml` | Outdated npm packages and GitHub Actions |
| Claude Code settings | `.claude/settings.json` | Blocks `git push`, PR creation and reading `.env` without approval |

## Workflow

Trunk-based: one short-lived branch per change, pull request, squash-merge to
`main`, CI green before merge.
