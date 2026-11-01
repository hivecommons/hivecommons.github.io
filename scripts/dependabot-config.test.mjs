#!/usr/bin/env node
// Static gate over `.github/dependabot.yml`. workflow-hardening.test.mjs
// requires every `uses:` to be pinned to a commit SHA with a `# <version>`
// comment, and Dependabot is the only thing that moves those pins: delete or
// break the config and the SHAs stay valid but silently rot, with nothing in
// CI noticing. OpenSSF Scorecard's Dependency-Update-Tool check looks at the
// same file but runs on `main` only and a lower score fails nothing. Each
// rule has a fixture self-test. Zero dependencies.
//
// Rules:
//   1. The file exists, is readable by the flat-YAML parser below, and
//      declares `version: 2`.
//   2. Every `updates:` entry names a known `package-ecosystem`, a
//      `directory:` (or `directories:`) and a `schedule.interval` Dependabot
//      accepts.
//   3. Every package ecosystem the tree actually contains (workflows under
//      `.github/workflows/` -> `github-actions`, a root `package.json` ->
//      `npm`, …) has an entry rooted at `/`, and no `/` entry names a
//      marker-backed ecosystem the tree does not contain (a dead entry is a
//      config that stopped meaning anything). Ecosystems without a root
//      marker, and entries below the root, are outside the rule's knowledge
//      and are left alone.
//   4. No two entries cover the same ecosystem at the same directory.
// Usage: node --test scripts/dependabot-config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONFIG = join(ROOT, ".github", "dependabot.yml");

// Dependabot `package-ecosystem` values (docs: configuration-options-for-the-dependabot.yml-file).
export const KNOWN_ECOSYSTEMS = new Set([
  "bundler", "cargo", "composer", "devcontainers", "docker", "docker-compose", "dotnet-sdk",
  "elm", "gitsubmodule", "github-actions", "gomod", "gradle", "helm", "maven", "mix", "npm",
  "nuget", "pip", "pub", "swift", "terraform", "uv", "bun",
]);
export const KNOWN_INTERVALS = new Set(["daily", "weekly", "monthly", "quarterly", "semiannually", "yearly", "cron"]);

// Root-level manifests that imply an ecosystem Dependabot should watch. Only
// the repository root is considered: every entry here is `directory: /`.
export const ECOSYSTEM_MARKERS = [
  { ecosystem: "github-actions", test: (fs, root) => listDir(fs, join(root, ".github", "workflows")).some((n) => /\.ya?ml$/i.test(n)) || fs.existsSync(join(root, "action.yml")) || fs.existsSync(join(root, "action.yaml")) },
  { ecosystem: "npm", test: (fs, root) => fs.existsSync(join(root, "package.json")) },
  { ecosystem: "bundler", test: (fs, root) => fs.existsSync(join(root, "Gemfile")) },
  { ecosystem: "pip", test: (fs, root) => ["requirements.txt", "pyproject.toml", "Pipfile"].some((f) => fs.existsSync(join(root, f))) },
  { ecosystem: "gomod", test: (fs, root) => fs.existsSync(join(root, "go.mod")) },
  { ecosystem: "cargo", test: (fs, root) => fs.existsSync(join(root, "Cargo.toml")) },
  { ecosystem: "docker", test: (fs, root) => fs.existsSync(join(root, "Dockerfile")) },
  { ecosystem: "gitsubmodule", test: (fs, root) => fs.existsSync(join(root, ".gitmodules")) },
];

export const MARKED_ECOSYSTEMS = new Set(ECOSYSTEM_MARKERS.map((m) => m.ecosystem));

function listDir(fs, dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// Ecosystems the tree implies, in ECOSYSTEM_MARKERS order.
export function expectedEcosystems(root, fs = { existsSync, readdirSync }) {
  return ECOSYSTEM_MARKERS.filter((m) => m.test(fs, root)).map((m) => m.ecosystem);
}

// --- parsing -----------------------------------------------------------------

// Minimal reader for the block-YAML shape dependabot.yml uses: a top-level
// `version:` scalar and an `updates:` list whose items hold scalars, a nested
// `schedule:` map and (ignored) deeper maps such as `groups:`. Returns
// { version, updates: [{ line, ...keys, schedule: {...} }], problems }.
// Anything the reader cannot place is reported so the live test cannot pass
// vacuously on a file it did not understand.
export function parseDependabot(text) {
  const out = { version: null, updates: [], problems: [] };
  let section = null; // top-level key currently open
  let item = null; // current updates[] entry
  let nested = null; // name of the indent-4 map currently open inside item
  let nestedIndent = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, "");
    if (!line.trim()) return;
    if (/\t/.test(line)) { out.problems.push(`line ${n}: tab indentation`); return; }
    const indent = line.match(/^ */)[0].length;
    const body = line.trim();
    let m;
    if (indent === 0) {
      if (!(m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(body))) { out.problems.push(`line ${n}: unreadable: ${JSON.stringify(raw)}`); return; }
      section = m[1]; item = null; nested = null;
      const v = m[2].trim();
      if (section === "version") out.version = unquote(v);
      else if (section !== "updates" && section !== "enable-beta-ecosystems" && section !== "registries") out.problems.push(`line ${n}: unknown top-level key ${section}`);
      return;
    }
    if (section !== "updates") return; // registries:/… bodies are not this gate's business
    if (indent === 2 && (m = /^-\s+([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(body))) {
      item = { line: n, schedule: {} };
      out.updates.push(item);
      nested = null;
      const err = setKey(item, m[1], m[2].trim());
      if (err) out.problems.push(`line ${n}: ${err}`);
      return;
    }
    if (!item) { out.problems.push(`line ${n}: list item expected: ${JSON.stringify(raw)}`); return; }
    if (indent === 4 && (m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(body))) {
      const v = m[2].trim();
      nested = v === "" ? m[1] : null;
      nestedIndent = 4;
      if (v !== "") { const err = setKey(item, m[1], v); if (err) out.problems.push(`line ${n}: ${err}`); }
      else if (m[1] === "directories") item.directories = [];
      return;
    }
    if (nested === "directories" && indent === 6 && /^-\s/.test(body)) { item.directories.push(unquote(body.replace(/^-\s+/, ""))); return; }
    if (nested === "schedule" && indent === 6 && (m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(body))) {
      item.schedule[m[1]] = unquote(m[2].trim());
      return;
    }
    if (nested && indent > nestedIndent) return; // deeper maps (groups:, ignore:, …) are opaque here
    out.problems.push(`line ${n}: unreadable: ${JSON.stringify(raw)}`);
  });
  return out;
}

// Assigns a scalar, `[…]` flow list or single-level `{…}` flow map (e.g.
// `schedule: {interval: weekly}`). Returns a problem string when the value
// cannot be read, so the caller can report it against the line.
function setKey(item, key, value) {
  let m;
  if (/^\[(.*)\]$/.test(value)) { item[key] = value.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean); return; }
  if ((m = /^\{(.*)\}$/.exec(value))) {
    const map = {};
    for (const part of m[1].split(",")) {
      if (!part.trim()) continue;
      const kv = /^\s*(["']?)([A-Za-z_][\w-]*)\1\s*:\s*(.*?)\s*$/.exec(part);
      if (!kv) return `unreadable flow map ${key}: ${JSON.stringify(value)}`;
      map[kv[2]] = unquote(kv[3]);
    }
    item[key] = map;
    return;
  }
  item[key] = unquote(value);
}

function unquote(s) {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

// --- rules -------------------------------------------------------------------

export function dependabotProblems({ config, expected }) {
  const problems = [...config.problems];
  if (config.version !== "2") problems.push(`version: must be 2 (found ${JSON.stringify(config.version)})`);
  if (config.updates.length === 0) problems.push("updates: lists no entries");
  const seen = new Map();
  const covered = new Set();
  for (const u of config.updates) {
    const eco = u["package-ecosystem"];
    const where = `line ${u.line}`;
    if (!eco) { problems.push(`${where}: entry has no package-ecosystem`); continue; }
    if (!KNOWN_ECOSYSTEMS.has(eco)) problems.push(`${where}: unknown package-ecosystem ${eco}`);
    const dirs = Array.isArray(u.directories) ? u.directories : u.directory ? [u.directory] : [];
    if (dirs.length === 0) problems.push(`${where}: ${eco} entry has no directory: or directories:`);
    const schedule = u.schedule && typeof u.schedule === "object" ? u.schedule : {};
    if (u.schedule !== undefined && typeof u.schedule !== "object") problems.push(`${where}: ${eco} schedule: must be a map`);
    const interval = schedule.interval;
    if (!interval) problems.push(`${where}: ${eco} entry has no schedule.interval`);
    else if (!KNOWN_INTERVALS.has(interval)) problems.push(`${where}: ${eco} schedule.interval ${interval} is not one Dependabot accepts`);
    if (interval === "cron" && !schedule.cronjob) problems.push(`${where}: ${eco} schedule.interval cron needs schedule.cronjob`);
    for (const d of dirs) {
      const key = `${eco} ${d}`;
      if (seen.has(key)) problems.push(`${where}: ${eco} at ${d} is already covered by the entry at line ${seen.get(key)}`);
      else seen.set(key, u.line);
      if (d === "/") covered.add(eco);
    }
    // Only ecosystems with a root marker can be judged dead, and only for a `/`
    // entry: `npm` at `/site` or a `terraform` entry are outside this rule's knowledge.
    if (dirs.includes("/") && MARKED_ECOSYSTEMS.has(eco) && !expected.includes(eco)) problems.push(`${where}: ${eco} entry has no matching manifest at the repository root (dead entry)`);
  }
  for (const eco of expected) {
    if (!covered.has(eco)) problems.push(`${eco}: the tree contains this ecosystem but no updates: entry covers it at directory /`);
  }
  return problems;
}

// --- fixture self-tests -------------------------------------------------------

const GOOD = `version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    groups:
      github-actions:
        patterns: ["*"]
`;

test("fixture: the committed shape parses into version, one entry with directory, interval and an opaque groups: map", () => {
  const c = parseDependabot(GOOD);
  assert.deepEqual(c.problems, []);
  assert.equal(c.version, "2");
  assert.equal(c.updates.length, 1);
  assert.equal(c.updates[0]["package-ecosystem"], "github-actions");
  assert.equal(c.updates[0].directory, "/");
  assert.equal(c.updates[0].schedule.interval, "weekly");
});

test("fixture: quoted scalars, flow lists, directories: block lists, comments and CRLF are read", () => {
  const c = parseDependabot('version: "2"\r\nupdates:\r\n  # comment\r\n  - package-ecosystem: "npm"\r\n    directories:\r\n      - "/"\r\n      - /site\r\n    schedule:\r\n      interval: monthly # trailing\r\n  - package-ecosystem: docker\r\n    directory: /\r\n    schedule:\r\n      interval: cron\r\n      cronjob: "0 9 * * 1"\r\n');
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.updates[0].directories, ["/", "/site"]);
  assert.equal(c.updates[0].schedule.interval, "monthly");
  assert.equal(c.updates[1].schedule.cronjob, "0 9 * * 1");
});

test("fixture: tabs, unknown top-level keys and lines the reader cannot place are reported rather than skipped", () => {
  assert.match(parseDependabot("version: 2\n\tupdates: []\n").problems.join("\n"), /tab indentation/);
  assert.match(parseDependabot("version: 2\nupdtaes:\n").problems.join("\n"), /unknown top-level key updtaes/);
  assert.match(parseDependabot("version: 2\nupdates:\n    directory: /\n").problems.join("\n"), /list item expected/);
  assert.match(parseDependabot("version: 2\nupdates:\n  - package-ecosystem: npm\n   oops\n").problems.join("\n"), /unreadable/);
});

test("fixture: a config matching the tree passes", () => {
  assert.deepEqual(dependabotProblems({ config: parseDependabot(GOOD), expected: ["github-actions"] }), []);
});

test("fixture: a missing or wrong version, and an empty updates list, are reported", () => {
  const p = dependabotProblems({ config: parseDependabot("version: 1\nupdates:\n"), expected: [] });
  assert.ok(p.some((x) => x.startsWith("version: must be 2")), p.join("\n"));
  assert.ok(p.some((x) => x.includes("lists no entries")), p.join("\n"));
});

test("fixture: unknown ecosystem, missing directory, missing/unknown interval and cron without cronjob are reported", () => {
  const cfg = parseDependabot("version: 2\nupdates:\n  - package-ecosystem: npmm\n    schedule:\n      interval: fortnightly\n  - package-ecosystem: npm\n    directory: /\n  - package-ecosystem: docker\n    directory: /\n    schedule:\n      interval: cron\n");
  const p = dependabotProblems({ config: cfg, expected: ["npm", "docker"] }).join("\n");
  assert.match(p, /unknown package-ecosystem npmm/);
  assert.match(p, /npmm entry has no directory/);
  assert.match(p, /fortnightly is not one Dependabot accepts/);
  assert.match(p, /npm entry has no schedule.interval/);
  assert.match(p, /cron needs schedule.cronjob/);
});

test("fixture: an ecosystem the tree contains but the config omits is reported — the SHA pins would silently rot", () => {
  const cfg = parseDependabot("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n");
  const p = dependabotProblems({ config: cfg, expected: ["github-actions", "npm"] });
  assert.deepEqual(p, ["github-actions: the tree contains this ecosystem but no updates: entry covers it at directory /"]);
});

test("fixture: an entry for an ecosystem the tree no longer contains is reported as dead, and only a `/` entry counts as cover", () => {
  const cfg = parseDependabot("version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /site\n    schedule:\n      interval: weekly\n  - package-ecosystem: bundler\n    directory: /\n    schedule:\n      interval: weekly\n");
  const p = dependabotProblems({ config: cfg, expected: ["github-actions"] }).join("\n");
  assert.match(p, /bundler entry has no matching manifest at the repository root \(dead entry\)/);
  assert.match(p, /github-actions: the tree contains this ecosystem but no updates: entry covers it at directory \//);
});

test("fixture: a flow-style `schedule: {interval: weekly}` is read as a map, and an unreadable flow map is reported", () => {
  const c = parseDependabot("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: weekly, day: monday}\n");
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.updates[0].schedule, { interval: "weekly", day: "monday" });
  assert.deepEqual(dependabotProblems({ config: c, expected: ["npm"] }), []);
  const bad = parseDependabot("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {weekly}\n");
  assert.match(bad.problems.join("\n"), /line 5: unreadable flow map schedule/);
  const scalar = parseDependabot("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: weekly\n");
  assert.match(dependabotProblems({ config: scalar, expected: ["npm"] }).join("\n"), /schedule: must be a map/);
});

test("fixture: the dead-entry rule leaves alone ecosystems without a root marker and entries below the root", () => {
  const cfg = parseDependabot("version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n  - package-ecosystem: terraform\n    directory: /\n    schedule:\n      interval: weekly\n  - package-ecosystem: npm\n    directory: /site\n    schedule:\n      interval: weekly\n");
  assert.deepEqual(dependabotProblems({ config: cfg, expected: ["github-actions"] }), []);
  assert.ok(!MARKED_ECOSYSTEMS.has("terraform"));
});

test("fixture: two entries for the same ecosystem and directory are reported once, against the first", () => {
  const cfg = parseDependabot("version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: daily\n");
  const p = dependabotProblems({ config: cfg, expected: ["github-actions"] });
  assert.deepEqual(p, ["line 7: github-actions at / is already covered by the entry at line 3"]);
});

test("fixture: an unreadable top-level line, a body under a section that is not updates:, a bad first key on an item, flow lists and an empty flow-map part are each placed", () => {
  assert.deepEqual(parseDependabot("version: 2\n- updates\n").problems, ['line 2: unreadable: "- updates"']);
  const registries = parseDependabot("version: 2\nregistries:\n  npm-github:\n    type: npm-registry\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n");
  assert.deepEqual(registries.problems, []);
  assert.equal(registries.updates.length, 1);
  assert.equal(registries.updates[0].type, undefined);
  assert.deepEqual(parseDependabot("version: 2\nupdates:\n  - schedule: {weekly}\n").problems, ["line 3: unreadable flow map schedule: \"{weekly}\""]);
  const flow = parseDependabot("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    labels: [\"deps\", 'npm', ]\n    schedule: {interval: weekly, }\n");
  assert.deepEqual(flow.problems, []);
  assert.deepEqual(flow.updates[0].labels, ["deps", "npm"]);
  assert.deepEqual(flow.updates[0].schedule, { interval: "weekly" });
});

test("fixture: an entry with no package-ecosystem is reported and skipped, and a directories: list is what the rules read", () => {
  const cfg = parseDependabot("version: 2\nupdates:\n  - directory: /\n    schedule:\n      interval: weekly\n  - package-ecosystem: npm\n    directories:\n      - /\n      - /site\n    schedule:\n      interval: weekly\n  - package-ecosystem: npm\n    directory: /site\n    schedule:\n      interval: weekly\n");
  assert.deepEqual(cfg.problems, []);
  const p = dependabotProblems({ config: cfg, expected: ["npm"] });
  assert.deepEqual(p, [
    "line 3: entry has no package-ecosystem",
    "line 12: npm at /site is already covered by the entry at line 6",
  ]);
});

test("fixture: expectedEcosystems treats a missing workflow directory as no workflows, so github-actions is implied only by an action manifest", () => {
  const noDir = (files) => ({
    existsSync: (p) => files.includes(p.slice("/r/".length)),
    readdirSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  });
  assert.deepEqual(expectedEcosystems("/r", noDir([])), []);
  assert.deepEqual(expectedEcosystems("/r", noDir(["action.yaml"])), ["github-actions"]);
});

test("fixture: expectedEcosystems reads the root manifests and workflow directory through the injected fs", () => {
  const fake = (files, workflows) => ({
    existsSync: (p) => files.includes(p.slice("/r/".length)),
    readdirSync: (p) => (p === "/r/.github/workflows" ? workflows : (() => { throw new Error("ENOENT"); })()),
  });
  assert.deepEqual(expectedEcosystems("/r", fake([], ["ci.yml"])), ["github-actions"]);
  assert.deepEqual(expectedEcosystems("/r", fake(["package.json", "go.mod"], [])), ["npm", "gomod"]);
  assert.deepEqual(expectedEcosystems("/r", fake(["action.yml", "Dockerfile", ".gitmodules"], ["README"])), ["github-actions", "docker", "gitsubmodule"]);
  assert.deepEqual(expectedEcosystems("/r", fake([], [])), []);
});

// --- live tree ----------------------------------------------------------------

test(".github/dependabot.yml exists, is version 2 and covers exactly the ecosystems the tree contains", () => {
  assert.ok(existsSync(CONFIG), ".github/dependabot.yml is missing — nothing would refresh the workflow SHA pins");
  const config = parseDependabot(readFileSync(CONFIG, "utf8"));
  const expected = expectedEcosystems(ROOT);
  assert.ok(expected.includes("github-actions"), "the tree has workflows, so github-actions must be an expected ecosystem (the marker rule would otherwise be vacuous)");
  assert.deepEqual(dependabotProblems({ config, expected }), []);
});
