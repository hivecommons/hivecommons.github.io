#!/usr/bin/env node
// Static gate keeping .github/workflows/links.yml and README.md in step with the
// gates that live under scripts/. The workflow's `test` job picks up every
// `*.test.mjs` through one glob, but the shell gates and their self-tests are
// listed by hand, one `run:` step each — so a new `check-*.sh` or `*.test.sh`
// that nobody wires in is committed, documented, green locally and never run
// in CI. Likewise a `.mjs` file that uses node:test but is not named
// `*.test.mjs` is skipped by the glob without a word, a shell script whose
// executable bit was lost fails only at run time, and README `## Checks` is the
// only inventory a contributor reads. Each rule has a fixture self-test.
// Zero dependencies.
// Usage: node --test scripts/ci-wiring.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runsOnEveryPrPush } from "./actions-if.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "links.yml");
const README = join(ROOT, "README.md");
const NODE_GLOB = "node --test scripts/*.test.mjs";

// --- parsing ---------------------------------------------------------------

// The `jobs:` block split into { name, body } entries, each body the text
// indented under the job name.
export function workflowJobs(yaml) {
  const jobs = /^jobs:\s*$([\s\S]*)/m.exec(yaml);
  if (!jobs) return [];
  const out = [];
  for (const m of jobs[1].matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$([\s\S]*?)(?=^\s{2}[A-Za-z0-9_-]+:\s*$|(?![\s\S]))/gm)) {
    out.push({ name: m[1], body: m[2] });
  }
  return out;
}

// Every `run:` command in a job body: single-line values and `run: |` blocks,
// each block returned as one string.
export function runCommands(body) {
  const out = [];
  for (const m of body.matchAll(/^(\s*)(?:-\s+)?run:[ \t]*(\|-?|>-?)?[ \t]*(.*)$/gm)) {
    if (m[2]) {
      const after = body.slice(m.index + m[0].length);
      const block = /^((?:[ \t]*\r?\n|[ \t]+\S.*\r?\n?)*)/.exec(after)?.[1] ?? "";
      const lines = block.split(/\r?\n/).filter((l) => l.trim());
      const indent = Math.min(...lines.map((l) => /^\s*/.exec(l)[0].length));
      out.push(lines.map((l) => l.slice(indent)).join("\n"));
    } else {
      out.push(m[3].trim());
    }
  }
  return out;
}

// A job is gated when its `if:` can skip it on a push or pull_request. An `if:` that
// only trims schedule/dispatch events (so a frequent cron runs one job alone) is not.
export function isGatedByCondition(body) {
  const cond = /^\s{4}if:[ \t]*(\S.*)$/m.exec(body)?.[1].trim();
  return !runsOnEveryPrPush(cond);
}

// Scripts under scripts/, classified.
export function classifyScripts(names) {
  return {
    shellTests: names.filter((n) => n.endsWith(".test.sh")).sort(),
    shellGates: names.filter((n) => n.endsWith(".sh") && !n.endsWith(".test.sh")).sort(),
    nodeTests: names.filter((n) => n.endsWith(".test.mjs")).sort(),
    otherNode: names.filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs")).sort(),
  };
}

// --- rules -----------------------------------------------------------------

// Which `run:` commands, across all unconditional jobs, mention a script.
function invocations(jobs, script) {
  const out = [];
  for (const job of jobs) {
    for (const cmd of runCommands(job.body)) {
      if (new RegExp(`(^|[\\s"'=])scripts/${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"'])`, "m").test(cmd)) out.push({ job: job.name, gated: isGatedByCondition(job.body) });
    }
  }
  return out;
}

export function wiringProblems(yaml, { scripts, readme, nodeSources = {} }) {
  const problems = [];
  const jobs = workflowJobs(yaml);
  if (!jobs.length) return ["links.yml has no jobs"];
  const { shellTests, shellGates, nodeTests, otherNode } = classifyScripts(scripts);

  const globRuns = jobs.flatMap((j) => runCommands(j.body).filter((c) => c.split("\n").some((l) => l.trim() === NODE_GLOB)).map(() => j));
  if (!globRuns.length) problems.push(`no job runs \`${NODE_GLOB}\` (every scripts/*.test.mjs gate depends on that one step)`);
  else if (globRuns.some((j) => isGatedByCondition(j.body))) problems.push(`the job running \`${NODE_GLOB}\` carries an \`if:\`, so node gates can be skipped`);

  for (const gate of shellGates) {
    const runs = invocations(jobs, gate);
    if (!runs.length) problems.push(`scripts/${gate} is a gate but no links.yml step runs it`);
    else if (runs.every((r) => r.gated)) problems.push(`scripts/${gate} runs only in conditional jobs (${runs.map((r) => r.job).join(", ")})`);
    const selfTest = gate.replace(/\.sh$/, ".test.sh");
    if (!shellTests.includes(selfTest)) problems.push(`scripts/${gate} has no self-test scripts/${selfTest}`);
  }
  for (const t of shellTests) {
    const runs = invocations(jobs, t);
    if (!runs.length) problems.push(`scripts/${t} is a self-test but no links.yml step runs it`);
    else if (runs.every((r) => r.gated)) problems.push(`scripts/${t} runs only in conditional jobs (${runs.map((r) => r.job).join(", ")})`);
  }
  for (const n of otherNode) {
    if (/from\s+["']node:test["']/.test(nodeSources[n] ?? "")) problems.push(`scripts/${n} imports node:test but is not named *.test.mjs, so \`${NODE_GLOB}\` never runs it`);
  }
  for (const n of nodeTests) {
    if (!/from\s+["']node:test["']/.test(nodeSources[n] ?? "")) problems.push(`scripts/${n} is named like a gate but does not import node:test`);
  }

  if (readme !== undefined) {
    const checks = /^## Checks\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme)?.[1];
    if (checks === undefined) problems.push("README.md has no `## Checks` section");
    else {
      for (const s of [...shellGates, ...shellTests, ...nodeTests]) {
        if (!checks.includes(`scripts/${s}`)) problems.push(`README.md \`## Checks\` does not describe scripts/${s}`);
      }
    }
  }
  return problems;
}

export function triggerProblems(yaml) {
  const problems = [];
  const on = /^on:\s*$([\s\S]*?)(?=^\S)/m.exec(yaml)?.[1] ?? "";
  if (!/^\s{2}pull_request:/m.test(on)) problems.push("links.yml does not run on pull_request");
  const push = /^\s{2}push:\s*$([\s\S]*?)(?=^\s{2}\S|(?![\s\S]))/m.exec(on)?.[1] ?? "";
  if (!/branches:\s*\[\s*main\s*\]/.test(push) && !/branches:\s*\n\s*-\s*main\b/.test(push)) problems.push("links.yml does not run on push to main (README promises a same-named baseline there)");
  return problems;
}

export function modeProblems(entries) {
  // entries: [{ name, mode }], mode from fs.statSync(...).mode
  return entries.filter((e) => e.name.endsWith(".sh") && !(e.mode & 0o111)).map((e) => `${e.name} is not executable (CI runs it directly)`);
}

// --- fixtures ---------------------------------------------------------------

const YAML = `name: Link check

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "17 9 * * 1"

jobs:
  availability:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - name: probe
        run: |
          for url in https://a.test/ \\
                     https://a.test/x/; do
            curl "$url"
          done

  links:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@sha
      - name: Check links
        run: scripts/check-links.sh \${{ 'x' || '--external-warn' }}

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@sha
      - name: Self-test check-links
        run: scripts/check-links.test.sh
      - name: Self-test check-redirects
        run: scripts/check-redirects.test.sh
      - name: Self-test page scripts
        run: node --test scripts/*.test.mjs

  redirects:
    runs-on: ubuntu-latest
    steps:
      - name: Check redirects
        run: scripts/check-redirects.sh
`;

const SCRIPTS = ["check-links.sh", "check-links.test.sh", "check-redirects.sh", "check-redirects.test.sh", "page-x.test.mjs"];
const SOURCES = { "page-x.test.mjs": 'import { test } from "node:test";\n' };
const README_OK = `# Site\n\n## Checks\n\n- \`scripts/check-links.sh\` — a\n- \`scripts/check-links.test.sh\` — b\n- \`scripts/check-redirects.sh\` — c\n- \`scripts/check-redirects.test.sh\` — d\n- \`node --test scripts/page-x.test.mjs\` — e\n\n## Next\n`;

test("fixture: jobs, run commands (inline and block) and if: gating are parsed", () => {
  const jobs = workflowJobs(YAML);
  assert.deepEqual(jobs.map((j) => j.name), ["availability", "links", "test", "redirects"]);
  assert.ok(isGatedByCondition(jobs[0].body));
  assert.ok(!isGatedByCondition(jobs[2].body));
  assert.deepEqual(runCommands(jobs[2].body), ["scripts/check-links.test.sh", "scripts/check-redirects.test.sh", "node --test scripts/*.test.mjs"]);
  const block = runCommands(jobs[0].body);
  assert.equal(block.length, 1);
  assert.match(block[0], /^for url in https:\/\/a\.test\/ \\\n\s+https:\/\/a\.test\/x\/; do\n\s+curl "\$url"\ndone$/, "block scalar keeps relative indentation, drops the YAML indent");
  assert.deepEqual(runCommands(jobs[1].body), ["scripts/check-links.sh ${{ 'x' || '--external-warn' }}"]);
  assert.deepEqual(workflowJobs("name: x\n"), []);
});

test("fixture: a fully wired workflow, script set and README pass", () => {
  assert.deepEqual(wiringProblems(YAML, { scripts: SCRIPTS, readme: README_OK, nodeSources: SOURCES }), []);
  assert.deepEqual(triggerProblems(YAML), []);
});

test("fixture: an unwired gate, an unwired self-test and a gate without a self-test are reported", () => {
  const scripts = [...SCRIPTS, "check-fonts.sh", "check-fonts.test.sh", "check-orphans.sh"];
  const problems = wiringProblems(YAML, { scripts, readme: undefined, nodeSources: SOURCES });
  assert.ok(problems.includes("scripts/check-fonts.sh is a gate but no links.yml step runs it"));
  assert.ok(problems.includes("scripts/check-fonts.test.sh is a self-test but no links.yml step runs it"));
  assert.ok(problems.includes("scripts/check-orphans.sh has no self-test scripts/check-orphans.test.sh"));
  assert.ok(problems.includes("scripts/check-orphans.sh is a gate but no links.yml step runs it"));
});

test("fixture: a script mentioned only as a substring of another path does not count as wired", () => {
  const yaml = YAML.replace("run: scripts/check-redirects.sh", "run: scripts/check-redirects.sh.bak");
  const problems = wiringProblems(yaml, { scripts: SCRIPTS, nodeSources: SOURCES });
  assert.ok(problems.includes("scripts/check-redirects.sh is a gate but no links.yml step runs it"), problems.join("\n"));
});

test("fixture: a gate that runs only inside a conditional job is reported", () => {
  const yaml = YAML.replace("  redirects:\n    runs-on", "  redirects:\n    if: github.event_name == 'schedule'\n    runs-on");
  const problems = wiringProblems(yaml, { scripts: SCRIPTS, nodeSources: SOURCES });
  assert.ok(problems.includes("scripts/check-redirects.sh runs only in conditional jobs (redirects)"), problems.join("\n"));
});

test("fixture: the node glob step is required and must be unconditional", () => {
  const gone = YAML.replace("        run: node --test scripts/*.test.mjs\n", "");
  assert.ok(wiringProblems(gone, { scripts: SCRIPTS, nodeSources: SOURCES }).some((p) => p.startsWith("no job runs `node --test scripts/*.test.mjs`")));
  const gated = YAML.replace("  test:\n    runs-on", "  test:\n    if: github.event_name == 'push'\n    runs-on");
  assert.ok(wiringProblems(gated, { scripts: SCRIPTS, nodeSources: SOURCES }).some((p) => p.includes("carries an `if:`")));
  const opaque = YAML.replace("  test:\n    runs-on", "  test:\n    if: contains(github.ref, 'main')\n    runs-on");
  assert.ok(wiringProblems(opaque, { scripts: SCRIPTS, nodeSources: SOURCES }).some((p) => p.includes("carries an `if:`")));
  const enumerated = YAML.replace("node --test scripts/*.test.mjs", "node --test scripts/page-x.test.mjs");
  assert.ok(wiringProblems(enumerated, { scripts: SCRIPTS, nodeSources: SOURCES }).some((p) => p.startsWith("no job runs `node --test scripts/*.test.mjs`")));
});

test("fixture: an `if:` that only trims schedule/dispatch events leaves the job unconditional for PR/push", () => {
  const trim = "github.event_name != 'schedule' || github.event.schedule == '17 9 * * 1'";
  const yaml = YAML.replace("  test:\n    runs-on", `  test:\n    if: ${trim}\n    runs-on`)
    .replace("  redirects:\n    runs-on", "  redirects:\n    if: github.event_name != 'workflow_dispatch'\n    runs-on");
  assert.deepEqual(wiringProblems(yaml, { scripts: SCRIPTS, nodeSources: SOURCES }), []);
  assert.equal(isGatedByCondition(`    if: ${trim}\n    runs-on: x\n`), false);
  assert.equal(isGatedByCondition("    if: github.event_name == 'schedule'\n    runs-on: x\n"), true);
  assert.equal(isGatedByCondition("    runs-on: x\n"), false);
});

test("fixture: node:test files outside the glob, and glob-named files without node:test, are reported", () => {
  const scripts = [...SCRIPTS, "helpers.mjs", "page-y.test.mjs"];
  const sources = { ...SOURCES, "helpers.mjs": 'import { test } from "node:test";\n', "page-y.test.mjs": "export const x = 1;\n" };
  const problems = wiringProblems(YAML, { scripts, nodeSources: sources });
  assert.ok(problems.some((p) => p.startsWith("scripts/helpers.mjs imports node:test but is not named *.test.mjs")));
  assert.ok(problems.includes("scripts/page-y.test.mjs is named like a gate but does not import node:test"));
  const plainHelper = wiringProblems(YAML, { scripts: [...SCRIPTS, "helpers.mjs"], nodeSources: { ...SOURCES, "helpers.mjs": "export const x = 1;\n" } });
  assert.deepEqual(plainHelper, []);
});

test("fixture: README Checks must exist and name every gate and self-test", () => {
  const noSection = wiringProblems(YAML, { scripts: SCRIPTS, readme: "# Site\n", nodeSources: SOURCES });
  assert.ok(noSection.includes("README.md has no `## Checks` section"));
  const missing = wiringProblems(YAML, { scripts: SCRIPTS, readme: README_OK.replace("- `node --test scripts/page-x.test.mjs` — e\n", ""), nodeSources: SOURCES });
  assert.deepEqual(missing, ["README.md `## Checks` does not describe scripts/page-x.test.mjs"]);
  const elsewhere = wiringProblems(YAML, { scripts: SCRIPTS, readme: README_OK.replace("- `node --test scripts/page-x.test.mjs` — e\n", "") + "\n`scripts/page-x.test.mjs`\n", nodeSources: SOURCES });
  assert.equal(elsewhere.length, 1, "a mention outside ## Checks does not count");
});

test("fixture: triggers must include pull_request and push to main", () => {
  assert.ok(triggerProblems(YAML.replace("  pull_request:\n", "")).includes("links.yml does not run on pull_request"));
  assert.ok(triggerProblems(YAML.replace("branches: [main]", "branches: [release]")).some((p) => p.includes("push to main")));
  assert.deepEqual(triggerProblems(YAML.replace("branches: [main]", "branches:\n      - main")), []);
});

test("fixture: shell scripts without an executable bit are reported", () => {
  assert.deepEqual(modeProblems([{ name: "a.sh", mode: 0o100755 }, { name: "b.mjs", mode: 0o100644 }]), []);
  assert.deepEqual(modeProblems([{ name: "a.sh", mode: 0o100644 }]), ["a.sh is not executable (CI runs it directly)"]);
});

// --- live checks over the committed tree ------------------------------------

const yaml = readFileSync(WORKFLOW, "utf8");
const names = readdirSync(HERE).filter((n) => statSync(join(HERE, n)).isFile());
const nodeSources = Object.fromEntries(names.filter((n) => n.endsWith(".mjs")).map((n) => [n, readFileSync(join(HERE, n), "utf8")]));

test("links.yml: every scripts/ gate and self-test is run by an unconditional step, node gates run through the glob, README Checks lists them all", () => {
  assert.deepEqual(wiringProblems(yaml, { scripts: names, readme: readFileSync(README, "utf8"), nodeSources }), [], "fixing a missing step needs a workflow edit; fixing a README gap does not");
});

test("links.yml: runs on pull_request and on push to main", () => {
  assert.deepEqual(triggerProblems(yaml), []);
});

test("scripts/*.sh and make-redirects.sh are executable", () => {
  const entries = [
    ...names.map((n) => ({ name: `scripts/${n}`, mode: statSync(join(HERE, n)).mode })),
    { name: "make-redirects.sh", mode: statSync(join(ROOT, "make-redirects.sh")).mode },
  ];
  assert.deepEqual(modeProblems(entries), []);
});
