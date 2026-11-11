#!/usr/bin/env node
// Static gate over CONTRIBUTING.md. GitHub links it from the new-issue and
// new-PR pages, so it is often the first file a newcomer reads; without it
// GitHub shows the org-wide guide, whose v4/v5 branch rules are hive's. Rules:
//   1. It names `main` as the pull request target.
//   2. It links the repository's starter labels (`good first issue`, `help wanted`)
//      and the Website problem form.
//   3. It links Discord and the community meeting, as the issue chooser does.
// Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/contributing.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPO = "https://github.com/hivecommons/hivecommons.github.io";

export const REQUIRED = [
  ["the main branch as the PR target", "**`main`**"],
  ["the good first issue label", `${REPO}/labels/good%20first%20issue`],
  ["the help wanted label", `${REPO}/labels/help%20wanted`],
  ["the Website problem form", `${REPO}/issues/new?template=site_problem.yml`],
  ["Discord", "https://hivecommons.dev/discord"],
  ["the community meeting", "https://docs.hivecommons.dev/docs/community/meetings"],
];

export function contributingProblems(text) {
  return REQUIRED.filter(([, needle]) => !text.includes(needle)).map(([what, needle]) => `does not name ${what} (${needle})`);
}

test("CONTRIBUTING.md names main and links starter issues, the issue form and community channels", () => {
  assert.deepEqual(contributingProblems(readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8")), []);
});

test("fixtures: a guide missing any required link is rejected, one with all of them passes", () => {
  const all = REQUIRED.map(([, needle]) => needle).join("\n");
  assert.deepEqual(contributingProblems(all), []);
  assert.equal(contributingProblems("").length, REQUIRED.length);
  for (const [what, needle] of REQUIRED) {
    assert.deepEqual(contributingProblems(all.replace(needle, "")), [`does not name ${what} (${needle})`]);
  }
});
