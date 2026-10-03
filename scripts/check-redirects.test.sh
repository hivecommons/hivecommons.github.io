#!/usr/bin/env bash
# Self-test for scripts/check-redirects.sh against throwaway fixture sites.
#
# Each case builds a tiny site under a temp dir with its own make-redirects.sh
# (same page template as the real one, smaller MAP), copies the gate next to it
# (the gate derives its site root from its own location), runs it, and checks
# the verdict. Usage: scripts/check-redirects.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/check-redirects.sh"
REAL_GEN="$HERE/../make-redirects.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
passes=0

pass() { echo "  ok: $1"; passes=$((passes + 1)); }
fail() { echo "  FAIL: $1"; failures=$((failures + 1)); }

# Fixture generator: the real script's body with a two-entry MAP, so the test
# exercises the same page template the site ships.
write_generator() {
  local dest="$1"
  {
    sed -n '1,/^declare -A MAP=(/p' "$REAL_GEN"
    cat <<'MAP'
  [tv]="https://example.test/tv|the test channel"
  [code]="https://example.test/code|the test code"
)
MAP
    sed -n '/^)$/,$p' "$REAL_GEN" | sed '1d'
  } > "$dest"
  chmod +x "$dest"
}

# new_site NAME -> prints a fixture root with generator, gate, and generated pages.
new_site() {
  local root="$TMP/$1"
  mkdir -p "$root/scripts"
  cp "$GATE" "$root/scripts/check-redirects.sh"
  write_generator "$root/make-redirects.sh"
  (cd "$root" && ./make-redirects.sh >/dev/null)
  printf '%s\n' "$root"
}

# run_gate ROOT -> sets OUT and RC
run_gate() {
  local root="$1"
  OUT="$(cd "$root" && bash scripts/check-redirects.sh 2>&1)"
  RC=$?
}

expect_rc() { # DESC WANT
  if [[ "$RC" == "$2" ]]; then pass "$1 (exit $2)"; else fail "$1: wanted exit $2, got $RC"; printf '%s\n' "$OUT" | sed 's/^/      /'; fi
}
expect_out() { # DESC PATTERN
  if grep -Eq -- "$2" <<<"$OUT"; then pass "$1"; else fail "$1: output lacks /$2/"; printf '%s\n' "$OUT" | sed 's/^/      /'; fi
}
expect_not_out() { # DESC PATTERN
  if grep -Eq -- "$2" <<<"$OUT"; then fail "$1: output unexpectedly matches /$2/"; printf '%s\n' "$OUT" | sed 's/^/      /'; else pass "$1"; fi
}

echo "case: fixture generator reproduces the real template"
root="$(new_site template)"
if grep -Fq 'http-equiv="refresh" content="0; url=https://example.test/tv"' "$root/tv/index.html"; then
  pass "generated page carries the meta-refresh"
else
  fail "fixture generator did not emit a meta-refresh page"
fi
if grep -Fq '<meta name="robots" content="noindex">' "$root/tv/index.html"; then
  pass "generated page is noindex"
else
  fail "fixture generator lost the noindex tag"
fi

echo "case: clean site passes"
root="$(new_site clean)"
mkdir -p "$root/stories" && printf '<!doctype html><title>stories</title>\n' > "$root/stories/index.html"
run_gate "$root"
expect_rc "clean site" 0
expect_out "reports counts" "Checked 2 MAP entries and 2 committed redirect pages\. Errors: 0\."
expect_not_out "no ERROR lines" "^ERROR"
if [[ "$(ls -A "$root/tv")" == "index.html" ]]; then
  pass "working tree untouched"
else
  fail "gate wrote into the working tree"
fi

echo "case: non-redirect nested pages are ignored"
root="$(new_site plain-page)"
mkdir -p "$root/about" && printf '<!doctype html><p>about, no refresh</p>\n' > "$root/about/index.html"
run_gate "$root"
expect_rc "plain nested index.html ignored" 0
expect_out "only redirect pages counted" "2 committed redirect pages"

echo "case: hand-edited redirect page is drift"
root="$(new_site hand-edit)"
sed -i 's#https://example.test/tv#https://example.test/tv-moved#' "$root/tv/index.html"
run_gate "$root"
expect_rc "hand edit fails" 1
expect_out "names the drifted page" "ERROR redirect page drifted from generator: tv/index\.html"
expect_out "shows a diff hint" "run \./make-redirects\.sh and commit"
expect_out "diff mentions the edited URL" "tv-moved"
expect_not_out "untouched sibling not flagged" "code/index\.html"
expect_out "error count" "Errors: 1\."

echo "case: redirect page not in MAP"
root="$(new_site untracked)"
mkdir -p "$root/rogue"
printf '<!doctype html><meta HTTP-EQUIV="Refresh" content="0; url=https://example.test/rogue">\n' > "$root/rogue/index.html"
run_gate "$root"
expect_rc "untracked redirect fails" 1
expect_out "names the untracked page (case-insensitive meta match)" "ERROR redirect page not in make-redirects\.sh MAP: rogue/index\.html"
expect_out "counts 3 committed redirect pages" "3 committed redirect pages"

echo "case: MAP entry with no committed page"
root="$(new_site missing-page)"
rm -r "$root/code"
run_gate "$root"
expect_rc "missing page fails" 1
expect_out "names the missing page" "ERROR MAP entry has no committed page: code/index\.html"
expect_not_out "does not also report drift for it" "drifted from generator: code"

echo "case: several drifts are all reported"
root="$(new_site multi)"
rm -r "$root/code"
printf '<!doctype html><meta http-equiv="refresh" content="0; url=x">\n' > "$root/tv/index.html"
run_gate "$root"
expect_rc "multiple errors fail" 1
expect_out "error count is 2" "Errors: 2\."

echo "case: generator missing"
root="$(new_site no-gen)"
rm "$root/make-redirects.sh"
run_gate "$root"
expect_rc "missing generator fails" 1
expect_out "explains" "ERROR make-redirects\.sh missing or not executable"

echo "case: generator not executable"
root="$(new_site noexec-gen)"
chmod -x "$root/make-redirects.sh"
run_gate "$root"
expect_rc "non-executable generator fails" 1
expect_out "explains" "missing or not executable"

echo "case: generator crashes"
root="$(new_site crash-gen)"
printf '#!/usr/bin/env bash\nexit 3\n' > "$root/make-redirects.sh"
run_gate "$root"
expect_rc "crashing generator fails" 1
expect_out "explains" "ERROR make-redirects\.sh failed to run"

echo
echo "check-redirects self-test: $passes passed, $failures failed"
(( failures == 0 ))
