#!/usr/bin/env node
// Static gate over the repository paths named in backticks by README.md and
// runbooks/*.md. The prose there is how a contributor (or an on-call reader at
// 3am) finds `scripts/check-links.sh`, `.github/workflows/scorecard.yml` or
// `.well-known/security.txt`; nothing else notices when a script is renamed,
// a workflow dropped or a runbook moved while the prose keeps pointing at the
// old name. page-meta.test.mjs resolves Markdown *links* only, and
// ci-wiring.test.mjs only checks that every existing gate is described by
// README `## Checks` — not that every described path still exists. A word in
// an inline code span is a path claim when it starts with `./`, when its
// first segment is a committed top-level directory, or when it is
// root-absolute — and in the latter two cases ends in a file extension or `/`
// (so `/404.html`, `/stories/` and `scripts/*.sh` are checked while URL-path
// examples like `/some/deep/path`, action references like
// `github/codeql-action/upload-sarif` and bare basenames are not).
// A `*` in the last segment is a glob that must match at least one file.
// Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/doc-paths.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SKIP_DIRS = new Set([".git", "node_modules", ".linkcheck-work"]);

// --- parsing -----------------------------------------------------------------

// Inline `code` spans outside fenced blocks, each as { text, line }.
export function codeSpans(markdown) {
  const out = [];
  let inFence = false;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) out.push({ text: m[1], line: i + 1 });
  }
  return out;
}

const EXT_RE = /\.[A-Za-z0-9]+$/;

// The words of a code span that claim to name a repository path, as
// { word, rel } where rel is the repository-relative path to resolve.
// topDirs is the set of committed top-level directory names.
export function pathClaims(span, topDirs) {
  const claims = [];
  for (let word of span.split(/\s+/)) {
    word = word.replace(/^[(]+/, "").replace(/[),.:;]+$/, "");
    if (!word || /[<>{}$@`]|:\/\//.test(word)) continue;
    if (word.startsWith("./")) {
      claims.push({ word, rel: word.slice(2) });
    } else if (word.startsWith("/")) {
      if (word.endsWith("/")) claims.push({ word, rel: `${word.slice(1)}index.html` });
      else if (EXT_RE.test(basename(word))) claims.push({ word, rel: word.slice(1) });
    } else if (word.includes("/") && topDirs.has(word.split("/")[0])) {
      // Redirect shortcuts (`github/`, `docs/`…) are committed directories too,
      // so `github/codeql-action/upload-sarif` would otherwise read as a path.
      if (word.endsWith("/") || EXT_RE.test(basename(word))) claims.push({ word, rel: word });
    }
  }
  return claims;
}

// Turns `*` (last segment only) into a RegExp over the basename.
function globToRegExp(pattern) {
  return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

// Resolves rel against root; `*` in the last segment matches at least one entry.
export function pathExists(root, rel, fs = { existsSync, readdirSync }) {
  const full = resolve(root, rel);
  if (!full.startsWith(resolve(root))) return false;
  if (!basename(rel).includes("*")) return fs.existsSync(full);
  const dir = dirname(full);
  if (dir.includes("*") || !fs.existsSync(dir)) return false;
  const re = globToRegExp(basename(rel));
  return fs.readdirSync(dir).some((name) => re.test(name));
}

// docs: { "README.md": text, "runbooks/x.md": text }. Returns one problem line
// per path claim that does not resolve to a committed file or directory.
export function docPathProblems(docs, { root, topDirs, exists = (rel) => pathExists(root, rel) }) {
  const problems = [];
  for (const [name, text] of Object.entries(docs)) {
    for (const span of codeSpans(text)) {
      for (const { word, rel } of pathClaims(span.text, topDirs)) {
        if (!exists(rel)) problems.push(`${name}:${span.line}: \`${word}\` does not exist in the repository`);
      }
    }
  }
  return problems;
}

function markdownFiles(dir = ROOT) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...markdownFiles(full));
    } else if (name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out.sort();
}

export function topLevelDirs(root) {
  return new Set(readdirSync(root).filter((n) => !SKIP_DIRS.has(n) && statSync(join(root, n)).isDirectory()));
}

// --- fixture self-tests ------------------------------------------------------

const TOP = new Set(["scripts", ".github", ".well-known", "runbooks", "stories", "github"]);

test("fixture: codeSpans reads inline spans with line numbers and skips fenced blocks", () => {
  const md = "a `one` b `two three`\n```\n`fenced`\n```\nx `four`\n~~~sh\n`also fenced`\n~~~\n";
  assert.deepEqual(codeSpans(md), [
    { text: "one", line: 1 },
    { text: "two three", line: 1 },
    { text: "four", line: 5 },
  ]);
});

test("fixture: pathClaims accepts ./, top-level-dir and root-absolute file/dir words", () => {
  assert.deepEqual(pathClaims("./make-redirects.sh", TOP), [{ word: "./make-redirects.sh", rel: "make-redirects.sh" }]);
  assert.deepEqual(pathClaims("scripts/check-links.sh [--external-warn]", TOP), [{ word: "scripts/check-links.sh", rel: "scripts/check-links.sh" }]);
  assert.deepEqual(pathClaims("node --test scripts/x.test.mjs", TOP), [{ word: "scripts/x.test.mjs", rel: "scripts/x.test.mjs" }]);
  assert.deepEqual(pathClaims(".github/workflows/links.yml", TOP), [{ word: ".github/workflows/links.yml", rel: ".github/workflows/links.yml" }]);
  assert.deepEqual(pathClaims("/404.html", TOP), [{ word: "/404.html", rel: "404.html" }]);
  assert.deepEqual(pathClaims("/stories/", TOP), [{ word: "/stories/", rel: "stories/index.html" }]);
  assert.deepEqual(pathClaims("(see scripts/a.sh).", TOP), [{ word: "scripts/a.sh", rel: "scripts/a.sh" }]);
  assert.deepEqual(pathClaims("scripts/", TOP), [{ word: "scripts/", rel: "scripts/" }]);
});

test("fixture: pathClaims skips URL-path examples, action refs, basenames, extensions, URLs and templates", () => {
  for (const s of [
    "/some/deep/path",
    "/code",
    "actions/checkout",
    "github/codeql-action/upload-sarif",
    "scripts/no-extension",
    "links.yml",
    "SECURITY.md",
    ".mjs",
    "*.test.mjs",
    "https://hivecommons.dev/scripts/x.sh",
    "${{ github.ref }}",
    "scripts/<name>.sh",
    "owner@scripts/x",
  ]) {
    assert.deepEqual(pathClaims(s, TOP), [], s);
  }
});

test("fixture: pathExists resolves plain paths, last-segment globs and rejects traversal", () => {
  const files = { "/r/scripts": ["a.sh", "a.test.sh", "b.mjs"], "/r/scripts/a.sh": 1, "/r/404.html": 1, "/r": ["scripts", "404.html"] };
  const fs = { existsSync: (p) => p in files, readdirSync: (p) => files[p] };
  assert.equal(pathExists("/r", "scripts/a.sh", fs), true);
  assert.equal(pathExists("/r", "scripts/zz.sh", fs), false);
  assert.equal(pathExists("/r", "scripts/*.sh", fs), true);
  assert.equal(pathExists("/r", "scripts/*.test.sh", fs), true);
  assert.equal(pathExists("/r", "scripts/*.yml", fs), false);
  assert.equal(pathExists("/r", "nope/*.sh", fs), false);
  assert.equal(pathExists("/r", "../etc/passwd", fs), false);
});

test("fixture: docPathProblems names file, line and word for every dead claim and nothing else", () => {
  const docs = {
    "README.md": "- `scripts/ok.sh` — a\n- `scripts/gone.sh` — b\n\n`node --test scripts/also-gone.test.mjs`\n",
    "runbooks/r.md": "Run `./make-redirects.sh`, then open `/404.html` and `/some/deep/path`.\n",
  };
  const live = new Set(["scripts/ok.sh", "make-redirects.sh", "404.html"]);
  assert.deepEqual(docPathProblems(docs, { topDirs: TOP, exists: (rel) => live.has(rel) }), [
    "README.md:2: `scripts/gone.sh` does not exist in the repository",
    "README.md:4: `scripts/also-gone.test.mjs` does not exist in the repository",
  ]);
  live.add("scripts/gone.sh").add("scripts/also-gone.test.mjs");
  assert.deepEqual(docPathProblems(docs, { topDirs: TOP, exists: (rel) => live.has(rel) }), []);
});

// --- live checks -------------------------------------------------------------

const TOP_DIRS = topLevelDirs(ROOT);
const DOCS = Object.fromEntries(markdownFiles().map((f) => [relative(ROOT, f), readFileSync(f, "utf8")]));

test("README.md and runbooks/*.md are present and name at least one repository path", () => {
  assert.ok("README.md" in DOCS, "README.md missing");
  assert.ok(Object.keys(DOCS).some((n) => n.startsWith("runbooks/")), "no runbooks/*.md found");
  const claims = Object.values(DOCS).flatMap((t) => codeSpans(t).flatMap((s) => pathClaims(s.text, TOP_DIRS)));
  assert.ok(claims.length > 0, "no backticked repository paths found — the gate has nothing to check");
});

for (const name of Object.keys(DOCS)) {
  test(`${name}: every backticked repository path resolves to a committed file or directory`, () => {
    assert.deepEqual(docPathProblems({ [name]: DOCS[name] }, { root: ROOT, topDirs: TOP_DIRS }), []);
  });
}
