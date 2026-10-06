#!/usr/bin/env node
// Static gate for the Content-Security-Policy <meta> on every content page.
// GitHub Pages cannot send response headers, so the policy ships as a <meta>
// tag and inline scripts are allow-listed by sha256 hash. A hash that drifts
// from its script body silently disables that script in every browser, so this
// test recomputes every hash from the committed HTML and fails on mismatch.
// It also keeps the policy from regressing to 'unsafe-inline'/'unsafe-eval'
// and keeps every external <img> origin covered by img-src.
// Zero dependencies. Usage: node --test scripts/page-csp.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "scripts", ".linkcheck-work"]);

// Script types the browser never executes; CSP script-src does not apply.
const DATA_SCRIPT_TYPES = new Set(["application/ld+json", "application/json", "importmap"]);
const EVENT_HANDLER_RE = /\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const META_REFRESH_RE = /<meta\b[^>]+http-equiv\s*=\s*["']refresh["']/i;

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

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return out;
}

export function sha256Source(source) {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

export function inlineScriptSources(html) {
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const a = attrs(m[1]);
    if (a.src !== undefined) continue;
    const type = (a.type ?? "").trim().toLowerCase();
    if (DATA_SCRIPT_TYPES.has(type)) continue;
    out.push(m[2]);
  }
  return out;
}

export function inlineHandlerSources(html) {
  const out = new Set();
  for (const m of html.matchAll(EVENT_HANDLER_RE)) out.add(m[1] ?? m[2]);
  return [...out];
}

export function externalImageOrigins(html) {
  const out = new Set();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attrs(m[0]).src ?? "";
    if (/^https?:\/\//i.test(src)) out.add(new URL(src).origin);
  }
  return [...out].sort();
}

export function parseCsp(html) {
  const head = (/<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html) ?? [, ""])[1];
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)];
  const cspMetas = metas.filter((m) => (attrs(m[0])["http-equiv"] ?? "").toLowerCase() === "content-security-policy");
  if (cspMetas.length === 0) return null;
  const directives = {};
  for (const part of (attrs(cspMetas[0][0]).content ?? "").split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    directives[tokens[0].toLowerCase()] = tokens.slice(1);
  }
  // Index in the head of the policy and of the first fetch-triggering tag, so a
  // policy placed after a <script> or <link> can be reported: CSP in <meta>
  // only governs content that follows it.
  const policyAt = head.indexOf(cspMetas[0][0]);
  const firstFetch = /<(script|link|img|style)\b/i.exec(head);
  return { count: cspMetas.length, directives, policyAt, firstFetchAt: firstFetch ? firstFetch.index : -1 };
}

export function problemsOf(html) {
  const problems = [];
  const csp = parseCsp(html);
  if (!csp) return ['missing <meta http-equiv="Content-Security-Policy">'];
  if (csp.count !== 1) problems.push(`expected exactly one CSP meta, found ${csp.count}`);
  if (csp.firstFetchAt !== -1 && csp.firstFetchAt < csp.policyAt) {
    problems.push("CSP meta must precede every <script>/<link>/<img>/<style> in <head> (a meta policy only governs what follows it)");
  }
  const d = csp.directives;
  const scriptSrc = d["script-src"];
  if (!scriptSrc) {
    problems.push("script-src directive missing");
  } else {
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:", "data:"]) {
      if (scriptSrc.includes(bad)) problems.push(`script-src must not contain ${bad}`);
    }
    if (!(d["default-src"] ?? []).includes("'none'")) problems.push("default-src must be 'none' so every fetch type is allow-listed explicitly");

    const wantScripts = inlineScriptSources(html).map(sha256Source);
    const wantHandlers = inlineHandlerSources(html).map(sha256Source);
    const haveHashes = scriptSrc.filter((t) => t.startsWith("'sha256-"));
    for (const h of [...wantScripts, ...wantHandlers]) {
      if (!haveHashes.includes(h)) problems.push(`script-src lacks ${h} for an inline script or event handler (body edited without updating the policy?)`);
    }
    for (const h of haveHashes) {
      if (!wantScripts.includes(h) && !wantHandlers.includes(h)) problems.push(`script-src has stale hash ${h} that matches no inline script or handler`);
    }
    if (wantHandlers.length > 0 && !scriptSrc.includes("'unsafe-hashes'")) problems.push("inline event handlers present but script-src lacks 'unsafe-hashes'");
    if (wantHandlers.length === 0 && scriptSrc.includes("'unsafe-hashes'")) problems.push("'unsafe-hashes' present but no inline event handlers remain");
  }
  const imgSrc = d["img-src"] ?? d["default-src"] ?? [];
  for (const origin of externalImageOrigins(html)) {
    if (!imgSrc.includes(origin) && !imgSrc.includes("https:")) problems.push(`img-src does not allow external <img> origin ${origin}`);
  }
  if (!(d["base-uri"] ?? []).some((t) => t === "'none'" || t === "'self'")) problems.push("base-uri must be 'none' or 'self'");
  if (!d["form-action"]) problems.push("form-action directive missing");
  return problems;
}

// --- per-page gates ---------------------------------------------------------

for (const file of htmlFiles()) {
  const rel = relative(ROOT, file);
  const html = readFileSync(file, "utf8");
  // Shortcut redirect pages are generated by make-redirects.sh and carry only a
  // meta refresh; they load no scripts and are out of scope.
  if (META_REFRESH_RE.test(html)) continue;

  test(`${rel}: CSP meta present, hashes match inline scripts, no unsafe-inline`, () => {
    assert.deepEqual(problemsOf(html), []);
  });
}

// --- fixture self-tests -----------------------------------------------------

function fixture({ csp, script = "console.log(1)", handler = "", img = "" } = {}) {
  const meta = csp === null ? "" : `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return `<!doctype html><html><head><meta charset="utf-8">${meta}<title>x</title></head><body>${img}<p${handler ? ` onerror="${handler}"` : ""}></p><script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing"}</script><script>${script}</script></body></html>`;
}

const BASE = "default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'";

test("fixture: correct policy passes", () => {
  const h = sha256Source("console.log(1)");
  assert.deepEqual(problemsOf(fixture({ csp: `${BASE}; script-src ${h}` })), []);
});

test("fixture: missing meta is reported", () => {
  assert.deepEqual(problemsOf(fixture({ csp: null })), ['missing <meta http-equiv="Content-Security-Policy">']);
});

test("fixture: drifted script body is reported with both the missing and the stale hash", () => {
  const stale = sha256Source("console.log(0)");
  const want = sha256Source("console.log(1)");
  const problems = problemsOf(fixture({ csp: `${BASE}; script-src ${stale}` }));
  assert.ok(problems.some((p) => p.includes(`lacks ${want}`)), problems.join("\n"));
  assert.ok(problems.some((p) => p.includes(`stale hash ${stale}`)), problems.join("\n"));
});

test("fixture: JSON-LD blocks are not hashed", () => {
  const h = sha256Source("console.log(1)");
  assert.equal(inlineScriptSources(fixture({ csp: `${BASE}; script-src ${h}` })).length, 1);
});

test("fixture: 'unsafe-inline' and 'unsafe-eval' in script-src are rejected", () => {
  const h = sha256Source("console.log(1)");
  const problems = problemsOf(fixture({ csp: `${BASE}; script-src 'unsafe-inline' 'unsafe-eval' ${h}` }));
  assert.deepEqual(problems, ["script-src must not contain 'unsafe-inline'", "script-src must not contain 'unsafe-eval'"]);
});

test("fixture: inline event handler requires 'unsafe-hashes' plus its hash", () => {
  const h = sha256Source("console.log(1)");
  const hh = sha256Source("this.hidden=true");
  assert.deepEqual(problemsOf(fixture({ csp: `${BASE}; script-src ${h} 'unsafe-hashes' ${hh}`, handler: "this.hidden=true" })), []);
  const problems = problemsOf(fixture({ csp: `${BASE}; script-src ${h}`, handler: "this.hidden=true" }));
  assert.ok(problems.some((p) => p.includes(`lacks ${hh}`)), problems.join("\n"));
  assert.ok(problems.includes("inline event handlers present but script-src lacks 'unsafe-hashes'"), problems.join("\n"));
});

test("fixture: external <img> origin must be in img-src", () => {
  const h = sha256Source("console.log(1)");
  const img = '<img src="https://github.com/octocat.png" alt="">';
  assert.deepEqual(problemsOf(fixture({ csp: `${BASE}; script-src ${h}`, img })), ["img-src does not allow external <img> origin https://github.com"]);
  assert.deepEqual(problemsOf(fixture({ csp: `default-src 'none'; img-src 'self' https://github.com; base-uri 'none'; form-action 'none'; script-src ${h}`, img })), []);
});

test("fixture: policy placed after a <script> in <head> is reported", () => {
  const h = sha256Source("console.log(1)");
  const html = `<!doctype html><html><head><meta charset="utf-8"><script>console.log(1)</script><meta http-equiv="Content-Security-Policy" content="${BASE}; script-src ${h}"></head><body></body></html>`;
  assert.deepEqual(problemsOf(html), ["CSP meta must precede every <script>/<link>/<img>/<style> in <head> (a meta policy only governs what follows it)"]);
});

test("fixture: default-src other than 'none' is reported", () => {
  const h = sha256Source("console.log(1)");
  const problems = problemsOf(fixture({ csp: `default-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; script-src ${h}` }));
  assert.deepEqual(problems, ["default-src must be 'none' so every fetch type is allow-listed explicitly"]);
});
