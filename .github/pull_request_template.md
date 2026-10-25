## Summary

<!-- What does this PR change on hivecommons.dev, and why? Name the pages or shortcut redirects it touches. -->

Closes #<!-- issue number, if this PR resolves one -->

## Screenshots

<!-- For a visible change, attach desktop and mobile screenshots (before/after if it alters existing content). Delete this section otherwise. -->

## Checks run locally

<!-- From the repository root; see README "Local preview and running the checks". Note any you could not run. -->

- [ ] `node --test scripts/*.test.mjs`
- [ ] `scripts/check-links.sh --external-warn`
- [ ] `scripts/check-links.test.sh`
- [ ] `scripts/check-redirects.test.sh`
- [ ] `scripts/check-redirects.sh`

## Checklist

- [ ] Shortcut redirects were changed only through the `MAP` in `make-redirects.sh`, followed by `./make-redirects.sh` (no hand-edited redirect pages)
- [ ] After editing an inline `<script>`, I ran `node scripts/update-csp-hashes.mjs`
- [ ] A new top-level page is listed in `sitemap.xml`
- [ ] A change to the integration or sponsor lists in `index.html` is mirrored in `llms.txt`
- [ ] Commits are signed off (`git commit -s`), as the org [CONTRIBUTING.md](https://github.com/hivecommons/.github/blob/main/CONTRIBUTING.md) requires
