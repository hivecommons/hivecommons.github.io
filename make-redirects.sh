#!/usr/bin/env bash
# Generates GitHub Pages shortcut redirects (meta-refresh; GH Pages has no server 301s).
# Usage: edit the map below, run ./make-redirects.sh, commit.
set -euo pipefail
declare -A MAP=(
  [tv]="https://youtube.com/@hivecommons"
  [youtube]="https://youtube.com/@hivecommons"
  [doc]="https://docs.hivecommons.dev"
  [docs]="https://docs.hivecommons.dev"
  [code]="https://github.com/hivecommons"
  [github]="https://github.com/hivecommons"
  [joinus]="https://github.com/hivecommons"
  [join_us]="https://github.com/hivecommons"
)
for path in "${!MAP[@]}"; do
  url="${MAP[$path]}"
  mkdir -p "$path"
  cat > "$path/index.html" <<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hive Commons — redirecting…</title>
<meta http-equiv="refresh" content="0; url=$url">
<link rel="canonical" href="$url">
<script>window.location.replace("$url");</script>
</head>
<body>
<p>Redirecting to <a href="$url">$url</a>…</p>
</body>
</html>
HTML
  echo "/$path -> $url"
done
