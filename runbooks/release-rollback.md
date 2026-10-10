# Runbook: rolling back a bad hivecommons.dev deploy

GitHub Pages publishes directly from the configured branch on every push to
`main` — there is no staging environment or review gate between a merged commit
and the live `hivecommons.dev` domain. Treat any push to `main` as an immediate
production deploy. However, the **Link check** workflow (`.github/workflows/links.yml`) runs on pull requests and on push to `main`, with jobs `links`, `test`, and `redirects` that validate links, redirects, and page markup before any change reaches production. The workflow's separate `availability` job probes the live site on a 6-hour schedule and on manual dispatch, but not on PRs or pushes. The full link check also runs on Mondays at 09:17 UTC.

## Who is affected

`hivecommons.dev` is the public landing page and link hub for the project:

- Anyone following a shortcut redirect (`/docs`, `/code`, `/discord`, `/join`,
  etc.) from external links, social posts, or `llms.txt`.
- Search engines and LLM crawlers consuming `sitemap.xml` / `llms.txt`.
- The custom domain itself, which depends on `CNAME` staying present and
  correct — GitHub disables the custom domain if `CNAME` is missing or wrong
  on the served branch.

A bad push can silently 404 a redirect, break the custom domain, or ship
broken HTML/CSS to every visitor, so treat any of these as user-impacting.

## Detect

- First, check the latest **Link check** run on `main`: visit the
  [Actions](https://github.com/hivecommons/hivecommons.github.io/actions/workflows/links.yml)
  tab, filter to `main` branch, or run
  `gh run list --workflow links.yml --branch main --limit 1 --repo hivecommons/hivecommons.github.io`.
  If the latest run failed, it already pinpointed the broken link, anchor, redirect, or
  markup — use the error output to guide the fix. If it passed, the breakage is
  likely a live-only issue (e.g. a content deploy race, CDN cache, or Pages build
  delay). **Note: the `availability` job did not run on that push** (it only runs
  every 6 hours or via manual dispatch). Trigger a fresh live-site probe with
  `gh workflow run links.yml --repo hivecommons/hivecommons.github.io` (or the Actions
  "Run workflow" button) before concluding that the probe passed and the live site is up.
- `curl -sI https://hivecommons.dev/` — confirm a `200` and that the response
  isn't GitHub's default Pages "there isn't a GitHub Pages site here" error.
- `curl -sI https://hivecommons.dev/<redirect>` for each shortcut in
  `make-redirects.sh`'s `MAP` to confirm each still meta-refreshes correctly.
- Compare the live `CNAME` file content against `hivecommons.dev` — a missing
  or altered `CNAME` drops the custom domain back to the default
  `*.github.io` host.
- Check the repo's Pages build status under Settings → Pages, or
  `gh api repos/hivecommons/hivecommons.github.io/pages/builds/latest`, for a
  failed build.

## Contain / fix forward

The fix is always a direct revert or forward-fix on `main` — there is no
separate "bad artifact" to deprecate or unpublish. Your revert PR will also
trigger the Link check workflow to validate the fix before it merges:

1. Identify the breaking commit: `git log --oneline -- <affected path>`.
2. Revert it directly: `git revert <sha>` and push to `main` (or push a
   forward fix if the revert itself would reintroduce a different problem).
3. If the regression came from `make-redirects.sh`, do not hand-edit the
   generated `index.html` redirect files — fix the `MAP` in the script and
   re-run `./make-redirects.sh`, per `README.md`, since a future script run
   silently overwrites hand edits.
4. If `sitemap.xml` is out of sync with a new or removed top-level page,
   update it in the same fix — `README.md` calls this out as an easy miss.

## After

- Re-run the `curl` checks above against `https://hivecommons.dev/` and the
  redirect paths to confirm the fix is live (Pages publishes are usually fast
  but not instant; allow a minute and retry).
- Confirm `CNAME` still reads `hivecommons.dev` and the custom domain has not
  been disabled (Settings → Pages will show an enforcement/DNS warning if so).
- Note the incident in the PR/issue that tracked the fix so future readers can
  find the rollback steps that were actually used.
