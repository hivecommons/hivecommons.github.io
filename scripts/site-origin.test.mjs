#!/usr/bin/env node
// Static gate tying the site origin to `CNAME`. GitHub Pages serves this repo
// at the host named in CNAME; every other gate in scripts/ hardcodes
// `SITE_ORIGIN = "https://hivecommons.dev"` and checks canonicals, og:url,
// sitemap.xml and robots.txt against that constant — so a CNAME edit (new
// domain, `www.` prefix, scheme or path pasted in, trailing dot, second line)
// would leave every gate green while the live site answered on a host none of
// the pages name. This gate reads CNAME as the single source of truth and
// fails when it is malformed, when a test constant or committed URL disagrees
// with it, or when a page/asset links the `*.github.io` fallback host (which
// bypasses the custom domain and splits canonical signals). Each rule has a
// fixture self-test. Zero dependencies.
// Usage: node --test scripts/site-origin.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FALLBACK_HOST = "hivecommons.github.io";

// --- parsing ---------------------------------------------------------------

// RFC 1123 host labels: lowercase letters, digits and hyphens, no leading or
// trailing hyphen, at least two labels. GitHub Pages lowercases the host it
// serves, so an uppercase CNAME would never match a canonical URL byte for byte.
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function cnameProblems(text) {
  const problems = [];
  if (text.length === 0) return ["CNAME is empty"];
  if (/\r/.test(text)) problems.push("CNAME has CRLF line endings");
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length !== 1) problems.push(`CNAME must be exactly one line, found ${lines.length}`);
  const host = lines[0];
  if (host !== host.trim()) problems.push("CNAME host has leading or trailing whitespace");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) problems.push("CNAME must be a bare host, not a URL with a scheme");
  if (/[/?#]/.test(host)) problems.push("CNAME must be a bare host, not a path or URL");
  if (/:\d+$/.test(host)) problems.push("CNAME must not carry a port");
  if (host.endsWith(".")) problems.push("CNAME host must not end with a trailing dot");
  if (host !== host.toLowerCase()) problems.push("CNAME host must be lowercase");
  if (problems.length === 0 && !HOST_RE.test(host)) problems.push(`CNAME host "${host}" is not a valid DNS name`);
  return problems;
}

export function cnameHost(text) {
  return text.replace(/\n$/, "").trim();
}

// `const SITE_ORIGIN = "..."` literals in the sibling gates.
export function siteOriginLiterals(source) {
  return [...source.matchAll(/^\s*(?:export\s+)?const\s+SITE_ORIGIN\s*=\s*(["'`])([^"'`]*)\1/gm)].map((m) => m[2]);
}

export function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

export function robotsSitemaps(text) {
  return [...text.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map((m) => m[1]);
}

// Every absolute http(s) URL in a document.
export function absoluteUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s"'<>()]+/g)].map((m) => m[0]);
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// --- rules -----------------------------------------------------------------

// Each entry: { label, origins } — every origin must equal `expected`.
export function originAgreementProblems(expected, entries) {
  const problems = [];
  for (const { label, origins } of entries) {
    if (origins.length === 0) problems.push(`${label}: no site origin found`);
    for (const o of origins) if (o !== expected) problems.push(`${label}: uses ${o}, CNAME says ${expected}`);
  }
  return problems;
}

export function fallbackHostProblems(files, host = FALLBACK_HOST) {
  const problems = [];
  const re = new RegExp(`https?://${host.replace(/[.]/g, "\\.")}(?=[/"'\\s<)]|$)`, "i");
  for (const { label, text } of files) {
    const m = re.exec(text);
    if (m) problems.push(`${label}: links the Pages fallback host ${m[0]} instead of the CNAME host`);
  }
  return problems;
}

// --- repository walk --------------------------------------------------------

const SKIP_DIRS = new Set([".git", "node_modules", "scripts", ".github"]);
const CONTENT_EXT = /\.(html|css|txt|xml|svg|json)$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(full);
    } else if (CONTENT_EXT.test(name)) {
      yield full;
    }
  }
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// --- fixtures --------------------------------------------------------------

test("fixture: a bare lowercase host on one line passes", () => {
  assert.deepEqual(cnameProblems("example.dev\n"), []);
  assert.deepEqual(cnameProblems("www.example.co.uk"), []);
  assert.equal(cnameHost("example.dev\n"), "example.dev");
});

test("fixture: empty, multi-line, CRLF and padded CNAME files are reported", () => {
  assert.deepEqual(cnameProblems(""), ["CNAME is empty"]);
  assert.ok(cnameProblems("a.dev\nb.dev\n").some((p) => p.includes("exactly one line")));
  assert.ok(cnameProblems("a.dev\r\n").some((p) => p.includes("CRLF")));
  assert.ok(cnameProblems(" a.dev\n").some((p) => p.includes("whitespace")));
  assert.ok(cnameProblems("a.dev \n").some((p) => p.includes("whitespace")));
});

test("fixture: a URL, path, port, trailing dot or uppercase host is reported", () => {
  assert.ok(cnameProblems("https://a.dev\n").some((p) => p.includes("scheme")));
  assert.ok(cnameProblems("a.dev/docs\n").some((p) => p.includes("path")));
  assert.ok(cnameProblems("a.dev:8080\n").some((p) => p.includes("port")));
  assert.ok(cnameProblems("a.dev.\n").some((p) => p.includes("trailing dot")));
  assert.ok(cnameProblems("A.dev\n").some((p) => p.includes("lowercase")));
  assert.ok(cnameProblems("localhost\n").some((p) => p.includes("not a valid DNS name")));
  assert.ok(cnameProblems("-a.dev\n").some((p) => p.includes("not a valid DNS name")));
});

test("fixture: SITE_ORIGIN literals are extracted from test sources", () => {
  const src = `const X = 1;\nconst SITE_ORIGIN = "https://a.dev";\nexport const SITE_ORIGIN = 'https://b.dev';\n// const SITE_ORIGIN = "https://c.dev" (commented out)\n`;
  assert.deepEqual(siteOriginLiterals(src), ["https://a.dev", "https://b.dev"]);
  assert.deepEqual(siteOriginLiterals("const other = 'x';"), []);
});

test("fixture: sitemap <loc>, robots Sitemap: and absolute URLs are extracted and reduced to origins", () => {
  assert.deepEqual(sitemapLocs("<urlset><url><loc> https://a.dev/ </loc></url><url><loc>https://a.dev/x/</loc></url></urlset>"), [
    "https://a.dev/",
    "https://a.dev/x/",
  ]);
  assert.deepEqual(robotsSitemaps("User-agent: *\nAllow: /\n\nSitemap: https://a.dev/sitemap.xml\n"), ["https://a.dev/sitemap.xml"]);
  assert.deepEqual(absoluteUrls('<a href="https://a.dev/p">x</a> see http://b.org/q.'), ["https://a.dev/p", "http://b.org/q."]);
  assert.equal(originOf("https://a.dev/p?q#f"), "https://a.dev");
  assert.equal(originOf("not a url"), null);
});

test("fixture: origin disagreement and an empty origin list are reported", () => {
  assert.deepEqual(originAgreementProblems("https://a.dev", [{ label: "x", origins: ["https://a.dev", "https://a.dev"] }]), []);
  const bad = originAgreementProblems("https://a.dev", [
    { label: "sitemap", origins: ["https://a.dev", "https://b.dev"] },
    { label: "robots", origins: [] },
  ]);
  assert.ok(bad.some((p) => p.startsWith("sitemap:") && p.includes("https://b.dev")));
  assert.ok(bad.some((p) => p.startsWith("robots:") && p.includes("no site origin")));
});

test("fixture: a link to the *.github.io fallback host is reported, repository URLs on github.com are not", () => {
  assert.deepEqual(fallbackHostProblems([{ label: "ok", text: 'href="https://github.com/hivecommons/hivecommons.github.io/issues/1"' }]), []);
  assert.deepEqual(fallbackHostProblems([{ label: "ok", text: 'href="https://hivecommons.github.io.example.com/"' }]), []);
  const bad = fallbackHostProblems([{ label: "p", text: '<link rel="canonical" href="https://hivecommons.github.io/stories/">' }]);
  assert.equal(bad.length, 1);
  assert.ok(bad[0].includes("fallback host"));
});

// --- repository -------------------------------------------------------------

const CNAME_TEXT = read("CNAME");
const HOST = cnameHost(CNAME_TEXT);
const ORIGIN = `https://${HOST}`;

test("CNAME: is a single bare lowercase DNS host", () => {
  assert.deepEqual(cnameProblems(CNAME_TEXT), []);
});

test("CNAME: every SITE_ORIGIN constant in scripts/ equals https://<CNAME>", () => {
  const entries = readdirSync(HERE)
    .filter((n) => n.endsWith(".test.mjs") && n !== "site-origin.test.mjs")
    .map((n) => ({ label: `scripts/${n}`, origins: siteOriginLiterals(readFileSync(join(HERE, n), "utf8")) }))
    .filter((e) => e.origins.length > 0);
  assert.ok(entries.length >= 1, "expected at least one sibling gate to declare SITE_ORIGIN");
  assert.deepEqual(originAgreementProblems(ORIGIN, entries), []);
});

test("CNAME: sitemap.xml <loc> and robots.txt Sitemap: live at https://<CNAME>", () => {
  const entries = [
    { label: "sitemap.xml", origins: sitemapLocs(read("sitemap.xml")).map(originOf) },
    { label: "robots.txt", origins: robotsSitemaps(read("robots.txt")).map(originOf) },
  ];
  assert.deepEqual(originAgreementProblems(ORIGIN, entries), []);
});

test("CNAME: every <link rel=canonical> and og:url on a canonical page is at https://<CNAME>", () => {
  const entries = [];
  for (const file of walk(ROOT)) {
    if (!file.endsWith(".html")) continue;
    const html = readFileSync(file, "utf8");
    if (/<meta[^>]+http-equiv\s*=\s*["']refresh["']/i.test(html)) continue;
    const urls = [
      ...[...html.matchAll(/<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
      ...[...html.matchAll(/<meta[^>]+property\s*=\s*["']og:url["'][^>]*content\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
    ];
    if (urls.length) entries.push({ label: relative(ROOT, file), origins: urls.map(originOf) });
  }
  assert.ok(entries.length >= 1, "expected at least one canonical page");
  assert.deepEqual(originAgreementProblems(ORIGIN, entries), []);
});

test("no committed page, stylesheet or text asset links the *.github.io fallback host", () => {
  const files = [];
  for (const file of walk(ROOT)) files.push({ label: relative(ROOT, file), text: readFileSync(file, "utf8") });
  assert.ok(files.some((f) => f.label === "llms.txt") && files.some((f) => f.label === "sitemap.xml"), "walk must include root text assets");
  assert.deepEqual(fallbackHostProblems(files), []);
});
