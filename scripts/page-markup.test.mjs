#!/usr/bin/env node
// Static markup gate for every committed non-redirect HTML page. The stub-DOM
// script tests build their own fake elements, so they cannot notice when the
// real page drifts out from under the scripts or assistive tech: a renamed id
// leaves aria-controls dangling, a dropped data-* attribute makes a script
// silently return early, a new logo ships without alt text. This file checks
// the markup itself. Zero dependencies.
// Usage: node --test scripts/page-markup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "scripts", ".linkcheck-work"]);

// Attributes whose value is one or more whitespace-separated id references.
const IDREF_ATTRS = ["aria-controls", "aria-labelledby", "aria-describedby", "aria-owns", "aria-activedescendant", "for"];

function htmlFiles(dir = ROOT) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...htmlFiles(full));
    } else if (name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out.sort();
}

function isRedirectPage(html) {
  return /<meta[^>]+http-equiv\s*=\s*["']refresh["']/i.test(html);
}

function lineOf(html, index) {
  return html.slice(0, index).split("\n").length;
}

// Strip <script> and <style> bodies so their contents are not mistaken for markup
// (e.g. a querySelector('[data-x]') string is not a data-x attribute).
function markupOnly(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, " "));
}

function attrValue(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

function hasAttr(tag, name) {
  return new RegExp(`\\s${name}(?=[\\s=/>])`, "i").test(tag);
}

function tags(html) {
  const markup = markupOnly(html);
  return [...markup.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)].map((m) => ({
    name: m[1].toLowerCase(),
    tag: m[0],
    line: lineOf(markup, m.index),
  }));
}

// ---------------------------------------------------------------------------
// Rules. Each returns a list of human-readable problems (empty = pass).
// ---------------------------------------------------------------------------

export function duplicateIds(html) {
  const seen = new Map();
  const problems = [];
  for (const t of tags(html)) {
    const id = attrValue(t.tag, "id");
    if (id === null) continue;
    if (id.trim() === "") { problems.push(`line ${t.line}: empty id attribute`); continue; }
    if (seen.has(id)) problems.push(`line ${t.line}: duplicate id "${id}" (first at line ${seen.get(id)})`);
    else seen.set(id, t.line);
  }
  return problems;
}

export function danglingIdrefs(html) {
  const all = tags(html);
  const ids = new Set(all.map((t) => attrValue(t.tag, "id")).filter((v) => v !== null));
  const problems = [];
  for (const t of all) {
    for (const attr of IDREF_ATTRS) {
      // <label for> is an idref; <output for> too. Other elements never use "for".
      if (attr === "for" && t.name !== "label" && t.name !== "output") continue;
      const value = attrValue(t.tag, attr);
      if (value === null) continue;
      for (const ref of value.trim().split(/\s+/).filter(Boolean)) {
        if (!ids.has(ref)) problems.push(`line ${t.line}: ${attr}="${ref}" does not match any id on the page`);
      }
    }
  }
  return problems;
}

export function imagesWithoutAlt(html) {
  return tags(html)
    .filter((t) => t.name === "img" && !hasAttr(t.tag, "alt"))
    .map((t) => `line ${t.line}: <img> without alt attribute`);
}

export function missingHtmlLang(html) {
  const root = tags(html).find((t) => t.name === "html");
  if (!root) return ["no <html> element"];
  const lang = attrValue(root.tag, "lang");
  if (lang === null || lang.trim() === "") return [`line ${root.line}: <html> has no lang attribute`];
  return [];
}

export function tablistWiring(html) {
  const problems = [];
  for (const t of tags(html)) {
    const role = attrValue(t.tag, "role");
    if (role === "tab" && !attrValue(t.tag, "aria-controls")) {
      problems.push(`line ${t.line}: role="tab" without aria-controls`);
    }
    if (role === "tabpanel" && !attrValue(t.tag, "aria-labelledby")) {
      problems.push(`line ${t.line}: role="tabpanel" without aria-labelledby`);
    }
  }
  return problems;
}

// data-* attribute selectors the page's own inline scripts query, e.g.
// querySelector('[data-hero-slide]') or querySelectorAll("[data-acmm-panel]").
export function scriptDataHooks(html) {
  const hooks = new Set();
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)(?![^>]*\btype\s*=\s*["'](?!module|text\/javascript)[^"']*["'])[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const h of m[1].matchAll(/querySelector(?:All)?\(\s*["']\[(data-[\w-]+)\]["']\s*\)/g)) hooks.add(h[1]);
  }
  return [...hooks].sort();
}

export function missingDataHooks(html) {
  const markup = markupOnly(html);
  return scriptDataHooks(html)
    .filter((hook) => !new RegExp(`\\s${hook}(?=[\\s=/>])`).test(markup))
    .map((hook) => `inline script queries [${hook}] but no element in the page carries ${hook}`);
}

// ---------------------------------------------------------------------------
// Fixture self-tests: prove every rule both passes clean markup and fires.
// ---------------------------------------------------------------------------

const CLEAN = `<!doctype html><html lang="en"><head><title>t</title>
<style>.x[data-ghost]{color:red}</style>
<script>document.querySelector('[data-root]'); document.querySelectorAll("[data-item]");</script>
</head><body data-root>
<div role="tablist"><button id="tab-a" role="tab" aria-controls="panel-a">A</button></div>
<section id="panel-a" role="tabpanel" aria-labelledby="tab-a"><p data-item>x</p></section>
<label for="email">Email</label><input id="email" aria-describedby="hint-1 hint-2">
<small id="hint-1">a</small><small id='hint-2'>b</small>
<img src="a.png" alt=""><img src="b.png" alt="B logo">
</body></html>`;

test("fixture: clean page passes every rule", () => {
  assert.deepEqual(duplicateIds(CLEAN), []);
  assert.deepEqual(danglingIdrefs(CLEAN), []);
  assert.deepEqual(imagesWithoutAlt(CLEAN), []);
  assert.deepEqual(missingHtmlLang(CLEAN), []);
  assert.deepEqual(tablistWiring(CLEAN), []);
  assert.deepEqual(scriptDataHooks(CLEAN), ["data-item", "data-root"]);
  assert.deepEqual(missingDataHooks(CLEAN), []);
});

test("fixture: duplicate and empty ids are reported with both lines", () => {
  const html = `<html lang="en"><body>\n<p id="a">1</p>\n<p id="a">2</p>\n<p id="">3</p></body></html>`;
  assert.deepEqual(duplicateIds(html), [
    'line 3: duplicate id "a" (first at line 2)',
    "line 4: empty id attribute",
  ]);
});

test("fixture: idrefs that do not resolve are reported, including one token of a list", () => {
  const html = `<html lang="en"><body>\n<button role="tab" aria-controls="nope"></button>\n<input aria-describedby="h1 h2">\n<small id="h1"></small>\n<label for="missing"></label>\n<option for="not-an-idref"></option></body></html>`;
  assert.deepEqual(danglingIdrefs(html), [
    'line 2: aria-controls="nope" does not match any id on the page',
    'line 3: aria-describedby="h2" does not match any id on the page',
    'line 5: for="missing" does not match any id on the page',
  ]);
});

test("fixture: ids declared only inside <script> text do not satisfy idrefs", () => {
  const html = `<html lang="en"><body><script>var s = '<p id="ghost">';</script>\n<div aria-labelledby="ghost"></div></body></html>`;
  assert.equal(danglingIdrefs(html).length, 1);
});

test("fixture: <img> without alt is reported; alt=\"\" and unquoted alt are fine", () => {
  const html = `<html lang="en"><body>\n<img src="a.png">\n<img src="b.png" alt="">\n<img alt=x src="c.png">\n<img src="d.png"\n  width="1"></body></html>`;
  assert.deepEqual(imagesWithoutAlt(html), [
    "line 2: <img> without alt attribute",
    "line 5: <img> without alt attribute",
  ]);
});

test("fixture: missing or empty <html lang> is reported", () => {
  assert.deepEqual(missingHtmlLang(`<html><body></body></html>`), ["line 1: <html> has no lang attribute"]);
  assert.deepEqual(missingHtmlLang(`<html lang=""><body></body></html>`), ["line 1: <html> has no lang attribute"]);
  assert.deepEqual(missingHtmlLang(`<body></body>`), ["no <html> element"]);
  assert.deepEqual(missingHtmlLang(`<html lang="en-GB"></html>`), []);
});

test("fixture: tabs and tabpanels missing their ARIA pair are reported", () => {
  const html = `<html lang="en"><body>\n<button role="tab">A</button>\n<div role="tabpanel"></div>\n<div role="tablist"></div></body></html>`;
  assert.deepEqual(tablistWiring(html), [
    'line 2: role="tab" without aria-controls',
    'line 3: role="tabpanel" without aria-labelledby',
  ]);
});

test("fixture: data-* hooks are collected only from runnable inline scripts", () => {
  const html = `<html lang="en"><body data-a>
<script type="application/ld+json">{"q":"querySelector('[data-ld]')"}</script>
<script src="x.js">document.querySelector('[data-ext]')</script>
<script type="module">document.querySelector('[data-a]')</script>
<script>document.querySelectorAll( "[data-b]" )</script>
<style>[data-style]{}</style></body></html>`;
  assert.deepEqual(scriptDataHooks(html), ["data-a", "data-b"]);
  assert.deepEqual(missingDataHooks(html), [
    "inline script queries [data-b] but no element in the page carries data-b",
  ]);
});

test("fixture: a data-* hook mentioned only in CSS or script text does not count as present", () => {
  const html = `<html lang="en"><body>\n<style>[data-x]{}</style>\n<script>document.querySelector('[data-x]'); var t='<div data-x>';</script></body></html>`;
  assert.equal(missingDataHooks(html).length, 1);
});

test("fixture: a hook prefix does not satisfy a longer hook name", () => {
  const html = `<html lang="en"><body data-car>\n<script>document.querySelector('[data-car-track]')</script></body></html>`;
  assert.equal(missingDataHooks(html).length, 1);
});

// ---------------------------------------------------------------------------
// Live gate over the committed pages.
// ---------------------------------------------------------------------------

const pages = htmlFiles().filter((p) => !isRedirectPage(readFileSync(p, "utf8")));

test("the site has committed non-redirect HTML pages to check", () => {
  assert.ok(pages.includes(join(ROOT, "index.html")));
  assert.ok(pages.includes(join(ROOT, "stories", "index.html")));
});

for (const page of pages) {
  const rel = relative(ROOT, page);
  const html = readFileSync(page, "utf8");

  test(`${rel}: ids are unique`, () => {
    assert.deepEqual(duplicateIds(html), []);
  });

  test(`${rel}: every ARIA idref and label[for] resolves to an id on the page`, () => {
    assert.deepEqual(danglingIdrefs(html), []);
  });

  test(`${rel}: every <img> has an alt attribute`, () => {
    assert.deepEqual(imagesWithoutAlt(html), []);
  });

  test(`${rel}: <html> declares lang`, () => {
    assert.deepEqual(missingHtmlLang(html), []);
  });

  test(`${rel}: role=tab has aria-controls and role=tabpanel has aria-labelledby`, () => {
    assert.deepEqual(tablistWiring(html), []);
  });

  test(`${rel}: every data-* hook queried by an inline script exists in the markup`, () => {
    assert.deepEqual(missingDataHooks(html), []);
  });
}

test("index.html: the interactive scripts' data-* hooks are the ones the stub-DOM tests exercise", () => {
  const hooks = scriptDataHooks(readFileSync(join(ROOT, "index.html"), "utf8"));
  for (const expected of ["data-hero-carousel", "data-hero-slide", "data-acmm-levels", "data-acmm-panel", "data-carousel", "data-car-track"]) {
    assert.ok(hooks.includes(expected), `expected inline scripts to query [${expected}]; got ${hooks.join(", ")}`);
  }
});
