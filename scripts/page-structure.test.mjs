#!/usr/bin/env node
// Static tree gate for every committed HTML page, redirect shortcuts and
// /404.html included. Browsers never reject malformed HTML — they repair it
// silently: a stray </div> is dropped, an unclosed <section> swallows the rest
// of the page into itself, a <div> inside <p> closes the paragraph early and
// leaves an empty <p></p> behind, a second class="" on one element is ignored,
// and a ">" inside an attribute value ends the tag early for every sibling gate
// here that tokenizes with /<tag[^>]*>/. None of that is visible to the stub-DOM
// script tests or the attribute-level markup gate, and the layout, CSS cascade
// and accessibility tree all quietly change shape. This file parses each page
// the way the HTML tokenizer does (comments, raw-text elements, quoted
// attributes, the spec's optional end tags, foreign content for inline SVG) and
// fails on anything a browser would have to repair. Zero dependencies.
// Usage: node --test scripts/page-structure.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "scripts", ".linkcheck-work"]);

// https://html.spec.whatwg.org/#void-elements
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Raw-text and escapable-raw-text elements: no tags are parsed inside them.
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
// Elements that open foreign content, where <path/> style self-closing is real.
const FOREIGN = new Set(["svg", "math"]);

// https://html.spec.whatwg.org/#optional-tags — an open element in this map is
// implicitly closed when any start tag in its set arrives, or when its parent closes.
const BLOCK_CLOSES_P = ["address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"];
const OPTIONAL_END = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  p: BLOCK_CLOSES_P,
  rt: ["rt", "rp"],
  rp: ["rt", "rp"],
  optgroup: ["optgroup"],
  option: ["option", "optgroup"],
  caption: ["colgroup", "thead", "tbody", "tfoot", "tr"],
  colgroup: ["thead", "tbody", "tfoot", "tr", "caption"],
  thead: ["tbody", "tfoot"],
  tbody: ["tbody", "tfoot"],
  tfoot: ["tbody"],
  tr: ["tr", "tbody", "tfoot"],
  td: ["td", "th", "tr", "tbody", "tfoot"],
  th: ["td", "th", "tr", "tbody", "tfoot"],
};

// Elements whose parent element is fixed by the content model; a browser that
// meets them elsewhere either drops them or hoists them somewhere else.
const REQUIRED_PARENT = {
  li: ["ul", "ol", "menu"],
  dt: ["dl", "div"],
  dd: ["dl", "div"],
  option: ["select", "datalist", "optgroup"],
  optgroup: ["select"],
  caption: ["table"],
  colgroup: ["table"],
  thead: ["table"],
  tbody: ["table"],
  tfoot: ["table"],
  tr: ["table", "thead", "tbody", "tfoot"],
  td: ["tr"],
  th: ["tr"],
  figcaption: ["figure"],
  summary: ["details"],
  legend: ["fieldset"],
  source: ["picture", "audio", "video"],
  track: ["audio", "video"],
};

// https://html.spec.whatwg.org/#interactive-content — <a> and <button> may not
// contain any of these; the browser renders the nest but focus and click
// targets become ambiguous for keyboard and screen-reader users.
const INTERACTIVE = new Set(["a", "button", "details", "embed", "iframe", "label", "select", "textarea", "input", "audio", "video"]);
const NO_INTERACTIVE_INSIDE = new Set(["a", "button", "label"]);

// https://html.spec.whatwg.org/#metadata-content — the only children <head> keeps.
const HEAD_CONTENT = new Set(["base", "link", "meta", "noscript", "script", "style", "template", "title"]);

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

// ---------------------------------------------------------------------------
// Tokenizer: start/end tags with their attributes, honouring quoted attribute
// values, comments, the doctype and raw-text element bodies.
// ---------------------------------------------------------------------------

const ATTR_RE = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function attributes(raw) {
  // raw is "<name attrs...>" — drop the name, keep everything up to the final ">".
  const body = raw.replace(/^<\/?[a-zA-Z][\w-]*/, "").replace(/\/?\s*>$/, "");
  const out = [];
  for (const m of body.matchAll(ATTR_RE)) {
    out.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null });
  }
  return out;
}

export function tokenize(html) {
  const tokens = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) { tokens.push({ type: "error", line: lineOf(html, lt), message: "comment opened with <!-- is never closed (the rest of the page is a comment)" }); break; }
      i = end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const open = /^<(\/?)([a-zA-Z][\w-]*)/.exec(html.slice(lt, lt + 64));
    if (!open) { i = lt + 1; continue; }
    let j = lt + open[0].length;
    let quote = null;
    for (; j < n; j++) {
      const c = html[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (j >= n) { tokens.push({ type: "error", line: lineOf(html, lt), message: `tag <${open[1]}${open[2]} is never terminated by ">"` }); break; }
    const raw = html.slice(lt, j + 1);
    const name = open[2].toLowerCase();
    const line = lineOf(html, lt);
    tokens.push({ type: open[1] ? "end" : "start", name, raw, line, selfClosing: !open[1] && /\/\s*>$/.test(raw) });
    i = j + 1;
    if (!open[1] && RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(i));
      if (!close) { tokens.push({ type: "error", line, message: `<${name}> is never closed (everything after it is ${name} text)` }); break; }
      tokens.push({ type: "end", name, raw: close[0], line: lineOf(html, i + close.index), selfClosing: false });
      i += close.index + close[0].length;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Tree builder: walks the tokens with an open-element stack and reports every
// repair a browser would have had to make. Returns { problems, elements } where
// elements lists every start tag with its parent chain for the content rules.
// ---------------------------------------------------------------------------

export function buildTree(html) {
  const problems = [];
  const elements = [];
  const stack = [];
  let foreign = 0;
  const top = () => stack[stack.length - 1];

  for (const t of tokenize(html)) {
    if (t.type === "error") { problems.push(`line ${t.line}: ${t.message}`); continue; }

    if (t.type === "start") {
      // Optional end tags: a start tag in the set closes the open element first.
      while (top() && OPTIONAL_END[top().name]?.includes(t.name)) stack.pop();

      const el = { name: t.name, line: t.line, raw: t.raw, parents: stack.map((s) => s.name), foreign: foreign > 0 };
      elements.push(el);

      if (VOID.has(t.name)) continue;
      if (t.selfClosing) {
        if (foreign === 0) problems.push(`line ${t.line}: <${t.name}/> is self-closing but ${t.name} is not a void element; a browser opens it and never closes it`);
        continue;
      }
      if (FOREIGN.has(t.name)) foreign++;
      stack.push(t);
      continue;
    }

    // End tag.
    if (VOID.has(t.name)) { problems.push(`line ${t.line}: </${t.name}> closes a void element, which has no end tag`); continue; }
    if (!top()) { problems.push(`line ${t.line}: stray </${t.name}> with no open element`); continue; }
    if (top().name !== t.name) {
      // Let optional-end elements close implicitly when their parent closes.
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== t.name && OPTIONAL_END[stack[k].name]) k--;
      if (k >= 0 && stack[k].name === t.name) {
        stack.length = k;
        continue;
      }
      const open = top();
      const where = stack.some((s) => s.name === t.name)
        ? `but <${open.name}> opened at line ${open.line} is still open`
        : `with no open <${t.name}>${t.name === "p" ? " (a block element inside <p> closes the paragraph implicitly, leaving this end tag stray)" : ""}`;
      problems.push(`line ${t.line}: </${t.name}> ${where}`);
      // Recover the way a browser does: pop through to the matching element if any.
      const idx = stack.map((s) => s.name).lastIndexOf(t.name);
      if (idx >= 0) {
        for (let s = idx; s < stack.length; s++) if (FOREIGN.has(stack[s].name)) foreign--;
        stack.length = idx;
      }
      continue;
    }
    if (FOREIGN.has(t.name)) foreign--;
    stack.pop();
  }

  for (const s of stack) {
    if (!OPTIONAL_END[s.name]) problems.push(`line ${s.line}: <${s.name}> is never closed`);
  }
  return { problems, elements };
}

// ---------------------------------------------------------------------------
// Rules. Each returns a list of human-readable problems (empty = pass).
// ---------------------------------------------------------------------------

export function unbalancedTags(html) {
  return buildTree(html).problems;
}

export function duplicateAttributes(html) {
  const problems = [];
  for (const el of buildTree(html).elements) {
    const seen = new Set();
    for (const a of attributes(el.raw)) {
      if (seen.has(a.name)) problems.push(`line ${el.line}: <${el.name}> repeats attribute "${a.name}" (a browser keeps the first and drops the rest)`);
      seen.add(a.name);
    }
  }
  return problems;
}

export function angleBracketsInAttributes(html) {
  const problems = [];
  for (const el of buildTree(html).elements) {
    for (const a of attributes(el.raw)) {
      if (a.value !== null && /[<>]/.test(a.value)) {
        problems.push(`line ${el.line}: <${el.name} ${a.name}="…"> contains a raw "<" or ">" (write &lt;/&gt;; the sibling gates tokenize tags with [^>]* and would read a truncated tag)`);
      }
    }
  }
  return problems;
}

export function misparentedElements(html) {
  const problems = [];
  for (const el of buildTree(html).elements) {
    const allowed = REQUIRED_PARENT[el.name];
    if (!allowed || el.foreign) continue;
    const parent = el.parents[el.parents.length - 1];
    if (!allowed.includes(parent)) {
      problems.push(`line ${el.line}: <${el.name}> inside <${parent ?? "nothing"}>; its parent must be one of ${allowed.map((p) => `<${p}>`).join(", ")}`);
    }
  }
  return problems;
}

export function nestedInteractiveContent(html) {
  const problems = [];
  for (const el of buildTree(html).elements) {
    if (!INTERACTIVE.has(el.name) || el.foreign) continue;
    if (el.name === "input" && /\stype\s*=\s*["']?hidden\b/i.test(el.raw)) continue;
    const outer = el.parents.find((p) => NO_INTERACTIVE_INSIDE.has(p));
    if (outer && !(outer === "label" && el.name !== "label" && el.name !== "a" && el.name !== "button")) {
      problems.push(`line ${el.line}: <${el.name}> nested inside <${outer}> (interactive content inside interactive content)`);
    }
  }
  return problems;
}

export function headContent(html) {
  const problems = [];
  for (const el of buildTree(html).elements) {
    const parent = el.parents[el.parents.length - 1];
    if (parent === "head" && !HEAD_CONTENT.has(el.name)) {
      problems.push(`line ${el.line}: <${el.name}> inside <head> is not metadata content; a browser closes <head> there and moves it into <body>`);
    }
  }
  return problems;
}

export function documentSkeleton(html, { requireMain = true } = {}) {
  const problems = [];
  const { elements } = buildTree(html);
  const count = (name) => elements.filter((e) => e.name === name && !e.foreign).length;
  for (const name of ["html", "head", "body"]) {
    const c = count(name);
    if (c !== 1) problems.push(`expected exactly one <${name}>, found ${c}`);
  }
  const mains = count("main");
  if (mains > 1) problems.push(`expected at most one <main>, found ${mains}`);
  if (requireMain && mains === 0) problems.push("no <main> landmark");
  for (const el of elements) {
    if (el.name === "body" && el.parents[el.parents.length - 1] !== "html") problems.push(`line ${el.line}: <body> is not a direct child of <html>`);
    if (el.name === "head" && el.parents[el.parents.length - 1] !== "html") problems.push(`line ${el.line}: <head> is not a direct child of <html>`);
    if (!["html", "head", "body"].includes(el.name) && !el.parents.includes("head") && !el.parents.includes("body")) {
      problems.push(`line ${el.line}: <${el.name}> sits outside both <head> and <body>`);
    }
  }
  return problems;
}

export function allProblems(html, options) {
  return [
    ...unbalancedTags(html),
    ...duplicateAttributes(html),
    ...angleBracketsInAttributes(html),
    ...misparentedElements(html),
    ...nestedInteractiveContent(html),
    ...headContent(html),
    ...documentSkeleton(html, options),
  ];
}

// ---------------------------------------------------------------------------
// Fixture self-tests: prove every rule both passes clean markup and fires.
// ---------------------------------------------------------------------------

const CLEAN = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>t &lt;x&gt;</title>
<style>a > b { color: red } /* <div> */</style>
<script>if (1 < 2 && 3 > 2) { document.write("<p>never</p>"); }</script>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<!-- a comment with <div> and </body> inside -->
<header><nav><ul>
  <li><a href="/">Home</a>
  <li><a href="/stories/">Stories</a></li>
</ul></nav></header>
<main>
  <p>One paragraph<br>with a break.
  <p>Second paragraph, closed implicitly.
  <section><h2>Section</h2><p>Para</p></section>
  <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0"/><g><circle r="1"/></g></svg>
  <form><label for="e">E</label><input id="e" type="text" data-x='q"uote'><input type="hidden" name="h">
  <datalist id="d"><option value="a"><option value="b"></datalist>
  <select><optgroup label="g"><option>1<option>2</optgroup><option>3</select>
  <textarea>not <a> tag</textarea></form>
  <table><caption>c</caption><thead><tr><th>H<tbody><tr><td>1<td>2<tr><td>3<td>4</table>
  <dl><dt>T<dd>D<dt>T2<dd>D2</dl>
  <figure><img src="x.png" alt=""><figcaption>cap</figcaption></figure>
  <details><summary>s</summary>body</details>
  <button type="button"><span>Go</span></button>
</main>
<footer><p>f</p></footer>
</body>
</html>`;

test("fixture: clean page passes every rule", () => {
  assert.deepEqual(allProblems(CLEAN), []);
});

test("fixture: tokenizer honours quotes, comments, raw text and the doctype", () => {
  const toks = tokenize(`<!doctype html><!-- <b> --><a title="x>y" data-q='>'><script>"</a>"</script></a>`);
  assert.deepEqual(toks.map((t) => `${t.type}:${t.name}`), ["start:a", "start:script", "end:script", "end:a"]);
  assert.deepEqual(attributes(toks[0].raw), [{ name: "title", value: "x>y" }, { name: "data-q", value: ">" }]);
  assert.deepEqual(attributes(`<input disabled type=text data-n="">`), [
    { name: "disabled", value: null }, { name: "type", value: "text" }, { name: "data-n", value: "" },
  ]);
});

test("fixture: unclosed comment, unterminated tag and unclosed <script> are reported", () => {
  assert.deepEqual(unbalancedTags(`<html lang="en"><body>\n<!-- oops\n</body></html>`), [
    "line 2: comment opened with <!-- is never closed (the rest of the page is a comment)",
    "line 1: <html> is never closed", "line 1: <body> is never closed",
  ]);
  assert.ok(unbalancedTags(`<p>\n<a href="x"`).some((p) => p === 'line 2: tag <a is never terminated by ">"'));
  assert.ok(unbalancedTags(`<body><script>var x = 1;\n</body>`).includes("line 1: <script> is never closed (everything after it is script text)"));
});

test("fixture: stray, mismatched and missing end tags are reported with both lines", () => {
  const html = `<html lang="en"><body>\n<div>\n<section>\n</div>\n</span>\n<article>\n</body></html>`;
  assert.deepEqual(unbalancedTags(html), [
    "line 4: </div> but <section> opened at line 3 is still open",
    "line 5: </span> with no open <span>",
    "line 7: </body> but <article> opened at line 6 is still open",
  ]);
  assert.deepEqual(unbalancedTags(`<html lang="en"><body>\n<div>\n</body></html>`), [
    "line 3: </body> but <div> opened at line 2 is still open",
  ]);
  assert.deepEqual(unbalancedTags(`<html lang="en"><body>\n<div>\n</body>`), [
    "line 3: </body> but <div> opened at line 2 is still open",
    "line 1: <html> is never closed",
  ]);
});

test("fixture: optional end tags are honoured, but a block inside <p> leaves </p> stray", () => {
  assert.deepEqual(unbalancedTags(`<html lang="en"><body><ul><li>a<li>b</ul><p>x<p>y</body></html>`), []);
  assert.deepEqual(unbalancedTags(`<html lang="en"><body>\n<p>intro\n<div>block</div>\n</p>\n</body></html>`), [
    "line 4: </p> with no open <p> (a block element inside <p> closes the paragraph implicitly, leaving this end tag stray)",
  ]);
});

test("fixture: void elements take no end tag and non-void elements may not self-close outside svg", () => {
  assert.deepEqual(unbalancedTags(`<html lang="en"><body>\n<br></br>\n<div/>\n<svg><path/></svg><img src="a" alt=""/></body></html>`), [
    "line 2: </br> closes a void element, which has no end tag",
    "line 3: <div/> is self-closing but div is not a void element; a browser opens it and never closes it",
  ]);
});

test("fixture: repeated attributes on one element are reported", () => {
  assert.deepEqual(duplicateAttributes(`<html lang="en"><body>\n<div class="a" id="x" class="b" CLASS=c></div></body></html>`), [
    'line 2: <div> repeats attribute "class" (a browser keeps the first and drops the rest)',
    'line 2: <div> repeats attribute "class" (a browser keeps the first and drops the rest)',
  ]);
});

test("fixture: raw angle brackets inside attribute values are reported", () => {
  const problems = angleBracketsInAttributes(`<html lang="en"><head>\n<meta name="description" content="a > b">\n</head><body><a title='&lt;ok&gt;' data-x="<">x</a></body></html>`);
  assert.equal(problems.length, 2);
  assert.ok(problems[0].startsWith('line 2: <meta content="…"> contains a raw "<" or ">"'));
  assert.ok(problems[1].startsWith('line 3: <a data-x="…">'));
});

test("fixture: elements with a fixed parent are reported elsewhere", () => {
  assert.deepEqual(misparentedElements(`<html lang="en"><body>\n<li>a</li>\n<div><option>x</option></div>\n<figcaption>c</figcaption>\n<table><tr><td>ok</td></tr></table>\n<svg><option>foreign is skipped</option></svg></body></html>`), [
    "line 2: <li> inside <body>; its parent must be one of <ul>, <ol>, <menu>",
    "line 3: <option> inside <div>; its parent must be one of <select>, <datalist>, <optgroup>",
    "line 4: <figcaption> inside <body>; its parent must be one of <figure>",
  ]);
});

test("fixture: interactive content nested in <a>, <button> or <label> is reported", () => {
  assert.deepEqual(nestedInteractiveContent(`<html lang="en"><body>
<a href="/"><span><a href="/x">inner</a></span></a>
<button><a href="/">link</a><input type="hidden" name="n"></button>
<label><input type="text"><button>no</button></label>
<a href="/"><label>l</label></a>
<label><label>nested</label></label>
</body></html>`), [
    "line 2: <a> nested inside <a> (interactive content inside interactive content)",
    "line 3: <a> nested inside <button> (interactive content inside interactive content)",
    "line 4: <button> nested inside <label> (interactive content inside interactive content)",
    "line 5: <label> nested inside <a> (interactive content inside interactive content)",
    "line 6: <label> nested inside <label> (interactive content inside interactive content)",
  ]);
});

test("fixture: non-metadata content inside <head> is reported", () => {
  assert.deepEqual(headContent(`<html lang="en"><head><title>t</title>\n<div>x</div>\n<noscript><link rel="stylesheet" href="a.css"></noscript></head><body></body></html>`), [
    "line 2: <div> inside <head> is not metadata content; a browser closes <head> there and moves it into <body>",
  ]);
});

test("fixture: document skeleton requires one html/head/body, at most one main", () => {
  assert.deepEqual(documentSkeleton(`<html lang="en"><head></head><body><main></main><main></main></body></html>`), ["expected at most one <main>, found 2"]);
  assert.deepEqual(documentSkeleton(`<html lang="en"><head></head><body></body></html>`), ["no <main> landmark"]);
  assert.deepEqual(documentSkeleton(`<html lang="en"><head></head><body></body></html>`, { requireMain: false }), []);
  assert.deepEqual(documentSkeleton(`<html lang="en"><body><main></main></body></html>\n<p>after</p>`), [
    "expected exactly one <head>, found 0",
    "line 2: <p> sits outside both <head> and <body>",
  ]);
  assert.deepEqual(documentSkeleton(`<html lang="en"><head></head><body><div><main></main></div><svg><title>t</title></svg></body></html>`), []);
});

// ---------------------------------------------------------------------------
// Live gate over the committed pages.
// ---------------------------------------------------------------------------

const pages = htmlFiles();

test("the site has committed HTML pages to check", () => {
  assert.ok(pages.includes(join(ROOT, "index.html")));
  assert.ok(pages.includes(join(ROOT, "stories", "index.html")));
  assert.ok(pages.includes(join(ROOT, "404.html")));
  assert.ok(pages.some((p) => isRedirectPage(readFileSync(p, "utf8"))));
});

for (const page of pages) {
  const rel = relative(ROOT, page);
  const html = readFileSync(page, "utf8");
  const redirect = isRedirectPage(html);

  test(`${rel}: every tag is closed, in order, with no stray end tags`, () => {
    assert.deepEqual(unbalancedTags(html), []);
  });

  test(`${rel}: no element repeats an attribute`, () => {
    assert.deepEqual(duplicateAttributes(html), []);
  });

  test(`${rel}: no attribute value contains a raw < or >`, () => {
    assert.deepEqual(angleBracketsInAttributes(html), []);
  });

  test(`${rel}: list items, options, table parts and captions sit in their required parent`, () => {
    assert.deepEqual(misparentedElements(html), []);
  });

  test(`${rel}: no interactive content is nested inside <a>, <button> or <label>`, () => {
    assert.deepEqual(nestedInteractiveContent(html), []);
  });

  test(`${rel}: <head> holds only metadata content`, () => {
    assert.deepEqual(headContent(html), []);
  });

  test(`${rel}: one <html>, <head> and <body>${redirect ? "" : ", exactly one <main>"}`, () => {
    assert.deepEqual(documentSkeleton(html, { requireMain: !redirect }), []);
  });
}
