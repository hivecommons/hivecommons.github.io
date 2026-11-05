#!/usr/bin/env node
// Static gate over every <iframe> on every committed HTML page. The homepage's
// hash-pinned script-src CSP only governs the homepage document: a frame that
// is same-origin (a relative src, one on hivecommons.dev, or its GitHub Pages
// alias — the org's project sites are served under this custom domain by *other*
// repositories) and unsandboxed can script `parent.document` and navigate `top`, so whatever
// ships in that other repository rewrites this page with none of this repo's
// gates in the way. featured-video.test.mjs pins the YouTube player's exact
// sandbox; this gate is the floor every other frame must meet: a `sandbox`
// attribute is present, it never grants top navigation, forms, modals or
// downloads, and a same-origin frame never pairs `allow-same-origin` with
// `allow-scripts` (on a same-origin document that pair lets the content strip
// its own sandbox, i.e. it is no sandbox at all). Each rule has a fixture
// self-test. Zero dependencies. Usage: node --test scripts/page-frames.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { ROOT, htmlFiles, isRedirectPage, lineOf } from "./html-pages.mjs";
import { attrs } from "./page-csp.mjs";

const SITE_ORIGIN = "https://hivecommons.dev";
const KNOWN_FRAME_ORIGINS = new Set([SITE_ORIGIN, "https://hivecommons.github.io"]);
const FORBIDDEN = /^allow-(top-navigation|forms|modals|downloads)/;

// The GitHub Pages alias redirects to SITE_ORIGIN, so it counts as same-origin too.
// Relative and protocol-relative src values conservatively count as same-origin.
// srcdoc and about: frames inherit the embedder's origin and count as same-origin too.
export function isSameOriginFrame(tag) {
  const a = attrs(tag);
  const src = a.src ?? "";
  if ("srcdoc" in a || src === "" || /^about:/i.test(src)) return true;
  if (/^https?:\/\//i.test(src)) return KNOWN_FRAME_ORIGINS.has(new URL(src).origin);
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src);
}

export function frameProblems(html) {
  const problems = [];
  for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const tag = m[0];
    const where = `line ${lineOf(html, m.index)} <iframe src="${attrs(tag).src ?? ""}">`;
    const sandbox = attrs(tag).sandbox;
    if (sandbox === undefined) {
      problems.push(`${where} has no sandbox attribute`);
      continue;
    }
    const tokens = sandbox.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
    for (const t of tokens) if (FORBIDDEN.test(t)) problems.push(`${where} sandbox grants ${t}`);
    if (isSameOriginFrame(tag) && tokens.includes("allow-same-origin") && tokens.includes("allow-scripts")) {
      problems.push(`${where} is same-origin and pairs allow-same-origin with allow-scripts, which is no sandbox at all`);
    }
  }
  return problems;
}

// --- per-page gates ---------------------------------------------------------

for (const file of htmlFiles()) {
  const rel = relative(ROOT, file);
  const html = readFileSync(file, "utf8");
  if (isRedirectPage(html)) continue;
  test(`${rel}: every <iframe> is sandboxed without top-navigation, and same-origin frames stay opaque`, () => {
    assert.deepEqual(frameProblems(html), []);
  });
}

test("index.html: the software-factory embed is sandboxed to scripts only", () => {
  const html = readFileSync(`${ROOT}/index.html`, "utf8");
  const frame = [...html.matchAll(/<iframe\b[^>]*>/g)].map((m) => m[0]).find((t) => (attrs(t).src ?? "").startsWith("/software-factory/"));
  assert.ok(frame, "missing the /software-factory/ iframe");
  assert.deepEqual(attrs(frame).sandbox.split(/\s+/).filter(Boolean), ["allow-scripts"]);
});

// --- fixture self-tests -----------------------------------------------------

const page = (frame) => `<!doctype html><html><head><title>x</title></head><body>\n${frame}\n</body></html>`;

test("fixture: isSameOriginFrame — relative, site-origin, srcdoc, src-less and about: are same-origin; other origins are not", () => {
  assert.equal(isSameOriginFrame('<iframe src="/embed/" title="x">'), true);
  assert.equal(isSameOriginFrame('<iframe src="embed.html" title="x">'), true);
  assert.equal(isSameOriginFrame('<iframe src="https://hivecommons.dev/x/" title="x">'), true);
  assert.equal(isSameOriginFrame('<iframe srcdoc="<p>x</p>" title="x">'), true);
  assert.equal(isSameOriginFrame('<iframe title="x">'), true);
  assert.equal(isSameOriginFrame('<iframe src="about:blank" title="x">'), true);
  assert.equal(isSameOriginFrame('<iframe src="https://www.youtube-nocookie.com/embed/x" title="x">'), false);
  assert.equal(isSameOriginFrame('<iframe src="HTTPS://HIVECOMMONS.DEV/x/" title="x">'), true);
});

test("fixture: GitHub Pages aliases count as same-origin and must keep scripts sandboxed", () => {
  for (const src of [
    "https://hivecommons.github.io/project/",
    "HTTPS://HIVECOMMONS.GITHUB.IO/project/",
    "//hivecommons.github.io/project/",
  ]) {
    assert.equal(isSameOriginFrame(`<iframe src="${src}" title="x">`), true);
    assert.deepEqual(frameProblems(page(`<iframe src="${src}" sandbox="allow-scripts allow-same-origin" title="x"></iframe>`)), [
      `line 2 <iframe src="${src}"> is same-origin and pairs allow-same-origin with allow-scripts, which is no sandbox at all`,
    ]);
    assert.deepEqual(frameProblems(page(`<iframe src="${src}" sandbox="allow-scripts" title="x"></iframe>`)), []);
  }
});

test("fixture: unrelated GitHub Pages sites and lookalike domains stay cross-origin", () => {
  for (const src of [
    "https://other.github.io/project/",
    "https://hivecommons.github.io.example.org/project/",
  ]) {
    assert.equal(isSameOriginFrame(`<iframe src="${src}" title="x">`), false);
    assert.deepEqual(frameProblems(page(`<iframe src="${src}" sandbox="allow-scripts allow-same-origin" title="x"></iframe>`)), []);
  }
});

test("fixture: a frame without sandbox is reported with its line and src", () => {
  assert.deepEqual(frameProblems(page('<iframe src="/software-factory/" title="x"></iframe>')), [
    'line 2 <iframe src="/software-factory/"> has no sandbox attribute',
  ]);
});

test("fixture: forbidden tokens are reported one per token, case-insensitively", () => {
  assert.deepEqual(frameProblems(page('<iframe src="https://example.org/e" sandbox="allow-scripts allow-top-navigation-by-user-activation Allow-Forms allow-modals allow-downloads" title="x"></iframe>')), [
    'line 2 <iframe src="https://example.org/e"> sandbox grants allow-top-navigation-by-user-activation',
    'line 2 <iframe src="https://example.org/e"> sandbox grants allow-forms',
    'line 2 <iframe src="https://example.org/e"> sandbox grants allow-modals',
    'line 2 <iframe src="https://example.org/e"> sandbox grants allow-downloads',
  ]);
});

test("fixture: same-origin frame pairing allow-same-origin with allow-scripts is reported; cross-origin may", () => {
  const same = '<iframe src="/software-factory/" sandbox="allow-scripts allow-same-origin" title="x"></iframe>';
  assert.deepEqual(frameProblems(page(same)), [
    'line 2 <iframe src="/software-factory/"> is same-origin and pairs allow-same-origin with allow-scripts, which is no sandbox at all',
  ]);
  const cross = '<iframe src="https://www.youtube-nocookie.com/embed/x" sandbox="allow-scripts allow-same-origin allow-presentation" title="x"></iframe>';
  assert.deepEqual(frameProblems(page(cross)), []);
});

test("fixture: compliant frames and pages without frames pass; an empty sandbox is the strictest and passes", () => {
  assert.deepEqual(frameProblems(page('<iframe src="/software-factory/" sandbox="allow-scripts" title="x"></iframe>')), []);
  assert.deepEqual(frameProblems(page('<iframe src="/x/" sandbox="" title="x"></iframe>')), []);
  assert.deepEqual(frameProblems(page('<p>no frames</p>')), []);
});

test("fixture: several frames are each checked", () => {
  const html = page('<iframe src="/a/" sandbox="allow-scripts" title="a"></iframe>\n<iframe src="/b/" title="b"></iframe>\n<iframe srcdoc="<p>c</p>" title="c"></iframe>');
  assert.deepEqual(frameProblems(html), [
    'line 3 <iframe src="/b/"> has no sandbox attribute',
    'line 4 <iframe src=""> has no sandbox attribute',
  ]);
});
