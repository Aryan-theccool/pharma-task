# CI pipeline

The GitHub Actions workflow lives here as **`github-actions-ci.yml`** rather
than at `.github/workflows/ci.yml`.

## Why it is parked here

The automation account that pushed this branch authenticates as a GitHub App
without the `workflows` permission. GitHub rejects any push whose diff creates
or modifies a file under `.github/workflows/`:

```
! [remote rejected] refusing to allow a GitHub App to create or update
  workflow `.github/workflows/ci.yml` without `workflows` permission
```

Keeping the file at its real path would have blocked the entire branch from
being pushed. The pipeline is complete and reviewable as code; it simply needs
one `git mv` by a human to become active.

## Activating it

```bash
./ci/activate.sh
git commit -m "ci: activate GitHub Actions pipeline"
git push
```

The script moves the file, fixes the paragraph in the README that points at
the parked location, and is safe to re-run (it no-ops if the workflow is
already active). Or do it by hand:

```bash
mkdir -p .github/workflows
git mv ci/github-actions-ci.yml .github/workflows/ci.yml
```

No edits to the workflow are required — it is unmodified and path-independent.

## What it runs

| Job | Does |
| --- | --- |
| `static-analysis` | `format:check`, `lint` with `--max-warnings 0`, `typecheck` |
| `unit-tests` | Fast pure-logic suite |
| `integration-tests` | PostgreSQL 16 + Redis 7 service containers, migrations, `test:cov`, coverage floor via `scripts/check-coverage.js`, coverage artifact |
| `openapi` | Regenerates `docs/openapi.json` and runs `git diff --exit-code` — the spec cannot drift from the code |
| `security` | `npm audit --audit-level=high`, gitleaks, CodeQL |
| `docker` | buildx image build, Trivy vulnerability scan, container boot + SIGTERM drain smoke test |

Concurrency is set to cancel superseded runs per ref.

## Running the same checks locally

```bash
npm run format:check && npm run lint && npm run typecheck
npm run test:cov && node scripts/check-coverage.js
npm run openapi:generate && git diff --exit-code docs/openapi.json
```
