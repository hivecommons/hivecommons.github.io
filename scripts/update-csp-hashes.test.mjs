// Fixture tests for the CSP regeneration command. Zero dependencies.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, htmlFiles, isRedirectPage } from "./html-pages.mjs";
import { REGEN_HINT, sha256Source, parseCsp, problemsOf } from "./page-csp.mjs";
import { updateCspHashes, updatePages } from "./update-csp-hashes.mjs";

const BASE = "default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'";
const SOURCE = "\n  console.log('exact whitespace');\n";
function fixture({ policy = `${BASE}; script-src 'self' 'sha256-stale'`, body = `<script>${SOURCE}</script>` } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><META content="${policy}" HTTP-EQUIV="Content-Security-Policy"><title>x</title></head><body>${body}</body></html>`;
}
const scriptSrc = (html) => parseCsp(html).directives["script-src"];

test("rewrites stale hashes, preserves non-hash tokens and all surrounding bytes, and is idempotent", () => {
  const before = fixture({ policy: `${BASE};  SCRIPT-SRC   'self' 'nonce-keep' https://example.org 'sha256-stale' 'sha384-old' 'sha512-old'  ; object-src 'none'` });
  const after = updateCspHashes(before);
  assert.equal(after, before.replace("'sha256-stale' 'sha384-old' 'sha512-old'", sha256Source(SOURCE)));
  assert.equal(updateCspHashes(after), after);
  assert.deepEqual(problemsOf(after), []);
});

test("hashes executable scripts only, deduplicates, and adds/removes handler authorization", () => {
  const script = `<script>${SOURCE}</script>`;
  const ignored = '<script src="/external.js"></script><script type="application/ld+json">{}</script><script type="application/json">{}</script><script type="importmap">{}</script>';
  const handlers = '<img onerror="this.hidden=true"><p onclick=\'this.hidden=true\'></p>';
  const before = fixture({ body: script + script + ignored + handlers });
  const after = updateCspHashes(before);
  assert.deepEqual(scriptSrc(after), ["'self'", sha256Source(SOURCE), "'unsafe-hashes'", sha256Source("this.hidden=true")]);
  assert.deepEqual(problemsOf(after), []);
  const removed = updateCspHashes(after.replace(handlers, ""));
  assert.deepEqual(scriptSrc(removed), ["'self'", sha256Source(SOURCE)]);
  const noScripts = updateCspHashes(removed.replaceAll(script, ""));
  assert.deepEqual(scriptSrc(noScripts), ["'self'"]);
});

test("duplicate old hashes cannot hide a newly added script", () => {
  const hash = sha256Source(SOURCE);
  const html = fixture({ policy: `${BASE}; script-src ${hash} ${hash}`, body: `<script>${SOURCE}</script><script>newScript()</script>` });
  assert.deepEqual(scriptSrc(updateCspHashes(html)), [hash, sha256Source("newScript()")]);
});

test("leaves correct policies byte-identical regardless of token order", () => {
  const html = fixture({ policy: `${BASE}; script-src ${sha256Source(SOURCE)}   'self'` });
  assert.equal(updateCspHashes(html), html);
});

test("bare script-src directives are unchanged without scripts and populated with a separator", () => {
  for (const suffix of ["", "; style-src 'self'", "   ; style-src 'self'"]) {
    const policy = `${BASE}; script-src${suffix}`;
    const empty = fixture({ policy, body: "" });
    assert.deepEqual(problemsOf(empty), []);
    assert.equal(updateCspHashes(empty), empty);
    const before = fixture({ policy });
    const after = updateCspHashes(before);
    const separator = suffix.startsWith(" ") ? suffix.match(/^\s*/)[0] : " ";
    assert.equal(after, before.replace(`script-src${suffix}`, `script-src${separator}${sha256Source(SOURCE)}${suffix.trimStart()}`));
    assert.deepEqual(scriptSrc(after), [sha256Source(SOURCE)]);
    assert.deepEqual(problemsOf(after), []);
    assert.equal(updateCspHashes(after), after);
  }
  assert.throws(() => updateCspHashes(fixture({ policy: `${BASE}; script-src-elem 'self'` })), /exactly one script-src/);
});

test("incompatible single-quoted attributes fail without rewriting their quoting", () => {
  const html = fixture({ policy: "default-src https:; script-src https:" })
    .replace('content="default-src https:; script-src https:"', "content='default-src https:; script-src https:'");
  assert.throws(() => updateCspHashes(html), /quote conflicts/);
});

test("does not relax unsafe policy tokens or invent missing policies", () => {
  const html = updateCspHashes(fixture({ policy: `${BASE}; script-src 'unsafe-inline' 'unsafe-eval' 'sha256-old'` }));
  assert.ok(problemsOf(html).includes("script-src must not contain 'unsafe-inline'"));
  assert.ok(problemsOf(html).includes("script-src must not contain 'unsafe-eval'"));
  assert.throws(() => updateCspHashes("<html><head></head></html>"), /exactly one CSP/);
  assert.throws(() => updateCspHashes(fixture({ policy: BASE })), /exactly one script-src/);
  assert.throws(() => updateCspHashes(fixture({ policy: `${BASE}; script-src 'self'; script-src 'none'` })), /exactly one script-src/);
  assert.throws(() => updateCspHashes(fixture().replace("<title>", '<meta http-equiv="Content-Security-Policy" content=""><title>')), /exactly one CSP/);
});

test("live tree: every committed content page is already up to date", () => {
  const stale = [];
  let pages = 0;
  for (const file of htmlFiles()) {
    const html = readFileSync(file, "utf8");
    if (isRedirectPage(html)) continue;
    pages += 1;
    if (updateCspHashes(html) !== html) stale.push(file);
  }
  assert.ok(pages > 0, "no content pages found");
  assert.deepEqual(stale, [], `stale pages: ${stale.join(", ")} — ${REGEN_HINT}`);
});

test("updatePages in-process: --check is read-only and names every stale page, update writes only stale pages, errors are reported per page without aborting the walk", () => {
  const dir = mkdtempSync(join(tmpdir(), "update-csp-pages-"));
  try {
    mkdirSync(join(dir, "nested"));
    const stale = join(dir, "nested", "index.html");
    const fresh = join(dir, "fresh.html");
    const broken = join(dir, "broken.html");
    const redirect = join(dir, "index.html");
    const before = fixture();
    const upToDate = updateCspHashes(before);
    const redirectHtml = '<meta http-equiv="refresh" content="0;url=/">';
    writeFileSync(stale, before);
    writeFileSync(fresh, upToDate);
    writeFileSync(redirect, redirectHtml);
    const run = (options) => {
      const lines = [];
      const code = updatePages({ root: dir, log: (line) => lines.push(line), ...options });
      return { code, lines };
    };

    // --check over the whole root: the stale page is named, the hint is printed once, nothing is written.
    let result = run({ check: true });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, ["Stale: nested/index.html", "Regenerate hashes with: node scripts/update-csp-hashes.mjs"]);
    assert.equal(readFileSync(stale, "utf8"), before);

    // Explicit file selection narrows the walk; an already-correct page is silent and exits 0.
    result = run({ check: true, files: [fresh] });
    assert.deepEqual(result, { code: 0, lines: [] });

    // Update mode rewrites only the stale page; fresh and redirect pages are byte-identical.
    result = run({});
    assert.deepEqual(result, { code: 0, lines: ["Updated: nested/index.html"] });
    assert.equal(readFileSync(stale, "utf8"), upToDate);
    assert.equal(readFileSync(fresh, "utf8"), upToDate);
    assert.equal(readFileSync(redirect, "utf8"), redirectHtml);

    // A second run is clean in both modes.
    assert.deepEqual(run({ check: true }), { code: 0, lines: [] });
    assert.deepEqual(run({}), { code: 0, lines: [] });

    // A page the tool refuses is reported with its message and fails the run, but
    // the walk continues: a stale sibling is still updated in the same pass.
    writeFileSync(broken, "<head></head>");
    writeFileSync(stale, before);
    result = run({});
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, ["Error: broken.html: expected exactly one CSP meta with a content attribute; fix the policy manually", "Updated: nested/index.html"]);
    assert.equal(readFileSync(stale, "utf8"), upToDate);
    assert.equal(readFileSync(broken, "utf8"), "<head></head>");

    // In --check mode an error alone also prints the regenerate hint.
    result = run({ check: true });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, ["Error: broken.html: expected exactly one CSP meta with a content attribute; fix the policy manually", "Regenerate hashes with: node scripts/update-csp-hashes.mjs"]);

    // A missing explicit file is an error for that file, not an uncaught exception.
    result = run({ check: true, files: [join(dir, "missing.html")] });
    assert.equal(result.code, 1);
    assert.equal(result.lines.length, 2);
    assert.match(result.lines[0], /^Error: missing\.html: ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI check is read-only, update reports recursive pages, redirects are skipped, and a second run is clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "update-csp-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "nested"));
    for (const name of ["update-csp-hashes.mjs", "page-csp.mjs", "html-pages.mjs"]) {
      copyFileSync(join(ROOT, "scripts", name), join(dir, "scripts", name));
    }
    const page = join(dir, "nested", "index.html");
    const before = fixture();
    const redirect = '<meta http-equiv="refresh" content="0;url=/">';
    writeFileSync(page, before);
    writeFileSync(join(dir, "index.html"), redirect);
    const run = (...args) => spawnSync(process.execPath, [join(dir, "scripts/update-csp-hashes.mjs"), ...args], { encoding: "utf8", cwd: tmpdir() });
    const untouched = join(dir, "other.html");
    writeFileSync(untouched, before);
    // Resolve the explicit path relative to the caller, not the script root.
    const selected = relative(tmpdir(), page);
    let result = run("--check", selected);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Stale: nested[/\\]index.html/);
    assert.equal(readFileSync(page, "utf8"), before);
    result = run(selected);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated: nested[/\\]index.html/);
    assert.equal(readFileSync(page, "utf8"), updateCspHashes(before));
    assert.equal(readFileSync(untouched, "utf8"), before);
    assert.equal(run("--check", selected).status, 0);
    assert.equal(run("--check").status, 1, "the unselected page must still be stale");
    // Reset so the recursive run below exercises both stale pages.
    writeFileSync(page, before);
    result = run("--check");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Stale: nested[/\\]index.html/);
    assert.match(result.stdout, /node scripts\/update-csp-hashes.mjs/);
    assert.equal(readFileSync(page, "utf8"), before);
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated: nested[/\\]index.html/);
    assert.equal(readFileSync(page, "utf8"), updateCspHashes(before));
    assert.equal(readFileSync(untouched, "utf8"), updateCspHashes(before));
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), redirect);
    assert.equal(run("--check").status, 0);
    assert.equal(run().stdout, "");
    assert.equal(run("--unknown").status, 1);
    writeFileSync(page, "<head></head>");
    result = run("--check");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Error: nested[/\\]index.html: expected exactly one CSP/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
