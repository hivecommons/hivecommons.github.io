#!/usr/bin/env bash
# Self-test for scripts/check-links.sh against throwaway fixture sites.
#
# Each case builds a tiny site under a temp dir, copies the checker next to it
# (the checker derives its site root from its own location), and runs it with a
# fake `curl` on PATH so no network is needed. Usage: scripts/check-links.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$HERE/check-links.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
passes=0

pass() { echo "  ok: $1"; ((passes++)); }
fail() { echo "  FAIL: $1"; ((failures++)); }

# Fake curl: status/body are chosen from the requested URL so cases can pick
# the external outcome they want without touching the network.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
out=""; url=""
while (( $# )); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -A|-w|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *broken*) code=404; body="gone" ;;
  *server-error*) code=500; body="boom" ;;
  *soft404*) code=200; body="<h1>Page Not Found</h1>" ;;
  *unreachable*) exit 7 ;;
  *) code=200; body="<p>fine</p>" ;;
esac
[[ -n "$out" ]] && printf '%s' "$body" > "$out"
printf '%s %s' "$code" "$url"
SH
chmod +x "$TMP/bin/curl"

# new_site NAME -> prints the fixture root; caller populates it with files.
new_site() {
  local root="$TMP/$1"
  mkdir -p "$root/scripts"
  cp "$CHECKER" "$root/scripts/check-links.sh"
  printf '%s\n' "$root"
}

# run_checker ROOT [flags...] -> sets OUT and RC
run_checker() {
  local root="$1"; shift
  OUT="$(cd "$root" && PATH="$TMP/bin:$PATH" bash scripts/check-links.sh "$@" 2>&1)"
  RC=$?
}

expect_rc() { # expect_rc WANT LABEL
  if [[ "$RC" == "$1" ]]; then pass "$2 (exit $RC)"; else fail "$2 (want exit $1, got $RC)"; echo "$OUT" | sed 's/^/    | /'; fi
}
expect_out() { # expect_out REGEX LABEL
  if grep -Eq -- "$1" <<<"$OUT"; then pass "$2"; else fail "$2 (no match for: $1)"; echo "$OUT" | sed 's/^/    | /'; fi
}
expect_no_out() { # expect_no_out REGEX LABEL
  if grep -Eq -- "$1" <<<"$OUT"; then fail "$2 (unexpected match for: $1)"; echo "$OUT" | sed 's/^/    | /'; else pass "$2"; fi
}

echo "case: clean site with every internal link form resolving"
root="$(new_site clean)"
mkdir -p "$root/sub" "$root/deep/er"
cat > "$root/index.html" <<'HTML'
<a href="/">root</a>
<a href="/sub/">dir with slash</a>
<a href="/sub">dir without slash</a>
<a href="/page">extensionless -> page.html</a>
<a href="/page.html#top">anchor via id</a>
<a href="/page.html#named">anchor via name attr</a>
<a href="#local">same-page anchor</a>
<a href="https://hivecommons.dev/sub/">site-absolute</a>
<a href="https://www.hivecommons.dev/page?x=1">site-absolute with query</a>
<a href="mailto:hi@example.test">mail</a>
<a href="tel:+100">tel</a>
<a href="javascript:void(0)">js</a>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com">
<img src="/deep/er/pic.png">
<p id="local">x</p>
HTML
echo '<p>sub</p>' > "$root/sub/index.html"
printf '<h1 id="top">t</h1><a name="named"></a>' > "$root/page.html"
: > "$root/deep/er/pic.png"
run_checker "$root"
expect_rc 0 "clean site passes"
expect_out 'Internal errors: 0\. External failures: 0\.' "summary reports zero errors"
expect_no_out 'unsupported URL' "mailto/tel/javascript are skipped, not flagged"

echo "case: missing internal target is reported"
root="$(new_site missing-target)"
echo '<a href="/nope">x</a>' > "$root/index.html"
run_checker "$root"
expect_rc 1 "missing target fails"
expect_out 'ERROR internal target missing: index\.html -> /nope' "names source and target"

echo "case: missing anchors are reported (same-page and cross-page)"
root="$(new_site missing-anchor)"
printf '<a href="#ghost">a</a><a href="/other.html#phantom">b</a>' > "$root/index.html"
echo '<p id="real">o</p>' > "$root/other.html"
run_checker "$root"
expect_rc 1 "missing anchors fail"
expect_out 'ERROR internal anchor missing: index\.html -> #ghost' "same-page anchor"
expect_out 'ERROR internal anchor missing: index\.html -> /other\.html#phantom' "cross-page anchor"
expect_out 'Internal errors: 2\.' "both counted"

echo "case: site-absolute hivecommons.dev URLs are checked as internal paths"
root="$(new_site site-absolute)"
echo '<a href="https://hivecommons.dev/missing-page">x</a>' > "$root/index.html"
run_checker "$root"
expect_rc 1 "site-absolute URL to missing page fails"
expect_out 'internal target missing: index\.html -> https://hivecommons\.dev/missing-page' "reported as internal, not fetched"

echo "case: meta-refresh redirect targets are extracted and checked"
root="$(new_site meta-refresh)"
mkdir -p "$root/go"
echo '<a href="/go/">go</a>' > "$root/index.html"
cat > "$root/go/index.html" <<'HTML'
<meta http-equiv="refresh" content="0; url=/does-not-exist">
HTML
run_checker "$root"
expect_rc 1 "redirect to missing internal page fails"
expect_out 'internal target missing: go/index\.html -> /does-not-exist' "meta-refresh url attributed to the redirect page"

echo "case: make-redirects.sh MAP targets are checked (url|label format)"
root="$(new_site redirect-map)"
echo '<p>home</p>' > "$root/index.html"
cat > "$root/make-redirects.sh" <<'SH'
declare -A MAP=(
  [ok]="https://example.test/fine|a fine label"
  [bad]="https://example.test/broken|a broken label"
)
SH
run_checker "$root"
expect_rc 1 "broken MAP target fails"
expect_out 'ERROR external broken: make-redirects\.sh -> https://example\.test/broken \(404' "url half of url|label is checked and attributed to the script"
expect_no_out 'label' "label half is not treated as a URL"
expect_out 'External failures: 1\.' "only the broken target counts"

echo "case: external failures — hard 404, 5xx, curl failure, soft-404"
root="$(new_site external)"
cat > "$root/index.html" <<'HTML'
<a href="https://example.test/broken">404</a>
<a href="https://example.test/server-error">500</a>
<a href="https://example.test/unreachable">curl exit</a>
<a href="https://example.test/soft404">soft</a>
<a href="https://example.test/fine">fine</a>
HTML
run_checker "$root"
expect_rc 1 "external failures fail without --external-warn"
expect_out 'ERROR external broken: index\.html -> https://example\.test/broken \(404' "404 is ERROR"
expect_out 'ERROR external broken: .*server-error \(500' "5xx is ERROR"
expect_out 'ERROR external broken: .*unreachable \(000 curl_failed\)' "curl failure is ERROR with 000"
expect_out 'ERROR external soft-404: .*soft404 \(200' "soft-404 body is ERROR despite 200"
expect_out 'External failures: 4\.' "four external failures, fine URL not counted"

run_checker "$root" --external-warn
expect_rc 0 "--external-warn downgrades external failures to exit 0"
expect_out 'WARN external broken: .*broken' "404 becomes WARN"
expect_out 'WARN external soft-404: .*soft404' "soft-404 becomes WARN"
expect_no_out '^ERROR' "no ERROR lines under --external-warn"

echo "case: internal errors still fail under --external-warn"
root="$(new_site warn-internal)"
echo '<a href="/nope">x</a><a href="https://example.test/broken">y</a>' > "$root/index.html"
run_checker "$root" --external-warn
expect_rc 1 "internal error wins over --external-warn"
expect_out 'ERROR internal target missing' "internal error stays ERROR"
expect_out 'WARN external broken' "external stays WARN"

echo "case: unsupported URL schemes are warned but do not fail"
root="$(new_site unsupported)"
echo '<a href="ftp://example.test/file">ftp</a>' > "$root/index.html"
run_checker "$root"
expect_rc 0 "unsupported scheme does not fail"
expect_out 'WARN unsupported URL: index\.html -> ftp://example\.test/file' "unsupported scheme is warned"

echo "case: duplicate links are checked once"
root="$(new_site dedup)"
printf '<a href="/a.html">1</a><a href="/a.html">2</a><a href="/a.html">3</a>' > "$root/index.html"
echo ok > "$root/a.html"
run_checker "$root"
expect_rc 0 "dedup site passes"
expect_out 'Checked 1 unique links\.' "three identical links counted once"

echo
echo "check-links self-test: $passes passed, $failures failed"
(( failures == 0 ))
