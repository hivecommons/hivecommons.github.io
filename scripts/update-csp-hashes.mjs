#!/usr/bin/env node
// Regenerate only script-src hashes; never relax or invent a page's policy.
// Rewrites sha256- tokens (and 'unsafe-hashes') on non-redirect pages;
// preserves every other token, directive and surrounding byte. Missing or
// duplicate policies/directives and incompatible attribute quotes are errors.
// Usage: node scripts/update-csp-hashes.mjs [--check] [page.html ...]
//   (no files)  every committed non-redirect .html page
//   --check     report stale pages and exit 1; write nothing
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, htmlFiles, isRedirectPage } from "./html-pages.mjs";
import { parseCsp, inlineScriptSources, inlineHandlerSources, sha256Source } from "./page-csp.mjs";

// Token order has no meaning in CSP. Don't churn already-correct policies.
function sameTokens(a, b) {
  return a.length === b.length && a.every((token) => b.includes(token)) && b.every((token) => a.includes(token));
}

export function updateCspHashes(html) {
  if (isRedirectPage(html)) return html;
  const csp = parseCsp(html);
  if (!csp || csp.count !== 1 || csp.content === null) {
    throw new Error("expected exactly one CSP meta with a content attribute; fix the policy manually");
  }
  const directives = [...csp.content.matchAll(/(^|;)(\s*script-src(?=\s|;|$))(\s*)([^;]*)/gi)];
  if (directives.length !== 1) throw new Error("expected exactly one script-src directive; fix the policy manually");
  const directive = directives[0];
  const oldTokens = directive[4].trim().split(/\s+/).filter(Boolean);
  const scripts = inlineScriptSources(html).map(sha256Source);
  const handlers = inlineHandlerSources(html).map(sha256Source);
  const tokens = [
    ...oldTokens.filter((t) => !/^'sha(?:256|384|512)-/.test(t) && t !== "'unsafe-hashes'"),
    ...new Set([...scripts, ...(handlers.length ? ["'unsafe-hashes'", ...handlers] : [])]),
  ];
  if (sameTokens(oldTokens, tokens)) return html;
  const value = (directive[3] ? "" : " ") + tokens.join(" ");
  if (value.includes(csp.contentQuote)) throw new Error("CSP attribute quote conflicts with source tokens; use double quotes");
  const start = csp.contentAt + directive.index + directive[1].length + directive[2].length + directive[3].length;
  const end = start + directive[4].trimEnd().length;
  return html.slice(0, start) + value + html.slice(end);
}

export function updatePages({ root = ROOT, check = false, files = [], log = console.log } = {}) {
  let failed = false;
  for (const file of files.length ? files.map((file) => resolve(file)) : htmlFiles(root)) {
    const name = relative(root, file);
    try {
      const html = readFileSync(file, "utf8");
      const updated = updateCspHashes(html);
      if (updated === html) continue;
      log(`${check ? "Stale" : "Updated"}: ${name}`);
      if (check) failed = true;
      else writeFileSync(file, updated);
    } catch (error) {
      log(`Error: ${name}: ${error.message}`);
      failed = true;
    }
  }
  if (check && failed) log("Regenerate hashes with: node scripts/update-csp-hashes.mjs");
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg.startsWith("-") && arg !== "--check")) {
    console.error("Usage: node scripts/update-csp-hashes.mjs [--check] [page.html ...]");
    process.exitCode = 1;
  } else {
    process.exitCode = updatePages({ check: args.includes("--check"), files: args.filter((arg) => arg !== "--check") });
  }
}
