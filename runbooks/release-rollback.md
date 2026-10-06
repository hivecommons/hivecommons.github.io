# Runbook: rolling back a bad hivecommons.dev deploy

This repo has no build step and no deploy workflow (the workflows under
`.github/workflows/` — link check, scorecard, close-linked-issues — do not
publish to Pages; the weekly link-check `availability` job only probes the
live site). GitHub Pages publishes directly from the configured branch on every
push to `main` — there is no test suite, staging environment, or review gate
between a merged commit and the live `hivecommons.dev` domain. Treat any push
to `main` as an immediate production deploy.

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

Because there is no build step or gate, the fix is always a direct revert or
forward-fix on `main` — there is no separate "bad artifact" to deprecate or
unpublish:

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
