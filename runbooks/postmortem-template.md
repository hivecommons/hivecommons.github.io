# Postmortem: <short title>

Use this after a bad deploy or any incident that reached visitors of
`hivecommons.dev` (broken page, dead redirect, lost custom domain). Keep it
blameless and fact-based. Related runbook: `release-rollback.md`.

## Summary

One or two sentences: what broke, who was affected, how long.

## Impact

- Affected paths (for example `/`, a shortcut redirect, `sitemap.xml`, `llms.txt`):
- Commit that introduced the problem:
- Detection time and who or what detected it (PR checks, scheduled probe, a user):
- Time to mitigation and time to full resolution:

## Timeline (UTC)

| Time | Event |
|------|-------|
|      |       |

## Root cause

What condition made the failure possible, and why existing checks (Link check
jobs, redirect and markup tests) did not stop it before it reached `main`.

## Mitigation and recovery

What was done (revert, forward fix, `CNAME` restore) and which step of the
rollback runbook was used. Note any step that was missing or wrong.

## What went well / what went poorly

-

## Action items

| Action | Owner | Tracking issue | Due |
|--------|-------|----------------|-----|
|        |       |                |     |
