#!/usr/bin/env node
// Gate for what a browser actually does with the shortcut-redirect pages.
//
// make-redirects.sh interpolates each MAP url and label into HTML verbatim:
// the refresh url=, the canonical href, the <a href>, the <title> and the link
// text. Nothing is escaped. check-redirects.sh proves the committed page is
// byte-identical to the generator's output, and check-links.sh curls the raw
// url text — neither asks what the HTML parser makes of it. A url that ends in
// "&para" or "&reg", a label with "&copy" in it, a "<" or a '"' anywhere, all
// regenerate cleanly and curl fine, and then redirect visitors somewhere else
// (or nowhere) because the parser decoded a character reference or closed the
// attribute early. Today's MAP already carries raw "&" separators, so the
// hazard is one MAP edit away.
//
// Rules, each with a fixture self-test (zero dependencies):
//   1. The MAP parses, every entry has a url and a label, and neither contains
//      a character that the unescaped template cannot carry ('"', '<', '>').
//   2. For every committed redirect page, the refresh url, canonical href and
//      <a href> decode (HTML attribute-value rules) to exactly the MAP url, and
//      the <title> and link text decode (text rules) to exactly the label.
//   3. No attribute or text node in a redirect page contains an ambiguous
//      ampersand: "&" followed by "#" or by a named reference that any
//      browser resolves. Escaped "&amp;" is the one accepted form.
// Usage: node --test scripts/redirect-targets.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const GENERATOR = join(ROOT, "make-redirects.sh");
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "scripts", ".linkcheck-work"]);

// The HTML Standard's named character references that browsers resolve even
// without a trailing ";" (the Latin-1 set plus AMP/COPY/GT/LT/QUOT/REG).
export const LEGACY_REFS = new Set(`
AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT
Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN
Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar
ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt
iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc
ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3
szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml
`.trim().split(/\s+/));

const FIVE = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", AMP: "&", LT: "<", GT: ">", QUOT: '"' };

// Decode character references the way the HTML tokenizer does for an attribute
// value (inAttribute=true) or a text node (inAttribute=false). Returns the
// decoded string plus the raw references that were consumed, so a caller can
// name exactly what the browser would rewrite. References outside the five
// predefined ones decode to U+FFFD: the test only needs to know that the
// browser would change the text, not what to.
export function decodeHtml(raw, { inAttribute }) {
  let out = "";
  const refs = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i] !== "&") {
      out += raw[i++];
      continue;
    }
    const rest = raw.slice(i);
    const numeric = /^&#(?:[xX][0-9a-fA-F]+|[0-9]+);?/.exec(rest);
    if (numeric) {
      refs.push(numeric[0]);
      out += "\uFFFD";
      i += numeric[0].length;
      continue;
    }
    const named = /^&([A-Za-z][A-Za-z0-9]*)(;?)/.exec(rest);
    if (named && named[2] === ";") {
      refs.push(named[0]);
      out += FIVE[named[1]] ?? "\uFFFD";
      i += named[0].length;
      continue;
    }
    if (named) {
      // No semicolon: only a legacy name matches, by longest prefix.
      let legacy = null;
      for (let len = named[1].length; len > 0; len--) {
        const cand = named[1].slice(0, len);
        if (LEGACY_REFS.has(cand)) { legacy = cand; break; }
      }
      if (legacy) {
        const next = named[1][legacy.length] ?? raw[i + 1 + legacy.length] ?? "";
        const quirk = inAttribute && (next === "=" || /^[A-Za-z0-9]$/.test(next));
        if (!quirk) {
          refs.push("&" + legacy);
          out += FIVE[legacy] ?? "\uFFFD";
          i += 1 + legacy.length;
          continue;
        }
      }
    }
    out += "&";
    i++;
  }
  return { value: out, refs };
}

// --- make-redirects.sh MAP ----------------------------------------------------

export function parseMap(script) {
  const entries = [];
  const problems = [];
  const block = /declare -A MAP=\(([\s\S]*?)^\)/m.exec(script);
  if (!block) return { entries, problems: ["make-redirects.sh has no `declare -A MAP=( ... )` block"] };
  for (const line of block[1].split("\n")) {
    const m = /^\s*\[([^\]]+)\]="(.*)"\s*$/.exec(line);
    if (!m) {
      if (line.trim()) problems.push(`unparseable MAP line: ${line.trim()}`);
      continue;
    }
    const [path, value] = [m[1], m[2]];
    const bar = value.indexOf("|");
    const url = bar === -1 ? value : value.slice(0, bar);
    const label = bar === -1 ? "" : value.slice(bar + 1);
    if (!/^https?:\/\/\S+$/.test(url)) problems.push(`MAP[${path}]: url "${url}" is not an absolute http(s) URL without whitespace`);
    if (!label.trim()) problems.push(`MAP[${path}]: missing label after "|"`);
    for (const [what, text] of [["url", url], ["label", label]]) {
      const bad = [...new Set(text.match(/["<>]/g) ?? [])];
      if (bad.length) problems.push(`MAP[${path}]: ${what} contains ${bad.map((c) => JSON.stringify(c)).join(", ")}, which the unescaped template cannot carry`);
      if (what === "label" && /&(?:#|[A-Za-z])/.test(text)) {
        const { refs } = decodeHtml(text, { inAttribute: false });
        if (refs.length) problems.push(`MAP[${path}]: label would be rewritten by the browser (${refs.join(", ")} decode in text)`);
      }
    }
    entries.push({ path, url, label });
  }
  return { entries, problems };
}

// --- committed redirect pages ------------------------------------------------

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

export function isRedirectPage(html) {
  return /<meta[^>]+http-equiv\s*=\s*["']refresh["']/i.test(html);
}

// Pull every place the page repeats the target or the label.
export function redirectParts(html) {
  const refreshTag = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => /http-equiv\s*=\s*["']refresh["']/i.test(t));
  const content = refreshTag ? attr(refreshTag, "content") : undefined;
  const refreshUrl = content === undefined ? undefined : (/^\s*\d+\s*;\s*url\s*=\s*(.*)$/i.exec(content)?.[1] ?? "");
  const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => /\brel\s*=\s*["']canonical["']/i.test(t));
  const canonical = canonicalTag ? attr(canonicalTag, "href") : undefined;
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(html);
  const anchorHref = anchor ? attr(anchor[1], "href") : undefined;
  const anchorText = anchor ? anchor[2] : undefined;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return { refreshUrl, canonical, anchorHref, anchorText, title };
}

export function redirectPageProblems(html, entry) {
  const problems = [];
  const parts = redirectParts(html);
  const attrChecks = [["refresh url=", parts.refreshUrl], ["canonical href", parts.canonical], ["<a href>", parts.anchorHref]];
  for (const [what, raw] of attrChecks) {
    if (raw === undefined) { problems.push(`${what} is missing`); continue; }
    const { value, refs } = decodeHtml(raw, { inAttribute: true });
    if (value !== entry.url) {
      const why = refs.length ? `browser decodes ${refs.join(", ")}` : "text differs";
      problems.push(`${what} resolves to "${value}", MAP says "${entry.url}" (${why})`);
    }
  }
  const textChecks = [["<title>", parts.title, `Hive Commons — ${entry.label}`], ["link text", parts.anchorText, entry.label]];
  for (const [what, raw, want] of textChecks) {
    if (raw === undefined) { problems.push(`${what} is missing`); continue; }
    const { value, refs } = decodeHtml(raw, { inAttribute: false });
    if (value !== want) {
      const why = refs.length ? `browser decodes ${refs.join(", ")}` : "text differs";
      problems.push(`${what} reads "${value}", expected "${want}" (${why})`);
    }
  }
  // Ambiguous ampersands anywhere on the page: "&" that is not "&amp;" yet
  // starts something a parser may consume as a character reference.
  for (const m of html.matchAll(/&(#(?:[xX][0-9a-fA-F]+|[0-9]+);?|[A-Za-z][A-Za-z0-9]*;?)/g)) {
    if (m[0] === "&amp;") continue;
    const name = m[1].replace(/;$/, "");
    const ambiguous = m[1].startsWith("#") || m[1].endsWith(";") || [...name].some((_, k) => LEGACY_REFS.has(name.slice(0, k + 1)));
    if (ambiguous) problems.push(`ambiguous ampersand "${m[0]}" at offset ${m.index}; write "&amp;" or change the MAP entry`);
  }
  return [...new Set(problems)];
}

export function committedRedirectPages(root = ROOT) {
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (SKIP_DIRS.has(name) || !statSync(dir).isDirectory()) continue;
    const file = join(dir, "index.html");
    if (existsSync(file) && isRedirectPage(readFileSync(file, "utf8"))) out.push(name);
  }
  return out.sort();
}

// --- fixtures ---------------------------------------------------------------

function page(url, label) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${url}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${url}"><title>Hive Commons — ${label}</title>
</head><body><p>Redirecting to <a href="${url}">${label}</a>…</p></body></html>
`;
}

const MAP_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
declare -A MAP=(
  [tv]="https://example.test/tv|the test channel"
  [cal]="https://example.test/c?a=1&b=2|the calendar"
)
for path in "\${!MAP[@]}"; do :; done
`;

test("fixture: decodeHtml follows attribute vs text rules for legacy references", () => {
  assert.deepEqual(decodeHtml("a=1&b=2", { inAttribute: true }), { value: "a=1&b=2", refs: [] });
  assert.deepEqual(decodeHtml("x&amp;y", { inAttribute: true }), { value: "x&y", refs: ["&amp;"] });
  assert.deepEqual(decodeHtml("x&amp;y", { inAttribute: false }), { value: "x&y", refs: ["&amp;"] });
  // Legacy name followed by "=" or alnum: left alone in attributes, decoded in text.
  assert.deepEqual(decodeHtml("?x=1&not=2", { inAttribute: true }), { value: "?x=1&not=2", refs: [] });
  assert.deepEqual(decodeHtml("?x=1&notify=2", { inAttribute: true }), { value: "?x=1&notify=2", refs: [] });
  assert.equal(decodeHtml("Q&notify", { inAttribute: false }).refs[0], "&not");
  // Legacy name at the end of the value or before punctuation decodes everywhere.
  assert.deepEqual(decodeHtml("?x=1&para", { inAttribute: true }).refs, ["&para"]);
  assert.deepEqual(decodeHtml("?x=1&reg/", { inAttribute: true }).refs, ["&reg"]);
  assert.deepEqual(decodeHtml("?x=1&copy&z", { inAttribute: true }).refs, ["&copy"]);
  // Semicolon-terminated and numeric references always decode.
  assert.deepEqual(decodeHtml("a&lt;b", { inAttribute: true }), { value: "a<b", refs: ["&lt;"] });
  assert.deepEqual(decodeHtml("a&hellip;b", { inAttribute: true }).refs, ["&hellip;"]);
  assert.deepEqual(decodeHtml("a&#38;b&#x26;c", { inAttribute: true }), { value: "a\uFFFDb\uFFFDc", refs: ["&#38;", "&#x26;"] });
  // Non-reference ampersands pass through, including trailing and "&&".
  assert.deepEqual(decodeHtml("a&&b&", { inAttribute: true }), { value: "a&&b&", refs: [] });
  assert.deepEqual(decodeHtml("&tmeid=1&tmsrc=2&scp=ALL", { inAttribute: true }).refs, []);
});

test("fixture: the MAP block parses into path/url/label entries", () => {
  const { entries, problems } = parseMap(MAP_SCRIPT);
  assert.deepEqual(problems, []);
  assert.deepEqual(entries, [
    { path: "tv", url: "https://example.test/tv", label: "the test channel" },
    { path: "cal", url: "https://example.test/c?a=1&b=2", label: "the calendar" },
  ]);
  assert.deepEqual(parseMap("echo no map").problems, ["make-redirects.sh has no `declare -A MAP=( ... )` block"]);
});

test("fixture: MAP entries with quotes, angle brackets, bad urls, missing labels or decodable labels are reported", () => {
  const bad = MAP_SCRIPT.replace(
    '  [cal]="https://example.test/c?a=1&b=2|the calendar"',
    [
      '  [q]="https://example.test/a?x=\\"1|the quote"',
      '  [lt]="https://example.test/b|<b>bold</b> label"',
      '  [rel]="/relative|a path"',
      '  [sp]="https://example.test/c d|spaced"',
      '  [nolabel]="https://example.test/e"',
      '  [ent]="https://example.test/f|R&copy by us"',
      "  garbage line",
    ].join("\n"),
  );
  const { problems } = parseMap(bad);
  assert.ok(problems.some((p) => p.startsWith("MAP[q]: url contains '\"'") || p.includes('MAP[q]: url contains "\\""')), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith("MAP[lt]: label contains")));
  assert.ok(problems.some((p) => p.startsWith("MAP[rel]: url")));
  assert.ok(problems.some((p) => p.startsWith("MAP[sp]: url")));
  assert.ok(problems.some((p) => p === "MAP[nolabel]: missing label after \"|\""));
  assert.ok(problems.some((p) => p.includes("MAP[ent]: label would be rewritten") && p.includes("&copy")));
  assert.ok(problems.some((p) => p === "unparseable MAP line: garbage line"));
});

test("fixture: a page whose attributes and text decode to the MAP entry passes, raw '&' separators included", () => {
  const entry = { path: "cal", url: "https://example.test/c?a=1&b=2&tmsrc=x", label: "the calendar" };
  assert.deepEqual(redirectPageProblems(page(entry.url, entry.label), entry), []);
  // The escaped form is equally acceptable.
  assert.deepEqual(redirectPageProblems(page(entry.url.replace(/&/g, "&amp;"), entry.label), entry), []);
});

test("fixture: a url ending in a legacy reference is reported on every attribute that carries it", () => {
  const entry = { path: "x", url: "https://example.test/c?a=1&para", label: "the page" };
  const problems = redirectPageProblems(page(entry.url, entry.label), entry);
  for (const what of ["refresh url=", "canonical href", "<a href>"]) {
    assert.ok(problems.some((p) => p.startsWith(what) && p.includes("browser decodes &para")), `${what}: ${problems.join("\n")}`);
  }
  assert.ok(problems.some((p) => p.startsWith('ambiguous ampersand "&para"')));
});

test("fixture: a label with a legacy reference is reported for the title and link text", () => {
  const entry = { path: "x", url: "https://example.test/c", label: "Q&notify" };
  const problems = redirectPageProblems(page(entry.url, entry.label), entry);
  assert.ok(problems.some((p) => p.startsWith("<title> reads") && p.includes("&not")));
  assert.ok(problems.some((p) => p.startsWith("link text reads") && p.includes("&not")));
});

test("fixture: a page that drifted from the MAP url, or lost a part, is reported", () => {
  const entry = { path: "x", url: "https://example.test/new", label: "the page" };
  const stale = redirectPageProblems(page("https://example.test/old", entry.label), entry);
  assert.equal(stale.filter((p) => p.includes("(text differs)")).length, 3);
  const noCanonical = page(entry.url, entry.label).replace(/<link rel="canonical"[^>]*>/, "");
  assert.ok(redirectPageProblems(noCanonical, entry).includes("canonical href is missing"));
  const noRefresh = page(entry.url, entry.label).replace(/<meta http-equiv="refresh"[^>]*>/, "");
  assert.ok(redirectPageProblems(noRefresh, entry).includes("refresh url= is missing"));
  const badContent = page(entry.url, entry.label).replace('content="0; url=', 'content="');
  assert.ok(redirectPageProblems(badContent, entry).some((p) => p.startsWith('refresh url= resolves to ""')));
});

test("fixture: numeric and semicolon-terminated references anywhere on the page are ambiguous ampersands", () => {
  const entry = { path: "x", url: "https://example.test/c", label: "the page" };
  const numeric = page(entry.url, entry.label).replace("Redirecting", "Redirecting&#8230;");
  assert.ok(redirectPageProblems(numeric, entry).some((p) => p.startsWith('ambiguous ampersand "&#8230;"')));
  const named = page(entry.url, entry.label).replace("Redirecting", "Redirecting&hellip;");
  assert.ok(redirectPageProblems(named, entry).some((p) => p.startsWith('ambiguous ampersand "&hellip;"')));
  const plain = page(entry.url + "?a=1&tmeid=2", entry.label);
  assert.ok(!redirectPageProblems(plain, { ...entry, url: entry.url + "?a=1&tmeid=2" }).some((p) => p.startsWith("ambiguous")));
});

// --- live checks over the committed tree ------------------------------------

const script = readFileSync(GENERATOR, "utf8");
const { entries, problems: mapProblems } = parseMap(script);

test("make-redirects.sh: the MAP parses and every url/label is safe to interpolate unescaped", () => {
  assert.deepEqual(mapProblems, []);
  assert.ok(entries.length > 0, "MAP has no entries");
});

test("make-redirects.sh: the template still interpolates url and label where this gate expects them", () => {
  assert.match(script, /content="0; url=\$url"/);
  assert.match(script, /<link rel="canonical" href="\$url"><title>Hive Commons — \$label<\/title>/);
  assert.match(script, /<a href="\$url">\$label<\/a>/);
});

test("every committed redirect page is in the MAP, and every MAP entry has a committed page", () => {
  assert.deepEqual(committedRedirectPages(), entries.map((e) => e.path).sort());
});

for (const entry of entries) {
  test(`${entry.path}/index.html: refresh, canonical and link resolve to the MAP url; title and link text to the label; no ambiguous ampersands`, () => {
    const file = join(ROOT, entry.path, "index.html");
    assert.ok(existsSync(file), `${entry.path}/index.html missing (run ./make-redirects.sh)`);
    assert.deepEqual(redirectPageProblems(readFileSync(file, "utf8"), entry), []);
  });
}
