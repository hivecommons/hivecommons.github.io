#!/usr/bin/env node
// Static gate keeping the prose about .github/workflows/links.yml honest. README.md
// (## Checks, ## Availability monitoring) and runbooks/*.md make checkable claims
// about the workflow: its name ("Link check"), which jobs exist, which run on every
// PR/push and which only on the weekly schedule / manual dispatch, the cron day and
// time, and that CI passes `--external-warn` to scripts/check-links.sh on PRs and
// pushes only. The runbook is read during an incident, and nothing else compares
// it with the workflow. Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/workflow-docs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "links.yml");
const CHECK_LINKS = join(HERE, "check-links.sh");
const RUNBOOKS = join(ROOT, "runbooks");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// --- parsing ---------------------------------------------------------------

export function workflowName(yaml) {
  return /^name:[ \t]*["']?([^"'\r\n#]+?)["']?[ \t]*$/m.exec(yaml)?.[1];
}

// The `jobs:` block split into { name, body } entries.
export function workflowJobs(yaml) {
  const jobs = /^jobs:\s*$([\s\S]*)/m.exec(yaml);
  if (!jobs) return [];
  const out = [];
  for (const m of jobs[1].matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$([\s\S]*?)(?=^\s{2}[A-Za-z0-9_-]+:\s*$|(?![\s\S]))/gm)) {
    out.push({ name: m[1], body: m[2] });
  }
  return out;
}

// The job-level `if:` expression, or undefined for an unconditional job.
export function jobCondition(body) {
  return /^\s{4}if:[ \t]*(\S.*)$/m.exec(body)?.[1].trim();
}

export function triggers(yaml) {
  const on = /^on:\s*$([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(yaml)?.[1] ?? "";
  return {
    dispatch: /^\s{2}workflow_dispatch:/m.test(on),
    schedule: /^\s{2}schedule:/m.test(on),
    cron: /^\s*-\s*cron:\s*["']([^"']+)["']/m.exec(on)?.[1],
  };
}

// "17 9 * * 1" -> { hour: "09", minute: "17", day: "Monday" }; undefined when it is not a plain weekly cron.
export function parseWeeklyCron(cron) {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-7])$/.exec((cron ?? "").trim());
  if (!m) return undefined;
  return { minute: m[1].padStart(2, "0"), hour: m[2].padStart(2, "0"), day: DAYS[Number(m[3]) % 7] };
}

// The flag `links` passes only outside schedule/dispatch: `scripts/check-links.sh ${{ (<schedule/dispatch>) && '' || '--flag' }}`.
export function conditionalFlag(body) {
  const run = /run:[ \t]*(scripts\/check-links\.sh\b.*)$/m.exec(body)?.[1];
  const expr = run && /\$\{\{([^}]*)\}\}/.exec(run)?.[1];
  if (!expr || !/schedule|workflow_dispatch/.test(expr)) return undefined;
  return /&&\s*(?:''|"")\s*\|\|\s*'(--[\w-]+)'/.exec(expr)?.[1];
}

export function acceptedFlag(script) {
  return /\[\[\s*"\$\{1:-\}"\s*==\s*"(--[\w-]+)"\s*\]\]/.exec(script)?.[1];
}

// Doc text with whitespace collapsed, split into sentences.
export function sentences(text) {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z*`])/);
}

const LIST = "`[A-Za-z][\\w-]*`(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+)`[A-Za-z][\\w-]*`)*";
const EVERY_RE = /\bevery (?:pull request|PR|push)\b/i;
const SCHEDULED_RE = /\bonly (?:on|runs)\b|\bruns only\b|\bscheduled\b|\bweekly\b|\bmanual dispatch\b/i;

// Jobs a doc names in "`x` job" / "jobs `a`, `b` and `c`" phrases, each with what the
// surrounding sentence says about when it runs.
export function jobClaims(text) {
  const out = [];
  const phrases = [new RegExp(`\\bjobs\\s+(${LIST})`, "g"), new RegExp(`(${LIST})\\s+jobs?\\b`, "g")];
  for (const s of sentences(text)) {
    for (const re of phrases) {
      for (const m of s.matchAll(re)) {
        const end = m.index + m[0].length;
        const everyRun = EVERY_RE.test(s.slice(Math.max(0, m.index - 160), m.index) + " " + s.slice(end, end + 120));
        const scheduledOnly = SCHEDULED_RE.test(s.slice(Math.max(0, m.index - 60), m.index) + " " + s.slice(end, end + 90));
        for (const j of m[1].matchAll(/`([^`]+)`/g)) out.push({ job: j[1], everyRun, scheduledOnly });
      }
    }
  }
  return out;
}

// --- rules -----------------------------------------------------------------

export function docProblems(yaml, { docs, checkLinks }) {
  const problems = [];
  const name = workflowName(yaml);
  const jobs = workflowJobs(yaml);
  const trig = triggers(yaml);
  if (!name) problems.push("links.yml has no `name:`");
  if (!jobs.length) return [...problems, "links.yml has no jobs"];
  const cron = parseWeeklyCron(trig.cron);
  if (!cron) problems.push(`links.yml has no plain weekly \`cron:\` ("M H * * D"); found ${JSON.stringify(trig.cron)}`);

  const flag = conditionalFlag(jobs.find((j) => j.name === "links")?.body ?? "");
  if (!flag) problems.push("the `links` job does not pass a flag to scripts/check-links.sh conditionally on schedule/workflow_dispatch");
  if (checkLinks !== undefined && flag && acceptedFlag(checkLinks) !== flag) problems.push(`the \`links\` job passes \`${flag}\` but scripts/check-links.sh accepts \`${acceptedFlag(checkLinks)}\``);

  for (const [file, raw] of Object.entries(docs)) {
    const text = raw.replace(/\s+/g, " ");
    for (const m of text.matchAll(/\*\*([^*]+?)\*\* workflow\b/g)) {
      if (name && m[1] !== name) problems.push(`${file} calls the workflow "${m[1]}" but links.yml is named "${name}"`);
    }

    const claims = jobClaims(raw.replace(/\*\*/g, ""));
    for (const { job, everyRun, scheduledOnly } of claims) {
      const found = jobs.find((j) => j.name === job);
      if (!found) {
        problems.push(`${file} names a \`${job}\` job that links.yml does not define (jobs: ${jobs.map((j) => j.name).join(", ")})`);
        continue;
      }
      const cond = jobCondition(found.body);
      if (everyRun && cond) problems.push(`${file} says the \`${job}\` job runs on every PR/push but it carries \`if: ${cond}\``);
      if (scheduledOnly) {
        if (!cond) problems.push(`${file} says the \`${job}\` job runs only on schedule/manual dispatch but it has no \`if:\``);
        else if (!/schedule|workflow_dispatch/.test(cond) || /!=/.test(cond)) problems.push(`${file} says the \`${job}\` job runs only on schedule/manual dispatch but its \`if: ${cond}\` does not select those events`);
        if (!trig.dispatch) problems.push(`${file} describes manual dispatch for the \`${job}\` job but links.yml does not declare \`workflow_dispatch\``);
        if (!trig.schedule) problems.push(`${file} describes a schedule for the \`${job}\` job but links.yml declares no \`schedule\` trigger`);
      }
    }

    if (cron) {
      for (const m of text.matchAll(/\b([01]\d|2[0-3]):([0-5]\d)\s+UTC\b/g)) {
        if (`${m[1]}:${m[2]}` !== `${cron.hour}:${cron.minute}`) problems.push(`${file} says ${m[0]} but the cron runs at ${cron.hour}:${cron.minute} UTC`);
      }
      for (const m of text.matchAll(new RegExp(`\\b(${DAYS.join("|")})\\b`, "g"))) {
        if (m[1] !== cron.day) problems.push(`${file} says ${m[1]} but the cron runs on ${cron.day}`);
      }
    }

    for (const m of text.matchAll(/scripts\/check-links\.sh\s+\[?(--[\w-]+)/g)) {
      if (flag && m[1] !== flag) problems.push(`${file} documents \`${m[1]}\` for scripts/check-links.sh but links.yml passes \`${flag}\``);
    }
    for (const m of text.matchAll(/(--external-[\w-]+)/g)) {
      if (flag && m[1] !== flag) problems.push(`${file} mentions \`${m[1]}\` but the flag is \`${flag}\``);
    }
  }

  // A parser that silently stops matching must not turn the gate vacuous.
  const readme = docs["README.md"];
  if (readme !== undefined) {
    if (!/\*\*[^*]+\*\* workflow\b/.test(readme.replace(/\s+/g, " "))) problems.push("README.md no longer names the workflow as a bold \"**<name>** workflow\"");
    if (!jobClaims(readme.replace(/\*\*/g, "")).length) problems.push("README.md names no job in a \"`x` job\" / \"jobs `a`, `b` and `c`\" phrase");
    if (!/\b\d\d:\d\d\s+UTC\b/.test(readme)) problems.push("README.md states no \"HH:MM UTC\" schedule time");
  }
  return problems;
}

// --- fixtures ---------------------------------------------------------------

const YAML = `name: Link check

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "17 9 * * 1"
  workflow_dispatch:

jobs:
  availability:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - run: curl https://a.test/

  links:
    runs-on: ubuntu-latest
    steps:
      - name: Check links
        run: scripts/check-links.sh \${{ (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && '' || '--external-warn' }}

  test:
    runs-on: ubuntu-latest
    steps:
      - run: node --test scripts/*.test.mjs

  redirects:
    runs-on: ubuntu-latest
    steps:
      - run: scripts/check-redirects.sh
`;

const SCRIPT = '#!/usr/bin/env bash\nif [[ "${1:-}" == "--external-warn" ]]; then\n  X=1\nfi\n';

const README = `# Site

## Checks

The **Link check** workflow (\`.github/workflows/links.yml\`) runs its \`links\`, \`test\` and
\`redirects\` jobs on every pull request and on every push to \`main\`.

- \`scripts/check-links.sh [--external-warn]\` — CI runs it with \`--external-warn\` on PRs.

## Availability monitoring

The **Link check** workflow runs every Monday at 09:17 UTC and can also be run
manually. On those runs, its separate \`availability\` job probes the live site.
`;

const RUNBOOK = `Intro. The **Link check** workflow runs on every PR and push to \`main\`, with jobs \`links\`, \`test\`, and \`redirects\` that validate things. The workflow's separate \`availability\` job probes the live site but runs only on the weekly schedule (Monday 09:17 UTC) and manual dispatch.

**Note: the \`availability\` job did not run on that push** (it only runs weekly on Monday or via manual dispatch).
`;

const DOCS = { "README.md": README, "runbooks/release-rollback.md": RUNBOOK };
const problems = (over = {}) => docProblems(over.yaml ?? YAML, { docs: over.docs ?? DOCS, checkLinks: over.checkLinks ?? SCRIPT });
const withDocs = (readme, runbook = RUNBOOK) => ({ docs: { "README.md": readme, "runbooks/release-rollback.md": runbook } });

test("fixture: workflow name, jobs, conditions, triggers, cron and flags are parsed", () => {
  assert.equal(workflowName(YAML), "Link check");
  const jobs = workflowJobs(YAML);
  assert.deepEqual(jobs.map((j) => j.name), ["availability", "links", "test", "redirects"]);
  assert.equal(jobCondition(jobs[0].body), "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
  assert.equal(jobCondition(jobs[2].body), undefined);
  assert.deepEqual(triggers(YAML), { dispatch: true, schedule: true, cron: "17 9 * * 1" });
  assert.deepEqual(parseWeeklyCron("17 9 * * 1"), { minute: "17", hour: "09", day: "Monday" });
  assert.deepEqual(parseWeeklyCron("0 14 * * 0"), { minute: "00", hour: "14", day: "Sunday" });
  assert.equal(parseWeeklyCron("*/5 * * * *"), undefined);
  assert.equal(conditionalFlag(jobs[1].body), "--external-warn");
  assert.equal(conditionalFlag(jobs[2].body), undefined);
  assert.equal(acceptedFlag(SCRIPT), "--external-warn");
  assert.deepEqual(workflowJobs("name: x\n"), []);
});

test("fixture: job phrases are extracted with their run-condition context", () => {
  const claims = jobClaims(RUNBOOK.replace(/\*\*/g, ""));
  const by = (j) => claims.filter((c) => c.job === j);
  assert.ok(by("links").every((c) => c.everyRun && !c.scheduledOnly));
  assert.deepEqual(by("redirects").map((c) => c.everyRun), [true]);
  assert.ok(by("availability").length === 2 && by("availability").every((c) => c.scheduledOnly && !c.everyRun));
  const readme = jobClaims(README.replace(/\*\*/g, ""));
  assert.deepEqual(readme.map((c) => c.job), ["links", "test", "redirects", "availability"]);
  assert.deepEqual(readme.map((c) => c.everyRun), [true, true, true, false]);
});

test("fixture: consistent docs and workflow pass", () => {
  assert.deepEqual(problems(), []);
});

test("fixture: a renamed workflow is reported", () => {
  const p = problems({ yaml: YAML.replace("name: Link check", "name: Site checks") });
  assert.ok(p.includes('README.md calls the workflow "Link check" but links.yml is named "Site checks"'), p.join("\n"));
  assert.ok(p.some((x) => x.startsWith("runbooks/release-rollback.md calls the workflow")));
});

test("fixture: a job named in the docs but missing from the workflow is reported", () => {
  const p = problems({ yaml: YAML.replace("  redirects:", "  redirect-check:") });
  assert.ok(p.some((x) => x.startsWith("README.md names a `redirects` job that links.yml does not define")), p.join("\n"));
  assert.ok(p.some((x) => x.startsWith("runbooks/release-rollback.md names a `redirects` job")));
});

test("fixture: a job the docs say runs on every PR/push but is gated is reported", () => {
  const p = problems({ yaml: YAML.replace("  test:\n    runs-on", "  test:\n    if: github.event_name == 'push'\n    runs-on") });
  assert.ok(p.some((x) => x.includes("the `test` job runs on every PR/push but it carries `if: github.event_name == 'push'`")), p.join("\n"));
});

test("fixture: a scheduled-only job that is unconditional or gated on other events is reported", () => {
  const open = problems({ yaml: YAML.replace(/    if: github\.event_name == 'schedule'[^\n]*\n/, "") });
  assert.ok(open.some((x) => x.includes("the `availability` job runs only on schedule/manual dispatch but it has no `if:`")), open.join("\n"));
  const wrong = problems({ yaml: YAML.replace(/    if: github\.event_name == 'schedule'[^\n]*\n/, "    if: github.event_name == 'push'\n") });
  assert.ok(wrong.some((x) => x.includes("does not select those events")), wrong.join("\n"));
  const negated = problems({ yaml: YAML.replace(/    if: github\.event_name == 'schedule'[^\n]*\n/, "    if: github.event_name != 'schedule'\n") });
  assert.ok(negated.some((x) => x.includes("does not select those events")), negated.join("\n"));
});

test("fixture: manual dispatch described but not declared, and a missing schedule, are reported", () => {
  const noDispatch = problems({ yaml: YAML.replace("  workflow_dispatch:\n", "") });
  assert.ok(noDispatch.some((x) => x.includes("does not declare `workflow_dispatch`")), noDispatch.join("\n"));
  const noSchedule = problems({ yaml: YAML.replace('  schedule:\n    - cron: "17 9 * * 1"\n', "") });
  assert.ok(noSchedule.some((x) => x.includes("declares no `schedule` trigger")), noSchedule.join("\n"));
  assert.ok(noSchedule.some((x) => x.startsWith("links.yml has no plain weekly `cron:`")));
});

test("fixture: a weekday or UTC time that disagrees with the cron is reported", () => {
  const day = problems({ yaml: YAML.replace("17 9 * * 1", "17 9 * * 2") });
  assert.ok(day.includes("README.md says Monday but the cron runs on Tuesday"), day.join("\n"));
  assert.ok(day.includes("runbooks/release-rollback.md says Monday but the cron runs on Tuesday"));
  const time = problems({ yaml: YAML.replace("17 9 * * 1", "30 6 * * 1") });
  assert.ok(time.includes("README.md says 09:17 UTC but the cron runs at 06:30 UTC"), time.join("\n"));
  assert.ok(time.includes("runbooks/release-rollback.md says 09:17 UTC but the cron runs at 06:30 UTC"));
});

test("fixture: the --external-warn flag must be passed conditionally by `links` and accepted by check-links.sh", () => {
  const renamed = problems({ yaml: YAML.replace("'--external-warn'", "'--warn-external'") });
  assert.ok(renamed.some((x) => x.includes("mentions `--external-warn` but the flag is `--warn-external`")), renamed.join("\n"));
  assert.ok(renamed.some((x) => x.includes("documents `--external-warn` for scripts/check-links.sh but links.yml passes `--warn-external`")));
  assert.ok(renamed.some((x) => x.includes("passes `--warn-external` but scripts/check-links.sh accepts `--external-warn`")));
  const unconditional = problems({ yaml: YAML.replace(/\$\{\{.*\}\}/, "--external-warn") });
  assert.ok(unconditional.some((x) => x.includes("does not pass a flag to scripts/check-links.sh conditionally")), unconditional.join("\n"));
  const script = problems({ checkLinks: SCRIPT.replace("--external-warn", "--warn") });
  assert.deepEqual(script, ["the `links` job passes `--external-warn` but scripts/check-links.sh accepts `--warn`"]);
});

test("fixture: a README the parser can no longer read is reported instead of passing vacuously", () => {
  const p = problems(withDocs("# Site\n\n## Checks\n\nNothing here.\n"));
  assert.ok(p.some((x) => x.includes("no longer names the workflow")), p.join("\n"));
  assert.ok(p.some((x) => x.includes("names no job")));
  assert.ok(p.some((x) => x.includes("no \"HH:MM UTC\"")));
});

// --- live checks over the committed tree ------------------------------------

const yaml = readFileSync(WORKFLOW, "utf8");
const docs = { "README.md": readFileSync(join(ROOT, "README.md"), "utf8") };
for (const n of readdirSync(RUNBOOKS).filter((f) => f.endsWith(".md")).sort()) docs[`runbooks/${n}`] = readFileSync(join(RUNBOOKS, n), "utf8");

test("README.md and runbooks/*.md agree with links.yml (name, jobs, run conditions, schedule, --external-warn)", () => {
  assert.deepEqual(docProblems(yaml, { docs, checkLinks: readFileSync(CHECK_LINKS, "utf8") }), [], "fix the prose to match the workflow, or update both deliberately");
});
