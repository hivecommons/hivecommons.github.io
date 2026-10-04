#!/usr/bin/env node
// Static gate for the <head> metadata contract of every committed HTML page
// and for the site links in the Markdown/llms.txt documents. check-links.sh
// resolves href/src and redirect targets only, so an og:image pointing at a
// renamed file, a canonical that drifts from the page path, or a dead link in
// README.md would ship unnoticed. Each rule has a fixture self-test.
// Zero dependencies. Usage: node --test scripts/page-meta.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

function markdownFiles(dir = ROOT) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...markdownFiles(full));
    } else if (name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out.sort();
}

// --- head parsing -----------------------------------------------------------

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return out;
}

export function parseHead(html) {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const head = headMatch ? headMatch[1] : "";
  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1].trim());
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const meta = new Map(); // key -> [values]
  for (const m of metas) {
    const key = m.property ?? m.name ?? (m["http-equiv"] ? `http-equiv:${m["http-equiv"].toLowerCase()}` : m.charset !== undefined ? "charset" : null);
    if (!key) continue;
    const value = m.charset !== undefined && key === "charset" ? m.charset : (m.content ?? "");
    if (!meta.has(key)) meta.set(key, []);
    meta.get(key).push(value);
  }
  const canonical = links.filter((l) => (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical")).map((l) => l.href ?? "");
  const refresh = (meta.get("http-equiv:refresh") ?? []).map((c) => {
    const m = /url\s*=\s*([^;\s]+)/i.exec(c);
    return m ? m[1] : null;
  });
  return { hasHead: Boolean(headMatch), titles, meta, canonical, refresh };
}

export function isRedirectPage(html) {
  return /<meta[^>]+http-equiv\s*=\s*["']refresh["']/i.test(html);
}

function first(map, key) {
  const v = map.get(key);
  return v && v.length ? v[0] : undefined;
}

// Site path a committed page is served at: /index.html -> "/", /stories/index.html -> "/stories/".
export function servedPath(rel) {
  const parts = rel.split(sep);
  if (parts[parts.length - 1] === "index.html") parts.pop();
  const p = parts.join("/");
  return p ? `/${p}/` : "/";
}

export function siteUrlToFile(url, root = ROOT) {
  if (!url.startsWith(SITE_ORIGIN + "/") && url !== SITE_ORIGIN) return null;
  let path = url.slice(SITE_ORIGIN.length).replace(/[?#].*$/, "");
  path = path.replace(/^\/+/, "");
  const candidates = path === "" ? ["index.html"] : [path, join(path, "index.html"), `${path}.html`];
  for (const c of candidates) {
    const full = resolve(root, c);
    if (!full.startsWith(resolve(root))) continue;
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

export function pngDimensions(buf) {
  const sig = "89504e470d0a1a0a";
  if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== sig) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// --- rules ------------------------------------------------------------------

const REQUIRED_CANONICAL_META = [
  "description", "og:type", "og:site_name", "og:title", "og:description", "og:url", "og:image",
  "twitter:card", "twitter:title", "twitter:description", "twitter:image",
];

// Problems with a canonical (indexable) page's head, independent of the file system.
export function canonicalPageProblems(html, served) {
  const h = parseHead(html);
  const problems = [];
  if (!h.hasHead) return ["no <head> element"];
  if (h.titles.length !== 1) problems.push(`expected exactly one <title>, found ${h.titles.length}`);
  else if (!h.titles[0]) problems.push("<title> is empty");
  if ((first(h.meta, "charset") ?? "").toLowerCase() !== "utf-8") problems.push('missing <meta charset="utf-8">');
  if (!first(h.meta, "viewport")) problems.push('missing <meta name="viewport">');
  for (const key of REQUIRED_CANONICAL_META) {
    if (!(first(h.meta, key) ?? "").trim()) problems.push(`missing or empty <meta ${key}>`);
  }
  for (const [key, values] of h.meta) {
    if (values.length > 1 && key !== "http-equiv:refresh") problems.push(`<meta ${key}> declared ${values.length} times`);
  }
  if (h.canonical.length !== 1) problems.push(`expected exactly one <link rel="canonical">, found ${h.canonical.length}`);
  else {
    const expected = SITE_ORIGIN + served;
    if (h.canonical[0] !== expected) problems.push(`canonical is ${h.canonical[0]}, expected ${expected} for this page's path`);
    const ogUrl = first(h.meta, "og:url");
    if (ogUrl !== undefined && ogUrl !== h.canonical[0]) problems.push(`og:url (${ogUrl}) differs from canonical (${h.canonical[0]})`);
  }
  const pairs = [["og:title", "twitter:title"], ["og:description", "twitter:description"], ["og:image", "twitter:image"]];
  for (const [a, b] of pairs) {
    const va = first(h.meta, a);
    const vb = first(h.meta, b);
    if (va !== undefined && vb !== undefined && va !== vb) problems.push(`${a} and ${b} disagree`);
  }
  const ogTitle = first(h.meta, "og:title");
  if (ogTitle && h.titles[0] && !h.titles[0].includes(ogTitle) && !ogTitle.includes(h.titles[0])) {
    problems.push(`og:title "${ogTitle}" is unrelated to <title> "${h.titles[0]}"`);
  }
  const robots = first(h.meta, "robots") ?? "";
  if (/\bnoindex\b/i.test(robots)) problems.push("canonical page is marked noindex");
  const imageUrl = first(h.meta, "og:image");
  if (imageUrl && !imageUrl.startsWith(SITE_ORIGIN + "/")) problems.push(`og:image ${imageUrl} is not an absolute URL under ${SITE_ORIGIN}`);
  return problems;
}

// og:image must be a committed file; declared dimensions must match the PNG header.
export function ogImageProblems(html, root = ROOT) {
  const h = parseHead(html);
  const url = first(h.meta, "og:image");
  if (!url) return [];
  const file = siteUrlToFile(url, root);
  if (!file) return [`og:image ${url} does not resolve to a committed file`];
  const problems = [];
  const w = first(h.meta, "og:image:width");
  const hgt = first(h.meta, "og:image:height");
  if (w !== undefined || hgt !== undefined) {
    const dims = pngDimensions(readFileSync(file));
    if (!dims) problems.push(`og:image:width/height declared but ${relative(root, file)} is not a PNG whose header can be read`);
    else {
      if (w !== undefined && Number(w) !== dims.width) problems.push(`og:image:width is ${w} but ${relative(root, file)} is ${dims.width}px wide`);
      if (hgt !== undefined && Number(hgt) !== dims.height) problems.push(`og:image:height is ${hgt} but ${relative(root, file)} is ${dims.height}px tall`);
    }
  }
  return problems;
}

// Redirect shortcut pages: noindex, non-empty title, canonical == refresh target.
export function redirectPageProblems(html) {
  const h = parseHead(html);
  const problems = [];
  if (h.titles.length !== 1 || !h.titles[0]) problems.push("redirect page needs exactly one non-empty <title>");
  if (!/\bnoindex\b/i.test(first(h.meta, "robots") ?? "")) problems.push('redirect page lacks <meta name="robots" content="noindex">');
  const target = h.refresh.find((t) => t);
  if (!target) problems.push("refresh meta has no url=");
  if (h.canonical.length !== 1) problems.push(`expected exactly one <link rel="canonical">, found ${h.canonical.length}`);
  else if (target && h.canonical[0] !== target) problems.push(`canonical (${h.canonical[0]}) differs from refresh target (${target})`);
  return problems;
}

// Links in Markdown/llms.txt: relative targets must exist; site-origin URLs must map to a page.
export function docLinkProblems(text, fileAbs, root = ROOT) {
  const problems = [];
  const dir = dirname(fileAbs);
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/i.test(target)) continue;
    const full = resolve(dir, target.replace(/[?#].*$/, ""));
    if (!full.startsWith(resolve(root)) || !existsSync(full)) problems.push(`relative link ${target} does not exist`);
  }
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?hivecommons\.dev(\/[A-Za-z0-9._~\/-]*)?(?=$|[\s)\]>`"'.,;])/g)) {
    const url = SITE_ORIGIN + (m[1] ?? "/");
    if (!siteUrlToFile(url, root)) problems.push(`site link ${m[0]} does not resolve to a committed page`);
  }
  return problems;
}

// --- fixtures ---------------------------------------------------------------

const GOOD_HEAD = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Fixture — Hive Commons</title>
<meta name="description" content="A fixture page.">
<link rel="canonical" href="${SITE_ORIGIN}/fixture/">
<meta property="og:type" content="website"><meta property="og:site_name" content="Hive Commons">
<meta property="og:title" content="Fixture"><meta property="og:description" content="A fixture page.">
<meta property="og:url" content="${SITE_ORIGIN}/fixture/"><meta property="og:image" content="${SITE_ORIGIN}/og.png">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="Fixture">
<meta name="twitter:description" content="A fixture page."><meta name="twitter:image" content="${SITE_ORIGIN}/og.png">
</head><body></body></html>`;

test("fixture: a complete canonical head passes every rule", () => {
  assert.deepEqual(canonicalPageProblems(GOOD_HEAD, "/fixture/"), []);
});

test("fixture: canonical/og:url drift from the served path is reported", () => {
  const p = canonicalPageProblems(GOOD_HEAD, "/elsewhere/");
  assert.ok(p.some((x) => x.startsWith("canonical is")), p.join("\n"));
  const ogDrift = GOOD_HEAD.replace(`og:url" content="${SITE_ORIGIN}/fixture/"`, `og:url" content="${SITE_ORIGIN}/"`);
  assert.ok(canonicalPageProblems(ogDrift, "/fixture/").some((x) => x.startsWith("og:url")));
});

test("fixture: missing, empty and duplicated meta are reported", () => {
  const missing = GOOD_HEAD.replace(/<meta name="twitter:card"[^>]*>/, "");
  assert.ok(canonicalPageProblems(missing, "/fixture/").includes("missing or empty <meta twitter:card>"));
  const empty = GOOD_HEAD.replace('content="A fixture page.">\n<link', 'content="">\n<link');
  assert.ok(canonicalPageProblems(empty, "/fixture/").includes("missing or empty <meta description>"));
  const dup = GOOD_HEAD.replace("</head>", '<meta property="og:title" content="Again"></head>');
  assert.ok(canonicalPageProblems(dup, "/fixture/").includes("<meta og:title> declared 2 times"));
});

test("fixture: og/twitter disagreement, noindex, unrelated og:title and two <title>s are reported", () => {
  const disagree = GOOD_HEAD.replace('twitter:image" content="' + SITE_ORIGIN + '/og.png"', 'twitter:image" content="' + SITE_ORIGIN + '/other.png"');
  assert.ok(canonicalPageProblems(disagree, "/fixture/").includes("og:image and twitter:image disagree"));
  const noindex = GOOD_HEAD.replace("</head>", '<meta name="robots" content="noindex"></head>');
  assert.ok(canonicalPageProblems(noindex, "/fixture/").includes("canonical page is marked noindex"));
  const unrelated = GOOD_HEAD.replace("<title>Fixture — Hive Commons</title>", "<title>Something else</title>");
  assert.ok(canonicalPageProblems(unrelated, "/fixture/").some((x) => x.startsWith("og:title")));
  const twoTitles = GOOD_HEAD.replace("</head>", "<title>Two</title></head>");
  assert.ok(canonicalPageProblems(twoTitles, "/fixture/").includes("expected exactly one <title>, found 2"));
});

test("fixture: og:image resolves against the real tree and dimensions are checked from the PNG header", () => {
  assert.deepEqual(ogImageProblems(GOOD_HEAD), []);
  const gone = GOOD_HEAD.replace(/og\.png/g, "missing-social-card.png");
  assert.deepEqual(ogImageProblems(gone), [`og:image ${SITE_ORIGIN}/missing-social-card.png does not resolve to a committed file`]);
  const wrongDims = GOOD_HEAD.replace("</head>", '<meta property="og:image:width" content="1"><meta property="og:image:height" content="2"></head>');
  const p = ogImageProblems(wrongDims);
  assert.equal(p.length, 2, p.join("\n"));
  assert.match(p[0], /og:image:width is 1 but og\.png is \d+px wide/);
  assert.match(p[1], /og:image:height is 2 but og\.png is \d+px tall/);
  const notPng = GOOD_HEAD.replace(/og\.png/g, "favicon.ico").replace("</head>", '<meta property="og:image:width" content="1"></head>');
  assert.match(ogImageProblems(notPng)[0], /not a PNG/);
});

test("fixture: pngDimensions reads IHDR and rejects non-PNG bytes", () => {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(pngDimensions(png), { width: 640, height: 480 });
  assert.equal(pngDimensions(Buffer.from("not a png at all, really")), null);
});

const GOOD_REDIRECT = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=https://example.test/x">
<meta name="robots" content="noindex">
<link rel="canonical" href="https://example.test/x"><title>Redirect</title></head><body></body></html>`;

test("fixture: a well-formed redirect page passes; missing noindex or canonical drift is reported", () => {
  assert.ok(isRedirectPage(GOOD_REDIRECT) && !isRedirectPage(GOOD_HEAD));
  assert.deepEqual(redirectPageProblems(GOOD_REDIRECT), []);
  assert.ok(redirectPageProblems(GOOD_REDIRECT.replace(/<meta name="robots"[^>]*>/, "")).some((x) => x.includes("noindex")));
  assert.ok(redirectPageProblems(GOOD_REDIRECT.replace('href="https://example.test/x"', 'href="https://example.test/y"')).some((x) => x.startsWith("canonical (")));
  assert.ok(redirectPageProblems(GOOD_REDIRECT.replace("<title>Redirect</title>", "")).some((x) => x.includes("<title>")));
});

test("fixture: servedPath maps committed files to the path they are served at", () => {
  assert.equal(servedPath("index.html"), "/");
  assert.equal(servedPath(["stories", "index.html"].join(sep)), "/stories/");
  assert.equal(servedPath(["a", "b", "index.html"].join(sep)), "/a/b/");
});

test("fixture: siteUrlToFile resolves /, directories, bare files and rejects traversal/foreign hosts", () => {
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/"), join(ROOT, "index.html"));
  assert.equal(siteUrlToFile(SITE_ORIGIN), join(ROOT, "index.html"));
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/stories/"), join(ROOT, "stories", "index.html"));
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/og.png?v=2#x"), join(ROOT, "og.png"));
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/../scripts/page-meta.test.mjs"), null);
  assert.equal(siteUrlToFile("https://docs.hivecommons.dev/"), null);
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/definitely-not-a-page/"), null);
});

test("fixture: doc links — dead relative target and dead site URL are reported, externals and placeholders skipped", () => {
  const md = [
    "[ok](../README.md) [ext](https://github.com/x) [mail](mailto:a@b) [anchor](#top)",
    "[dead](../no-such-file.md)",
    `${SITE_ORIGIN}/ and ${SITE_ORIGIN}/stories/ are fine; ${SITE_ORIGIN}/nope/ is not.`,
    "`https://hivecommons.dev/<redirect>` is a placeholder, host-only `https://hivecommons.dev` is the home page",
  ].join("\n");
  const p = docLinkProblems(md, join(ROOT, "runbooks", "fixture.md"));
  assert.deepEqual(p, [
    "relative link ../no-such-file.md does not exist",
    `site link ${SITE_ORIGIN}/nope/ does not resolve to a committed page`,
  ]);
});

// --- live checks over the committed tree ------------------------------------

const pages = htmlFiles();
const canonicalPages = pages.filter((p) => !isRedirectPage(readFileSync(p, "utf8")));
const redirectPages = pages.filter((p) => isRedirectPage(readFileSync(p, "utf8")));

test("the site has both canonical and redirect pages to check", () => {
  assert.ok(canonicalPages.includes(join(ROOT, "index.html")));
  assert.ok(redirectPages.length > 0);
});

for (const page of canonicalPages) {
  const rel = relative(ROOT, page);
  const html = readFileSync(page, "utf8");
  test(`${rel}: head carries the title/description/canonical/Open Graph/Twitter contract`, () => {
    assert.deepEqual(canonicalPageProblems(html, servedPath(rel)), []);
  });
  test(`${rel}: og:image is a committed file and declared dimensions match the PNG`, () => {
    assert.deepEqual(ogImageProblems(html), []);
  });
}

for (const page of redirectPages) {
  const rel = relative(ROOT, page);
  const html = readFileSync(page, "utf8");
  test(`${rel}: redirect page is noindex and its canonical matches the refresh target`, () => {
    assert.deepEqual(redirectPageProblems(html), []);
  });
}

const docs = [...markdownFiles(), join(ROOT, "llms.txt")].filter((f) => existsSync(f));

test("Markdown and llms.txt documents exist to check", () => {
  assert.ok(docs.includes(join(ROOT, "README.md")));
  assert.ok(docs.includes(join(ROOT, "llms.txt")));
});

for (const doc of docs) {
  const rel = relative(ROOT, doc);
  test(`${rel}: relative links exist and hivecommons.dev links resolve to committed pages`, () => {
    assert.deepEqual(docLinkProblems(readFileSync(doc, "utf8"), doc), []);
  });
}
