#!/usr/bin/env node
// Static gate over .github/ISSUE_TEMPLATE/*. GitHub silently falls back to a
// blank issue when a form fails to parse, so CI would stay green on a broken
// form. Rules:
//   1. config.yml and every form parse; `blank_issues_enabled` is boolean.
//   2. Every `contact_links[].url` is https; `hivecommons.dev/<path>` URLs
//      resolve to a committed page.
//   3. `body[].id` is unique within a form; every `type` is a GitHub form type.
//   4. Every `labels[]` entry is in KNOWN_LABELS (the committed label list).
// Zero dependencies: a minimal reader for the YAML subset these files use.
// Usage: node --test scripts/issue-forms.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIR = join(ROOT, ".github", "ISSUE_TEMPLATE");

// Element types in GitHub's form schema documentation.
export const FORM_TYPES = new Set(["markdown", "textarea", "input", "dropdown", "checkboxes"]);
// Labels that exist on the repository; add new labels here in the same PR that uses them.
export const KNOWN_LABELS = new Set(["bug"]);
const SITE_ORIGIN = "https://hivecommons.dev";

function scalar(s) {
  s = s.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(",").map(scalar) : [];
  }
  if (/^"(.*)"$/.test(s) || /^'(.*)'$/.test(s)) return s.slice(1, -1);
  return s.replace(/\s+#.*$/, "");
}

// Parses block maps, block lists (of scalars or maps), flow lists, and `|`/`>` block scalars.
export function parseYaml(text) {
  const lines = text.replace(/\t/g, "\u0000").split("\n").map((l) => l.replace(/\r$/, ""));
  for (const l of lines) if (l.includes("\u0000") && /^\s*\u0000/.test(l)) throw new Error("tab indentation");
  let i = 0;
  const skip = () => { while (i < lines.length && (/^\s*$/.test(lines[i]) || /^\s*#/.test(lines[i]))) i++; };
  const indentOf = (l) => l.match(/^ */)[0].length;

  function block(indent) {
    skip();
    if (i >= lines.length) return null;
    return lines[i].slice(indent).startsWith("- ") || lines[i].slice(indent) === "-" ? list(indent) : map(indent);
  }
  function list(indent) {
    const out = [];
    for (skip(); i < lines.length && indentOf(lines[i]) === indent && /^-( |$)/.test(lines[i].slice(indent)); skip()) {
      const rest = lines[i].slice(indent + 2);
      if (/^[A-Za-z_][\w-]*:(\s|$)/.test(rest)) {
        lines[i] = " ".repeat(indent + 2) + rest;
        out.push(map(indent + 2));
      } else { i++; out.push(scalar(rest)); }
    }
    return out;
  }
  function map(indent) {
    const out = {};
    for (skip(); i < lines.length && indentOf(lines[i]) === indent; skip()) {
      const m = lines[i].slice(indent).match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
      if (!m) throw new Error(`line ${i + 1}: cannot parse "${lines[i].trim()}"`);
      if (m[1] in out) throw new Error(`line ${i + 1}: duplicate key ${m[1]}`);
      i++;
      const v = m[2];
      if (v === undefined || v === "") {
        skip();
        out[m[1]] = i < lines.length && (indentOf(lines[i]) > indent || (indentOf(lines[i]) === indent && /^- /.test(lines[i].slice(indent))))
          ? block(indentOf(lines[i])) : null;
      } else if (/^[|>][+-]?$/.test(v)) {
        const buf = [];
        while (i < lines.length && (/^\s*$/.test(lines[i]) || indentOf(lines[i]) > indent)) buf.push(lines[i++].trim() === "" ? "" : lines[i - 1].trim());
        out[m[1]] = buf.join("\n").trim();
      } else out[m[1]] = scalar(v);
    }
    return out;
  }
  skip();
  const result = block(indentOf(lines[i] ?? ""));
  skip();
  if (i < lines.length) throw new Error(`line ${i + 1}: unexpected content "${lines[i].trim()}"`);
  return result;
}

export function configProblems(cfg, pageExists) {
  const p = [];
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) return ["config.yml is not a mapping"];
  if (typeof cfg.blank_issues_enabled !== "boolean") p.push("blank_issues_enabled is not a boolean");
  for (const [n, link] of (cfg.contact_links ?? []).entries()) {
    const url = link?.url;
    if (typeof url !== "string" || !url.startsWith("https://")) { p.push(`contact_links[${n}].url is not https: ${url}`); continue; }
    if (url === SITE_ORIGIN || url.startsWith(`${SITE_ORIGIN}/`)) {
      const path = url.slice(SITE_ORIGIN.length).split(/[?#]/)[0].replace(/^\/+/, "");
      if (!pageExists(path)) p.push(`contact_links[${n}].url ${url} does not resolve to a committed page`);
    }
  }
  return p;
}

export function formProblems(form) {
  const p = [];
  if (typeof form !== "object" || form === null || Array.isArray(form)) return ["form is not a mapping"];
  if (!Array.isArray(form.body) || form.body.length === 0) return ["body is missing or empty"];
  const ids = new Set();
  for (const [n, el] of form.body.entries()) {
    if (!FORM_TYPES.has(el?.type)) p.push(`body[${n}].type "${el?.type}" is not a GitHub form type`);
    if (el?.id !== undefined) {
      if (ids.has(el.id)) p.push(`duplicate body id "${el.id}"`);
      ids.add(el.id);
    }
  }
  const labels = form.labels ?? [];
  if (!Array.isArray(labels)) p.push("labels is not a list");
  else for (const l of labels) if (!KNOWN_LABELS.has(l)) p.push(`label "${l}" is not in KNOWN_LABELS`);
  return p;
}

// A site path resolves when a committed page (or its index.html) serves it.
const siteHas = (path) => {
  if (path === "") return existsSync(join(ROOT, "index.html"));
  const clean = path.replace(/\/$/, "");
  return existsSync(join(ROOT, clean, "index.html")) || existsSync(join(ROOT, `${clean}.html`)) || existsSync(join(ROOT, clean));
};

test("config.yml parses and its contact links are sound", () => {
  const cfg = parseYaml(readFileSync(join(DIR, "config.yml"), "utf8"));
  assert.deepEqual(configProblems(cfg, siteHas), []);
});

test("every issue form parses and is sound", () => {
  const forms = readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n) && n !== "config.yml");
  assert.ok(forms.length > 0, "no issue forms found");
  for (const f of forms) assert.deepEqual(formProblems(parseYaml(readFileSync(join(DIR, f), "utf8"))), [], f);
});

test("fixtures: each rule rejects a bad input", () => {
  const ok = () => true;
  assert.ok(configProblems({ blank_issues_enabled: "yes", contact_links: [] }, ok).length);
  assert.ok(configProblems({ blank_issues_enabled: true, contact_links: [{ url: "http://x.dev/" }] }, ok).length);
  assert.ok(configProblems({ blank_issues_enabled: true, contact_links: [{ url: "https://hivecommons.dev/gone" }] }, () => false).length);
  assert.ok(formProblems({ body: [{ type: "input", id: "a" }, { type: "input", id: "a" }] }).length);
  assert.ok(formProblems({ body: [{ type: "bogus" }] }).length);
  assert.ok(formProblems({ labels: ["nope"], body: [{ type: "markdown" }] }).length);
  assert.throws(() => parseYaml("a: 1\na: 2\n"));
});
