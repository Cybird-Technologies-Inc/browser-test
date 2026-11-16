# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`browser-test.js` is a single-file Playwright (Chromium) page-load timer. It measures DNS, TTFB and load time per request. It is used to load-test and monitor a DNS resolver (the "LeoHat" ISP resolver) and to compare resolvers. The README is only a one-line stub.

## Commands

- Install: `npm ci`, then `npx playwright install chromium` if the browser is missing.
- Run: `npm start`. Output goes to `page-summary.csv` and `request-details.csv` (gitignored).
- All checks: `npm run verify` (syntax check, ESLint, tests). Also run `npm audit --audit-level=high`; CI runs both. Do not call `npm audit` from an npm script: a user-level `allow-scripts` in `~/.npmrc` makes npm 12 reject it.
- Single test file: `node --test test/<file>.test.js`.
- Enable the pre-commit hook once per clone: `npm run setup` (secret scan, syntax, tests).
- Lint: `npm run lint` (ESLint 9 flat config, `eslint.config.js`). No formatter; ask before adding Prettier.

## Architecture

- Everything lives in `browser-test.js`: config constants at the top, pure helpers (`round`, `phase`, `percentile`, `average`, `csvEscape`, `dnsBuckets`), then `testPage(url, runNumber)` (launches Chromium per call and collects per-request timings), then a long main section that loops `URLS` x `REPEATS`, writes the CSVs and prints summaries (`printGlobalDNS` etc.).
- Config is currently hardcoded constants (`URLS`, `REPEATS`, `SETTLE_TIME_MS`, `SCROLL_PAGE`, `CACHE_LIKE_THRESHOLD_MS`). `PROMPT_browser-test-session.txt` describes the planned change to env-var config.
- Chromium uses the OS resolver, so results reflect whatever resolver the host is configured with. Running from WSL does not test LeoHat: its resolver and IP are different, and LeoHat only answers approved networks.

## Project context (from the untracked planning files)

- `PLAN_and_open_points.txt` and `PROMPT_browser-test-session.txt` hold the plan for branch `feat/configurable-scheduled-runs`. PR 1 is script-only: env-var config, `RESOLVER_LABEL`, `summary.json`, `MAX_P95_DNS_MS` / `MAX_FAIL_RATE` thresholds with non-zero exit, per-URL failure handling, `BLOCKED_URLS`, `.gitignore`, README, `node:test` tests. Keep the existing CSV column names.
- PR 2 (EC2 timer, metrics push) is out of scope here. Its infra belongs in `cybird-dns-shield` tooling, not in this repo.
- Do not touch the untracked zip/CSV files in this directory (they belong to the user). Do not push or open a PR without being told. Ask before adding a dependency or deleting a file.
- Do not run heavy profiles against LeoHat without the user's agreement.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
