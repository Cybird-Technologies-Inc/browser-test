# browser-test

Playwright (Chromium) page-load timer. It measures DNS, TTFB and load time per
request, so a DNS resolver can be load-tested and monitored.

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
