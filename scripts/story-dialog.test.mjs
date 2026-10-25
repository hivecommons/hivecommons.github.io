#!/usr/bin/env node
// Self-test for the "Share your story" dialog script inlined in stories/index.html.
//
// The script is extracted verbatim from the page and run against a tiny stub DOM
// (no jsdom, no npm) so the prefilled GitHub issue URL, validation, truncation,
// and popup-blocked fallback can be asserted offline.
// Usage: node --test scripts/story-dialog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "stories", "index.html");
const STORY_MAX = 1500;

function extractDialogScript(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const dialogScripts = blocks.filter((s) => s.includes('getElementById("story-dialog")'));
  assert.equal(dialogScripts.length, 1, "expected exactly one story-dialog script block");
  return dialogScripts[0];
}

class ClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : Boolean(force);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}

class Element {
  constructor(doc, id, opts = {}) {
    this.doc = doc;
    this.id = id;
    this.value = opts.value ?? "";
    this.checked = false;
    this.textContent = "";
    this.hidden = false;
    this.href = "";
    this.open = false;
    this.offsetParent = {};
    this.attrs = {};
    this.listeners = {};
    this.classList = new ClassList();
    this.parentElement = null;
    this.focusCount = 0;
    this.children = [];
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "href") this.href = String(v); if (k === "open") this.open = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === "href") this.href = ""; if (k === "open") this.open = false; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, init = {}) {
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  focus() { this.focusCount++; this.doc.activeElement = this; }
  getBoundingClientRect() { return { left: 100, top: 100, right: 500, bottom: 400 }; }
  querySelectorAll(selector) { return this.doc.select(selector, this); }
  querySelector(selector) { return this.doc.select(selector, this)[0] || null; }
}

function makeDocument() {
  const doc = { byId: new Map(), activeElement: null };
  doc.getElementById = (id) => doc.byId.get(id) || null;
  doc.querySelectorAll = (selector) => doc.select(selector, null);
  // Only the handful of selectors the page script uses are supported.
  doc.select = (selector, scope) => {
    // Form fields live inside both the form and the dialog; the form is nested in the dialog.
    const within = (el) => !scope || el === scope || el.scope === scope || (scope.id === "story-form" && el.scope === doc.getElementById("story-dialog"));
    const all = [...doc.byId.values()].filter(within);
    if (selector === "[data-story-open]") return all.filter((el) => "data-story-open" in el.attrs);
    if (selector === "[data-story-close]") return all.filter((el) => "data-story-close" in el.attrs);
    if (selector === "[aria-invalid='true']") return all.filter((el) => el.attrs["aria-invalid"] === "true");
    if (selector.startsWith("a[href], button")) return all.filter((el) => el.focusable);
    throw new Error("unsupported selector in stub DOM: " + selector);
  };
  const add = (id, opts = {}) => {
    const el = new Element(doc, id, opts);
    Object.assign(el, opts);
    doc.byId.set(id, el);
    return el;
  };

  const dialog = add("story-dialog");
  dialog.showModalCalls = 0;
  dialog.closeCalls = 0;
  dialog.showModal = () => { dialog.showModalCalls++; dialog.open = true; };
  dialog.close = () => { dialog.closeCalls++; dialog.open = false; };
  const form = add("story-form", { scope: dialog });

  const inDialog = (id, opts = {}) => add(id, { scope: dialog, focusable: true, ...opts });
  add("opener-hero", { attrs: { "data-story-open": "" } });
  add("opener-band", { attrs: { "data-story-open": "" } });
  inDialog("story-close-x", { attrs: { "data-story-close": "" } });
  inDialog("story-name");
  add("story-name-error", { scope: dialog });
  inDialog("story-profile");
  add("story-profile-error", { scope: dialog });
  inDialog("story-project", { value: "Hive" });
  add("story-project-error", { scope: dialog });
  inDialog("story-role", { value: "first-time contributor" });
  const text = inDialog("story-text");
  add("story-text-error", { scope: dialog });
  const count = add("story-count", { scope: dialog });
  count.parentElement = add("story-counter", { scope: dialog });
  inDialog("story-quote");
  inDialog("story-link");
  add("story-link-error", { scope: dialog });
  add("story-status", { scope: dialog });
  const fallback = add("story-fallback", { scope: dialog });
  fallback.hidden = true;
  inDialog("story-fallback-link", { href: "https://github.com/hivecommons/hive/issues/new?template=contributor-story.yml" });
  inDialog("story-copy");
  inDialog("story-cancel", { attrs: { "data-story-close": "" } });
  void text;
  return doc;
}

function boot({ popupBlocked = false, clipboardOverride } = {}) {
  const html = readFileSync(PAGE, "utf8");
  const src = extractDialogScript(html);
  const doc = makeDocument();
  const body = new Element(doc, "body");
  doc.body = body;
  const opened = [];
  const win = {
    open(url, target) {
      if (popupBlocked) return null;
      const tab = { url, target, opener: "parent", location: null };
      opened.push(tab);
      return tab;
    }
  };
  const clipboard = { written: [] };
  const navigator = { clipboard: { writeText(t) { clipboard.written.push(t); return Promise.resolve(); } } };
  if (clipboardOverride !== undefined) navigator.clipboard = clipboardOverride.clipboard;
  const timers = [];
  const setTimeoutStub = (fn) => { timers.push(fn); return timers.length; };
  const run = new Function("document", "window", "navigator", "setTimeout", src);
  run(doc, win, navigator, setTimeoutStub);
  const el = (id) => doc.getElementById(id);
  return {
    doc, el, opened, clipboard, timers,
    dialog: el("story-dialog"),
    form: el("story-form"),
    flush() { while (timers.length) timers.shift()(); },
    fill(values) { for (const [id, v] of Object.entries(values)) { if (typeof v === "boolean") el(id).checked = v; else el(id).value = v; } },
    submit() { return el("story-form").dispatch("submit"); },
    issueUrl() { assert.equal(opened.length, 1, "expected exactly one tab opened"); return new URL(opened[0].location); }
  };
}

async function copied(t) {
  t.el("story-copy").dispatch("click");
  await Promise.resolve();
  return t.clipboard.written[0];
}

const VALID = {
  "story-name": "  Ada Lovelace ",
  "story-project": "Dibs",
  "story-text": "Picked a good-first-issue, the relay scaffolded the fix, merged in an hour.",
  "story-profile": "https://github.com/ada",
  "story-link": "https://github.com/hivecommons/dibs/pull/7",
  "story-quote": true
};

test("page contains exactly one dialog script and the stub can boot it", () => {
  const t = boot();
  assert.ok(t.dialog.listeners.keydown, "dialog registers keydown trap");
  assert.ok(t.form.listeners.submit, "form registers submit handler");
  assert.equal(t.el("story-count").textContent, "0", "counter initialised on load");
});

test("submit opens the hive contributor-story issue form prefilled via field ids — labels come from the template", () => {
  const t = boot();
  t.fill(VALID);
  const ev = t.submit();
  assert.ok(ev.defaultPrevented, "native form submit suppressed");
  const url = t.issueUrl();
  assert.equal(url.origin + url.pathname, "https://github.com/hivecommons/hive/issues/new");
  const p = url.searchParams;
  assert.equal(p.get("template"), "contributor-story.yml");
  assert.equal(p.get("labels"), null, "labels= is ignored for non-maintainers; the template applies them (#223)");
  assert.equal(p.get("body"), null, "issue forms ignore body=");
  assert.equal(p.get("title"), "📖 contributor story: Ada Lovelace on Dibs", "title uses trimmed name and project");
  assert.equal(p.get("name"), "Ada Lovelace");
  assert.equal(p.get("profile"), "https://github.com/ada");
  assert.equal(p.get("project"), "Dibs");
  assert.equal(p.get("role"), "first-time contributor");
  assert.equal(p.get("story"), VALID["story-text"]);
  assert.equal(p.get("link"), "https://github.com/hivecommons/dibs/pull/7");
  assert.deepEqual([...p.keys()].sort(), ["link", "name", "profile", "project", "role", "story", "template", "title"]);
});

test("copied text is the markdown summary with every field, in order", async () => {
  const t = boot();
  t.fill(VALID);
  t.submit();
  const body = await copied(t);
  assert.deepEqual(body.split("\n"), [
    "## Contributor story",
    "",
    "**Name or handle:** Ada Lovelace",
    "**Profile:** https://github.com/ada",
    "**Project / hive:** Dibs",
    "**Role:** first-time contributor",
    "**Can quote by name:** Yes",
    "**PR / issue:** https://github.com/hivecommons/dibs/pull/7",
    "",
    "### Story",
    VALID["story-text"]
  ]);
});

test("optional fields are omitted from the form URL; copied text says 'Not provided' and quote defaults to No", async () => {
  const t = boot();
  t.fill({ ...VALID, "story-profile": "", "story-link": "", "story-quote": false });
  t.submit();
  assert.equal(t.issueUrl().searchParams.has("profile"), false);
  assert.equal(t.issueUrl().searchParams.has("link"), false);
  const body = await copied(t);
  assert.match(body, /\*\*Profile:\*\* Not provided\n/);
  assert.match(body, /\*\*PR \/ issue:\*\* Not provided\n/);
  assert.match(body, /\*\*Can quote by name:\*\* No\n/);
});

test("opened tab is detached from the opener before navigation", () => {
  const t = boot();
  t.fill(VALID);
  t.submit();
  assert.equal(t.opened[0].url, "", "tab is opened blank first so opener can be severed");
  assert.equal(t.opened[0].target, "_blank");
  assert.equal(t.opened[0].opener, null, "opener nulled (reverse-tabnabbing guard)");
  assert.match(t.el("story-status").textContent, /opened as a draft issue in a new tab/);
});

test("success note tells the contributor to re-pick Role and re-tick quote consent — GitHub forms only prefill text fields (#223)", () => {
  const t = boot();
  t.fill(VALID);
  t.submit();
  const note = t.el("story-status").textContent;
  assert.match(note, /pick your Role again/);
  assert.match(note, /re-tick Can we quote you by name\?/);
  assert.match(note, /Submit new issue/);
});

test("success note skips the quote reminder when the contributor did not consent", () => {
  const t = boot();
  t.fill({ ...VALID, "story-quote": false });
  t.submit();
  const note = t.el("story-status").textContent;
  assert.match(note, /pick your Role again/);
  assert.doesNotMatch(note, /quote you by name/);
});

test("popup-blocked fallback copy also says Role and quote consent must be re-entered on GitHub", () => {
  const html = readFileSync(PAGE, "utf8");
  const fallback = html.match(/<div class="story-fallback"[\s\S]*?<\/div>/)[0];
  assert.match(fallback, /pick your Role and tick Can we quote you by name\? again there/);
});

test("required fields block submission and flag the first invalid field", () => {
  const t = boot();
  t.fill({ ...VALID, "story-name": "   ", "story-text": "" });
  t.submit();
  assert.equal(t.opened.length, 0, "no tab opened when invalid");
  assert.equal(t.el("story-name").getAttribute("aria-invalid"), "true");
  assert.equal(t.el("story-name-error").textContent, "Name or handle is required.");
  assert.equal(t.el("story-text").getAttribute("aria-invalid"), "true");
  assert.equal(t.el("story-text-error").textContent, "Your story is required.");
  assert.equal(t.el("story-project").getAttribute("aria-invalid"), "false");
  assert.equal(t.el("story-project-error").textContent, "");
  assert.equal(t.doc.activeElement, t.el("story-name"), "focus moves to first invalid field");
});

test("profile and PR links must be absolute http(s) URLs", () => {
  for (const bad of ["github.com/ada", "javascript:alert(1)", "ftp://x.example", "not a url"]) {
    const t = boot();
    t.fill({ ...VALID, "story-profile": bad });
    t.submit();
    assert.equal(t.opened.length, 0, `profile ${JSON.stringify(bad)} rejected`);
    assert.equal(t.el("story-profile-error").textContent, "Use a full http:// or https:// URL.");
  }
  const t = boot();
  t.fill({ ...VALID, "story-link": "http://example.org/pr/1" });
  t.submit();
  assert.equal(t.opened.length, 1, "plain http link accepted");
});

test("story over 1500 chars is trimmed in the form URL and the user is told", () => {
  const t = boot();
  const long = "x".repeat(STORY_MAX - 3) + "   tail-that-gets-cut";
  t.fill({ ...VALID, "story-text": long });
  t.submit();
  const story = t.issueUrl().searchParams.get("story");
  assert.equal(story, "x".repeat(STORY_MAX - 3), "sliced at 1500 then trailing whitespace trimmed");
  assert.match(t.el("story-status").textContent, /^Your story was trimmed to 1500 characters/);
});

test("story cut inside an emoji drops the half pair so the form URL still opens", () => {
  const t = boot();
  t.fill({ ...VALID, "story-text": "a".repeat(STORY_MAX - 1) + "😀 tail" });
  t.submit();
  assert.equal(t.opened.length, 1, "submit opens the draft issue instead of throwing URIError");
  assert.equal(t.issueUrl().searchParams.get("story"), "a".repeat(STORY_MAX - 1));
});

test("story at exactly 1500 chars is not trimmed", () => {
  const t = boot();
  t.fill({ ...VALID, "story-text": "y".repeat(STORY_MAX) });
  t.submit();
  assert.equal(t.issueUrl().searchParams.get("story").length, STORY_MAX);
  assert.doesNotMatch(t.el("story-status").textContent, /trimmed/);
});

test("character counter caps at the soft max and marks overflow", () => {
  const t = boot();
  const text = t.el("story-text");
  text.value = "a".repeat(10);
  text.dispatch("input");
  assert.equal(t.el("story-count").textContent, "10");
  assert.equal(t.el("story-counter").classList.contains("is-over"), false);
  text.value = "a".repeat(STORY_MAX + 50);
  text.dispatch("input");
  assert.equal(t.el("story-count").textContent, String(STORY_MAX));
  assert.equal(t.el("story-counter").classList.contains("is-over"), true);
});

test("popup blocked: fallback link gets the prefilled URL and copy button yields the same markdown", async () => {
  const t = boot({ popupBlocked: true });
  t.el("opener-hero").dispatch("click");
  assert.equal(t.el("story-fallback-link").href, "", "stale static href cleared on open (#55)");
  assert.equal(t.el("story-fallback").hidden, true);
  t.fill(VALID);
  t.submit();
  assert.equal(t.el("story-fallback").hidden, false, "fallback revealed");
  const href = new URL(t.el("story-fallback-link").href);
  assert.equal(href.searchParams.get("title"), "📖 contributor story: Ada Lovelace on Dibs");
  assert.equal(t.el("story-status").textContent, "", "no success note when nothing opened");
  t.el("story-copy").dispatch("click");
  await Promise.resolve();
  assert.equal(t.clipboard.written.length, 1);
  assert.equal(t.clipboard.written[0].split("### Story\n")[1], href.searchParams.get("story"), "clipboard markdown carries the same story");
  assert.match(t.el("story-status").textContent, /^Copied\./);
});

test("popup blocked with truncated story: fallback revealed and trimmed-story notice shown", async () => {
  const t = boot({ popupBlocked: true });
  const long = "x".repeat(STORY_MAX - 3) + "   tail-that-gets-cut";
  t.el("opener-hero").dispatch("click");
  t.fill({ ...VALID, "story-text": long });
  t.submit();
  assert.equal(t.el("story-fallback").hidden, false, "fallback revealed");
  assert.match(t.el("story-status").textContent, /^Your story was trimmed to 1500 characters/, "trimmed-story notice shown when popup blocked");
  const href = new URL(t.el("story-fallback-link").href);
  const story = href.searchParams.get("story");
  assert.equal(story, "x".repeat(STORY_MAX - 3), "fallback link carries the trimmed story");
});

test("popup blocked with truncated story: copy issue text carries the full story", async () => {
  const t = boot({ popupBlocked: true });
  const long = "x".repeat(STORY_MAX - 3) + "   tail-that-gets-cut";
  t.el("opener-hero").dispatch("click");
  t.fill({ ...VALID, "story-text": long });
  t.submit();
  const href = new URL(t.el("story-fallback-link").href);
  assert.equal(href.searchParams.get("story"), "x".repeat(STORY_MAX - 3), "fallback link carries the trimmed story");
  assert.match(t.el("story-status").textContent, /Copy issue text carries the full story\./);
  t.el("story-copy").dispatch("click");
  await Promise.resolve();
  assert.equal(t.clipboard.written[0].split("### Story\n")[1], long, "clipboard markdown carries the full story");
});

test("popup blocked with non-truncated story: fallback revealed but no notice shown", () => {
  const t = boot({ popupBlocked: true });
  t.el("opener-hero").dispatch("click");
  t.fill(VALID);
  t.submit();
  assert.equal(t.el("story-fallback").hidden, false, "fallback revealed");
  assert.equal(t.el("story-status").textContent, "", "no truncation notice when story not truncated");
});

test("copy button tells the user to use the prefilled link when the clipboard write is rejected", async () => {
  const t = boot({ popupBlocked: true, clipboardOverride: { clipboard: { writeText() { return Promise.reject(new Error("denied")); } } } });
  t.el("opener-hero").dispatch("click");
  t.fill(VALID);
  t.submit();
  t.el("story-copy").dispatch("click");
  await Promise.resolve();
  await Promise.resolve();
  assert.match(t.el("story-status").textContent, /^Copy did not work\..*prefilled issue link above/);
});

test("copy button tells the user to use the prefilled link when navigator.clipboard is unavailable", () => {
  const t = boot({ popupBlocked: true, clipboardOverride: { clipboard: undefined } });
  t.el("opener-hero").dispatch("click");
  t.fill(VALID);
  t.submit();
  t.el("story-copy").dispatch("click");
  assert.match(t.el("story-status").textContent, /^Copy did not work\..*prefilled issue link above/);
});

test("open/close lifecycle: showModal, focus to name, Escape closes and restores focus", () => {
  const t = boot();
  const opener = t.el("opener-band");
  opener.focus();
  opener.dispatch("click");
  assert.equal(t.dialog.showModalCalls, 1);
  t.flush();
  assert.equal(t.doc.activeElement, t.el("story-name"), "first field focused after open");
  t.el("story-status").textContent = "leftover";
  t.dialog.dispatch("keydown", { key: "Escape" });
  assert.equal(t.dialog.closeCalls, 1);
  assert.equal(t.doc.activeElement, opener, "focus returned to the opener");
  opener.dispatch("click");
  assert.equal(t.el("story-status").textContent, "", "status reset on reopen");
});

test("dialog falls back to the open attribute when showModal is unavailable", () => {
  const t = boot();
  t.dialog.showModal = undefined;
  t.dialog.close = undefined;
  t.el("opener-hero").dispatch("click");
  assert.equal(t.dialog.getAttribute("open"), "");
  assert.ok(t.dialog.classList.contains("is-fallback-open"));
  assert.ok(t.doc.body.classList.contains("story-modal-open"));
  t.el("story-cancel").dispatch("click");
  assert.equal(t.dialog.getAttribute("open"), null);
  assert.equal(t.dialog.classList.contains("is-fallback-open"), false);
  assert.equal(t.doc.body.classList.contains("story-modal-open"), false);
});

test("Tab wraps focus inside the dialog in both directions", () => {
  const t = boot();
  t.el("opener-hero").dispatch("click");
  const items = t.dialog.querySelectorAll("a[href], button:not([disabled])");
  const first = items[0];
  const last = items[items.length - 1];
  last.focus();
  let ev = t.dialog.dispatch("keydown", { key: "Tab", shiftKey: false });
  assert.ok(ev.defaultPrevented);
  assert.equal(t.doc.activeElement, first, "Tab on last wraps to first");
  ev = t.dialog.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.ok(ev.defaultPrevented);
  assert.equal(t.doc.activeElement, last, "Shift+Tab on first wraps to last");
  t.el("story-name").focus();
  ev = t.dialog.dispatch("keydown", { key: "Tab", shiftKey: false });
  assert.equal(ev.defaultPrevented, false, "Tab in the middle is left to the browser");
});

test("keys other than Escape and Tab pass through the focus trap untouched", () => {
  const t = boot();
  t.el("opener-hero").dispatch("click");
  const items = t.dialog.querySelectorAll("a[href], button:not([disabled])");
  const last = items[items.length - 1];
  last.focus();
  for (const key of ["Enter", " ", "ArrowDown", "a"]) {
    const ev = t.dialog.dispatch("keydown", { key, shiftKey: false });
    assert.equal(ev.defaultPrevented, false, `${JSON.stringify(key)} is not intercepted`);
    assert.equal(t.doc.activeElement, last, `${JSON.stringify(key)} does not move focus`);
  }
  assert.equal(t.dialog.closeCalls, 0, "only Escape closes");
});

test("focus trap skips focusables that are not rendered (hidden fallback link) unless they hold focus", () => {
  const t = boot();
  t.el("opener-hero").dispatch("click");
  // The popup-blocked fallback block is `hidden` until needed, so its link and the
  // copy button have no layout box; the trap must wrap around them, not onto them.
  const copy = t.el("story-copy");
  const fallbackLink = t.el("story-fallback-link");
  copy.offsetParent = null;
  fallbackLink.offsetParent = null;
  const rendered = t.dialog.querySelectorAll("a[href], button:not([disabled])").filter((el) => el.offsetParent !== null);
  const first = rendered[0];
  const last = rendered[rendered.length - 1];
  assert.notEqual(last, copy);
  assert.notEqual(last, fallbackLink);
  first.focus();
  let ev = t.dialog.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.ok(ev.defaultPrevented);
  assert.equal(t.doc.activeElement, last, "Shift+Tab on first wraps to the last RENDERED control");
  ev = t.dialog.dispatch("keydown", { key: "Tab", shiftKey: false });
  assert.equal(t.doc.activeElement, first, "Tab on last rendered control wraps to first");
  // A hidden element that somehow holds focus is still part of the ring so the
  // trap cannot strand focus on it.
  copy.focus();
  ev = t.dialog.dispatch("keydown", { key: "Tab", shiftKey: false });
  assert.equal(ev.defaultPrevented, false, "focused-but-unrendered element is counted; it is not last so Tab passes through");
  fallbackLink.offsetParent = {};
  copy.offsetParent = {};
});

test("focus trap is a no-op when nothing in the dialog is focusable", () => {
  const t = boot();
  t.el("opener-hero").dispatch("click");
  const items = t.dialog.querySelectorAll("a[href], button:not([disabled])");
  for (const item of items) item.offsetParent = null;
  t.doc.activeElement = t.doc.body;
  const ev = t.dialog.dispatch("keydown", { key: "Tab", shiftKey: false });
  assert.equal(ev.defaultPrevented, false, "no items: browser handles Tab");
  assert.equal(t.doc.activeElement, t.doc.body, "focus untouched");
  for (const item of items) item.offsetParent = {};
});

test("project is required and the PR/issue link must be an absolute http(s) URL", () => {
  let t = boot();
  t.fill({ ...VALID, "story-project": "  " });
  t.submit();
  assert.equal(t.opened.length, 0, "blank project blocks submission");
  assert.equal(t.el("story-project").getAttribute("aria-invalid"), "true");
  assert.equal(t.el("story-project-error").textContent, "Project or hive is required.");
  assert.equal(t.el("story-project").getAttribute("aria-describedby"), "story-project-error");
  assert.equal(t.doc.activeElement, t.el("story-project"), "focus moves to the project field");

  for (const bad of ["hivecommons/dibs#7", "javascript:void(0)", "mailto:ada@example.org"]) {
    t = boot();
    t.fill({ ...VALID, "story-link": bad });
    t.submit();
    assert.equal(t.opened.length, 0, `link ${JSON.stringify(bad)} rejected`);
    assert.equal(t.el("story-link").getAttribute("aria-invalid"), "true");
    assert.equal(t.el("story-link-error").textContent, "Use a full http:// or https:// URL.");
    assert.equal(t.el("story-profile").getAttribute("aria-invalid"), "false", "valid profile not flagged alongside");
  }

  // Fixing the field clears the message on the next submit.
  t.fill({ "story-link": "https://github.com/hivecommons/dibs/pull/7" });
  t.submit();
  assert.equal(t.opened.length, 1);
  assert.equal(t.el("story-link").getAttribute("aria-invalid"), "false");
  assert.equal(t.el("story-link-error").textContent, "");
});

test("clicking the backdrop closes; clicking inside the panel does not", () => {
  const t = boot();
  t.el("opener-hero").dispatch("click");
  t.dialog.dispatch("click", { clientX: 300, clientY: 250 });
  assert.equal(t.dialog.closeCalls, 0, "inside the panel rect");
  t.dialog.dispatch("click", { clientX: 10, clientY: 10 });
  assert.equal(t.dialog.closeCalls, 1, "outside the panel rect");
  t.dialog.dispatch("click", { clientX: 10, clientY: 10, target: t.el("story-name") });
  assert.equal(t.dialog.closeCalls, 1, "bubbled clicks from children never close");
});

test("cancel event (browser Escape) is intercepted so cleanup always runs", () => {
  const t = boot();
  t.el("opener-hero").dispatch("click");
  const ev = t.dialog.dispatch("cancel");
  assert.ok(ev.defaultPrevented);
  assert.equal(t.dialog.closeCalls, 1);
});
