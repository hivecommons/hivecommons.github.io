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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SITE_ORIGIN = "https://hivecommons.dev";
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

test("index.html ships the expected interactive scripts (hero carousel, ACMM levels, project carousel)", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const bodies = scriptBlocks(html).filter((b) => b.type === "").map((b) => b.body);
  for (const hook of ["[data-hero-carousel]", "[data-acmm-levels]", "[data-carousel]"]) {
    assert.equal(bodies.filter((b) => b.includes(hook)).length, 1, `exactly one script block wires ${hook}`);
  }
});

// --- sitemap.xml <-> canonical top-level pages ------------------------------

function isRedirectPage(html) {
  return /<meta[^>]+http-equiv\s*=\s*["']refresh["']/i.test(html);
}

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
