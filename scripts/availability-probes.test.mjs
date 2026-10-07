#!/usr/bin/env node
// Static gate over the URL list the scheduled `availability` job in
// .github/workflows/links.yml probes against the live site. That list is
// hand-maintained: nothing else notices when a probed page is renamed or
// removed (the weekly job then fails with a false alarm), when a new canonical
// page is added to sitemap.xml but never probed, or when a directory URL loses
// its trailing slash (GitHub Pages answers 301, which curl without -L reports
// as a failure). Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/availability-probes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SITE_ORIGIN = "https://hivecommons.dev";
const WORKFLOW = join(ROOT, ".github", "workflows", "links.yml");

// --- parsing ---------------------------------------------------------------

// The `availability` job's `for url in ...; do` word list, backslash
// continuations joined. Returns null when the job or its loop is absent.
export function probedUrls(yaml) {
  const job = /^\s{2}availability:\s*$([\s\S]*?)(?=^\s{2}\S|(?![\s\S]))/m.exec(yaml);
  if (!job) return null;
  const loop = /for\s+url\s+in\s+([\s\S]*?);\s*do\b/.exec(job[1]);
  if (!loop) return null;
  return loop[1].replace(/\\\r?\n/g, " ").split(/\s+/).filter(Boolean);
}

export function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

export function isRedirectPage(html) {
  return /<meta[^>]+http-equiv\s*=\s*["']refresh["']/i.test(html);
}

// Committed file a site URL is served from, or null. Directory URLs must carry
// their trailing slash: "/docs" is a 301 on GitHub Pages, not the page.
export function siteUrlToFile(url, root = ROOT) {
  if (url === SITE_ORIGIN) return null;
  if (!url.startsWith(SITE_ORIGIN + "/")) return null;
  const path = url.slice(SITE_ORIGIN.length).replace(/[?#].*$/, "");
  const rel = path === "/" ? "index.html" : path.endsWith("/") ? join(path.slice(1), "index.html") : path.slice(1);
  const full = resolve(root, rel);
  if (!full.startsWith(resolve(root) + "/") || !existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

// --- rules -----------------------------------------------------------------

export function probeListProblems(urls, { sitemap, root = ROOT }) {
  const problems = [];
  if (!urls || urls.length === 0) return ["availability job has no `for url in ...; do` probe list"];
  if (new Set(urls).size !== urls.length) problems.push("probe list has duplicate URLs");
  let redirects = 0;
  for (const url of urls) {
    if (!url.startsWith("https://")) { problems.push(`${url} is not https`); continue; }
    if (!url.startsWith(SITE_ORIGIN + "/")) { problems.push(`${url} is not under ${SITE_ORIGIN}/`); continue; }
    const path = url.slice(SITE_ORIGIN.length);
    if (/[?#]/.test(path)) problems.push(`${url} carries a query/fragment; probe the bare page`);
    if (!path.endsWith("/") && !/\.[a-z0-9]+$/i.test(path)) {
      problems.push(`${url} is a directory page without its trailing slash (GitHub Pages answers 301, not 200)`);
      continue;
    }
    const file = siteUrlToFile(url, root);
    if (!file) { problems.push(`${url} does not resolve to a committed page`); continue; }
    if (file.endsWith(".html") && isRedirectPage(readFileSync(file, "utf8"))) redirects++;
  }
  for (const loc of sitemap) {
    if (!urls.includes(loc)) problems.push(`canonical page ${loc} (listed in sitemap.xml) is not probed`);
  }
  if (!urls.includes(SITE_ORIGIN + "/404.html")) problems.push(`${SITE_ORIGIN}/404.html is not probed (the error page must serve HTTP 200)`);
  if (redirects === 0) problems.push("no redirect shortcut page is probed");
  return problems;
}

// --- fixtures --------------------------------------------------------------

const GOOD_YAML = `name: x
jobs:
  availability:
    if: github.event_name == 'schedule'
    steps:
      - run: |
          for url in https://hivecommons.dev/ https://hivecommons.dev/stories/ \\
                     https://hivecommons.dev/docs/ https://hivecommons.dev/404.html; do
            curl "$url"
          done
  links:
    steps:
      - run: for url in https://example.com/; do echo "$url"; done
`;

test("fixture: the availability loop's word list is extracted with continuations joined", () => {
  assert.deepEqual(probedUrls(GOOD_YAML), [
    `${SITE_ORIGIN}/`, `${SITE_ORIGIN}/stories/`, `${SITE_ORIGIN}/docs/`, `${SITE_ORIGIN}/404.html`,
  ]);
});

test("fixture: a missing availability job or loop yields null", () => {
  assert.equal(probedUrls(GOOD_YAML.replace(/^\s{2}availability:/m, "  other:")), null);
  assert.equal(probedUrls(GOOD_YAML.replace("for url in", "for u in")), null);
});

test("fixture: sitemap <loc> values are extracted", () => {
  assert.deepEqual(sitemapLocs(`<urlset><url><loc> ${SITE_ORIGIN}/ </loc></url><url><loc>${SITE_ORIGIN}/a/</loc></url></urlset>`), [
    `${SITE_ORIGIN}/`, `${SITE_ORIGIN}/a/`,
  ]);
});

const FIXTURE_SITEMAP = [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/stories/`];
const GOOD_LIST = [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/stories/`, `${SITE_ORIGIN}/docs/`, `${SITE_ORIGIN}/404.html`];

test("fixture: a list covering the sitemap, 404.html and a redirect passes", () => {
  assert.deepEqual(probeListProblems(GOOD_LIST, { sitemap: FIXTURE_SITEMAP }), []);
});

test("fixture: an empty or absent list is reported", () => {
  assert.equal(probeListProblems(null, { sitemap: [] }).length, 1);
  assert.equal(probeListProblems([], { sitemap: [] }).length, 1);
});

test("fixture: a probed URL with no committed page is reported", () => {
  const p = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/nope/`], { sitemap: FIXTURE_SITEMAP });
  assert.ok(p.some((x) => x.includes("/nope/ does not resolve")), p.join("\n"));
});

test("fixture: a directory URL without its trailing slash is reported", () => {
  const p = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/code`], { sitemap: FIXTURE_SITEMAP });
  assert.ok(p.some((x) => x.includes("trailing slash")), p.join("\n"));
});

test("fixture: a canonical page missing from the probe list is reported", () => {
  const p = probeListProblems(GOOD_LIST.filter((u) => !u.endsWith("/stories/")), { sitemap: FIXTURE_SITEMAP });
  assert.ok(p.some((x) => x.includes("/stories/ (listed in sitemap.xml) is not probed")), p.join("\n"));
});

test("fixture: missing 404.html probe, missing redirect probe, duplicates and foreign origins are reported", () => {
  const no404 = probeListProblems(GOOD_LIST.filter((u) => !u.endsWith("404.html")), { sitemap: FIXTURE_SITEMAP });
  assert.ok(no404.some((x) => x.includes("404.html is not probed")), no404.join("\n"));
  const noRedirect = probeListProblems(GOOD_LIST.filter((u) => !u.endsWith("/docs/")), { sitemap: FIXTURE_SITEMAP });
  assert.ok(noRedirect.some((x) => x.includes("no redirect shortcut page")), noRedirect.join("\n"));
  const dup = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/`], { sitemap: FIXTURE_SITEMAP });
  assert.ok(dup.some((x) => x.includes("duplicate")), dup.join("\n"));
  const foreign = probeListProblems([...GOOD_LIST, "https://example.com/", "http://hivecommons.dev/"], { sitemap: FIXTURE_SITEMAP });
  assert.ok(foreign.some((x) => x.includes("example.com/ is not under")), foreign.join("\n"));
  assert.ok(foreign.some((x) => x.includes("http://hivecommons.dev/ is not https")), foreign.join("\n"));
  const query = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/stories/?x=1`], { sitemap: FIXTURE_SITEMAP });
  assert.ok(query.some((x) => x.includes("query/fragment")), query.join("\n"));
});

// --- the real workflow -----------------------------------------------------

test("links.yml availability job probes every canonical page, 404.html and a redirect, each a committed page", () => {
  const urls = probedUrls(readFileSync(WORKFLOW, "utf8"));
  const sitemap = sitemapLocs(readFileSync(join(ROOT, "sitemap.xml"), "utf8"));
  assert.deepEqual(
    probeListProblems(urls, { sitemap }),
    [],
    "the availability probe list in .github/workflows/links.yml drifted from the committed site (fixing it needs a workflow edit)",
  );
});
