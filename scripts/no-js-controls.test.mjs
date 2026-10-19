#!/usr/bin/env node
// Static gate for controls that only work once an inline script attaches a
// handler. GitHub Pages serves static HTML, the pages ship `<html class="no-js">`
// and a one-line toggle swaps it for `js`, so a `<button type="button">` that
// a script wires up renders as a dead primary call to action for anyone whose
// JavaScript is blocked, slow or failing. The stub-DOM tests prove the handler
// works once attached; nothing proved the control was hidden until then —
// the two `[data-story-open]` buttons on /stories/ shipped exactly that way
// (#216). This file checks every such control is either revealed by the script
// (`hidden`, or inside a closed `<dialog>`), hidden by a `.no-js … { display:
// none }` rule, or a `role="tab"` whose panel is fully visible without
// JavaScript. Zero dependencies.
// Usage: node --test scripts/no-js-controls.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlFiles, isRedirectPage, lineOf } from "./html-pages.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

function blank(s) {
  return s.replace(/[^\n]/g, " ");
}

function markupOnly(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank);
}

function attrValue(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

function hasAttr(tag, name) {
  return new RegExp(`\\s${name}(?=[\\s=/>])`, "i").test(tag);
}

// ---------------------------------------------------------------------------
// Markup: every element with its open-tag text and ancestor chain. The
// page-structure gate already guarantees the tree is well formed, so a plain
// stack over start/end tags (void and self-closed tags excluded) is enough.
// ---------------------------------------------------------------------------

export function elements(html) {
  const markup = markupOnly(html);
  const stack = [];
  const out = [];
  for (const m of markup.matchAll(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g)) {
    const tag = m[0];
    const name = m[1].toLowerCase();
    if (tag.startsWith("</")) {
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at !== -1) stack.length = at;
      continue;
    }
    const el = {
      name,
      tag,
      line: lineOf(markup, m.index),
      id: attrValue(tag, "id"),
      classes: (attrValue(tag, "class") ?? "").split(/\s+/).filter(Boolean),
      attrs: [...tag.matchAll(/\s([a-zA-Z_:][\w:.-]*)(?=[\s=/>])/g)].map((a) => a[1].toLowerCase()),
      ancestors: [...stack],
    };
    out.push(el);
    if (!VOID_ELEMENTS.has(name) && !/\/>$/.test(tag)) stack.push(el);
  }
  return out;
}

// Controls whose only behaviour comes from a script: `<button type="button">`.
// Submit/reset buttons and type-less buttons (submit by default) have a native
// form behaviour and are left alone.
export function scriptOnlyButtons(html) {
  return elements(html).filter((el) => el.name === "button" && (attrValue(el.tag, "type") ?? "").toLowerCase() === "button");
}

// ---------------------------------------------------------------------------
// CSS: `display: none` rules keyed by whether they apply without JavaScript.
// Selectors are read as compound selectors joined by descendant/child
// combinators; `:not(…)`, pseudo-classes and pseudo-elements are dropped from
// each compound so a rule can only ever match MORE than the browser would,
// which keeps the gate conservative in the direction of "hidden" only where
// the selector's tail genuinely names the control or an ancestor.
// ---------------------------------------------------------------------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, blank);
}

// Flatten nested blocks (@media, @supports) into their inner rules.
function rules(css) {
  const out = [];
  const text = stripComments(css);
  let i = 0;
  const walk = (end) => {
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open === -1 || open >= end) { i = end; return; }
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < end && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith("@")) {
        if (/^@(media|supports|layer|container)\b/i.test(prelude)) {
          const save = i;
          i = open + 1;
          walk(j - 1);
          i = save;
        }
      } else {
        out.push({ selectors: prelude.split(",").map((s) => s.trim()).filter(Boolean), body, line: lineOf(text, open) });
      }
      i = j;
    }
  };
  walk(text.length);
  return out;
}

function hidesByDisplay(body) {
  return /(?:^|;)\s*display\s*:\s*none\b/i.test(body);
}

// A compound selector as the parts a static matcher can honour.
function parseCompound(compound) {
  let s = compound.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "");
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const tagMatch = /^[a-zA-Z][\w-]*|^\*/.exec(s);
  if (tagMatch) { out.tag = tagMatch[0] === "*" ? null : tagMatch[0].toLowerCase(); s = s.slice(tagMatch[0].length); }
  for (const m of s.matchAll(/\.([\w-]+)|#([\w-]+)|\[\s*([\w:.-]+)(?:[~|^$*]?=[^\]]*)?\]/g)) {
    if (m[1]) out.classes.push(m[1]);
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.attrs.push(m[3].toLowerCase());
  }
  return out;
}

export function parseSelector(selector) {
  return selector.split(/\s*[>~+]\s*|\s+/).filter(Boolean).map(parseCompound);
}

function compoundMatches(part, el) {
  if (part.tag && part.tag !== el.name) return false;
  if (part.id && part.id !== el.id) return false;
  if (!part.classes.every((c) => el.classes.includes(c))) return false;
  if (!part.attrs.every((a) => el.attrs.includes(a))) return false;
  return true;
}

// Does `parts` (outermost first) match `el` through its ancestor chain, with
// every combinator read as "descendant"? The last part must match el itself.
function selectorMatches(parts, el) {
  if (parts.length === 0 || !compoundMatches(parts[parts.length - 1], el)) return false;
  let p = parts.length - 2;
  for (let a = el.ancestors.length - 1; a >= 0 && p >= 0; a--) {
    if (compoundMatches(parts[p], el.ancestors[a])) p--;
  }
  return p < 0;
}

function isNoJsCompound(part) {
  return part.classes.includes("no-js") && part.tag === null && part.id === null && part.attrs.length === 0 && part.classes.length === 1;
}

function isJsCompound(part) {
  return part.classes.includes("js");
}

// `display: none` selectors that apply without JavaScript, split into those
// scoped under `.no-js` (which hide script-only controls) and those unscoped
// (which hide content in both modes). `.js`-scoped rules are JavaScript-only.
export function noJsHidingSelectors(css) {
  const noJs = [];
  const always = [];
  for (const rule of rules(css)) {
    if (!hidesByDisplay(rule.body)) continue;
    for (const selector of rule.selectors) {
      const parts = parseSelector(selector);
      if (parts.length === 0) continue;
      if (parts.some(isJsCompound)) continue;
      if (isNoJsCompound(parts[0])) noJs.push({ selector, parts: parts.slice(1), line: rule.line });
      else always.push({ selector, parts, line: rule.line });
    }
  }
  return { noJs, always };
}

// ---------------------------------------------------------------------------
// The rule.
// ---------------------------------------------------------------------------

function hiddenUntilScript(el) {
  if (hasAttr(el.tag, "hidden")) return "carries hidden";
  for (const a of el.ancestors) {
    if (hasAttr(a.tag, "hidden")) return `inside <${a.name}> with hidden (line ${a.line})`;
    if (a.name === "dialog" && !hasAttr(a.tag, "open")) return `inside closed <dialog> (line ${a.line})`;
  }
  return null;
}

function matchingSelector(selectors, el) {
  const chain = [el, ...el.ancestors];
  for (const target of chain) {
    for (const s of selectors) if (selectorMatches(s.parts, target)) return s;
  }
  return null;
}

// Every `<button type="button">` on the page must be unreachable without
// JavaScript, or be a tab whose panel is already visible. Returns problems.
export function deadWithoutScript(html, css, rel = "page") {
  const problems = [];
  const all = elements(html);
  const { noJs, always } = noJsHidingSelectors(css);
  for (const el of scriptOnlyButtons(html)) {
    if (hiddenUntilScript(el)) continue;
    if (matchingSelector(noJs, el)) continue;
    if (matchingSelector(always, el)) continue;
    const role = (attrValue(el.tag, "role") ?? "").toLowerCase();
    if (role === "tab") {
      const panelId = (attrValue(el.tag, "aria-controls") ?? "").trim();
      const panel = all.find((e) => e.id === panelId);
      if (panel && !hiddenUntilScript(panel) && !matchingSelector(always, panel) && !matchingSelector(noJs, panel)) continue;
      problems.push(`${rel}:${el.line}: <button type="button" role="tab"> controls "${panelId}" which is ${panel ? "hidden without JavaScript" : "not on the page"}; a tab is only no-js safe when its panel already shows`);
      continue;
    }
    const hook = el.attrs.find((a) => a.startsWith("data-")) ?? (el.id ? `#${el.id}` : el.classes.map((c) => `.${c}`).join("") || "<button>");
    problems.push(`${rel}:${el.line}: <button type="button"> (${hook}) is reachable without JavaScript and nothing hides it — add \`hidden\` (and reveal it from the script), move it inside a closed <dialog>, or add a \`.no-js … { display: none; }\` rule`);
  }
  return problems;
}

// Local stylesheet hrefs a page links, resolved to files in the checkout.
export function localStylesheets(html, pagePath) {
  const out = [];
  for (const m of markupOnly(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) continue;
    const href = attrValue(tag, "href");
    if (!href || /^(?:[a-z]+:)?\/\//i.test(href)) continue;
    const clean = href.split(/[?#]/)[0];
    out.push(clean.startsWith("/") ? join(ROOT, clean) : join(dirname(pagePath), clean));
  }
  return out;
}

export function inlineStyles(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Fixture self-tests.
// ---------------------------------------------------------------------------

const CSS = `
/* .no-js .in-comment { display: none; } */
.no-js .hero-controls { display: none; }
.no-js [data-story-open] { display:none }
.js .panel:not(.is-active) { display: none; }
.always-gone { color: red; display: none; }
@media (max-width: 40em) { .no-js .narrow-only { display: none; } }
.not-hidden { display: block; }
`;

const CLEAN = `<!doctype html><html lang="en" class="no-js"><head><title>t</title>
<link rel="stylesheet" href="/style.css"></head><body>
<div class="hero-controls" hidden><button type="button" data-hero-prev>p</button></div>
<section><button type="button" class="btn" data-story-open>share</button></section>
<div role="tablist">
  <button type="button" role="tab" aria-controls="p1" data-tab>one</button>
</div>
<article id="p1" class="panel" role="tabpanel">shown without js</article>
<dialog id="d"><button type="button" data-close>x</button><form><button type="submit">go</button></form></dialog>
<form><button>default submit</button><button type="reset">r</button></form>
<div class="always-gone"><button type="button" data-never>n</button></div>
<div class="narrow-only"><button type="button" data-narrow>n</button></div>
<script>document.querySelector('<button type="button" data-in-script>');</script>
<style>.x { display: none; }</style>
</body></html>`;

test("fixture: a page whose script-only buttons are all hidden without JavaScript passes", () => {
  assert.deepEqual(deadWithoutScript(CLEAN, CSS), []);
});

test("fixture: elements carry their ancestors, void and self-closed tags do not nest", () => {
  const els = elements(`<div class="a b" data-x><img src=x><svg><path d="M0"/></svg><p id="p">t</p></div><button type="button">b</button>`);
  const p = els.find((e) => e.name === "p");
  assert.deepEqual(p.ancestors.map((a) => a.name), ["div"]);
  assert.deepEqual(els.find((e) => e.name === "div").classes, ["a", "b"]);
  assert.deepEqual(els.find((e) => e.name === "div").attrs, ["class", "data-x"]);
  assert.deepEqual(els.find((e) => e.name === "button").ancestors, []);
  assert.deepEqual(scriptOnlyButtons(`<button type="button">a</button><button type="BUTTON">b</button><button>c</button><button type="submit">d</button>`).map((b) => b.line), [1, 1]);
});

test("fixture: a reachable script-only button with no .no-js rule is reported with its hook", () => {
  const html = CLEAN.replace("<section><button", "<section><button type=\"button\" data-rogue>r</button><button");
  assert.deepEqual(deadWithoutScript(html, CSS, "x.html"), [
    "x.html:4: <button type=\"button\"> (data-rogue) is reachable without JavaScript and nothing hides it — add `hidden` (and reveal it from the script), move it inside a closed <dialog>, or add a `.no-js … { display: none; }` rule",
  ]);
  const byId = deadWithoutScript(`<button type="button" id="copy">c</button>`, "", "y.html");
  assert.match(byId[0], /\(#copy\) is reachable/);
  const byClass = deadWithoutScript(`<button type="button" class="btn big">c</button>`, "", "y.html");
  assert.match(byClass[0], /\(\.btn\.big\) is reachable/);
  const bare = deadWithoutScript(`<button type="button">c</button>`, "", "y.html");
  assert.match(bare[0], /\(<button>\) is reachable/);
});

test("fixture: the stories regression — a data-story-open button with the .no-js rule removed", () => {
  const css = CSS.replace(".no-js [data-story-open] { display:none }", "");
  const problems = deadWithoutScript(CLEAN, css, "stories/index.html");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^stories\/index\.html:4: <button type="button"> \(data-story-open\)/);
});

test("fixture: `hidden` on the button or an ancestor, and a closed <dialog>, count as hidden until the script runs", () => {
  assert.deepEqual(deadWithoutScript(`<button type="button" hidden data-a>a</button>`, ""), []);
  assert.deepEqual(deadWithoutScript(`<div hidden><p><button type="button" data-a>a</button></p></div>`, ""), []);
  assert.deepEqual(deadWithoutScript(`<dialog><button type="button" data-a>a</button></dialog>`, ""), []);
  const open = deadWithoutScript(`<dialog open><button type="button" data-a>a</button></dialog>`, "", "p");
  assert.equal(open.length, 1, "an open dialog shows its buttons without JavaScript");
});

test("fixture: .no-js rules match the button or an ancestor through descendant and child combinators, including inside @media", () => {
  assert.deepEqual(deadWithoutScript(`<div class="hero-controls"><span><button type="button" data-a>a</button></span></div>`, CSS), []);
  assert.deepEqual(deadWithoutScript(`<div class="narrow-only"><button type="button" data-a>a</button></div>`, CSS), []);
  assert.deepEqual(deadWithoutScript(`<nav class="bar"><button type="button" class="go">a</button></nav>`, `.no-js nav.bar > .go { display: none; }`), []);
  assert.deepEqual(deadWithoutScript(`<nav class="bar"><button type="button" class="go">a</button></nav>`, `.no-js .bar #go { display: none; }`, "p").length, 1, "an id the button lacks does not match");
  assert.deepEqual(deadWithoutScript(`<div class="other"><button type="button" class="go">a</button></div>`, `.no-js .bar .go { display: none; }`, "p").length, 1, "an ancestor class the chain lacks does not match");
  assert.deepEqual(deadWithoutScript(`<div class="other"><button type="button" class="go">a</button></div>`, `.no-js .bar .go, .no-js .other .go { display: none; }`), [], "any selector in a group may match");
});

test("fixture: rules in comments, non-display rules and .js-scoped rules do not hide anything", () => {
  assert.equal(deadWithoutScript(`<div class="in-comment"><button type="button" data-a>a</button></div>`, CSS, "p").length, 1);
  assert.equal(deadWithoutScript(`<div class="not-hidden"><button type="button" data-a>a</button></div>`, CSS, "p").length, 1);
  assert.equal(deadWithoutScript(`<div class="panel"><button type="button" data-a>a</button></div>`, CSS, "p").length, 1, ".js-scoped display:none only applies once the script ran");
  assert.equal(deadWithoutScript(`<div class="a"><button type="button" data-a>a</button></div>`, `.no-js .a { display: nonetheless; }`, "p").length, 1);
  assert.deepEqual(deadWithoutScript(`<div class="a"><button type="button" data-a>a</button></div>`, `.no-js .a { color: red; display: none }`), []);
});

test("fixture: a .no-js compound carrying extra qualifiers is not the html toggle class", () => {
  const { noJs, always } = noJsHidingSelectors(`.no-js .a { display: none; } html.no-js .b { display: none; } .c.no-js .d { display: none; }`);
  assert.deepEqual(noJs.map((s) => s.selector), [".no-js .a"]);
  assert.deepEqual(always.map((s) => s.selector), ["html.no-js .b", ".c.no-js .d"]);
});

test("fixture: a tab is no-js safe only when its panel is on the page and visible without JavaScript", () => {
  const tab = (panel) => `<button type="button" role="tab" aria-controls="p1" data-tab>t</button>${panel}`;
  assert.deepEqual(deadWithoutScript(tab(`<article id="p1" class="panel">x</article>`), CSS), []);
  const hiddenPanel = deadWithoutScript(tab(`<article id="p1" class="panel" hidden>x</article>`), CSS, "p");
  assert.deepEqual(hiddenPanel, ["p:1: <button type=\"button\" role=\"tab\"> controls \"p1\" which is hidden without JavaScript; a tab is only no-js safe when its panel already shows"]);
  const alwaysHidden = deadWithoutScript(tab(`<article id="p1" class="always-gone">x</article>`), CSS, "p");
  assert.match(alwaysHidden[0], /hidden without JavaScript/);
  const noJsHidden = deadWithoutScript(tab(`<article id="p1" class="hero-controls">x</article>`), CSS, "p");
  assert.match(noJsHidden[0], /hidden without JavaScript/);
  const missing = deadWithoutScript(tab(``), CSS, "p");
  assert.match(missing[0], /controls "p1" which is not on the page/);
  const noControls = deadWithoutScript(`<button type="button" role="tab">t</button>`, CSS, "p");
  assert.match(noControls[0], /controls "" which is not on the page/);
});

test("fixture: selector parsing drops pseudo-classes and pseudo-elements and reads attribute selectors", () => {
  assert.deepEqual(parseSelector(".a:hover > b[data-x='1']::after .c:not(.d)"), [
    { tag: null, id: null, classes: ["a"], attrs: [] },
    { tag: "b", id: null, classes: [], attrs: ["data-x"] },
    { tag: null, id: null, classes: ["c"], attrs: [] },
  ]);
  assert.deepEqual(parseSelector("#main *"), [{ tag: null, id: "main", classes: [], attrs: [] }, { tag: null, id: null, classes: [], attrs: [] }]);
});

test("fixture: only local stylesheet hrefs are collected and inline <style> bodies are read", () => {
  const html = `<link rel="stylesheet" href="/style.css?v=2"><link rel="stylesheet" href="https://cdn/x.css"><link rel="icon" href="/f.ico"><link rel=stylesheet href="local.css"><style>.a{display:none}</style>`;
  assert.deepEqual(localStylesheets(html, join(ROOT, "sub", "index.html")).map((p) => relative(ROOT, p)), ["style.css", "sub/local.css"]);
  assert.deepEqual(inlineStyles(html), [".a{display:none}"]);
});

// ---------------------------------------------------------------------------
// The live site.
// ---------------------------------------------------------------------------

const pages = htmlFiles().map((path) => ({ path, rel: relative(ROOT, path), html: readFileSync(path, "utf8") }))
  .filter((p) => !isRedirectPage(p.html));

test("the site has script-only buttons to check", () => {
  const total = pages.reduce((n, p) => n + scriptOnlyButtons(p.html).length, 0);
  assert.ok(total > 0, "expected at least one <button type=\"button\"> across the committed pages");
  assert.ok(pages.some((p) => p.rel === "index.html"));
});

for (const p of pages) {
  test(`${p.rel}: every <button type="button"> is hidden until its script runs, or is a tab whose panel already shows`, () => {
    const css = [
      ...localStylesheets(p.html, p.path).filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8")),
      ...inlineStyles(p.html),
    ].join("\n");
    assert.deepEqual(deadWithoutScript(p.html, css, p.rel), []);
  });
}
