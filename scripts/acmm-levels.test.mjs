#!/usr/bin/env node
// Self-test for the ACMM levels tablist script inlined in index.html.
//
// The script is extracted verbatim from the page and run against a tiny stub DOM
// (no jsdom, no npm) so tab activation, roving tabindex, keyboard navigation,
// auto-rotation, and the pause conditions (hover, focus, hidden tab, reduced
// motion, out of view) can be asserted offline.
// Usage: node --test scripts/acmm-levels.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "index.html");
const HOLD_MS = 5000;
const LEVELS = 6;

function extractAcmmScript(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const scripts = blocks.filter((s) => s.includes("[data-acmm-levels]"));
  assert.equal(scripts.length, 1, "expected exactly one ACMM levels script block");
  return scripts[0];
}

class ClassList {
  constructor(initial = []) { this.set = new Set(initial); }
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
  constructor(doc, name, { classes = [], attrs = {}, parent = null } = {}) {
    this.doc = doc;
    this.name = name;
    this.classList = new ClassList(classes);
    this.attrs = { ...attrs };
    this.listeners = {};
    this.children = [];
    this.parent = parent;
    this.tabIndex = 0;
    this.focusCount = 0;
    if (parent) parent.children.push(this);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, init = {}) {
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  focus() { this.focusCount++; this.doc.activeElement = this; }
  contains(other) {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  }
  descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(selector) {
    const m = /^\[([a-z-]+)\]$/.exec(selector);
    if (!m) throw new Error("unsupported selector in stub DOM: " + selector);
    return this.descendants().filter((el) => m[1] in el.attrs);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function makeDocument({ activeIndex = 0 } = {}) {
  const doc = { activeElement: null, hidden: false, listeners: {} };
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  doc.dispatch = (type) => { for (const fn of doc.listeners[type] || []) fn({ type }); };

  const root = new Element(doc, "root", { attrs: { "data-acmm-levels": "" } });
  const list = new Element(doc, "list", { attrs: { "data-acmm-list": "" }, parent: root });
  const details = new Element(doc, "details", { attrs: { "data-acmm-details": "" }, parent: root });
  const levels = [];
  const tabs = [];
  const panels = [];
  for (let i = 0; i < LEVELS; i++) {
    const active = i === activeIndex;
    const level = new Element(doc, "level-" + (i + 1), {
      attrs: { "data-acmm-level": "" },
      classes: active ? ["is-active"] : [],
      parent: list,
    });
    const tab = new Element(doc, "tab-" + (i + 1), {
      attrs: { "data-acmm-tab": "", "aria-selected": active ? "true" : "false" },
      parent: level,
    });
    const panel = new Element(doc, "panel-" + (i + 1), {
      attrs: { "data-acmm-panel": "" },
      classes: active ? ["is-active"] : [],
      parent: details,
    });
    levels.push(level); tabs.push(tab); panels.push(panel);
  }
  doc.querySelector = (selector) => {
    if (selector === "[data-acmm-levels]") return root;
    throw new Error("unsupported document selector in stub DOM: " + selector);
  };
  return { doc, root, levels, tabs, panels };
}

// Deterministic timer queue: boot() returns advance(ms) to fire due timers.
function makeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pendingCount() { return pending.size; },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, t] = due[0];
        pending.delete(id);
        now = t.at;
        t.fn();
      }
      now = target;
    },
  };
}

function boot({ reduceMotion = false, intersectionObserver = true, activeIndex = 0 } = {}) {
  const html = readFileSync(PAGE, "utf8");
  const src = extractAcmmScript(html);
  const dom = makeDocument({ activeIndex });
  const timers = makeTimers();
  const mq = { matches: reduceMotion, listeners: [], addEventListener(type, fn) { if (type === "change") this.listeners.push(fn); } };
  mq.set = (matches) => { mq.matches = matches; mq.listeners.forEach((fn) => fn({ matches })); };

  const observers = [];
  class IntersectionObserver {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.observed = []; observers.push(this); }
    observe(el) { this.observed.push(el); }
    fire(isIntersecting) { this.cb(this.observed.map((target) => ({ target, isIntersecting }))); }
  }
  const win = { matchMedia: () => mq };
  if (intersectionObserver) win.IntersectionObserver = IntersectionObserver;

  // The page calls `new IntersectionObserver(...)` as a bare global after
  // feature-detecting it on `window`, so both bindings are supplied.
  const run = new Function("document", "window", "setTimeout", "clearTimeout", "IntersectionObserver", src);
  run(dom.doc, win, timers.setTimeout, timers.clearTimeout, intersectionObserver ? IntersectionObserver : undefined);

  const activeIndexNow = () => dom.levels.findIndex((l) => l.classList.contains("is-active"));
  const show = () => { if (observers[0]) observers[0].fire(true); };
  return { ...dom, timers, mq, observers, win, activeIndexNow, show, advance: timers.advance };
}

function assertActive(t, i, msg) {
  assert.equal(t.activeIndexNow(), i, msg || `level ${i + 1} should be active`);
  t.levels.forEach((level, k) => {
    const on = k === i;
    assert.equal(level.classList.contains("is-active"), on, `level ${k + 1} is-active`);
    assert.equal(t.tabs[k].getAttribute("aria-selected"), on ? "true" : "false", `tab ${k + 1} aria-selected`);
    assert.equal(t.tabs[k].tabIndex, on ? 0 : -1, `tab ${k + 1} tabIndex (roving)`);
    assert.equal(t.panels[k].classList.contains("is-active"), on, `panel ${k + 1} is-active`);
    assert.equal(t.panels[k].getAttribute("aria-hidden"), on ? "false" : "true", `panel ${k + 1} aria-hidden`);
  });
}

test("page markup: one ACMM root, six levels with tabs, six matching panels", () => {
  // Strip inline scripts so selector strings in the JS don't count as markup.
  const html = readFileSync(PAGE, "utf8").replace(/<script>[\s\S]*?<\/script>/g, "");
  assert.equal((html.match(/data-acmm-levels\b/g) || []).length, 1);
  assert.equal((html.match(/data-acmm-level\b/g) || []).length, LEVELS);
  assert.equal((html.match(/data-acmm-tab\b/g) || []).length, LEVELS);
  assert.equal((html.match(/data-acmm-panel\b/g) || []).length, LEVELS);
  assert.equal((html.match(/class="acmm-level is-active"/g) || []).length, 1, "exactly one level pre-marked active");
  assert.equal((html.match(/class="level-detail is-active"/g) || []).length, 1, "exactly one panel pre-marked active");
});

test("boot normalises state: active level gets roving tabindex and panels get aria-hidden", () => {
  const t = boot();
  assertActive(t, 0);
  assert.equal(t.observers.length, 1, "one IntersectionObserver created");
  assert.deepEqual(t.observers[0].observed, [t.root]);
  assert.equal(t.observers[0].opts.threshold, 0.25);
  assert.equal(t.timers.pendingCount(), 0, "no rotation scheduled before the ladder scrolls into view");
  assert.equal(t.root.classList.contains("is-rotating"), false);
});

test("respects a non-first pre-marked active level", () => {
  const t = boot({ activeIndex: 3 });
  assertActive(t, 3);
});

test("auto-rotation starts when in view, advances every HOLD_MS and wraps", () => {
  const t = boot();
  t.show();
  assert.equal(t.root.classList.contains("is-rotating"), true);
  assert.equal(t.timers.pendingCount(), 1);
  t.advance(HOLD_MS - 1);
  assertActive(t, 0, "no advance before HOLD_MS");
  t.advance(1);
  assertActive(t, 1);
  t.advance(HOLD_MS * (LEVELS - 1));
  assertActive(t, 0, "wraps back to the first level after a full cycle");
  assert.equal(t.timers.pendingCount(), 1, "rotation keeps re-queuing");
});

test("leaving view stops rotation; re-entering resumes it", () => {
  const t = boot();
  t.show();
  t.observers[0].fire(false);
  assert.equal(t.timers.pendingCount(), 0);
  assert.equal(t.root.classList.contains("is-rotating"), false);
  t.advance(HOLD_MS * 3);
  assertActive(t, 0, "does not advance while out of view");
  t.show();
  t.advance(HOLD_MS);
  assertActive(t, 1);
});

test("without IntersectionObserver the ladder is treated as in view and rotates", () => {
  const t = boot({ intersectionObserver: false });
  assert.equal(t.observers.length, 0);
  assert.equal(t.root.classList.contains("is-rotating"), true);
  t.advance(HOLD_MS);
  assertActive(t, 1);
});

test("prefers-reduced-motion disables rotation, and a live change toggles it", () => {
  const t = boot({ reduceMotion: true });
  t.show();
  assert.equal(t.timers.pendingCount(), 0, "no timer under reduced motion");
  assert.equal(t.root.classList.contains("is-rotating"), false);
  t.mq.set(false);
  assert.equal(t.root.classList.contains("is-rotating"), true);
  t.advance(HOLD_MS);
  assertActive(t, 1);
  t.mq.set(true);
  assert.equal(t.timers.pendingCount(), 0);
  t.advance(HOLD_MS * 2);
  assertActive(t, 1, "frozen after reduced motion is re-enabled");
});

test("clicking a tab activates it, moves focus, and restarts the hold timer", () => {
  const t = boot();
  t.show();
  t.advance(HOLD_MS - 1000);
  t.tabs[3].dispatch("click");
  assertActive(t, 3);
  assert.equal(t.tabs[3].focusCount, 1, "clicked tab receives focus");
  t.advance(1000);
  assertActive(t, 3, "click resets the hold timer rather than advancing on the old schedule");
  t.advance(HOLD_MS - 1000);
  assertActive(t, 4, "rotation continues HOLD_MS after the click");
});

test("focusing a tab selects it and pauses rotation until focus leaves the ladder", () => {
  const t = boot();
  t.show();
  t.tabs[2].dispatch("focus");
  assertActive(t, 2);
  assert.equal(t.tabs[2].focusCount, 0, "focus handler does not re-focus (no loop)");
  assert.equal(t.timers.pendingCount(), 0, "rotation stopped while focused");
  t.advance(HOLD_MS * 2);
  assertActive(t, 2);
  // Focus moving to another tab inside the root does not resume rotation.
  t.root.dispatch("focusout", { relatedTarget: t.tabs[3] });
  assert.equal(t.timers.pendingCount(), 0);
  // Focus leaving the root resumes it.
  t.root.dispatch("focusout", { relatedTarget: null });
  assert.equal(t.root.classList.contains("is-rotating"), true);
  t.advance(HOLD_MS);
  assertActive(t, 3);
});

test("arrow/Home/End keys move selection with wrap-around, focus the target, and stop rotation", () => {
  const t = boot();
  t.show();
  let ev = t.tabs[0].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(ev.defaultPrevented, true);
  assertActive(t, 1);
  assert.equal(t.tabs[1].focusCount, 1);
  assert.equal(t.timers.pendingCount(), 0, "keyboard navigation stops auto-rotation");

  t.tabs[1].dispatch("keydown", { key: "ArrowDown" });
  assertActive(t, 2);
  t.tabs[2].dispatch("keydown", { key: "ArrowLeft" });
  assertActive(t, 1);
  t.tabs[1].dispatch("keydown", { key: "ArrowUp" });
  assertActive(t, 0);
  t.tabs[0].dispatch("keydown", { key: "ArrowLeft" });
  assertActive(t, LEVELS - 1, "ArrowLeft from the first level wraps to the last");
  t.tabs[LEVELS - 1].dispatch("keydown", { key: "ArrowRight" });
  assertActive(t, 0, "ArrowRight from the last level wraps to the first");
  t.tabs[0].dispatch("keydown", { key: "End" });
  assertActive(t, LEVELS - 1);
  t.tabs[LEVELS - 1].dispatch("keydown", { key: "Home" });
  assertActive(t, 0);

  ev = t.tabs[0].dispatch("keydown", { key: "Tab" });
  assert.equal(ev.defaultPrevented, false, "unrelated keys are not swallowed");
  assertActive(t, 0);
});

test("pointer hover pauses rotation and leaving resumes it", () => {
  const t = boot();
  t.show();
  t.root.dispatch("pointerenter");
  assert.equal(t.timers.pendingCount(), 0);
  assert.equal(t.root.classList.contains("is-rotating"), false);
  t.advance(HOLD_MS * 2);
  assertActive(t, 0);
  t.root.dispatch("pointerleave");
  assert.equal(t.root.classList.contains("is-rotating"), true);
  t.advance(HOLD_MS);
  assertActive(t, 1);
});

test("hidden document stops rotation; becoming visible resumes it", () => {
  const t = boot();
  t.show();
  t.doc.hidden = true;
  t.doc.dispatch("visibilitychange");
  assert.equal(t.timers.pendingCount(), 0);
  t.advance(HOLD_MS * 2);
  assertActive(t, 0);
  t.doc.hidden = false;
  t.doc.dispatch("visibilitychange");
  t.advance(HOLD_MS);
  assertActive(t, 1);
});

test("a timer that fires after rotation became disallowed does not advance", () => {
  const t = boot();
  t.show();
  // Simulate the tab being hidden without the visibilitychange event firing
  // (e.g. a missed event): step() must re-check canRotate() before advancing.
  t.doc.hidden = true;
  t.advance(HOLD_MS);
  assertActive(t, 0, "step() must not advance while the document is hidden");
  assert.equal(t.timers.pendingCount(), 0, "and must not re-queue");
  assert.equal(t.root.classList.contains("is-rotating"), false);
});

test("start() is idempotent: repeated in-view signals never stack timers", () => {
  const t = boot();
  t.show();
  t.show();
  t.root.dispatch("pointerleave");
  assert.equal(t.timers.pendingCount(), 1, "only one hold timer is ever pending");
  t.advance(HOLD_MS);
  assertActive(t, 1, "exactly one advance per HOLD_MS");
});
