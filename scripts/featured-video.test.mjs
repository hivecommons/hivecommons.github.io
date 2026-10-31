#!/usr/bin/env node
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const section = /<section\b[^>]*\bid="hive-in-practice"[^>]*>[\s\S]*?<\/section>/.exec(html)?.[0];
const VIDEO_ID = "bUhCBYi4dys";
const START_SECONDS = 369;

function attribute(tag, name) {
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  assert.ok(value, `missing ${name} attribute`);
  return value[1].replaceAll("&amp;", "&");
}

test("Bluefin's talk follows the Hive overview and precedes the project family", () => {
  assert.ok(section, "missing Hive in practice section");
  assert.ok(html.indexOf('id="hive"') < html.indexOf(section));
  assert.ok(html.indexOf(section) < html.indexOf('id="projects"'));
  assert.match(section, /<h2 id="hive-in-practice-title">Hive in practice<\/h2>/);
  assert.match(section, /aria-labelledby="hive-in-practice-title"/);
  assert.match(section, /How Project Bluefin uses Hive/);
  assert.match(section, /Jorge Castro/);
  assert.match(section, /GitHub Universe 2026/);
  assert.match(section, /Published by GitHub/);
});

test("the privacy-enhanced player starts at the Hive discussion without autoplay", () => {
  const frames = [...section.matchAll(/<iframe\b[^>]*>/g)];
  assert.equal(frames.length, 1);
  const frame = frames[0][0];
  const url = new URL(attribute(frame, "src"));
  assert.equal(url.origin, "https://www.youtube-nocookie.com");
  assert.equal(url.pathname, `/embed/${VIDEO_ID}`);
  assert.equal(url.searchParams.get("start"), String(START_SECONDS));
  assert.equal(url.searchParams.get("autoplay"), null);
  assert.doesNotMatch(attribute(frame, "allow"), /\bautoplay\b/);
  assert.equal(attribute(frame, "loading"), "lazy");
  assert.equal(attribute(frame, "referrerpolicy"), "strict-origin-when-cross-origin");
  assert.match(attribute(frame, "title"), /Jorge Castro.*CI\/CD/);
  assert.equal(Number(attribute(frame, "width")) / Number(attribute(frame, "height")), 16 / 9);
  assert.match(frame, /\sallowfullscreen(?:\s|>)/);
  assert.match(html, /frame-src https:\/\/www\.youtube-nocookie\.com;/);
});

test("direct YouTube links offer the highlighted discussion and full talk", () => {
  const links = [...section.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)];
  const discussion = links.find(([tag]) => tag.includes("Watch the Hive discussion"));
  const full = links.find(([tag]) => tag.includes("Watch the full talk"));
  assert.ok(discussion);
  assert.ok(full);
  const discussionUrl = new URL(attribute(discussion[0], "href"));
  const fullUrl = new URL(attribute(full[0], "href"));
  for (const url of [discussionUrl, fullUrl]) {
    assert.equal(url.origin, "https://www.youtube.com");
    assert.equal(url.pathname, "/watch");
    assert.equal(url.searchParams.get("v"), VIDEO_ID);
  }
  assert.equal(discussionUrl.searchParams.get("t"), `${START_SECONDS}s`);
  assert.equal(fullUrl.searchParams.get("t"), null);
});

test("the Bluefin adopter links to the talk and its original GitHub link remains available", () => {
  assert.match(html, /<a href="#hive-in-practice"><img src="\/assets\/adopters\/projectbluefin\.png"/);
  assert.match(section, /<a href="https:\/\/github\.com\/projectbluefin">Project Bluefin<\/a>/);
});
