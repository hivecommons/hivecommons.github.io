# Runbook: the live-site availability probe is failing

The **Link check** workflow (`.github/workflows/links.yml`) runs its `availability`
job on a 6-hour schedule and on manual dispatch. It requests the live homepage,
`/stories/`, `/docs/`, `/llms.txt`, `/sitemap.xml`, `/robots.txt`, a sample of the shortcut redirects and `/404.html` over HTTPS and fails
unless every one returns HTTP 200. Use this runbook when that job is red and no recent
deploy explains it; for a bad commit, use the [rollback runbook](release-rollback.md).

## Who is affected

Every visitor to `https://hivecommons.dev/`, plus anyone following a shortcut redirect
or an LLM crawler reading `llms.txt`. A failure that persists across two consecutive
probe runs (about 12 hours) should be treated as an outage, not a blip.

## Triage

1. Read the failing step's log: the `::error::` line names the URL and the HTTP status.
   A connection or TLS error (no status) points at DNS, certificate or network; a
   `404` on one path points at content; a `404` or other error on every path points
   at Pages or the custom domain.
2. Re-run the probe to rule out a transient fault:
   `gh workflow run links.yml --repo hivecommons/hivecommons.github.io`
3. Check the site directly:
   - `curl -sI https://hivecommons.dev/` and `curl -sI https://hivecommons.dev/404.html`
   - `curl -sI https://hivecommons.github.io/` (the default Pages host) — if this
     works while the custom domain does not, the fault is DNS, certificate or `CNAME`.
4. Check platform status at <https://www.githubstatus.com/> for a Pages incident.

## Likely causes and fixes

| Symptom | Cause | Action |
|---------|-------|--------|
| All paths fail, default `*.github.io` host also fails | GitHub Pages incident or failed Pages build | Check `gh api repos/hivecommons/hivecommons.github.io/pages/builds/latest`; wait for GitHub, or push a forward fix if the build error is ours |
| Custom domain fails, default host works | `CNAME` missing or altered, DNS change, or expired/unprovisioned certificate | Confirm `CNAME` reads `hivecommons.dev`; review Settings → Pages for DNS or HTTPS warnings; re-save the custom domain to re-trigger certificate provisioning |
| One or two paths return 404 | Redirect page or top-level page removed or renamed | Fix the `MAP` in `make-redirects.sh` and re-run `./make-redirects.sh`; do not hand-edit generated redirect pages |
| A path returns 5xx or times out intermittently | Pages/CDN degradation | Re-run after a few minutes; escalate only if it persists |
| The probe URL list no longer matches the site | A probed page was intentionally removed | Update the list in the `availability` job and keep `scripts/availability-probes.test.mjs` passing; never drop a probe just to turn the job green |

## After

- Re-run the `availability` job via manual dispatch and confirm it passes.
- If visitors were affected for more than one probe interval, record it with the
  [postmortem template](postmortem-template.md).
