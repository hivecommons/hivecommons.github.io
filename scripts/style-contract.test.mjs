#!/usr/bin/env node
// Static gate for the site's CSS and its contract with the pages' markup and
// inline scripts. The stub-DOM tests prove a script toggles `is-active`; the
// markup gate proves the data-* hooks exist. Neither notices when style.css
// drifts: a stray brace that drops every rule after it, a `var(--x)` whose
// custom property nobody defines (the declaration is then invalid at
// computed-value time and the browser silently uses the initial value), a
// state class the script toggles that no rule styles any more, a
// `--hero-h` the script measures that CSS stopped reading, or a url() whose
// font or image file was renamed, truncated or never committed (the browser
// just keeps the fallback font). This file checks those contracts. Zero
// dependencies.
// Usage: node --test scripts/style-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "scripts", ".linkcheck-work"]);

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

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Replace every non-newline character so line numbers survive.
function blank(s) {
  return s.replace(/[^\n]/g, " ");
}

function markupOnly(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank);
}

// Bodies of the page's runnable inline scripts (not JSON-LD, not external).
export function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)(?![^>]*\btype\s*=\s*["'](?!module|text\/javascript)[^"']*["'])[^>]*>([\s\S]*?)<\/script>/gi)) out.push(m[1]);
  return out;
}

export function inlineStyles(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => ({ css: m[1], line: lineOf(html, m.index) }));
}

// Local stylesheet hrefs a page links (absolute-from-site-root or relative).
export function localStylesheetHrefs(html) {
  const out = [];
  for (const m of markupOnly(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const value = href && (href[1] ?? href[2] ?? href[3]);
    if (value && !/^(?:[a-z]+:)?\/\//i.test(value)) out.push(value.split(/[?#]/)[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSS structure: comments and strings terminate, braces and parens balance,
// every declaration in a style block is `name: value`, and nothing but
// at-statements sits at the top level. Returns human-readable problems.
// ---------------------------------------------------------------------------

export function stripComments(css) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) { out += blank(css.slice(i)); break; }
      out += blank(css.slice(i, end + 2));
      i = end + 2;
    } else {
      out += css[i++];
    }
  }
  return out;
}

function splitDeclarations(text) {
  const chunks = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth <= 0) { chunks.push(cur); cur = ""; }
    else cur += ch;
  }
  chunks.push(cur);
  return chunks;
}

export function cssStructureProblems(css, label = "css") {
  const problems = [];
  let i = 0;
  let line = 1;
  let paren = 0;
  // Each frame collects the text of its own block with nested blocks removed.
  const stack = [{ prelude: null, line: 1, text: "" }];
  const top = () => stack[stack.length - 1];

  const checkDeclarations = (frame) => {
    for (const raw of splitDeclarations(frame.text)) {
      const chunk = raw.trim();
      if (chunk === "") continue;
      if (frame.prelude === null) {
        if (!chunk.startsWith("@")) problems.push(`${label} line ${frame.line}: top-level text "${chunk.slice(0, 40)}" is not a rule or at-statement`);
      } else if (!/^(?:--[\w-]*|[-\w]+)\s*:\s*\S/.test(chunk)) {
        problems.push(`${label} line ${frame.line}: malformed declaration "${chunk.slice(0, 40)}" in "${frame.prelude}"`);
      }
    }
  };

  while (i < css.length) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) { problems.push(`${label} line ${line}: unterminated comment`); break; }
      line += (css.slice(i, end + 2).match(/\n/g) || []).length;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
      if (css[j] !== ch) { problems.push(`${label} line ${line}: unterminated string`); return problems; }
      // Keep the quotes but blank the content so a ";" or "{" in a string is inert.
      top().text += ch + " ".repeat(Math.max(0, j - i - 1)) + ch;
      i = j + 1;
      continue;
    }
    if (ch === "\n") line++;
    if (ch === "(") paren++;
    else if (ch === ")") {
      paren--;
      if (paren < 0) { problems.push(`${label} line ${line}: unexpected ")"`); paren = 0; }
    } else if (ch === "{" && paren === 0) {
      const frame = top();
      const cut = frame.text.lastIndexOf(";") + 1;
      const prelude = frame.text.slice(cut).trim();
      frame.text = frame.text.slice(0, cut);
      if (prelude === "") problems.push(`${label} line ${line}: "{" without a selector or at-rule prelude`);
      stack.push({ prelude: prelude || "?", line, text: "" });
      i++;
      continue;
    } else if (ch === "}" && paren === 0) {
      if (stack.length === 1) { problems.push(`${label} line ${line}: unexpected "}"`); i++; continue; }
      checkDeclarations(stack.pop());
      i++;
      continue;
    }
    top().text += ch;
    i++;
  }
  if (paren > 0) problems.push(`${label}: ${paren} unclosed "("`);
  while (stack.length > 1) {
    const frame = stack.pop();
    problems.push(`${label} line ${frame.line}: unclosed "{" for "${frame.prelude}"`);
  }
  checkDeclarations(stack[0]);
  return problems;
}

// ---------------------------------------------------------------------------
// Contracts between CSS, markup and inline scripts.
// ---------------------------------------------------------------------------

// Custom properties a stylesheet or inline <style> declares.
export function cssCustomPropertyDefinitions(css) {
  return new Set([...stripComments(css).matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

// Custom properties a page defines outside the stylesheet: style="--i:1" on
// an element, or script.style.setProperty('--hero-h', …).
export function pageCustomPropertyDefinitions(html) {
  const out = new Set();
  for (const m of markupOnly(html).matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const d of (m[1] ?? m[2]).matchAll(/(?:^|[;\s])(--[\w-]+)\s*:/g)) out.add(d[1]);
  }
  for (const d of scriptSetProperties(html)) out.add(d);
  return out;
}

export function scriptSetProperties(html) {
  const out = new Set();
  for (const src of inlineScripts(html)) {
    for (const m of src.matchAll(/\.setProperty\(\s*["'](--[\w-]+)["']/g)) out.add(m[1]);
  }
  return [...out].sort();
}

// var(--x) uses that carry no fallback value, with their line numbers.
export function cssVarUsesWithoutFallback(css) {
  const clean = stripComments(css);
  return [...clean.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => ({ name: m[1], line: lineOf(clean, m.index) }));
}

export function undefinedCustomProperties(css, definitions, label = "css") {
  const defs = new Set(definitions);
  const seen = new Set();
  const problems = [];
  for (const { name, line } of cssVarUsesWithoutFallback(css)) {
    if (defs.has(name) || seen.has(name)) continue;
    seen.add(name);
    problems.push(`${label} line ${line}: var(${name}) has no fallback and ${name} is defined nowhere (stylesheet, inline style= or script setProperty)`);
  }
  return problems;
}

export function cssVarNamesConsumed(css) {
  return new Set([...stripComments(css).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
}

export function unconsumedScriptProperties(html, css, label) {
  const consumed = cssVarNamesConsumed(css);
  return scriptSetProperties(html)
    .filter((name) => !consumed.has(name))
    .map((name) => `${label}: script sets ${name} via setProperty but no var(${name}) reads it in CSS`);
}

// Class selectors a stylesheet names (after dropping strings and url()).
export function cssClassSelectors(css) {
  const clean = stripComments(css).replace(/url\([^)]*\)/g, "url()").replace(/"[^"]*"|'[^']*'/g, '""');
  return new Set([...clean.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

function stringLiterals(args) {
  return [...args.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
}

// Classes the page's inline scripts write via classList.add/remove/toggle/replace.
export function scriptToggledClasses(html) {
  const out = new Set();
  for (const src of inlineScripts(html)) {
    for (const m of src.matchAll(/classList\s*\.\s*(add|remove|toggle|replace)\s*\(([^)]*)\)/g)) {
      const lits = stringLiterals(m[2]);
      // toggle(name, force): only the first argument is a class name.
      for (const c of m[1] === "toggle" ? lits.slice(0, 1) : lits) if (/^-?[_a-zA-Z][\w-]*$/.test(c)) out.add(c);
    }
  }
  return [...out].sort();
}

// Classes an inline script only reads back (contains / selector strings), which
// make a JS-only state class legitimate even when no CSS rule styles it.
export function scriptObservedClasses(html) {
  const out = new Set();
  for (const src of inlineScripts(html)) {
    for (const m of src.matchAll(/classList\s*\.\s*contains\s*\(\s*["']([^"']+)["']/g)) out.add(m[1]);
    for (const m of src.matchAll(/(?:querySelector(?:All)?|closest|matches)\s*\(\s*["']([^"']*)["']/g)) {
      for (const c of m[1].matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(c[1]);
    }
  }
  return out;
}

export function unstyledScriptClasses(html, css, label) {
  const styled = cssClassSelectors(css);
  for (const s of inlineStyles(html)) for (const c of cssClassSelectors(s.css)) styled.add(c);
  const observed = scriptObservedClasses(html);
  return scriptToggledClasses(html)
    .filter((c) => !styled.has(c) && !observed.has(c))
    .map((c) => `${label}: inline script toggles class "${c}" but no CSS rule or script selector references .${c}`);
}

// data-* attribute selectors the stylesheet uses must exist in some page.
export function cssDataSelectors(css) {
  return [...new Set([...stripComments(css).matchAll(/\[(data-[\w-]+)/g)].map((m) => m[1]))].sort();
}

export function missingCssDataSelectors(css, markups, label = "css") {
  return cssDataSelectors(css)
    .filter((attr) => !markups.some((markup) => new RegExp(`\\s${attr}(?=[\\s=/>])`).test(markup)))
    .map((attr) => `${label}: selector [${attr}] matches no element in any committed page`);
}

// ---------------------------------------------------------------------------
// Asset references. A url() that names a missing file fails silently in the
// browser: a @font-face with font-display: swap just keeps the fallback font
// and a background-image is simply absent, with nothing in CI to notice. The
// link checker only reads href/src in HTML, so these checks resolve every
// local url() in the stylesheet and inline <style> blocks against the
// checkout and confirm the file's magic bytes agree with its format() hint
// (or extension), so a renamed, truncated or mis-typed asset cannot ship.
// ---------------------------------------------------------------------------

// Local url() references with their line, optional format() hint and the
// property they appear in. data:, fragment and external (scheme or //) URLs
// are skipped; query/hash suffixes are dropped.
export function cssUrlReferences(css) {
  const clean = stripComments(css);
  const out = [];
  const re = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)(?:\s*format\(\s*["']([^"']+)["']\s*\))?/g;
  for (const m of clean.matchAll(re)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (raw === "" || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
    out.push({ url: raw.split(/[?#]/)[0], line: lineOf(clean, m.index), format: m[4] ? m[4].toLowerCase() : null });
  }
  return out;
}

// Resolve a url() against the site root (leading /) or the referencing file's directory.
export function resolveAssetPath(url, fromFile) {
  return url.startsWith("/") ? join(ROOT, url) : resolve(dirname(fromFile), url);
}

const SIGNATURES = {
  woff2: [Buffer.from("wOF2")],
  woff: [Buffer.from("wOFF")],
  truetype: [Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from("true")],
  opentype: [Buffer.from("OTTO"), Buffer.from([0x00, 0x01, 0x00, 0x00])],
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  jpg: [Buffer.from([0xff, 0xd8, 0xff])],
  gif: [Buffer.from("GIF87a"), Buffer.from("GIF89a")],
  webp: [Buffer.from("RIFF")],
  ico: [Buffer.from([0x00, 0x00, 0x01, 0x00])],
};
const EXT_KIND = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype", png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp", ico: "ico", svg: "svg" };
const FORMAT_KIND = { woff2: "woff2", woff: "woff", truetype: "truetype", opentype: "opentype", "truetype-variations": "truetype", "opentype-variations": "opentype", "woff2-variations": "woff2", "woff-variations": "woff" };

// The kind a reference claims to be: the format() hint wins over the extension.
export function expectedAssetKind(url, format) {
  if (format && FORMAT_KIND[format]) return FORMAT_KIND[format];
  const ext = /\.([a-z0-9]+)$/i.exec(url);
  return ext ? EXT_KIND[ext[1].toLowerCase()] ?? null : null;
}

// Whether a file's leading bytes match the kind. SVG is text: optional BOM/whitespace then "<".
export function bytesMatchKind(bytes, kind) {
  if (!kind) return true;
  if (kind === "svg") return /^\uFEFF?\s*</.test(bytes.subarray(0, 64).toString("utf8"));
  const sigs = SIGNATURES[kind];
  return sigs.some((sig) => bytes.length >= sig.length && bytes.subarray(0, sig.length).equals(sig));
}

// Problems for every local url() in `css` (which lives at `fromFile`), using
// `readAsset(path)` -> Buffer | null so fixtures can supply an in-memory tree.
export function missingCssAssets(css, fromFile, readAsset, label = "css") {
  const problems = [];
  const seen = new Set();
  for (const { url, line, format } of cssUrlReferences(css)) {
    const path = resolveAssetPath(url, fromFile);
    const key = `${path}|${format}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes = readAsset(path);
    if (bytes === null) { problems.push(`${label} line ${line}: url(${url}) names no committed file`); continue; }
    if (bytes.length === 0) { problems.push(`${label} line ${line}: url(${url}) is an empty file`); continue; }
    const kind = expectedAssetKind(url, format);
    if (format && !FORMAT_KIND[format]) problems.push(`${label} line ${line}: url(${url}) has unknown format("${format}")`);
    else if (!bytesMatchKind(bytes, kind)) problems.push(`${label} line ${line}: url(${url}) does not start with the ${kind} signature${format ? ` its format("${format}") promises` : ""}`);
  }
  return problems;
}

// Committed font files nothing references are dead weight that drifts
// silently (e.g. a weight dropped from @font-face but left on disk).
export function unreferencedFontFiles(fontFiles, referenced) {
  const used = new Set(referenced);
  return [...fontFiles].filter((f) => !used.has(f)).sort().map((f) => `${f} is committed but no url() in any stylesheet or inline <style> references it`);
}

function readAssetFromDisk(path) {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function fontFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...fontFilesUnder(full));
    else if (/\.(?:woff2?|ttf|otf)$/i.test(name)) out.push(relative(ROOT, full));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Fixture self-tests: prove every rule both passes clean input and fires.
// ---------------------------------------------------------------------------

const CLEAN_CSS = `/* header */
@import url("x.css");
:root { --bg: #000; --pad: .5rem; --font: "A;B", sans-serif; }
.a, .b:hover { color: var(--bg); padding: calc(var(--pad) * 2); background: url(data:image/png;base64,AAA=); }
@media (max-width: 36rem) {
  .c { margin: 0; content: "{"; }
  .d[data-root] { opacity: var(--missing, 1); }
}
.js .e.is-on { display: block; }
.no-js .e { display: none; }
.f { --i: 2; animation-delay: calc(var(--i) * 1s); height: var(--hero-h); }
`;

const CLEAN_HTML = `<!doctype html><html lang="en" class="no-js"><head><title>t</title>
<link rel="stylesheet" href="https://fonts.example/css?x">
<link rel="stylesheet" href="/style.css">
<style>.inline-only { color: red; }</style>
<script>document.documentElement.classList.replace('no-js', 'js');</script>
<script type="application/ld+json">{"a":"classList.add('ld-ghost')"}</script>
</head><body data-root>
<div class="f" style="--n: 3"></div>
<script>
  var el = document.querySelector('.e');
  el.classList.toggle('is-on', true);
  el.classList.add("inline-only", 'state-only');
  if (el.classList.contains('state-only')) {}
  el.style.setProperty('--hero-h', '10px');
  document.querySelectorAll('.js .e').length;
</script>
</body></html>`;

test("fixture: clean CSS and page pass every rule", () => {
  assert.deepEqual(cssStructureProblems(CLEAN_CSS), []);
  const defs = new Set([...cssCustomPropertyDefinitions(CLEAN_CSS), ...pageCustomPropertyDefinitions(CLEAN_HTML)]);
  assert.deepEqual([...defs].sort(), ["--bg", "--font", "--hero-h", "--i", "--n", "--pad"]);
  assert.deepEqual(undefinedCustomProperties(CLEAN_CSS, defs), []);
  assert.deepEqual(scriptSetProperties(CLEAN_HTML), ["--hero-h"]);
  assert.deepEqual(unconsumedScriptProperties(CLEAN_HTML, CLEAN_CSS, "page"), []);
  assert.deepEqual(scriptToggledClasses(CLEAN_HTML), ["inline-only", "is-on", "js", "no-js", "state-only"]);
  assert.deepEqual(unstyledScriptClasses(CLEAN_HTML, CLEAN_CSS, "page"), []);
  assert.deepEqual(cssDataSelectors(CLEAN_CSS), ["data-root"]);
  assert.deepEqual(missingCssDataSelectors(CLEAN_CSS, [markupOnly(CLEAN_HTML)]), []);
  assert.deepEqual(localStylesheetHrefs(CLEAN_HTML), ["/style.css"]);
});

test("fixture: unbalanced braces are reported with the opening line", () => {
  assert.deepEqual(cssStructureProblems(`.a {\n color: red;\n.b { margin: 0; }\n`), ['css line 1: unclosed "{" for ".a"']);
  assert.deepEqual(cssStructureProblems(`.a { color: red; }\n}\n`), ['css line 2: unexpected "}"']);
  assert.deepEqual(cssStructureProblems(`@media (x) {\n .a { color: red; }\n`), ['css line 1: unclosed "{" for "@media (x)"']);
});

test("fixture: unterminated comment, string and paren are reported", () => {
  assert.deepEqual(cssStructureProblems(`.a { color: red; }\n/* never closed\n.b { }`), ["css line 2: unterminated comment"]);
  assert.deepEqual(cssStructureProblems(`.a { content: "oops;\n}`), ["css line 1: unterminated string"]);
  assert.deepEqual(cssStructureProblems(`.a { width: calc(1px + (2px); }`), ['css: 1 unclosed "("', 'css line 1: unclosed "{" for ".a"']);
});

test("fixture: a declaration without a colon or value is reported in its rule", () => {
  assert.deepEqual(cssStructureProblems(`.a {\n color red;\n margin: ;\n padding: 0;\n}`), [
    'css line 1: malformed declaration "color red" in ".a"',
    'css line 1: malformed declaration "margin:" in ".a"',
  ]);
  assert.deepEqual(cssStructureProblems(`.a { color: red; }\nstray text;\n.b { }`), ['css line 1: top-level text "stray text" is not a rule or at-statement']);
  // Bare text that runs into a "{" is a (strange) selector, not stray text — CSS parses it the same way.
  assert.deepEqual(cssStructureProblems(`.a { color: red; }\nstray text\n.b { }`), []);
  assert.deepEqual(cssStructureProblems(`{ color: red; }`), ['css line 1: "{" without a selector or at-rule prelude']);
});

test("fixture: semicolons and braces inside strings, url() and comments are inert", () => {
  const css = `.a { content: ";{}"; background: url(data:x;base64,Zm9v); /* } { ; */ font-family: 'A;B'; }`;
  assert.deepEqual(cssStructureProblems(css), []);
});

test("fixture: a var() with no definition anywhere is reported once with its first line", () => {
  const css = `.a { color: var(--ghost); }\n.b { color: var(--ghost); background: var(--other, red); }`;
  assert.deepEqual(undefinedCustomProperties(css, new Set(["--bg"])), [
    "css line 1: var(--ghost) has no fallback and --ghost is defined nowhere (stylesheet, inline style= or script setProperty)",
  ]);
  assert.deepEqual(undefinedCustomProperties(css, new Set(["--ghost"])), []);
});

test("fixture: definitions inside comments or script text do not count", () => {
  assert.deepEqual([...cssCustomPropertyDefinitions(`/* --nope: 1; */ .a { --yes: 1; }`)], ["--yes"]);
  const html = `<html><body><script type="application/ld+json">{"s":"--ld: 1"}</script><script>var s = 'style=\"--txt: 1\"';</script><div style="--real: 2; color: red"></div></body></html>`;
  assert.deepEqual([...pageCustomPropertyDefinitions(html)], ["--real"]);
});

test("fixture: a property the script sets that CSS never reads is reported", () => {
  const html = `<html><body><script>el.style.setProperty('--measured', '1px'); el.style.setProperty("--read", "2px");</script></body></html>`;
  assert.deepEqual(unconsumedScriptProperties(html, `.a { height: var(--read, 0); }`, "page"), [
    "page: script sets --measured via setProperty but no var(--measured) reads it in CSS",
  ]);
});

test("fixture: a class the script toggles with no CSS rule and no script read is reported", () => {
  const html = `<html><body><script>
    el.classList.add('styled', 'js-only');
    el.classList.toggle('orphan', cond);
    el.classList.remove("gone");
    if (el.classList.contains('js-only')) {}
  </script></body></html>`;
  assert.deepEqual(scriptToggledClasses(html), ["gone", "js-only", "orphan", "styled"]);
  assert.deepEqual(unstyledScriptClasses(html, `.styled { color: red; } .x.gone { display: none; }`, "page"), [
    'page: inline script toggles class "orphan" but no CSS rule or script selector references .orphan',
  ]);
});

test("fixture: toggle's force argument and non-identifier literals are not class names", () => {
  const html = `<html><body><script>el.classList.toggle('is-over', length > 'MAX'); el.classList.add('' + x);</script></body></html>`;
  assert.deepEqual(scriptToggledClasses(html), ["is-over"]);
});

test("fixture: class selectors are not confused with decimals, file extensions or strings", () => {
  const css = `.real { width: .5rem; transition: all .55s; background: url(img/logo.png); content: ".fake"; } .also-real { }`;
  assert.deepEqual([...cssClassSelectors(css)].sort(), ["also-real", "real"]);
});

test("fixture: an inline <style> rule satisfies a toggled class", () => {
  const html = `<html><head><style>.only-inline { color: red; }</style></head><body><script>el.classList.add('only-inline');</script></body></html>`;
  assert.deepEqual(unstyledScriptClasses(html, ``, "page"), []);
});

test("fixture: a CSS data-* selector that no page's markup carries is reported", () => {
  const css = `[data-live] { } .x[data-dead="1"] { }`;
  const markup = markupOnly(`<html><body data-live><script>'<div data-dead>'</script></body></html>`);
  assert.deepEqual(missingCssDataSelectors(css, [markup]), ["css: selector [data-dead] matches no element in any committed page"]);
});

test("fixture: only local stylesheet hrefs are collected", () => {
  const html = `<html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">
<link rel="stylesheet" href="//cdn.example/x.css">
<link rel="preload" href="/not-a-stylesheet.css" as="style">
<link rel="stylesheet" href="/style.css?v=3">
<link href='theme.css' rel='stylesheet'>
<script>'<link rel="stylesheet" href="/ghost.css">'</script></head></html>`;
  assert.deepEqual(localStylesheetHrefs(html), ["/style.css", "theme.css"]);
});

test("fixture: url() references skip data:, external, fragment and empty URLs and keep format() hints", () => {
  const css = `@font-face { src: url(/assets/fonts/A.woff2) format('woff2'), url("/assets/fonts/A.woff") format("woff"); }
.a { background: url(data:image/png;base64,AAA=), url('https://cdn.example/x.png'), url(//cdn.example/y.png), url(#grad), url(); }
.b { background-image: url( "img/bee.svg?v=2#frag" ); cursor: url(../cur.png) 4 4, auto; }
/* url(/commented-out.png) */`;
  assert.deepEqual(cssUrlReferences(css), [
    { url: "/assets/fonts/A.woff2", line: 1, format: "woff2" },
    { url: "/assets/fonts/A.woff", line: 1, format: "woff" },
    { url: "img/bee.svg", line: 3, format: null },
    { url: "../cur.png", line: 3, format: null },
  ]);
  assert.equal(resolveAssetPath("/assets/x.png", join(ROOT, "a", "b.css")), join(ROOT, "assets", "x.png"));
  assert.equal(resolveAssetPath("../x.png", join(ROOT, "a", "b.css")), join(ROOT, "x.png"));
});

test("fixture: the expected kind comes from format() first, then the extension", () => {
  assert.equal(expectedAssetKind("/f.woff2", null), "woff2");
  assert.equal(expectedAssetKind("/f.bin", "woff2"), "woff2");
  assert.equal(expectedAssetKind("/f.woff2", "truetype-variations"), "truetype");
  assert.equal(expectedAssetKind("/f.JPEG", null), "jpg");
  assert.equal(expectedAssetKind("/f.svg", null), "svg");
  assert.equal(expectedAssetKind("/f.unknownext", null), null);
  assert.ok(bytesMatchKind(Buffer.from("wOF2\u0000rest"), "woff2"));
  assert.ok(!bytesMatchKind(Buffer.from("wOFF\u0000rest"), "woff2"));
  assert.ok(bytesMatchKind(Buffer.from("\uFEFF  <svg xmlns='x'/>"), "svg"));
  assert.ok(!bytesMatchKind(Buffer.from("PK\u0003\u0004"), "svg"));
  assert.ok(bytesMatchKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), "png"));
  assert.ok(bytesMatchKind(Buffer.from("anything"), null));
});

test("fixture: clean asset references pass and every failure mode is reported once with its line", () => {
  const tree = new Map([
    [join(ROOT, "assets", "fonts", "ok.woff2"), Buffer.from("wOF2\u0000\u0001")],
    [join(ROOT, "assets", "fonts", "wrong.woff2"), Buffer.from("wOFF\u0000\u0001")],
    [join(ROOT, "assets", "fonts", "empty.woff2"), Buffer.alloc(0)],
    [join(ROOT, "img", "bee.svg"), Buffer.from("<svg/>")],
    [join(ROOT, "img", "not-really.png"), Buffer.from("<html>404</html>")],
  ]);
  const readAsset = (p) => (tree.has(p) ? tree.get(p) : null);
  const from = join(ROOT, "style.css");
  assert.deepEqual(missingCssAssets(`@font-face { src: url(/assets/fonts/ok.woff2) format('woff2'); }\n.a { background: url(img/bee.svg); }`, from, readAsset), []);
  const bad = `@font-face { src: url(/assets/fonts/wrong.woff2) format('woff2'); }
@font-face { src: url(/assets/fonts/gone.woff2) format('woff2'); }
@font-face { src: url(/assets/fonts/empty.woff2) format('woff2'); }
@font-face { src: url(/assets/fonts/ok.woff2) format('eot'); }
.a { background: url(img/not-really.png); }
.b { background: url(/assets/fonts/gone.woff2) format('woff2'); }`;
  assert.deepEqual(missingCssAssets(bad, from, readAsset, "style.css"), [
    'style.css line 1: url(/assets/fonts/wrong.woff2) does not start with the woff2 signature its format("woff2") promises',
    "style.css line 2: url(/assets/fonts/gone.woff2) names no committed file",
    "style.css line 3: url(/assets/fonts/empty.woff2) is an empty file",
    'style.css line 4: url(/assets/fonts/ok.woff2) has unknown format("eot")',
    "style.css line 5: url(img/not-really.png) does not start with the png signature",
  ]);
  // A relative url() inside a page's inline <style> resolves against that page's directory.
  const pageTree = new Map([[join(ROOT, "stories", "img", "x.svg"), Buffer.from("<svg/>")]]);
  assert.deepEqual(missingCssAssets(`.a { background: url(img/x.svg); }`, join(ROOT, "stories", "index.html"), (p) => pageTree.get(p) ?? null), []);
  assert.deepEqual(missingCssAssets(`.a { background: url(img/x.svg); }`, join(ROOT, "index.html"), (p) => pageTree.get(p) ?? null, "index.html:5"), [
    "index.html:5 line 1: url(img/x.svg) names no committed file",
  ]);
});

test("fixture: a committed font file no stylesheet references is reported", () => {
  assert.deepEqual(unreferencedFontFiles(["assets/fonts/a.woff2", "assets/fonts/b.woff2"], ["assets/fonts/b.woff2"]), [
    "assets/fonts/a.woff2 is committed but no url() in any stylesheet or inline <style> references it",
  ]);
  assert.deepEqual(unreferencedFontFiles(["assets/fonts/a.woff2"], ["assets/fonts/a.woff2"]), []);
});

// ---------------------------------------------------------------------------
// Live gate over the committed site.
// ---------------------------------------------------------------------------

const pages = htmlFiles().map((path) => ({ path, rel: relative(ROOT, path), html: readFileSync(path, "utf8") }));
const contentPages = pages.filter((p) => !isRedirectPage(p.html));

// Every local stylesheet any page links, resolved against the checkout.
const stylesheets = new Map();
for (const p of pages) {
  for (const href of localStylesheetHrefs(p.html)) {
    const file = href.startsWith("/") ? join(ROOT, href) : resolve(dirname(p.path), href);
    const rel = relative(ROOT, file);
    if (!stylesheets.has(rel)) stylesheets.set(rel, { file, pages: [] });
    stylesheets.get(rel).pages.push(p.rel);
  }
}

test("the site has committed pages and a linked local stylesheet to check", () => {
  assert.ok(contentPages.some((p) => p.rel === "index.html"));
  assert.ok(stylesheets.has("style.css"), `expected pages to link /style.css; found ${[...stylesheets.keys()].join(", ") || "none"}`);
});

for (const [rel, { file, pages: linkedBy }] of stylesheets) {
  test(`${rel}: linked by ${linkedBy.join(", ")} and present in the checkout`, () => {
    assert.ok(existsSync(file), `${rel} is linked but not committed`);
  });
}

const allMarkup = pages.map((p) => markupOnly(p.html));
const pageDefinitions = new Set();
for (const p of pages) for (const d of pageCustomPropertyDefinitions(p.html)) pageDefinitions.add(d);

for (const [rel, { file, pages: linkedBy }] of stylesheets) {
  if (!existsSync(file)) continue;
  const css = readFileSync(file, "utf8");
  const inlineDefs = new Set();
  for (const p of pages) for (const s of inlineStyles(p.html)) for (const d of cssCustomPropertyDefinitions(s.css)) inlineDefs.add(d);
  const definitions = new Set([...cssCustomPropertyDefinitions(css), ...pageDefinitions, ...inlineDefs]);

  test(`${rel}: comments, strings, braces and parens balance and every declaration is name: value`, () => {
    assert.deepEqual(cssStructureProblems(css, rel), []);
  });

  test(`${rel}: every var(--x) without a fallback names a custom property defined somewhere`, () => {
    assert.deepEqual(undefinedCustomProperties(css, definitions, rel), []);
  });

  test(`${rel}: every [data-*] selector matches an element in some committed page`, () => {
    assert.deepEqual(missingCssDataSelectors(css, allMarkup, rel), []);
  });

  for (const p of contentPages.filter((cp) => linkedBy.includes(cp.rel))) {
    test(`${p.rel}: every class its inline scripts toggle is styled by ${rel} or read back by a script`, () => {
      assert.deepEqual(unstyledScriptClasses(p.html, css, p.rel), []);
    });

    test(`${p.rel}: every custom property its inline scripts set is read by ${rel}`, () => {
      assert.deepEqual(unconsumedScriptProperties(p.html, css, p.rel), []);
    });
  }
}

for (const p of pages) {
  for (const s of inlineStyles(p.html)) {
    test(`${p.rel}: inline <style> at line ${s.line} is structurally sound`, () => {
      assert.deepEqual(cssStructureProblems(s.css, `${p.rel}:${s.line}`), []);
    });
  }
}

// Every local url() in the stylesheet and in each page's inline <style> must
// name a committed file whose bytes match what the reference claims it is.
const referencedAssets = new Set();
for (const [rel, { file }] of stylesheets) {
  if (!existsSync(file)) continue;
  const css = readFileSync(file, "utf8");
  for (const { url } of cssUrlReferences(css)) referencedAssets.add(relative(ROOT, resolveAssetPath(url, file)));
  test(`${rel}: every local url() names a committed file whose signature matches its format()/extension`, () => {
    assert.deepEqual(missingCssAssets(css, file, readAssetFromDisk, rel), []);
  });
}
for (const p of pages) {
  for (const s of inlineStyles(p.html)) {
    const refs = cssUrlReferences(s.css);
    if (refs.length === 0) continue;
    for (const { url } of refs) referencedAssets.add(relative(ROOT, resolveAssetPath(url, p.path)));
    test(`${p.rel}: inline <style> at line ${s.line} references only committed assets`, () => {
      assert.deepEqual(missingCssAssets(s.css, p.path, readAssetFromDisk, `${p.rel}:${s.line}`), []);
    });
  }
}

test("style.css: self-hosted @font-face files are committed and every committed font file is referenced", () => {
  const fonts = fontFilesUnder(join(ROOT, "assets", "fonts"));
  assert.ok(fonts.length > 0, "expected self-hosted fonts under assets/fonts/");
  assert.deepEqual(unreferencedFontFiles(fonts, referencedAssets), []);
});

test("index.html: the carousel and ACMM state classes are the ones the stub-DOM tests exercise", () => {
  const index = contentPages.find((p) => p.rel === "index.html");
  const toggled = scriptToggledClasses(index.html);
  for (const expected of ["is-active", "is-current", "is-rotating", "js", "no-js"]) {
    assert.ok(toggled.includes(expected), `expected index.html scripts to toggle "${expected}"; got ${toggled.join(", ")}`);
  }
  assert.deepEqual(scriptSetProperties(index.html), ["--hero-h", "--hero-stage-h"]);
});
