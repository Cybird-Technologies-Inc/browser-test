# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`browser-test.js` is a Playwright (Chromium) page-load timer. It measures DNS, TTFB and load time per request. It is used to load-test and monitor a DNS resolver (the "LeoHat" ISP resolver) and to compare resolvers. The README has usage, the env-var table and exit codes.

## Commands

- Install: `npm ci`, then `npx playwright install chromium` if the browser is missing.
- Run: `npm start`. Output goes to `page-summary.csv` and `request-details.csv` (gitignored).
- All checks: `npm run verify` (syntax check, ESLint, tests). Also run `npm audit --audit-level=high`; CI runs both. Do not call `npm audit` from an npm script: a user-level `allow-scripts` in `~/.npmrc` makes npm 12 reject it.
- Single test file: `node --test test/<file>.test.js`.
- Enable the pre-commit hook once per clone: `npm run setup` (secret scan, syntax, lint, tests).
- Lint: `npm run lint` (ESLint 9 flat config, `eslint.config.js`). No formatter; ask before adding Prettier.

## Architecture

- `lib.js` holds the pure, unit-tested logic: stats helpers, `loadConfig(env, fs)`, blocked-domain classification, `summarizeResults`, `checkThresholds`. Put new logic there so `node:test` can reach it without a browser.
- `browser-test.js` is the Playwright part: `testPage(browser, url, run)` collects per-request timings, `testPageIsolated` gives each page its own browser plus a hard timeout, and the main block runs a worker pool (`CONCURRENCY`), writes the CSVs and `summary.json`, and sets the exit code (0 ok, 1 threshold incl. `MAX_BLOCK_FAILED`, 2 config).
- Config is env-var only (table in the README). New CSV columns are appended after the existing ones so downstream readers keep working.
- Chromium uses the OS resolver, so results reflect whatever resolver the host is configured with. Running from WSL does not test LeoHat: its resolver and IP are different, and LeoHat only answers approved networks.

## Project context (from the untracked planning files)

- `PLAN_and_open_points.txt` and `PROMPT_browser-test-session.txt` (untracked) hold the plan. PR 1 (script-only config, thresholds, summary.json, blocked check) is implemented on `feat/configurable-scheduled-runs`.
- PR 2 (EC2 timer, metrics push) is out of scope here. Its infra belongs in `cybird-dns-shield` tooling, not in this repo.
- Do not touch the untracked zip/CSV files in this directory (they belong to the user). Do not push or open a PR without being told. Ask before adding a dependency or deleting a file.
- Do not run heavy profiles against LeoHat without the user's agreement.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
