#!/usr/bin/env node
// Branch-coverage floor over the scripts/*.mjs helpers. Every other gate here
// is a *.test.mjs that imports a helper (page-csp.mjs, html-pages.mjs, ...),
// so a branch added to a helper runs under the suite the moment any page hits
// it — and nothing fails when no test asserts what that branch decides. This
// gate runs the rest of the suite once more as a child with NODE_V8_COVERAGE,
// reads the raw V8 block-coverage ranges for scripts/*.mjs (not *.test.mjs),
// and fails naming each range the suite never executed: file, line and the
// quoted source slice, so the fix is a test rather than arithmetic. The
// main-module guard of a tool (`if (process.argv[1] ... import.meta.url) {`)
// is excluded: its self-test runs it via spawnSync against a copy, which V8
// attributes to the copy. Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/coverage-floor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { HARNESSED_SCRIPTS, INLINE_URL_PREFIX, inlineScript } from "./inline-scripts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SELF = basename(fileURLToPath(import.meta.url));
// Set in the child so a stray `coverage-floor.test.mjs` in its file list can
// never recurse; the file list below already leaves it out.
const CHILD_ENV = "COVERAGE_FLOOR_CHILD";

// Dead ranges inside the top-level functions of each gate when the ratchet
// landed. Lower an entry when you assert a branch; delete it at zero; never
// raise one. The end state is an empty object and the same floor the
// scripts/*.mjs helpers already meet.
export const TEST_HELPER_BASELINE = {
  "scripts/carousels.test.mjs": 6,
  "scripts/issue-forms.test.mjs": 15,
  "scripts/jsonld-contract.test.mjs": 14,
  "scripts/no-js-controls.test.mjs": 5,
  "scripts/page-404.test.mjs": 5,
  "scripts/page-images.test.mjs": 19,
  "scripts/page-meta.test.mjs": 20,
  "scripts/page-structure.test.mjs": 7,
  "scripts/story-cards.test.mjs": 14,
  "scripts/story-form-contract.test.mjs": 12,
  "scripts/style-contract.test.mjs": 13,
};

// --- analysis ---------------------------------------------------------------

// [start, end) offsets of every main-module guard block in a tool's source:
// `if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { ... }`.
export function cliEntrySpans(src) {
  const spans = [];
  for (const m of src.matchAll(/^if \(process\.argv\[1\][^\n]*import\.meta\.url\)\) \{/gm)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { spans.push([m.index, i + 1]); break; }
    }
  }
  return spans;
}

// [start, end) offsets of every top-level function declaration in a gate:
// `export function f(...) {` / `async function g(...) {` opening at the end of
// its line, up to the first `}` on a line of its own. Formatted code closes a
// top-level body exactly there, and counting braces would trip over the `{`
// inside the string and regex literals the checkers are made of. A one-line
// declaration has no span (it would otherwise run on to the next body).
// Also matches top-level const arrow-function helpers:
// `const name = (...) => {` / `const name = async (...) => {` /
// `const name = function(...) {` / `const name = async function(...) {`.
// An assigned function closes with `};`, so the const form also accepts a
// `;` right after the brace; the span ends at the brace either way.
export function functionSpans(src) {
  const spans = [];
  // Match both function declarations and const arrow-function/function-assigned helpers
  for (const m of src.matchAll(/^(?:export )?(?:(?:async )?function\b|const\s+\w+\s*=\s*(?:async\s+)?(?:\(|function\b))[^\n]*\{$/gm)) {
    const close = src.indexOf("\n}", m.index);
    if (close < 0) break;
    const isConst = /^(?:export )?const\b/.test(m[0]);
    const after = src[close + 2];
    if (after === ";" && isConst) {
      const next = src[close + 3];
      if (next !== undefined && next !== "\n") continue;
    } else if (after !== undefined && after !== "\n") continue;
    spans.push([m.index, close + 2]);
  }
  return spans;
}

// Execution count of the whole span [start, end) in one process: the count of
// the innermost V8 range that encloses it entirely. V8 only emits a range for
// a block whose count differs from its parent, so a block the process ran as
// often as its parent has no range of its own and inherits the parent's count.
export function countOf(functions, start, end) {
  let best;
  for (const fn of functions) {
    for (const r of fn.ranges) {
      if (r.startOffset <= start && r.endOffset >= end && (!best || r.endOffset - r.startOffset < best.endOffset - best.startOffset)) best = r;
    }
  }
  return best?.count;
}

// Ranges no process executed: zero-count in one run and still zero in every
// other run that loaded the script. `runs` is one `functions` array per process.
// With `within`, only ranges inside one of those [start, end) spans count.
export function deadRanges(src, runs, within) {
  const seen = new Map();
  for (const functions of runs) {
    for (const fn of functions) {
      for (const r of fn.ranges) {
        if (r.count === 0) seen.set(`${r.startOffset}:${r.endOffset}`, [r.startOffset, r.endOffset]);
      }
    }
  }
  const skip = cliEntrySpans(src);
  const out = [];
  for (const [start, end] of seen.values()) {
    if (!src.slice(start, end).trim()) continue;
    if (skip.some(([s, e]) => start >= s && start < e)) continue;
    if (within && !within.some(([s, e]) => start >= s && end <= e)) continue;
    if (runs.some((functions) => (countOf(functions, start, end) ?? 0) > 0)) continue;
    out.push([start, end]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export function lineOf(src, offset) {
  return src.slice(0, offset).split("\n").length;
}

// Problems per file, naming file, line and the source each dead range starts
// with. A source is either the file's text or `{ src, line, within }`: `line`
// for a block embedded in a page at that 1-based line, so the reported line is
// the page's; `within` to confine the search to those spans of the source.
export function problemsByFile(sources, runsByFile) {
  const out = new Map();
  for (const [file, entry] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const { src, line = 1, within } = typeof entry === "string" ? { src: entry } : entry;
    const problems = [];
    out.set(file, problems);
    const runs = runsByFile.get(file);
    if (!runs) { problems.push(`${file}: never loaded by the suite`); continue; }
    for (const [start, end] of deadRanges(src, runs, within)) {
      const slice = src.slice(start, end).trim().split("\n")[0];
      const quoted = slice.length > 60 ? `${slice.slice(0, 57)}...` : slice;
      problems.push(`${file}:${lineOf(src, start) + line - 1} \`${quoted}\` never executed by the suite (add a test that asserts what this branch decides)`);
    }
  }
  return out;
}

// One problem per dead range, in file order.
export function problemsOf(sources, runsByFile) {
  return [...problemsByFile(sources, runsByFile).values()].flat();
}

// Ratchet: a file may carry at most `baseline[file]` problems (0 when absent)
// and must lower its entry as they are fixed, so the baseline only shrinks.
export function ratchetProblems(byFile, baseline) {
  const problems = [];
  for (const [file, found] of byFile) {
    const allowed = baseline[file] ?? 0;
    if (found.length > allowed) problems.push(`${file}: ${found.length} dead ranges, baseline allows ${allowed}`, ...found);
    else if (found.length < allowed) problems.push(`${file}: ${found.length} dead ranges left, baseline allows ${allowed} — lower TEST_HELPER_BASELINE to ${found.length || "nothing (delete the entry)"}`);
  }
  for (const file of Object.keys(baseline)) {
    if (!byFile.has(file)) problems.push(`${file}: in TEST_HELPER_BASELINE but not a gate under scripts/ — delete the entry`);
  }
  return problems;
}

// --- collection -------------------------------------------------------------

// Helper sources under <root>/scripts: *.mjs that are not *.test.mjs, keyed by
// repository-relative path.
export function helperSources(root) {
  const dir = join(root, "scripts");
  return new Map(readdirSync(dir).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs")).sort()
    .map((n) => [`scripts/${n}`, readFileSync(join(dir, n), "utf8")]));
}

// The gates' own top-level functions: every scripts/*.test.mjs (this file
// aside — the child never loads it) that declares at least one, as
// `{ src, within }` so only those declarations are read.
export function testHelperSources(root, self = SELF) {
  const dir = join(root, "scripts");
  const out = new Map();
  for (const n of readdirSync(dir).filter((n) => n.endsWith(".test.mjs") && n !== self).sort()) {
    const src = readFileSync(join(dir, n), "utf8");
    const within = functionSpans(src);
    if (within.length) out.set(`scripts/${n}`, { src, within });
  }
  return out;
}

// Parsed NODE_V8_COVERAGE reports reduced to Map<repo-relative helper, runs[]>.
export function runsFromReports(reports, root, sources) {
  const prefix = pathToFileURL(join(resolve(root), "scripts")).href + "/";
  const out = new Map();
  for (const report of reports) {
    for (const script of report.result ?? []) {
      if (!script.url.startsWith(prefix)) continue;
      const file = relative(resolve(root), fileURLToPath(script.url)).split("\\").join("/");
      if (!sources.has(file)) continue;
      if (!out.has(file)) out.set(file, []);
      out.get(file).push(script.functions);
    }
  }
  return out;
}

// Inline page scripts under <root> as the harnesses run them: Map<"page#hook",
// { src, line }>, keyed the way `inlineUrl` names them minus the prefix.
export function inlineSources(root, registry = HARNESSED_SCRIPTS) {
  const out = new Map();
  for (const [page, entries] of Object.entries(registry)) {
    const html = readFileSync(join(root, page), "utf8");
    for (const { hook } of entries) out.set(`${page}#${hook}`, inlineScript(html, page, hook));
  }
  return out;
}

// `new Function(...params, body)` compiles `(function anonymous(params\n) {\nbody\n})`,
// so V8's offsets sit `wrapper` code units past the body's own; the sourceURL
// trailer is part of the body. Ranges are shifted back and clamped to the body.
const FUNCTION_SUFFIX = "\n})".length;

export function shiftRanges(functions, by, length) {
  const clamp = (n) => Math.min(length, Math.max(0, n - by));
  return functions.map((fn) => ({ ...fn, ranges: fn.ranges.map((r) => ({ ...r, startOffset: clamp(r.startOffset), endOffset: clamp(r.endOffset) })) }));
}

// Parsed NODE_V8_COVERAGE reports reduced to Map<"page#hook", runs[]> for the
// inline scripts, plus one problem per script whose compiled length does not
// fit the extracted body (the harness did not run `inlineScript(...).src`
// through `new Function`, so its offsets cannot be trusted).
export function inlineRunsFromReports(reports, sources) {
  const runs = new Map();
  const problems = [];
  for (const report of reports) {
    for (const script of report.result ?? []) {
      if (!script.url.startsWith(INLINE_URL_PREFIX)) continue;
      const key = script.url.slice(INLINE_URL_PREFIX.length);
      const entry = sources.get(key);
      if (!entry) continue;
      const compiled = Math.max(...script.functions.flatMap((fn) => fn.ranges.map((r) => r.endOffset)));
      const wrapper = compiled - entry.src.length - FUNCTION_SUFFIX;
      if (wrapper < 0) { problems.push(`${key}: compiled as ${compiled} code units but the extracted block is ${entry.src.length}; run inlineScript(...).src through new Function`); continue; }
      if (!runs.has(key)) runs.set(key, []);
      runs.get(key).push(shiftRanges(script.functions, wrapper, entry.src.length));
    }
  }
  return { runs, problems: [...new Set(problems)].sort() };
}

// Runs `node --test <files>` from <root> with coverage into a temp dir; returns
// the parsed reports and the child's status.
export function collect(root, files) {
  const dir = mkdtempSync(join(tmpdir(), "coverage-floor-"));
  try {
    // The parent runner marks its own children with NODE_TEST_CONTEXT; a child
    // `node --test` that inherits it reports over IPC instead of running files.
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
    const child = spawnSync(process.execPath, ["--test", ...files], {
      cwd: root, encoding: "utf8", env: { ...env, NODE_V8_COVERAGE: dir, [CHILD_ENV]: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    const reports = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
    return { reports, status: child.status, stdout: child.stdout, stderr: child.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function suiteFiles(root) {
  return readdirSync(join(root, "scripts")).filter((n) => n.endsWith(".test.mjs") && n !== SELF).sort().map((n) => `scripts/${n}`);
}

// --- fixture self-tests -----------------------------------------------------

// Synthetic V8 `functions` arrays: a 40-char module whose block [20, 30) is
// the branch under test.
const SRC = "const a = 1;\nif (a) { b(); } else { c(); }";
const FULL = [{ functionName: "", ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }], isBlockCoverage: true }];
const DEAD_ELSE = [{ functionName: "", ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }, { startOffset: 27, endOffset: 42, count: 0 }], isBlockCoverage: true }];
const DEAD_THEN = [{ functionName: "", ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }, { startOffset: 20, endOffset: 27, count: 0 }], isBlockCoverage: true }];

test("fixture: a range zero in one run but inherited as executed in another is not dead", () => {
  assert.deepEqual(deadRanges(SRC, [DEAD_ELSE, FULL]), []);
  assert.deepEqual(deadRanges(SRC, [DEAD_ELSE, DEAD_THEN]), []);
  assert.deepEqual(deadRanges(SRC, [DEAD_ELSE, DEAD_ELSE]), [[27, 42]]);
  assert.deepEqual(deadRanges(SRC, [DEAD_ELSE]), [[27, 42]]);
  assert.equal(countOf(DEAD_ELSE, 27, 42), 0);
  assert.equal(countOf(FULL, 27, 42), 1);
  assert.equal(countOf([], 0, 1), undefined);
});

test("fixture: functionSpans recognizes top-level arrow-const and function-assigned const helpers", () => {
  const arrow = "const siteHas = (path) => {\n  return path === '';\n}\n";
  const asyncArrow = "const check = async (x) => {\n  return x > 0;\n}\n";
  const funcAssigned = "const helper = function(a) {\n  return a ? 'yes' : 'no';\n}\n";
  const asyncFuncAssigned = "const asyncHelper = async function(b) {\n  return b;\n}\n";
  const exported = "export const f = (x) => {\n  return x * 2;\n}\n";
  const mixed = "import x from 'y';\n\nconst a = (p) => {\n  if (p) { return 1; }\n  return 0;\n}\n\nexport function b() {\n  return 2;\n}\n\nconst c = async (q) => {\n  return q || null;\n}\n";
  
  const arrowSpans = functionSpans(arrow);
  assert.equal(arrowSpans.length, 1, "arrow const should have one span");
  assert.equal(arrow.slice(...arrowSpans[0]), arrow.trimEnd(), "arrow const span should cover the entire function up to its closing brace");
  
  const asyncArrowSpans = functionSpans(asyncArrow);
  assert.equal(asyncArrowSpans.length, 1, "async arrow const should have one span");
  
  const funcSpans = functionSpans(funcAssigned);
  assert.equal(funcSpans.length, 1, "function-assigned const should have one span");
  
  const asyncFuncSpans = functionSpans(asyncFuncAssigned);
  assert.equal(asyncFuncSpans.length, 1, "async function-assigned const should have one span");
  
  const exportedSpans = functionSpans(exported);
  assert.equal(exportedSpans.length, 1, "exported arrow const should have one span");
  
  const mixedSpans = functionSpans(mixed);
  assert.equal(mixedSpans.length, 3, "mixed file should have three spans (a, b, c)");

  const semi = "const siteHas = (path) => {\n  if (path === '') return true;\n  return false;\n};\n\nexport const g = function(x) {\n  return x;\n};\n";
  const semiSpans = functionSpans(semi);
  assert.equal(semiSpans.length, 2, "arrow/function consts closing with `};` should each have one span");
  assert.equal(semi.slice(...semiSpans[0]), "const siteHas = (path) => {\n  if (path === '') return true;\n  return false;\n}", "the `};` span ends at the closing brace");
  assert.equal(semi.slice(...semiSpans[1]), "export const g = function(x) {\n  return x;\n}");
  assert.deepEqual(functionSpans("const h = (x) => {\n  return x;\n}; h(1);\n"), [], "a `};` followed by more code on the line is not a top-level close");
  assert.deepEqual(functionSpans("function d() {\n  return 1;\n};\n"), [], "a declaration followed by `;` keeps the old rejection");
});


test("fixture: problems name file, line and the first line of the dead source, sorted by file then offset", () => {
  const src = "export function f(x) {\n  return x\n    ? 1\n    : 2;\n}\n";
  const runs = [[{ functionName: "f", ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }, { startOffset: src.indexOf(": 2"), endOffset: src.indexOf(";"), count: 0 }, { startOffset: src.indexOf("? 1"), endOffset: src.indexOf("\n    :"), count: 0 }], isBlockCoverage: true }]];
  const sources = new Map([["scripts/z.mjs", src], ["scripts/a.mjs", src]]);
  assert.deepEqual(problemsOf(sources, new Map([["scripts/z.mjs", runs], ["scripts/a.mjs", runs]])), [
    "scripts/a.mjs:3 `? 1` never executed by the suite (add a test that asserts what this branch decides)",
    "scripts/a.mjs:4 `: 2` never executed by the suite (add a test that asserts what this branch decides)",
    "scripts/z.mjs:3 `? 1` never executed by the suite (add a test that asserts what this branch decides)",
    "scripts/z.mjs:4 `: 2` never executed by the suite (add a test that asserts what this branch decides)",
  ]);
  assert.deepEqual(problemsOf(new Map([["scripts/q.mjs", src]]), new Map()), ["scripts/q.mjs: never loaded by the suite"]);
  const long = `x(${"a".repeat(80)})`;
  const longRuns = [[{ functionName: "", ranges: [{ startOffset: 0, endOffset: long.length, count: 1 }, { startOffset: 0, endOffset: long.length - 1, count: 0 }], isBlockCoverage: true }]];
  const [problem] = problemsOf(new Map([["scripts/l.mjs", long]]), new Map([["scripts/l.mjs", longRuns]]));
  assert.match(problem, /`x\(a{55}\.\.\.` never executed/);
});

test("fixture: whitespace-only ranges and the main-module guard block are excluded", () => {
  const src = 'import { resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\nexport function f() { return 1; }\nif (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {\n  if (f()) { g(); }\n}\n';
  const guard = src.indexOf("if (process.argv[1]");
  assert.deepEqual(cliEntrySpans(src), [[guard, src.length - 1]]);
  assert.deepEqual(cliEntrySpans("export const x = 1;\n"), []);
  const runs = [[
    { functionName: "", ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }, { startOffset: guard + src.slice(guard).indexOf("{"), endOffset: src.length - 1, count: 0 }, { startOffset: src.indexOf("\n", guard), endOffset: src.indexOf("\n", guard) + 2, count: 0 }], isBlockCoverage: true },
    { functionName: "f", ranges: [{ startOffset: src.indexOf("function f"), endOffset: src.indexOf("}\nif") + 1, count: 0 }], isBlockCoverage: true },
  ]];
  assert.deepEqual(deadRanges(src, runs).map(([s]) => lineOf(src, s)), [3]);
});

test("fixture: a real child run reports exactly the dead branch of a tmp helper and nothing for a fully asserted one", () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-floor-fixture-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "dead.mjs"), "export function pick(x) {\n  return x ? 'yes' : 'no';\n}\n");
    writeFileSync(join(dir, "scripts", "dead.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { pick } from "./dead.mjs";\ntest("yes", () => assert.equal(pick(1), "yes"));\n');
    writeFileSync(join(dir, "scripts", "live.mjs"), "export function pick(x) {\n  return x ? 'yes' : 'no';\n}\n");
    writeFileSync(join(dir, "scripts", "live.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { pick } from "./live.mjs";\ntest("both", () => { assert.equal(pick(1), "yes"); assert.equal(pick(0), "no"); });\n');
    writeFileSync(join(dir, "scripts", "coverage-floor.test.mjs"), 'import { test } from "node:test";\ntest("self", () => {});\n');
    const sources = helperSources(dir);
    assert.deepEqual([...sources.keys()], ["scripts/dead.mjs", "scripts/live.mjs"]);
    assert.deepEqual(suiteFiles(dir), ["scripts/dead.test.mjs", "scripts/live.test.mjs"]);
    const { reports, status } = collect(dir, suiteFiles(dir));
    assert.equal(status, 0);
    const runs = runsFromReports(reports, dir, sources);
    assert.deepEqual([...runs.keys()].sort(), ["scripts/dead.mjs", "scripts/live.mjs"]);
    assert.deepEqual(problemsOf(sources, runs), [
      "scripts/dead.mjs:2 `: 'no'` never executed by the suite (add a test that asserts what this branch decides)",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture: inlineSources keys every registered block as page#hook", () => {
  assert.deepEqual([...inlineSources(ROOT).keys()], Object.entries(HARNESSED_SCRIPTS).flatMap(([page, entries]) => entries.map(({ hook }) => `${page}#${hook}`)));
});

test("fixture: inline ranges are shifted past the new Function wrapper and clamped; a body the compiled length cannot hold is a problem", () => {
  const body = "if (a) { b(); } else { c(); }\n//# sourceURL=inline:p.html#[data-x]\n";
  const wrapper = "(function anonymous(document\n) {\n".length;
  const functions = [
    { functionName: "", ranges: [{ startOffset: 0, endOffset: wrapper + body.length + 3, count: 1 }], isBlockCoverage: true },
    { functionName: "", ranges: [{ startOffset: 1, endOffset: wrapper + body.length + 2, count: 1 }, { startOffset: wrapper + 21, endOffset: wrapper + 29, count: 0 }], isBlockCoverage: true },
  ];
  const sources = new Map([["p.html#[data-x]", { src: body, line: 7 }]]);
  const { runs, problems } = inlineRunsFromReports([{ result: [{ url: "inline:p.html#[data-x]", functions }, { url: "inline:p.html#[data-other]", functions }, { url: "file:///p.mjs", functions }] }], sources);
  assert.deepEqual(problems, []);
  assert.deepEqual(runs.get("p.html#[data-x]"), [[
    { functionName: "", ranges: [{ startOffset: 0, endOffset: body.length, count: 1 }], isBlockCoverage: true },
    { functionName: "", ranges: [{ startOffset: 0, endOffset: body.length, count: 1 }, { startOffset: 21, endOffset: 29, count: 0 }], isBlockCoverage: true },
  ]]);
  assert.deepEqual(problemsOf(sources, runs), ["p.html#[data-x]:7 `{ c(); }` never executed by the suite (add a test that asserts what this branch decides)"]);
  assert.deepEqual(problemsOf(new Map([["p.html#[data-x]", { src: "a\nb\nc", line: 10 }]]), new Map([["p.html#[data-x]", [[{ functionName: "", ranges: [{ startOffset: 0, endOffset: 5, count: 1 }, { startOffset: 4, endOffset: 5, count: 0 }], isBlockCoverage: true }]]]])), ["p.html#[data-x]:12 `c` never executed by the suite (add a test that asserts what this branch decides)"]);
  const short = inlineRunsFromReports([{ result: [{ url: "inline:p.html#[data-x]", functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }] }] }], sources);
  assert.deepEqual([...short.runs.keys()], []);
  assert.deepEqual(short.problems, [`p.html#[data-x]: compiled as 10 code units but the extracted block is ${body.length}; run inlineScript(...).src through new Function`]);
});

test("fixture: a real child run reports the dead branch of a tmp page's inline script at its page line and nothing for a fully asserted one", () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-floor-inline-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "w"));
    const page = (hook) => `<!doctype html>\n<html>\n<body>\n<script>\n(function () {\n  var root = document.querySelector('${hook}');\n  if (!root) return;\n  root.className = root.getAttribute('data-on') ? 'on' : 'off';\n})();\n</script>\n</body>\n</html>\n`;
    writeFileSync(join(dir, "index.html"), page("[data-dead]"));
    writeFileSync(join(dir, "w", "index.html"), page("[data-live]"));
    const helper = pathToFileURL(join(HERE, "inline-scripts.mjs")).href;
    const harness = (pageRel, hook, boots) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nimport { inlineScript } from ${JSON.stringify(helper)};\nconst { src } = inlineScript(readFileSync(${JSON.stringify(join(dir, pageRel))}, "utf8"), ${JSON.stringify(pageRel)}, ${JSON.stringify(hook)});\nfunction boot(root) { new Function("document", src)({ querySelector: () => root }); return root; }\n${boots}\n`;
    const el = (on) => `{ attrs: ${on ? "{ 'data-on': '1' }" : "{}"}, getAttribute(k) { return this.attrs[k]; }, className: "" }`;
    writeFileSync(join(dir, "scripts", "dead.test.mjs"), harness("index.html", "[data-dead]", `test("on", () => assert.equal(boot(${el(true)}).className, "on"));`));
    writeFileSync(join(dir, "scripts", "live.test.mjs"), harness("w/index.html", "[data-live]", `test("on", () => assert.equal(boot(${el(true)}).className, "on"));\ntest("off", () => assert.equal(boot(${el(false)}).className, "off"));\ntest("absent", () => assert.equal(boot(null), null));`));
    const registry = { "index.html": [{ hook: "[data-dead]", harness: "scripts/dead.test.mjs" }], "w/index.html": [{ hook: "[data-live]", harness: "scripts/live.test.mjs" }] };
    const sources = inlineSources(dir, registry);
    assert.deepEqual([...sources.keys()], ["index.html#[data-dead]", "w/index.html#[data-live]"]);
    assert.equal(sources.get("index.html#[data-dead]").line, 4);
    const { reports, status, stdout, stderr } = collect(dir, suiteFiles(dir));
    assert.equal(status, 0, `${stdout}\n${stderr}`);
    const { runs, problems } = inlineRunsFromReports(reports, sources);
    assert.deepEqual(problems, []);
    assert.deepEqual([...runs.keys()].sort(), ["index.html#[data-dead]", "w/index.html#[data-live]"]);
    assert.deepEqual(problemsOf(sources, runs), [
      "index.html#[data-dead]:7 `return;` never executed by the suite (add a test that asserts what this branch decides)",
      "index.html#[data-dead]:8 `: 'off'` never executed by the suite (add a test that asserts what this branch decides)",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture: functionSpans finds top-level declarations only and deadRanges honours within", () => {
  const src = 'import x from "y";\nexport function a(v) {\n  return v ? "{" : "}";\n}\n\nasync function b() {\n  if (c) {\n    d();\n  }\n}\nfunction notClosed() { return 1; }\ntest("t", () => {\n  const f = function () { return 2; };\n  return f;\n});\n';
  const spans = functionSpans(src);
  assert.deepEqual(spans.map(([s, e]) => src.slice(s, e).split("\n")[0]), ["export function a(v) {", "async function b() {"]);
  assert.equal(src.slice(...spans[0]).at(-1), "}");
  assert.equal(src.slice(...spans[1]).at(-1), "}");
  assert.deepEqual(functionSpans("export function f() {\n  return 1;\n}"), [[0, 35]]);
  assert.deepEqual(functionSpans("export function f() { return 1; }\n"), []);
  assert.deepEqual(functionSpans("function f() { return 1; }\ntest(\"t\", () => {\n  f();\n});\nfunction g() {\n  return 2;\n}\n").map(([s]) => s), [56]);
  assert.deepEqual(functionSpans("export function f() {\n  return 1;\n});\n"), []);
  assert.deepEqual(functionSpans("export function f() {\n  return 1;"), []);
  assert.deepEqual(functionSpans("const x = 1;\n"), []);
  const inA = src.indexOf(': "}"');
  const inTest = src.indexOf("return 2;");
  const runs = [[{ functionName: "", ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }, { startOffset: inA, endOffset: inA + 5, count: 0 }, { startOffset: inTest, endOffset: inTest + 9, count: 0 }], isBlockCoverage: true }]];
  assert.deepEqual(deadRanges(src, runs), [[inA, inA + 5], [inTest, inTest + 9]]);
  assert.deepEqual(deadRanges(src, runs, spans), [[inA, inA + 5]]);
  assert.deepEqual(problemsOf(new Map([["scripts/g.test.mjs", { src, within: spans }]]), new Map([["scripts/g.test.mjs", runs]])), [
    'scripts/g.test.mjs:3 `: "}"` never executed by the suite (add a test that asserts what this branch decides)',
  ]);
});

test("fixture: the ratchet fails on growth, on a stale entry and on an unlowered one, and passes at the baseline", () => {
  const byFile = new Map([["scripts/a.test.mjs", ["a:1 dead", "a:2 dead"]], ["scripts/b.test.mjs", []], ["scripts/c.test.mjs", ["c:1 dead"]]]);
  assert.deepEqual(ratchetProblems(byFile, { "scripts/a.test.mjs": 2, "scripts/c.test.mjs": 1 }), []);
  assert.deepEqual(ratchetProblems(byFile, { "scripts/a.test.mjs": 1, "scripts/c.test.mjs": 1 }), ["scripts/a.test.mjs: 2 dead ranges, baseline allows 1", "a:1 dead", "a:2 dead"]);
  assert.deepEqual(ratchetProblems(byFile, { "scripts/a.test.mjs": 2 }), ["scripts/c.test.mjs: 1 dead ranges, baseline allows 0", "c:1 dead"]);
  assert.deepEqual(ratchetProblems(byFile, { "scripts/a.test.mjs": 3, "scripts/b.test.mjs": 1, "scripts/c.test.mjs": 1 }), [
    "scripts/a.test.mjs: 2 dead ranges left, baseline allows 3 — lower TEST_HELPER_BASELINE to 2",
    "scripts/b.test.mjs: 0 dead ranges left, baseline allows 1 — lower TEST_HELPER_BASELINE to nothing (delete the entry)",
  ]);
  assert.deepEqual(ratchetProblems(byFile, { "scripts/a.test.mjs": 2, "scripts/c.test.mjs": 1, "scripts/gone.test.mjs": 1 }), ["scripts/gone.test.mjs: in TEST_HELPER_BASELINE but not a gate under scripts/ — delete the entry"]);
  assert.deepEqual(ratchetProblems(new Map([["scripts/n.test.mjs", ["scripts/n.test.mjs: never loaded by the suite"]]]), {}), ["scripts/n.test.mjs: 1 dead ranges, baseline allows 0", "scripts/n.test.mjs: never loaded by the suite"]);
  assert.ok(Object.values(TEST_HELPER_BASELINE).every((n) => Number.isInteger(n) && n > 0), "baseline entries are positive integers; delete an entry at zero");
});

test("fixture: a real child run reads a gate's own top-level functions and nothing inside its test bodies", () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-floor-gate-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "gate.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nexport function pick(x) {\n  return x ? "yes" : "no";\n}\ntest("yes", () => {\n  assert.equal(pick(1), "yes");\n  if (!pick(1)) assert.fail("unreachable");\n});\n');
    writeFileSync(join(dir, "scripts", "plain.test.mjs"), 'import { test } from "node:test";\ntest("plain", () => {});\n');
    writeFileSync(join(dir, "scripts", "coverage-floor.test.mjs"), 'import { test } from "node:test";\nexport function ignored(x) {\n  return x ? 1 : 2;\n}\ntest("self", () => {});\n');
    const sources = testHelperSources(dir);
    assert.deepEqual([...sources.keys()], ["scripts/gate.test.mjs"]);
    assert.deepEqual([...testHelperSources(dir, "nothing.test.mjs").keys()], ["scripts/coverage-floor.test.mjs", "scripts/gate.test.mjs"]);
    const { reports, status, stdout, stderr } = collect(dir, suiteFiles(dir));
    assert.equal(status, 0, `${stdout}\n${stderr}`);
    const byFile = problemsByFile(sources, runsFromReports(reports, dir, sources));
    assert.deepEqual([...byFile], [["scripts/gate.test.mjs", [
      'scripts/gate.test.mjs:4 `: "no"` never executed by the suite (add a test that asserts what this branch decides)',
    ]]]);
    assert.deepEqual(ratchetProblems(byFile, { "scripts/gate.test.mjs": 1 }), []);
    assert.equal(ratchetProblems(byFile, {}).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- live gate --------------------------------------------------------------

test("every branch of every scripts/*.mjs helper and every inline page script is executed by the suite", { skip: process.env[CHILD_ENV] ? "running inside the coverage-floor child" : false }, () => {
  const sources = helperSources(ROOT);
  assert.ok(sources.size > 0, "no helpers under scripts/");
  const inline = inlineSources(ROOT);
  assert.ok(inline.size > 0, "no inline scripts registered in HARNESSED_SCRIPTS");
  const files = suiteFiles(ROOT);
  assert.ok(!files.includes(`scripts/${SELF}`));
  const { reports, status, stdout, stderr } = collect(ROOT, files);
  assert.equal(status, 0, `child suite failed; fix it first\n${stdout}\n${stderr}`);
  const inlineRuns = inlineRunsFromReports(reports, inline);
  assert.deepEqual([
    ...problemsOf(sources, runsFromReports(reports, ROOT, sources)),
    ...inlineRuns.problems,
    ...problemsOf(inline, inlineRuns.runs),
  ], []);
});

test("every branch of every gate's own top-level functions is executed by the suite, down to TEST_HELPER_BASELINE", { skip: process.env[CHILD_ENV] ? "running inside the coverage-floor child" : false }, () => {
  const sources = testHelperSources(ROOT);
  assert.ok(sources.size > 0, "no gate under scripts/ declares a top-level function");
  const { reports, status, stdout, stderr } = collect(ROOT, suiteFiles(ROOT));
  assert.equal(status, 0, `child suite failed; fix it first\n${stdout}\n${stderr}`);
  assert.deepEqual(ratchetProblems(problemsByFile(sources, runsFromReports(reports, ROOT, sources)), TEST_HELPER_BASELINE), []);
});

test("fixture: real inline child coverage maps Function wrappers to original page lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-inline-fixture-"));
  try {
    mkdirSync(join(dir, "scripts"));
    const page = '<h1>Fixture</h1>\n\n<script>\nfunction pick(x) {\n  return x ? "yes" : "no";\n}\nassert.equal(pick(flag), expected);\n</script>';
    writeFileSync(join(dir, "page.html"), page);
    const helper = pathToFileURL(join(HERE, "inline-scripts.mjs")).href;
    writeFileSync(join(dir, "scripts", "page.test.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inlineScript } from ${JSON.stringify(helper)};
const { src } = inlineScript(readFileSync("page.html", "utf8"), "page.html", "pick");
new Function("assert", "flag", "expected", src)(assert, true, "yes");
new Function("assert", "flag", "expected", "unusedLongParameter", src)(assert, true, "yes");
`);
    const registry = { "page.html": [{ hook: "pick" }] };
    const sources = inlineSources(dir, registry);
    const first = collect(dir, suiteFiles(dir));
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const { runs, problems } = inlineRunsFromReports(first.reports, sources);
    assert.deepEqual(problems, []);
    assert.deepEqual([...runs.keys()], ["page.html#pick"]);
    assert.deepEqual(problemsOf(sources, runs), [
      'page.html#pick:5 `: "no"` never executed by the suite (add a test that asserts what this branch decides)',
    ]);
    assert.deepEqual(problemsOf(sources, new Map()), ['page.html#pick: never loaded by the suite']);
    writeFileSync(join(dir, "scripts", "both.test.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inlineScript } from ${JSON.stringify(helper)};
new Function("assert", "flag", "expected", inlineScript(readFileSync("page.html", "utf8"), "page.html", "pick").src)(assert, false, "no");
`);
    const both = collect(dir, suiteFiles(dir));
    assert.equal(both.status, 0, both.stdout + both.stderr);
    assert.deepEqual(problemsOf(sources, inlineRunsFromReports(both.reports, sources).runs), []);
    assert.deepEqual([...inlineRunsFromReports([{ result: [{ url: "inline:unknown", functions: [] }, { url: "node:fs" }, { url: pathToFileURL(join(dir, "scripts", "unknown.mjs")).href }] }, {}], sources).runs], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
