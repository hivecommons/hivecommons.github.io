#!/usr/bin/env node
// Static gate for .well-known/security.txt (RFC 9116). The file carries an
// Expires field; once it passes, scanners treat the contact as abandoned, and
// nothing else reads it (links.yml only probes that the URL answers 200).
// Fails while there is still time to rotate: Expires must be a valid RFC 3339
// timestamp at least 30 days away and no more than ~1 year ahead (RFC 9116
// recommends under a year). Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/security-txt.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const SECURITY_TXT = readFileSync(join(ROOT, ".well-known", "security.txt"), "utf8");

const CANONICAL = "https://hivecommons.dev/.well-known/security.txt";
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DAYS = 30;
const MAX_DAYS = 366;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function parseFields(text) {
  const fields = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*?)\s*$/);
    if (m) fields.push({ name: m[1].toLowerCase(), value: m[2] });
    else fields.push({ name: null, value: line });
  }
  return fields;
}

// Returns a list of problems; empty means the file is healthy at `now`.
export function check(text, now) {
  const problems = [];
  const fields = parseFields(text);
  for (const f of fields) if (f.name === null) problems.push(`not a field line: ${JSON.stringify(f.value)}`);
  const named = (n) => fields.filter((f) => f.name === n);

  const expires = named("expires");
  if (expires.length !== 1) problems.push(`expected exactly one Expires field, found ${expires.length}`);
  if (!named("contact").length) problems.push("no Contact field");
  const canonical = named("canonical");
  if (!canonical.some((f) => f.value === CANONICAL)) problems.push(`Canonical must include ${CANONICAL}`);

  if (expires.length === 1) {
    const v = expires[0].value;
    const t = RFC3339.test(v) ? Date.parse(v) : NaN;
    if (Number.isNaN(t)) {
      problems.push(`Expires is not a valid RFC 3339 timestamp: ${JSON.stringify(v)}`);
    } else {
      const days = (t - now.getTime()) / DAY_MS;
      if (days <= 0) problems.push(`Expires ${v} is in the past — rotate it`);
      else if (days < MIN_DAYS) problems.push(`Expires ${v} is only ${Math.floor(days)} days away (< ${MIN_DAYS}) — rotate it now`);
      else if (days > MAX_DAYS) problems.push(`Expires ${v} is ${Math.floor(days)} days away (> ${MAX_DAYS}); RFC 9116 recommends under a year`);
    }
  }
  return problems;
}

// --- fixture self-tests ------------------------------------------------------

const NOW = new Date("2026-10-14T00:00:00Z");

function fixture({ expires = ["Expires: 2027-01-01T00:00:00.000Z"], contact = ["Contact: mailto:a@example.com"], canonical = [`Canonical: ${CANONICAL}`], extra = [] } = {}) {
  return ["# comment", ...contact, ...expires, ...canonical, ...extra, ""].join("\n");
}

test("a well-formed fixture passes", () => {
  assert.deepEqual(check(fixture(), NOW), []);
});

test("parseFields skips comments and blanks and flags non-field lines", () => {
  assert.deepEqual(parseFields("# c\n\nContact: x\nbogus line\n"), [
    { name: "contact", value: "x" },
    { name: null, value: "bogus line" },
  ]);
  assert.match(check(fixture({ extra: ["bogus line"] }), NOW).join("\n"), /not a field line/);
});

test("exactly one Expires is required", () => {
  assert.match(check(fixture({ expires: [] }), NOW).join("\n"), /exactly one Expires.*found 0/);
  const two = ["Expires: 2027-01-01T00:00:00Z", "Expires: 2027-02-01T00:00:00Z"];
  assert.match(check(fixture({ expires: two }), NOW).join("\n"), /exactly one Expires.*found 2/);
});

test("at least one Contact is required", () => {
  assert.match(check(fixture({ contact: [] }), NOW).join("\n"), /no Contact/);
});

test("Canonical must match the published URL", () => {
  assert.match(check(fixture({ canonical: [] }), NOW).join("\n"), /Canonical must include/);
  assert.match(check(fixture({ canonical: ["Canonical: https://example.com/.well-known/security.txt"] }), NOW).join("\n"), /Canonical must include/);
});

test("Expires must be a valid RFC 3339 timestamp", () => {
  for (const bad of ["tomorrow", "2027-01-01", "2027-13-01T00:00:00Z", "2027-01-01 00:00:00Z"]) {
    assert.match(check(fixture({ expires: [`Expires: ${bad}`] }), NOW).join("\n"), /not a valid RFC 3339/, bad);
  }
  assert.deepEqual(check(fixture({ expires: ["Expires: 2027-01-01T00:00:00+02:00"] }), NOW), []);
});

test("Expires must be in the future and at least 30 days away", () => {
  assert.match(check(fixture({ expires: ["Expires: 2026-10-01T00:00:00Z"] }), NOW).join("\n"), /in the past/);
  assert.match(check(fixture({ expires: ["Expires: 2026-11-01T00:00:00Z"] }), NOW).join("\n"), /only 18 days away/);
  assert.deepEqual(check(fixture({ expires: ["Expires: 2026-11-14T00:00:00Z"] }), NOW), []);
});

test("Expires must be no more than ~1 year ahead", () => {
  assert.match(check(fixture({ expires: ["Expires: 2028-01-01T00:00:00Z"] }), NOW).join("\n"), /recommends under a year/);
  assert.deepEqual(check(fixture({ expires: ["Expires: 2027-10-15T00:00:00Z"] }), NOW), []);
});

// --- live check --------------------------------------------------------------

test(".well-known/security.txt is well-formed and its Expires is neither stale nor too far out", () => {
  assert.deepEqual(check(SECURITY_TXT, new Date()), [], "rotate Expires in .well-known/security.txt (see runbooks/)");
});
