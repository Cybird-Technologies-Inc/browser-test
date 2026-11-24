# Improvement plan and tracker (branch feat/browser-test-monitor)

Status values: TODO, DOING, DONE, BLOCKED (needs input), NOTED (cannot be done yet).

## Evidence from the code check

| Check | Result |
|-------|--------|
| `npm run verify` | 71 of 71 tests, lint clean |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| CI on the branch | Not run yet. CI triggers only on pull requests and pushes to main, so the new action versions (checkout, setup-node, gitleaks-action) are unverified until a pull request exists |
| Bug A1 (reproduced, then fixed) | Reusing `--out` after a run, then testing an unroutable IP: the report showed the old run's numbers for the dead resolver |
| Bug A2 (reproduced, then fixed) | `--dns-domains example.com` stopped with "File not found" |
| Bug A3 (reproduced, then fixed) | Ctrl+C mid-cycle recorded a timeout as the reason |

## Phase A: correctness bugs

| ID | Item | Fix | Status |
|----|------|-----|--------|
| A1 | Stale `summary.json` read as the new result when a cycle folder is reused | Delete the cycle's `summary.json` before each spawn; refuse a `--out` folder that already holds a run | DONE |
| A2 | A single domain mis-detected as a missing file | Validate the list once with the real loader before the first cycle | DONE |
| A3 | Wrong failure reason when the user stops the run | Record "stopped by user" separately from "timed out" | DONE |
| A4 | Second Ctrl+C swallowed | A second Ctrl+C exits at once | DONE |

## Phase B: preflight and safety

| ID | Item | Fix | Status |
|----|------|-----|--------|
| B1 | A 20 minute run against an unapproved or dead resolver only fails at the end | One real lookup to each resolver before round 1. No answer stops the run with a clear message and exit code 3. There is no option to skip it | DONE |
| B2 | `--interval` could hammer a live resolver | 10 s floor; the report warns when a cycle runs longer than the interval | DONE |
| B3 | Tests could not reach a fake resolver (port 53 only) | `RESOLVER_DNS_PORT` (default 53) and `--port` | DONE |

## Phase C: tests and report

| ID | Item | Fix | Status |
|----|------|-----|--------|
| C1 | `run.js` loop, timing, `--compare` and failure paths had no test | `test/run-e2e.test.js` runs `run.js` against fake UDP DNS servers on localhost | DONE |
| C2 | First lookups warm up over a long run (the name pool repeats) | Note in report and README; cycle 1 first P95 shown as its own card | DONE |
| C3 | Timestamps are UTC but were not labelled | "UTC" label in the report; local start time and UTC value printed at launch | DONE |
| C4 | Report never viewed in a browser | Checked in Chromium, light and dark, desktop and phone width | DONE |
| C5 | The comparison was spread over cards and tables | "Resolver comparison" section at the top: summary sentence, side-by-side table, cold against warm, slowest names per resolver, "about the same" within 20 ms, and a "Not checked in this run" note | DONE |

## Phase D: housekeeping

| ID | Item | Status |
|----|------|--------|
| D1 | `CLAUDE.md` refreshed (commands, branch names, project context) | DONE |
| D2 | Pre-commit hook comment: only added or modified files are scanned | DONE |
| D3 | Dependabot groups `eslint` and `@eslint/js` so they move together | DONE |
| D4 | CI secret scan needs the `GITLEAKS_LICENSE` secret. A repository admin must set it. No guardrail was changed | DONE (README note) |
| D5 | Page-load mode checked once in real Chromium | DONE |
| D6 | CI on the branch | NOTED: stays unverified until a pull request is opened |

## Phase E: open items

| ID | Item | Status |
|----|------|--------|
| E1 | Follow-ups outside this repository (feed categories) | Tracked privately |
| E2 | Verdict-cache test against a live resolver | BLOCKED: needs a throwaway name, an approved network and an explicit go-ahead. Tracked privately |
| E3 | Block-check run (`docs/RUN_GUIDE.md`, section 4) | TODO: run from an approved network; add `--block-page-ips` if the resolver answers with a sinkhole IP |

## Phase F: verify and commit

| Step | Detail | Status |
|------|--------|--------|
| F1 | `npm run verify` and `npm audit --audit-level=high` clean | DONE |
| F2 | One commit per phase, each with the Co-Authored-By line | DONE |
| F3 | Reproductions of A1, A2 and A3 re-run and shown fixed | DONE |
| F4 | Scratch folders and test output removed | DONE |

## Decisions taken

| ID | Question | Decision |
|----|----------|----------|
| D1 | Warm-up of first lookups | Report note plus cycle 1 as its own card; the name pool is unchanged |
| D2 | CI secret scan | Keep the action; an admin adds `GITLEAKS_LICENSE` |
| D3 | Browser download for the report check | Not needed: the existing Chromium was used |
| D4 | New settings | `--port` (default 53) and a 10 s `--interval` floor |
