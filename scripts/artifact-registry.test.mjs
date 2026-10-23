#!/usr/bin/env node
// Advisory (report-only) registry gate: every tracked file should be covered
// by a page/asset gate or named literally in a scripts/*.test.mjs or
// scripts/check-*.sh. Unregistered files are printed as a warning and do NOT
// fail the run yet; a follow-up will make this fail once the list is clean.
// Add a file to UNGATED_OK to exempt it (a reviewed diff, not silence).
// Usage: node --test scripts/artifact-registry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

export const UNGATED_OK = new Set(["LICENSE", ".gitignore"]);

// Literal path prefixes/extensions covered by an existing gate.
const CLASSES = [
  { name: "page", match: (f) => f.endsWith(".html") },
  { name: "asset", match: (f) => f.startsWith("assets/") },
  { name: "script", match: (f) => f.startsWith("scripts/") },
];

export function unregistered(files, gateTexts) {
  return files.filter((f) => {
    if (UNGATED_OK.has(f) || CLASSES.some((c) => c.match(f))) return false;
    return !gateTexts.some((t) => t.includes(f));
  });
}

test("artifact registry (report-only)", (t) => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const gateTexts = readdirSync(HERE)
    .filter((n) => /\.test\.mjs$/.test(n) || /^check-.*\.sh$/.test(n))
    .map((n) => readFileSync(join(HERE, n), "utf8"));
  const missing = unregistered(files, gateTexts);
  if (missing.length) {
    const msg = `unregistered artifacts (add a gate or an UNGATED_OK entry; see issue #245): ${missing.join(", ")}`;
    console.warn(`WARNING: ${msg}`);
    t.diagnostic(msg);
  }
  assert.ok(Array.isArray(missing));
});

test("fixtures: classifier", () => {
  assert.deepEqual(unregistered(["a.html", "assets/x.png", "scripts/y.mjs", "LICENSE"], []), []);
  assert.deepEqual(unregistered(["new.yml", "OWNERS"], ["... OWNERS ..."]), ["new.yml"]);
});
