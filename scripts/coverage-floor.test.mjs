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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SELF = basename(fileURLToPath(import.meta.url));
// Set in the child so a stray `coverage-floor.test.mjs` in its file list can
// never recurse; the file list below already leaves it out.
const CHILD_ENV = "COVERAGE_FLOOR_CHILD";

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
export function deadRanges(src, runs) {
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
    if (runs.some((functions) => (countOf(functions, start, end) ?? 0) > 0)) continue;
    out.push([start, end]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export function lineOf(src, offset) {
  return src.slice(0, offset).split("\n").length;
}

// One problem per dead range, naming file, line and the source it starts with.
export function problemsOf(sources, runsByFile) {
  const problems = [];
  for (const [file, src] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const runs = runsByFile.get(file);
    if (!runs) { problems.push(`${file}: never loaded by the suite`); continue; }
    for (const [start, end] of deadRanges(src, runs)) {
      const slice = src.slice(start, end).trim().split("\n")[0];
      const quoted = slice.length > 60 ? `${slice.slice(0, 57)}...` : slice;
      problems.push(`${file}:${lineOf(src, start)} \`${quoted}\` never executed by the suite (add a test that asserts what this branch decides)`);
    }
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

// --- live gate --------------------------------------------------------------

test("every branch of every scripts/*.mjs helper is executed by the suite", { skip: process.env[CHILD_ENV] ? "running inside the coverage-floor child" : false }, () => {
  const sources = helperSources(ROOT);
  assert.ok(sources.size > 0, "no helpers under scripts/");
  const files = suiteFiles(ROOT);
  assert.ok(!files.includes(`scripts/${SELF}`));
  const { reports, status, stdout, stderr } = collect(ROOT, files);
  assert.equal(status, 0, `child suite failed; fix it first\n${stdout}\n${stderr}`);
  assert.deepEqual(problemsOf(sources, runsFromReports(reports, ROOT, sources)), []);
});
