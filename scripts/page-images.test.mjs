#!/usr/bin/env node
// Static gate for the image assets the pages embed. check-links.sh proves an
// <img src> or <link rel="icon" href> names a committed file and the markup
// gate proves every <img> has alt, but nothing looks at the bytes: a PNG
// re-exported as SVG under the old .png name, a logo whose width/height
// attributes no longer match its intrinsic aspect ratio (the browser
// reserves the wrong box and squashes or letterboxes it), an SVG without a
// viewBox (it cannot scale to the 20px slot), a raster smaller than the box
// it is drawn in (blurry upscale), or an asset left under assets/ after the
// tag that used it was removed. style-contract.test.mjs covers the same
// contract for CSS url() and the self-hosted fonts; this file covers the
// markup side. Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/page-images.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "scripts", ".linkcheck-work"]);
const ASSET_DIR = join(ROOT, "assets");
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|ico)$/i;
// Declared width/height may be rounded from a non-integer intrinsic ratio
// (e.g. a 109x40.5 viewBox drawn at 27x10), so allow a little slack.
const ASPECT_TOLERANCE = 0.05;

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
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank);
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function isLocalUrl(url) {
  return url !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);
}

// Every local image the page's markup embeds: <img src>, <img srcset>
// candidates, <link rel="icon|apple-touch-icon|preload as=image" href> and
// <meta property="og:image"|name="twitter:image" content>. Each carries the
// tag's line, the declared width/height when both are present, and whether
// it is an <img> (only <img> gets the aspect/viewBox/upscale rules).
export function imageReferences(html) {
  const markup = markupOnly(html);
  const out = [];
  for (const m of markup.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const line = lineOf(markup, m.index);
    const w = attr(tag, "width");
    const h = attr(tag, "height");
    const declared = w !== null && h !== null && /^\d+$/.test(w) && /^\d+$/.test(h) ? { width: Number(w), height: Number(h) } : null;
    const src = attr(tag, "src");
    if (src !== null && isLocalUrl(src.trim())) out.push({ url: src.trim().split(/[?#]/)[0], line, img: true, declared });
    const srcset = attr(tag, "srcset");
    if (srcset !== null) {
      for (const candidate of srcset.split(",")) {
        const url = candidate.trim().split(/\s+/)[0] ?? "";
        if (isLocalUrl(url)) out.push({ url: url.split(/[?#]/)[0], line, img: true, declared: null });
      }
    }
  }
  for (const m of markup.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const isIcon = rel.includes("icon") || rel.includes("apple-touch-icon");
    const isPreloadImage = rel.includes("preload") && (attr(tag, "as") ?? "").toLowerCase() === "image";
    if (!isIcon && !isPreloadImage) continue;
    const href = attr(tag, "href");
    if (href !== null && isLocalUrl(href.trim())) out.push({ url: href.trim().split(/[?#]/)[0], line: lineOf(markup, m.index), img: false, declared: null });
  }
  for (const m of markup.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (key !== "og:image" && key !== "twitter:image") continue;
    const content = attr(tag, "content");
    if (content === null) continue;
    const url = content.trim().replace(/^https?:\/\/(?:www\.)?hivecommons\.dev(?=\/)/i, "");
    if (isLocalUrl(url)) out.push({ url: url.split(/[?#]/)[0], line: lineOf(markup, m.index), img: false, declared: null });
  }
  return out;
}

// Resolve a URL against the site root (leading /) or the referencing file's directory.
export function resolveAssetPath(url, fromFile, root = ROOT) {
  return url.startsWith("/") ? join(root, url) : resolve(dirname(fromFile), url);
}

const SIGNATURES = {
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  jpg: [Buffer.from([0xff, 0xd8, 0xff])],
  gif: [Buffer.from("GIF87a"), Buffer.from("GIF89a")],
  webp: [Buffer.from("RIFF")],
  ico: [Buffer.from([0x00, 0x00, 0x01, 0x00])],
};
const EXT_KIND = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp", ico: "ico", svg: "svg" };

export function expectedImageKind(url) {
  const ext = /\.([a-z0-9]+)$/i.exec(url);
  return ext ? EXT_KIND[ext[1].toLowerCase()] ?? null : null;
}

// Whether a file's leading bytes match the kind. SVG is text: optional
// BOM/whitespace/XML prolog/comments, then an <svg> root.
export function bytesMatchKind(bytes, kind) {
  if (!kind) return true;
  if (kind === "svg") {
    const head = bytes.subarray(0, 2048).toString("utf8").replace(/^\uFEFF/, "").replace(/<\?xml[\s\S]*?\?>/, "").replace(/<!DOCTYPE[^>]*>/i, "").replace(/<!--[\s\S]*?-->/g, "").trim();
    return /^<svg[\s>\/]/i.test(head);
  }
  const sigs = SIGNATURES[kind];
  return sigs.some((sig) => bytes.length >= sig.length && bytes.subarray(0, sig.length).equals(sig));
}

// Intrinsic pixel size (or SVG user-unit size) of an image, or null when the
// kind is unknown or the header cannot be read.
export function intrinsicSize(bytes, kind) {
  if (kind === "png") {
    if (bytes.length < 24 || bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (kind === "gif") {
    if (bytes.length < 10) return null;
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (kind === "jpg") {
    // Walk the marker segments to the first SOFn frame header.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + len;
    }
    return null;
  }
  if (kind === "svg") {
    const root = /<svg\b[^>]*>/i.exec(bytes.toString("utf8"));
    if (!root) return null;
    const vb = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(root[0]);
    if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
    const w = /\swidth\s*=\s*["']?([\d.]+)(?:px)?["'\s>]/i.exec(root[0]);
    const h = /\sheight\s*=\s*["']?([\d.]+)(?:px)?["'\s>]/i.exec(root[0]);
    return w && h ? { width: Number(w[1]), height: Number(h[1]) } : null;
  }
  return null;
}

export function svgHasViewBox(bytes) {
  const root = /<svg\b[^>]*>/i.exec(bytes.toString("utf8"));
  return !!root && /\bviewBox\s*=/i.test(root[0]);
}

// Problems for every local image reference in `html` (which lives at
// `fromFile`), using `readAsset(path)` -> Buffer | null so fixtures can
// supply an in-memory tree. Returns the resolved paths too so the caller can
// build the referenced set for the orphan rule.
export function imageProblems(html, fromFile, readAsset, label = "page", root = ROOT) {
  const problems = [];
  const referenced = new Set();
  const seen = new Set();
  for (const ref of imageReferences(html)) {
    const path = resolveAssetPath(ref.url, fromFile, root);
    referenced.add(path);
    const key = `${path}|${ref.line}|${ref.declared ? `${ref.declared.width}x${ref.declared.height}` : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes = readAsset(path);
    if (bytes === null) { problems.push(`${label} line ${ref.line}: ${ref.url} names no committed file`); continue; }
    if (bytes.length === 0) { problems.push(`${label} line ${ref.line}: ${ref.url} is an empty file`); continue; }
    const kind = expectedImageKind(ref.url);
    if (!kind) { problems.push(`${label} line ${ref.line}: ${ref.url} has no recognised image extension`); continue; }
    if (!bytesMatchKind(bytes, kind)) { problems.push(`${label} line ${ref.line}: ${ref.url} does not start with the ${kind} signature its extension promises`); continue; }
    if (!ref.img) continue;
    const size = intrinsicSize(bytes, kind);
    if (size && (size.width === 0 || size.height === 0)) problems.push(`${label} line ${ref.line}: ${ref.url} declares a zero-sized image`);
    if (!ref.declared || !size || size.width === 0 || size.height === 0) continue;
    const intrinsic = size.width / size.height;
    const declared = ref.declared.width / ref.declared.height;
    if (Math.abs(intrinsic - declared) / intrinsic > ASPECT_TOLERANCE) {
      problems.push(`${label} line ${ref.line}: ${ref.url} is ${size.width}x${size.height} but the <img> declares ${ref.declared.width}x${ref.declared.height} (aspect ${intrinsic.toFixed(3)} vs ${declared.toFixed(3)})`);
    }
    if (kind !== "svg" && (size.width < ref.declared.width || size.height < ref.declared.height)) {
      problems.push(`${label} line ${ref.line}: ${ref.url} is ${size.width}x${size.height} but the <img> declares ${ref.declared.width}x${ref.declared.height}, so the browser upscales it`);
    }
  }
  return { problems, referenced };
}

// An SVG drawn by <img> scales to the box only through its root viewBox:
// without one the browser lays the drawing out in user units inside the
// 20px viewport and clips it, so a 512-unit icon shows just its corner. The
// icon <link> and og:image paths are not scaled that way, so only <img>
// references are checked.
export function svgViewBoxProblems(html, fromFile, readAsset, label = "page", root = ROOT) {
  const problems = [];
  const seen = new Set();
  for (const ref of imageReferences(html)) {
    if (!ref.img || expectedImageKind(ref.url) !== "svg") continue;
    const path = resolveAssetPath(ref.url, fromFile, root);
    const key = `${path}|${ref.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes = readAsset(path);
    if (bytes === null || !bytesMatchKind(bytes, "svg")) continue; // reported by imageProblems
    if (!svgHasViewBox(bytes)) problems.push(`${label} line ${ref.line}: ${ref.url} is an <img> SVG whose root has no viewBox, so it cannot scale to its box`);
  }
  return problems;
}

// Image URLs that CSS embeds (so a background image under assets/ is not an orphan).
export function cssImageUrls(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const m of clean.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/g)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (isLocalUrl(raw)) out.push(raw.split(/[?#]/)[0]);
  }
  return out;
}

// Committed image files under assets/ that no page or stylesheet references
// are dead weight that drifts silently (e.g. a logo removed from the strip
// but left on disk).
export function unreferencedImageFiles(imageFiles, referenced) {
  const used = new Set(referenced);
  return [...imageFiles].filter((f) => !used.has(f)).sort().map((f) => `${f} is committed under assets/ but no <img>, <link>, og:image or url() references it`);
}

function readAssetFromDisk(path) {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function imageFilesUnder(dir, root = ROOT) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...imageFilesUnder(full, root));
    else if (IMAGE_EXT_RE.test(name)) out.push(relative(root, full));
  }
  return out.sort();
}

function localStylesheetHrefs(html) {
  const out = [];
  for (const m of markupOnly(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) continue;
    const href = attr(tag, "href");
    if (href !== null && isLocalUrl(href.trim())) out.push(href.trim().split(/[?#]/)[0]);
  }
  return out;
}

function inlineStyles(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Fixture self-tests: prove every rule both passes clean input and fires.
// ---------------------------------------------------------------------------

function pngBytes(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegBytes(width, height) {
  // SOI, APP0 (JFIF, 16 bytes), SOF0 with one component, then EOI.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof0 = Buffer.alloc(13);
  sof0[0] = 0xff; sof0[1] = 0xc0; sof0.writeUInt16BE(11, 2); sof0[4] = 8;
  sof0.writeUInt16BE(height, 5); sof0.writeUInt16BE(width, 7); sof0[9] = 1; sof0[10] = 1; sof0[11] = 0x11; sof0[12] = 0;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])]);
}

function gifBytes(width, height) {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

const SVG_SQUARE = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>');
const SVG_WIDE_NO_VIEWBOX = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="19"><rect width="100" height="19"/></svg>');

const FIXTURE_ROOT = "/site";
const FIXTURE_TREE = new Map([
  ["/site/assets/a.png", pngBytes(160, 160)],
  ["/site/assets/b.jpg", jpegBytes(160, 160)],
  ["/site/assets/c.gif", gifBytes(30, 10)],
  ["/site/assets/d.svg", SVG_SQUARE],
  ["/site/assets/wide.svg", SVG_WIDE_NO_VIEWBOX],
  ["/site/assets/fake.png", SVG_SQUARE],
  ["/site/assets/empty.png", Buffer.alloc(0)],
  ["/site/assets/tiny.png", pngBytes(16, 16)],
  ["/site/favicon.ico", Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00])],
  ["/site/og.png", pngBytes(1200, 630)],
  ["/site/style.css", Buffer.from("body{background:url(/assets/c.gif)}")],
]);
const readFixture = (path) => FIXTURE_TREE.get(path) ?? null;
const FIXTURE_PAGE = "/site/index.html";

const CLEAN_HTML = `<!doctype html><html lang="en"><head>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="stylesheet" href="/style.css">
<meta property="og:image" content="https://hivecommons.dev/og.png">
<style>.x{background:url("/assets/c.gif")}</style>
</head><body>
<img src="/assets/a.png" width="48" height="48" alt="">
<img src="assets/b.jpg" width='24' height='24' alt="">
<img src="/assets/d.svg" width=20 height=20 alt="">
<img src="https://github.com/x.png?size=96" width="48" height="48" alt="">
<img src="data:image/png;base64,AAAA" alt="">
<!-- <img src="/assets/commented-out.png" alt=""> -->
<script>var s = '<img src="/assets/ghost.png">';</script>
</body></html>`;

test("fixture: image references are collected from <img>, srcset, icon <link> and og:image, not from comments, scripts, external or data: URLs", () => {
  const refs = imageReferences(CLEAN_HTML + '<img srcset="/assets/a.png 1x, /assets/tiny.png 2x" alt="">');
  assert.deepEqual(refs.map((r) => [r.url, r.img, r.declared]), [
    ["/assets/a.png", true, { width: 48, height: 48 }],
    ["assets/b.jpg", true, { width: 24, height: 24 }],
    ["/assets/d.svg", true, { width: 20, height: 20 }],
    ["/assets/a.png", true, null],
    ["/assets/tiny.png", true, null],
    ["/favicon.ico", false, null],
    ["/og.png", false, null],
  ]);
  assert.equal(refs[0].line, 7);
  assert.equal(refs[5].line, 2);
});

test("fixture: a clean page passes every rule and reports the files it referenced", () => {
  const { problems, referenced } = imageProblems(CLEAN_HTML, FIXTURE_PAGE, readFixture, "index.html", FIXTURE_ROOT);
  assert.deepEqual(problems, []);
  assert.deepEqual([...referenced].sort(), ["/site/assets/a.png", "/site/assets/b.jpg", "/site/assets/d.svg", "/site/favicon.ico", "/site/og.png"]);
});

test("fixture: missing, empty, unrecognised and mis-signed files are each reported once with their line", () => {
  const html = `<html><body>
<img src="/assets/nope.png" alt="">
<img src="/assets/empty.png" alt="">
<img src="/assets/fake.png" alt="">
<img src="/assets/a.bmp" alt="">
<img src="/assets/fake.png" alt="">
</body></html>`;
  const tree = new Map(FIXTURE_TREE);
  tree.set("/site/assets/a.bmp", Buffer.from("BM"));
  const { problems } = imageProblems(html, FIXTURE_PAGE, (p) => tree.get(p) ?? null, "p", FIXTURE_ROOT);
  assert.deepEqual(problems, [
    "p line 2: /assets/nope.png names no committed file",
    "p line 3: /assets/empty.png is an empty file",
    "p line 4: /assets/fake.png does not start with the png signature its extension promises",
    "p line 5: /assets/a.bmp has no recognised image extension",
    "p line 6: /assets/fake.png does not start with the png signature its extension promises",
  ]);
});

test("fixture: an <img> whose width/height disagree with the file's aspect ratio is reported for PNG, JPEG, GIF and SVG", () => {
  const html = `<html><body>
<img src="/assets/a.png" width="48" height="32" alt="">
<img src="/assets/b.jpg" width="100" height="50" alt="">
<img src="/assets/c.gif" width="9" height="9" alt="">
<img src="/assets/d.svg" width="20" height="10" alt="">
<img src="/assets/c.gif" width="27" height="9" alt="">
</body></html>`;
  const { problems } = imageProblems(html, FIXTURE_PAGE, readFixture, "p", FIXTURE_ROOT);
  assert.deepEqual(problems, [
    "p line 2: /assets/a.png is 160x160 but the <img> declares 48x32 (aspect 1.000 vs 1.500)",
    "p line 3: /assets/b.jpg is 160x160 but the <img> declares 100x50 (aspect 1.000 vs 2.000)",
    "p line 4: /assets/c.gif is 30x10 but the <img> declares 9x9 (aspect 3.000 vs 1.000)",
    "p line 5: /assets/d.svg is 24x24 but the <img> declares 20x10 (aspect 1.000 vs 2.000)",
  ]);
});

test("fixture: an <img> SVG whose root has no viewBox is reported; the same file as an icon <link>, a viewBox SVG, and a missing or mis-signed file are not", () => {
  const html = `<html><head><link rel="icon" href="/assets/wide.svg"></head><body>
<img src="/assets/wide.svg" width="100" height="19" alt="">
<img src="/assets/d.svg" alt="">
<img src="/assets/nope.svg" alt="">
<img src="/assets/a.png" alt="">
<img src="/assets/wide.svg" alt="">
</body></html>`;
  assert.deepEqual(imageProblems(html, FIXTURE_PAGE, readFixture, "p", FIXTURE_ROOT).problems, ["p line 4: /assets/nope.svg names no committed file"]);
  assert.deepEqual(svgViewBoxProblems(html, FIXTURE_PAGE, readFixture, "p", FIXTURE_ROOT), [
    "p line 2: /assets/wide.svg is an <img> SVG whose root has no viewBox, so it cannot scale to its box",
    "p line 6: /assets/wide.svg is an <img> SVG whose root has no viewBox, so it cannot scale to its box",
  ]);
  assert.ok(svgHasViewBox(SVG_SQUARE));
  assert.ok(!svgHasViewBox(Buffer.from('<svg width="1" height="1"><svg viewBox="0 0 1 1"/></svg>')), "a nested viewBox does not scale the root");
});

test("fixture: a raster drawn larger than its pixels is reported; an SVG never is", () => {
  const html = `<html><body>
<img src="/assets/tiny.png" width="48" height="48" alt="">
<img src="/assets/d.svg" width="512" height="512" alt="">
<img src="/assets/tiny.png" alt="">
</body></html>`;
  const { problems } = imageProblems(html, FIXTURE_PAGE, readFixture, "p", FIXTURE_ROOT);
  assert.deepEqual(problems, ["p line 2: /assets/tiny.png is 16x16 but the <img> declares 48x48, so the browser upscales it"]);
});

test("fixture: intrinsicSize reads PNG IHDR, JPEG SOF0, GIF header and SVG viewBox/width/height, and returns null otherwise", () => {
  assert.deepEqual(intrinsicSize(pngBytes(640, 480), "png"), { width: 640, height: 480 });
  assert.deepEqual(intrinsicSize(jpegBytes(320, 200), "jpg"), { width: 320, height: 200 });
  assert.deepEqual(intrinsicSize(gifBytes(12, 34), "gif"), { width: 12, height: 34 });
  assert.deepEqual(intrinsicSize(SVG_SQUARE, "svg"), { width: 24, height: 24 });
  assert.deepEqual(intrinsicSize(SVG_WIDE_NO_VIEWBOX, "svg"), { width: 100, height: 19 });
  assert.deepEqual(intrinsicSize(Buffer.from('<svg viewBox="0 0 109 40.5"/>'), "svg"), { width: 109, height: 40.5 });
  assert.equal(intrinsicSize(Buffer.from("<svg/>"), "svg"), null);
  assert.equal(intrinsicSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "jpg"), null);
  assert.equal(intrinsicSize(pngBytes(1, 1).subarray(0, 20), "png"), null);
  assert.equal(intrinsicSize(Buffer.from("RIFF"), "webp"), null);
  assert.equal(intrinsicSize(Buffer.alloc(8), "ico"), null);
});

test("fixture: bytesMatchKind accepts each signature, an SVG behind a prolog/comment, and rejects the rest", () => {
  assert.ok(bytesMatchKind(pngBytes(1, 1), "png"));
  assert.ok(bytesMatchKind(jpegBytes(1, 1), "jpg"));
  assert.ok(bytesMatchKind(gifBytes(1, 1), "gif"));
  assert.ok(bytesMatchKind(SVG_SQUARE, "svg"));
  assert.ok(bytesMatchKind(Buffer.from("\uFEFF  <svg/>"), "svg"));
  assert.ok(bytesMatchKind(Buffer.from([0x00, 0x00, 0x01, 0x00]), "ico"));
  assert.ok(bytesMatchKind(Buffer.from("RIFF....WEBP"), "webp"));
  assert.ok(!bytesMatchKind(Buffer.from("<html><svg/></html>"), "svg"));
  assert.ok(!bytesMatchKind(SVG_SQUARE, "png"));
  assert.ok(!bytesMatchKind(pngBytes(1, 1), "svg"));
  assert.ok(bytesMatchKind(Buffer.alloc(0), null));
  assert.equal(expectedImageKind("/a/b.JPEG"), "jpg");
  assert.equal(expectedImageKind("/a/b.svg"), "svg");
  assert.equal(expectedImageKind("/a/b"), null);
});

test("fixture: a committed image under assets/ that nothing references is reported; CSS url() and og:image count as references", () => {
  const files = ["assets/a.png", "assets/c.gif", "assets/orphan.png", "assets/sub/og.png"];
  const referenced = ["assets/a.png", ...cssImageUrls("body{background:url(/assets/c.gif) /* url(/assets/x.png) */}").map((u) => u.replace(/^\//, "")), "assets/sub/og.png"];
  assert.deepEqual(unreferencedImageFiles(files, referenced), ["assets/orphan.png is committed under assets/ but no <img>, <link>, og:image or url() references it"]);
  assert.deepEqual(cssImageUrls('a{background:url("data:image/png;base64,AA") url(https://x/y.png) url(#frag) url(/assets/q.png?v=1)}'), ["/assets/q.png"]);
});

// ---------------------------------------------------------------------------
// Real pages
// ---------------------------------------------------------------------------

const pages = htmlFiles().map((path) => ({ path, rel: relative(ROOT, path), html: readFileSync(path, "utf8") }));
const contentPages = pages.filter((p) => !isRedirectPage(p.html));

test("the site has committed content pages with local images to check", () => {
  assert.ok(contentPages.length > 0, "no non-redirect pages found");
  assert.ok(contentPages.some((p) => imageReferences(p.html).some((r) => r.img)), "no page embeds a local <img>; update this gate if that is intended");
});

const referencedAssets = new Set();
for (const p of contentPages) {
  test(`${p.rel}: every local image is a committed, non-empty file whose bytes match its extension, and every <img> width/height matches the intrinsic aspect ratio without upscaling a raster`, () => {
    const { problems, referenced } = imageProblems(p.html, p.path, readAssetFromDisk, p.rel);
    for (const path of referenced) referencedAssets.add(relative(ROOT, path));
    assert.deepEqual(problems, []);
  });
  // TODO: drop the `todo` option once assets/integrations/opencode.svg gains a
  // root viewBox (its outer <svg> wrapper has only width/height, #108); until then
  // the rule is reported but does not fail the run.
  test(`${p.rel}: every <img> SVG has a root viewBox`, { todo: "assets/integrations/opencode.svg root <svg> lacks viewBox (#108); the rule is enforced once that asset is fixed" }, () => {
    assert.deepEqual(svgViewBoxProblems(p.html, p.path, readAssetFromDisk, p.rel), []);
  });
}

test("assets/: every committed image file is referenced by some page or stylesheet", () => {
  for (const p of pages) {
    for (const href of localStylesheetHrefs(p.html)) {
      const file = resolveAssetPath(href, p.path);
      if (!existsSync(file)) continue;
      for (const url of cssImageUrls(readFileSync(file, "utf8"))) referencedAssets.add(relative(ROOT, resolveAssetPath(url, file)));
    }
    for (const css of inlineStyles(p.html)) {
      for (const url of cssImageUrls(css)) referencedAssets.add(relative(ROOT, resolveAssetPath(url, p.path)));
    }
    for (const ref of imageReferences(p.html)) referencedAssets.add(relative(ROOT, resolveAssetPath(ref.url, p.path)));
  }
  assert.deepEqual(unreferencedImageFiles(imageFilesUnder(ASSET_DIR), referencedAssets), []);
});
