#!/usr/bin/env node
// Regenerates the sha256- allow-list in every page's
// <meta http-equiv="Content-Security-Policy"> after an inline <script> body or
// on*= handler changes, so the page-csp.test.mjs gate stays green without
// anyone computing a hash by hand. Every non-hash token of script-src is kept
// in place; 'unsafe-hashes' is added when the page has inline event handlers
// and dropped when it has none. Redirect shortcut pages (meta refresh, no
// scripts) and pages without a policy or a script-src directive are left
// untouched and reported, since the gate owns those rules.
// Zero dependencies.
//
// Usage: node scripts/update-csp-hashes.mjs [--check] [page.html ...]
//   (no files)  every committed non-redirect .html page
//   --check     report pages whose policy is stale and exit 1; write nothing
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, htmlFiles, isRedirectPage } from "./html-pages.mjs";
import { attrs, inlineHandlerSources, inlineScriptSources, parseCsp, sha256Source } from "./page-csp.mjs";

export const UNSAFE_HASHES = "'unsafe-hashes'";

// Tokens the tool owns: hash sources and the 'unsafe-hashes' flag.
function isManaged(token) {
  return token.startsWith("'sha256-") || token.startsWith("'sha384-") || token.startsWith("'sha512-") || token === UNSAFE_HASHES;
}

// The script-src token list the page needs: the policy's own non-hash tokens in
// their original order, then one hash per inline script body (in page order),
// then 'unsafe-hashes' and one hash per distinct handler body when handlers exist.
export function wantedScriptSrc(html, current) {
  const kept = current.filter((t) => !isManaged(t));
  const scripts = inlineScriptSources(html).map(sha256Source);
  const handlers = inlineHandlerSources(html).map(sha256Source);
  const out = [...kept];
  for (const h of scripts) if (!out.includes(h)) out.push(h);
  if (handlers.length > 0) {
    out.push(UNSAFE_HASHES);
    for (const h of handlers) if (!out.includes(h)) out.push(h);
  }
  return out;
}

// Rewrite only the script-src directive inside the policy's content attribute,
// preserving directive order and the `; ` separators the pages use.
export function updatedCsp(html) {
  if (isRedirectPage(html)) return { html, changed: false, skipped: "redirect page" };
  const csp = parseCsp(html);
  if (!csp) return { html, changed: false, skipped: "no CSP meta" };
  if (!csp.directives["script-src"]) return { html, changed: false, skipped: "no script-src directive" };

  const current = csp.directives["script-src"];
  const wanted = wantedScriptSrc(html, current);
  if (wanted.length === current.length && wanted.every((t, i) => t === current[i])) return { html, changed: false };

  const content = attrs(csp.tag).content ?? "";
  const rebuilt = content.split(";").map((p) => p.trim()).filter(Boolean).map((part) => {
    const tokens = part.split(/\s+/);
    return tokens[0].toLowerCase() === "script-src" ? ["script-src", ...wanted].join(" ") : tokens.join(" ");
  }).join("; ");
  const newTag = csp.tag.replace(/(\scontent\s*=\s*)(?:"[^"]*"|'[^']*')/i, (m, prefix) => `${prefix}"${rebuilt}"`);
  const headStart = html.search(/<head\b/i);
  const at = html.indexOf(csp.tag, headStart < 0 ? 0 : headStart);
  return { html: html.slice(0, at) + newTag + html.slice(at + csp.tag.length), changed: true };
}

export function run(argv, { root = ROOT, write = writeFileSync, log = console.log } = {}) {
  const check = argv.includes("--check");
  const files = argv.filter((a) => a !== "--check");
  const pages = files.length ? files.map((f) => resolve(f)) : htmlFiles(root);
  let stale = 0;
  for (const file of pages) {
    const rel = relative(root, file);
    const before = readFileSync(file, "utf8");
    const { html, changed, skipped } = updatedCsp(before);
    if (skipped) {
      if (files.length) log(`skipped ${rel}: ${skipped}`);
      continue;
    }
    if (!changed) continue;
    stale += 1;
    if (check) {
      log(`stale ${rel}: script-src hashes do not match its inline scripts (run node scripts/update-csp-hashes.mjs)`);
    } else {
      write(file, html);
      log(`updated ${rel}`);
    }
  }
  if (check) return stale === 0 ? 0 : 1;
  if (stale === 0) log("every CSP meta already matches its inline scripts");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
