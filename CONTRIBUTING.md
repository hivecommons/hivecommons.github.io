# Contributing to hivecommons.dev

This repository is the source for [hivecommons.dev](https://hivecommons.dev), a static
GitHub Pages site with no build step. Open pull requests against **`main`**, the default
branch. The `v4`/`v5` branch rules in the org-wide
[Hive Commons contributing guide](https://github.com/hivecommons/.github/blob/main/CONTRIBUTING.md)
were written for `hivecommons/hive` and do not apply here.

## Before you open a pull request

Run the checks from the repository root. The README's
[Local preview and running the checks](README.md#local-preview-and-running-the-checks)
section lists them, and they need only Python 3 and Node.js (no `npm install`):

```sh
node --test scripts/*.test.mjs
scripts/check-links.test.sh
scripts/check-redirects.test.sh
scripts/check-redirects.sh
```

The [pull request template](.github/pull_request_template.md) checklist covers this
repository's own rules:

- Shortcut redirects (`/discord`, `/meet`, …) are generated. Change the `MAP` in
  `make-redirects.sh`, then run `./make-redirects.sh`. Do not hand-edit the redirect pages.
- After you edit an inline `<script>`, run `node scripts/update-csp-hashes.mjs`.
- A new top-level page goes in `sitemap.xml`.
- A change to the integration, sponsor, community-link or adopter lists in `index.html`
  must be mirrored in `llms.txt`.

Sign off every commit (`git commit -s`) for the Developer Certificate of Origin check.

## Finding something to work on

- [`good first issue`](https://github.com/hivecommons/hivecommons.github.io/labels/good%20first%20issue)
  and [`help wanted`](https://github.com/hivecommons/hivecommons.github.io/labels/help%20wanted)
  issues are ready to pick up. Comment on the issue before you start.
- Found a broken link, a dead redirect or wrong content? Use the
  [Website problem form](https://github.com/hivecommons/hivecommons.github.io/issues/new?template=site_problem.yml).
  Problems with Hive itself go to the
  [hive issue tracker](https://github.com/hivecommons/hive/issues/new/choose).

## Questions

Ask on [Discord](https://hivecommons.dev/discord) or bring it to the biweekly
[Hive Commons community meeting](https://docs.hivecommons.dev/docs/community/meetings).

For review, governance and the AI-agent contribution policy, see the org-wide
[contributing guide](https://github.com/hivecommons/.github/blob/main/CONTRIBUTING.md).
