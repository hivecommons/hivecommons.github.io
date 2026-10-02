#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$ROOT/.linkcheck-work"
USER_AGENT="hivecommons-link-checker/1.0 (+https://hivecommons.dev)"
EXTERNAL_WARN=0

if [[ "${1:-}" == "--external-warn" ]]; then
  EXTERNAL_WARN=1
fi

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/bodies"
trap 'rm -rf "$WORK_DIR"' EXIT

SOFT_404_RE="Page Not Found|>404<|doesn't exist or has moved"

html_file_for_path() {
  local raw="${1%%\?*}"
  raw="${raw%/}"
  raw="${raw#/}"
  if [[ -z "$raw" ]]; then
    printf '%s\n' "$ROOT/index.html"
    return
  fi
  if [[ -f "$ROOT/$raw" ]]; then
    printf '%s\n' "$ROOT/$raw"
  elif [[ -f "$ROOT/$raw/index.html" ]]; then
    printf '%s\n' "$ROOT/$raw/index.html"
  elif [[ -f "$ROOT/$raw.html" ]]; then
    printf '%s\n' "$ROOT/$raw.html"
  else
    printf '%s\n' "$ROOT/$raw"
  fi
}

has_id() {
  local file="$1"
  local id="$2"
  [[ -f "$file" ]] || return 1
  grep -Eq "id=[\"']${id//\//\\/}[\"']|name=[\"']${id//\//\\/}[\"']" "$file"
}

is_site_url() {
  [[ "$1" =~ ^https?://(www\.)?hivecommons\.dev(/|$) ]]
}

normalize_internal_path() {
  local url="$1"
  if is_site_url "$url"; then
    url="${url#http://hivecommons.dev}"
    url="${url#https://hivecommons.dev}"
    url="${url#http://www.hivecommons.dev}"
    url="${url#https://www.hivecommons.dev}"
  fi
  printf '%s\n' "$url"
}

extract_html_links() {
  local file="$1"
  grep -Eoi '(href|src)[[:space:]]*=[[:space:]]*"[^"]+"' "$file" |
    sed -E 's/^[^=]+=[[:space:]]*"([^"]+)"/\1/' |
    awk -v file="$file" '{ print file "\t" $0 }'

  grep -Eoi '<meta[^>]+http-equiv[[:space:]]*=[[:space:]]*"refresh"[^>]*>' "$file" |
    sed -En 's/.*content[[:space:]]*=[[:space:]]*"[^"]*[Uu][Rr][Ll][[:space:]]*=[[:space:]]*([^";]+).*/\1/p' |
    awk -v file="$file" '{ print file "\t" $0 }'
}

extract_redirect_targets() {
  local redirects="$ROOT/make-redirects.sh"
  [[ -f "$redirects" ]] || return 0
  awk -F'"' '/^[[:space:]]*\[[^]]+\]="/ { split($2, parts, "|"); print "make-redirects.sh\t" parts[1] }' "$redirects"
}

find "$ROOT" -name '*.html' -not -path "$WORK_DIR/*" -print | sort |
  while IFS= read -r file; do
    rel="${file#$ROOT/}"
    extract_html_links "$rel"
  done > "$WORK_DIR/links.tsv"
extract_redirect_targets >> "$WORK_DIR/links.tsv"

sort -u "$WORK_DIR/links.tsv" > "$WORK_DIR/links.dedup.tsv"

internal_errors=0
external_errors=0
checked=0

while IFS=$'\t' read -r source url; do
  [[ -n "${url:-}" ]] || continue
  [[ "$url" =~ ^(mailto:|tel:|javascript:) ]] && continue
  ((checked++))

  if [[ "$url" == \#* ]]; then
    id="${url#\#}"
    if ! has_id "$ROOT/$source" "$id"; then
      echo "ERROR internal anchor missing: $source -> $url"
      ((internal_errors++))
    fi
    continue
  fi

  if [[ "$url" == /* ]] || is_site_url "$url"; then
    local_url="$(normalize_internal_path "$url")"
    path_part="${local_url%%#*}"
    anchor=""
    if [[ "$local_url" == *#* ]]; then
      anchor="${local_url#*#}"
    fi
    target="$(html_file_for_path "$path_part")"
    if [[ ! -f "$target" ]]; then
      echo "ERROR internal target missing: $source -> $url"
      ((internal_errors++))
      continue
    fi
    if [[ -n "$anchor" ]] && ! has_id "$target" "$anchor"; then
      echo "ERROR internal anchor missing: $source -> $url"
      ((internal_errors++))
    fi
    continue
  fi

  if [[ "$url" =~ ^https?:// ]]; then
    if [[ "$url" == "https://fonts.googleapis.com" || "$url" == "https://fonts.gstatic.com" ]]; then
      continue
    fi
    body="$WORK_DIR/bodies/$(printf '%s' "$url" | shasum | awk '{print $1}')"
    result="$(curl -sL --max-time 15 -A "$USER_AGENT" -o "$body" -w '%{http_code} %{url_effective}' "$url" 2>/dev/null || printf '000 curl_failed')"
    code="${result%% *}"
    effective="${result#* }"
    soft=0
    if grep -Eq "$SOFT_404_RE" "$body"; then
      soft=1
    fi
    if [[ "$code" == "000" || "$code" == "404" || "$code" == "410" || "$code" =~ ^5 || "$soft" == "1" ]]; then
      level="WARN"
      ((external_errors++))
      if [[ "$EXTERNAL_WARN" == "0" ]]; then
        level="ERROR"
      fi
      if [[ "$soft" == "1" ]]; then
        echo "$level external soft-404: $source -> $url ($code $effective)"
      else
        echo "$level external broken: $source -> $url ($code $effective)"
      fi
    fi
    continue
  fi

  echo "WARN unsupported URL: $source -> $url"
done < "$WORK_DIR/links.dedup.tsv"

echo "Checked $checked unique links. Internal errors: $internal_errors. External failures: $external_errors."

if (( internal_errors > 0 )); then
  exit 1
fi
if (( external_errors > 0 && EXTERNAL_WARN == 0 )); then
  exit 1
fi
