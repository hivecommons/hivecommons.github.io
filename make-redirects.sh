#!/usr/bin/env bash
# Generates GitHub Pages shortcut redirects (meta-refresh; GH Pages has no server 301s).
# Usage: edit the map below, run ./make-redirects.sh, commit.
#
# Every /<path> redirect that ships in this repo must have an entry here.
# This script is the only source of truth for these pages — do not hand-edit
# a redirect's index.html afterwards, or the next run of this script will
# silently discard the hand edit.
set -euo pipefail
declare -A MAP=(
  [tv]="https://youtube.com/@hivecommons|the Hive Commons YouTube channel"
  [youtube]="https://youtube.com/@hivecommons|the Hive Commons YouTube channel"
  [discord]="https://discord.gg/kQbCKGySvp|the Hive Commons Discord"
  [doc]="https://docs.hivecommons.dev|the Hive Commons docs"
  [docs]="https://docs.hivecommons.dev|the Hive Commons docs"
  [code]="https://github.com/hivecommons|the Hive Commons GitHub org"
  [github]="https://github.com/hivecommons|the Hive Commons GitHub org"
  [joinus]="https://groups.google.com/g/hivecommons-dev|the hivecommons-dev Google Group"
  [join_us]="https://groups.google.com/g/hivecommons-dev|the hivecommons-dev Google Group"
  [join]="https://groups.google.com/g/hivecommons-dev|the hivecommons-dev Google Group"
  [agenda]="https://docs.google.com/document/d/1eVJnPR4zua5ZhOqg-vVT-ndBpwXbPOdXar7AZqlqky0/edit?usp=sharing|the meeting agenda & notes"
  [calendar]="https://calendar.google.com/calendar/embed?src=b43dc28a888d316aa1fe4a47bf3038cd1bca7bbb2b5cdbf5e7ecb9cc10672a95%40group.calendar.google.com|the community calendar"
  [meet]="https://calendar.google.com/calendar/event?action=TEMPLATE&tmeid=MGU0cmRlbjZvbXZpZTljZTRqZWg5ZTJlbmMgYjQzZGMyOGE4ODhkMzE2YWExZmU0YTQ3YmYzMDM4Y2QxYmNhN2JiYjJiNWNkYmY1ZTdlY2I5Y2MxMDY3MmE5NUBn&tmsrc=b43dc28a888d316aa1fe4a47bf3038cd1bca7bbb2b5cdbf5e7ecb9cc10672a95%40group.calendar.google.com&scp=ALL|the meeting invite"
)
for path in "${!MAP[@]}"; do
  entry="${MAP[$path]}"
  url="${entry%%|*}"
  label="${entry#*|}"
  mkdir -p "$path"
  cat > "$path/index.html" <<HTML
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=$url">
<meta name="robots" content="noindex">
<link rel="canonical" href="$url"><title>Hive Commons — $label</title>
<style>body{font-family:system-ui;background:#14110b;color:#efe7d7;display:grid;place-items:center;height:100vh;margin:0}a{color:#e0a33a}</style>
</head><body><p>Redirecting to <a href="$url">$label</a>…</p></body></html>
HTML
  echo "/$path -> $url"
done
