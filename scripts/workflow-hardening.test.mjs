#!/usr/bin/env node
// Static gate over the supply-chain hardening of every workflow under
// .github/workflows/. Each workflow today pins every `uses:` to a full commit
// SHA with a human-readable version comment, declares a top-level
// `permissions:` block, checks out with `persist-credentials: false` and bounds
// every runner job with `timeout-minutes`. Nothing enforces any of that: a PR
// that re-pins `actions/checkout` to `@v4`, drops `persist-credentials: false`
// to "fix" a push, or adds a workflow without `permissions:` is green in CI.
// OpenSSF Scorecard reads the same files (Pinned-Dependencies, Token-Permissions)
// but only on push to main and weekly, and a lower score fails nothing —
// automation-docs.test.mjs checks what the README *says* about each workflow,
// not how the workflow is built. Each rule has a fixture self-test.
// Zero dependencies.
//
// Rules:
//   1. Every `uses:` is `owner/repo[/path]@<40-hex SHA>` followed by a
//      `# <version>` comment on the same line (what Dependabot rewrites on a
//      bump, so the pin stays readable). `./local` actions are exempt;
//      `docker://` images must carry an `@sha256:<64-hex>` digest.
//   2. The workflow declares a top-level `permissions:` block, and neither it
//      nor any job grants `write-all`.
//   3. Every `actions/checkout` step sets `with: persist-credentials: false`.
//   4. Every job that has `runs-on:` also has `timeout-minutes:` (jobs that
//      call a reusable workflow via `uses:` cannot, and are exempt).
//   5. A workflow directory with no `uses:` lines at all is reported, so the
//      parser can never pass vacuously.
// Usage: node --test scripts/workflow-hardening.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

// --- parsing -----------------------------------------------------------------

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// Every `uses:` occurrence as { line (1-based), ref, comment }.
export function usesLines(yaml) {
  const out = [];
  yaml.split("\n").forEach((text, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*(.*)$/.exec(text);
    if (!m) return;
    let rest = m[1].trim();
    let comment = null;
    const hash = rest.search(/\s#/);
    if (hash >= 0) {
      comment = rest.slice(hash + 2).trim();
      rest = rest.slice(0, hash).trim();
    }
    const ref = rest.replace(/^["']|["']$/g, "");
    out.push({ line: i + 1, ref, comment });
  });
  return out;
}

// The `jobs:` block split into { name, line, body } entries, each body the
// lines indented under the job name.
export function workflowJobs(yaml) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    const m = /^  ([\w.-]+):\s*(?:#.*)?$/.exec(l);
    if (m) {
      jobs.push({ name: m[1], line: i + 1, body: [] });
    } else if (jobs.length) {
      jobs[jobs.length - 1].body.push(l);
    }
  }
  return jobs;
}

// Each step under a job's `steps:` as { line, body } (body includes the `- ` line).
export function jobSteps(job) {
  const idx = job.body.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (idx < 0) return [];
  const stepsIndent = indentOf(job.body[idx]);
  const steps = [];
  let dashIndent = null;
  for (let i = idx + 1; i < job.body.length; i++) {
    const l = job.body[i];
    if (l.trim() === "") continue;
    if (indentOf(l) <= stepsIndent) break;
    if (/^\s*-\s/.test(l) && (dashIndent === null || indentOf(l) === dashIndent)) {
      dashIndent = indentOf(l);
      steps.push({ line: job.line + 1 + i, body: [l] });
    } else if (steps.length) {
      steps[steps.length - 1].body.push(l);
    }
  }
  return steps;
}

export function topLevelPermissions(yaml) {
  const lines = yaml.split("\n");
  const i = lines.findIndex((l) => /^permissions:/.test(l));
  if (i < 0) return null;
  const inline = /^permissions:\s*(\S.*?)\s*(?:#.*)?$/.exec(lines[i])?.[1];
  if (inline) return { line: i + 1, scalar: inline, entries: [] };
  const entries = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === "") continue;
    if (/^\S/.test(l)) break;
    const m = /^\s+([\w-]+):\s*(\S+)/.exec(l);
    if (m) entries.push({ scope: m[1], level: m[2] });
  }
  return { line: i + 1, scalar: null, entries };
}

// --- rules -------------------------------------------------------------------

// workflows: { "links.yml": yaml }
export function hardeningProblems(workflows) {
  const problems = [];
  let totalUses = 0;
  for (const [file, yaml] of Object.entries(workflows).sort()) {
    const where = `.github/workflows/${file}`;

    // 1. pinned uses
    for (const u of usesLines(yaml)) {
      totalUses++;
      const at = `${where}:${u.line}`;
      if (u.ref.startsWith("./")) continue;
      if (u.ref.startsWith("docker://")) {
        const digest = u.ref.split("@")[1] ?? "";
        if (!SHA256.test(digest)) problems.push(`${at} uses ${u.ref} — docker images must be pinned by @sha256:<64-hex> digest, not tag`);
        continue;
      }
      const [action, version] = u.ref.split("@");
      if (version === undefined) {
        problems.push(`${at} uses ${u.ref} without any @ref — pin it to a 40-hex commit SHA`);
        continue;
      }
      if (!/^[\w.-]+\/[\w.-]+(\/[^@\s]+)?$/.test(action)) problems.push(`${at} uses ${u.ref} — expected owner/repo[/path]@sha`);
      if (!SHA40.test(version)) problems.push(`${at} uses ${u.ref} — @${version} is not a 40-hex commit SHA (mutable tags and branches can be moved under you)`);
      if (!u.comment) problems.push(`${at} uses ${u.ref} without a trailing \`# <version>\` comment naming what the SHA resolves to`);
    }

    // 2. permissions
    const perms = topLevelPermissions(yaml);
    if (!perms) {
      problems.push(`${where} declares no top-level \`permissions:\` — the default GITHUB_TOKEN grant is then whatever the repository setting says`);
    } else if (perms.scalar === "write-all") {
      problems.push(`${where}:${perms.line} grants \`permissions: write-all\` at the top level`);
    } else if (perms.scalar && perms.scalar !== "read-all" && perms.scalar !== "{}") {
      problems.push(`${where}:${perms.line} has an unrecognised \`permissions: ${perms.scalar}\` (expected read-all, {} or a scope map)`);
    } else {
      for (const e of perms.entries) if (e.level === "write-all") problems.push(`${where}:${perms.line} grants \`${e.scope}: write-all\``);
    }

    const jobs = workflowJobs(yaml);
    if (!jobs.length) problems.push(`${where} has no \`jobs:\` block the parser can read`);
    for (const job of jobs) {
      const body = job.body.join("\n");
      const jobWhere = `${where} job \`${job.name}\``;
      if (/^\s+permissions:\s*write-all\s*$/m.test(body)) problems.push(`${jobWhere} grants \`permissions: write-all\``);
      if (/^\s+(?!permissions:)[\w-]+:\s*write-all\s*$/m.test(body)) problems.push(`${jobWhere} grants a \`write-all\` scope`);

      // 4. timeout on runner jobs
      const isReusable = /^\s{4}uses:\s/m.test(body);
      const hasRunsOn = /^\s{4}runs-on:\s/m.test(body);
      if (hasRunsOn && !/^\s{4}timeout-minutes:\s*\d+/m.test(body)) problems.push(`${jobWhere} has \`runs-on\` but no \`timeout-minutes\` (default is 360)`);
      if (!hasRunsOn && !isReusable) problems.push(`${jobWhere} has neither \`runs-on\` nor a reusable-workflow \`uses:\``);

      // 3. checkout hardening
      for (const step of jobSteps(job)) {
        const text = step.body.join("\n");
        if (!/uses:\s*["']?actions\/checkout@/.test(text)) continue;
        const pc = /^\s+persist-credentials:\s*(\S+)/m.exec(text);
        if (!pc) problems.push(`${where}:${step.line} actions/checkout step does not set \`with: persist-credentials: false\` (the token is otherwise written into .git/config for every later step)`);
        else if (pc[1] !== "false") problems.push(`${where}:${step.line} actions/checkout step sets \`persist-credentials: ${pc[1]}\`; it must be \`false\``);
      }
    }
  }
  if (!Object.keys(workflows).length) problems.push("no workflows found under .github/workflows/");
  else if (!totalUses) problems.push("no `uses:` line in any workflow — the parser matches nothing");
  return problems;
}

// --- fixtures ----------------------------------------------------------------

const SHA_A = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SHA_B = "2d1146689b8cda280b9bc96326124645441f03bc";
const DIGEST = "sha256:" + "ab".repeat(32);

const GOOD = `name: Good

on:
  pull_request:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@${SHA_A} # v7.0.1
        with:
          persist-credentials: false
      - name: Scan
        uses: ossf/scorecard-action@${SHA_B} # v2.4.4
      - uses: ./.github/actions/local
      - uses: docker://alpine@${DIGEST}
      - run: echo ok
  reuse:
    uses: hivecommons/infra/.github/workflows/reusable.yml@${SHA_A} # infra main as of 2026-09-29
`;

const GOOD_READ_ALL = GOOD.replace("permissions:\n  contents: read\n", "permissions: read-all\n");

test("fixture: a fully hardened workflow passes", () => {
  assert.deepEqual(hardeningProblems({ "good.yml": GOOD }), []);
  assert.deepEqual(hardeningProblems({ "good.yml": GOOD_READ_ALL }), []);
});

test("fixture: usesLines reads refs, strips quotes and splits the version comment", () => {
  const u = usesLines(GOOD);
  assert.equal(u.length, 5);
  assert.deepEqual(u[0], { line: 14, ref: `actions/checkout@${SHA_A}`, comment: "v7.0.1" });
  assert.deepEqual(u[2], { line: 19, ref: "./.github/actions/local", comment: null });
  assert.deepEqual(usesLines(`      - uses: "actions/checkout@${SHA_A}" # v7`)[0], { line: 1, ref: `actions/checkout@${SHA_A}`, comment: "v7" });
});

test("fixture: workflowJobs and jobSteps split by indentation and carry line numbers", () => {
  const jobs = workflowJobs(GOOD);
  assert.deepEqual(jobs.map((j) => j.name), ["build", "reuse"]);
  assert.equal(jobs[0].line, 10);
  const steps = jobSteps(jobs[0]);
  assert.equal(steps.length, 5);
  assert.equal(steps[0].line, 14);
  assert.ok(steps[0].body.some((l) => /persist-credentials: false/.test(l)), "with: block belongs to the checkout step");
  assert.deepEqual(jobSteps(jobs[1]), []);
});

test("fixture: workflowJobs stops at the next top-level key instead of reading it as a job", () => {
  // `jobs:` is not always the last block: a trailing top-level `env:` (or
  // `defaults:`) has two-space-indented children that look exactly like job
  // names. Without the break they would be parsed as jobs with no runs-on.
  const yaml = GOOD + "\nenv:\n  CI: true\n  phantom:\n    runs-on: ubuntu-latest\n";
  const jobs = workflowJobs(yaml);
  assert.deepEqual(jobs.map((j) => j.name), ["build", "reuse"]);
  assert.ok(!jobs.some((j) => j.body.some((l) => /CI: true|phantom/.test(l))), "the env block must not be appended to the last job's body");
  assert.deepEqual(hardeningProblems({ "w.yml": yaml }), []);
});

test("fixture: jobSteps stops at the next job-level key instead of reading it as a step", () => {
  // A job key after `steps:` (here `env:`) sits at the steps indent; its
  // children are deeper than `steps:` but are not steps. Without the break a
  // `- ` list item under it would be counted as a step, and a
  // `persist-credentials` under it could be credited to a checkout step.
  const yaml = GOOD.replace("      - run: echo ok\n", "      - run: echo ok\n    env:\n      LIST:\n        - item\n      persist-credentials: false\n");
  const [build] = workflowJobs(yaml);
  const steps = jobSteps(build);
  assert.equal(steps.length, 5, steps.map((s) => s.body[0]).join("\n"));
  assert.ok(!steps.some((s) => s.body.some((l) => /LIST:|- item|^      persist-credentials/.test(l))), "nothing under env: belongs to a step");
  assert.deepEqual(hardeningProblems({ "w.yml": yaml }), []);
  // The break is what keeps the stray persist-credentials from rescuing an
  // unhardened checkout earlier in the same job.
  const unhardened = yaml.replace("        with:\n          persist-credentials: false\n", "");
  const p = hardeningProblems({ "w.yml": unhardened });
  assert.equal(p.length, 1, p.join("\n"));
  assert.match(p[0], /:14 actions\/checkout step does not set/);
});

test("fixture: a tag, branch, short SHA or missing @ref on uses: is reported", () => {
  const tag = hardeningProblems({ "w.yml": GOOD.replace(`ossf/scorecard-action@${SHA_B} # v2.4.4`, "ossf/scorecard-action@v2.4.4 # v2.4.4") });
  assert.deepEqual(tag, [".github/workflows/w.yml:18 uses ossf/scorecard-action@v2.4.4 — @v2.4.4 is not a 40-hex commit SHA (mutable tags and branches can be moved under you)"]);
  const short = hardeningProblems({ "w.yml": GOOD.replace(`ossf/scorecard-action@${SHA_B}`, `ossf/scorecard-action@${SHA_B.slice(0, 12)}`) });
  assert.equal(short.length, 1, short.join("\n"));
  assert.match(short[0], /is not a 40-hex commit SHA/);
  const none = hardeningProblems({ "w.yml": GOOD.replace(`ossf/scorecard-action@${SHA_B} # v2.4.4`, "ossf/scorecard-action") });
  assert.deepEqual(none, [".github/workflows/w.yml:18 uses ossf/scorecard-action without any @ref — pin it to a 40-hex commit SHA"]);
  const upper = hardeningProblems({ "w.yml": GOOD.replace(`ossf/scorecard-action@${SHA_B}`, `ossf/scorecard-action@${SHA_B.toUpperCase()}`) });
  assert.equal(upper.length, 1, "uppercase hex is not what git prints and not what Dependabot writes");
});

test("fixture: a SHA-pinned uses: whose action is not owner/repo[/path] is reported", () => {
  // A bare `checkout@<sha>` or a `owner/repo:tag@<sha>` passes the SHA and
  // comment rules; only the action-shape rule catches it.
  const bare = hardeningProblems({ "w.yml": GOOD.replace(`ossf/scorecard-action@${SHA_B}`, `scorecard-action@${SHA_B}`) });
  assert.deepEqual(bare, [`.github/workflows/w.yml:18 uses scorecard-action@${SHA_B} — expected owner/repo[/path]@sha`]);
  const colon = hardeningProblems({ "w.yml": GOOD.replace(`ossf/scorecard-action@${SHA_B}`, `ossf/scorecard-action:v2@${SHA_B}`) });
  assert.equal(colon.length, 1, colon.join("\n"));
  assert.match(colon[0], /expected owner\/repo\[\/path\]@sha$/);
  // Shape and SHA rules are independent: a bad action with a tag reports both.
  const both = hardeningProblems({ "w.yml": GOOD.replace(`ossf/scorecard-action@${SHA_B} # v2.4.4`, "scorecard-action@v2 # v2") });
  assert.equal(both.length, 2, both.join("\n"));
  assert.match(both[0], /expected owner\/repo\[\/path\]@sha$/);
  assert.match(both[1], /@v2 is not a 40-hex commit SHA/);
});

test("fixture: a SHA pin without a trailing version comment is reported", () => {
  const p = hardeningProblems({ "w.yml": GOOD.replace(`actions/checkout@${SHA_A} # v7.0.1`, `actions/checkout@${SHA_A}`) });
  assert.deepEqual(p, [`.github/workflows/w.yml:14 uses actions/checkout@${SHA_A} without a trailing \`# <version>\` comment naming what the SHA resolves to`]);
  const empty = hardeningProblems({ "w.yml": GOOD.replace(`actions/checkout@${SHA_A} # v7.0.1`, `actions/checkout@${SHA_A} #`) });
  assert.equal(empty.length, 1, "an empty comment does not count");
});

test("fixture: the reusable-workflow job's uses: is held to the same pin rule", () => {
  const p = hardeningProblems({ "w.yml": GOOD.replace(`reusable.yml@${SHA_A} # infra main as of 2026-09-29`, "reusable.yml@main # infra main") });
  assert.equal(p.length, 1, p.join("\n"));
  assert.match(p[0], /^\.github\/workflows\/w\.yml:23 uses hivecommons\/infra\/\.github\/workflows\/reusable\.yml@main — @main is not a 40-hex/);
});

test("fixture: local ./ actions are exempt; docker:// images need a sha256 digest", () => {
  assert.deepEqual(hardeningProblems({ "w.yml": GOOD.replace("- uses: ./.github/actions/local", "- uses: ./other/action") }), []);
  const tag = hardeningProblems({ "w.yml": GOOD.replace(`docker://alpine@${DIGEST}`, "docker://alpine:3.20") });
  assert.deepEqual(tag, [".github/workflows/w.yml:20 uses docker://alpine:3.20 — docker images must be pinned by @sha256:<64-hex> digest, not tag"]);
});

test("fixture: a workflow without top-level permissions, or granting write-all anywhere, is reported", () => {
  const missing = hardeningProblems({ "w.yml": GOOD.replace("permissions:\n  contents: read\n", "") });
  assert.deepEqual(missing, [".github/workflows/w.yml declares no top-level `permissions:` — the default GITHUB_TOKEN grant is then whatever the repository setting says"]);
  const writeAll = hardeningProblems({ "w.yml": GOOD.replace("permissions:\n  contents: read\n", "permissions: write-all\n") });
  assert.deepEqual(writeAll, [".github/workflows/w.yml:6 grants `permissions: write-all` at the top level"]);
  const scopeWriteAll = hardeningProblems({ "w.yml": GOOD.replace("  contents: read\n", "  contents: write-all\n") });
  assert.deepEqual(scopeWriteAll, [".github/workflows/w.yml:6 grants `contents: write-all`"]);
  const jobWriteAll = hardeningProblems({ "w.yml": GOOD.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    permissions: write-all\n") });
  assert.deepEqual(jobWriteAll, [".github/workflows/w.yml job `build` grants `permissions: write-all`"]);
  const jobScopeWriteAll = hardeningProblems({ "w.yml": GOOD.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    permissions:\n      contents: write-all\n") });
  assert.deepEqual(jobScopeWriteAll, [".github/workflows/w.yml job `build` grants a `write-all` scope"]);
  const jobScoped = hardeningProblems({ "w.yml": GOOD.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n") });
  assert.deepEqual(jobScoped, [], "a job-level scoped write grant is the intended way to escalate");
  const odd = hardeningProblems({ "w.yml": GOOD.replace("permissions:\n  contents: read\n", "permissions: everything\n") });
  assert.equal(odd.length, 1);
  assert.match(odd[0], /unrecognised `permissions: everything`/);
});

test("fixture: a job-level permissions block does not satisfy the top-level rule", () => {
  const yaml = GOOD.replace("permissions:\n  contents: read\n", "").replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n");
  const p = hardeningProblems({ "w.yml": yaml });
  assert.equal(p.length, 1, p.join("\n"));
  assert.match(p[0], /declares no top-level `permissions:`/);
});

test("fixture: a checkout without persist-credentials: false, or with it true, is reported", () => {
  const missing = hardeningProblems({ "w.yml": GOOD.replace("        with:\n          persist-credentials: false\n", "") });
  assert.deepEqual(missing, [".github/workflows/w.yml:14 actions/checkout step does not set `with: persist-credentials: false` (the token is otherwise written into .git/config for every later step)"]);
  const yes = hardeningProblems({ "w.yml": GOOD.replace("persist-credentials: false", "persist-credentials: true") });
  assert.deepEqual(yes, [".github/workflows/w.yml:14 actions/checkout step sets `persist-credentials: true`; it must be `false`"]);
  // persist-credentials on a *different* step must not be credited to the checkout.
  const elsewhere = hardeningProblems({
    "w.yml": GOOD.replace("        with:\n          persist-credentials: false\n", "").replace("      - run: echo ok\n", "      - run: echo ok\n        with:\n          persist-credentials: false\n"),
  });
  assert.equal(elsewhere.length, 1, elsewhere.join("\n"));
  assert.match(elsewhere[0], /:14 actions\/checkout step does not set/);
});

test("fixture: a runner job without timeout-minutes is reported; reusable-workflow jobs are exempt", () => {
  const p = hardeningProblems({ "w.yml": GOOD.replace("    timeout-minutes: 5\n", "") });
  assert.deepEqual(p, [".github/workflows/w.yml job `build` has `runs-on` but no `timeout-minutes` (default is 360)"]);
  const neither = hardeningProblems({ "w.yml": GOOD.replace("    runs-on: ubuntu-latest\n    timeout-minutes: 5\n", "") });
  assert.deepEqual(neither, [".github/workflows/w.yml job `build` has neither `runs-on` nor a reusable-workflow `uses:`"]);
});

test("fixture: problems are reported per file and sorted by file name", () => {
  const p = hardeningProblems({
    "b.yml": GOOD.replace("    timeout-minutes: 5\n", ""),
    "a.yml": GOOD.replace("permissions:\n  contents: read\n", ""),
  });
  assert.equal(p.length, 2);
  assert.match(p[0], /^\.github\/workflows\/a\.yml /);
  assert.match(p[1], /^\.github\/workflows\/b\.yml /);
});

test("fixture: no workflows, no uses: lines or no jobs: block is reported instead of passing vacuously", () => {
  assert.deepEqual(hardeningProblems({}), ["no workflows found under .github/workflows/"]);
  const noUses = hardeningProblems({ "w.yml": "name: x\n\non: push\n\npermissions: read-all\n\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 1\n    steps:\n      - run: true\n" });
  assert.deepEqual(noUses, ["no `uses:` line in any workflow — the parser matches nothing"]);
  const noJobs = hardeningProblems({ "w.yml": `name: x\n\non: push\n\npermissions: read-all\n\nsteps:\n  - uses: actions/checkout@${SHA_A} # v7\n` });
  assert.deepEqual(noJobs, [".github/workflows/w.yml has no `jobs:` block the parser can read"]);
});

// --- live tree -------------------------------------------------------------------

const live = {};
for (const n of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) live[n] = readFileSync(join(WORKFLOWS, n), "utf8");

test("every .github/workflows/*.yml pins uses: to a commented SHA, declares permissions, hardens checkout and bounds runner jobs", () => {
  assert.ok(Object.keys(live).length >= 3, `expected the three committed workflows, found ${Object.keys(live).join(", ")}`);
  assert.deepEqual(hardeningProblems(live), []);
});

test("live tree: every workflow contributes at least one uses: line (the pin rule actually runs on each)", () => {
  for (const [file, yaml] of Object.entries(live)) {
    assert.ok(usesLines(yaml).length > 0, `${file} has no uses: line`);
  }
});
