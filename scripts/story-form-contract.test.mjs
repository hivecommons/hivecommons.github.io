#!/usr/bin/env node
// Contract gate between the "Share your story" dialog in `stories/index.html`
// and the GitHub issue form it opens in another repository
// (`hivecommons/hive` `.github/ISSUE_TEMPLATE/contributor-story.yml`).
//
// `buildIssue()` prefills that form through `?template=<file>&<field-id>=…`
// query parameters. GitHub validates none of this: an unknown `template=`
// silently falls back to the blank-issue chooser (so the `contributor-story`
// label the page promises is never applied), an unknown field id is silently
// dropped (the contributor lands on an empty field), and a `role` dropdown
// whose options drift from the page's `<select>` offers the contributor a
// choice the page never showed. `story-dialog.test.mjs` pins the URL the page
// builds; nothing checked that the form on the other side still matches it.
//
// Rules (`contractProblems(page, form)`):
//   1. The page's `labels=` promise (the `Issues labelled <code>…</code>` note)
//      is a label the template applies — GitHub ignores `labels=` for
//      non-maintainers, so only the template can honour it.
//   2. The template's `title:` equals the prefix `buildIssue()` puts in front of
//      the name/project, so the form's own default never overwrites it.
//   3. Every field id the page sends is a field of the template.
//   4. Every `input`/`textarea` field of the template is sent by the page —
//      a text field GitHub *could* prefill but the dialog leaves blank.
//   5. Every field the template requires is sent by the page.
//   6. The page's `<select id="story-role">` option values equal the template's
//      `role` dropdown options, in order.
//   7. The popup-blocked fallback `<a href>` opens the same template.
//
// The live rule fetches the template from the hive's default branch
// (`raw.githubusercontent.com/<owner>/<repo>/HEAD/…`, 10 s timeout, falling back
// through the three directories GitHub reads issue templates from). A transport
// failure (offline, DNS, timeout) *skips* that one test so the offline suite
// stays runnable; an HTTP 404 on every directory is a real finding and fails.
// `STORY_FORM_TEMPLATE=<path>` reads a local copy instead (no network).
// Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/story-form-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "stories", "index.html");
export const TEMPLATE_DIRS = [".github/ISSUE_TEMPLATE", "ISSUE_TEMPLATE", "docs/ISSUE_TEMPLATE"];
export const FETCH_TIMEOUT_MS = 10_000;
export const TEXT_FIELD_TYPES = new Set(["input", "textarea"]);

// --- page side ---------------------------------------------------------------

function unquote(raw) {
  const s = raw.trim();
  if (/^".*"$/.test(s)) return JSON.parse(s);
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function dialogScript(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const scripts = blocks.filter((s) => s.includes('getElementById("story-dialog")'));
  if (scripts.length !== 1) throw new Error(`expected exactly one story-dialog script block, found ${scripts.length}`);
  return scripts[0];
}

// What the dialog sends: template file, title prefix, field ids (those always
// pushed into `params` and those pushed behind an `if (data.x)`), plus the
// markup it must agree with (role options, fallback href, promised label).
export function pageContract(html) {
  const script = dialogScript(html);
  const issueUrl = /var ISSUE_URL\s*=\s*"([^"]+)"/.exec(script)?.[1];
  if (!issueUrl) throw new Error("ISSUE_URL not found in the dialog script");
  const body = /function buildIssue\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/.exec(script)?.[1];
  if (!body) throw new Error("buildIssue() not found in the dialog script");

  const always = [...(/var params\s*=\s*\[([\s\S]*?)\];/.exec(body)?.[1] ?? "").matchAll(/\[\s*"([^"]+)"\s*,\s*([^\]]+?)\s*\]/g)]
    .map((m) => ({ id: m[1], value: m[2] }));
  const optional = [...body.matchAll(/params\.push\(\[\s*"([^"]+)"\s*,/g)].map((m) => m[1]);
  const templateFile = always.find((p) => p.id === "template")?.value;
  const titleExpr = always.find((p) => p.id === "title")?.value;
  const titlePrefix = /^"([^"]*)"\s*\+/.exec(titleExpr ?? "")?.[1];

  const select = /<select[^>]*\bid="story-role"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
  const roleOptions = [...select.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map((m) => m[1]);
  const fallbackHref = /<a[^>]*\bid="story-fallback-link"[^>]*\bhref="([^"]*)"/.exec(html)?.[1]
    ?? /<a[^>]*\bhref="([^"]*)"[^>]*\bid="story-fallback-link"/.exec(html)?.[1];
  const promisedLabel = /Issues labelled <code>([^<]+)<\/code>/.exec(html)?.[1];

  const sent = [...always.map((p) => p.id).filter((id) => id !== "template" && id !== "title"), ...optional];
  return { issueUrl, templateFile: templateFile ? unquote(templateFile) : undefined, titlePrefix, sent, roleOptions, fallbackHref, promisedLabel };
}

// --- template side -------------------------------------------------------------

// Minimal reader for the subset of GitHub's issue-form schema this gate needs:
// top-level `title:` / `labels:` (flow list or block list) and the `body:` list
// of `- type:` entries with `id:`, `attributes: { options: [...] }` and
// `validations: { required: … }`. Anything else is skipped, not rejected — the
// hive owns the template; this gate only reads the keys the page depends on.
export function parseIssueForm(text) {
  const form = { title: undefined, labels: [], fields: [] };
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  let section = null; // "labels" | "body" | null
  let field = null;
  let listKey = null; // which key inside a field a bare `- item` belongs to
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = /^\s*/.exec(line)[0].length;
    if (indent === 0) {
      section = null; field = null; listKey = null;
      const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === "title") form.title = unquote(m[2]);
      else if (m[1] === "labels") {
        if (/^\[.*\]$/.test(m[2])) form.labels = m[2].slice(1, -1).split(",").map((s) => unquote(s)).filter(Boolean);
        else section = "labels";
      } else if (m[1] === "body") section = "body";
      continue;
    }
    if (section === "labels") {
      const m = /^\s*-\s+(.+)$/.exec(line);
      if (m) form.labels.push(unquote(m[1]));
      continue;
    }
    if (section !== "body") continue;
    const item = /^\s*-\s+(?:([A-Za-z_]+):\s*(.*))?$/.exec(line);
    if (item && indent === 2) {
      field = { type: undefined, id: undefined, required: false, options: [] };
      form.fields.push(field);
      listKey = null;
      if (item[1] === "type") field.type = unquote(item[2]);
      else if (item[1] === "id") field.id = unquote(item[2]);
      continue;
    }
    if (!field) continue;
    const kv = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) {
      listKey = null;
      if (kv[1] === "type" && indent === 4) field.type = unquote(kv[2]);
      else if (kv[1] === "id" && indent === 4) field.id = unquote(kv[2]);
      else if (kv[1] === "required") field.required = unquote(kv[2]) === "true";
      else if (kv[1] === "options") {
        if (/^\[.*\]$/.test(kv[2])) field.options = kv[2].slice(1, -1).split(",").map((s) => unquote(s)).filter(Boolean);
        else listKey = "options";
      }
      continue;
    }
    const bullet = /^\s*-\s+(.+)$/.exec(line);
    if (bullet && listKey === "options") {
      // dropdown options are scalars; checkbox options are `- label: …` maps
      const labelled = /^label:\s*(.*)$/.exec(bullet[1]);
      field.options.push(unquote(labelled ? labelled[1] : bullet[1]));
    }
  }
  return form;
}

// --- rules -----------------------------------------------------------------------

export function contractProblems(page, form) {
  const problems = [];
  const byId = new Map(form.fields.filter((f) => f.id).map((f) => [f.id, f]));

  if (page.promisedLabel && !form.labels.includes(page.promisedLabel)) {
    problems.push(`page promises issues are labelled \`${page.promisedLabel}\` but the template applies [${form.labels.join(", ")}]`);
  }
  if (page.titlePrefix !== undefined && form.title !== page.titlePrefix) {
    problems.push(`page title prefix ${JSON.stringify(page.titlePrefix)} differs from template title ${JSON.stringify(form.title)}`);
  }
  for (const id of page.sent) {
    if (!byId.has(id)) problems.push(`page sends \`${id}=\` but the template has no field with that id (GitHub drops it silently)`);
  }
  for (const f of form.fields) {
    if (!f.id) continue;
    if (TEXT_FIELD_TYPES.has(f.type) && !page.sent.includes(f.id)) {
      problems.push(`template ${f.type} \`${f.id}\` could be prefilled but the page never sends it`);
    }
    if (f.required && !page.sent.includes(f.id)) {
      problems.push(`template requires \`${f.id}\` but the page never sends it`);
    }
  }
  const role = byId.get("role");
  if (role) {
    if (role.type !== "dropdown") problems.push(`template \`role\` is a ${role.type}, page offers a <select>`);
    else if (JSON.stringify(role.options) !== JSON.stringify(page.roleOptions)) {
      problems.push(`page role options [${page.roleOptions.join(", ")}] differ from template dropdown [${role.options.join(", ")}]`);
    }
  }
  const expectedFallback = `${page.issueUrl}?template=${page.templateFile}`;
  if (page.fallbackHref !== expectedFallback) {
    problems.push(`fallback link href ${JSON.stringify(page.fallbackHref)} should be ${JSON.stringify(expectedFallback)}`);
  }
  return problems;
}

// Where GitHub reads the template from: the default branch of the repo in ISSUE_URL.
export function templateUrls(issueUrl, templateFile) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/new$/.exec(issueUrl);
  if (!m) throw new Error(`ISSUE_URL ${issueUrl} is not a github.com issues/new URL`);
  return TEMPLATE_DIRS.map((d) => `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/${d}/${templateFile}`);
}

// Resolves to { text } on the first 200, { missing: [urls] } when every
// directory 404s, and throws on a transport failure.
export async function fetchTemplate(urls, fetchImpl = globalThis.fetch) {
  const missing = [];
  for (const url of urls) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "hivecommons.github.io story-form-contract" } });
    if (res.status === 200) return { text: await res.text(), url };
    missing.push(`${url} (HTTP ${res.status})`);
  }
  return { missing };
}

// --- fixtures -------------------------------------------------------------------

const PAGE_FIXTURE = `
<p>Issues labelled <code>contributor-story</code> are reviewed.</p>
<select id="story-role" name="role">
  <option value="first-time contributor">first-time contributor</option>
  <option value="maintainer">maintainer</option>
</select>
<a id="story-fallback-link" href="https://github.com/o/r/issues/new?template=story.yml">open</a>
<script>(function () {
  var ISSUE_URL = "https://github.com/o/r/issues/new";
  var dialog = document.getElementById("story-dialog");
  function buildIssue(data) {
    var params = [
      ["template", "story.yml"],
      ["title", "📖 contributor story: " + data.name + " on " + data.project],
      ["name", data.name],
      ["role", data.role],
      ["story", data.story]
    ];
    if (data.link) params.push(["link", data.link]);
    return ISSUE_URL + "?" + buildQuery(params);
  }
})();</script>`;

const FORM_FIXTURE = `name: Contributor story
description: Share a story
title: "📖 contributor story: "
labels: [contributor-story, docs]
body:
  - type: markdown
    attributes:
      value: |
        Thanks.
        - not: a field
  - type: input
    id: name
    attributes:
      label: Name
    validations:
      required: true
  - type: dropdown
    id: role
    attributes:
      label: Role
      options:
        - first-time contributor
        - maintainer
    validations:
      required: true
  - type: textarea
    id: story
    validations:
      required: true
  - type: checkboxes
    id: quote_ok
    attributes:
      options:
        - label: "Yes"
          required: false
  - type: input
    id: link
    validations:
      required: false
`;

test("pageContract reads the template, title prefix, sent ids, role options, fallback and promised label", () => {
  assert.deepEqual(pageContract(PAGE_FIXTURE), {
    issueUrl: "https://github.com/o/r/issues/new",
    templateFile: "story.yml",
    titlePrefix: "📖 contributor story: ",
    sent: ["name", "role", "story", "link"],
    roleOptions: ["first-time contributor", "maintainer"],
    fallbackHref: "https://github.com/o/r/issues/new?template=story.yml",
    promisedLabel: "contributor-story",
  });
  assert.throws(() => pageContract("<script>var x = 1;</script>"), /exactly one story-dialog script/);
});

test("parseIssueForm reads title, labels and the body fields it needs; markdown blocks and checkbox maps do not confuse it", () => {
  const form = parseIssueForm(FORM_FIXTURE);
  assert.equal(form.title, "📖 contributor story: ");
  assert.deepEqual(form.labels, ["contributor-story", "docs"]);
  assert.deepEqual(form.fields.map((f) => [f.type, f.id, f.required]), [
    ["markdown", undefined, false], ["input", "name", true], ["dropdown", "role", true],
    ["textarea", "story", true], ["checkboxes", "quote_ok", false], ["input", "link", false],
  ]);
  assert.deepEqual(form.fields[2].options, ["first-time contributor", "maintainer"]);
  assert.deepEqual(form.fields[4].options, ["Yes"]);
  const block = parseIssueForm("title: 'It''s'\nlabels:\n  - a\n  - \"b\"\nbody:\n  - id: x\n    type: input\n");
  assert.deepEqual([block.title, block.labels, block.fields], ["It's", ["a", "b"], [{ type: "input", id: "x", required: false, options: [] }]]);
});

test("a matching page and template produce no problems", () => {
  assert.deepEqual(contractProblems(pageContract(PAGE_FIXTURE), parseIssueForm(FORM_FIXTURE)), []);
});

test("rule 1-2: label the page promises and the title prefix must match the template", () => {
  const p = contractProblems(pageContract(PAGE_FIXTURE), parseIssueForm(FORM_FIXTURE.replace("[contributor-story, docs]", "[docs]").replace('title: "📖 contributor story: "', 'title: "Story: "')));
  assert.deepEqual(p, [
    "page promises issues are labelled `contributor-story` but the template applies [docs]",
    'page title prefix "📖 contributor story: " differs from template title "Story: "',
  ]);
});

test("rule 3-5: sent ids must exist; template text fields and required fields must be sent", () => {
  const renamed = FORM_FIXTURE.replace("id: story", "id: your_story").replace("id: link", "id: pr_link");
  assert.deepEqual(contractProblems(pageContract(PAGE_FIXTURE), parseIssueForm(renamed)), [
    "page sends `story=` but the template has no field with that id (GitHub drops it silently)",
    "page sends `link=` but the template has no field with that id (GitHub drops it silently)",
    "template textarea `your_story` could be prefilled but the page never sends it",
    "template requires `your_story` but the page never sends it",
    "template input `pr_link` could be prefilled but the page never sends it",
  ]);
  const newRequired = FORM_FIXTURE + "  - type: dropdown\n    id: consent\n    validations:\n      required: true\n";
  assert.deepEqual(contractProblems(pageContract(PAGE_FIXTURE), parseIssueForm(newRequired)), ["template requires `consent` but the page never sends it"]);
});

test("rule 6: role options must match the dropdown exactly and in order", () => {
  const reordered = FORM_FIXTURE.replace("        - first-time contributor\n        - maintainer\n", "        - maintainer\n        - first-time contributor\n");
  assert.deepEqual(contractProblems(pageContract(PAGE_FIXTURE), parseIssueForm(reordered)), [
    "page role options [first-time contributor, maintainer] differ from template dropdown [maintainer, first-time contributor]",
  ]);
  const asInput = FORM_FIXTURE.replace("- type: dropdown\n    id: role", "- type: input\n    id: role");
  assert.deepEqual(contractProblems(pageContract(PAGE_FIXTURE), parseIssueForm(asInput)), ["template `role` is a input, page offers a <select>"]);
});

test("rule 7: the popup-blocked fallback must open the same template", () => {
  const page = pageContract(PAGE_FIXTURE.replace("?template=story.yml", "?labels=contributor-story"));
  assert.deepEqual(contractProblems(page, parseIssueForm(FORM_FIXTURE)), [
    'fallback link href "https://github.com/o/r/issues/new?labels=contributor-story" should be "https://github.com/o/r/issues/new?template=story.yml"',
  ]);
});

test("templateUrls targets the default branch of the ISSUE_URL repository across the directories GitHub reads", () => {
  assert.deepEqual(templateUrls("https://github.com/o/r/issues/new", "story.yml"), [
    "https://raw.githubusercontent.com/o/r/HEAD/.github/ISSUE_TEMPLATE/story.yml",
    "https://raw.githubusercontent.com/o/r/HEAD/ISSUE_TEMPLATE/story.yml",
    "https://raw.githubusercontent.com/o/r/HEAD/docs/ISSUE_TEMPLATE/story.yml",
  ]);
  assert.throws(() => templateUrls("https://gitlab.com/o/r/issues/new", "x.yml"), /not a github\.com/);
});

test("fetchTemplate returns the first 200, lists every 404, and lets transport errors propagate", async () => {
  const fake = (statuses) => async (url) => {
    const status = statuses[url] ?? 404;
    return { status, text: async () => `body of ${url}` };
  };
  const urls = ["https://x/a", "https://x/b"];
  assert.deepEqual(await fetchTemplate(urls, fake({ "https://x/b": 200 })), { text: "body of https://x/b", url: "https://x/b" });
  assert.deepEqual(await fetchTemplate(urls, fake({})), { missing: ["https://x/a (HTTP 404)", "https://x/b (HTTP 404)"] });
  await assert.rejects(fetchTemplate(urls, async () => { throw new TypeError("fetch failed"); }), /fetch failed/);
});

// --- the real page against the real template -------------------------------------

test("stories/index.html sends only ids that exist, in the shape of the hive's contributor-story issue form", async (t) => {
  const page = pageContract(readFileSync(PAGE, "utf8"));
  assert.ok(page.templateFile, "buildIssue() must send template=");
  assert.ok(page.titlePrefix !== undefined, "buildIssue() must send a literal title prefix");
  assert.ok(page.sent.length > 0, "buildIssue() must send at least one field id");

  let text;
  if (process.env.STORY_FORM_TEMPLATE) {
    text = readFileSync(process.env.STORY_FORM_TEMPLATE, "utf8");
  } else {
    let fetched;
    try {
      fetched = await fetchTemplate(templateUrls(page.issueUrl, page.templateFile));
    } catch (error) {
      t.skip(`cannot reach raw.githubusercontent.com (${error?.cause?.code ?? error?.name ?? error}); set STORY_FORM_TEMPLATE=<path> to check a local copy`);
      return;
    }
    if (fetched.text === undefined) {
      assert.fail(`template ${page.templateFile} is not on the default branch of the repository ISSUE_URL points at — GitHub will show the blank-issue chooser and apply no label:\n  ${fetched.missing.join("\n  ")}`);
    }
    text = fetched.text;
  }
  assert.deepEqual(contractProblems(page, parseIssueForm(text)), []);
});
