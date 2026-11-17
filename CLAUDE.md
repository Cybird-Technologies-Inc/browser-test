# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`browser-test.js` is a Playwright (Chromium) page-load timer. It measures DNS, TTFB and load time per request. It is used to load-test and monitor a DNS resolver (an ISP resolver) and to compare resolvers. The README has usage, the env-var table and exit codes.

## Commands

- Install: `npm ci`, then `npx playwright install chromium` if the browser is missing.
- Run: `npm start`. Output goes to `page-summary.csv` and `request-details.csv` (gitignored).
- All checks: `npm run verify` (syntax check, ESLint, tests). Also run `npm audit --audit-level=high`; CI runs both. Do not call `npm audit` from an npm script: a user-level `allow-scripts` in `~/.npmrc` makes npm 12 reject it.
- Single test file: `node --test test/<file>.test.js`.
- Enable the pre-commit hook once per clone: `npm run setup` (secret scan, syntax, lint, tests).
- Lint: `npm run lint` (ESLint 9 flat config, `eslint.config.js`). No formatter; ask before adding Prettier.

## Design rule: any ISP, no hardcoded ISP

LeoHat was only the first example resolver. Code, config defaults and docs must stay ISP-neutral: the resolver under test is identified only by `RESOLVER_LABEL` and `RESOLVER_DNS_IP` (deploy), and sinkhole addresses by `BLOCK_PAGE_IPS`. Use placeholders such as `<ISP name>` in docs. Do not add an ISP name as a default anywhere.

## Architecture

- `lib.js` holds the pure, unit-tested logic: stats helpers, `loadConfig(env, fs)`, blocked-domain classification, `summarizeResults`, `checkThresholds`. Put new logic there so `node:test` can reach it without a browser.
- `browser-test.js` is the Playwright part: `testPage(browser, url, run)` collects per-request timings, `testPageIsolated` gives each page its own browser plus a hard timeout, and the main block runs a worker pool (`CONCURRENCY`), writes the CSVs and `summary.json`, and sets the exit code (0 ok, 1 threshold incl. `MAX_BLOCK_FAILED`, 2 config).
- Config is env-var only (table in the README). New CSV columns are appended after the existing ones so downstream readers keep working.
- Chromium uses the OS resolver, so results reflect whatever resolver the host is configured with. Running from WSL does not test the resolver: its resolver and IP are different, and the resolver only answers approved networks.

## Deploy (`deploy/`)

- `deploy/aws/{install,update,uninstall}.sh` create and remove the AWS pieces (S3 bucket, SNS alerts, IAM, EC2 + Elastic IP, heartbeat alarm) in `ap-south-1`. All support `DRY_RUN=1`, which makes no `aws` call; tests rely on that.
- `deploy/instance/` runs on the box: `setup.sh`, systemd units (15-minute timer), `run-and-upload.sh`, `alert.sh`. The host resolver is the resolver with no fallback; AWS endpoints bypass it so alerts still work.
- Real installs need `ALERT_EMAIL` and `RESOLVER_DNS_IP` in the environment (never committed). `deploy/` must be committed first: the release is `git archive HEAD`.
- Never run a real install, update or uninstall without the user's explicit go-ahead. See `deploy/README.md`.
- Not yet run on real AWS or Ubuntu: every `aws` call, `setup.sh`, the DNS routing and the AppArmor profile are untested.

## Project context (from the untracked planning files)

- `PLAN_and_open_points.txt` and `PROMPT_browser-test-session.txt` (untracked) hold the plan. PR 1 (script-only config, thresholds, summary.json, blocked check) is implemented on `feat/configurable-scheduled-runs`.
- PR 2 (EC2 timer, metrics push) is out of scope here. Its infra belongs in `cybird-dns-shield` tooling, not in this repo.
- Do not touch the untracked zip/CSV files in this directory (they belong to the user). Do not push or open a PR without being told. Ask before adding a dependency or deleting a file.
- Do not run heavy profiles against a live ISP resolver without the user's agreement.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
