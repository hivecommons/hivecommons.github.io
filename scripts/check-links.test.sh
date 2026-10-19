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

echo "case: single-quoted and unquoted href/src are checked; ?src= and empty href are not"
root="$(new_site quoting-forms)"
cat > "$root/index.html" <<'HTML'
<a href='/single-missing'>single</a>
<a href=/unquoted-missing>unquoted</a>
<img src='/img-missing.png'>
<iframe src="https://example.test/embed?src=/query-missing"></iframe>
<a href="">empty</a>
<a href="/">root</a>
HTML
run_checker "$root"
expect_rc 1 "broken single-quoted/unquoted links fail the gate"
expect_out 'ERROR internal target missing: index\.html -> /single-missing$' "single-quoted href is checked"
expect_out 'ERROR internal target missing: index\.html -> /unquoted-missing$' "unquoted href is checked"
expect_out 'ERROR internal target missing: index\.html -> /img-missing\.png$' "single-quoted src is checked"
expect_no_out 'query-missing' "?src= inside a URL is not an attribute"
expect_out 'Internal errors: 3\.' "empty href is skipped"

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

echo "case: .well-known/security.txt URI fields are checked (RFC 9116 Contact/Canonical/Policy/Acknowledgments/Hiring)"
root="$(new_site security-txt)"
echo '<p>home</p>' > "$root/index.html"
mkdir -p "$root/.well-known"
cat > "$root/.well-known/security.txt" <<'TXT'
# A comment mentioning https://example.test/broken-comment must be ignored
Contact: mailto:security@example.test
Contact: https://example.test/broken
Expires: 2027-01-01T00:00:00.000Z
Preferred-Languages: en
Canonical: https://hivecommons.dev/.well-known/security.txt
Policy: https://example.test/fine
Acknowledgments: https://example.test/soft404
Hiring: https://example.test/server-error
TXT
run_checker "$root"
expect_rc 1 "rotten security.txt URIs fail the gate"
expect_out 'ERROR external broken: \.well-known/security\.txt -> https://example\.test/broken \(404' "https Contact is probed and attributed to security.txt"
expect_out 'ERROR external soft-404: \.well-known/security\.txt -> https://example\.test/soft404 \(200' "Acknowledgments is probed"
expect_out 'ERROR external broken: \.well-known/security\.txt -> https://example\.test/server-error \(500' "Hiring is probed"
expect_no_out 'broken-comment' "comment lines are not harvested"
expect_no_out 'mailto' "mailto: Contact is skipped, not flagged"
expect_no_out 'internal target missing' "Canonical resolves to the committed security.txt"
expect_out 'External failures: 3\.' "Policy that resolves is not counted"

echo "case: security.txt Canonical pointing at a path the tree does not publish is an internal error"
root="$(new_site security-canonical)"
echo '<p>home</p>' > "$root/index.html"
mkdir -p "$root/.well-known"
printf 'Contact: mailto:security@example.test\nCanonical: https://hivecommons.dev/.well-known/other.txt\n' > "$root/.well-known/security.txt"
run_checker "$root" --external-warn
expect_rc 1 "unpublished Canonical fails even under --external-warn"
expect_out 'ERROR internal target missing: \.well-known/security\.txt -> https://hivecommons\.dev/\.well-known/other\.txt' "Canonical is resolved against the tree like any site URL"

echo "case: a site without security.txt is unaffected"
root="$(new_site no-security-txt)"
echo '<a href="/">home</a>' > "$root/index.html"
run_checker "$root"
expect_rc 0 "no security.txt, no extra links"
expect_out 'Checked 1 unique links\.' "only the page link is counted"

echo "case: llms.txt URLs are checked"
root="$(new_site llms-txt)"
echo '<p>home</p>' > "$root/index.html"
cat > "$root/llms.txt" <<'TXT'
# Hive Commons

- [Thing](https://example.test/broken): text
- Docs: https://example.test/broken-period.
- Site (https://example.test/soft404)
- Ends with comma https://example.test/server-error,
- Home: https://hivecommons.dev/
TXT
run_checker "$root"
expect_rc 1 "rotten llms.txt URLs fail the gate"
expect_out 'ERROR external broken: llms\.txt -> https://example\.test/broken \(404' "Markdown link is probed, attributed to llms.txt, closing paren not captured"
expect_out 'ERROR external soft-404: llms\.txt -> https://example\.test/soft404 \(200' "parenthesised URL is probed"
expect_out 'ERROR external broken: llms\.txt -> https://example\.test/server-error \(500' "trailing comma is stripped"
expect_out 'ERROR external broken: llms\.txt -> https://example\.test/broken-period \(404' "trailing period is stripped"
expect_no_out 'broken-period\.' "URL is not reported with its trailing period"
expect_no_out 'internal target missing' "site-origin URL resolves against the tree"
expect_out 'External failures: 4\.' "only the four rotten URLs count"

echo "case: a site without llms.txt is unaffected"
root="$(new_site no-llms-txt)"
echo '<a href="/">home</a>' > "$root/index.html"
run_checker "$root"
expect_rc 0 "no llms.txt, no extra links"
expect_out 'Checked 1 unique links\.' "only the page link is counted"

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

echo "case: document-relative links resolve against the source file's directory"
root="$(new_site relative-ok)"
mkdir -p "$root/sub" "$root/other"
printf '<a href="page.html">p</a><a href="./page.html#top">p2</a><a href="sub/">s</a><img src="logo.png?v=1">' > "$root/index.html"
printf '<a href="../index.html">up</a><a href="../other/#id">o</a><a href="sibling.html">s</a>' > "$root/sub/index.html"
echo '<p>sib</p>' > "$root/sub/sibling.html"
echo '<h1 id="top">t</h1>' > "$root/page.html"
echo '<p id="id">o</p>' > "$root/other/index.html"
: > "$root/logo.png"
run_checker "$root"
expect_rc 0 "existing relative targets pass"
expect_no_out 'ERROR' "no errors for resolvable relative links"
expect_no_out 'unsupported URL' "relative links are no longer unsupported"

echo "case: missing document-relative target is reported"
root="$(new_site relative-missing)"
echo '<a href="missing.html">x</a>' > "$root/index.html"
run_checker "$root"
expect_rc 1 "missing relative target fails"
expect_out 'ERROR internal target missing: index\.html -> missing\.html' "names source and relative url"

echo "case: relative links from a subdirectory page with missing anchor or escaping the root"
root="$(new_site relative-sub)"
mkdir -p "$root/sub" "$root/other"
echo '<a href="/">home</a>' > "$root/index.html"
printf '<a href="../other/#ghost">a</a><a href="../../escape.html">b</a>' > "$root/sub/index.html"
echo '<p id="id">o</p>' > "$root/other/index.html"
run_checker "$root"
expect_rc 1 "bad subdirectory relative links fail"
expect_out 'ERROR internal anchor missing: sub/index\.html -> \.\./other/#ghost' "anchor resolved through .."
expect_out 'ERROR internal target missing: sub/index\.html -> \.\./\.\./escape\.html' "climbing above the root is missing"

echo "case: protocol-relative URLs are external, not internal"
root="$(new_site protocol-relative)"
echo '<a href="//example.test/x">x</a>' > "$root/index.html"
run_checker "$root"
expect_rc 0 "protocol-relative URL is probed over https"
expect_no_out 'internal target missing' "//host is not treated as a root-absolute path"
expect_no_out 'unsupported URL' "//host is not unsupported"

echo "case: duplicate links are checked once"
root="$(new_site dedup)"
printf '<a href="/a.html">1</a><a href="/a.html">2</a><a href="/a.html">3</a>' > "$root/index.html"
echo ok > "$root/a.html"
run_checker "$root"
expect_rc 0 "dedup site passes"
expect_out 'Checked 1 unique links\.' "three identical links counted once"

echo "case: result does not depend on the caller's cwd"
root="$(new_site other-cwd)"
echo '<a href="/nope">x</a>' > "$root/index.html"
OUT="$(cd "$TMP" && PATH="$TMP/bin:$PATH" bash "$root/scripts/check-links.sh" 2>&1)"; RC=$?
expect_rc 1 "broken link still fails when run from another directory"
expect_out 'ERROR internal target missing: index\.html -> /nope' "page links are extracted from outside the root"
expect_no_out 'No such file' "no grep path errors"

echo "case: HTML entities in URLs are decoded before probing"
root="$(new_site entities)"
echo '<a href="https://example.test/e?a=1&amp;broken">x</a><a href="/page.html?x=1&amp;y=2#frag">y</a>' > "$root/index.html"
echo '<p id="frag">p</p>' > "$root/page.html"
run_checker "$root"
expect_rc 1 "broken external link behind &amp; fails"
expect_out 'index\.html -> https://example\.test/e\?a=1&broken \(404' "href &amp; is decoded to & before probing"
expect_no_out '&amp;' "no literal &amp; reaches the probe"
expect_no_out 'internal' "internal link with &amp; query and anchor resolves"

echo "case: meta-refresh URL keeps ';' from &amp; and is decoded"
root="$(new_site meta-entities)"
mkdir -p "$root/go"
echo '<a href="/go/">go</a>' > "$root/index.html"
cat > "$root/go/index.html" <<'HTML'
<meta http-equiv="refresh" content="0; url=https://example.test/m?a=1&amp;b=2&amp;broken">
HTML
run_checker "$root"
expect_rc 1 "broken meta-refresh target behind &amp; fails"
expect_out 'go/index\.html -> https://example\.test/m\?a=1&b=2&broken \(404' "full URL extracted, not truncated at &amp"

echo "case: og:image meta URL pointing at a missing internal file is reported"
root="$(new_site og-image)"
cat > "$root/index.html" <<'HTML'
<meta property="og:image" content="https://hivecommons.dev/assets/missing-og.png">
<meta name="twitter:image" content="https://hivecommons.dev/index.html">
<meta property="og:image:width" content="https://hivecommons.dev/assets/not-a-meta-image.png">
HTML
run_checker "$root"
expect_rc 1 "missing og:image target fails"
expect_out 'ERROR internal target missing: index\.html -> https://hivecommons\.dev/assets/missing-og\.png' "og:image is resolved against the tree"
expect_out 'Internal errors: 1\.' "resolvable twitter:image is not flagged and og:image:width is not treated as og:image"

echo "case: single-quoted and root-relative og/twitter image values are checked"
root="$(new_site og-quoting)"
cat > "$root/index.html" <<'HTML'
<meta property='og:image' content='https://hivecommons.dev/assets/missing-single-quoted.png'>
<meta name="twitter:image" content="/assets/missing-root-relative.png">
<meta property="og:url" content=https://hivecommons.dev/missing-unquoted/>
<meta property="og:image:alt" content="/assets/not-a-link.png">
HTML
run_checker "$root"
expect_rc 1 "missing og/twitter targets fail regardless of quoting"
expect_out 'ERROR internal target missing: index\.html -> https://hivecommons\.dev/assets/missing-single-quoted\.png' "single-quoted og:image is checked"
expect_out 'ERROR internal target missing: index\.html -> /assets/missing-root-relative\.png' "root-relative twitter:image is resolved against the tree"
expect_out 'ERROR internal target missing: index\.html -> https://hivecommons\.dev/missing-unquoted/' "unquoted og:url is checked"
expect_out 'Internal errors: 3\.' "og:image:alt is not treated as a link"

echo "case: JSON-LD logo pointing at a missing internal file is reported"
root="$(new_site jsonld-logo)"
cat > "$root/index.html" <<'HTML'
<script type="application/ld+json">
{"@type": "Organization", "name": "Hive", "logo": "https://hivecommons.dev/assets/missing-logo.png"}
</script>
HTML
run_checker "$root"
expect_rc 1 "missing JSON-LD logo target fails"
expect_out 'ERROR internal target missing: index\.html -> https://hivecommons\.dev/assets/missing-logo\.png' "JSON-LD logo is resolved against the tree"

echo "case: single-line JSON-LD does not bleed into a following script block"
root="$(new_site jsonld-oneline)"
cat > "$root/index.html" <<'HTML'
<script type="application/ld+json">{"url":"https://hivecommons.dev/","logo":"https://hivecommons.dev/missing-logo.png"}</script>
<script>var cfg={"url":"https://hivecommons.dev/not-jsonld"};</script>
HTML
run_checker "$root"
expect_rc 1 "missing single-line JSON-LD logo fails"
expect_out 'ERROR internal target missing: index\.html -> https://hivecommons\.dev/missing-logo\.png' "single-line JSON-LD logo is checked"
expect_out 'Internal errors: 1\.' "URL in the following inline script is not probed"

echo "case: every JSON-LD block on a page is checked, not only the last"
root="$(new_site jsonld-multi)"
cat > "$root/index.html" <<'HTML'
<script type="application/ld+json">{"@type":"Organization","logo":"https://hivecommons.dev/first-missing.png"}</script>
<p>between</p>
<script type="application/ld+json">
{"@type":"WebSite","url":"https://hivecommons.dev/second-missing/"}
</script>
HTML
run_checker "$root"
expect_rc 1 "missing targets in both JSON-LD blocks fail"
expect_out 'ERROR internal target missing: index\.html -> https://hivecommons\.dev/first-missing\.png' "first JSON-LD block is checked"
expect_out 'ERROR internal target missing: index\.html -> https://hivecommons\.dev/second-missing/' "second JSON-LD block is checked"
expect_out 'Internal errors: 2\.' "both blocks counted"

echo "case: a site with no links to check fails closed"
root="$(new_site empty)"
run_checker "$root"
expect_rc 1 "no pages/links is an error, not a pass"
expect_out 'no links found' "explains why"

echo
echo "check-links self-test: $passes passed, $failures failed"
(( failures == 0 ))
