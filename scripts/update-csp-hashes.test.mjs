// Fixture self-test for scripts/update-csp-hashes.mjs, the tool that rewrites a
// page's CSP script-src allow-list after an inline script changes, plus a pin
// on the live tree: every committed page must already be up to date, so the
// tool and the page-csp.test.mjs gate agree on what "correct" means.
// Zero dependencies. Usage: node --test scripts/update-csp-hashes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ROOT, htmlFiles, isRedirectPage } from "./html-pages.mjs";
import { REGEN_HINT, problemsOf, sha256Source } from "./page-csp.mjs";
import { UNSAFE_HASHES, run, updatedCsp, wantedScriptSrc } from "./update-csp-hashes.mjs";

const BASE = "default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'";
const OK = sha256Source("console.log(1)");
const STALE = sha256Source("console.log(0)");
const HANDLER = sha256Source("this.hidden=true");

function page({ csp, script = "console.log(1)", handler = "", quote = '"' } = {}) {
  const meta = csp === null ? "" : `<meta http-equiv=${quote}Content-Security-Policy${quote} content=${quote}${csp}${quote}>`;
  return `<!doctype html><html><head><meta charset="utf-8">${meta}<title>x</title></head><body><p${handler ? ` onerror="${handler}"` : ""}></p><script type="application/ld+json">{"@type":"Thing"}</script><script>${script}</script></body></html>`;
}

function scriptSrcOf(html) {
  return /script-src ([^;"]*)/.exec(html)[1];
}

test("fixture: an up-to-date policy is left byte-identical", () => {
  const html = page({ csp: `${BASE}; script-src ${OK}` });
  assert.deepEqual(updatedCsp(html), { html, changed: false });
});

test("fixture: a drifted hash is replaced and the gate then passes", () => {
  const before = page({ csp: `${BASE}; script-src ${STALE}` });
  assert.ok(problemsOf(before).length > 0);
  const { html, changed } = updatedCsp(before);
  assert.equal(changed, true);
  assert.equal(scriptSrcOf(html), OK);
  assert.deepEqual(problemsOf(html), []);
});

test("fixture: non-hash tokens keep their order; only the managed tokens are rewritten", () => {
  const before = page({ csp: `${BASE}; script-src 'self' ${STALE} https://cdn.example 'strict-dynamic'` });
  const { html } = updatedCsp(before);
  assert.equal(scriptSrcOf(html), `'self' https://cdn.example 'strict-dynamic' ${OK}`);
});

test("fixture: token order is not enforced; a policy the gate accepts is never rewritten", () => {
  const h1 = sha256Source("console.log(1)");
  const h2 = sha256Source("console.log(2)");
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="${BASE}; script-src ${h2} 'self' ${h1}"></head><body><script>console.log(1)</script><script>console.log(2)</script></body></html>`;
  assert.deepEqual(problemsOf(html), []);
  assert.deepEqual(updatedCsp(html), { html, changed: false });
});

test("fixture: other directives, their order and the `; ` separators are preserved", () => {
  const before = page({ csp: `style-src 'self' 'unsafe-inline'; ${BASE}; script-src ${STALE}; font-src 'self'` });
  const { html } = updatedCsp(before);
  assert.ok(html.includes(`content="style-src 'self' 'unsafe-inline'; ${BASE}; script-src ${OK}; font-src 'self'"`), html);
});

test("fixture: an inline handler adds 'unsafe-hashes' and its hash; removing the handler drops both", () => {
  const withHandler = updatedCsp(page({ csp: `${BASE}; script-src ${OK}`, handler: "this.hidden=true" }));
  assert.equal(withHandler.changed, true);
  assert.equal(scriptSrcOf(withHandler.html), `${OK} ${UNSAFE_HASHES} ${HANDLER}`);
  assert.deepEqual(problemsOf(withHandler.html), []);

  const without = updatedCsp(page({ csp: `${BASE}; script-src ${OK} ${UNSAFE_HASHES} ${HANDLER}` }));
  assert.equal(without.changed, true);
  assert.equal(scriptSrcOf(without.html), OK);
  assert.deepEqual(problemsOf(without.html), []);
});

test("fixture: wantedScriptSrc never repeats a hash two identical scripts share", () => {
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head><body><script>a()</script><script>a()</script></body></html>`;
  assert.deepEqual(wantedScriptSrc(html, ["'self'"]), ["'self'", sha256Source("a()")]);
});

test("fixture: a single-quoted content attribute is rewritten too", () => {
  const before = `<html><head><meta http-equiv='Content-Security-Policy' content='default-src "none"; script-src ${STALE}'></head><body><script>console.log(1)</script></body></html>`;
  const { html, changed } = updatedCsp(before);
  assert.equal(changed, true);
  assert.ok(html.includes(`script-src ${OK}`), html);
});

test("fixture: redirect pages and pages without a policy or script-src are skipped, not rewritten", () => {
  const redirect = `<html><head><meta http-equiv="refresh" content="0; url=/x/"><script>console.log(1)</script></head></html>`;
  assert.deepEqual(updatedCsp(redirect), { html: redirect, changed: false, skipped: "redirect page" });
  const none = page({ csp: null, script: "console.log(0)" });
  assert.deepEqual(updatedCsp(none), { html: none, changed: false, skipped: "no CSP meta" });
  const noScriptSrc = page({ csp: BASE, script: "console.log(0)" });
  assert.deepEqual(updatedCsp(noScriptSrc), { html: noScriptSrc, changed: false, skipped: "no script-src directive" });
});

test("fixture: --check reports stale pages and exits 1 without writing; a plain run rewrites and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "csp-hashes-"));
  const stale = join(dir, "stale.html");
  const fresh = join(dir, "fresh.html");
  writeFileSync(stale, page({ csp: `${BASE}; script-src ${STALE}` }));
  writeFileSync(fresh, page({ csp: `${BASE}; script-src ${OK}` }));

  const checkLog = [];
  const writes = [];
  assert.equal(run(["--check", stale, fresh], { root: dir, write: (f, c) => writes.push(f), log: (l) => checkLog.push(l) }), 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(checkLog, ["stale stale.html: script-src hashes do not match its inline scripts (run node scripts/update-csp-hashes.mjs)"]);

  const log = [];
  assert.equal(run([stale, fresh], { root: dir, log: (l) => log.push(l) }), 0);
  assert.deepEqual(log, ["updated stale.html"]);
  assert.deepEqual(problemsOf(readFileSync(stale, "utf8")), []);
  assert.equal(run(["--check", stale, fresh], { root: dir, log: () => {} }), 0);
});

test("fixture: with no files a plain run says every page is current and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "csp-hashes-"));
  writeFileSync(join(dir, "a.html"), page({ csp: `${BASE}; script-src ${OK}` }));
  const log = [];
  assert.equal(run([], { root: dir, log: (l) => log.push(l) }), 0);
  assert.deepEqual(log, ["every CSP meta already matches its inline scripts"]);
});

// --- live tree --------------------------------------------------------------

test("live tree: every committed content page is already up to date (`--check` would exit 0)", () => {
  const stale = [];
  let pages = 0;
  for (const file of htmlFiles()) {
    const html = readFileSync(file, "utf8");
    if (isRedirectPage(html)) continue;
    pages += 1;
    const { changed, skipped } = updatedCsp(html);
    if (changed || skipped) stale.push(`${relative(ROOT, file)}${skipped ? ` (${skipped})` : ""}`);
  }
  assert.ok(pages > 0, "no content pages found");
  assert.deepEqual(stale, [], `pages whose CSP script-src is stale: ${stale.join(", ")} — ${REGEN_HINT}`);
});
