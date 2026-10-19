#!/usr/bin/env node
// Static gate over the licence files shipped with self-hosted fonts. Each
// family has a licence beside its font bytes; the filename selects the text
// checks. Existing OFL filenames stay valid. Each rule has fixture self-tests.
// Zero dependencies.
//
// Rules:
//   1. Every font family under assets/fonts/ (the file name up to the first
//      `-`: Fraunces-normal-560.woff2 -> Fraunces) has a supported licence:
//      OFL-<Family>.txt, Apache-2.0-<Family>.txt or UFL-<Family>.txt.
//   2. Every licence names a family that still has at least one font file.
//   3. Each licence carries the markers for its type (OFL 1.1, Apache 2.0,
//      or Ubuntu Font Licence 1.0). These are sanity checks, not verification
//      of the entire text or the font's actual licence. Keep the upstream
//      licence text and notices intact; include attribution in the same file.
//   4. assets/fonts/ contains only font files and supported licence files.
// To support another licence, add a LICENSE_TYPES entry and fixture coverage.
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
// Filename patterns and text markers live together so a new licence type
// participates in classification, family matching and validation at once.
const LICENSE_TYPES = [
  {
    pattern: /^OFL-(.+)\.txt$/,
    copyrightFirst: true,
    checks: [
      [/licensed under the SIL Open Font License, Version 1\.1/, 'the "licensed under the SIL Open Font License, Version 1.1" statement'],
      [/SIL OPEN FONT LICENSE Version 1\.1/, "the OFL 1.1 licence body heading"],
    ],
  },
  {
    // https://www.apache.org/licenses/LICENSE-2.0.txt
    pattern: /^Apache-2\.0-(.+)\.txt$/,
    checks: [
      [/Apache License\s+Version 2\.0, January 2004/, "the Apache 2.0 licence body heading"],
      [/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/, "the Apache terms heading"],
      [/END OF TERMS AND CONDITIONS/, "the Apache end-of-terms marker"],
    ],
  },
  {
    // https://canonical.com/legal/font-licence
    pattern: /^UFL-(.+)\.txt$/,
    checks: [
      [/UBUNTU FONT LICEN[CS]E\s+Version 1\.0\b/i, "the Ubuntu Font Licence 1.0 heading"],
      [/PERMISSION & CONDITIONS/i, "the Ubuntu permission and conditions heading"],
      [/DISCLAIMER/i, "the Ubuntu disclaimer heading"],
    ],
  },
];
const LICENSE_NAMES = "OFL-<Family>.txt, Apache-2.0-<Family>.txt or UFL-<Family>.txt";

function licenseOf(name) {
  for (const type of LICENSE_TYPES) {
    const match = type.pattern.exec(name);
    if (match) return { family: match[1], type };
  }
  return null;
}

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
    else if (licenseOf(n)) licenses.push(n);
    else other.push(n);
  }
  return { fonts, licenses, other };
}

// Check markers for the licence type named by the file, not OFL markers for
// every file. Unsupported names fail closed even when called directly.
export function licenseTextProblems(name, text) {
  const license = licenseOf(name);
  if (!license) return [`${name}: unsupported licence filename (expected ${LICENSE_NAMES})`];
  const problems = [];
  if (license.type.copyrightFirst) {
    const first = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
    if (!/^Copyright\b/.test(first)) problems.push(`${name}: first line must be the Copyright notice (found ${JSON.stringify(first)})`);
  }
  for (const [pattern, description] of license.type.checks) {
    if (!pattern.test(text)) problems.push(`${name}: lacks ${description}`);
  }
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
  const licensed = new Set(licenses.map((l) => licenseOf(l).family));
  for (const fam of [...families].sort()) {
    if (!licensed.has(fam)) problems.push(`${fam}: font files are shipped but a licence file is missing (expected ${LICENSE_NAMES.replaceAll("<Family>", fam)})`);
  }
  for (const l of licenses) {
    const fam = licenseOf(l).family;
    if (!families.has(fam)) problems.push(`${l}: no font file of family ${fam} is shipped (stale licence)`);
    problems.push(...licenseTextProblems(l, read(l)));
  }
  for (const o of other) problems.push(`${o}: assets/fonts/ may hold only font files and ${LICENSE_NAMES}`);
  return problems;
}

// --- fixture self-tests -------------------------------------------------------

const OFL = "Copyright 2018 The Fixture Project Authors\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n\n-----\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----\n";
const GOOD_NAMES = ["Alpha-normal-400.woff2", "Alpha-italic-400.woff2", "Beta-normal-500.woff2", "OFL-Alpha.txt", "OFL-Beta.txt"];
const readGood = () => OFL;
// Minimal marker fixture, like OFL above; not a distributable licence text.
const UFL = "Ubuntu Font Licence Version 1.0\n\nPREAMBLE\n\nPERMISSION & CONDITIONS\n\nDISCLAIMER\n";
// This repository's own licence provides a real Apache text with the licence
// heading first (unlike the copyright-first OFL convention).
const APACHE = readFileSync(join(ROOT, "LICENSE"), "utf8");
const MIXED = {
  "OFL-Alpha.txt": OFL,
  "Apache-2.0-Beta.txt": APACHE,
  "UFL-Gamma.txt": UFL,
};
const MIXED_NAMES = ["Alpha-normal-400.woff2", "Beta-normal-500.woff2", "Gamma-normal-400.ttf", ...Object.keys(MIXED)];

test("fixture: familyOf takes the segment before the first dash and rejects names without one", () => {
  assert.equal(familyOf("Fraunces-normal-560.woff2"), "Fraunces");
  assert.equal(familyOf("IBMPlexSans-italic-400.woff2"), "IBMPlexSans");
  assert.equal(familyOf("logo.woff2"), null);
});

test("fixture: classify sorts a listing into fonts, supported licences and everything else", () => {
  assert.deepEqual(classify(["z.txt", "OFL-A.txt", "A-normal-400.woff2", "A-normal-400.ttf", "readme.md"]), {
    fonts: ["A-normal-400.ttf", "A-normal-400.woff2"],
    licenses: ["OFL-A.txt"],
    other: ["readme.md", "z.txt"],
  });
});

test("fixture: two licensed families pass", () => {
  assert.deepEqual(fontLicenseProblems({ names: GOOD_NAMES, read: readGood }), []);
});

test("fixture: OFL, Apache and Ubuntu licences coexist and match their font families", () => {
  assert.deepEqual(classify(MIXED_NAMES).licenses, ["Apache-2.0-Beta.txt", "OFL-Alpha.txt", "UFL-Gamma.txt"]);
  assert.deepEqual(fontLicenseProblems({ names: MIXED_NAMES, read: (n) => MIXED[n] }), []);
});

test("fixture: every supported licence type rejects missing, stale and mismatched files", () => {
  for (const [name, text] of Object.entries(MIXED)) {
    const family = licenseOf(name).family;
    const font = `${family}-normal-400.woff2`;
    assert.deepEqual(fontLicenseProblems({ names: [font, name], read: () => text }), []);
    const missing = fontLicenseProblems({ names: [font], read: () => assert.fail("no licence to read") });
    assert.equal(missing.length, 1);
    assert.ok(missing[0].includes(family) && missing[0].includes(name), missing[0]);
    const stale = fontLicenseProblems({ names: ["Other-normal-400.woff2", "OFL-Other.txt", name], read: (n) => n === name ? text : OFL });
    assert.deepEqual(stale, [`${name}: no font file of family ${family} is shipped (stale licence)`]);
    assert.ok(licenseTextProblems(name, "").length > 0, `${name}: empty text must fail`);
    for (const [otherName, otherText] of Object.entries(MIXED)) {
      if (otherName === name) continue;
      assert.ok(fontLicenseProblems({ names: [font, name], read: () => otherText }).length > 0,
        `${name}: must reject text from ${otherName}`);
    }
  }
});

test("fixture: non-OFL text checks tolerate line endings and leading copyright notices", () => {
  for (const [name, text] of [["Apache-2.0-X.txt", APACHE], ["UFL-X.txt", UFL]]) {
    assert.deepEqual(licenseTextProblems(name, text), []);
    assert.deepEqual(licenseTextProblems(name, `Copyright 2026 Fixture Authors\n\n${text}`.replaceAll("\n", "\r\n")), []);
  }
});

test("fixture: non-OFL licences require their own version and body markers", () => {
  for (const marker of ["Apache License", "Version 2.0", "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION", "END OF TERMS AND CONDITIONS"]) {
    assert.ok(licenseTextProblems("Apache-2.0-X.txt", APACHE.replaceAll(marker, "removed")).length > 0, marker);
  }
  for (const marker of ["Ubuntu Font Licence", "Version 1.0", "PERMISSION & CONDITIONS", "DISCLAIMER"]) {
    assert.ok(licenseTextProblems("UFL-X.txt", UFL.replaceAll(marker, "removed")).length > 0, marker);
  }
  assert.ok(licenseTextProblems("Apache-2.0-X.txt", APACHE.replaceAll("Version 2.0", "Version 1.1")).length > 0);
  assert.ok(licenseTextProblems("UFL-X.txt", UFL.replace("Version 1.0", "Version 2.0")).length > 0);
});

test("fixture: unsupported and malformed licence names do not satisfy a font's licence", () => {
  for (const name of ["MIT-Alpha.txt", "Apache-1.1-Alpha.txt", "Apache-2.0-.txt", "OFL-.txt", "UFL-.txt", "UFL-Alpha.md"]) {
    assert.deepEqual(classify([name]), { fonts: [], licenses: [], other: [name] });
    assert.match(licenseTextProblems(name, OFL)[0], /unsupported licence filename/);
    const problems = fontLicenseProblems({ names: ["Alpha-normal-400.woff2", name], read: () => assert.fail("unsupported file must not be read") });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /Alpha:.*licence file is missing/);
    assert.match(problems[1], /may hold only font files/);
  }
});

test("fixture: a family without its licence is reported, naming the supported files", () => {
  const p = fontLicenseProblems({ names: GOOD_NAMES.filter((n) => n !== "OFL-Beta.txt"), read: readGood });
  assert.deepEqual(p, ["Beta: font files are shipped but a licence file is missing (expected OFL-Beta.txt, Apache-2.0-Beta.txt or UFL-Beta.txt)"]);
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

test("assets/fonts/: every shipped font family carries a supported licence file and nothing else is in the directory", () => {
  const names = readdirSync(FONT_DIR);
  const read = (n) => readFileSync(join(FONT_DIR, n), "utf8");
  assert.deepEqual(fontLicenseProblems({ names, read }), []);
  const { fonts, licenses } = classify(names);
  assert.ok(fonts.length >= 2 && licenses.length >= 2, `expected the Fraunces and IBM Plex Sans families with licences, got ${names.join(", ")}`);
});
