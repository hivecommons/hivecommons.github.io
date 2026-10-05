#!/usr/bin/env node
// Static gate for the contributor story cards in stories/index.html.
// Every card is hand-copied markup added in its own PR, and the page promises
// that "these cards only include public GitHub evidence". check-links.sh only
// proves each URL resolves; it cannot see that an avatar was copied from the
// previous card while the handle link was changed, that a card lost its
// evidence link, or that a date was mistyped. Each rule has a fixture self-test.
// Zero dependencies. Usage: node --test scripts/story-cards.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const STORIES_PAGE = join(ROOT, "stories", "index.html");

const GITHUB_PROFILE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)$/;
const GITHUB_AVATAR = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\.png(?:\?size=\d+)?$/;
const GITHUB_EVIDENCE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues|commit)\/[A-Za-z0-9]+$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return out;
}

function hasClass(tagAttrs, name) {
  return (tagAttrs.class ?? "").split(/\s+/).includes(name);
}

function lineOf(html, index) {
  return html.slice(0, index).split("\n").length;
}

function textOf(inner) {
  return inner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// Returns [{ line, html }] for every <article class="... story-card ...">.
export function storyCards(html) {
  const out = [];
  for (const m of html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    if (!hasClass(attrs(m[1]), "story-card")) continue;
    out.push({ line: lineOf(html, m.index), html: m[2] });
  }
  return out;
}

function anchors(fragment) {
  return [...fragment.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ ...attrs(m[1]), text: textOf(m[2]) }));
}

// One card's violations as human-readable strings (empty when clean).
export function cardProblems(card) {
  const problems = [];
  const handles = [...card.html.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)].filter((m) => hasClass(attrs(m[1]), "story-handle"));
  if (handles.length !== 1) {
    problems.push(`expected exactly one <p class="story-handle">, found ${handles.length}`);
  } else {
    const handleHtml = handles[0][2];
    const imgs = [...handleHtml.matchAll(/<img\b([^>]*)>/gi)].map((m) => attrs(m[1]));
    const avatars = imgs.filter((a) => hasClass(a, "story-avatar"));
    const links = anchors(handleHtml);
    if (avatars.length !== 1) problems.push(`story-handle must contain exactly one <img class="story-avatar">, found ${avatars.length}`);
    if (links.length !== 1) problems.push(`story-handle must contain exactly one <a>, found ${links.length}`);
    if (avatars.length === 1 && links.length === 1) {
      const avatar = avatars[0];
      const link = links[0];
      const avatarHandle = GITHUB_AVATAR.exec(avatar.src ?? "")?.[1];
      const linkHandle = GITHUB_PROFILE.exec(link.href ?? "")?.[1];
      if (!avatarHandle) problems.push(`avatar src ${JSON.stringify(avatar.src ?? "")} is not https://github.com/<handle>.png`);
      if (!linkHandle) problems.push(`handle link href ${JSON.stringify(link.href ?? "")} is not https://github.com/<handle>`);
      if (avatarHandle && linkHandle) {
        if (avatarHandle !== linkHandle) problems.push(`avatar is @${avatarHandle} but handle link is @${linkHandle}`);
        if (avatar.alt !== `@${linkHandle}`) problems.push(`avatar alt ${JSON.stringify(avatar.alt ?? "")} should be "@${linkHandle}"`);
        if (link.text !== `@${linkHandle}`) problems.push(`handle link text ${JSON.stringify(link.text)} should be "@${linkHandle}"`);
      }
      for (const [name, want] of [["loading", "lazy"], ["referrerpolicy", "no-referrer"]]) {
        if (avatar[name] !== want) problems.push(`avatar must set ${name}="${want}"`);
      }
      if (!/^\d+$/.test(avatar.width ?? "") || !/^\d+$/.test(avatar.height ?? "")) problems.push("avatar must declare numeric width and height");
      if (!(avatar.onerror ?? "").includes("hidden")) problems.push("avatar must hide itself onerror so a deleted account does not show a broken image");
    }
  }

  const headings = [...card.html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)].map((m) => textOf(m[1]));
  if (headings.length !== 1) problems.push(`expected exactly one <h3>, found ${headings.length}`);
  else if (!headings[0]) problems.push("<h3> is empty");

  const all = anchors(card.html);
  const evidence = all.filter((a) => hasClass(a, "inline-link"));
  if (evidence.length === 0) problems.push('card has no <a class="inline-link"> evidence link');
  for (const a of evidence) {
    if (!GITHUB_EVIDENCE.test(a.href ?? "")) problems.push(`evidence link ${JSON.stringify(a.href ?? "")} is not a GitHub pull/issue/commit URL`);
    if (!a.text) problems.push("evidence link has no text");
  }
  for (const a of all) {
    if (!/^https:\/\/github\.com\//.test(a.href ?? "")) problems.push(`link ${JSON.stringify(a.href ?? "")} is not public GitHub evidence`);
  }

  for (const m of card.html.matchAll(/\b([A-Z][a-z]+) (\d{1,2}), (\d{4})\b/g)) {
    const [, month, day, year] = m;
    const mi = MONTHS.indexOf(month);
    if (mi < 0) continue; // a capitalised word followed by numbers that is not a month
    const d = new Date(Date.UTC(Number(year), mi, Number(day)));
    if (d.getUTCMonth() !== mi || d.getUTCDate() !== Number(day)) problems.push(`"${m[0]}" is not a real calendar date`);
  }

  return problems;
}

export function duplicateHandles(cards) {
  const seen = new Map();
  const out = [];
  for (const card of cards) {
    const m = /<a\b[^>]*href\s*=\s*["'](https:\/\/github\.com\/[^"'/]+)["']/i.exec(card.html);
    if (!m) continue;
    const handle = m[1].toLowerCase();
    if (seen.has(handle)) out.push(`line ${card.line}: handle ${m[1]} already has a card at line ${seen.get(handle)}`);
    else seen.set(handle, card.line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture self-tests: prove every rule both passes clean markup and fires.
// ---------------------------------------------------------------------------

function fixtureCard({ handle = "octocat", avatarHandle = handle, alt = `@${handle}`, text = `@${handle}`, img = `src="https://github.com/${avatarHandle}.png?size=96" alt="${alt}" width="48" height="48" loading="lazy" referrerpolicy="no-referrer" onerror="this.hidden=true"`, h3 = "<h3>Contributor</h3>", body = '<p>First merged PR: <a href="https://github.com/o/r/pull/1">#1</a>, merged June 12, 2026.</p>', evidence = '<a class="inline-link" href="https://github.com/o/r/commit/abc123">View evidence</a>' } = {}) {
  return `<article class="story-card card-flagship">\n<p class="story-handle"><img class="story-avatar" ${img}><a href="https://github.com/${handle}">${text}</a></p>\n${h3}\n${body}\n${evidence}\n</article>`;
}

function problemsOf(cardHtml) {
  const cards = storyCards(`<html><body><div class="story-grid">\n${cardHtml}\n</div></body></html>`);
  assert.equal(cards.length, 1);
  return cardProblems(cards[0]);
}

test("fixture: a clean card passes every rule and non-story articles are ignored", () => {
  assert.deepEqual(problemsOf(fixtureCard()), []);
  assert.deepEqual(storyCards('<article class="other"><p>x</p></article>'), []);
});

test("fixture: avatar/alt/link/text handle disagreement is reported", () => {
  assert.deepEqual(problemsOf(fixtureCard({ handle: "alice", avatarHandle: "bob", alt: "@alice" })), ["avatar is @bob but handle link is @alice"]);
  assert.deepEqual(problemsOf(fixtureCard({ handle: "alice", alt: "@bob" })), ['avatar alt "@bob" should be "@alice"']);
  assert.deepEqual(problemsOf(fixtureCard({ handle: "alice", text: "alice" })), ['handle link text "alice" should be "@alice"']);
  assert.deepEqual(problemsOf(fixtureCard({ handle: "alice", avatarHandle: "alice", img: 'src="https://avatars.example/alice.png" alt="@alice" width="48" height="48" loading="lazy" referrerpolicy="no-referrer" onerror="this.hidden=true"' })), ['avatar src "https://avatars.example/alice.png" is not https://github.com/<handle>.png']);
});

test("fixture: avatar hardening attributes are required", () => {
  const problems = problemsOf(fixtureCard({ img: 'src="https://github.com/octocat.png?size=96" alt="@octocat"' }));
  assert.deepEqual(problems, [
    'avatar must set loading="lazy"',
    'avatar must set referrerpolicy="no-referrer"',
    "avatar must declare numeric width and height",
    "avatar must hide itself onerror so a deleted account does not show a broken image",
  ]);
});

test("fixture: missing or duplicated handle paragraph, heading and evidence link are reported", () => {
  assert.deepEqual(problemsOf('<article class="story-card"><h3>t</h3><a class="inline-link" href="https://github.com/o/r/pull/1">e</a></article>'), ['expected exactly one <p class="story-handle">, found 0']);
  assert.deepEqual(problemsOf(fixtureCard({ h3: "" })), ["expected exactly one <h3>, found 0"]);
  assert.deepEqual(problemsOf(fixtureCard({ h3: "<h3> </h3>" })), ["<h3> is empty"]);
  assert.deepEqual(problemsOf(fixtureCard({ evidence: "" })), ['card has no <a class="inline-link"> evidence link']);
  assert.deepEqual(problemsOf(fixtureCard({ evidence: '<a class="inline-link" href="https://github.com/o/r"></a>' })), [
    'evidence link "https://github.com/o/r" is not a GitHub pull/issue/commit URL',
    "evidence link has no text",
  ]);
});

test("fixture: any non-GitHub link inside a card violates the public-evidence promise", () => {
  assert.deepEqual(problemsOf(fixtureCard({ body: '<p>See <a href="https://example.com/blog">my blog</a>.</p>' })), ['link "https://example.com/blog" is not public GitHub evidence']);
  assert.deepEqual(problemsOf(fixtureCard({ body: '<p>See <a href="http://github.com/o/r/pull/1">#1</a>.</p>' })), ['link "http://github.com/o/r/pull/1" is not public GitHub evidence']);
});

test("fixture: impossible calendar dates are reported, real ones and non-month words are not", () => {
  assert.deepEqual(problemsOf(fixtureCard({ body: "<p>Merged February 30, 2026 and Node 22, 2026.</p>" })), ['"February 30, 2026" is not a real calendar date']);
  assert.deepEqual(problemsOf(fixtureCard({ body: "<p>Merged February 29, 2028.</p>" })), []);
});

test("fixture: two cards for the same handle (any case) are reported once", () => {
  const html = `${fixtureCard({ handle: "Alice" })}\n${fixtureCard({ handle: "bob" })}\n${fixtureCard({ handle: "alice" })}`;
  const cards = storyCards(html);
  assert.equal(cards.length, 3);
  assert.deepEqual(duplicateHandles(cards), [`line ${cards[2].line}: handle https://github.com/alice already has a card at line ${cards[0].line}`]);
});

// ---------------------------------------------------------------------------
// The committed page.
// ---------------------------------------------------------------------------

const PAGE = readFileSync(STORIES_PAGE, "utf8");
const CARDS = storyCards(PAGE);

test("stories/index.html: has at least one story card and every handle is unique", () => {
  assert.ok(CARDS.length > 0, "no <article class=\"story-card\"> found");
  assert.deepEqual(duplicateHandles(CARDS), []);
});

for (const card of CARDS) {
  const who = /<a\b[^>]*>(@[^<]+)<\/a>/.exec(card.html)?.[1] ?? "?";
  test(`stories/index.html: card ${who} (line ${card.line}) satisfies the public-evidence contract`, () => {
    assert.deepEqual(cardProblems(card), []);
  });
}
