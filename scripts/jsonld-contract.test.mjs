#!/usr/bin/env node
// Static gate keeping the JSON-LD on index.html in step with the page it
// describes. The <script type="application/ld+json"> block is what search
// engines and LLM crawlers read instead of the markup: the Organization's
// sponsor/funder list, the Hive SoftwareApplication's keywords and featureList
// and every URL in it are hand-copied from the infra-thanks logo row, the
// integration chips and the page's links. page-scripts.test.mjs only checks
// that the block parses and page-images.test.mjs only checks the logo file;
// llms-txt.test.mjs gates the *other* crawler summary (llms.txt) against the
// same chips but never looks at the JSON-LD, so a chip renamed on the page
// keeps being advertised under its old name here with nothing going red.
// Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/jsonld-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SITE_ORIGIN = "https://hivecommons.dev";

const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");

// --- index.html chip parsing (same shape as llms-txt.test.mjs, kept local so
// each gate stands alone) -----------------------------------------------------

function decode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns the markup of the <section> whose <h3 id="..."> heading is `headingId`.
export function sectionByHeading(html, headingId) {
  const h = html.indexOf(`id="${headingId}"`);
  if (h < 0) return null;
  const start = html.lastIndexOf("<section", h);
  const end = html.indexOf("</section>", h);
  if (start < 0 || end < 0) return null;
  return html.slice(start, end);
}

// Each chip name under a section.
export function chipNamesIn(sectionHtml) {
  const names = [];
  if (!sectionHtml) return names;
  for (const li of sectionHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
    const name = li[1].match(/<span class="integration-chip">([\s\S]*?)<\/span>/);
    if (name) names.push(decode(name[1]));
  }
  return names;
}

// "A, B, C and D." / "A, B, C, and D." / "A and B." / "A." -> ["A","B","C","D"]
export function splitProseList(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- extraction --------------------------------------------------------------

// Every <script type="application/ld+json"> body on the page, parsed. A block
// that does not parse is reported by page-scripts.test.mjs; here it is a
// hard failure too, so the live checks never pass vacuously on an empty list.
export function jsonLdBlocks(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    out.push(JSON.parse(m[1]));
  }
  return out;
}

// The page's one JSON-LD graph as a flat array of typed nodes.
export function jsonLdNodes(html) {
  const blocks = jsonLdBlocks(html);
  if (blocks.length !== 1) throw new Error(`expected exactly one application/ld+json block, found ${blocks.length}`);
  const graph = Array.isArray(blocks[0]) ? blocks[0] : [blocks[0]];
  for (const node of graph) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("JSON-LD graph entry is not an object");
    if (node["@context"] !== "https://schema.org") throw new Error(`JSON-LD node ${JSON.stringify(node["@type"])} lacks "@context": "https://schema.org"`);
    if (typeof node["@type"] !== "string" || !node["@type"]) throw new Error("JSON-LD node lacks a string @type");
  }
  return graph;
}

export function nodesOfType(nodes, type) {
  return nodes.filter((n) => n["@type"] === type);
}

// Every href="..." on the page, normalised so `https://a.dev` and
// `https://a.dev/` compare equal (crawlers treat them as the same resource).
export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return u;
  }
}

export function pageHrefs(html) {
  return new Set([...html.matchAll(/\bhref\s*=\s*"([^"]+)"/g)].map((m) => normalizeUrl(decodeAttr(m[1]))));
}

function decodeAttr(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// The page's visible text (tags and the raw-text script/style bodies dropped).
export function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

// Infra logo row as [{ label, href }] in page order. The JSON-LD names the
// sponsor without the parenthetical the label carries ("Akamai (Linode)" ->
// "Akamai"), so `name` is the label with any trailing "(…)" removed.
export function infraSponsors(html) {
  const out = [];
  for (const li of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
    const label = li[1].match(/<span class="infra-logo-label">([\s\S]*?)<\/span>/);
    if (!label) continue;
    const href = li[1].match(/<a\b[^>]*\bhref="([^"]+)"/);
    const full = label[1].replace(/\s+/g, " ").trim();
    out.push({ label: full, name: full.replace(/\s*\([^)]*\)\s*$/, ""), href: href ? decodeAttr(href[1]) : null });
  }
  return out;
}

// Every chip name on the page, classifier chips included (they are chips too).
export function allChipNames(html) {
  return ["agent-cli-title", "inference-title", "gateway-title"].flatMap((id) => chipNamesIn(sectionByHeading(html, id)));
}

export function splitKeywords(keywords) {
  if (Array.isArray(keywords)) return keywords.map((k) => String(k).trim()).filter(Boolean);
  return String(keywords ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

// Names enumerated by "… including A, B and C." fragments of a feature
// sentence; the trailing "more" of "A, B and more" is not a name. A sentence
// ends at a period followed by whitespace or the end, so "IBM watsonx.ai" is
// one name.
export function includingLists(sentence) {
  const out = [];
  for (const m of String(sentence).matchAll(/\bincluding\s+(.+?)(?:\.(?=\s|$)|$)/g)) {
    out.push(...splitProseList(m[1]).filter((n) => !/^more$/i.test(n)));
  }
  return out;
}

// Every URL-valued field a crawler would follow, with a path to report.
export function jsonLdLinks(nodes) {
  const out = [];
  nodes.forEach((node, i) => {
    const where = `${node["@type"]}#${i}`;
    for (const key of ["url", "codeRepository"]) {
      if (typeof node[key] === "string") out.push({ where: `${where}.${key}`, url: node[key] });
    }
    for (const [j, u] of (Array.isArray(node.sameAs) ? node.sameAs : []).entries()) out.push({ where: `${where}.sameAs[${j}]`, url: u });
    for (const key of ["sponsor", "funder"]) {
      for (const [j, org] of (Array.isArray(node[key]) ? node[key] : []).entries()) {
        if (org && typeof org.url === "string") out.push({ where: `${where}.${key}[${j}].url`, url: org.url });
      }
    }
  });
  return out;
}

// Keywords are matched against the page text case-insensitively; a plural of a
// visible term ("speks" for "spek") counts as shown.
export function keywordShown(keyword, text, chipSet) {
  if (chipSet.has(keyword)) return true;
  const lower = text.toLowerCase();
  const k = keyword.toLowerCase();
  return lower.includes(k) || (k.endsWith("s") && lower.includes(k.slice(0, -1)));
}

// --- rules -------------------------------------------------------------------

export function checkOrganization(nodes, html) {
  const problems = [];
  const orgs = nodesOfType(nodes, "Organization");
  if (orgs.length !== 1) return [`expected exactly one Organization node, found ${orgs.length}`];
  const org = orgs[0];
  if (normalizeUrl(org.url ?? "") !== normalizeUrl(`${SITE_ORIGIN}/`)) problems.push(`Organization.url is ${JSON.stringify(org.url)}, expected ${SITE_ORIGIN}/`);
  if (typeof org.logo !== "string" || !org.logo.startsWith(`${SITE_ORIGIN}/`)) problems.push(`Organization.logo must be an absolute ${SITE_ORIGIN}/… URL, got ${JSON.stringify(org.logo)}`);
  if (typeof org.name !== "string" || !visibleText(html).includes(org.name)) problems.push(`Organization.name ${JSON.stringify(org.name)} does not appear in the page text`);

  const sponsor = Array.isArray(org.sponsor) ? org.sponsor : [];
  const funder = Array.isArray(org.funder) ? org.funder : [];
  if (!sponsor.length) problems.push("Organization.sponsor is missing or empty");
  if (JSON.stringify(sponsor) !== JSON.stringify(funder)) problems.push("Organization.sponsor and Organization.funder differ — the page thanks one list of infrastructure providers; keep both fields identical");

  const page = infraSponsors(html);
  const pageByName = new Map(page.map((p) => [p.name, p]));
  const ldNames = sponsor.map((s) => s && s.name);
  for (const s of sponsor) {
    if (!s || s["@type"] !== "Organization" || typeof s.name !== "string" || typeof s.url !== "string") {
      problems.push(`Organization.sponsor entry ${JSON.stringify(s)} must be {"@type":"Organization","name":…,"url":…}`);
      continue;
    }
    const match = pageByName.get(s.name);
    if (!match) {
      problems.push(`Organization.sponsor names ${JSON.stringify(s.name)} but no .infra-logo-label on the page reads "${s.name}" or "${s.name} (…)" — rename or remove it in the JSON-LD`);
      continue;
    }
    if (normalizeUrl(s.url) !== normalizeUrl(match.href ?? "")) problems.push(`Organization.sponsor ${JSON.stringify(s.name)} links ${s.url} but the infra logo chip links ${match.href}`);
  }
  for (const p of page) {
    if (!ldNames.includes(p.name)) problems.push(`infra logo ${JSON.stringify(p.label)} is on the page but Organization.sponsor/funder does not name ${JSON.stringify(p.name)} — add it to the JSON-LD`);
  }
  if (new Set(ldNames).size !== ldNames.length) problems.push(`Organization.sponsor repeats a name: ${ldNames.join(", ")}`);
  return problems;
}

export function checkSoftwareApplications(nodes, html) {
  const problems = [];
  const apps = nodesOfType(nodes, "SoftwareApplication");
  if (!apps.length) return ["expected at least one SoftwareApplication node"];
  const text = visibleText(html);
  const chips = allChipNames(html);
  const chipSet = new Set(chips);

  const hive = apps.find((a) => a.name === "Hive");
  if (!hive) problems.push(`no SoftwareApplication named "Hive" (found ${apps.map((a) => JSON.stringify(a.name)).join(", ")})`);

  for (const app of apps) {
    const where = `SoftwareApplication ${JSON.stringify(app.name)}`;
    if (typeof app.name !== "string" || !text.includes(app.name)) problems.push(`${where}: name does not appear in the page text`);
    if (typeof app.license !== "string" || !/^https?:\/\//.test(app.license)) problems.push(`${where}: license must be a URL`);
    const features = Array.isArray(app.featureList) ? app.featureList : [];
    if (!features.length) problems.push(`${where}: featureList is missing or empty`);
    for (const f of features) {
      if (typeof f !== "string" || !f.trim()) {
        problems.push(`${where}: featureList entry ${JSON.stringify(f)} is not a non-empty string`);
        continue;
      }
      for (const name of includingLists(f)) {
        if (!chipSet.has(name)) problems.push(`${where}: featureList says "including … ${name} …" but no integration chip on the page is named ${JSON.stringify(name)} — update the sentence or the chips`);
      }
    }
    const keywords = splitKeywords(app.keywords);
    if (!keywords.length) problems.push(`${where}: keywords is missing or empty`);
    const dupes = keywords.filter((k, i) => keywords.indexOf(k) !== i);
    if (dupes.length) problems.push(`${where}: keywords repeats ${[...new Set(dupes)].map((d) => JSON.stringify(d)).join(", ")}`);
    for (const k of keywords) {
      if (!keywordShown(k, text, chipSet)) problems.push(`${where}: keyword ${JSON.stringify(k)} is neither an integration chip nor visible page text — a crawler is told about something the page does not show`);
    }
  }

  if (hive) {
    const keywords = new Set(splitKeywords(hive.keywords));
    for (const chip of chips) {
      if (!keywords.has(chip)) problems.push(`integration chip ${JSON.stringify(chip)} is on the page but missing from the Hive SoftwareApplication.keywords — add it`);
    }
  }
  return problems;
}

export function checkLinks(nodes, html) {
  const problems = [];
  const hrefs = pageHrefs(html);
  for (const { where, url } of jsonLdLinks(nodes)) {
    if (!/^https:\/\//.test(url)) {
      problems.push(`${where} = ${JSON.stringify(url)} is not an https URL`);
      continue;
    }
    if (!hrefs.has(normalizeUrl(url))) problems.push(`${where} = ${url} is not linked (href) anywhere on index.html — crawlers are sent somewhere the page itself never points`);
  }
  return problems;
}

// --- fixtures ----------------------------------------------------------------

function fixturePage({ ld, extraHtml = "" } = {}) {
  const chips = `
<section class="integration-group" aria-labelledby="agent-cli-title"><h3 id="agent-cli-title">Agent CLIs</h3>
<ul class="integration-list"><li><a href="https://alpha.dev"><span class="integration-chip">Alpha CLI</span><span>backend: alpha</span></a></li></ul></section>
<section class="integration-group" aria-labelledby="inference-title"><h3 id="inference-title">Inference engines</h3>
<ul class="integration-list"><li><a href="https://engine.dev"><span class="integration-chip">Engine</span><span>backend: engine</span></a></li></ul></section>
<section class="integration-group" aria-labelledby="gateway-title"><h3 id="gateway-title">Gateways</h3>
<ul class="integration-list"><li><a href="https://clf.dev"><span class="integration-chip">Clf</span><span>partner · classifier.backend: clf</span></a></li></ul></section>
<ul class="infra-logo-row">
  <li><a class="infra-logo-chip" href="https://host-one.example/"><span><span class="infra-logo-label">Host One (Cloud)</span><span class="infra-logo-note">n</span></span></a></li>
  <li><a class="infra-logo-chip" href="https://host-two.example/"><span><span class="infra-logo-label">Host Two</span><span class="infra-logo-note">n</span></span></a></li>
</ul>
<p>Acme Commons ships Widget and Gadget. Spoke by Partner Co.</p>
<a href="https://github.com/acme">GitHub</a> <a href="https://docs.acme.dev">Docs</a>
<a href="https://widget.acme.dev">Widget</a> <a href="https://github.com/acme/widget">Repo</a>`;
  const script = ld === undefined ? "" : `<script type="application/ld+json">${typeof ld === "string" ? ld : JSON.stringify(ld)}</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title><link rel="canonical" href="https://hivecommons.dev/">${script}</head><body>${chips}${extraHtml}<script>var s = 'Hidden Name';</script></body></html>`;
}

function goodLd() {
  const sponsors = [
    { "@type": "Organization", name: "Host One", url: "https://host-one.example/" },
    { "@type": "Organization", name: "Host Two", url: "https://host-two.example/" },
  ];
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Acme Commons",
      url: "https://hivecommons.dev/",
      logo: "https://hivecommons.dev/assets/logo.png",
      sameAs: ["https://github.com/acme", "https://docs.acme.dev/"],
      sponsor: sponsors,
      funder: JSON.parse(JSON.stringify(sponsors)),
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Widget",
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      codeRepository: "https://github.com/acme/widget",
      url: "https://widget.acme.dev/",
      keywords: "Alpha CLI, Engine, Clf, Partner Co",
      featureList: ["Drives agent CLIs including Alpha CLI and more.", "Routes inference including Engine.", "Supports Spoke by Partner Co."],
    },
  ];
}

function allProblems(html) {
  const nodes = jsonLdNodes(html);
  return [...checkOrganization(nodes, html), ...checkSoftwareApplications(nodes, html), ...checkLinks(nodes, html)];
}

test("fixture: a consistent page and JSON-LD pass every rule", () => {
  // The fixture's Widget is the "Hive" stand-in, so relax that one name.
  const ld = goodLd();
  ld[1].name = "Hive";
  const html = fixturePage({ ld, extraHtml: "<p>Hive</p>" });
  assert.deepEqual(allProblems(html), []);
});

test("fixture: zero or two JSON-LD blocks, a non-schema.org context or a bare node are reported, not skipped", () => {
  assert.throws(() => jsonLdNodes(fixturePage()), /exactly one application\/ld\+json block, found 0/);
  const two = fixturePage({ ld: goodLd() }).replace("</head>", `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing"}</script></head>`);
  assert.throws(() => jsonLdNodes(two), /found 2/);
  const ctx = goodLd();
  ctx[0]["@context"] = "http://schema.org";
  assert.throws(() => jsonLdNodes(fixturePage({ ld: ctx })), /lacks "@context": "https:\/\/schema\.org"/);
  assert.throws(() => jsonLdNodes(fixturePage({ ld: "[1]" })), /not an object/);
  assert.throws(() => jsonLdNodes(fixturePage({ ld: "{not json" })), SyntaxError);
  assert.equal(jsonLdNodes(fixturePage({ ld: goodLd()[0] })).length, 1, "a single object is accepted as a one-node graph");
});

test("fixture: an infra logo missing from sponsor, a sponsor without a logo, and a sponsor URL that disagrees with the chip are reported", () => {
  const dropped = goodLd();
  dropped[0].sponsor.pop();
  dropped[0].funder.pop();
  assert.match(checkOrganization(dropped, fixturePage({ ld: dropped })).join("\n"), /infra logo "Host Two" is on the page but Organization\.sponsor\/funder does not name "Host Two"/);

  const ghost = goodLd();
  ghost[0].sponsor.push({ "@type": "Organization", name: "Host Nine", url: "https://nine.example/" });
  ghost[0].funder = JSON.parse(JSON.stringify(ghost[0].sponsor));
  assert.match(checkOrganization(ghost, fixturePage({ ld: ghost })).join("\n"), /sponsor names "Host Nine" but no \.infra-logo-label/);

  const wrongUrl = goodLd();
  wrongUrl[0].sponsor[0].url = "https://elsewhere.example/";
  wrongUrl[0].funder[0].url = "https://elsewhere.example/";
  assert.match(checkOrganization(wrongUrl, fixturePage({ ld: wrongUrl })).join("\n"), /"Host One" links https:\/\/elsewhere\.example\/ but the infra logo chip links https:\/\/host-one\.example\//);
});

test("fixture: sponsor/funder drift, a malformed sponsor, a repeated sponsor and a wrong Organization url/logo/name are reported", () => {
  const drift = goodLd();
  drift[0].funder = drift[0].funder.slice(0, 1);
  assert.match(checkOrganization(drift, fixturePage({ ld: drift })).join("\n"), /sponsor and Organization\.funder differ/);

  const malformed = goodLd();
  malformed[0].sponsor[0] = { name: "Host One" };
  malformed[0].funder[0] = { name: "Host One" };
  assert.match(checkOrganization(malformed, fixturePage({ ld: malformed })).join("\n"), /must be \{"@type":"Organization","name":…,"url":…\}/);

  const repeated = goodLd();
  repeated[0].sponsor.push(repeated[0].sponsor[0]);
  repeated[0].funder.push(repeated[0].funder[0]);
  assert.match(checkOrganization(repeated, fixturePage({ ld: repeated })).join("\n"), /repeats a name/);

  const ident = goodLd();
  ident[0].url = "https://hivecommons.github.io/";
  ident[0].logo = "/assets/logo.png";
  ident[0].name = "Nobody Commons";
  const out = checkOrganization(ident, fixturePage({ ld: ident })).join("\n");
  assert.match(out, /Organization\.url is "https:\/\/hivecommons\.github\.io\/"/);
  assert.match(out, /Organization\.logo must be an absolute/);
  assert.match(out, /Organization\.name "Nobody Commons" does not appear/);

  const none = goodLd().slice(1);
  assert.deepEqual(checkOrganization(none, fixturePage({ ld: none })), ["expected exactly one Organization node, found 0"]);
});

test("fixture: a chip missing from Hive's keywords, a keyword the page never shows, a duplicate keyword and a renamed chip in featureList are reported", () => {
  const base = goodLd();
  base[1].name = "Hive";
  const page = (ld) => fixturePage({ ld, extraHtml: "<p>Hive</p>" });

  const missing = JSON.parse(JSON.stringify(base));
  missing[1].keywords = "Alpha CLI, Engine";
  assert.match(checkSoftwareApplications(missing, page(missing)).join("\n"), /chip "Clf" is on the page but missing from the Hive SoftwareApplication\.keywords/);

  const ghost = JSON.parse(JSON.stringify(base));
  ghost[1].keywords += ", Hidden Name";
  assert.match(checkSoftwareApplications(ghost, page(ghost)).join("\n"), /keyword "Hidden Name" is neither an integration chip nor visible page text/);

  const dupe = JSON.parse(JSON.stringify(base));
  dupe[1].keywords += ", Engine";
  assert.match(checkSoftwareApplications(dupe, page(dupe)).join("\n"), /keywords repeats "Engine"/);

  const renamed = JSON.parse(JSON.stringify(base));
  renamed[1].featureList[0] = "Drives agent CLIs including Alpha, Beta CLI and more.";
  const out = checkSoftwareApplications(renamed, page(renamed)).join("\n");
  assert.match(out, /including … Alpha …/);
  assert.match(out, /including … Beta CLI …/);
  assert.doesNotMatch(out, /including … more/);

  const arrayKw = JSON.parse(JSON.stringify(base));
  arrayKw[1].keywords = ["Alpha CLI", "Engine", "Clf"];
  assert.deepEqual(checkSoftwareApplications(arrayKw, page(arrayKw)), [], "array-valued keywords are accepted");

  const lenient = JSON.parse(JSON.stringify(base));
  lenient[1].keywords += ", widgets, ACME COMMONS";
  assert.deepEqual(checkSoftwareApplications(lenient, page(lenient)), [], "a plural or differently-cased form of visible text counts as shown");
});

test("fixture: no SoftwareApplication, no Hive entry, an unlisted name, a non-URL license and an empty featureList are reported", () => {
  const onlyOrg = goodLd().slice(0, 1);
  assert.deepEqual(checkSoftwareApplications(onlyOrg, fixturePage({ ld: onlyOrg })), ["expected at least one SoftwareApplication node"]);

  const noHive = goodLd();
  const out = checkSoftwareApplications(noHive, fixturePage({ ld: noHive })).join("\n");
  assert.match(out, /no SoftwareApplication named "Hive" \(found "Widget"\)/);

  const bad = goodLd();
  bad[1].name = "Hive";
  bad[1].license = "Apache-2.0";
  bad[1].featureList = [];
  const out2 = checkSoftwareApplications(bad, fixturePage({ ld: bad })).join("\n");
  assert.match(out2, /name does not appear in the page text/);
  assert.match(out2, /license must be a URL/);
  assert.match(out2, /featureList is missing or empty/);
});

test("fixture: a JSON-LD URL the page never links, a non-https URL, and trailing-slash-only differences", () => {
  const good = goodLd();
  good[1].name = "Hive";
  assert.deepEqual(checkLinks(good, fixturePage({ ld: good, extraHtml: "<p>Hive</p>" })), [], "https://docs.acme.dev/ matches href=\"https://docs.acme.dev\"");

  const stray = goodLd();
  stray[0].sameAs.push("https://x.example/nowhere");
  assert.match(checkLinks(stray, fixturePage({ ld: stray })).join("\n"), /Organization#0\.sameAs\[2\] = https:\/\/x\.example\/nowhere is not linked/);

  const http = goodLd();
  http[1].codeRepository = "http://github.com/acme/widget";
  assert.match(checkLinks(http, fixturePage({ ld: http })).join("\n"), /SoftwareApplication#1\.codeRepository = "http:\/\/github\.com\/acme\/widget" is not an https URL/);

  const sponsorUrl = goodLd();
  sponsorUrl[0].sponsor[1].url = "https://host-three.example/";
  sponsorUrl[0].funder[1].url = "https://host-three.example/";
  assert.match(checkLinks(sponsorUrl, fixturePage({ ld: sponsorUrl })).join("\n"), /Organization#0\.sponsor\[1\]\.url = https:\/\/host-three\.example\/ is not linked/);
});

test("fixture: helpers — includingLists, splitKeywords, infraSponsors, normalizeUrl, visibleText, chip parsing", () => {
  assert.deepEqual(allChipNames(fixturePage({ ld: goodLd() })), ["Alpha CLI", "Engine", "Clf"], "classifier chips are chips too");
  assert.deepEqual(chipNamesIn(null), []);
  assert.deepEqual(chipNamesIn('<li><span class="integration-chip">A &amp; B</span></li>'), ["A & B"]);
  assert.equal(sectionByHeading("<p>x</p>", "nope-title"), null);
  assert.deepEqual(splitProseList("A, B, C, and D"), ["A", "B", "C", "D"]);
  assert.deepEqual(includingLists("Drives CLIs including A, B CLI and more. Routes including C."), ["A", "B CLI", "C"]);
  assert.deepEqual(includingLists("Routes inference including vLLM, IBM watsonx.ai and OpenAI."), ["vLLM", "IBM watsonx.ai", "OpenAI"], "a dotted product name is not a sentence end");
  assert.deepEqual(includingLists("Nothing enumerated here."), []);
  assert.deepEqual(splitKeywords(" a , b,, c "), ["a", "b", "c"]);
  assert.deepEqual(splitKeywords(undefined), []);
  assert.deepEqual(infraSponsors(fixturePage({ ld: goodLd() })), [
    { label: "Host One (Cloud)", name: "Host One", href: "https://host-one.example/" },
    { label: "Host Two", name: "Host Two", href: "https://host-two.example/" },
  ]);
  assert.equal(normalizeUrl("https://a.dev"), normalizeUrl("https://a.dev/"));
  assert.equal(normalizeUrl("https://a.dev/x/#frag"), normalizeUrl("https://a.dev/x"));
  assert.notEqual(normalizeUrl("https://a.dev/x"), normalizeUrl("https://a.dev/y"));
  const text = visibleText(fixturePage({ ld: goodLd() }));
  assert.ok(text.includes("Acme Commons"));
  assert.ok(!text.includes("Hidden Name"), "script bodies are not visible text");
  assert.ok(!text.includes("Host One\",\"url\""), "the JSON-LD body is not visible text");
});

// --- live checks -------------------------------------------------------------

const NODES = jsonLdNodes(INDEX_HTML);

test("index.html carries one schema.org JSON-LD graph with an Organization and at least one SoftwareApplication", () => {
  assert.equal(nodesOfType(NODES, "Organization").length, 1);
  assert.ok(nodesOfType(NODES, "SoftwareApplication").length >= 1);
  assert.ok(allChipNames(INDEX_HTML).length > 0, "no integration chips found — the gate's selectors no longer match index.html");
  assert.ok(infraSponsors(INDEX_HTML).length > 0, "no infra logo chips found — the gate's selectors no longer match index.html");
});

test("JSON-LD Organization sponsor/funder match the infra-thanks logo row (names and links) on index.html", () => {
  assert.deepEqual(checkOrganization(NODES, INDEX_HTML), []);
});

test("JSON-LD SoftwareApplication keywords and featureList match the integration chips on index.html", () => {
  assert.deepEqual(checkSoftwareApplications(NODES, INDEX_HTML), []);
});

test("every URL in the JSON-LD is https and linked somewhere on index.html", () => {
  assert.deepEqual(checkLinks(NODES, INDEX_HTML), []);
});
