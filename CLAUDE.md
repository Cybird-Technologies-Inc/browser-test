# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This repo tests a DNS resolver (an ISP resolver). The main entry point is `run.js`: give it a resolver IP and it writes an HTML report (see Point-and-shoot runner). Underneath, `browser-test.js` is a Playwright (Chromium) page-load and DNS timer, and `dns-load-test.js` is an on-demand load ramp. The README has usage, the option and env-var tables and exit codes.

## Commands

- Install: `npm ci`, then `npx playwright install chromium` if the browser is missing.
- Run the point-and-shoot test: `node run.js <ip> --duration 10m --rounds 2` (see README). Run the page-load timer: `npm start`. Output goes to `page-summary.csv` and `request-details.csv` (gitignored).
- All checks: `npm run verify` (syntax check, ESLint, tests). Also run `npm audit --audit-level=high`; CI runs both. Do not call `npm audit` from an npm script: a user-level `allow-scripts` in `~/.npmrc` makes npm 12 reject it.
- Single test file: `node --test test/<file>.test.js`.
- Enable the pre-commit hook once per clone: `npm run setup` (secret scan, syntax, lint, tests).
- Lint: `npm run lint` (ESLint 9 flat config, `eslint.config.js`). No formatter; ask before adding Prettier.

## Design rule: any ISP, no hardcoded ISP

LeoHat was only the first example resolver. Code, config defaults and docs must stay ISP-neutral: the resolver under test is identified only by `RESOLVER_LABEL` and `RESOLVER_DNS_IP`, and sinkhole addresses by `BLOCK_PAGE_IPS`. Use placeholders such as `<ISP name>` in docs. Do not add an ISP name as a default anywhere.

## Architecture

- `lib.js` holds the pure, unit-tested logic: stats helpers, `loadConfig(env, fs)`, blocked-domain classification, `summarizeResults`, `checkThresholds`. Put new logic there so `node:test` can reach it without a browser.
- `browser-test.js` is the Playwright part: `testPage(browser, url, run)` collects per-request timings, `testPageIsolated` gives each page its own browser plus a hard timeout, and the main block runs a worker pool (`CONCURRENCY`), writes the CSVs and `summary.json`, and sets the exit code (0 ok, 1 threshold incl. `MAX_BLOCK_FAILED`, 2 config).
- `dns-load-test.js` (`npm run dns-load`) is the on-demand DNS load ramp: needs `CONFIRM_LOAD=yes`, hard ceilings 50 parallel and 20 queries/s in `lib.js`. Never schedule it.
- Random mix: `SAMPLE_*` + seeded `RANDOM_SEED` in `lib.loadConfig`. Blocked-pool entries carry a category; `EXPECT_BLOCKED_CATEGORIES` makes the category decide blocked vs allowed.
- Config is env-var only (table in the README). New CSV columns are appended after the existing ones so downstream readers keep working.
- Chromium uses the OS resolver, so results reflect whatever resolver the host is configured with. Running from WSL does not test the resolver: its resolver and IP are different, and the resolver only answers approved networks.

## Point-and-shoot runner

- `run.js` (`node run.js <resolver-ip[:port]> --duration 10m --rounds 2 [--compare <ip>]`) runs DNS-only cycles (`browser-test.js` with `PAGE_LOADS=false`) and writes one `report.html` plus `results.json` under `out/run-<timestamp>/`. Pure logic (option parsing, aggregation, HTML) is in `report.js`; `test/run-e2e.test.js` runs `run.js` against fake DNS servers on localhost.
- Preflight: before any cycle it sends one lookup to each resolver. No answer = red ACTION NEEDED banner, a banner in `report.html` and exit code 3, so the person running it fixes the approval first. `--interval` has a 10 s floor to protect a live resolver.
- It uses no cloud: no S3, email or alerts. The AWS deployment was removed on the user's request (the AWS resources were deleted; recoverable only from git history).
- The resolver only answers approved networks, and the user handles approval. A run from an unapproved network shows every lookup as failed.

## Project context (from the untracked planning files)

- `PLAN_and_open_points.txt` and `PROMPT_browser-test-session.txt` (untracked) hold the plan. Work lives on the single branch `feat/browser-test-monitor`; main still holds the original upload and is not to be changed until the user says so.
- Do not touch the untracked zip/CSV files in this directory (they belong to the user). Do not push or open a PR without being told. Ask before adding a dependency or deleting a file.
- Do not run heavy profiles against a live ISP resolver without the user's agreement.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
