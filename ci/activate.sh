#!/usr/bin/env bash
#
# Move the GitHub Actions workflow to the path GitHub actually reads.
#
# The workflow ships at ci/github-actions-ci.yml because the automation account
# that pushed this branch is a GitHub App without the `workflows` permission,
# and GitHub rejects ANY push whose diff touches .github/workflows/ — which
# blocks the whole branch, not just that one file.
#
# Run this from a human account (or any token with the `workflows` scope):
#
#   ./ci/activate.sh && git push
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

SRC="ci/github-actions-ci.yml"
DEST=".github/workflows/ci.yml"

if [[ -f "$DEST" ]]; then
  echo "Already active: $DEST exists. Nothing to do."
  exit 0
fi

if [[ ! -f "$SRC" ]]; then
  echo "error: $SRC not found. Are you in the right repository?" >&2
  exit 1
fi

mkdir -p .github/workflows
git mv "$SRC" "$DEST"

# The README points at the parked location; correct it now that it has moved.
if [[ -f README.md ]]; then
  python3 - <<'PY'
from pathlib import Path

readme = Path("README.md")
text = readme.read_text()

old = """The pipeline is **[`ci/github-actions-ci.yml`](ci/github-actions-ci.yml)**. It is
parked outside `.github/workflows/` because the bot account that pushed this
branch lacks GitHub's `workflows` permission and the push is rejected
otherwise; one `git mv` activates it, see [ci/README.md](ci/README.md). It
runs:"""

new = """`.github/workflows/ci.yml` runs on every push:"""

if old in text:
    readme.write_text(text.replace(old, new))
    print("  updated README.md")
PY
  git add README.md
fi

git add -A

cat <<'EOF'

Workflow activated.

  ci/github-actions-ci.yml  ->  .github/workflows/ci.yml

Next:

  git commit -m "ci: activate GitHub Actions pipeline"
  git push

The workflow file itself is unchanged — it was always path-independent.
EOF
