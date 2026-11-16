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
| `BLOCKED_URLS` | unset | Same format as `URLS`. Domains the resolver should block |
| `BLOCK_PAGE_IPS` | unset | Comma list of IPs your block page is served from |
| `BLOCK_PAGE_PATTERN` | unset | Case-insensitive regex matched against the page text of a block page |

A page counts as **failed** if it throws, times out, or gets no main response.
HTTP 4xx/5xx with a response is not a failure.

### Blocked domains

For each `BLOCKED_URLS` entry: NXDOMAIN, an answer from `BLOCK_PAGE_IPS`, or page
text matching `BLOCK_PAGE_PATTERN` is **blocked OK**. Anything else, including a
real page, is **block FAILED**. Without `BLOCK_PAGE_IPS` or `BLOCK_PAGE_PATTERN`
a block page cannot be recognised. Blocked URLs never count in the DNS
percentiles or the failure rate.

### Output files (in `OUT_DIR`)

| File | Content |
|------|---------|
| `page-summary.csv`, `request-details.csv` | Existing columns first, then `resolver`, `timestamp`, `kind` (and `failed`, `blockResult` on pages) |
| `summary.json` | Per URL and global: attempts, failed, failure rate, DNS count/avg/P50/P95/P99/max; blocked counts; threshold violations |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Run finished, no threshold exceeded |
| `1` | `MAX_P95_DNS_MS` or `MAX_FAIL_RATE` exceeded (the message says which) |
| `2` | Invalid configuration (all problems are listed) |

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
