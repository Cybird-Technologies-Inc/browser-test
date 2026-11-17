# browser-test

Playwright (Chromium) page-load timer. It measures DNS, TTFB and load time per
request, so a DNS resolver can be load-tested and monitored.

## Usage

```bash
RESOLVER_LABEL=leohat REPEATS=3 CONCURRENCY=2 MAX_P95_DNS_MS=150 MAX_FAIL_RATE=0.1 npm start
```

Chromium uses the host's DNS resolver, so run it on a machine whose resolver
is the one under test (and whose IP the resolver accepts).

### Environment variables

Every variable is optional. Defaults equal the old hardcoded values.

| Variable | Default | Meaning |
|----------|---------|---------|
| `URLS` | 5 built-in sites | Comma list of `http(s)` URLs, or a path to a file (one URL per line, `#` comments) |
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
| `BLOCKED_URLS` | unset | Domains the resolver should block, as `category=domain` entries (comma list, or a file). See below |
| `MAX_BLOCK_FAILED` | unset | Fail if more than this many blocked domains were answered. Use `0` whenever `BLOCKED_URLS` is set |
| `BLOCK_PAGE_IPS` | unset | Comma list of the resolver's sinkhole IPs (list both IPv4 and IPv6 if it answers both) |

A page counts as **failed** if it throws, times out, gets no main response, or
answers with HTTP 4xx or 5xx (the convention of common uptime monitors). Some
sites answer headless browsers with 4xx (for example LinkedIn); drop such sites
from `URLS` or the failure rate will never reach 0.

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

The summary reports totals and a count per category, so a feed that stops
blocking shows up even while the others still work. A warning is logged if
`BLOCKED_URLS` is set without `BLOCK_PAGE_IPS`. Blocked entries never count in
the DNS percentiles or the page failure rate. Set `MAX_BLOCK_FAILED=0` to alert.

### Output files (in `OUT_DIR`)

| File | Content |
|------|---------|
| `page-summary.csv`, `request-details.csv` | Existing columns first, then `resolver`, `timestamp`, `kind` (and `failed`, `category`, `blockResult`, `blockDetail` on pages) |
| `summary.json` | Per URL and global: attempts, failed, failure rate, DNS count/avg/P50/P95/P99/max; blocked counts; threshold violations |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Run finished, no threshold exceeded |
| `1` | `MAX_P95_DNS_MS`, `MAX_FAIL_RATE` or `MAX_BLOCK_FAILED` exceeded (the message says which) |
| `2` | Invalid configuration (all problems are listed) |

### Example profiles

Ready-made settings in `profiles/`. Load one with `set -a; . profiles/light.env; set +a`
(or a systemd `EnvironmentFile=`), and set `RESOLVER_LABEL` yourself.

| File | Load | Use |
|------|------|-----|
| `light.env` | 1 browser x 1 pass | Scheduled monitoring, about every 15 minutes |
| `heavy-start.env` | 2 browsers x 5 repeats | First step of an on-demand load test |
| `heavy.env` | 10 browsers x 20 repeats | Full load. Reach it by ramping up, never as a first run |

The thresholds in the profiles are starting values: tune them after baseline runs.
Do not run the heavy profiles against LeoHat without agreement. It serves real subscribers.

## Deploy

A scheduled runner on AWS (EC2 timer, S3 results, SNS alerts, heartbeat alarm) is described in [deploy/README.md](deploy/README.md).

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
| CI | `.github/workflows/ci.yml` | Same checks plus `npm audit` and a gitleaks secret scan, on every PR |
| `.gitignore` | repo root | Results (`*.csv`, `out/`), archives, `.env`, `node_modules` |
| Dependabot | `.github/dependabot.yml` | Outdated npm packages and GitHub Actions |
| Claude Code settings | `.claude/settings.json` | Blocks `git push`, PR creation and reading `.env` without approval |

## Workflow

Trunk-based: one short-lived branch per change, pull request, squash-merge to
`main`, CI green before merge.
