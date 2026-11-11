#!/usr/bin/env node
// Static gate over the URL list the scheduled `availability` job in
// .github/workflows/links.yml probes against the live site. That list is
// hand-maintained: nothing else notices when a probed page is renamed or
// removed (the weekly job then fails with a false alarm), when a new canonical
// page is added to sitemap.xml but never probed, or when a directory URL loses
// its trailing slash (GitHub Pages answers 301, which curl without -L reports
// as a failure). Paths under a `PROJECT_SITES` prefix of check-links.sh are
// served on hivecommons.dev by a sibling Pages project repo: they have no
// committed file, so the probe list may name them without resolving to one.
// runbooks/availability-failure.md restates the probed paths for the on-call
// reader; its intro must name exactly the paths the job probes, or the runbook
// sends them looking at the wrong pages (#378 fixed that drift by hand).
// Each rule has a fixture self-test. Zero dependencies.
// Usage: node --test scripts/availability-probes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SITE_ORIGIN = "https://hivecommons.dev";
const WORKFLOW = join(ROOT, ".github", "workflows", "links.yml");
const CHECKER = join(ROOT, "scripts", "check-links.sh");
const RUNBOOK = join(ROOT, "runbooks", "availability-failure.md");

// --- parsing ---------------------------------------------------------------

// The `availability` job's `for url in ...; do` word list, backslash
// continuations joined. Returns null when the job or its loop is absent.
export function probedUrls(yaml) {
  const job = /^\s{2}availability:\s*$([\s\S]*?)(?=^\s{2}\S|(?![\s\S]))/m.exec(yaml);
  if (!job) return null;
  const loop = /for\s+url\s+in\s+([\s\S]*?);\s*do\b/.exec(job[1]);
  if (!loop) return null;
  return loop[1].replace(/\\\r?\n/g, " ").split(/\s+/).filter(Boolean);
}

// The `PROJECT_SITES=( ... )` array of check-links.sh, one path prefix per
// line, optionally enclosed in matching single or double quotes, with trailing
// `# comment` dropped. Returns [] when the array is absent.
export function projectSitePrefixes(sh) {
  const arr = /^PROJECT_SITES=\(\s*$([\s\S]*?)^\)\s*$/m.exec(sh);
  if (!arr) return [];
  return arr[1].split("\n").map((l) => l.replace(/#.*$/, "").trim())
    .map((l) => l.replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, double, single) => double ?? single)).filter(Boolean);
}

export function isProjectSitePath(path, prefixes) {
  const bare = path.replace(/[?#].*$/, "");
  return prefixes.some((prefix) => bare.startsWith(prefix));
}

// Site paths the availability runbook's intro (everything before its first
// `## ` heading) says the job probes: each `/...` code span and each bare
// parenthesised (/...) — the latter is how a project-site path served by a
// sibling repo is written, since doc-paths.test.mjs resolves code spans to
// committed files. Returns the distinct paths in order of first mention.
export function runbookProbedPaths(markdown) {
  const intro = markdown.split(/^## /m)[0];
  const paths = [];
  for (const m of intro.matchAll(/`(\/[^`\s]*)`|\((\/[^()\s]*)\)/g)) {
    const path = m[1] ?? m[2];
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

// Text of the availability loop from `do` to its closing `done`, and what
// follows it. Returns null when the job or the loop is absent.
export function probeLoopParts(yaml) {
  const job = /^\s{2}availability:\s*$([\s\S]*?)(?=^\s{2}\S|(?![\s\S]))/m.exec(yaml);
  if (!job) return null;
  const loop = /for\s+url\s+in\s+[\s\S]*?;\s*do\b([\s\S]*?)^\s*done\b([\s\S]*)$/m.exec(job[1]);
  return loop ? { body: loop[1], after: loop[2] } : null;
}

export function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

export function isRedirectPage(html) {
  return /<meta[^>]+http-equiv\s*=\s*["']refresh["']/i.test(html);
}

// Committed file a site URL is served from, or null. Directory URLs must carry
// their trailing slash: "/docs" is a 301 on GitHub Pages, not the page.
export function siteUrlToFile(url, root = ROOT) {
  if (url === SITE_ORIGIN) return null;
  if (!url.startsWith(SITE_ORIGIN + "/")) return null;
  const path = url.slice(SITE_ORIGIN.length).replace(/[?#].*$/, "");
  const rel = path === "/" ? "index.html" : path.endsWith("/") ? join(path.slice(1), "index.html") : path.slice(1);
  const full = resolve(root, rel);
  if (!full.startsWith(resolve(root) + "/") || !existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

// --- rules -----------------------------------------------------------------

export function probeListProblems(urls, { sitemap, root = ROOT, projectSites = [] }) {
  const problems = [];
  if (!urls || urls.length === 0) return ["availability job has no `for url in ...; do` probe list"];
  if (new Set(urls).size !== urls.length) problems.push("probe list has duplicate URLs");
  let redirects = 0;
  for (const url of urls) {
    if (!url.startsWith("https://")) { problems.push(`${url} is not https`); continue; }
    if (!url.startsWith(SITE_ORIGIN + "/")) { problems.push(`${url} is not under ${SITE_ORIGIN}/`); continue; }
    const path = url.slice(SITE_ORIGIN.length);
    if (/[?#]/.test(path)) problems.push(`${url} carries a query/fragment; probe the bare page`);
    if (!path.endsWith("/") && !/\.[a-z0-9]+$/i.test(path)) {
      problems.push(`${url} is a directory page without its trailing slash (GitHub Pages answers 301, not 200)`);
      continue;
    }
    if (isProjectSitePath(path, projectSites)) continue;
    const file = siteUrlToFile(url, root);
    if (!file) { problems.push(`${url} does not resolve to a committed page`); continue; }
    if (file.endsWith(".html") && isRedirectPage(readFileSync(file, "utf8"))) redirects++;
  }
  for (const loc of sitemap) {
    if (!urls.includes(loc)) problems.push(`canonical page ${loc} (listed in sitemap.xml) is not probed`);
  }
  if (!urls.includes(SITE_ORIGIN + "/404.html")) problems.push(`${SITE_ORIGIN}/404.html is not probed (the error page must serve HTTP 200)`);
  if (redirects === 0) problems.push("no redirect shortcut page is probed");
  return problems;
}

// The runbook intro and the probe list must name the same paths. The homepage
// is probed as the bare `/`, which the prose calls "the homepage" rather than
// spelling out; every other probe must appear verbatim.
export function runbookProblems(urls, markdown) {
  const problems = [];
  const probed = (urls ?? []).filter((u) => u.startsWith(SITE_ORIGIN + "/")).map((u) => u.slice(SITE_ORIGIN.length));
  const named = runbookProbedPaths(markdown);
  const intro = markdown.split(/^## /m)[0];
  if (probed.includes("/") && !/\bhomepage\b/i.test(intro)) problems.push("the job probes the homepage but the runbook intro never says so");
  for (const path of probed) {
    if (path !== "/" && !named.includes(path)) problems.push(`the job probes ${path} but the runbook intro does not name it`);
  }
  for (const path of named) {
    if (!probed.includes(path)) problems.push(`the runbook intro names ${path} but the job does not probe it`);
  }
  return problems;
}

// --- fixtures --------------------------------------------------------------

const GOOD_YAML = `name: x
jobs:
  availability:
    if: github.event_name == 'schedule'
    steps:
      - run: |
          for url in https://hivecommons.dev/ https://hivecommons.dev/stories/ \\
                     https://hivecommons.dev/docs/ https://hivecommons.dev/404.html; do
            curl "$url"
          done
  links:
    steps:
      - run: for url in https://example.com/; do echo "$url"; done
`;

test("fixture: the availability loop's word list is extracted with continuations joined", () => {
  assert.deepEqual(probedUrls(GOOD_YAML), [
    `${SITE_ORIGIN}/`, `${SITE_ORIGIN}/stories/`, `${SITE_ORIGIN}/docs/`, `${SITE_ORIGIN}/404.html`,
  ]);
});

test("fixture: a missing availability job or loop yields null", () => {
  assert.equal(probedUrls(GOOD_YAML.replace(/^\s{2}availability:/m, "  other:")), null);
  assert.equal(probedUrls(GOOD_YAML.replace("for url in", "for u in")), null);
});

test("fixture: siteUrlToFile resolves /, directories and bare files, and rejects the bare origin, foreign hosts and traversal", () => {
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/"), join(ROOT, "index.html"));
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/stories/"), join(ROOT, "stories", "index.html"));
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/og.png?v=2#x"), join(ROOT, "og.png"));
  // Unlike page-meta's resolver, the bare origin is not the home page here: a
  // probe URL must carry its trailing slash or curl sees a 301, not the page.
  assert.equal(siteUrlToFile(SITE_ORIGIN), null);
  assert.equal(siteUrlToFile("https://docs.hivecommons.dev/"), null);
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/../scripts/availability-probes.test.mjs"), null);
  assert.equal(siteUrlToFile(SITE_ORIGIN + "/definitely-not-a-page/"), null);
});

const CHECKER_FIXTURE = `SOFT_404_RE="x"

PROJECT_SITES=(
  /software-factory/   # hivecommons/software-factory

  /other-site/
)

is_project_site_path() {
  :
}
`;

test("fixture: PROJECT_SITES prefixes are read from check-links.sh with comments and blank lines dropped", () => {
  assert.deepEqual(projectSitePrefixes(CHECKER_FIXTURE), ["/software-factory/", "/other-site/"]);
  assert.deepEqual(projectSitePrefixes(CHECKER_FIXTURE.replace("PROJECT_SITES=(", "OTHER=(")), []);
  assert.deepEqual(projectSitePrefixes("PROJECT_SITES=(\n)\n"), []);
});

const QUOTED_CHECKER_FIXTURE = `PROJECT_SITES=(
  '/single-quoted/'   # single quotes

  "/double-quoted/"   # double quotes
  /unquoted/         # unquoted entries still work
)
`;

test("fixture: PROJECT_SITES accepts whole-entry single and double quotes alongside unquoted prefixes", () => {
  assert.deepEqual(projectSitePrefixes(QUOTED_CHECKER_FIXTURE), ["/single-quoted/", "/double-quoted/", "/unquoted/"]);
});

test("fixture: PROJECT_SITES leaves unmatched or mismatched quotes intact", () => {
  const prefixes = projectSitePrefixes(`PROJECT_SITES=(
  '/unmatched-single/
  "/unmatched-double/
  '/mismatched/"
)
`);
  assert.deepEqual(prefixes, ["'/unmatched-single/", '"/unmatched-double/', "'/mismatched/\""]);
  for (const path of ["/unmatched-single/", "/unmatched-double/", "/mismatched/"]) {
    assert.equal(isProjectSitePath(path, prefixes), false);
  }
});

test("fixture: isProjectSitePath matches a prefix, ignores query/fragment, and rejects a near-miss", () => {
  const prefixes = ["/software-factory/"];
  assert.equal(isProjectSitePath("/software-factory/", prefixes), true);
  assert.equal(isProjectSitePath("/software-factory/?flow=spek#top", prefixes), true);
  assert.equal(isProjectSitePath("/software-factory/deep/", prefixes), true);
  assert.equal(isProjectSitePath("/software-factory-notes/", prefixes), false);
  assert.equal(isProjectSitePath("/software-factory/", []), false);
});

test("fixture: isProjectSitePath recognizes parsed quoted prefixes and rejects near-misses", () => {
  const prefixes = projectSitePrefixes(QUOTED_CHECKER_FIXTURE);
  for (const prefix of ["/single-quoted/", "/double-quoted/", "/unquoted/"]) {
    assert.equal(isProjectSitePath(prefix, prefixes), true);
    assert.equal(isProjectSitePath(prefix + "deep/?x=1#top", prefixes), true);
    assert.equal(isProjectSitePath(prefix.slice(0, -1) + "-notes/", prefixes), false);
  }
});

test("fixture: sitemap <loc> values are extracted", () => {
  assert.deepEqual(sitemapLocs(`<urlset><url><loc> ${SITE_ORIGIN}/ </loc></url><url><loc>${SITE_ORIGIN}/a/</loc></url></urlset>`), [
    `${SITE_ORIGIN}/`, `${SITE_ORIGIN}/a/`,
  ]);
});

const FIXTURE_SITEMAP = [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/stories/`];
const GOOD_LIST = [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/stories/`, `${SITE_ORIGIN}/docs/`, `${SITE_ORIGIN}/llms.txt`, `${SITE_ORIGIN}/sitemap.xml`, `${SITE_ORIGIN}/robots.txt`, `${SITE_ORIGIN}/404.html`];

test("fixture: a list covering the sitemap, 404.html and a redirect passes", () => {
  assert.deepEqual(probeListProblems(GOOD_LIST, { sitemap: FIXTURE_SITEMAP }), []);
});

test("fixture: an empty or absent list is reported", () => {
  assert.equal(probeListProblems(null, { sitemap: [] }).length, 1);
  assert.equal(probeListProblems([], { sitemap: [] }).length, 1);
});

test("fixture: a probed URL with no committed page is reported", () => {
  const p = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/nope/`], { sitemap: FIXTURE_SITEMAP });
  assert.ok(p.some((x) => x.includes("/nope/ does not resolve")), p.join("\n"));
});

test("fixture: a project-site URL is accepted without a committed page only when its prefix is declared", () => {
  const projectSites = ["/software-factory/"];
  const probed = [...GOOD_LIST, `${SITE_ORIGIN}/software-factory/`];
  assert.deepEqual(probeListProblems(probed, { sitemap: FIXTURE_SITEMAP, projectSites }), []);
  const undeclared = probeListProblems(probed, { sitemap: FIXTURE_SITEMAP });
  assert.ok(undeclared.some((x) => x.includes("/software-factory/ does not resolve")), undeclared.join("\n"));
  const nearMiss = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/software-factory-notes/`], { sitemap: FIXTURE_SITEMAP, projectSites });
  assert.ok(nearMiss.some((x) => x.includes("/software-factory-notes/ does not resolve")), nearMiss.join("\n"));
  // The shape rules still apply: a project-site directory URL needs its slash and no query.
  const noSlash = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/software-factory`], { sitemap: FIXTURE_SITEMAP, projectSites });
  assert.ok(noSlash.some((x) => x.includes("/software-factory is a directory page without its trailing slash")), noSlash.join("\n"));
  const query = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/software-factory/?flow=spek`], { sitemap: FIXTURE_SITEMAP, projectSites });
  assert.ok(query.some((x) => x.includes("/software-factory/?flow=spek carries a query/fragment")), query.join("\n"));
});

test("fixture: project-site probes accept parsed single-quoted and double-quoted prefixes", () => {
  const projectSites = projectSitePrefixes(QUOTED_CHECKER_FIXTURE);
  const probed = [...GOOD_LIST, `${SITE_ORIGIN}/single-quoted/`, `${SITE_ORIGIN}/double-quoted/`, `${SITE_ORIGIN}/unquoted/`];
  assert.deepEqual(probeListProblems(probed, { sitemap: FIXTURE_SITEMAP, projectSites }), []);
});

test("fixture: a directory URL without its trailing slash is reported", () => {
  const p = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/code`], { sitemap: FIXTURE_SITEMAP });
  assert.ok(p.some((x) => x.includes("trailing slash")), p.join("\n"));
});

test("fixture: a canonical page missing from the probe list is reported", () => {
  const p = probeListProblems(GOOD_LIST.filter((u) => !u.endsWith("/stories/")), { sitemap: FIXTURE_SITEMAP });
  assert.ok(p.some((x) => x.includes("/stories/ (listed in sitemap.xml) is not probed")), p.join("\n"));
});

test("fixture: missing 404.html probe, missing redirect probe, duplicates and foreign origins are reported", () => {
  const no404 = probeListProblems(GOOD_LIST.filter((u) => !u.endsWith("404.html")), { sitemap: FIXTURE_SITEMAP });
  assert.ok(no404.some((x) => x.includes("404.html is not probed")), no404.join("\n"));
  const noRedirect = probeListProblems(GOOD_LIST.filter((u) => !u.endsWith("/docs/")), { sitemap: FIXTURE_SITEMAP });
  assert.ok(noRedirect.some((x) => x.includes("no redirect shortcut page")), noRedirect.join("\n"));
  const dup = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/`], { sitemap: FIXTURE_SITEMAP });
  assert.ok(dup.some((x) => x.includes("duplicate")), dup.join("\n"));
  const foreign = probeListProblems([...GOOD_LIST, "https://example.com/", "http://hivecommons.dev/"], { sitemap: FIXTURE_SITEMAP });
  assert.ok(foreign.some((x) => x.includes("example.com/ is not under")), foreign.join("\n"));
  assert.ok(foreign.some((x) => x.includes("http://hivecommons.dev/ is not https")), foreign.join("\n"));
  const query = probeListProblems([...GOOD_LIST, `${SITE_ORIGIN}/stories/?x=1`], { sitemap: FIXTURE_SITEMAP });
  assert.ok(query.some((x) => x.includes("query/fragment")), query.join("\n"));
});

const GOOD_RUNBOOK = `# Runbook: probe failing

The job requests the live homepage, \`/stories/\`, the \`/docs/\` shortcut redirect,
\`/llms.txt\`, \`/sitemap.xml\`, \`/robots.txt\`, \`/404.html\` and
the project site (/software-factory/) over HTTPS. See the [rollback runbook](release-rollback.md)
and the workflow (\`.github/workflows/links.yml\`).

## Who is affected

Every visitor to \`https://hivecommons.dev/\` and \`/stories/\`; also \`/never-probed/\`.
`;
const GOOD_RUNBOOK_LIST = [...GOOD_LIST, `${SITE_ORIGIN}/software-factory/`];

test("fixture: runbook probe paths are the intro's /-prefixed code spans and bare (/...) parentheticals, deduplicated, up to the first ## heading", () => {
  assert.deepEqual(runbookProbedPaths(GOOD_RUNBOOK), ["/stories/", "/docs/", "/llms.txt", "/sitemap.xml", "/robots.txt", "/404.html", "/software-factory/"]);
  assert.deepEqual(runbookProbedPaths("Intro names \`/a/\` twice: \`/a/\` and (/a/), plus \`a/b\`, \`.github/x\`, (b/) and (/sp ace/).\n"), ["/a/"]);
  assert.deepEqual(runbookProbedPaths("No headings and no paths.\n"), []);
});

test("fixture: a runbook naming exactly the probed paths (and the homepage in prose) passes", () => {
  assert.deepEqual(runbookProblems(GOOD_RUNBOOK_LIST, GOOD_RUNBOOK), []);
  // Without a homepage probe the prose need not mention it; foreign URLs are ignored here (probeListProblems reports them).
  assert.deepEqual(runbookProblems([...GOOD_RUNBOOK_LIST.filter((u) => u !== SITE_ORIGIN + "/"), "https://example.com/"], GOOD_RUNBOOK.replace("live homepage", "live site")), []);
  assert.deepEqual(runbookProblems(null, "Nothing here.\n"), []);
});

test("fixture: a probed path the runbook omits, a runbook path the job dropped, and an unmentioned homepage are each reported", () => {
  const omitted = runbookProblems([...GOOD_RUNBOOK_LIST, `${SITE_ORIGIN}/.well-known/security.txt`], GOOD_RUNBOOK);
  assert.deepEqual(omitted, ["the job probes /.well-known/security.txt but the runbook intro does not name it"]);
  const dropped = runbookProblems(GOOD_RUNBOOK_LIST.filter((u) => !u.endsWith("/robots.txt")), GOOD_RUNBOOK);
  assert.deepEqual(dropped, ["the runbook intro names /robots.txt but the job does not probe it"]);
  const noHome = runbookProblems(GOOD_RUNBOOK_LIST, GOOD_RUNBOOK.replace("live homepage", "live site"));
  assert.deepEqual(noHome, ["the job probes the homepage but the runbook intro never says so"]);
  // A path only named after the first ## heading does not count as a probe claim.
  assert.ok(!runbookProblems(GOOD_RUNBOOK_LIST, GOOD_RUNBOOK).some((x) => x.includes("/never-probed/")));
});

// --- the real workflow -----------------------------------------------------

test("check-links.sh declares at least one PROJECT_SITES prefix and each is a /-delimited directory path", () => {
  const prefixes = projectSitePrefixes(readFileSync(CHECKER, "utf8"));
  assert.ok(prefixes.includes("/software-factory/"), `the homepage embeds /software-factory/; parsed: ${JSON.stringify(prefixes)}`);
  for (const prefix of prefixes) assert.match(prefix, /^\/[^\s/]+(\/[^\s/]+)*\/$/, `${prefix} is not a /-delimited directory prefix`);
});

test("links.yml availability job probes every canonical page, 404.html and a redirect, each a committed page or a project-site path", () => {
  const urls = probedUrls(readFileSync(WORKFLOW, "utf8"));
  const sitemap = sitemapLocs(readFileSync(join(ROOT, "sitemap.xml"), "utf8"));
  const projectSites = projectSitePrefixes(readFileSync(CHECKER, "utf8"));
  assert.deepEqual(
    probeListProblems(urls, { sitemap, projectSites }),
    [],
    "the availability probe list in .github/workflows/links.yml drifted from the committed site (fixing it needs a workflow edit)",
  );
});

test("runbooks/availability-failure.md names exactly the paths the links.yml availability job probes", () => {
  const urls = probedUrls(readFileSync(WORKFLOW, "utf8"));
  assert.deepEqual(
    runbookProblems(urls, readFileSync(RUNBOOK, "utf8")),
    [],
    "the availability runbook's probe list drifted from .github/workflows/links.yml; update the runbook intro (or, if a probe was dropped, the workflow)",
  );
});

test("fixture: probeLoopParts separates the loop body from the code after done", () => {
  const yaml = "jobs:\n  availability:\n    steps:\n      - run: |\n          for url in a b; do\n            exit 1\n          done\n          exit 2\n";
  const parts = probeLoopParts(yaml);
  assert.match(parts.body, /exit 1/);
  assert.match(parts.after, /exit 2/);
  assert.equal(probeLoopParts("jobs:\n  other:\n"), null);
  assert.equal(probeLoopParts("jobs:\n  availability:\n    steps:\n      - run: curl -fsS a\n"), null, "job without a for-loop");
});

test("links.yml availability loop probes every URL: `exit` only after `done`, never inside the loop", () => {
  const parts = probeLoopParts(readFileSync(WORKFLOW, "utf8"));
  assert.ok(parts, "availability job has no `for url in ...; do ... done` loop");
  assert.doesNotMatch(parts.body, /^[^#\n]*\bexit\b/m, "exit inside the loop stops at the first failing URL; count failures and exit after done");
  assert.match(parts.after, /\bexit\s+1\b/, "the job must still fail after done when any probe failed");
});
