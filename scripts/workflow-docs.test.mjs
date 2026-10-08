#!/usr/bin/env node
// Static gate keeping what README.md and runbooks/*.md say about
// .github/workflows/links.yml in step with the workflow itself. The runbook is
// the page an operator opens during an incident, and it makes concrete claims:
// which jobs exist, which run on every PR/push and which only on the weekly
// schedule or manual dispatch, what day and time that schedule fires, and that
// `--external-warn` is the flag CI passes to the link checker. None of those
// claims is checked by ci-wiring.test.mjs (it gates scripts, not prose), and
// #141 had to hand-correct the runbook after it said the availability probe
// ran per-PR. Each rule has a fixture self-test. Zero dependencies.
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
const DOCS = [join(ROOT, "README.md"), ...readdirSync(join(ROOT, "runbooks")).filter((n) => n.endsWith(".md")).sort().map((n) => join(ROOT, "runbooks", n))];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// --- workflow parsing ---------------------------------------------------------

export function workflowFacts(yaml) {
  const name = /^name:[ \t]*(.+?)[ \t]*$/m.exec(yaml)?.[1] ?? null;
  const on = /^on:\s*$([\s\S]*?)(?=^\S)/m.exec(yaml)?.[1] ?? "";
  const triggers = [...on.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
  const cron = /^\s+-\s*cron:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(on)?.[1] ?? null;
  const jobsBlock = /^jobs:\s*$([\s\S]*)/m.exec(yaml)?.[1] ?? "";
  const jobs = {};
  for (const m of jobsBlock.matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$([\s\S]*?)(?=^\s{2}[A-Za-z0-9_-]+:\s*$|(?![\s\S]))/gm)) {
    const body = m[2];
    const cond = /^\s{4}if:[ \t]*(.+?)[ \t]*$/m.exec(body)?.[1] ?? null;
    const runs = [...body.matchAll(/^\s*(?:-\s+)?run:[ \t]*(.*)$/gm)].map((r) => r[1].trim());
    jobs[m[1]] = { cond, runs };
  }
  return { name, triggers, cron, jobs };
}

// "17 9 * * 1" -> { weekday: "Monday", time: "09:17" }; null for anything
// this gate cannot express as one weekday and one wall-clock time.
export function cronSlot(cron) {
  const parts = (cron ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour) || dom !== "*" || mon !== "*" || !/^[0-7]$/.test(dow)) return null;
  const weekday = WEEKDAYS[Number(dow) % 7];
  return { weekday, time: `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` };
}

// --- doc parsing ----------------------------------------------------------------

// Paragraphs (blank-line separated, list items joined with their continuation
// lines) that talk about the workflow at all.
export function paragraphs(md) {
  return md.split(/\n[ \t]*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// Sentences of a normalised paragraph. A period inside backticks or a
// parenthesis does not end a sentence, and a trailing "(...)" stays with it.
export function sentences(paragraph) {
  return paragraph.split(/(?<=[.!?])\s+(?=[A-Z*`])/).map((s) => s.trim()).filter(Boolean);
}

// Job identifiers a sentence or paragraph names as jobs: "`x` job", "job `x`",
// "jobs `a`, `b` and `c`", "its `a`, `b` and `c` jobs".
export function jobMentions(paragraph) {
  const out = new Set();
  const seq = "`[a-z0-9_-]+`(?:\\s*,\\s*`[a-z0-9_-]+`)*(?:\\s*,?\\s*(?:and|or)\\s*`[a-z0-9_-]+`)?";
  const re = new RegExp(`(?:\\bjobs?\\s+(${seq}))|((${seq})\\s+jobs?\\b)`, "gi");
  for (const m of paragraph.matchAll(re)) {
    for (const id of (m[1] ?? m[3]).matchAll(/`([a-z0-9_-]+)`/g)) out.add(id[1]);
  }
  return [...out];
}

const PER_PR = /\b(every|each|all)\b[^.]*\b(pull requests?|PRs?)\b|\bon (pull requests?|PRs?) and (on )?(every )?push(es)?\b|\bper[- ]PR\b/i;
const SCHEDULED_ONLY = /\bonly\b[^.]*\b(schedule[sd]?|weekly|manual(ly)?|dispatch)\b|\b(schedule[sd]?|weekly|manual(ly)?|dispatch)\b[^.]*\bonly\b|\bweekly (schedule[sd]?|run|probe)\b|\bscheduled\b|\bdid not run on that push\b/i;

// --- rules ---------------------------------------------------------------------

export function docProblems(doc, md, facts) {
  const problems = [];
  const slot = cronSlot(facts.cron);
  const jobNames = Object.keys(facts.jobs);
  const gated = (j) => facts.jobs[j]?.cond != null;
  const condMentions = (j, ev) => new RegExp(`event_name\\s*==\\s*'${ev}'`).test(facts.jobs[j]?.cond ?? "");

  for (const p of paragraphs(md)) {
    for (const m of p.matchAll(/\*\*([^*]+)\*\* workflow/g)) {
      if (m[1] !== facts.name) problems.push(`${doc}: names the workflow **${m[1]}** but links.yml is named "${facts.name}"`);
    }
    // Gating claims are judged per sentence: one paragraph routinely says
    // "`links`, `test` and `redirects` run on every PR" and then "the
    // `availability` job runs only on the weekly schedule".
    for (const s of sentences(p)) {
      for (const j of jobMentions(s)) {
        if (!jobNames.includes(j)) { problems.push(`${doc}: names a \`${j}\` job that links.yml does not define (jobs: ${jobNames.join(", ")})`); continue; }
        const claimsScheduled = SCHEDULED_ONLY.test(s);
        const claimsPerPr = PER_PR.test(s) && !claimsScheduled;
        if (claimsPerPr && gated(j)) problems.push(`${doc}: says the \`${j}\` job runs on every PR/push but links.yml gates it with \`if: ${facts.jobs[j].cond}\``);
        if (claimsScheduled && !gated(j)) problems.push(`${doc}: says the \`${j}\` job runs only on schedule/dispatch but links.yml runs it unconditionally`);
        if (claimsScheduled && gated(j)) {
          if (/\b(weekly|schedule[sd]?)\b/i.test(s) && !condMentions(j, "schedule")) problems.push(`${doc}: says the \`${j}\` job runs on the schedule but its \`if:\` never tests for 'schedule'`);
          if (/\b(manual(ly)?|dispatch)\b/i.test(s) && !condMentions(j, "workflow_dispatch")) problems.push(`${doc}: says the \`${j}\` job can be run manually but its \`if:\` never tests for 'workflow_dispatch'`);
        }
      }
    }
    const talksAboutWorkflow = /\bworkflow\b|\blinks\.yml\b|\bjobs?\b|\bprobe\b|\bscheduled? run\b/i.test(p);
    if (!talksAboutWorkflow) continue;
    for (const m of p.matchAll(/\b(\d{1,2}:\d{2})\s*UTC\b/g)) {
      if (!slot) problems.push(`${doc}: cites a run time of ${m[1]} UTC but links.yml has no single-slot cron (${facts.cron ?? "none"})`);
      else if (m[1].padStart(5, "0") !== slot.time) problems.push(`${doc}: says the workflow runs at ${m[1]} UTC but the cron "${facts.cron}" fires at ${slot.time} UTC`);
    }
    for (const m of p.matchAll(new RegExp(`\\b(${WEEKDAYS.join("|")})s?\\b`, "g"))) {
      if (!slot) problems.push(`${doc}: cites ${m[1]} as a run day but links.yml has no single-slot cron (${facts.cron ?? "none"})`);
      else if (m[1] !== slot.weekday) problems.push(`${doc}: says the workflow runs on ${m[1]} but the cron "${facts.cron}" fires on ${slot.weekday}`);
    }
    if (/\b(manual(ly)?|dispatch|Run workflow)\b/i.test(p) && !facts.triggers.includes("workflow_dispatch")) problems.push(`${doc}: says the workflow can be run manually but links.yml declares no workflow_dispatch trigger`);
    if (/\b(weekly|schedule[sd]?)\b/i.test(p) && !facts.triggers.includes("schedule")) problems.push(`${doc}: describes a scheduled run but links.yml declares no schedule trigger`);
  }
  return problems;
}

// `--external-warn` must be the flag README documents, the flag the `links`
// job passes only outside schedule/dispatch, and the flag check-links.sh reads.
export function externalWarnProblems(readme, facts, checkLinksSh) {
  const problems = [];
  if (!/`--external-warn`/.test(readme)) return problems;
  if (!/"\$\{1:-\}"\s*==\s*"--external-warn"|--external-warn\)/.test(checkLinksSh)) problems.push("README.md documents `--external-warn` but scripts/check-links.sh does not read that flag");
  const links = facts.jobs.links;
  if (!links) { problems.push("README.md documents `--external-warn` for the `links` job but links.yml has no `links` job"); return problems; }
  const run = links.runs.find((r) => r.includes("scripts/check-links.sh"));
  if (!run) { problems.push("links.yml `links` job never runs scripts/check-links.sh"); return problems; }
  if (!run.includes("--external-warn")) problems.push("README.md says CI passes `--external-warn` but the `links` job's check-links step does not");
  else if (!/event_name\s*==\s*'schedule'/.test(run) || !/event_name\s*==\s*'workflow_dispatch'/.test(run)) problems.push("README.md says schedule/dispatch runs hard-fail on external links, but the `links` step does not switch on both 'schedule' and 'workflow_dispatch'");
  return problems;
}

// --- fixtures --------------------------------------------------------------------

const YAML = `name: Link check

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "17 9 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  availability:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - name: probe
        run: |
          curl https://a.test/

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

const DOC_OK = `# Site

The **Link check** workflow runs its \`links\`, \`test\` and
\`redirects\` jobs on every pull request and on every push to \`main\`.

- \`scripts/check-links.sh [--external-warn]\` — CI runs it with \`--external-warn\` on PRs.

The **Link check** workflow runs every Monday at 09:17 UTC and can also be run
manually from the Actions tab. On those runs, its separate \`availability\` job
probes the live site.

**Note: the \`availability\` job did not run on that push** (it only runs
weekly on Monday or via manual dispatch).
`;

const SH_OK = 'if [[ "${1:-}" == "--external-warn" ]]; then\n  WARN=1\nfi\n';

test("fixture: workflow name, triggers, cron and per-job if:/run: are parsed", () => {
  const f = workflowFacts(YAML);
  assert.equal(f.name, "Link check");
  assert.deepEqual(f.triggers, ["push", "pull_request", "schedule", "workflow_dispatch"]);
  assert.equal(f.cron, "17 9 * * 1");
  assert.deepEqual(Object.keys(f.jobs), ["availability", "links", "test", "redirects"]);
  assert.match(f.jobs.availability.cond, /schedule/);
  assert.equal(f.jobs.links.cond, null);
  assert.equal(f.jobs.links.runs.length, 1);
  assert.match(f.jobs.links.runs[0], /--external-warn/);
});

test("fixture: cron expressions reduce to one weekday and time, or null", () => {
  assert.deepEqual(cronSlot("17 9 * * 1"), { weekday: "Monday", time: "09:17" });
  assert.deepEqual(cronSlot("0 0 * * 7"), { weekday: "Sunday", time: "00:00" });
  assert.deepEqual(cronSlot("5 4 * * 0"), { weekday: "Sunday", time: "04:05" });
  assert.equal(cronSlot("17 9 * * *"), null, "daily");
  assert.equal(cronSlot("17 9 1 * 1"), null, "day-of-month set");
  assert.equal(cronSlot("*/5 9 * * 1"), null, "step minute");
  assert.equal(cronSlot("17 9 * * 1,3"), null, "two days");
  assert.equal(cronSlot(null), null);
});

test("fixture: job mentions are extracted from every phrasing the docs use", () => {
  assert.deepEqual(jobMentions("runs its `links`, `test` and `redirects` jobs on every PR"), ["links", "test", "redirects"]);
  assert.deepEqual(jobMentions("with jobs `links`, `test`, and `redirects` that validate"), ["links", "test", "redirects"]);
  assert.deepEqual(jobMentions("its separate `availability` job probes"), ["availability"]);
  assert.deepEqual(jobMentions("the `availability` job did not run"), ["availability"]);
  assert.deepEqual(jobMentions("remain warnings in the separate `links` job."), ["links"]);
  assert.deepEqual(jobMentions("the `links` or `redirects` job"), ["links", "redirects"]);
  assert.deepEqual(jobMentions("run `scripts/check-links.sh` and `make-redirects.sh`"), [], "paths are not jobs");
  assert.deepEqual(jobMentions("the `test` step"), [], "steps are not jobs");
});

test("fixture: sentences split on terminal punctuation, not on periods inside code or parentheses", () => {
  const p = paragraphs("Runs on every push to `main`. The `availability` job runs only weekly (see `links.yml`). Done.\n")[0];
  assert.deepEqual(sentences(p), ["Runs on every push to `main`.", "The `availability` job runs only weekly (see `links.yml`).", "Done."]);
  const note = paragraphs("**Note: the `availability` job did not run on that push** (it only runs\nweekly on Monday or via manual dispatch). Trigger a fresh probe.\n")[0];
  assert.deepEqual(sentences(note), ["**Note: the `availability` job did not run on that push** (it only runs weekly on Monday or via manual dispatch).", "Trigger a fresh probe."]);
  const mixed = paragraphs("The workflow runs its `links` and `test` jobs on every PR, with the `availability` job running only on the weekly schedule.\n")[0];
  assert.equal(sentences(mixed).length, 1, "one sentence that mixes claims is judged as a whole");
});

test("fixture: a doc that agrees with the workflow passes", () => {
  assert.deepEqual(docProblems("doc.md", DOC_OK, workflowFacts(YAML)), []);
});

test("fixture: an unknown job, a renamed workflow and a renamed job are reported", () => {
  const f = workflowFacts(YAML);
  assert.ok(docProblems("doc.md", DOC_OK.replace("`redirects` jobs", "`redirect` jobs"), f).some((p) => p.includes("names a `redirect` job that links.yml does not define")));
  assert.ok(docProblems("doc.md", DOC_OK.replace(/\*\*Link check\*\*/g, "**Links**"), f).some((p) => p.includes("names the workflow **Links**")));
  const renamed = workflowFacts(YAML.replace("  availability:\n", "  live:\n"));
  assert.ok(docProblems("doc.md", DOC_OK, renamed).some((p) => p.includes("names a `availability` job that links.yml does not define")));
});

test("fixture: a job described as per-PR but gated, or as scheduled-only but unconditional, is reported", () => {
  const gatedLinks = workflowFacts(YAML.replace("  links:\n    runs-on", "  links:\n    if: github.event_name == 'schedule'\n    runs-on"));
  assert.ok(docProblems("doc.md", DOC_OK, gatedLinks).some((p) => p.includes("says the `links` job runs on every PR/push but links.yml gates it")));
  const openAvailability = workflowFacts(YAML.replace("    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'\n", ""));
  const problems = docProblems("doc.md", DOC_OK, openAvailability);
  assert.ok(problems.some((p) => p.includes("says the `availability` job runs only on schedule/dispatch but links.yml runs it unconditionally")));
  // This is the drift #141 corrected by hand: the runbook said the probe ran on the push.
  const runbookDrift = DOC_OK.replace("**Note: the `availability` job did not run on that push** (it only runs\nweekly on Monday or via manual dispatch).", "The `availability` job already ran on every push and each pull request, so the live site was probed.");
  assert.ok(docProblems("doc.md", runbookDrift, workflowFacts(YAML)).some((p) => p.includes("says the `availability` job runs on every PR/push but links.yml gates it")));
});

test("fixture: a gated job's if: must test the events the docs promise", () => {
  const scheduleOnly = workflowFacts(YAML.replace("if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", "if: github.event_name == 'schedule'"));
  const problems = docProblems("doc.md", DOC_OK, scheduleOnly);
  assert.ok(problems.some((p) => p.includes("can be run manually but its `if:` never tests for 'workflow_dispatch'")));
  const dispatchOnly = workflowFacts(YAML.replace("if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", "if: github.event_name == 'workflow_dispatch'"));
  assert.ok(docProblems("doc.md", DOC_OK, dispatchOnly).some((p) => p.includes("runs on the schedule but its `if:` never tests for 'schedule'")));
});

test("fixture: a wrong weekday or time, a non-single-slot cron, and missing triggers are reported", () => {
  const f = workflowFacts(YAML);
  assert.ok(docProblems("doc.md", DOC_OK.replace("09:17 UTC", "9:17 UTC"), f).length === 0, "unpadded hour is the same time");
  assert.ok(docProblems("doc.md", DOC_OK.replace("09:17 UTC", "09:30 UTC"), f).some((p) => p.includes("runs at 09:30 UTC but the cron")));
  assert.ok(docProblems("doc.md", DOC_OK.replace("every Monday", "every Tuesday"), f).some((p) => p.includes("runs on Tuesday but the cron")));
  const moved = workflowFacts(YAML.replace('"17 9 * * 1"', '"30 6 * * 3"'));
  const problems = docProblems("doc.md", DOC_OK, moved);
  assert.ok(problems.some((p) => p.includes("fires at 06:30 UTC")));
  assert.ok(problems.some((p) => p.includes("fires on Wednesday")));
  const daily = workflowFacts(YAML.replace('"17 9 * * 1"', '"17 9 * * *"'));
  assert.ok(docProblems("doc.md", DOC_OK, daily).some((p) => p.includes("has no single-slot cron")));
  const noDispatch = workflowFacts(YAML.replace("  workflow_dispatch:\n", ""));
  assert.ok(docProblems("doc.md", DOC_OK, noDispatch).some((p) => p.includes("declares no workflow_dispatch trigger")));
  const noSchedule = workflowFacts(YAML.replace('  schedule:\n    - cron: "17 9 * * 1"\n', ""));
  assert.ok(docProblems("doc.md", DOC_OK, noSchedule).some((p) => p.includes("declares no schedule trigger")));
});

test("fixture: a weekday in prose unrelated to the workflow is not a claim", () => {
  const md = "# Notes\n\nThe community call is on Thursday.\n";
  assert.deepEqual(docProblems("doc.md", md, workflowFacts(YAML)), []);
});

test("fixture: --external-warn must be wired in links.yml and read by check-links.sh", () => {
  const f = workflowFacts(YAML);
  assert.deepEqual(externalWarnProblems(DOC_OK, f, SH_OK), []);
  assert.deepEqual(externalWarnProblems("# no flag documented\n", f, ""), [], "nothing claimed, nothing checked");
  assert.ok(externalWarnProblems(DOC_OK, f, "set -e\n").some((p) => p.includes("check-links.sh does not read that flag")));
  const plain = workflowFacts(YAML.replace(/run: scripts\/check-links\.sh .*\n/, "run: scripts/check-links.sh\n"));
  assert.ok(externalWarnProblems(DOC_OK, plain, SH_OK).some((p) => p.includes("does not")));
  const scheduleOnly = workflowFacts(YAML.replace("(github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && ''", "github.event_name == 'schedule' && ''"));
  assert.ok(externalWarnProblems(DOC_OK, scheduleOnly, SH_OK).some((p) => p.includes("does not switch on both")));
  const noLinks = workflowFacts(YAML.replace("  links:\n", "  linkcheck:\n"));
  assert.ok(externalWarnProblems(DOC_OK, noLinks, SH_OK).some((p) => p.includes("has no `links` job")));
});

// --- live checks over the committed tree ---------------------------------------

const facts = workflowFacts(readFileSync(WORKFLOW, "utf8"));
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

test("links.yml: has a name, a single-slot weekly cron, and schedule + workflow_dispatch triggers the docs can describe", () => {
  assert.ok(facts.name, "workflow has no name:");
  assert.ok(cronSlot(facts.cron), `cron "${facts.cron}" is not one weekday at one time; update README/runbook wording and this gate together`);
  assert.ok(facts.triggers.includes("schedule") && facts.triggers.includes("workflow_dispatch"));
});

for (const doc of DOCS) {
  const rel = doc.slice(ROOT.length + 1);
  test(`${rel}: every claim about the Link check workflow (name, jobs, gating, weekday/time, manual runs) matches links.yml`, () => {
    assert.deepEqual(docProblems(rel, readFileSync(doc, "utf8"), facts), []);
  });
}

test("README.md: the `--external-warn` story matches the `links` job and scripts/check-links.sh", () => {
  assert.deepEqual(externalWarnProblems(readme, facts, readFileSync(CHECK_LINKS, "utf8")), []);
});

test("README.md and runbooks name every job links.yml defines at least once (an undocumented job is unexplained to the operator)", () => {
  const mentioned = new Set(DOCS.flatMap((d) => paragraphs(readFileSync(d, "utf8")).flatMap(jobMentions)));
  assert.deepEqual(Object.keys(facts.jobs).filter((j) => !mentioned.has(j)), []);
});
