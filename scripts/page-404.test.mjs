#!/usr/bin/env node
// Static gate for the custom error page. GitHub Pages serves /404.html for every
// unknown path, at whatever depth the visitor typed, so the page has a contract
// no other page shares: it must live at the repository root (Pages ignores a
// 404.html anywhere else), it must not claim a canonical URL or social-card
// identity (it is served at thousands of URLs), it must stay noindex, it must
// not be a redirect (a refresh would turn every typo into a bounce), every
// href/src must be root-absolute or external (a relative "style.css" resolves
// against the unknown path and breaks), it must link back to "/", and its body
// text must keep matching check-links.sh's SOFT_404_RE so the link checker
// recognises this page when a misrouted URL serves it with HTTP 200.
// page-meta.test.mjs deliberately skips 404.html; this is the gate for it.
// Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/page-404.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "scripts", ".linkcheck-work"]);

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return out;
}

function headOf(html) {
  const m = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  return m ? m[1] : "";
}

function metas(head) {
  return [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
}

// Visible body text with tags stripped and whitespace collapsed.
export function bodyText(html) {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const body = m ? m[1] : "";
  return body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Every URL the browser would fetch or follow from the page.
export function pageUrls(html) {
  const out = [];
  for (const m of html.matchAll(/<(a|link|img|script|source|iframe|video|audio)\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    for (const key of ["href", "src", "srcset"]) {
      if (a[key] === undefined) continue;
      const values = key === "srcset" ? a[key].split(",").map((s) => s.trim().split(/\s+/)[0]) : [a[key]];
      for (const v of values) if (v) out.push({ tag: m[1].toLowerCase(), attr: key, url: v });
    }
  }
  return out;
}

// Rules over the error page's <head> and <body>.
export function errorPageProblems(html) {
  const problems = [];
  const head = headOf(html);
  const ms = metas(head);
  const named = (n) => ms.filter((m) => (m.name ?? "").toLowerCase() === n).map((m) => m.content ?? "");

  const lang = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  if (!lang) problems.push('<html> lacks a lang attribute');
  if (!ms.some((m) => m.charset !== undefined)) problems.push("missing <meta charset>");
  if (!named("viewport")[0]) problems.push("missing or empty <meta name=\"viewport\">");

  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1].trim());
  if (titles.length !== 1 || !titles[0]) problems.push("error page needs exactly one non-empty <title>");

  const robots = named("robots");
  if (robots.length !== 1) problems.push(`expected exactly one <meta name="robots">, found ${robots.length}`);
  else if (!/\bnoindex\b/i.test(robots[0])) problems.push('error page lacks <meta name="robots" content="noindex">');

  if (ms.some((m) => (m["http-equiv"] ?? "").toLowerCase() === "refresh")) problems.push("error page must not be a meta-refresh redirect");

  const canonicals = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0])).filter((a) => /\bcanonical\b/i.test(a.rel ?? ""));
  if (canonicals.length) problems.push("error page must not declare <link rel=\"canonical\"> (it is served at every unknown path)");
  const social = ms.filter((m) => /^(og|twitter):/i.test(m.property ?? m.name ?? ""));
  if (social.length) problems.push(`error page must not carry og:/twitter: metadata, found ${social.length} tag(s)`);

  if (!/<h1\b[^>]*>\s*\S/i.test(html)) problems.push("error page needs a non-empty <h1>");

  const urls = pageUrls(html);
  for (const { tag, attr, url } of urls) {
    if (/^(https?:)?\/\//i.test(url) || /^(mailto|tel):/i.test(url)) continue;
    if (url.startsWith("#")) continue;
    if (!url.startsWith("/")) problems.push(`<${tag} ${attr}="${url}"> is relative; the error page is served at arbitrary paths, use a root-absolute URL`);
  }
  if (!urls.some(({ tag, attr, url }) => tag === "a" && attr === "href" && url === "/")) problems.push('error page lacks an <a href="/"> back to the home page');
  return problems;
}

// Root-absolute references must name committed files (directories map to index.html).
export function localTargetProblems(html, root = ROOT) {
  const problems = [];
  for (const { tag, attr, url } of pageUrls(html)) {
    if (!url.startsWith("/") || url.startsWith("//")) continue;
    const clean = url.replace(/[?#].*$/, "");
    let file = join(root, clean);
    if (clean.endsWith("/")) file = join(file, "index.html");
    if (!existsSync(file) || statSync(file).isDirectory()) problems.push(`<${tag} ${attr}="${url}"> does not resolve to a committed file`);
  }
  return problems;
}

// check-links.sh keeps a regex that recognises not-found bodies served with 200.
export function soft404Regex(script) {
  const m = /^SOFT_404_RE="((?:[^"\\]|\\.)*)"/m.exec(script);
  return m ? new RegExp(m[1]) : null;
}

export function error404Locations(root = ROOT, dir = root) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...error404Locations(root, full));
    } else if (name === "404.html") {
      out.push(relative(root, full));
    }
  }
  return out.sort();
}

// --- fixtures ---------------------------------------------------------------

const GOOD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found — Fixture</title>
<style>body{margin:0}</style>
</head>
<body>
<main>
<h1>Page not found</h1>
<p>That page doesn't exist or has moved.</p>
<p><a href="/">Go home</a></p>
</main>
</body>
</html>`;

test("fixture: a complete error page passes every rule", () => {
  assert.deepEqual(errorPageProblems(GOOD), []);
});

test("fixture: missing lang, charset, viewport, title and h1 are reported", () => {
  assert.ok(errorPageProblems(GOOD.replace(' lang="en"', "")).includes("<html> lacks a lang attribute"));
  assert.ok(errorPageProblems(GOOD.replace('<meta charset="utf-8">', "")).includes("missing <meta charset>"));
  assert.ok(errorPageProblems(GOOD.replace(/<meta name="viewport"[^>]*>/, "")).some((p) => p.includes("viewport")));
  assert.ok(errorPageProblems(GOOD.replace(/<title>[^<]*<\/title>/, "")).some((p) => p.includes("<title>")));
  assert.ok(errorPageProblems(GOOD.replace("<title>", "<title>A</title><title>")).some((p) => p.includes("exactly one non-empty <title>")));
  assert.ok(errorPageProblems(GOOD.replace(/<h1>[^<]*<\/h1>/, "")).some((p) => p.includes("<h1>")));
});

test("fixture: robots must be exactly one noindex meta", () => {
  assert.ok(errorPageProblems(GOOD.replace(/<meta name="robots"[^>]*>/, "")).some((p) => p.includes("found 0")));
  assert.ok(errorPageProblems(GOOD.replace('content="noindex"', 'content="index, follow"')).some((p) => p.includes("lacks")));
  const twice = GOOD.replace("<title>", '<meta name="robots" content="noindex"><title>');
  assert.ok(errorPageProblems(twice).some((p) => p.includes("found 2")));
});

test("fixture: redirect, canonical and social-card metadata are rejected", () => {
  const refresh = GOOD.replace("<title>", '<meta http-equiv="refresh" content="0; url=/"><title>');
  assert.ok(errorPageProblems(refresh).some((p) => p.includes("meta-refresh")));
  const canonical = GOOD.replace("<title>", '<link rel="canonical" href="https://example.test/404.html"><title>');
  assert.ok(errorPageProblems(canonical).some((p) => p.includes("canonical")));
  const og = GOOD.replace("<title>", '<meta property="og:title" content="x"><meta name="twitter:card" content="summary"><title>');
  assert.ok(errorPageProblems(og).some((p) => p.includes("found 2 tag(s)")));
});

test("fixture: relative URLs are rejected, root-absolute/external/anchor/mailto are allowed, home link required", () => {
  const rel = GOOD.replace("<style>", '<link rel="stylesheet" href="style.css"><style>');
  assert.ok(errorPageProblems(rel).some((p) => p.includes('href="style.css"> is relative')));
  const dotdot = GOOD.replace("</main>", '<img src="../og.png" alt=""></main>');
  assert.ok(errorPageProblems(dotdot).some((p) => p.includes('src="../og.png"> is relative')));
  const srcset = GOOD.replace("</main>", '<img src="/og.png" srcset="og.png 2x" alt=""></main>');
  assert.ok(errorPageProblems(srcset).some((p) => p.includes('srcset="og.png"> is relative')));
  const ok = GOOD.replace("</main>", '<a href="https://example.test/">x</a><a href="//cdn.test/a">y</a><a href="#top">z</a><a href="mailto:a@b">m</a><img src="/og.png" alt=""></main>');
  assert.deepEqual(errorPageProblems(ok), []);
  assert.ok(errorPageProblems(GOOD.replace('href="/"', 'href="/stories/"')).some((p) => p.includes('<a href="/">')));
});

test("fixture: root-absolute targets must be committed files", () => {
  assert.deepEqual(localTargetProblems(GOOD), []);
  const dir = GOOD.replace("</main>", '<a href="/stories/">s</a><img src="/og.png?v=1" alt=""></main>');
  assert.deepEqual(localTargetProblems(dir), []);
  const dead = GOOD.replace("</main>", '<img src="/assets/no-such-file.png" alt=""><a href="/nope/">n</a></main>');
  assert.deepEqual(localTargetProblems(dead), [
    '<img src="/assets/no-such-file.png"> does not resolve to a committed file',
    '<a href="/nope/"> does not resolve to a committed file',
  ]);
  const bareDir = GOOD.replace("</main>", '<a href="/stories">s</a></main>');
  assert.ok(localTargetProblems(bareDir).some((p) => p.includes('href="/stories">')), "a directory without trailing slash is not a file");
});

test("fixture: bodyText strips tags, style and script, collapsing whitespace", () => {
  assert.equal(bodyText(GOOD), "Page not found That page doesn't exist or has moved. Go home");
  assert.equal(bodyText('<body><script>x("<b>")</script><p>a&nbsp;b</p></body>'), "a b");
  assert.equal(bodyText("<html>no body</html>"), "");
});

test("fixture: soft404Regex reads SOFT_404_RE from the checker script and tolerates its absence", () => {
  const re = soft404Regex('X=1\nSOFT_404_RE="Page Not Found|>404<"\nY=2\n');
  assert.ok(re instanceof RegExp);
  assert.ok(re.test("<h1>Page Not Found</h1>"));
  assert.ok(!re.test("all good"));
  assert.equal(soft404Regex("nothing here"), null);
});

// --- live checks over the committed tree ------------------------------------

const PAGE = join(ROOT, "404.html");

test("404.html exists at the repository root and nowhere else (GitHub Pages only honours the root copy)", () => {
  assert.deepEqual(error404Locations(), ["404.html"]);
});

test("404.html: head/body carry the error-page contract (noindex, no canonical/social, no refresh, root-absolute links, home link)", () => {
  assert.deepEqual(errorPageProblems(readFileSync(PAGE, "utf8")), []);
});

test("404.html: every root-absolute href/src resolves to a committed file", () => {
  assert.deepEqual(localTargetProblems(readFileSync(PAGE, "utf8")), []);
});

test("404.html: visible body text matches check-links.sh SOFT_404_RE so a misrouted 200 is detected as a soft-404", () => {
  const re = soft404Regex(readFileSync(join(ROOT, "scripts", "check-links.sh"), "utf8"));
  assert.ok(re, "scripts/check-links.sh no longer defines SOFT_404_RE=\"...\"");
  const text = bodyText(readFileSync(PAGE, "utf8"));
  assert.match(text, re, `404.html body "${text}" is not matched by SOFT_404_RE ${re}`);
});

test("404.html: pages with their own not-found copy do not exist (no soft-404 content on canonical pages)", () => {
  const re = soft404Regex(readFileSync(join(ROOT, "scripts", "check-links.sh"), "utf8"));
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
      } else if (name.endsWith(".html") && full !== PAGE) {
        if (re.test(bodyText(readFileSync(full, "utf8")))) offenders.push(relative(ROOT, full));
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], "these pages would be flagged as soft-404s by check-links.sh");
});
