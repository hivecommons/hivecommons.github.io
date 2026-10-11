// Direct unit test for scripts/html-pages.mjs, the page-discovery helper every static
// gate (page-meta, page-csp, page-images, page-markup, page-structure, page-404,
// page-scripts, jsonld-contract, redirect-targets, ...) imports to decide WHICH pages
// it inspects. None of those gates checks the helper itself: a SKIP_DIRS entry that
// swallowed a content directory, a walker that stopped recursing, or an
// isRedirectPage() that stopped matching the generator's output would not fail a
// single gate — each would just run over fewer pages and pass vacuously. This file
// pins the walker against a throw-away tree and then pins the live tree so the
// helper can never report a page set that omits what the site ships.
// Zero dependencies. Usage: node --test scripts/html-pages.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { ROOT, SKIP_DIRS, htmlFiles, isRedirectPage, lineOf } from "./html-pages.mjs";

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "html-pages-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const rel = (dir, files) => files.map((f) => relative(dir, f).split(sep).join("/"));

// Paths of the shortcut redirects make-redirects.sh generates (its MAP keys).
// redirect-targets.test.mjs owns the full MAP contract; only the keys matter here.
function mapPaths() {
  const script = readFileSync(join(ROOT, "make-redirects.sh"), "utf8");
  const block = /declare -A MAP=\(([\s\S]*?)^\)/m.exec(script);
  assert.ok(block, "make-redirects.sh has no `declare -A MAP=( ... )` block");
  const paths = [...block[1].matchAll(/^\s*\[([^\]]+)\]=/gm)].map((m) => m[1]);
  assert.ok(paths.length > 0, "MAP block has no entries");
  return paths;
}

// --- htmlFiles -----------------------------------------------------------------

test("htmlFiles recurses into nested directories and returns a sorted list", () => {
  const dir = tree({
    "z/index.html": "",
    "a/b/c/deep.html": "",
    "index.html": "",
    "m/page.html": "",
  });
  try {
    assert.deepEqual(rel(dir, htmlFiles(dir)), ["a/b/c/deep.html", "index.html", "m/page.html", "z/index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("htmlFiles ignores files that are not .html, including .htm and .html.bak", () => {
  const dir = tree({
    "index.html": "",
    "style.css": "",
    "README.md": "",
    "old.htm": "",
    "index.html.bak": "",
    "sitemap.xml": "",
    "notes.HTML": "",
  });
  try {
    assert.deepEqual(rel(dir, htmlFiles(dir)), ["index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("htmlFiles skips exactly the SKIP_DIRS names, at any depth, and only as directories", () => {
  const files = { "index.html": "", "keep/index.html": "", "keep/scripts/nested-skip.html": "" };
  for (const name of SKIP_DIRS) files[`${name}/hidden.html`] = "";
  // A regular file whose name collides with a skip entry must still be a candidate
  // (it is not .html so it is ignored for that reason only — see next assertion).
  files["scripts.html"] = "";
  const dir = tree(files);
  try {
    assert.deepEqual(rel(dir, htmlFiles(dir)), ["index.html", "keep/index.html", "scripts.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("htmlFiles on an empty tree returns [] rather than throwing", () => {
  const dir = tree({});
  try {
    assert.deepEqual(htmlFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SKIP_DIRS names only tooling directories, never a content directory", () => {
  const expected = new Set([".git", ".github", "node_modules", "scripts", ".linkcheck-work"]);
  assert.deepEqual(SKIP_DIRS, expected, "a new SKIP_DIRS entry hides pages from every gate — add it here deliberately");
  for (const name of SKIP_DIRS) {
    assert.ok(name.startsWith(".") || name === "node_modules" || name === "scripts", `SKIP_DIRS entry ${JSON.stringify(name)} looks like a content directory`);
  }
});

// --- isRedirectPage --------------------------------------------------------------

test("isRedirectPage matches the generator's meta refresh in every attribute spelling", () => {
  const variants = [
    '<meta http-equiv="refresh" content="0; url=https://x">',
    "<meta http-equiv='refresh' content='0; url=https://x'>",
    '<meta http-equiv = "refresh" content="0">',
    '<META HTTP-EQUIV="Refresh" CONTENT="0">',
    '<meta content="0; url=/" http-equiv="refresh">',
    '<meta\n  http-equiv="refresh"\n  content="0">',
  ];
  for (const v of variants) assert.equal(isRedirectPage(`<!doctype html><head>${v}</head>`), true, v);
});

test("isRedirectPage does not match other http-equiv values or refresh mentioned elsewhere", () => {
  const negatives = [
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">',
    '<meta http-equiv="content-type" content="text/html">',
    '<meta name="refresh" content="0">',
    "<p>Click refresh to reload.</p>",
    '<a href="?refresh=1">refresh</a>',
    "",
  ];
  for (const n of negatives) assert.equal(isRedirectPage(n), false, n || "(empty)");
});

// --- lineOf --------------------------------------------------------------------

test("lineOf is 1-based and counts newlines before the index", () => {
  const text = "first\nsecond\nthird";
  assert.equal(lineOf(text, 0), 1);
  assert.equal(lineOf(text, 5), 1, "the newline itself still belongs to line 1");
  assert.equal(lineOf(text, 6), 2);
  assert.equal(lineOf(text, text.indexOf("third")), 3);
  assert.equal(lineOf(text, text.length), 3);
  assert.equal(lineOf("", 0), 1);
});

// --- live tree -----------------------------------------------------------------

test("live tree: htmlFiles(ROOT) includes the canonical pages, 404.html and every make-redirects.sh MAP page", () => {
  const pages = rel(ROOT, htmlFiles());
  assert.ok(pages.length > 0, "htmlFiles(ROOT) returned no pages — every gate would pass vacuously");
  for (const must of ["index.html", "404.html", "stories/index.html"]) {
    assert.ok(pages.includes(must), `${must} missing from htmlFiles(ROOT)`);
  }
  for (const path of mapPaths()) {
    assert.ok(pages.includes(`${path}/index.html`), `redirect page ${path}/index.html missing from htmlFiles(ROOT)`);
  }
});

test("live tree: nothing under a SKIP_DIRS directory is reported, and nothing reported lives outside ROOT", () => {
  for (const page of rel(ROOT, htmlFiles())) {
    assert.ok(!page.startsWith("../"), `${page} escapes ROOT`);
    const top = page.split("/")[0];
    assert.ok(!SKIP_DIRS.has(top), `${page} is under skipped directory ${top}`);
    assert.ok(existsSync(join(ROOT, page)), `${page} does not exist`);
  }
});

test("live tree: isRedirectPage agrees with the MAP — redirect pages are exactly the MAP paths", () => {
  const mapPages = new Set(mapPaths().map((p) => `${p}/index.html`));
  const redirects = rel(ROOT, htmlFiles()).filter((p) => isRedirectPage(readFileSync(join(ROOT, p), "utf8")));
  assert.deepEqual(new Set(redirects), mapPages);
});
