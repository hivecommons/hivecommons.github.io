#!/usr/bin/env bash
# Verifies the committed shortcut-redirect pages match what make-redirects.sh
# generates, so a hand-edited redirect or a MAP change committed without a
# regeneration run fails CI instead of drifting silently.
#
# Checks:
#   1. Every <path>/index.html that contains a meta-refresh redirect is an entry
#      in the script's MAP (no untracked redirect pages).
#   2. Every MAP entry has a committed <path>/index.html.
#   3. Each committed redirect page is byte-identical to a fresh generation.
#
# Usage: scripts/check-redirects.sh            (exit 1 on any drift)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="$ROOT/make-redirects.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

errors=0

if [[ ! -x "$GEN" ]]; then
  echo "ERROR make-redirects.sh missing or not executable at $GEN"
  exit 1
fi

# Regenerate into a scratch copy so the working tree is never touched.
cp "$GEN" "$WORK/make-redirects.sh"
(cd "$WORK" && ./make-redirects.sh >/dev/null) || {
  echo "ERROR make-redirects.sh failed to run"
  exit 1
}

mapfile -t map_paths < <(cd "$WORK" && find . -mindepth 2 -maxdepth 2 -name index.html -printf '%h\n' | sed 's#^\./##' | sort)

mapfile -t committed_redirects < <(
  cd "$ROOT" && find . -mindepth 2 -maxdepth 2 -name index.html \
    -not -path './.git/*' -not -path "./scripts/*" -not -path './.github/*' \
    -not -path './node_modules/*' -print |
    while IFS= read -r f; do
      if grep -Eqi '<meta[^>]+http-equiv[[:space:]]*=[[:space:]]*"refresh"' "$f"; then
        dirname "${f#./}"
      fi
    done | sort
)

for p in "${committed_redirects[@]}"; do
  if [[ ! -f "$WORK/$p/index.html" ]]; then
    echo "ERROR redirect page not in make-redirects.sh MAP: $p/index.html"
    ((errors++))
  fi
done

for p in "${map_paths[@]}"; do
  if [[ ! -f "$ROOT/$p/index.html" ]]; then
    echo "ERROR MAP entry has no committed page: $p/index.html (run ./make-redirects.sh and commit)"
    ((errors++))
    continue
  fi
  if ! cmp -s "$WORK/$p/index.html" "$ROOT/$p/index.html"; then
    echo "ERROR redirect page drifted from generator: $p/index.html (run ./make-redirects.sh and commit)"
    diff -u "$ROOT/$p/index.html" "$WORK/$p/index.html" | sed 's/^/    /' | head -20
    ((errors++))
  fi
done

echo "Checked ${#map_paths[@]} MAP entries and ${#committed_redirects[@]} committed redirect pages. Errors: $errors."
(( errors == 0 ))
