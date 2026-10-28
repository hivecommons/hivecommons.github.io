#!/usr/bin/env node
// Static gate over every `OWNERS` file in the tree (and `OWNERS_ALIASES` when
// present). Prow's `approve` plugin and tide read these files directly, and
// their failure mode is silent: a typo'd key (`approver:`), a tab-indented
// list, an `@`-prefixed handle, an email instead of a login, an empty
// `approvers:` list or a stray nested `OWNERS` all parse as "no approvers
// here", after which `/approve` is ignored and tide never merges — with
// nothing in CI going red. Each rule has a fixture self-test. Zero
// dependencies.
//
// Rules:
//   1. The root `OWNERS` exists. Every `OWNERS` file parses as top-level
//      `key:` blocks of `- item` lines indented with spaces (no tabs, no
//      nesting beyond `options:` booleans).
//   2. Only keys prow knows (`approvers`, `reviewers`, `emeritus_approvers`,
//      `emeritus_reviewers`, `labels`, `options`); `options` holds only
//      known boolean flags.
//   3. The root file has a non-empty `approvers:` list.
//   4. Every entry under a people key is a syntactically valid GitHub login
//      (no `@`, no email, 1-39 chars, hyphen rules) or an alias declared in
//      `OWNERS_ALIASES`. Login syntax only: the gate has no network access.
//   5. No duplicate entries within a list (case-insensitive) and no login
//      listed as both active and emeritus for the same role.
// Usage: node --test scripts/owners-file.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

export const PEOPLE_KEYS = new Set(["approvers", "reviewers", "emeritus_approvers", "emeritus_reviewers"]);
export const KNOWN_KEYS = new Set([...PEOPLE_KEYS, "labels", "options"]);
export const KNOWN_OPTIONS = new Set(["no_parent_owners", "auto_approve_unowned_subfolders"]);
export const SKIP_DIRS = new Set([".git", "node_modules"]);

// GitHub login: alphanumerics and single hyphens, no leading/trailing hyphen, max 39.
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// --- flat YAML -------------------------------------------------------------

// Strips a trailing ` # comment` and surrounding quotes from a scalar.
function scalar(raw) {
  let v = raw.replace(/\s+#.*$/, "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

// Parses the subset of YAML prow OWNERS files use: top-level `key:` followed
// by `  - item` lines, or `key:` followed by `  sub: value` lines (options),
// or an inline `key: [a, b]` flow list. Returns { doc, problems }; `doc`
// maps key -> array of strings (lists) or object (maps). Line numbers are
// 1-based in messages so a failure points at the offending line.
export function parseOwners(text) {
  const doc = {};
  const problems = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.trim() || /^\s*#/.test(line)) return;
    if (/^\t/.test(line) || /^ *\t/.test(line)) { problems.push(`line ${n}: tab indentation (YAML requires spaces)`); return; }
    let m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (m) {
      const [, key, rest] = m;
      if (key in doc) problems.push(`line ${n}: duplicate top-level key \`${key}\``);
      current = key;
      const value = scalar(rest);
      if (value === "") { doc[key] = doc[key] ?? (key === "options" ? {} : []); return; }
      const flow = value.match(/^\[(.*)\]$/);
      if (flow) { doc[key] = flow[1].split(",").map((s) => scalar(s)).filter(Boolean); return; }
      problems.push(`line ${n}: \`${key}\` must introduce a list, not a scalar ${JSON.stringify(value)}`);
      doc[key] = [];
      return;
    }
    m = line.match(/^( +)-[ \t]+(.*)$/);
    if (m) {
      if (current === null) { problems.push(`line ${n}: list item before any key`); return; }
      if (!Array.isArray(doc[current])) { problems.push(`line ${n}: list item under \`${current}\`, which is a map`); return; }
      const item = scalar(m[2]);
      if (item === "") problems.push(`line ${n}: empty list item under \`${current}\``);
      else doc[current].push(item);
      return;
    }
    m = line.match(/^( +)([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (m) {
      if (current === null || Array.isArray(doc[current])) { problems.push(`line ${n}: nested key \`${m[2]}\` under \`${current ?? "(none)"}\`, which is not a map`); return; }
      doc[current][m[2]] = scalar(m[3]);
      return;
    }
    problems.push(`line ${n}: unparseable line ${JSON.stringify(line)}`);
  });
  return { doc, problems };
}

// `OWNERS_ALIASES` is `aliases:` -> map of alias name -> list of logins.
export function parseAliases(text) {
  const names = new Set();
  const problems = [];
  let inAliases = false;
  let current = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    if (!line.trim() || /^\s*#/.test(line)) return;
    if (/^\s*\t/.test(line)) { problems.push(`line ${n}: tab indentation (YAML requires spaces)`); return; }
    if (/^aliases:\s*$/.test(line)) { inAliases = true; return; }
    if (/^\S/.test(line)) { problems.push(`line ${n}: only an \`aliases:\` block is allowed at top level`); inAliases = false; return; }
    if (!inAliases) { problems.push(`line ${n}: content outside \`aliases:\``); return; }
    let m = line.match(/^ +([A-Za-z0-9_][A-Za-z0-9_-]*):\s*$/);
    if (m) { current = m[1]; if (names.has(current)) problems.push(`line ${n}: duplicate alias \`${current}\``); names.add(current); return; }
    m = line.match(/^ +-\s+(.*)$/);
    if (m) {
      if (current === null) { problems.push(`line ${n}: login before any alias name`); return; }
      const login = scalar(m[1]);
      if (!LOGIN_RE.test(login)) problems.push(`line ${n}: alias \`${current}\` member ${JSON.stringify(login)} is not a GitHub login`);
      return;
    }
    problems.push(`line ${n}: unparseable line ${JSON.stringify(line)}`);
  });
  return { names, problems };
}

// --- rules -------------------------------------------------------------------

// `isRoot` selects the rule that the top-level file must name approvers.
export function checkOwners(text, { isRoot = true, aliases = new Set() } = {}) {
  const { doc, problems } = parseOwners(text);
  for (const key of Object.keys(doc)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`unknown key \`${key}\` (prow knows ${[...KNOWN_KEYS].join(", ")})`);
  }
  if (doc.options !== undefined) {
    if (Array.isArray(doc.options)) problems.push("`options` must be a map of flags, not a list");
    else for (const [k, v] of Object.entries(doc.options)) {
      if (!KNOWN_OPTIONS.has(k)) problems.push(`unknown option \`${k}\` (prow knows ${[...KNOWN_OPTIONS].join(", ")})`);
      else if (!/^(true|false)$/.test(v)) problems.push(`option \`${k}\` must be true or false, got ${JSON.stringify(v)}`);
    }
  }
  if (isRoot && !(Array.isArray(doc.approvers) && doc.approvers.length)) problems.push("root OWNERS must list at least one approver (`approvers:`), or nothing can be /approve'd");
  for (const key of PEOPLE_KEYS) {
    // parseOwners only ever builds a map for `options`; every other key is a list.
    const list = doc[key];
    if (list === undefined) continue;
    const seen = new Set();
    for (const entry of list) {
      const lower = entry.toLowerCase();
      if (seen.has(lower)) problems.push(`\`${key}\` lists ${JSON.stringify(entry)} more than once`);
      seen.add(lower);
      if (aliases.has(entry)) continue;
      if (entry.startsWith("@")) problems.push(`\`${key}\` entry ${JSON.stringify(entry)} must not carry an @ prefix`);
      else if (entry.includes("@")) problems.push(`\`${key}\` entry ${JSON.stringify(entry)} is an email, not a GitHub login`);
      else if (!LOGIN_RE.test(entry)) problems.push(`\`${key}\` entry ${JSON.stringify(entry)} is neither a GitHub login nor an OWNERS_ALIASES alias`);
    }
  }
  if (Array.isArray(doc.labels)) for (const l of doc.labels) if (!l.trim()) problems.push("`labels` has an empty entry");
  for (const role of ["approvers", "reviewers"]) {
    const active = new Set((Array.isArray(doc[role]) ? doc[role] : []).map((s) => s.toLowerCase()));
    const emeritus = Array.isArray(doc[`emeritus_${role}`]) ? doc[`emeritus_${role}`] : [];
    for (const e of emeritus) if (active.has(e.toLowerCase())) problems.push(`${JSON.stringify(e)} is listed as both \`${role}\` and \`emeritus_${role}\``);
  }
  return problems;
}

export function findOwnersFiles(root, fs = { readdirSync, statSync }) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name === "OWNERS") out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function checkTree(root, fs = { existsSync, readFileSync, readdirSync, statSync }) {
  const problems = [];
  const rootOwners = join(root, "OWNERS");
  if (!fs.existsSync(rootOwners)) problems.push("OWNERS is missing at the repository root");
  let aliases = new Set();
  const aliasFile = join(root, "OWNERS_ALIASES");
  if (fs.existsSync(aliasFile)) {
    const r = parseAliases(fs.readFileSync(aliasFile, "utf8"));
    aliases = r.names;
    problems.push(...r.problems.map((p) => `OWNERS_ALIASES: ${p}`));
  }
  for (const file of findOwnersFiles(root, fs)) {
    const rel = relative(root, file);
    for (const p of checkOwners(fs.readFileSync(file, "utf8"), { isRoot: file === rootOwners, aliases })) problems.push(`${rel}: ${p}`);
  }
  return problems;
}

// --- fixture self-tests ------------------------------------------------------

const GOOD = "# Prow OWNERS\napprovers:\n  - alice\n  - bob-smith\nreviewers:\n  - alice\n";

test("a well-formed fixture passes", () => {
  assert.deepEqual(checkOwners(GOOD), []);
  assert.deepEqual(parseOwners(GOOD).doc, { approvers: ["alice", "bob-smith"], reviewers: ["alice"] });
});

test("inline flow lists, quoted scalars and trailing comments parse", () => {
  const { doc, problems } = parseOwners("approvers: [alice, 'bob']\nlabels:\n  - \"area/x\" # c\noptions:\n  no_parent_owners: true\n");
  assert.deepEqual(problems, []);
  assert.deepEqual(doc, { approvers: ["alice", "bob"], labels: ["area/x"], options: { no_parent_owners: "true" } });
});

test("tabs, scalars where lists belong and stray lines are reported with line numbers", () => {
  assert.match(checkOwners("approvers:\n\t- alice\n").join("\n"), /line 2: tab indentation/);
  assert.match(checkOwners("approvers: alice\n").join("\n"), /line 1: `approvers` must introduce a list/);
  assert.match(checkOwners("  - alice\napprovers:\n  - bob\n").join("\n"), /line 1: list item before any key/);
  assert.match(checkOwners("approvers:\n  - alice\n  nested: x\n").join("\n"), /line 3: nested key `nested` under `approvers`/);
  assert.match(checkOwners("  nested: x\napprovers:\n  - alice\n").join("\n"), /line 1: nested key `nested` under `\(none\)`, which is not a map/);
  assert.match(checkOwners("approvers:\n  - alice\n:::\n").join("\n"), /line 3: unparseable line/);
  assert.match(checkOwners("approvers:\n  -   \n").join("\n"), /line 2: empty list item/);
  assert.match(checkOwners("approvers:\n  - alice\napprovers:\n  - bob\n").join("\n"), /line 3: duplicate top-level key `approvers`/);
});

test("only keys prow knows are accepted", () => {
  assert.match(checkOwners("approver:\n  - alice\n").join("\n"), /unknown key `approver`/);
  assert.match(checkOwners(GOOD + "maintainers:\n  - carol\n").join("\n"), /unknown key `maintainers`/);
  assert.deepEqual(checkOwners(GOOD + "emeritus_approvers:\n  - dave\nlabels:\n  - area/site\n"), []);
});

test("a quoted whitespace-only label survives parsing and is reported as empty", () => {
  // `scalar` strips the quotes after trimming, so `"  "` reaches the list as
  // two spaces rather than tripping the parser's empty-item rule.
  assert.deepEqual(parseOwners('labels:\n  - "  "\n').problems, []);
  assert.deepEqual(checkOwners(GOOD + 'labels:\n  - "  "\n'), ["`labels` has an empty entry"]);
});

test("options must be a map of known boolean flags", () => {
  assert.match(checkOwners(GOOD + "options:\n  - no_parent_owners\n").join("\n"), /list item under `options`, which is a map/);
  assert.match(checkOwners(GOOD + "options: [no_parent_owners]\n").join("\n"), /`options` must be a map/);
  assert.match(checkOwners(GOOD + "options:\n  parent_owners: true\n").join("\n"), /unknown option `parent_owners`/);
  assert.match(checkOwners(GOOD + "options:\n  no_parent_owners: yes\n").join("\n"), /must be true or false, got "yes"/);
  assert.deepEqual(checkOwners(GOOD + "options:\n  no_parent_owners: true\n  auto_approve_unowned_subfolders: false\n"), []);
});

test("the root file must name at least one approver; nested files need not", () => {
  for (const text of ["reviewers:\n  - alice\n", "approvers:\nreviewers:\n  - alice\n", "approvers: []\n"]) {
    assert.match(checkOwners(text).join("\n"), /root OWNERS must list at least one approver/, text);
    assert.doesNotMatch(checkOwners(text, { isRoot: false }).join("\n"), /at least one approver/, text);
  }
});

test("entries must be GitHub logins, not handles, emails or aliases nobody declared", () => {
  assert.match(checkOwners("approvers:\n  - @alice\n").join("\n"), /"@alice" must not carry an @ prefix/);
  assert.match(checkOwners("approvers:\n  - alice@example.com\n").join("\n"), /"alice@example.com" is an email/);
  assert.match(checkOwners("approvers:\n  - -alice\n").join("\n"), /"-alice" is neither a GitHub login nor an OWNERS_ALIASES alias/);
  assert.match(checkOwners("approvers:\n  - al--ice\n").join("\n"), /"al--ice" is neither/);
  assert.match(checkOwners("approvers:\n  - site maintainers\n").join("\n"), /"site maintainers" is neither/);
  assert.match(checkOwners(`approvers:\n  - ${"a".repeat(40)}\n`).join("\n"), /is neither/);
  assert.deepEqual(checkOwners("approvers:\n  - site-maintainers\n", { aliases: new Set(["site-maintainers"]) }), []);
  assert.deepEqual(checkOwners(`approvers:\n  - ${"a".repeat(39)}\n  - A1-b2\n`), []);
});

test("duplicates within a list and active/emeritus overlap are reported", () => {
  assert.match(checkOwners("approvers:\n  - alice\n  - Alice\n").join("\n"), /`approvers` lists "Alice" more than once/);
  assert.match(checkOwners("approvers:\n  - alice\nemeritus_approvers:\n  - ALICE\n").join("\n"), /"ALICE" is listed as both `approvers` and `emeritus_approvers`/);
  assert.match(checkOwners("approvers:\n  - alice\nreviewers:\n  - bob\nemeritus_reviewers:\n  - bob\n").join("\n"), /"bob" is listed as both `reviewers` and `emeritus_reviewers`/);
  assert.deepEqual(checkOwners("approvers:\n  - alice\nemeritus_reviewers:\n  - alice\n"), [], "emeritus in a different role is fine");
});

test("OWNERS_ALIASES parses alias names and rejects malformed members", () => {
  const ok = parseAliases("aliases:\n  site-maintainers:\n    - alice\n    - bob\n  docs:\n    - carol\n");
  assert.deepEqual(ok.problems, []);
  assert.deepEqual([...ok.names], ["site-maintainers", "docs"]);
  assert.match(parseAliases("aliases:\n  x:\n    - @alice\n").problems.join("\n"), /alias `x` member "@alice" is not a GitHub login/);
  assert.match(parseAliases("aliases:\n  x:\n    - alice\n  x:\n    - bob\n").problems.join("\n"), /duplicate alias `x`/);
  assert.match(parseAliases("approvers:\n  - alice\n").problems.join("\n"), /only an `aliases:` block/);
  assert.match(parseAliases("aliases:\n    - alice\n").problems.join("\n"), /login before any alias name/);
  assert.match(parseAliases("aliases:\n\tx:\n").problems.join("\n"), /tab indentation/);
  assert.match(parseAliases("aliases:\n  x:\n  :::\n").problems.join("\n"), /line 3: unparseable line "  :::"/);
});

// In-memory tree so the walker and the per-file rule wiring are exercised
// without touching disk.
function memFs(files) {
  const dirs = new Set(["/r"]);
  for (const p of Object.keys(files)) { let d = dirname(p); while (d !== "/" && !dirs.has(d)) { dirs.add(d); d = dirname(d); } }
  return {
    existsSync: (p) => p in files || dirs.has(p),
    readFileSync: (p) => files[p],
    readdirSync: (d) => [...new Set([...Object.keys(files), ...dirs].filter((p) => dirname(p) === d).map((p) => relative(d, p)))],
    statSync: (p) => ({ isDirectory: () => dirs.has(p) }),
  };
}

test("checkTree walks nested OWNERS, skips .git, applies aliases and prefixes paths", () => {
  const fs = memFs({
    "/r/OWNERS": "approvers:\n  - site-maintainers\n",
    "/r/OWNERS_ALIASES": "aliases:\n  site-maintainers:\n    - alice\n",
    "/r/stories/OWNERS": "reviewers:\n  - @bob\n",
    "/r/.git/OWNERS": "garbage\n",
    "/r/node_modules/x/OWNERS": "garbage\n",
  });
  assert.deepEqual(findOwnersFiles("/r", fs), ["/r/OWNERS", "/r/stories/OWNERS"]);
  assert.deepEqual(checkTree("/r", fs), ['stories/OWNERS: `reviewers` entry "@bob" must not carry an @ prefix']);
});

test("checkTree reports a missing root OWNERS and alias-file problems", () => {
  assert.deepEqual(checkTree("/r", memFs({ "/r/index.html": "" })), ["OWNERS is missing at the repository root"]);
  const problems = checkTree("/r", memFs({ "/r/OWNERS": "approvers:\n  - alice\n", "/r/OWNERS_ALIASES": "aliases:\n  x:\n    - bad login\n" }));
  assert.deepEqual(problems, ['OWNERS_ALIASES: line 3: alias `x` member "bad login" is not a GitHub login']);
});

// --- the real tree -----------------------------------------------------------

test("every OWNERS file in the repository is one prow can act on", () => {
  assert.deepEqual(checkTree(ROOT), []);
});
