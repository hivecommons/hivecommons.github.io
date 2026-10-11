// Direct unit test for scripts/actions-if.mjs, the job-level `if:` evaluator shared by
// ci-wiring.test.mjs and workflow-docs.test.mjs. Those gates only exercise the parser
// through whatever expressions .github/workflows/*.yml contain today, so a precedence,
// negation or tokeniser slip would go unnoticed until a workflow happened to use the
// shape it mishandles — and the failure mode is silent: a job wrongly judged "gated"
// is simply not held to the every-PR/push rules. This file pins the grammar the
// helper claims to support and, just as importantly, that everything outside it
// returns undefined so callers fall back to the conservative "gated" answer.
// Zero dependencies.
import test from "node:test";
import assert from "node:assert/strict";
import { evalCondition, runsOnEveryPrPush } from "./actions-if.mjs";

const push = { eventName: "push" };
const pr = { eventName: "pull_request" };
const schedule = (cron) => ({ eventName: "schedule", schedule: cron });

test("equality and inequality on github.event_name", () => {
  assert.equal(evalCondition("github.event_name == 'push'", push), true);
  assert.equal(evalCondition("github.event_name == 'push'", pr), false);
  assert.equal(evalCondition("github.event_name != 'schedule'", push), true);
  assert.equal(evalCondition("github.event_name != 'schedule'", schedule("1 2 * * *")), false);
  assert.equal(evalCondition("'push' == github.event_name", push), true, "literal may be on either side");
});

test("github.event.schedule compares against the cron string and defaults to empty", () => {
  const cond = "github.event.schedule == '43 */6 * * *'";
  assert.equal(evalCondition(cond, schedule("43 */6 * * *")), true);
  assert.equal(evalCondition(cond, schedule("17 9 * * 1")), false);
  assert.equal(evalCondition(cond, push), false, "no schedule on push → compares against ''");
  assert.equal(evalCondition("github.event.schedule == ''", push), true);
});

test("&& binds tighter than ||, matching GitHub Actions precedence", () => {
  // a || b && c  ≡  a || (b && c)
  const cond = "github.event_name == 'push' || github.event_name == 'schedule' && github.event.schedule == 'X'";
  assert.equal(evalCondition(cond, push), true);
  assert.equal(evalCondition(cond, schedule("X")), true);
  assert.equal(evalCondition(cond, schedule("Y")), false);
  assert.equal(evalCondition(cond, pr), false);
  // The other order must not be re-associated into (a || b) && c.
  const cond2 = "github.event_name == 'schedule' && github.event.schedule == 'X' || github.event_name == 'push'";
  assert.equal(evalCondition(cond2, push), true);
  assert.equal(evalCondition(cond2, schedule("Y")), false);
});

test("parentheses override precedence and may nest", () => {
  const cond = "(github.event_name == 'push' || github.event_name == 'schedule') && github.event.schedule == 'X'";
  assert.equal(evalCondition(cond, push), false, "push has no schedule, so the && fails");
  assert.equal(evalCondition(cond, schedule("X")), true);
  assert.equal(evalCondition("((github.event_name == 'push'))", push), true);
  assert.equal(evalCondition("!(github.event_name == 'push' || github.event_name == 'pull_request')", schedule("X")), true);
  assert.equal(evalCondition("!(github.event_name == 'push' || github.event_name == 'pull_request')", pr), false);
});

test("! negates a single atom and binds tighter than ==", () => {
  assert.equal(evalCondition("!github.event_name", push), false, "non-empty string is truthy");
  assert.equal(evalCondition("!github.event.schedule", push), true, "empty default is falsy");
  assert.equal(evalCondition("!!github.event_name", push), true);
  // `!a == b` parses as `(!a) == b`: (!'push') is false, false == 'push' is false.
  assert.equal(evalCondition("!github.event_name == 'push'", push), false);
  assert.equal(evalCondition("!(github.event_name == 'push')", push), false);
  assert.equal(evalCondition("!(github.event_name == 'push')", pr), true);
});

test("the result is always a boolean, even for a bare value", () => {
  assert.equal(evalCondition("github.event_name", push), true);
  assert.equal(evalCondition("github.event.schedule", push), false);
  assert.equal(evalCondition("'x'", push), true);
  assert.equal(evalCondition("''", push), false);
});

test("string literals honour backslash escapes and may contain operators or spaces", () => {
  assert.equal(evalCondition("github.event_name == 'it\\'s'", { eventName: "it's" }), true);
  assert.equal(evalCondition("github.event.schedule == 'a && b || c'", schedule("a && b || c")), true);
  assert.equal(evalCondition("github.event.schedule == '(x)'", schedule("(x)")), true);
});

test("whitespace is insignificant", () => {
  assert.equal(evalCondition("github.event_name=='push'", push), true);
  assert.equal(evalCondition("  github.event_name   ==   'push'  ", push), true);
  assert.equal(evalCondition("github.event_name\n  == 'push'", push), true);
});

test("string comparison is case-sensitive here (Actions is case-insensitive) — the conservative direction", () => {
  // GitHub would evaluate this true; the helper says false, so runsOnEveryPrPush
  // treats the job as gated rather than wrongly exempting it. Pin that this never
  // flips to a permissive answer without a deliberate change.
  assert.equal(evalCondition("github.event_name == 'Push'", push), false);
});

test("unknown contexts, functions and operators return undefined rather than guessing", () => {
  const unsupported = [
    "github.ref == 'refs/heads/main'",
    "github.actor != 'dependabot[bot]'",
    "contains(github.event.head_commit.message, 'skip')",
    "startsWith(github.ref, 'refs/tags/')",
    "always()",
    "success() && github.event_name == 'push'",
    "github.event_name == 'push' && failure()",
    "github.run_attempt > 1",
    "github.event_name == \"push\"",
    "${{ github.event_name == 'push' }}",
    "github.event_name == 'push' || true",
    "inputs.dry_run == 'false'",
  ];
  for (const cond of unsupported) {
    assert.equal(evalCondition(cond, push), undefined, cond);
    assert.equal(evalCondition(cond, pr), undefined, cond);
  }
});

test("malformed expressions return undefined", () => {
  const malformed = [
    "",
    "github.event_name ==",
    "== 'push'",
    "github.event_name == 'push' ||",
    "&& github.event_name == 'push'",
    "(github.event_name == 'push'",
    "github.event_name == 'push')",
    "github.event_name == 'push' 'extra'",
    "github.event_name 'push'",
    "'unterminated",
    "github.event_name == 'push' = 'x'",
    "!",
  ];
  for (const cond of malformed) {
    assert.equal(evalCondition(cond, push), undefined, JSON.stringify(cond));
  }
});

test("runsOnEveryPrPush: no if: means the job always runs", () => {
  assert.equal(runsOnEveryPrPush(undefined), true);
  assert.equal(runsOnEveryPrPush(null), true);
  assert.equal(runsOnEveryPrPush(""), true);
});

test("runsOnEveryPrPush: the cron-trim shape links.yml uses is accepted", () => {
  assert.equal(runsOnEveryPrPush("github.event_name != 'schedule' || github.event.schedule == '17 9 * * 1'"), true);
  assert.equal(runsOnEveryPrPush("github.event_name != 'schedule' && github.event_name != 'workflow_dispatch'"), true);
  assert.equal(runsOnEveryPrPush("github.event_name == 'push' || github.event_name == 'pull_request'"), true);
});

test("runsOnEveryPrPush: an if: that can skip push or pull_request is a gate", () => {
  assert.equal(runsOnEveryPrPush("github.event_name == 'push'"), false, "skips pull_request");
  assert.equal(runsOnEveryPrPush("github.event_name == 'pull_request'"), false, "skips push");
  assert.equal(runsOnEveryPrPush("github.event_name == 'schedule'"), false);
  assert.equal(runsOnEveryPrPush("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"), false);
  assert.equal(runsOnEveryPrPush("github.event.schedule == ''"), true, "no schedule on push/pr, so this is vacuously true for both");
});

test("runsOnEveryPrPush: an expression the parser cannot evaluate counts as a gate", () => {
  assert.equal(runsOnEveryPrPush("github.ref == 'refs/heads/main'"), false);
  assert.equal(runsOnEveryPrPush("always()"), false);
  assert.equal(runsOnEveryPrPush("github.event_name != 'schedule' ||"), false);
  // A conjunction with one unknown operand must not short-circuit into true/false.
  assert.equal(runsOnEveryPrPush("github.event_name == 'push' || github.ref == 'x'"), false);
});
