#!/usr/bin/env node
// Static gate keeping llms.txt in step with index.html. llms.txt is the
// machine-readable summary LLM crawlers read instead of the page, and its
// prose enumerates the supported agent CLIs, inference engines/gateways and
// the infrastructure sponsors by name. Those lists are hand-copied from the
// integration chips and the infra-thanks logo row on index.html; nothing else
// notices when a chip is added, renamed or dropped while the summary keeps
// advertising the old list. page-meta.test.mjs only checks the links inside
// llms.txt. Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/llms-txt.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const LLMS_TXT = readFileSync(join(ROOT, "llms.txt"), "utf8");

// --- llms.txt parsing --------------------------------------------------------

// "A, B, C and D." / "A, B, C, and D." / "A and B." / "A." -> ["A","B","C","D"]
export function splitProseList(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const SENTENCES = {
  agentClis: /^Hive supports agent CLIs including (.+?)\.\s*$/m,
  inference: /^Hive supports inference engines and gateways including (.+?)\.\s*$/m,
  infra: /^Thanks to (.+?) for powering Hive Commons\.\s*$/m,
};

export function parseLlmsTxt(text) {
  const out = {};
  for (const [key, re] of Object.entries(SENTENCES)) {
    const m = text.match(re);
    out[key] = m ? splitProseList(m[1]) : null;
  }
  return out;
}

// --- index.html parsing ------------------------------------------------------

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

// Each chip as { name, note } where note is the trailing description span.
export function chipsIn(sectionHtml) {
  const chips = [];
  if (!sectionHtml) return chips;
  for (const li of sectionHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
    const name = li[1].match(/<span class="integration-chip">([\s\S]*?)<\/span>/);
    if (!name) continue;
    const spans = [...li[1].matchAll(/<span(?:\s[^>]*)?>([\s\S]*?)<\/span>/g)]
      .map((m) => m[1])
      .filter((s) => !/^<img\b/.test(s.trim()));
    chips.push({ name: decode(name[1]), note: decode(spans[spans.length - 1] ?? "") });
  }
  return chips;
}

export function infraLabels(html) {
  return [...html.matchAll(/<span class="infra-logo-label">([\s\S]*?)<\/span>/g)].map((m) => decode(m[1]));
}

// llms.txt's second sentence covers engines and gateways/providers only; chips
// whose note marks them as a classifier (TypeSafe's Jev) are neither.
export function inferenceChipNames(html) {
  return [...chipsIn(sectionByHeading(html, "inference-title")), ...chipsIn(sectionByHeading(html, "gateway-title"))]
    .filter((c) => !/\bclassifier\b/i.test(c.note))
    .map((c) => c.name);
}

export function agentCliChipNames(html) {
  return chipsIn(sectionByHeading(html, "agent-cli-title")).map((c) => c.name);
}

// --- project list -------------------------------------------------------------

// llms.txt "## Projects" bullets: "- [Name](url): blurb" -> "Name". Names drop
// a trailing parenthetical alias ("Spektacular (Spek)" -> "Spektacular") so they
// compare against the card <h3>. Links are not compared: llms.txt may point at a
// project's own site where the card points at its repo. Returns null when the
// section is absent.
export function parseLlmsProjects(text) {
  const m = text.match(/^## Projects\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  if (!m) return null;
  return [...m[1].matchAll(/^- \[([^\]]+)\]\([^)]+\)/gm)].map((b) => decode(b[1]).replace(/\s*\([^)]*\)\s*$/, ""));
}

// Project carousel card names on index.html: each card's <h3> text without its
// <span class="tag"> badge, in carousel order. Anchor cards and div cards
// (buttons inside) are both read; slides without an <h3> are not projects.
export function projectCards(html) {
  const section = sectionByHeading(html, "projects") ?? html;
  const cards = [];
  for (const li of section.matchAll(/<li class="slide" data-slide>([\s\S]*?)<\/li>/g)) {
    const h3 = li[1].match(/<h3>([\s\S]*?)<\/h3>/);
    if (!h3) continue;
    cards.push(decode(h3[1].replace(/<span\b[^>]*>[\s\S]*?<\/span>/g, "")));
  }
  return cards;
}

// --- version gates -----------------------------------------------------------

// Extract the Crux version tag from the project carousel: "<h3>Crux ... <span...>vX.Y.Z</span></h3>"
export function cruxVersionFromHtml(html) {
  const m = html.match(/<h3>Crux\s*<span[^>]*>([^<]*)<\/span><\/h3>/);
  return m ? m[1] : null;
}

// Extract the Crux version from llms.txt: "First release vX.Y.Z" or "Latest release vX.Y.Z"
export function cruxVersionFromLlms(text) {
  const m = text.match(/\[Crux\].*?(?:First|Latest) release (v\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function setDiff(a, b) {
  const sb = new Set(b);
  return a.filter((x) => !sb.has(x));
}

function assertSameSet(pageNames, llmsNames, what) {
  assert.deepEqual(
    setDiff(pageNames, llmsNames),
    [],
    `${what}: on index.html but missing from llms.txt — add them to the llms.txt sentence`,
  );
  assert.deepEqual(
    setDiff(llmsNames, pageNames),
    [],
    `${what}: named in llms.txt but no matching index.html chip/label — remove or rename them in llms.txt`,
  );
}

// --- fixture self-tests ------------------------------------------------------

test("splitProseList handles Oxford and non-Oxford lists, 'and', and single items", () => {
  assert.deepEqual(splitProseList("A, B, C and D"), ["A", "B", "C", "D"]);
  assert.deepEqual(splitProseList("A, B, C, and D"), ["A", "B", "C", "D"]);
  assert.deepEqual(splitProseList("A and B"), ["A", "B"]);
  assert.deepEqual(splitProseList("Only One"), ["Only One"]);
  assert.deepEqual(splitProseList("Oh My Pi, IBM watsonx.ai and\n  Akamai (Linode)"), ["Oh My Pi", "IBM watsonx.ai", "Akamai (Linode)"]);
});

test("parseLlmsTxt extracts the three enumerating sentences and reports absent ones as null", () => {
  const txt = [
    "# X",
    "Hive supports agent CLIs including Foo CLI, Bar and Baz.",
    "Hive supports inference engines and gateways including vLLM and OpenAI.",
    "Thanks to Alpha, Beta and Gamma for powering Hive Commons.",
  ].join("\n\n");
  assert.deepEqual(parseLlmsTxt(txt), {
    agentClis: ["Foo CLI", "Bar", "Baz"],
    inference: ["vLLM", "OpenAI"],
    infra: ["Alpha", "Beta", "Gamma"],
  });
  assert.deepEqual(parseLlmsTxt("# X\n\nNo lists here.").agentClis, null);
});

const FIXTURE_HTML = `
<section class="integration-group" aria-labelledby="agent-cli-title">
  <h3 id="agent-cli-title">Agent CLIs</h3>
  <ul class="integration-list">
    <li><a href="#"><span class="integration-logo"><img src="/a.svg" alt="A"></span><span class="integration-chip">Alpha &amp; Co</span><span>Vendor · backend: alpha</span></a></li>
    <li><a href="#"><span class="integration-chip">Beta</span><span>backend: beta</span></a></li>
  </ul>
</section>
<section class="integration-group" aria-labelledby="inference-title">
  <h3 id="inference-title">Inference engines</h3>
  <ul class="integration-list"><li><a href="#"><span class="integration-chip">Engine</span><span>backend: engine</span></a></li></ul>
</section>
<section class="integration-group" aria-labelledby="gateway-title">
  <h3 id="gateway-title">Model gateways and providers</h3>
  <ul class="integration-list">
    <li><a href="#"><span class="integration-chip">Gateway</span><span>backend: gw</span></a></li>
    <li><a href="#"><span class="integration-chip">Clf</span><span>partner · classifier.backend: clf</span></a></li>
  </ul>
</section>
<ul class="infra-logo-row">
  <li><span><span class="infra-logo-label">Host One</span><span class="infra-logo-note">n</span></span></li>
  <li><span><span class="infra-logo-label">Host Two</span><span class="infra-logo-note">n</span></span></li>
</ul>`;

test("chipsIn reads chip name and trailing note, decoding entities and skipping the logo span", () => {
  assert.deepEqual(chipsIn(sectionByHeading(FIXTURE_HTML, "agent-cli-title")), [
    { name: "Alpha & Co", note: "Vendor · backend: alpha" },
    { name: "Beta", note: "backend: beta" },
  ]);
  assert.equal(sectionByHeading(FIXTURE_HTML, "nope-title"), null);
  assert.deepEqual(chipsIn(null), []);
});

test("inferenceChipNames unions engines and gateways but drops classifier chips", () => {
  assert.deepEqual(inferenceChipNames(FIXTURE_HTML), ["Engine", "Gateway"]);
});

test("infraLabels reads every infra-logo-label", () => {
  assert.deepEqual(infraLabels(FIXTURE_HTML), ["Host One", "Host Two"]);
});

test("assertSameSet flags drift in either direction with an actionable message", () => {
  assert.throws(() => assertSameSet(["A", "B"], ["A"], "x"), /missing from llms\.txt/);
  assert.throws(() => assertSameSet(["A"], ["A", "Z"], "x"), /no matching index\.html/);
  assert.doesNotThrow(() => assertSameSet(["B", "A"], ["A", "B"], "x"));
});

const FIXTURE_PROJECTS_HTML = `
<section class="band band-alt" id="projects">
  <h2>The project family</h2>
  <ul class="track" data-car-track>
    <li class="slide" data-slide>
      <div class="card">
        <h3>Alpha <span class="tag">flagship</span></h3>
        <div class="card-actions">
          <a class="btn btn-primary btn-sm" href="https://alpha.example/start">Start →</a>
          <a class="card-link" href="https://github.com/x/alpha">Source</a>
        </div>
      </div>
    </li>
    <li class="slide" data-slide>
      <a class="card" href="https://beta.example">
        <h3>Beta <span class="tag tag-new">B for short</span></h3>
        <span class="card-link">beta.example</span>
      </a>
    </li>
    <li class="slide" data-slide><div class="card"><p>no heading, not a project</p></div></li>
  </ul>
</section>
<ul><li class="slide" data-slide><a class="card" href="https://other.example"><h3>Other carousel</h3></a></li></ul>`;

test("parseLlmsProjects reads one name per bullet, strips the alias, stops at the next heading and reports a missing section as null", () => {
  const txt = [
    "# X",
    "## Projects",
    "",
    "- [Alpha](https://github.com/x/alpha): blurb. Docs: https://alpha.example",
    "- [Beta (B)](https://beta.example): blurb (with parens) inside.",
    "",
    "## Next section",
    "",
    "- [Not a project](https://nope.example)",
  ].join("\n");
  assert.deepEqual(parseLlmsProjects(txt), ["Alpha", "Beta"]);
  assert.equal(parseLlmsProjects("# X\n\nNo projects."), null);
  assert.deepEqual(parseLlmsProjects("## Projects\n\n- [Last](https://last.example): at EOF"), ["Last"]);
});

test("projectCards reads each carousel card's badge-free name from anchor and div cards alike, skipping heading-less slides and other carousels", () => {
  assert.deepEqual(projectCards(FIXTURE_PROJECTS_HTML), ["Alpha", "Beta"]);
  // Without a #projects section the whole document is scanned.
  assert.deepEqual(projectCards('<li class="slide" data-slide><a class="card" href="/u"><h3>Solo</h3></a></li>'), ["Solo"]);
  assert.deepEqual(projectCards("<p>nothing</p>"), []);
});

test("fixture: cruxVersionFromHtml extracts version from Crux carousel tag or returns null when absent", () => {
  assert.equal(cruxVersionFromHtml('<h3>Crux <span class="tag tag-new">v0.2.0</span></h3>'), "v0.2.0");
  assert.equal(cruxVersionFromHtml('<h3>Crux <span class="tag">v1.0.0</span></h3>'), "v1.0.0");
  assert.equal(cruxVersionFromHtml("<h3>Other <span>v1.0.0</span></h3>"), null);
  assert.equal(cruxVersionFromHtml("<h3>Crux</h3>"), null);
  assert.equal(cruxVersionFromHtml(""), null);
});

test("fixture: cruxVersionFromLlms extracts version from llms.txt or returns null when absent", () => {
  assert.equal(cruxVersionFromLlms("- [Crux](https://github.com/hivecommons/crux): ... Latest release v0.2.0 (early software)."), "v0.2.0");
  assert.equal(cruxVersionFromLlms("- [Crux](https://github.com/hivecommons/crux): ... First release v0.1.0 (early software)."), "v0.1.0");
  assert.equal(cruxVersionFromLlms("- [Other](https://github.com/hivecommons/other): ... Latest release v1.0.0."), null);
  assert.equal(cruxVersionFromLlms("- [Crux](https://github.com/hivecommons/crux): ... No version here."), null);
  assert.equal(cruxVersionFromLlms(""), null);
});

// --- live checks -------------------------------------------------------------

const live = parseLlmsTxt(LLMS_TXT);

test("llms.txt still carries the three enumerating sentences the gate relies on", () => {
  for (const [key, names] of Object.entries(live)) {
    assert.ok(names, `llms.txt lost the "${key}" sentence (pattern ${SENTENCES[key]}) — restore it or update this gate`);
    assert.ok(names.length > 0, `llms.txt "${key}" sentence names nothing`);
    assert.equal(new Set(names).size, names.length, `llms.txt "${key}" sentence repeats a name: ${names.join(", ")}`);
  }
});

test("index.html integration groups the gate reads are present and non-empty", () => {
  assert.ok(agentCliChipNames(INDEX_HTML).length > 0, "no chips under #agent-cli-title");
  assert.ok(chipsIn(sectionByHeading(INDEX_HTML, "inference-title")).length > 0, "no chips under #inference-title");
  assert.ok(chipsIn(sectionByHeading(INDEX_HTML, "gateway-title")).length > 0, "no chips under #gateway-title");
  assert.ok(infraLabels(INDEX_HTML).length > 0, "no .infra-logo-label elements");
});

test("llms.txt agent CLI list matches the Agent CLIs chips on index.html", () => {
  assertSameSet(agentCliChipNames(INDEX_HTML), live.agentClis ?? [], "agent CLIs");
});

test("llms.txt inference engines/gateways list matches the engine and gateway chips on index.html", () => {
  assertSameSet(inferenceChipNames(INDEX_HTML), live.inference ?? [], "inference engines and gateways");
});

test("llms.txt infrastructure thanks match the infra-thanks logo labels on index.html", () => {
  assertSameSet(infraLabels(INDEX_HTML), live.infra ?? [], "infrastructure sponsors");
});

test("llms.txt points at the same 'See all integrations' docs URL as index.html", () => {
  const m = INDEX_HTML.match(/<a class="inline-link" href="([^"]+)">See all integrations/);
  assert.ok(m, "index.html lost its 'See all integrations' link");
  assert.ok(LLMS_TXT.includes(m[1]), `llms.txt does not reference ${m[1]}`);
});

test("llms.txt names every project the home page lists as a Hive Commons product", () => {
  // Spektacular is the only non-Hive product llms.txt describes today; keep the
  // crawler summary honest if the home page stops (or starts) calling it Spek.
  assert.match(INDEX_HTML, /Spektacular/);
  assert.match(LLMS_TXT, /Spektacular \(Spek\)/);
});

test("llms.txt Projects list names the project carousel cards on index.html, in the same order", () => {
  const cards = projectCards(INDEX_HTML);
  assert.ok(cards.length > 0, "no project cards under #projects");
  const projects = parseLlmsProjects(LLMS_TXT);
  assert.ok(projects, "llms.txt lost its '## Projects' section — restore it or update this gate");
  assert.deepEqual(
    projects,
    cards,
    "llms.txt '## Projects' must list the same projects as the index.html carousel, in carousel order",
  );
});

test("Crux version in llms.txt matches the carousel tag in index.html and both are valid semver", () => {
  const htmlVersion = cruxVersionFromHtml(INDEX_HTML);
  const llmsVersion = cruxVersionFromLlms(LLMS_TXT);
  const semverPattern = /^v\d+\.\d+\.\d+$/;
  
  assert.ok(htmlVersion, "Crux version tag not found in index.html carousel");
  assert.ok(llmsVersion, "Crux version not found in llms.txt");
  assert.match(htmlVersion, semverPattern, `index.html Crux tag '${htmlVersion}' is not valid semver`);
  assert.match(llmsVersion, semverPattern, `llms.txt Crux version '${llmsVersion}' is not valid semver`);
  assert.equal(htmlVersion, llmsVersion, `Crux version mismatch: index.html has '${htmlVersion}' but llms.txt has '${llmsVersion}' — keep them in sync`);
});

