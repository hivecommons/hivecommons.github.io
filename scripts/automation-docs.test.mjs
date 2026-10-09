#!/usr/bin/env node
// Static gate keeping the prose about every workflow under .github/workflows/ honest.
// README.md (## Checks, ## Repository automation) and runbooks/*.md introduce each
// workflow as "**<name>** … (`.github/workflows/<file>`)" and then say when it runs:
// on every push to `main`, on every pull request, weekly on a `cron`, on manual
// dispatch, when a PR transitions to `closed`, publishing to code scanning. Nothing
// else compares that paragraph with the workflow, and workflow-docs.test.mjs reads
// links.yml only, so renaming scorecard.yml, moving its cron or changing the
// linked-issue trigger leaves the README describing automation that no longer runs.
// Every committed workflow must also be introduced that way in README.md, so a new
// automation cannot land undocumented. Each rule has a fixture self-test. Zero
// dependencies. Usage: node --test scripts/automation-docs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const RUNBOOKS = join(ROOT, "runbooks");

// GitHub's pull_request activity types, so a back-ticked word in a PR sentence can be
// told apart from a job or branch name.
const PR_ACTIVITY = new Set([
  "assigned", "unassigned", "labeled", "unlabeled", "opened", "edited", "closed", "reopened",
  "synchronize", "converted_to_draft", "locked", "unlocked", "enqueued", "dequeued", "milestoned",
  "demilestoned", "ready_for_review", "review_requested", "review_request_removed", "auto_merge_enabled",
  "auto_merge_disabled",
]);
const SARIF_UPLOAD = "github/codeql-action/upload-sarif";

// --- workflow parsing ----------------------------------------------------------

export function workflowName(yaml) {
  return /^name:[ \t]*["']?([^"'\r\n#]+?)["']?[ \t]*$/m.exec(yaml)?.[1];
}

// The body of a top-level `key:` block (lines indented under it).
function topBlock(yaml, key) {
  return new RegExp(`^${key}:[ \\t]*$([\\s\\S]*?)(?=^\\S|(?![\\s\\S]))`, "m").exec(yaml)?.[1];
}

// The body of a two-space-indented `key:` block inside `on:`, "" for a bare `key:`
// and undefined when the key is absent.
function onEntry(on, key) {
  const m = new RegExp(`^\\s{2}${key}:[ \\t]*(\\S.*)?$([\\s\\S]*?)(?=^\\s{2}\\S|(?![\\s\\S]))`, "m").exec(on ?? "");
  if (!m) return undefined;
  return (m[1] ?? "") + (m[2] ?? "");
}

// `key: [a, b]` or a `key:` list, within one `on:` entry body; undefined when absent.
function listUnder(body, key) {
  const m = new RegExp(`^\\s*${key}:[ \\t]*(?:\\[([^\\]]*)\\]|$((?:\\n\\s*-\\s*[^\\n]+)+))`, "m").exec(body ?? "");
  if (!m) return undefined;
  const raw = m[1] !== undefined ? m[1].split(",") : m[2].split("\n").map((l) => l.replace(/^\s*-\s*/, ""));
  return raw.map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

export function workflowTriggers(yaml) {
  const on = topBlock(yaml, "on");
  const push = onEntry(on, "push");
  const pr = onEntry(on, "pull_request");
  const schedule = onEntry(on, "schedule");
  return {
    push: push !== undefined,
    pushBranches: listUnder(push, "branches"),
    pullRequest: pr !== undefined,
    pullRequestTypes: listUnder(pr, "types"),
    dispatch: onEntry(on, "workflow_dispatch") !== undefined,
    schedule: schedule !== undefined,
    cron: /^\s*-\s*cron:\s*["']?([^"'\r\n#]+?)["']?\s*$/m.exec(schedule ?? "")?.[1],
  };
}

export function isWeeklyCron(cron) {
  return /^\d{1,2}\s+\d{1,2}\s+\*\s+\*\s+[0-7]$/.test((cron ?? "").trim());
}

export function usedActions(yaml) {
  return [...yaml.matchAll(/^\s*-?\s*uses:\s*["']?([^\s"'@#]+)/gm)].map((m) => m[1]);
}

// --- doc parsing -----------------------------------------------------------------

// Each "**<name>** … (`.github/workflows/<file>`)" introduction with the paragraph it
// opens (text up to the next blank line, whitespace collapsed).
export function workflowReferences(text) {
  const out = [];
  const re = /\*\*([^*\n]+?)\*\*[^\n*]{0,60}?\(`(\.github\/workflows\/([\w.-]+\.ya?ml))`\)/g;
  for (const m of text.matchAll(re)) {
    const start = text.lastIndexOf("\n\n", m.index) + 1;
    let end = text.indexOf("\n\n", m.index + m[0].length);
    if (end === -1) end = text.length;
    out.push({ name: m[1].trim(), path: m[2], file: m[3], paragraph: text.slice(start, end).replace(/\s+/g, " ").trim() });
  }
  return out;
}

export function claims(paragraph) {
  const p = paragraph;
  const sentenceWithPR = /\b(?:pull requests?|PRs?)\b/i.test(p);
  const prTypes = [...p.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((w) => PR_ACTIVITY.has(w));
  return {
    pushMain: /\bpush(?:es)? to `main`/i.test(p),
    everyPR: /\bevery (?:pull request|PR)\b/i.test(p),
    weekly: /\bweekly\b/i.test(p),
    cron: /\bcron\s+`([^`]+)`/i.exec(p)?.[1],
    dispatch: /\bmanual(?:ly)?\b.{0,20}\bdispatch\b|\bworkflow_dispatch\b|\brun manually\b/i.test(p),
    prTypes: sentenceWithPR ? [...new Set(prTypes)] : [],
    codeScanning: /\bcode scanning\b/i.test(p),
  };
}

// --- rules -----------------------------------------------------------------------

// docs: { "README.md": text, "runbooks/x.md": text }; workflows: { "links.yml": yaml }.
export function automationDocProblems({ docs, workflows }) {
  const problems = [];
  const referenced = new Set();
  let total = 0;
  for (const [doc, text] of Object.entries(docs)) {
    for (const ref of workflowReferences(text)) {
      total++;
      const yaml = workflows[ref.file];
      const where = `${doc} introduces **${ref.name}** (\`${ref.path}\`)`;
      if (yaml === undefined) {
        problems.push(`${where} but no such workflow is committed (have: ${Object.keys(workflows).sort().join(", ") || "none"})`);
        continue;
      }
      referenced.add(ref.file);
      const name = workflowName(yaml);
      if (name !== ref.name) problems.push(`${where} but the workflow is named "${name ?? "<none>"}"`);
      const t = workflowTriggers(yaml);
      const c = claims(ref.paragraph);
      if (c.pushMain && !(t.push && (t.pushBranches === undefined || t.pushBranches.includes("main")))) {
        problems.push(`${where} as running on push to \`main\` but it declares ${t.push ? `push.branches: [${(t.pushBranches ?? []).join(", ")}]` : "no `push` trigger"}`);
      }
      if (c.everyPR && !t.pullRequest) problems.push(`${where} as running on every pull request but it declares no \`pull_request\` trigger`);
      if (c.weekly) {
        if (!t.schedule) problems.push(`${where} as running weekly but it declares no \`schedule\` trigger`);
        else if (!isWeeklyCron(t.cron)) problems.push(`${where} as running weekly but its cron is ${JSON.stringify(t.cron)} (not "M H * * D")`);
      }
      if (c.cron !== undefined && c.cron.trim() !== (t.cron ?? "").trim()) problems.push(`${where} with cron \`${c.cron}\` but the workflow's cron is ${JSON.stringify(t.cron)}`);
      if (c.dispatch && !t.dispatch) problems.push(`${where} as runnable by manual dispatch but it declares no \`workflow_dispatch\``);
      if (c.prTypes.length || t.pullRequestTypes) {
        const declared = t.pullRequestTypes ?? [];
        for (const ty of c.prTypes) if (!declared.includes(ty)) problems.push(`${where} as reacting to pull request \`${ty}\` but pull_request.types is [${declared.join(", ")}]`);
        for (const ty of declared) if (!c.prTypes.includes(ty)) problems.push(`${where} but does not name its pull_request type \`${ty}\` in back-ticks`);
      }
      if (c.codeScanning && !usedActions(yaml).includes(SARIF_UPLOAD)) problems.push(`${where} as publishing to code scanning but no step uses \`${SARIF_UPLOAD}\``);
    }
  }
  const readmeRefs = new Set(workflowReferences(docs["README.md"] ?? "").map((r) => r.file));
  for (const file of Object.keys(workflows).sort()) {
    if (!readmeRefs.has(file)) problems.push(`.github/workflows/${file} is not introduced in README.md as "**<name>** … (\`.github/workflows/${file}\`)"`);
  }
  if (!total) problems.push('no doc introduces a workflow as "**<name>** … (`.github/workflows/<file>`)" — the parser matches nothing');
  void referenced;
  return problems;
}

// --- fixtures ----------------------------------------------------------------------

const LINKS = `name: Link check

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "17 9 * * 1"
  workflow_dispatch:

jobs:
  links:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@sha
`;

const SCORECARD = `name: OpenSSF Scorecard

on:
  push:
    branches: [main]
  schedule:
    - cron: "23 5 * * 1"
  workflow_dispatch:

permissions: read-all

jobs:
  analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@sha
      - uses: ossf/scorecard-action@sha
      - name: Upload SARIF to code scanning
        uses: github/codeql-action/upload-sarif@sha
`;

const CLOSE = `name: Close linked issues

on:
  pull_request:
    types: [closed]

jobs:
  close-linked-issue:
    uses: hivecommons/infra/.github/workflows/reusable-close-linked-issues.yml@sha
`;

const README = `# Site

## Checks

The **Link check** workflow (\`.github/workflows/links.yml\`) runs its \`links\`, \`test\` and
\`redirects\` jobs on every pull request and on every push to \`main\`, so commits pushed
straight to \`main\` are checked too.

- \`scripts/check-links.sh\` — a gate.

## Repository automation

**OpenSSF Scorecard** (\`.github/workflows/scorecard.yml\`) — Runs OpenSSF security scorecard analysis on every push to \`main\`, weekly (cron \`23 5 * * 1\`), and on manual dispatch from the Actions tab. Results are published to GitHub's code scanning dashboard.

**Close linked issues** (\`.github/workflows/close-linked-issues.yml\`) — Automatically closes issues linked to a closed pull request when a PR transitions to \`closed\`.
`;

const RUNBOOK = `Intro. The **Link check** workflow (\`.github/workflows/links.yml\`) runs on every PR and push to \`main\`, with jobs \`links\`, \`test\`, and \`redirects\`. The workflow's separate \`availability\` job runs only on the weekly schedule (Monday 09:17 UTC) and manual dispatch.

Recover by reverting.
`;

const WF = { "links.yml": LINKS, "scorecard.yml": SCORECARD, "close-linked-issues.yml": CLOSE };
const DOCS = { "README.md": README, "runbooks/release-rollback.md": RUNBOOK };
const problems = (over = {}) => automationDocProblems({ docs: over.docs ?? DOCS, workflows: over.workflows ?? WF });
const withWorkflow = (file, yaml) => ({ workflows: { ...WF, [file]: yaml } });

test("fixture: workflow triggers are parsed from flow and block lists", () => {
  assert.deepEqual(workflowTriggers(LINKS), { push: true, pushBranches: ["main"], pullRequest: true, pullRequestTypes: undefined, dispatch: true, schedule: true, cron: "17 9 * * 1" });
  assert.deepEqual(workflowTriggers(CLOSE), { push: false, pushBranches: undefined, pullRequest: true, pullRequestTypes: ["closed"], dispatch: false, schedule: false, cron: undefined });
  const block = "on:\n  push:\n    branches:\n      - main\n      - 'release'\n  pull_request:\n    types:\n      - closed\n      - reopened\n";
  assert.deepEqual(workflowTriggers(block).pushBranches, ["main", "release"]);
  assert.deepEqual(workflowTriggers(block).pullRequestTypes, ["closed", "reopened"]);
  assert.equal(workflowTriggers("name: x\n").push, false);
  assert.ok(isWeeklyCron("23 5 * * 1") && !isWeeklyCron("*/5 * * * *") && !isWeeklyCron(undefined));
  assert.deepEqual(usedActions(SCORECARD), ["actions/checkout", "ossf/scorecard-action", "github/codeql-action/upload-sarif"]);
  assert.deepEqual(usedActions(CLOSE), ["hivecommons/infra/.github/workflows/reusable-close-linked-issues.yml"]);
});

test("fixture: workflow introductions and their paragraphs' claims are extracted", () => {
  const refs = workflowReferences(README);
  assert.deepEqual(refs.map((r) => [r.name, r.file]), [["Link check", "links.yml"], ["OpenSSF Scorecard", "scorecard.yml"], ["Close linked issues", "close-linked-issues.yml"]]);
  assert.ok(refs[0].paragraph.endsWith("are checked too."), refs[0].paragraph);
  assert.deepEqual(claims(refs[0].paragraph), { pushMain: true, everyPR: true, weekly: false, cron: undefined, dispatch: false, prTypes: [], codeScanning: false });
  assert.deepEqual(claims(refs[1].paragraph), { pushMain: true, everyPR: false, weekly: true, cron: "23 5 * * 1", dispatch: true, prTypes: [], codeScanning: true });
  assert.deepEqual(claims(refs[2].paragraph), { pushMain: false, everyPR: false, weekly: false, cron: undefined, dispatch: false, prTypes: ["closed"], codeScanning: false });
  const rb = workflowReferences(RUNBOOK);
  assert.equal(rb.length, 1);
  assert.deepEqual(claims(rb[0].paragraph), { pushMain: true, everyPR: true, weekly: true, cron: undefined, dispatch: true, prTypes: [], codeScanning: false });
  assert.deepEqual(claims("Jobs `links` and `test` run; a `closed` issue is not a pull-request activity claim.").prTypes, []);
  assert.deepEqual(claims("Runs when a PR is `closed` or `reopened`, never on `labeled`.").prTypes, ["closed", "reopened", "labeled"]);
  assert.deepEqual(workflowReferences("**Bold** text with no (`path`) anywhere.\n"), []);
});

test("fixture: consistent docs and workflows pass", () => {
  assert.deepEqual(problems(), []);
});

test("fixture: a workflow the docs introduce but that is not committed is reported", () => {
  const { "close-linked-issues.yml": _, ...rest } = WF;
  const p = problems({ workflows: rest });
  assert.ok(p.some((x) => x.startsWith("README.md introduces **Close linked issues** (`.github/workflows/close-linked-issues.yml`) but no such workflow is committed")), p.join("\n"));
});

test("fixture: a committed workflow README.md never introduces is reported", () => {
  const p = problems({ workflows: { ...WF, "deploy.yml": "name: Deploy\non:\n  push:\n" } });
  assert.deepEqual(p, ['.github/workflows/deploy.yml is not introduced in README.md as "**<name>** … (`.github/workflows/deploy.yml`)"']);
  const runbookOnly = problems({ docs: { "README.md": README.replace(/\*\*Close linked issues\*\*[^\n]*\n/, ""), "runbooks/r.md": "**Close linked issues** (`.github/workflows/close-linked-issues.yml`) closes on `closed` pull requests.\n" } });
  assert.deepEqual(runbookOnly, ['.github/workflows/close-linked-issues.yml is not introduced in README.md as "**<name>** … (`.github/workflows/close-linked-issues.yml`)"']);
});

test("fixture: a renamed workflow is reported against the bold text", () => {
  const p = problems(withWorkflow("scorecard.yml", SCORECARD.replace("name: OpenSSF Scorecard", "name: Scorecard")));
  assert.deepEqual(p, ['README.md introduces **OpenSSF Scorecard** (`.github/workflows/scorecard.yml`) but the workflow is named "Scorecard"']);
  const unnamed = problems(withWorkflow("close-linked-issues.yml", CLOSE.replace("name: Close linked issues\n", "")));
  assert.ok(unnamed.some((x) => x.includes('but the workflow is named "<none>"')), unnamed.join("\n"));
});

test("fixture: push-to-main and every-pull-request claims must match the triggers", () => {
  const branch = problems(withWorkflow("scorecard.yml", SCORECARD.replace("branches: [main]", "branches: [release]")));
  assert.ok(branch.some((x) => x.includes("as running on push to `main` but it declares push.branches: [release]")), branch.join("\n"));
  const noPush = problems(withWorkflow("scorecard.yml", SCORECARD.replace("  push:\n    branches: [main]\n", "")));
  assert.ok(noPush.some((x) => x.includes("as running on push to `main` but it declares no `push` trigger")), noPush.join("\n"));
  assert.deepEqual(problems(withWorkflow("scorecard.yml", SCORECARD.replace("    branches: [main]\n", ""))), [], "an unfiltered push trigger does run on main");
  const noPR = problems(withWorkflow("links.yml", LINKS.replace("  pull_request:\n", "")));
  assert.ok(noPR.some((x) => x.includes("as running on every pull request but it declares no `pull_request` trigger")), noPR.join("\n"));
});

test("fixture: weekly, cron-literal and manual-dispatch claims must match the triggers", () => {
  const day = problems(withWorkflow("scorecard.yml", SCORECARD.replace("23 5 * * 1", "23 5 * * 3")));
  assert.deepEqual(day, ['README.md introduces **OpenSSF Scorecard** (`.github/workflows/scorecard.yml`) with cron `23 5 * * 1` but the workflow\'s cron is "23 5 * * 3"']);
  const daily = problems(withWorkflow("scorecard.yml", SCORECARD.replace("23 5 * * 1", "23 5 * * *")));
  assert.ok(daily.some((x) => x.includes('as running weekly but its cron is "23 5 * * *"')), daily.join("\n"));
  const noSchedule = problems(withWorkflow("scorecard.yml", SCORECARD.replace('  schedule:\n    - cron: "23 5 * * 1"\n', "")));
  assert.ok(noSchedule.some((x) => x.includes("as running weekly but it declares no `schedule` trigger")), noSchedule.join("\n"));
  assert.ok(noSchedule.some((x) => x.includes("with cron `23 5 * * 1` but the workflow's cron is undefined")), noSchedule.join("\n"));
  const noDispatch = problems(withWorkflow("scorecard.yml", SCORECARD.replace("  workflow_dispatch:\n", "")));
  assert.deepEqual(noDispatch, ["README.md introduces **OpenSSF Scorecard** (`.github/workflows/scorecard.yml`) as runnable by manual dispatch but it declares no `workflow_dispatch`"]);
  const runbook = problems(withWorkflow("links.yml", LINKS.replace("  workflow_dispatch:\n", "")));
  assert.ok(runbook.some((x) => x.startsWith("runbooks/release-rollback.md introduces **Link check**") && x.includes("manual dispatch")), runbook.join("\n"));
});

test("fixture: pull_request activity types must be named exactly", () => {
  const opened = problems(withWorkflow("close-linked-issues.yml", CLOSE.replace("types: [closed]", "types: [opened]")));
  assert.deepEqual(opened, [
    "README.md introduces **Close linked issues** (`.github/workflows/close-linked-issues.yml`) as reacting to pull request `closed` but pull_request.types is [opened]",
    "README.md introduces **Close linked issues** (`.github/workflows/close-linked-issues.yml`) but does not name its pull_request type `opened` in back-ticks",
  ]);
  const extra = problems(withWorkflow("close-linked-issues.yml", CLOSE.replace("types: [closed]", "types: [closed, reopened]")));
  assert.deepEqual(extra, ["README.md introduces **Close linked issues** (`.github/workflows/close-linked-issues.yml`) but does not name its pull_request type `reopened` in back-ticks"]);
  const untyped = problems(withWorkflow("close-linked-issues.yml", CLOSE.replace("    types: [closed]\n", "")));
  assert.ok(untyped.some((x) => x.includes("as reacting to pull request `closed` but pull_request.types is []")), untyped.join("\n"));
});

test("fixture: a code-scanning claim needs an upload-sarif step", () => {
  const p = problems(withWorkflow("scorecard.yml", SCORECARD.replace("github/codeql-action/upload-sarif@sha", "ossf/publish@sha")));
  assert.deepEqual(p, ["README.md introduces **OpenSSF Scorecard** (`.github/workflows/scorecard.yml`) as publishing to code scanning but no step uses `github/codeql-action/upload-sarif`"]);
});

test("fixture: docs the parser can no longer read are reported instead of passing vacuously", () => {
  const p = problems({ docs: { "README.md": "# Site\n\nWorkflows are described elsewhere.\n" } });
  assert.ok(p.some((x) => x.startsWith("no doc introduces a workflow")), p.join("\n"));
  assert.equal(p.filter((x) => x.includes("is not introduced in README.md")).length, 3);
});

// --- live checks over the committed tree ------------------------------------------

const workflows = {};
for (const n of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) workflows[n] = readFileSync(join(WORKFLOWS, n), "utf8");
const docs = { "README.md": readFileSync(join(ROOT, "README.md"), "utf8") };
if (existsSync(RUNBOOKS)) for (const n of readdirSync(RUNBOOKS).filter((f) => f.endsWith(".md")).sort()) docs[`runbooks/${n}`] = readFileSync(join(RUNBOOKS, n), "utf8");

test("README.md and runbooks/*.md agree with every .github/workflows/*.yml (name, triggers, cron, dispatch, PR types, code scanning)", () => {
  assert.ok(Object.keys(workflows).length >= 1, "no workflows committed");
  assert.deepEqual(automationDocProblems({ docs, workflows }), [], "fix the prose to match the workflow, or update both deliberately");
});
