#!/usr/bin/env node
// Static gate over what GitHub Pages' Jekyll build actually publishes. The
// site has no build step of its own, but Pages still runs Jekyll, which
// silently drops any path whose segment starts with `_`, `.`, `#` or `~`
// unless `_config.yml` lists it under `include:`, drops anything under
// `exclude:`, and runs Liquid over any file that opens with a `---` front
// matter block. None of the other gates look at that: availability-probes
// resolves each probed URL to a committed file, so `.well-known/security.txt`
// passes review with `include:` deleted and only the six-hourly live probe
// notices the 404 after deploy. Each rule has a fixture self-test. Zero
// dependencies. Usage: node --test scripts/pages-build.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SITE_ORIGIN = "https://hivecommons.dev";
const CONFIG = join(ROOT, "_config.yml");
const WORKFLOW = join(ROOT, ".github", "workflows", "links.yml");
const SITEMAP = join(ROOT, "sitemap.xml");
const SECURITY_TXT = join(ROOT, ".well-known", "security.txt");

// Dot-directories at the repository root that are tooling, never site content.
export const TOOLING_DIRS = new Set([".git", ".github", ".linkcheck-work", "node_modules"]);
// The only key the README allows in _config.yml ("nothing else about the build is configured").
export const ALLOWED_CONFIG_KEYS = new Set(["include"]);
// Jekyll's default exclude list (files it never publishes even when committed).
const JEKYLL_DEFAULT_EXCLUDE = new Set([".sass-cache", ".jekyll-cache", "gemfiles", "Gemfile", "Gemfile.lock", "node_modules", "vendor"]);

// --- parsing -----------------------------------------------------------------

// Minimal reader for the flat `key:` / `- item` YAML _config.yml uses. Returns
// { keys: [top-level keys in order], lists: { key: [items] }, scalars: { key: value } }.
// Anything it cannot read (nested maps, flow collections, tabs) is reported in
// `problems` so the live test cannot pass vacuously on a file it did not parse.
export function parseConfig(text) {
  const out = { keys: [], lists: {}, scalars: {}, problems: [] };
  let current = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (!line.trim()) return;
    if (/\t/.test(line)) { out.problems.push(`line ${i + 1}: tab indentation`); return; }
    let m;
    if ((m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line))) {
      current = m[1];
      out.keys.push(current);
      const v = m[2].trim();
      if (v === "") out.lists[current] = out.lists[current] ?? [];
      else if (/^\[(.*)\]$/.test(v)) out.lists[current] = v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
      else out.scalars[current] = unquote(v);
      return;
    }
    if ((m = /^[ \t]+-[ \t]+(.+)$/.exec(line)) && current && out.lists[current]) {
      out.lists[current].push(unquote(m[1].trim()));
      return;
    }
    out.problems.push(`line ${i + 1}: unreadable: ${JSON.stringify(raw)}`);
  });
  return out;
}

function unquote(s) {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

// The `availability` job's `for url in ...; do` word list (same shape
// availability-probes.test.mjs reads); [] when absent.
export function probedUrls(yaml) {
  const job = /^\s{2}availability:\s*$([\s\S]*?)(?=^\s{2}\S|(?![\s\S]))/m.exec(yaml);
  const loop = job && /for\s+url\s+in\s+([\s\S]*?);\s*do\b/.exec(job[1]);
  return loop ? loop[1].replace(/\\\r?\n/g, " ").split(/\s+/).filter(Boolean) : [];
}

export function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

export function securityTxtCanonicals(text) {
  return [...text.matchAll(/^Canonical:[ \t]*(\S+)/gim)].map((m) => m[1]);
}

// Repo-relative path (POSIX separators) a site URL is served from, or null
// when the URL is off-site. Directory URLs map to their index.html.
export function urlToRelPath(url, origin = SITE_ORIGIN) {
  if (url === origin) return "index.html";
  if (!url.startsWith(origin + "/")) return null;
  const path = url.slice(origin.length).replace(/[?#].*$/, "");
  return path === "/" ? "index.html" : path.endsWith("/") ? path.slice(1) + "index.html" : path.slice(1);
}

// --- rules -------------------------------------------------------------------

// Why Jekyll would not publish `rel` under `config`, or null if it would.
export function unpublishedReason(rel, config) {
  const include = config.lists.include ?? [];
  const exclude = config.lists.exclude ?? [];
  const segments = rel.split("/");
  const listed = (list, path) => list.some((p) => p.replace(/\/+$/, "") === path);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const top = segments.slice(0, i + 1).join("/");
    if (listed(exclude, top)) return `${top} is listed under _config.yml exclude:`;
    if (i === 0 && JEKYLL_DEFAULT_EXCLUDE.has(seg) && !listed(include, seg)) return `${seg} is on Jekyll's default exclude list`;
    if (/^[_.#~]/.test(seg) && !listed(include, top)) {
      return `${top} starts with ${JSON.stringify(seg[0])}, which Jekyll drops unless _config.yml include: lists it`;
    }
  }
  return null;
}

export function hasFrontMatter(text) {
  return /^\uFEFF?---[ \t]*\r?\n/.test(text);
}

// Root-level dot-directories holding files (recursively), minus tooling dirs.
export function contentDotDirs(root = ROOT) {
  return readdirSync(root)
    .filter((n) => n.startsWith(".") && !TOOLING_DIRS.has(n) && statSync(join(root, n)).isDirectory() && hasFiles(join(root, n)))
    .sort();
}

function hasFiles(dir) {
  return readdirSync(dir).some((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? hasFiles(full) : true;
  });
}

export function configProblems(config) {
  const problems = [...config.problems];
  for (const k of config.keys) if (!ALLOWED_CONFIG_KEYS.has(k)) problems.push(`_config.yml sets \`${k}:\`; README says only \`include:\` is configured — document the new key there and here if it is needed`);
  if (new Set(config.keys).size !== config.keys.length) problems.push("_config.yml repeats a top-level key (YAML keeps the last one)");
  if (!config.lists.include) problems.push("_config.yml has no `include:` list, so Jekyll drops every dot-directory (.well-known/security.txt included)");
  else {
    for (const item of config.lists.include) {
      if (!existsSync(join(ROOT, item))) problems.push(`_config.yml include: lists ${item}, which does not exist`);
    }
  }
  return problems;
}

export function publishProblems({ config, urls, files, dotDirs }) {
  const problems = [];
  for (const d of dotDirs) {
    if (!(config.lists.include ?? []).includes(d)) problems.push(`${d}/ holds site files but is not in _config.yml include:, so Pages will not publish it`);
  }
  const seen = new Set();
  for (const { url, source } of urls) {
    const rel = urlToRelPath(url);
    if (rel === null) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const reason = unpublishedReason(rel, config);
    if (reason) problems.push(`${url} (${source}) is served from ${rel}, but ${reason}`);
  }
  for (const [rel, text] of Object.entries(files)) {
    if (hasFrontMatter(text)) problems.push(`${rel} opens with a \`---\` front matter block, so Jekyll will run Liquid over it and rewrite its contents`);
  }
  return problems;
}

// --- fixtures ----------------------------------------------------------------

const GOOD_CONFIG = parseConfig("# comment\ninclude:\n  - .well-known\n");

test("fixture: parseConfig reads keys, block lists, flow lists and scalars, and reports what it cannot read", () => {
  const c = parseConfig("include:\n  - .well-known # trailing\n  - '.other'\nexclude: [a, \"b\"]\ntitle: Site\n");
  assert.deepEqual(c.keys, ["include", "exclude", "title"]);
  assert.deepEqual(c.lists.include, [".well-known", ".other"]);
  assert.deepEqual(c.lists.exclude, ["a", "b"]);
  assert.equal(c.scalars.title, "Site");
  assert.deepEqual(c.problems, []);
  assert.match(parseConfig("defaults:\n  - scope:\n      path: ''\n").problems.join("\n"), /unreadable/);
  assert.match(parseConfig("include:\n\t- .well-known\n").problems.join("\n"), /tab/);
});

test("fixture: a config with only include: [.well-known] passes", () => {
  assert.deepEqual(configProblems(GOOD_CONFIG), []);
});

test("fixture: a missing include: list, an unknown key, a repeated key and a nonexistent include entry are reported", () => {
  assert.match(configProblems(parseConfig("# nothing\n")).join("\n"), /no `include:` list/);
  assert.match(configProblems(parseConfig("include:\n  - .well-known\nplugins:\n  - jekyll-seo-tag\n")).join("\n"), /sets `plugins:`/);
  assert.match(configProblems(parseConfig("include:\n  - .well-known\ninclude:\n  - .well-known\n")).join("\n"), /repeats/);
  assert.match(configProblems(parseConfig("include:\n  - .well-known\n  - .nope-dir\n")).join("\n"), /\.nope-dir, which does not exist/);
});

test("fixture: unpublishedReason knows Jekyll's special-prefix, include:, exclude: and default-exclude rules", () => {
  assert.equal(unpublishedReason("index.html", GOOD_CONFIG), null);
  assert.equal(unpublishedReason("docs/index.html", GOOD_CONFIG), null);
  assert.equal(unpublishedReason(".well-known/security.txt", GOOD_CONFIG), null);
  assert.match(unpublishedReason(".well-known/security.txt", parseConfig("include: []\n")), /Jekyll drops unless/);
  assert.match(unpublishedReason(".well-known/security.txt", parseConfig("include:\n  - .other\n")), /Jekyll drops unless/);
  assert.match(unpublishedReason("_data/x.json", GOOD_CONFIG), /_data starts with "_"/);
  assert.match(unpublishedReason("a/#tmp.html", GOOD_CONFIG), /a\/#tmp.html starts with "#"/);
  assert.match(unpublishedReason("a/~b/c.html", GOOD_CONFIG), /a\/~b starts with "~"/);
  assert.match(unpublishedReason("docs/index.html", parseConfig("include:\n  - .well-known\nexclude:\n  - docs/\n")), /listed under _config.yml exclude:/);
  assert.match(unpublishedReason("vendor/x.js", GOOD_CONFIG), /default exclude list/);
  assert.equal(unpublishedReason("vendor/x.js", parseConfig("include:\n  - .well-known\n  - vendor\n")), null);
});

test("fixture: urlToRelPath maps origin, directory and file URLs and rejects off-site URLs", () => {
  assert.equal(urlToRelPath(`${SITE_ORIGIN}/`), "index.html");
  assert.equal(urlToRelPath(SITE_ORIGIN), "index.html");
  assert.equal(urlToRelPath(`${SITE_ORIGIN}/docs/`), "docs/index.html");
  assert.equal(urlToRelPath(`${SITE_ORIGIN}/.well-known/security.txt?x#y`), ".well-known/security.txt");
  assert.equal(urlToRelPath("https://example.com/"), null);
});

test("fixture: probedUrls, sitemapLocs and securityTxtCanonicals extract their URL lists", () => {
  const yaml = "jobs:\n  availability:\n    steps:\n      - run: |\n          for url in https://a/ \\\n                     https://b/x.txt; do\n            echo\n          done\n  links:\n    steps: []\n";
  assert.deepEqual(probedUrls(yaml), ["https://a/", "https://b/x.txt"]);
  assert.deepEqual(probedUrls("jobs:\n  links:\n    steps: []\n"), []);
  assert.deepEqual(sitemapLocs("<urlset><url><loc> https://a/ </loc></url></urlset>"), ["https://a/"]);
  assert.deepEqual(securityTxtCanonicals("# c\nContact: x\ncanonical: https://a/.well-known/security.txt\n"), ["https://a/.well-known/security.txt"]);
});

test("fixture: hasFrontMatter detects a leading --- block (BOM and CRLF included) and nothing else", () => {
  assert.equal(hasFrontMatter("---\ntitle: x\n---\n<html>"), true);
  assert.equal(hasFrontMatter("\uFEFF---\r\nlayout: null\r\n---\r\n"), true);
  assert.equal(hasFrontMatter("<!DOCTYPE html>\n---\n"), false);
  assert.equal(hasFrontMatter("----\n"), false);
  assert.equal(hasFrontMatter("# Hive Commons\n"), false);
});

const FIXTURE_URLS = [
  { url: `${SITE_ORIGIN}/`, source: "sitemap.xml" },
  { url: `${SITE_ORIGIN}/.well-known/security.txt`, source: "links.yml availability probe" },
];

test("fixture: published dot-dir URLs pass when include: lists the directory", () => {
  assert.deepEqual(publishProblems({ config: GOOD_CONFIG, urls: FIXTURE_URLS, files: { "index.html": "<!DOCTYPE html>" }, dotDirs: [".well-known"] }), []);
});

test("fixture: dropping .well-known from include: is reported for both the directory and every URL served from it", () => {
  const p = publishProblems({ config: parseConfig("include: []\n"), urls: FIXTURE_URLS, files: {}, dotDirs: [".well-known"] });
  assert.ok(p.some((x) => x.startsWith(".well-known/ holds site files but is not in _config.yml include:")), p.join("\n"));
  assert.ok(p.some((x) => x.includes("/.well-known/security.txt (links.yml availability probe) is served from .well-known/security.txt, but")), p.join("\n"));
  assert.equal(p.length, 2);
});

test("fixture: the same file reached from two sources is reported once", () => {
  const urls = [...FIXTURE_URLS, { url: `${SITE_ORIGIN}/.well-known/security.txt`, source: "security.txt Canonical" }];
  const p = publishProblems({ config: parseConfig("include: []\n"), urls, files: {}, dotDirs: [] });
  assert.equal(p.length, 1);
});

test("fixture: a published file with front matter is reported", () => {
  const p = publishProblems({ config: GOOD_CONFIG, urls: [], files: { "llms.txt": "---\nlayout: null\n---\n# x" }, dotDirs: [] });
  assert.match(p.join("\n"), /llms.txt opens with a `---` front matter block/);
});

test("fixture: contentDotDirs ignores tooling directories and empty dot-directories", () => {
  const dirs = contentDotDirs(ROOT);
  assert.ok(dirs.includes(".well-known"), dirs.join(","));
  assert.ok(!dirs.includes(".git") && !dirs.includes(".github"), dirs.join(","));
});

// --- live checks -------------------------------------------------------------

const config = parseConfig(readFileSync(CONFIG, "utf8"));

test("_config.yml is readable, only configures include:, and every include entry exists", () => {
  assert.deepEqual(configProblems(config), []);
});

test("every URL the site publishes resolves to a file Jekyll will actually deploy, and no published file carries front matter", () => {
  const urls = [
    ...sitemapLocs(readFileSync(SITEMAP, "utf8")).map((url) => ({ url, source: "sitemap.xml" })),
    ...probedUrls(readFileSync(WORKFLOW, "utf8")).map((url) => ({ url, source: "links.yml availability probe" })),
    ...securityTxtCanonicals(readFileSync(SECURITY_TXT, "utf8")).map((url) => ({ url, source: "security.txt Canonical" })),
  ];
  assert.ok(urls.length >= 3, "expected sitemap, probe and Canonical URLs to be extracted");
  const files = {};
  for (const { url } of urls) {
    const rel = urlToRelPath(url);
    const full = rel && resolve(ROOT, rel);
    if (full && full.startsWith(resolve(ROOT) + sep) && existsSync(full) && statSync(full).isFile()) files[rel] = readFileSync(full, "utf8");
  }
  assert.deepEqual(publishProblems({ config, urls, files, dotDirs: contentDotDirs(ROOT) }), []);
});
