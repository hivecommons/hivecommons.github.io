// Shared helper for the gates that read job-level `if:` expressions out of
// .github/workflows/*.yml (ci-wiring.test.mjs, workflow-docs.test.mjs). A job that
// carries an `if:` is not necessarily skipped on pull requests and pushes: links.yml
// gates its PR/push jobs with `github.event_name != 'schedule' || …` purely so a
// frequent cron can run one job alone. So "is this job gated?" has to be answered by
// evaluating the expression for the events in question, not by checking that one exists.
// Zero dependencies; not a test file (it imports nothing from node:test).

// Evaluates a job-level `if:` for one event. Supports the subset the workflows use:
// `github.event_name`, `github.event.schedule`, single-quoted strings, `==`, `!=`,
// `!`, `&&`, `||` and parentheses. Returns undefined for anything else so callers fall
// back to treating the condition as a gate rather than guessing.
export function evalCondition(cond, { eventName, schedule = "" }) {
  const tokens = cond.match(/\(|\)|&&|\|\||==|!=|!|'(?:[^'\\]|\\.)*'|[A-Za-z_][\w.]*/g) ?? [];
  if (tokens.join("").replace(/\s+/g, "") !== cond.replace(/\s+/g, "")) return undefined;
  let i = 0;
  const vars = { "github.event_name": eventName, "github.event.schedule": schedule };
  const atom = () => {
    const t = tokens[i++];
    if (t === undefined) throw new Error("eof");
    if (t === "(") { const v = or(); if (tokens[i++] !== ")") throw new Error(")"); return v; }
    if (t === "!") return !atom();
    if (t.startsWith("'")) return t.slice(1, -1).replace(/\\(.)/g, "$1");
    if (t in vars) return vars[t];
    throw new Error(t);
  };
  const cmp = () => {
    let l = atom();
    while (tokens[i] === "==" || tokens[i] === "!=") { const op = tokens[i++]; const r = atom(); l = op === "==" ? l === r : l !== r; }
    return l;
  };
  const and = () => { let l = cmp(); while (tokens[i] === "&&") { i++; const r = cmp(); l = l && r; } return l; };
  const or = () => { let l = and(); while (tokens[i] === "||") { i++; const r = and(); l = l || r; } return l; };
  try {
    const v = or();
    return i === tokens.length ? Boolean(v) : undefined;
  } catch {
    return undefined;
  }
}

// True when the job's `if:` (or its absence) lets it run on every push and pull_request.
// Unknown expression shapes count as gated until this parser learns them.
export function runsOnEveryPrPush(cond) {
  if (!cond) return true;
  return ["push", "pull_request"].every((eventName) => evalCondition(cond, { eventName }) === true);
}
