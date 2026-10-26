#!/usr/bin/env node
// Static gate for every committed HTML page: inline scripts must parse, JSON-LD
// blocks must be valid JSON, and sitemap.xml must stay in step with the
// canonical top-level pages (README: "when adding a new top-level page, add it
// to sitemap.xml too"). Zero dependencies.
// Usage: node --test scripts/page-scripts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { htmlFiles, isRedirectPage, SKIP_DIRS } from "./html-pages.mjs";
import { HARNESSED_SCRIPTS, inlineScript } from "./inline-scripts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SITE_ORIGIN = "https://hivecommons.dev";

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function scriptBlocks(html) {
  return [...html.matchAll(SCRIPT_RE)].map((m) => {
    const attrs = m[1];
    const typeMatch = /type\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const src = /\bsrc\s*=/i.test(attrs);
    const line = html.slice(0, m.index).split("\n").length;
    return { type: typeMatch ? typeMatch[1].toLowerCase() : "", external: src, body: m[2], line };
  });
}

const pages = htmlFiles();

test("the site has committed HTML pages to check", () => {
  assert.ok(pages.length > 0);
  assert.ok(pages.includes(join(ROOT, "index.html")));
});

for (const page of pages) {
  const rel = relative(ROOT, page);
  const html = readFileSync(page, "utf8");
  const blocks = scriptBlocks(html);

  test(`${rel}: every inline script block parses as JavaScript`, () => {
    const classic = blocks.filter((b) => !b.external && (b.type === "" || b.type === "text/javascript" || b.type === "module"));
    for (const b of classic) {
      assert.doesNotThrow(
        () => new vm.Script(b.body, { filename: `${rel}:${b.line}` }),
        `script block starting at ${rel}:${b.line} has a syntax error`,
      );
    }
  });

  test(`${rel}: every JSON-LD block is valid JSON with @context/@type`, () => {
    const ld = blocks.filter((b) => b.type === "application/ld+json");
    for (const b of ld) {
      let data;
      assert.doesNotThrow(() => { data = JSON.parse(b.body); }, `JSON-LD at ${rel}:${b.line} is not valid JSON`);
      const items = Array.isArray(data) ? data : [data];
      assert.ok(items.length > 0, `JSON-LD at ${rel}:${b.line} is empty`);
      for (const item of items) {
        assert.equal(item["@context"], "https://schema.org", `JSON-LD item at ${rel}:${b.line} lacks schema.org @context`);
        assert.ok(typeof item["@type"] === "string" && item["@type"], `JSON-LD item at ${rel}:${b.line} lacks @type`);
      }
    }
  });

  test(`${rel}: no external <script src> (site is self-contained, no build step)`, () => {
    const external = blocks.filter((b) => b.external);
    assert.deepEqual(external.map((b) => b.line), [], `external scripts found at lines ${external.map((b) => b.line).join(", ")}`);
  });
}

// --- every inline behaviour script has a harness --------------------------
// The loop above only checks that an inline script parses. What each one does
// is pinned by a dedicated harness (scripts/*.test.mjs) that extracts the block
// from the page by a hook string and runs it against a stub DOM. A new inline
// script has to be registered in HARNESSED_SCRIPTS (scripts/inline-scripts.mjs)
// with its harness, or it ships with nothing but a syntax check; the only block
// exempt is the one-statement no-js toggle.
const NO_JS_TOGGLE = "document.documentElement.classList.replace('no-js', 'js');";

function isBehaviourScript(b) {
  return !b.external && (b.type === "" || b.type === "text/javascript" || b.type === "module");
}

// Problems with the inline behaviour scripts of one page against its registry
// entries: an unregistered block, a registered hook matched by zero or several
// blocks, or a block matched by more than one hook.
function harnessProblems(rel, blocks, registry = HARNESSED_SCRIPTS) {
  const entries = registry[rel] || [];
  const problems = [];
  const scripts = blocks.filter(isBehaviourScript).filter((b) => b.body.trim() !== NO_JS_TOGGLE);
  for (const b of scripts) {
    const hooks = entries.filter((e) => b.body.includes(e.hook)).map((e) => e.hook);
    if (hooks.length === 0) problems.push(`${rel}:${b.line}: inline script has no harness (register it in HARNESSED_SCRIPTS with the scripts/*.test.mjs that runs it)`);
    if (hooks.length > 1) problems.push(`${rel}:${b.line}: inline script matches several hooks (${hooks.join(", ")})`);
  }
  for (const e of entries) {
    const n = scripts.filter((b) => b.body.includes(e.hook)).length;
    if (n !== 1) problems.push(`${rel}: expected exactly one inline script mentioning ${e.hook}, found ${n}`);
  }
  return problems;
}

for (const page of pages) {
  const rel = relative(ROOT, page);
  test(`${rel}: every inline behaviour script is registered with a harness test`, () => {
    assert.deepEqual(harnessProblems(rel, scriptBlocks(readFileSync(page, "utf8"))), []);
  });
}

test("every registered page exists and every harness file extracts its block by the registered hook", () => {
  for (const [rel, entries] of Object.entries(HARNESSED_SCRIPTS)) {
    assert.ok(pages.includes(join(ROOT, rel)), `${rel} is registered in HARNESSED_SCRIPTS but is not a committed page`);
    for (const { hook, harness } of entries) {
      const file = join(ROOT, harness);
      assert.ok(existsSync(file), `${harness} (harness for ${rel} ${hook}) does not exist`);
      const src = readFileSync(file, "utf8");
      assert.ok(src.includes("new Function("), `${harness} does not run the extracted script (no new Function(...))`);
      assert.ok(src.includes(hook), `${harness} never mentions ${hook}, so it cannot be extracting that block from ${rel}`);
    }
  }
});

test("fixture: inlineScript returns the one matching block with a sourceURL trailer and its page line; zero or several matches throw", () => {
  const html = "<!doctype html>\n<html>\n<script>document.documentElement.classList.replace('no-js', 'js');</script>\n<p>x</p>\n<script>\n(function () { var r = document.querySelector('[data-w]'); if (!r) return; })();\n</script>\n</html>\n";
  const { src, line } = inlineScript(html, "w/index.html", "[data-w]");
  assert.equal(line, 5);
  assert.equal(src, "\n(function () { var r = document.querySelector('[data-w]'); if (!r) return; })();\n\n//# sourceURL=inline:w/index.html#[data-w]\n");
  assert.throws(() => inlineScript(html, "w/index.html", "[data-missing]"), /w\/index\.html: expected exactly one <script> block mentioning \[data-missing\], found 0/);
  assert.throws(() => inlineScript(html, "w/index.html", "document"), /found 2/);
});

test("fixture: an inline script without a registered hook is reported, the no-js toggle is not", () => {
  const html = `<!doctype html><html class="no-js"><head>
<script>${NO_JS_TOGGLE}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing"}</script>
<script>
(function () { var root = document.querySelector('[data-widget]'); if (!root) return; })();
</script>
</head><body></body></html>`;
  assert.deepEqual(harnessProblems("widget.html", scriptBlocks(html), {}), [
    "widget.html:4: inline script has no harness (register it in HARNESSED_SCRIPTS with the scripts/*.test.mjs that runs it)",
  ]);
  assert.deepEqual(harnessProblems("widget.html", scriptBlocks(html), { "widget.html": [{ hook: "[data-widget]", harness: "x" }] }), []);
});

test("fixture: a registered hook matched by no block or by two blocks is reported", () => {
  const registry = { "p.html": [{ hook: "[data-a]", harness: "x" }, { hook: "[data-b]", harness: "y" }] };
  const none = `<script>document.querySelector('[data-a]');</script>`;
  assert.deepEqual(harnessProblems("p.html", scriptBlocks(none), registry), [
    "p.html: expected exactly one inline script mentioning [data-b], found 0",
  ]);
  const twice = `<script>document.querySelector('[data-a]');</script>
<script>document.querySelector('[data-a]');</script>
<script>document.querySelector('[data-b]');</script>`;
  assert.deepEqual(harnessProblems("p.html", scriptBlocks(twice), registry), [
    "p.html: expected exactly one inline script mentioning [data-a], found 2",
  ]);
  const both = `<script>document.querySelector('[data-a]'); document.querySelector('[data-b]');</script>`;
  assert.deepEqual(harnessProblems("p.html", scriptBlocks(both), registry), [
    "p.html:1: inline script matches several hooks ([data-a], [data-b])",
  ]);
});

// --- sitemap.xml <-> canonical top-level pages ------------------------------

function canonicalTopLevelPaths() {
  const paths = ["/"];
  for (const name of readdirSync(ROOT)) {
    const dir = join(ROOT, name);
    if (SKIP_DIRS.has(name) || !statSync(dir).isDirectory()) continue;
    const index = join(dir, "index.html");
    if (!existsSync(index)) continue;
    if (isRedirectPage(readFileSync(index, "utf8"))) continue;
    paths.push(`/${name}/`);
  }
  return paths.sort();
}

function sitemapPaths() {
  const xml = readFileSync(join(ROOT, "sitemap.xml"), "utf8");
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  return { xml, locs };
}

test("sitemap.xml is well-formed enough: urlset namespace and absolute https locs", () => {
  const { xml, locs } = sitemapPaths();
  assert.match(xml, /<urlset\s+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  assert.ok(locs.length > 0, "sitemap has at least one <loc>");
  for (const loc of locs) {
    assert.ok(loc.startsWith(SITE_ORIGIN + "/"), `${loc} is not under ${SITE_ORIGIN}`);
    assert.ok(loc === SITE_ORIGIN + "/" || loc.endsWith("/"), `${loc} should end with a trailing slash (directory index)`);
  }
  assert.equal(new Set(locs).size, locs.length, "sitemap has duplicate <loc> entries");
});

test("sitemap.xml lists exactly the canonical top-level pages (no redirects, nothing missing)", () => {
  const { locs } = sitemapPaths();
  const listed = locs.map((l) => l.slice(SITE_ORIGIN.length)).sort();
  const expected = canonicalTopLevelPaths();
  assert.deepEqual(
    listed, expected,
    "sitemap.xml drifted from the committed top-level pages — add new pages to sitemap.xml and keep redirect shortcuts out of it",
  );
});

test("robots.txt advertises sitemap.xml at the site origin", () => {
  const robots = readFileSync(join(ROOT, "robots.txt"), "utf8");
  assert.match(robots, new RegExp(`^Sitemap:\\s*${SITE_ORIGIN.replace(/[.]/g, "\\.")}/sitemap\\.xml\\s*$`, "m"));
});
