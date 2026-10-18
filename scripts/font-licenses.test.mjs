#!/usr/bin/env node
// Static gate over the licence files that must travel with the self-hosted
// fonts under assets/fonts/. Fraunces and IBM Plex Sans are SIL Open Font
// License 1.1 fonts; the OFL requires that the licence text (with its
// copyright notice and Reserved Font Name) accompany every copy of the Font
// Software, so each family ships an `OFL-<Family>.txt` next to its .woff2
// files. style-contract.test.mjs checks that every @font-face url() resolves
// to real font bytes and that no font file is unreferenced; nothing checks
// the licence files. Delete OFL-Fraunces.txt or add a third family without
// its licence and CI is green. Each rule has a fixture self-test. Zero
// dependencies.
//
// Rules:
//   1. Every font family under assets/fonts/ (the file name up to the first
//      `-`: Fraunces-normal-560.woff2 -> Fraunces) has an OFL-<Family>.txt.
//   2. Every OFL-*.txt names a family that still has at least one font file
//      (a licence for a font that was removed is stale and misleading).
//   3. Each licence file is the OFL 1.1 text: it opens with a Copyright
//      notice, says the Font Software is under the SIL Open Font License
//      Version 1.1, and carries the licence body's own heading.
//   4. assets/fonts/ contains nothing but font files and OFL-*.txt.
// Usage: node --test scripts/font-licenses.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FONT_DIR = join(ROOT, "assets", "fonts");

const FONT_RE = /\.(?:woff2?|ttf|otf)$/i;
const LICENSE_RE = /^OFL-(.+)\.txt$/;

// Family a font file name belongs to: the segment before the first `-`.
export function familyOf(fileName) {
  const m = /^([^-]+)-/.exec(fileName);
  return m ? m[1] : null;
}

// Split a directory listing into font files, licence files and anything else.
export function classify(names) {
  const fonts = [];
  const licenses = [];
  const other = [];
  for (const n of [...names].sort()) {
    if (FONT_RE.test(n)) fonts.push(n);
    else if (LICENSE_RE.test(n)) licenses.push(n);
    else other.push(n);
  }
  return { fonts, licenses, other };
}

// Checks the text of one OFL-<Family>.txt. Returns [] when it is the OFL 1.1
// text with a copyright notice, else one message per missing piece.
export function licenseTextProblems(name, text) {
  const problems = [];
  const first = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  if (!/^Copyright\b/.test(first)) problems.push(`${name}: first line must be the Copyright notice (found ${JSON.stringify(first)})`);
  if (!/licensed under the SIL Open Font License, Version 1\.1/.test(text)) problems.push(`${name}: lacks the "licensed under the SIL Open Font License, Version 1.1" statement`);
  if (!/SIL OPEN FONT LICENSE Version 1\.1/.test(text)) problems.push(`${name}: lacks the OFL 1.1 licence body heading`);
  return problems;
}

export function fontLicenseProblems({ names, read }) {
  const { fonts, licenses, other } = classify(names);
  const problems = [];
  if (fonts.length === 0) problems.push("assets/fonts/ holds no font files — nothing to license (the gate would pass vacuously)");
  const families = new Set();
  for (const f of fonts) {
    const fam = familyOf(f);
    if (!fam) { problems.push(`${f}: font file name is not <Family>-<style>-<weight>.<ext>, so its licence cannot be matched`); continue; }
    families.add(fam);
  }
  const licensed = new Set(licenses.map((l) => LICENSE_RE.exec(l)[1]));
  for (const fam of [...families].sort()) {
    if (!licensed.has(fam)) problems.push(`${fam}: font files are shipped but assets/fonts/OFL-${fam}.txt is missing`);
  }
  for (const l of licenses) {
    const fam = LICENSE_RE.exec(l)[1];
    if (!families.has(fam)) problems.push(`${l}: no font file of family ${fam} is shipped (stale licence)`);
    problems.push(...licenseTextProblems(l, read(l)));
  }
  for (const o of other) problems.push(`${o}: assets/fonts/ may hold only font files and OFL-<Family>.txt`);
  return problems;
}

// --- fixture self-tests -------------------------------------------------------

const OFL = "Copyright 2018 The Fixture Project Authors\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n\n-----\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----\n";
const GOOD_NAMES = ["Alpha-normal-400.woff2", "Alpha-italic-400.woff2", "Beta-normal-500.woff2", "OFL-Alpha.txt", "OFL-Beta.txt"];
const readGood = () => OFL;

test("fixture: familyOf takes the segment before the first dash and rejects names without one", () => {
  assert.equal(familyOf("Fraunces-normal-560.woff2"), "Fraunces");
  assert.equal(familyOf("IBMPlexSans-italic-400.woff2"), "IBMPlexSans");
  assert.equal(familyOf("logo.woff2"), null);
});

test("fixture: classify sorts a listing into fonts, OFL licences and everything else", () => {
  assert.deepEqual(classify(["z.txt", "OFL-A.txt", "A-normal-400.woff2", "A-normal-400.ttf", "readme.md"]), {
    fonts: ["A-normal-400.ttf", "A-normal-400.woff2"],
    licenses: ["OFL-A.txt"],
    other: ["readme.md", "z.txt"],
  });
});

test("fixture: two licensed families pass", () => {
  assert.deepEqual(fontLicenseProblems({ names: GOOD_NAMES, read: readGood }), []);
});

test("fixture: a family without its OFL file is reported, naming the file to add", () => {
  const p = fontLicenseProblems({ names: GOOD_NAMES.filter((n) => n !== "OFL-Beta.txt"), read: readGood });
  assert.deepEqual(p, ["Beta: font files are shipped but assets/fonts/OFL-Beta.txt is missing"]);
});

test("fixture: a licence whose family no longer ships is reported as stale", () => {
  const p = fontLicenseProblems({ names: GOOD_NAMES.filter((n) => !n.startsWith("Beta-")), read: readGood });
  assert.deepEqual(p, ["OFL-Beta.txt: no font file of family Beta is shipped (stale licence)"]);
});

test("fixture: a licence file that is not the OFL 1.1 text is reported per missing piece", () => {
  assert.deepEqual(licenseTextProblems("OFL-X.txt", OFL), []);
  const p = licenseTextProblems("OFL-X.txt", "MIT License\n\nPermission is hereby granted...\n");
  assert.equal(p.length, 3, p.join("\n"));
  assert.match(p[0], /first line must be the Copyright notice \(found "MIT License"\)/);
  assert.match(p[1], /lacks the "licensed under the SIL Open Font License, Version 1\.1" statement/);
  assert.match(p[2], /lacks the OFL 1\.1 licence body heading/);
  assert.deepEqual(licenseTextProblems("OFL-X.txt", "\n\n" + OFL), [], "leading blank lines before the Copyright notice are fine");
  assert.equal(licenseTextProblems("OFL-X.txt", "").length, 3);
});

test("fixture: a stray file in assets/fonts/, an unnamed font file and an empty directory are reported", () => {
  const p = fontLicenseProblems({ names: [...GOOD_NAMES, "notes.md", "logo.woff2"], read: readGood }).join("\n");
  assert.match(p, /notes\.md: assets\/fonts\/ may hold only font files and OFL-<Family>\.txt/);
  assert.match(p, /logo\.woff2: font file name is not <Family>-<style>-<weight>\.<ext>/);
  assert.deepEqual(fontLicenseProblems({ names: [], read: readGood }), ["assets/fonts/ holds no font files — nothing to license (the gate would pass vacuously)"]);
});

// --- live tree ----------------------------------------------------------------

test("assets/fonts/: every shipped font family carries its OFL 1.1 licence file and nothing else is in the directory", () => {
  const names = readdirSync(FONT_DIR);
  const read = (n) => readFileSync(join(FONT_DIR, n), "utf8");
  assert.deepEqual(fontLicenseProblems({ names, read }), []);
  const { fonts, licenses } = classify(names);
  assert.ok(fonts.length >= 2 && licenses.length >= 2, `expected the Fraunces and IBM Plex Sans families with licences, got ${names.join(", ")}`);
});
