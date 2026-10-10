#!/usr/bin/env node
// Self-test for the two carousel scripts inlined in index.html: the hero
// carousel ([data-hero-carousel]) and the projects carousel ([data-carousel]).
//
// Each script is extracted verbatim from the page and run against a tiny stub
// DOM (no jsdom, no npm) with deterministic timers, so slide activation,
// dots, live-region announcements, keyboard/swipe/hash navigation, auto-rotate,
// every pause condition, height measurement and scroll-sync can be asserted
// offline.
// Usage: node --test scripts/carousels.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "index.html");
const HERO_SLIDES = 4;
const HERO_ROTATE_MS = 7000;
const HERO_SWIPE_PX = 48;
const HERO_RESIZE_DEBOUNCE_MS = 80;
const PROJECT_SLIDES = 7;
const PROJECT_ADVANCE_MS = 6000;
const PROJECT_SCROLL_SETTLE_MS = 450;
const PROJECT_SCROLL_SETTLE_REDUCED_MS = 80;
const PROJECT_SCROLL_SYNC_MS = 80;

function extractScript(html, hook) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const scripts = blocks.filter((s) => s.includes(hook));
  assert.equal(scripts.length, 1, `expected exactly one script block mentioning ${hook}`);
  return scripts[0];
}

// ---------------------------------------------------------------------------
// Stub DOM
// ---------------------------------------------------------------------------

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

class Style {
  constructor() { this.props = {}; }
  setProperty(k, v) { this.props[k] = String(v); }
  getPropertyValue(k) { return this.props[k] || ""; }
}

class Element {
  constructor(doc, name, { classes = [], attrs = {}, parent = null, rect = {}, computed = {}, textContent = "", offsetLeft = 0 } = {}) {
    this.doc = doc;
    this.name = name;
    this.classList = new ClassList(classes);
    this.attrs = { ...attrs };
    this.listeners = {};
    this.children = [];
    this.parent = null;
    this.hidden = false;
    this.tabIndex = 0;
    this.style = new Style();
    this.rect = { width: 0, height: 0, ...rect };
    this.computed = { ...computed };
    this.textContent = textContent;
    this.offsetLeft = offsetLeft;
    this.scrollLeft = 0;
    this.scrollCalls = [];
    this.focusCount = 0;
    this.lastFocusOptions = undefined;
    if (parent) parent.appendChild(this);
  }
  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = String(v); }
  get className() { return [...this.classList.set].join(" "); }
  set className(v) { this.classList = new ClassList(String(v).split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  // Dispatches on this element and bubbles to ancestors, like real DOM events.
  dispatch(type, init = {}) {
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (let node = this; node; node = node.parent) {
      for (const fn of node.listeners[type] || []) fn(ev);
    }
    return ev;
  }
  focus(options) { this.focusCount++; this.lastFocusOptions = options; this.doc.activeElement = this; }
  contains(other) {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  matches(selector) {
    return selector.split(",").map((s) => s.trim()).some((s) => {
      const m = /^\[([a-z-]+)\]$/.exec(s);
      if (m) return m[1] in this.attrs;
      if (/^[a-z0-9]+$/.test(s)) return this.name === s;
      throw new Error("unsupported selector in stub DOM: " + s);
    });
  }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter((el) => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  appendChild(child) {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  cloneNode(deep) {
    const copy = new Element(this.doc, this.name, {
      classes: [...this.classList.set], attrs: this.attrs, rect: this.rect, computed: this.computed,
      textContent: this.textContent, offsetLeft: this.offsetLeft,
    });
    copy.hidden = this.hidden;
    if (deep) this.children.forEach((c) => copy.appendChild(c.cloneNode(true)));
    return copy;
  }
  getBoundingClientRect() { return { ...this.rect }; }
  scrollTo(opts) { this.scrollCalls.push({ ...opts }); this.scrollLeft = opts.left; }
}

function makeDocument() {
  const doc = { activeElement: null, hidden: false, listeners: {}, fontsReady: [] };
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  doc.dispatch = (type) => { for (const fn of doc.listeners[type] || []) fn({ type }); };
  doc.createElement = (name) => new Element(doc, name);
  doc.body = new Element(doc, "body");
  doc.querySelector = (selector) => doc.body.querySelector(selector);
  doc.querySelectorAll = (selector) => doc.body.querySelectorAll(selector);
  doc.fonts = { ready: { then(fn) { doc.fontsReady.push(fn); } } };
  return doc;
}

// Deterministic timers: setTimeout/setInterval/clear*, plus advance(ms).
function makeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  const api = {
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { fn, at: now + (ms || 0), every: 0 }); return id; },
    setInterval(fn, ms) { const id = nextId++; pending.set(id, { fn, at: now + ms, every: ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    clearInterval(id) { pending.delete(id); },
    pendingCount() { return pending.size; },
    intervals() { return [...pending.values()].filter((t) => t.every > 0).map((t) => t.every); },
    timeouts() { return [...pending.values()].filter((t) => t.every === 0).map((t) => t.at - now); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, t] = due[0];
        now = t.at;
        if (t.every > 0) t.at = now + t.every; else pending.delete(id);
        t.fn();
      }
      now = target;
    },
  };
  return api;
}

function makeWindow({ reduceMotion, timers, intersectionObserver, scrollend, hash }) {
  const mq = { matches: reduceMotion, listeners: [], addEventListener(type, fn) { if (type === "change") this.listeners.push(fn); } };
  mq.set = (matches) => { mq.matches = matches; mq.listeners.forEach((fn) => fn({ matches })); };
  const observers = [];
  class IntersectionObserver {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.observed = []; observers.push(this); }
    observe(el) { this.observed.push(el); }
    fire(entries) { this.cb(entries); }
  }
  const win = {
    listeners: {},
    location: { hash },
    matchMedia: () => mq,
    getComputedStyle: (el) => ({ ...el.computed }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatch(type) { for (const fn of this.listeners[type] || []) fn({ type }); },
  };
  if (intersectionObserver) win.IntersectionObserver = IntersectionObserver;
  if (scrollend) win.onscrollend = null;
  return { win, mq, observers, IntersectionObserver };
}

function runScript(src, { doc, win, timers, IntersectionObserver }) {
  const run = new Function("document", "window", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "IntersectionObserver", src);
  run(doc, win, timers.setTimeout, timers.clearTimeout, timers.setInterval, timers.clearInterval, IntersectionObserver);
}

// ---------------------------------------------------------------------------
// Hero carousel
// ---------------------------------------------------------------------------

const HERO_NAMES = ["Hive Commons", "Hive", "Spektacular (Spek)", "The family"];
const HERO_IDS = ["hero-hivecommons", "hero-hive", "hero-spektacular", "hero-family"];

function makeHeroDom(doc, { slideCount = HERO_SLIDES, withControls = true } = {}) {
  const root = new Element(doc, "section", { attrs: { "data-hero-carousel": "" }, parent: doc.body, computed: { paddingTop: "24px", paddingBottom: "32px" } });
  const stage = new Element(doc, "div", { attrs: { "data-hero-stage": "" }, parent: root, rect: { width: 800, height: 0 } });
  const slides = [];
  for (let i = 0; i < slideCount; i++) {
    const slide = new Element(doc, "article", {
      attrs: { "data-hero-slide": "", "data-hero-name": HERO_NAMES[i], id: HERO_IDS[i] },
      parent: stage, rect: { width: 800, height: 300 + i * 50 },
    });
    if (i > 0) { slide.hidden = true; slide.setAttribute("inert", ""); }
    new Element(doc, "a", { parent: slide, attrs: { href: "#" } });
    slides.push(slide);
  }
  let controls = null, prev = null, next = null, dotsWrap = null, status = null;
  if (withControls) {
    controls = new Element(doc, "div", { attrs: { "data-hero-controls": "" }, parent: root, rect: { height: 40 }, computed: { marginTop: "12px" } });
    controls.hidden = true;
    prev = new Element(doc, "button", { attrs: { "data-hero-prev": "" }, parent: controls });
    dotsWrap = new Element(doc, "div", { attrs: { "data-hero-dots": "" }, parent: controls });
    next = new Element(doc, "button", { attrs: { "data-hero-next": "" }, parent: controls });
    status = new Element(doc, "p", { attrs: { "data-hero-status": "", "aria-live": "polite" }, parent: controls });
  }
  return { root, stage, slides, controls, prev, next, dotsWrap, status };
}

function bootHero({ reduceMotion = false, hash = "", slideCount = HERO_SLIDES, withControls = true } = {}) {
  const src = extractScript(readFileSync(PAGE, "utf8"), "[data-hero-carousel]");
  const doc = makeDocument();
  const timers = makeTimers();
  const dom = makeHeroDom(doc, { slideCount, withControls });
  const { win, mq, IntersectionObserver } = makeWindow({ reduceMotion, timers, intersectionObserver: false, scrollend: false, hash });
  runScript(src, { doc, win, timers, IntersectionObserver });
  const t = {
    ...dom, doc, win, mq, timers, advance: timers.advance,
    dots: () => dom.dotsWrap ? dom.dotsWrap.children : [],
    currentIndex: () => dom.slides.findIndex((s) => !s.hidden),
    rotating: () => timers.intervals().length > 0,
  };
  return t;
}

function assertHeroSlide(t, i, msg) {
  assert.equal(t.currentIndex(), i, msg || `hero slide ${i + 1} should be visible`);
  t.slides.forEach((slide, k) => {
    const on = k === i;
    assert.equal(slide.hidden, !on, `slide ${k + 1} hidden`);
    assert.equal(slide.hasAttribute("inert"), !on, `slide ${k + 1} inert`);
    assert.equal(t.dots()[k].getAttribute("aria-current"), on ? "true" : "false", `dot ${k + 1} aria-current`);
  });
}

test("hero markup: one root, four hash-addressable slides, first visible, controls present", () => {
  const html = readFileSync(PAGE, "utf8").replace(/<script>[\s\S]*?<\/script>/g, "");
  assert.equal((html.match(/data-hero-carousel\b/g) || []).length, 1);
  const slides = [...html.matchAll(/<article class="hero-slide" id="([a-z-]+)"[^>]*data-hero-slide data-hero-name="([^"]+)"([^>]*)>/g)];
  assert.equal(slides.length, HERO_SLIDES);
  assert.deepEqual(slides.map((m) => m[1]), HERO_IDS, "slide ids are stable deep-link targets");
  assert.deepEqual(slides.map((m) => m[2]), HERO_NAMES);
  slides.forEach((m, i) => {
    assert.equal(/\bhidden\b/.test(m[3]) && /\binert\b/.test(m[3]), i > 0, `slide ${i + 1} hidden+inert in server-rendered HTML`);
    assert.ok(m[0].includes(`aria-label="${i + 1} of ${HERO_SLIDES}"`), `slide ${i + 1} aria-label position`);
  });
  for (const hook of ["data-hero-stage", "data-hero-controls", "data-hero-prev", "data-hero-next", "data-hero-dots", "data-hero-status"]) {
    assert.equal((html.match(new RegExp(hook + "\\b", "g")) || []).length, 1, hook);
  }
});

test("hero boot: dots built from slide names, controls revealed, first slide active, auto-rotate scheduled", () => {
  const t = bootHero();
  assert.equal(t.controls.hidden, false, "controls un-hidden for JS users");
  const dots = t.dots();
  assert.equal(dots.length, HERO_SLIDES);
  dots.forEach((dot, i) => {
    assert.equal(dot.name, "button");
    assert.equal(dot.type, "button");
    assert.equal(dot.classList.contains("hero-dot"), true);
    assert.equal(dot.getAttribute("aria-label"), "Go to slide: " + HERO_NAMES[i]);
  });
  assertHeroSlide(t, 0);
  assert.equal(t.status.textContent, "", "no announcement on boot");
  assert.deepEqual(t.timers.intervals(), [HERO_ROTATE_MS], "one rotate interval");
  t.advance(HERO_ROTATE_MS);
  assert.equal(t.status.getAttribute("aria-live"), "off", "auto-rotation is silent to screen readers");
});

test("hero boot: measures tallest slide via detached clones and publishes CSS custom properties", () => {
  const t = bootHero();
  // Tallest slide is 450px; controls 40px + 12px gap; root padding 24px + 32px.
  assert.equal(t.root.style.getPropertyValue("--hero-stage-h"), "450px");
  assert.equal(t.root.style.getPropertyValue("--hero-h"), String(450 + 40 + 12 + 24 + 32) + "px");
  assert.equal(t.root.children.some((c) => c.classList.contains("hero-measure")), false, "measure element removed after use");
  assert.equal(t.slides.filter((s) => s.hidden).length, HERO_SLIDES - 1, "measuring did not un-hide the real slides");
  assert.deepEqual(t.slides.map((s) => s.id), HERO_IDS, "measuring did not strip ids from the real slides");
});

test("hero measure: clones are made visible and lose id/inert so the measurement is honest and unique", () => {
  const t = bootHero();
  const appended = [];
  const origAppend = t.root.appendChild.bind(t.root);
  t.root.appendChild = (child) => { appended.push(child); return origAppend(child); };
  t.doc.fontsReady.forEach((fn) => fn());
  assert.equal(appended.length, 1, "fonts.ready re-measures once");
  const measure = appended[0];
  assert.equal(measure.classList.contains("hero-measure"), true);
  assert.equal(measure.style.width, "800px", "measure column matches the live stage width");
  assert.equal(measure.children.length, HERO_SLIDES);
  measure.children.forEach((clone) => {
    assert.equal(clone.hidden, false);
    assert.equal(clone.hasAttribute("inert"), false);
    assert.equal(clone.hasAttribute("id"), false, "duplicate ids would be invalid HTML");
  });
  assert.equal(measure.parent, null, "removed from the document");
});

test("hero resize: re-measure is debounced to one run per burst", () => {
  const t = bootHero();
  let measured = 0;
  const origAppend = t.root.appendChild.bind(t.root);
  t.root.appendChild = (child) => { if (child.classList.contains("hero-measure")) measured++; return origAppend(child); };
  t.win.dispatch("resize"); t.win.dispatch("resize"); t.win.dispatch("resize");
  assert.equal(measured, 0, "nothing measured synchronously");
  t.advance(HERO_RESIZE_DEBOUNCE_MS - 1);
  assert.equal(measured, 0);
  t.advance(1);
  assert.equal(measured, 1, "one measurement after the debounce window");
});

test("hero auto-rotate: advances silently every 7s and wraps", () => {
  const t = bootHero();
  for (let i = 1; i <= HERO_SLIDES; i++) {
    t.advance(HERO_ROTATE_MS);
    assertHeroSlide(t, i % HERO_SLIDES);
    assert.equal(t.status.textContent, "", "auto-rotate does not announce");
  }
});

test("hero auto-rotate: holds while the document is hidden", () => {
  const t = bootHero();
  t.doc.hidden = true;
  t.advance(HERO_ROTATE_MS * 3);
  assertHeroSlide(t, 0);
  t.doc.hidden = false;
  t.advance(HERO_ROTATE_MS);
  assertHeroSlide(t, 1);
});

test("hero reduced motion: no auto-rotate, live region polite", () => {
  const t = bootHero({ reduceMotion: true });
  assert.deepEqual(t.timers.intervals(), []);
  assert.equal(t.status.getAttribute("aria-live"), "polite");
  t.advance(HERO_ROTATE_MS * 2);
  assertHeroSlide(t, 0);
  // Manual navigation still works.
  t.next.dispatch("click");
  assertHeroSlide(t, 1);
  assert.equal(t.status.textContent, "Hive, slide 2 of 4");
  assert.equal(t.status.getAttribute("aria-live"), "polite", "with no rotation to restart, the announcement stays polite");
  assert.deepEqual(t.timers.intervals(), [], "restart() does not start a timer under reduced motion");
});

test("hero reduced-motion toggle: stops and resumes rotation", () => {
  const t = bootHero();
  t.mq.set(true);
  assert.deepEqual(t.timers.intervals(), []);
  assert.equal(t.status.getAttribute("aria-live"), "polite");
  t.mq.set(false);
  assert.deepEqual(t.timers.intervals(), [HERO_ROTATE_MS]);
  t.advance(HERO_ROTATE_MS);
  assert.equal(t.status.getAttribute("aria-live"), "off");
});

test("hero next/prev: announce the new slide politely, wrap, and reset the rotate timer", () => {
  const t = bootHero();
  t.advance(HERO_ROTATE_MS - 1000);
  t.next.dispatch("click");
  assertHeroSlide(t, 1);
  assert.equal(t.status.textContent, "Hive, slide 2 of 4");
  assert.equal(t.status.getAttribute("aria-live"), "polite", "user-initiated announcement is not silenced by restart()");
  t.advance(1000);
  assertHeroSlide(t, 1, "timer was reset by the click; the old tick must not fire");
  t.advance(HERO_ROTATE_MS - 1000);
  assertHeroSlide(t, 2, "full interval after click advances");
  t.prev.dispatch("click"); t.prev.dispatch("click"); t.prev.dispatch("click");
  assertHeroSlide(t, HERO_SLIDES - 1, "prev wraps from first to last");
  assert.equal(t.status.textContent, "The family, slide 4 of 4");
});

test("hero dots: clicking a dot jumps directly to that slide", () => {
  const t = bootHero();
  t.dots()[2].dispatch("click");
  assertHeroSlide(t, 2);
  assert.equal(t.status.textContent, "Spektacular (Spek), slide 3 of 4");
  assert.equal(t.status.getAttribute("aria-live"), "polite");
});

test("hero keyboard: Arrow/Home/End navigate and are consumed; other keys are ignored", () => {
  const t = bootHero();
  let ev = t.root.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(ev.defaultPrevented, true); assertHeroSlide(t, 1);
  ev = t.root.dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(ev.defaultPrevented, true); assertHeroSlide(t, 0);
  ev = t.root.dispatch("keydown", { key: "ArrowLeft" });
  assertHeroSlide(t, HERO_SLIDES - 1, "ArrowLeft wraps");
  ev = t.root.dispatch("keydown", { key: "Home" });
  assert.equal(ev.defaultPrevented, true); assertHeroSlide(t, 0);
  ev = t.root.dispatch("keydown", { key: "End" });
  assert.equal(ev.defaultPrevented, true); assertHeroSlide(t, HERO_SLIDES - 1);
  ev = t.root.dispatch("keydown", { key: "Tab" });
  assert.equal(ev.defaultPrevented, false, "Tab must keep its default so focus can leave");
  assertHeroSlide(t, HERO_SLIDES - 1);
  ev = t.root.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(ev.defaultPrevented, false);
  assertHeroSlide(t, HERO_SLIDES - 1);
});

test("hero pause: hover stops rotation, leaving resumes", () => {
  const t = bootHero();
  t.root.dispatch("mouseenter");
  assert.deepEqual(t.timers.intervals(), []);
  t.advance(HERO_ROTATE_MS * 2);
  assertHeroSlide(t, 0);
  t.root.dispatch("mouseleave");
  assert.deepEqual(t.timers.intervals(), [HERO_ROTATE_MS]);
  t.advance(HERO_ROTATE_MS);
  assertHeroSlide(t, 1);
});

test("hero pause: focus inside stops rotation; focus moving within the carousel keeps it paused", () => {
  const t = bootHero();
  t.root.dispatch("focusin");
  assert.deepEqual(t.timers.intervals(), []);
  t.root.dispatch("focusout", { relatedTarget: t.next });
  assert.deepEqual(t.timers.intervals(), [], "still paused while focus stays inside");
  t.root.dispatch("focusout", { relatedTarget: null });
  assert.deepEqual(t.timers.intervals(), [HERO_ROTATE_MS], "resumes when focus leaves");
});

test("hero swipe: touch swipe past threshold navigates; mouse drags, short and vertical swipes are ignored", () => {
  const t = bootHero();
  // Mouse "drag" is ignored entirely.
  t.root.dispatch("pointerdown", { pointerType: "mouse", clientX: 0, clientY: 0 });
  t.root.dispatch("pointerup", { pointerType: "mouse", clientX: -200, clientY: 0 });
  assertHeroSlide(t, 0, "mouse pointer never swipes");
  // Swipe left -> next.
  t.root.dispatch("pointerdown", { pointerType: "touch", clientX: 300, clientY: 100 });
  t.root.dispatch("pointerup", { pointerType: "touch", clientX: 300 - HERO_SWIPE_PX, clientY: 110 });
  assertHeroSlide(t, 1);
  assert.equal(t.status.textContent, "Hive, slide 2 of 4", "swipe announces");
  // Swipe right -> prev.
  t.root.dispatch("pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
  t.root.dispatch("pointerup", { pointerType: "touch", clientX: 100 + HERO_SWIPE_PX, clientY: 100 });
  assertHeroSlide(t, 0);
  // Below threshold.
  t.root.dispatch("pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
  t.root.dispatch("pointerup", { pointerType: "touch", clientX: 100 - (HERO_SWIPE_PX - 1), clientY: 100 });
  assertHeroSlide(t, 0, "short swipe ignored");
  // Vertical-dominant (page scroll) must not navigate.
  t.root.dispatch("pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
  t.root.dispatch("pointerup", { pointerType: "touch", clientX: 100 - 60, clientY: 100 + 80 });
  assertHeroSlide(t, 0, "vertical scroll gesture ignored");
  // pointerup with no matching pointerdown is a no-op.
  t.root.dispatch("pointerup", { pointerType: "touch", clientX: -500, clientY: 0 });
  assertHeroSlide(t, 0);
});

test("hero deep link: location.hash selects the initial slide; unknown hash falls back to the first", () => {
  const t = bootHero({ hash: "#" + HERO_IDS[2] });
  assertHeroSlide(t, 2);
  assert.equal(t.status.textContent, "", "initial deep link paints without announcing");
  const u = bootHero({ hash: "#not-a-slide" });
  assertHeroSlide(u, 0);
  const v = bootHero({ hash: "" });
  assertHeroSlide(v, 0);
});

test("hero hashchange: navigating to a slide id announces it and resets the timer; other hashes are ignored", () => {
  const t = bootHero();
  t.advance(HERO_ROTATE_MS - 500);
  t.win.location.hash = "#" + HERO_IDS[3];
  t.win.dispatch("hashchange");
  assertHeroSlide(t, 3);
  assert.equal(t.status.textContent, "The family, slide 4 of 4");
  t.advance(500);
  assertHeroSlide(t, 3, "timer reset on hashchange");
  t.win.location.hash = "#projects";
  t.win.dispatch("hashchange");
  assertHeroSlide(t, 3, "non-slide hash leaves the carousel alone");
});

test("hero no-op guards: a single slide or missing dots container leaves the page untouched", () => {
  const one = bootHero({ slideCount: 1 });
  assert.equal(one.controls.hidden, true, "controls stay hidden with one slide");
  assert.equal(one.dots().length, 0);
  assert.equal(one.timers.pendingCount(), 0);
  const noControls = bootHero({ withControls: false });
  assert.equal(noControls.timers.pendingCount(), 0, "no dots container -> script bails before scheduling");
  assert.equal(noControls.slides[1].hidden, true);
});

// ---------------------------------------------------------------------------
// Projects carousel
// ---------------------------------------------------------------------------

const PROJECT_NAMES = ["Hive", "Spektacular", "dibs", "pluk", "rationguard", "hotshot", "promptargs"];
const TRACK_OFFSET = 100;
const TRACK_PADDING = 16;
const SLIDE_PITCH = 300;

function expectedSlideLeft(i) { return TRACK_OFFSET + i * SLIDE_PITCH - TRACK_OFFSET - TRACK_PADDING; }

function makeProjectDom(doc, { slideCount = PROJECT_SLIDES, withControls = true, withLinks = true } = {}) {
  let controls = null, prev = null, next = null;
  if (withControls) {
    controls = new Element(doc, "div", { attrs: { "data-carousel-controls": "" }, parent: doc.body });
    controls.hidden = true;
    prev = new Element(doc, "button", { attrs: { "data-car-prev": "" }, parent: controls });
    next = new Element(doc, "button", { attrs: { "data-car-next": "" }, parent: controls });
  }
  const root = new Element(doc, "section", { attrs: { "data-carousel": "" }, parent: doc.body });
  const track = new Element(doc, "ul", { attrs: { "data-car-track": "" }, parent: root, offsetLeft: TRACK_OFFSET, computed: { paddingLeft: TRACK_PADDING + "px" } });
  const slides = [];
  const links = [];
  for (let i = 0; i < slideCount; i++) {
    const slide = new Element(doc, "li", { attrs: { "data-slide": "" }, parent: track, offsetLeft: TRACK_OFFSET + i * SLIDE_PITCH });
    new Element(doc, "h3", { parent: slide, textContent: "  " + PROJECT_NAMES[i] + "\n  " });
    if (withLinks) links.push(new Element(doc, "a", { parent: slide, attrs: { href: "#" } }));
    slides.push(slide);
  }
  const dotsWrap = new Element(doc, "div", { attrs: { "data-car-dots": "" }, parent: root });
  dotsWrap.hidden = true;
  return { controls, prev, next, root, track, slides, links, dotsWrap };
}

function bootProjects({ reduceMotion = false, intersectionObserver = true, scrollend = false, slideCount = PROJECT_SLIDES, withControls = true, withLinks = true } = {}) {
  const src = extractScript(readFileSync(PAGE, "utf8"), "[data-carousel]");
  const doc = makeDocument();
  const timers = makeTimers();
  const dom = makeProjectDom(doc, { slideCount, withControls, withLinks });
  const { win, mq, observers, IntersectionObserver } = makeWindow({ reduceMotion, timers, intersectionObserver, scrollend, hash: "" });
  runScript(src, { doc, win, timers, IntersectionObserver });
  return {
    ...dom, doc, win, mq, timers, observers, advance: timers.advance,
    dots: () => dom.dotsWrap.children,
    currentIndex: () => dom.slides.findIndex((s) => s.classList.contains("is-current")),
    lastScroll: () => dom.track.scrollCalls[dom.track.scrollCalls.length - 1],
  };
}

function assertProjectSlide(t, i, msg) {
  assert.equal(t.currentIndex(), i, msg || `project slide ${i + 1} should be current`);
  t.slides.forEach((slide, k) => {
    const on = k === i;
    assert.equal(slide.classList.contains("is-current"), on, `slide ${k + 1} is-current`);
    assert.equal(slide.getAttribute("aria-current"), on ? "true" : "false", `slide ${k + 1} aria-current`);
    assert.equal(t.dots()[k].getAttribute("aria-selected"), on ? "true" : "false", `dot ${k + 1} aria-selected`);
    assert.equal(t.dots()[k].tabIndex, on ? 0 : -1, `dot ${k + 1} roving tabindex`);
  });
}

test("projects markup: one carousel with seven slides, each with an h3 and a link, controls and dots present", () => {
  const html = readFileSync(PAGE, "utf8").replace(/<script>[\s\S]*?<\/script>/g, "");
  assert.equal((html.match(/data-carousel\b(?!-)/g) || []).length, 1);
  assert.equal((html.match(/data-car-track\b/g) || []).length, 1);
  assert.equal((html.match(/data-car-dots\b/g) || []).length, 1);
  assert.equal((html.match(/data-carousel-controls\b/g) || []).length, 1);
  assert.equal((html.match(/data-car-prev\b/g) || []).length, 1);
  assert.equal((html.match(/data-car-next\b/g) || []).length, 1);
  const trackStart = html.indexOf("data-car-track");
  const trackEnd = html.indexOf("</ul>", trackStart);
  const track = html.slice(trackStart, trackEnd);
  const slides = track.split(/<li class="slide" data-slide>/).slice(1);
  assert.equal(slides.length, PROJECT_SLIDES);
  slides.forEach((s, i) => {
    assert.match(s, /<h3[\s>]/, `slide ${i + 1} has an h3 (used for the dot's aria-label)`);
    assert.match(s, /<a\s/, `slide ${i + 1} has a link (focus target for keyboard users)`);
  });
});

test("projects boot: tab dots named from h3 text, controls revealed, first slide current, scrolled into place", () => {
  const t = bootProjects();
  assert.equal(t.dotsWrap.hidden, false);
  assert.equal(t.controls.hidden, false);
  const dots = t.dots();
  assert.equal(dots.length, PROJECT_SLIDES);
  dots.forEach((dot, i) => {
    assert.equal(dot.type, "button");
    assert.equal(dot.classList.contains("dot"), true);
    assert.equal(dot.getAttribute("role"), "tab");
    assert.equal(dot.getAttribute("aria-label"), PROJECT_NAMES[i], "h3 text is trimmed");
  });
  assertProjectSlide(t, 0);
  assert.deepEqual(t.lastScroll(), { left: expectedSlideLeft(0), behavior: "smooth" });
  assert.deepEqual(t.timers.intervals(), [PROJECT_ADVANCE_MS]);
  assert.equal(t.links[0].focusCount, 0, "boot never steals focus");
});

test("projects boot: dots fall back to a positional label when a slide has no h3", () => {
  const src = extractScript(readFileSync(PAGE, "utf8"), "[data-carousel]");
  const doc = makeDocument();
  const timers = makeTimers();
  const dom = makeProjectDom(doc, { slideCount: 2 });
  dom.slides[1].children = dom.slides[1].children.filter((c) => c.name !== "h3");
  const { win, IntersectionObserver } = makeWindow({ reduceMotion: false, timers, intersectionObserver: true, scrollend: false, hash: "" });
  runScript(src, { doc, win, timers, IntersectionObserver });
  assert.equal(dom.dotsWrap.children[1].getAttribute("aria-label"), "Project 2");
});

test("projects reduced motion: instant scroll, short settle window, no auto-advance", () => {
  const t = bootProjects({ reduceMotion: true });
  assert.deepEqual(t.lastScroll(), { left: expectedSlideLeft(0), behavior: "auto" });
  assert.deepEqual(t.timers.intervals(), []);
  assert.deepEqual(t.timers.timeouts(), [PROJECT_SCROLL_SETTLE_REDUCED_MS], "settle timeout is 80ms under reduced motion");
  t.advance(PROJECT_ADVANCE_MS * 2);
  assertProjectSlide(t, 0);
  t.next.dispatch("click");
  assertProjectSlide(t, 1);
  assert.deepEqual(t.timers.intervals(), [], "restart() stays off under reduced motion");
});

test("projects auto-advance: moves every 6s with a smooth scroll and wraps", () => {
  const t = bootProjects();
  t.advance(PROJECT_SCROLL_SETTLE_MS); // let boot's programmatic scroll settle
  for (let i = 1; i <= PROJECT_SLIDES; i++) {
    t.advance(PROJECT_ADVANCE_MS);
    assertProjectSlide(t, i % PROJECT_SLIDES);
    assert.equal(t.lastScroll().left, expectedSlideLeft(i % PROJECT_SLIDES));
    assert.equal(t.links[i % PROJECT_SLIDES].focusCount, 0, "auto-advance never moves focus");
    t.advance(PROJECT_SCROLL_SETTLE_MS);
  }
});

test("projects auto-advance: holds while the document is hidden and resumes on visibilitychange", () => {
  const t = bootProjects();
  t.doc.hidden = true;
  t.doc.dispatch("visibilitychange");
  assert.deepEqual(t.timers.intervals(), [], "hidden tab stops the interval");
  t.advance(PROJECT_ADVANCE_MS * 3);
  assertProjectSlide(t, 0);
  t.doc.hidden = false;
  t.doc.dispatch("visibilitychange");
  assert.deepEqual(t.timers.intervals(), [PROJECT_ADVANCE_MS]);
});

test("projects next/prev buttons: move without focusing the card, wrap, and reset the timer", () => {
  const t = bootProjects();
  t.advance(PROJECT_ADVANCE_MS - 1000);
  t.next.dispatch("click");
  assertProjectSlide(t, 1);
  assert.equal(t.links[1].focusCount, 0, "pointer users keep focus on the button");
  t.advance(1000);
  assertProjectSlide(t, 1, "old tick cancelled by restart");
  t.prev.dispatch("click"); t.prev.dispatch("click");
  assertProjectSlide(t, PROJECT_SLIDES - 1, "prev wraps to the last slide");
});

test("projects dots: clicking a dot scrolls to that slide and moves focus into its card without scrolling the page", () => {
  const t = bootProjects();
  t.dots()[4].dispatch("click");
  assertProjectSlide(t, 4);
  assert.equal(t.lastScroll().left, expectedSlideLeft(4));
  assert.equal(t.links[4].focusCount, 1);
  assert.deepEqual(t.links[4].lastFocusOptions, { preventScroll: true });
  assert.equal(t.doc.activeElement, t.links[4]);
});

test("projects focus: falls back to plain focus() when preventScroll is rejected; no-op when the card has no link", () => {
  const t = bootProjects();
  const link = t.links[2];
  const real = link.focus.bind(link);
  let calls = 0;
  link.focus = (opts) => { calls++; if (opts) throw new TypeError("legacy engine"); real(); };
  t.dots()[2].dispatch("click");
  assert.equal(calls, 2, "retried without options");
  assert.equal(t.doc.activeElement, link);
  const u = bootProjects({ withLinks: false });
  u.dots()[1].dispatch("click");
  assertProjectSlide(u, 1, "card without an interactive target still becomes current");
});

test("projects keyboard: Arrow/Home/End on the track or dots navigate, focus the card and are consumed", () => {
  const t = bootProjects();
  let ev = t.track.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(ev.defaultPrevented, true); assertProjectSlide(t, 1);
  assert.equal(t.links[1].focusCount, 1, "keyboard navigation moves focus to the card");
  ev = t.dotsWrap.dispatch("keydown", { key: "End" });
  assert.equal(ev.defaultPrevented, true); assertProjectSlide(t, PROJECT_SLIDES - 1);
  ev = t.dotsWrap.dispatch("keydown", { key: "ArrowRight" });
  assertProjectSlide(t, 0, "ArrowRight wraps");
  ev = t.track.dispatch("keydown", { key: "ArrowLeft" });
  assertProjectSlide(t, PROJECT_SLIDES - 1, "ArrowLeft wraps");
  ev = t.track.dispatch("keydown", { key: "Home" });
  assert.equal(ev.defaultPrevented, true); assertProjectSlide(t, 0);
  ev = t.track.dispatch("keydown", { key: "Tab" });
  assert.equal(ev.defaultPrevented, false, "Tab is left alone");
  ev = t.root.dispatch("keydown", { key: "ArrowRight" });
  assertProjectSlide(t, 0, "keys outside track/dots (e.g. on the root) do nothing");
});

test("projects focusin: tabbing into a card brings it into view without re-focusing; focus pauses auto-advance", () => {
  const t = bootProjects();
  t.links[3].dispatch("focusin", { relatedTarget: null });
  assertProjectSlide(t, 3);
  assert.equal(t.lastScroll().left, expectedSlideLeft(3));
  assert.equal(t.links[3].focusCount, 0, "focusin handler does not call focus() again (would loop)");
  assert.deepEqual(t.timers.intervals(), [], "focus inside pauses");
  t.links[3].dispatch("focusin", { relatedTarget: null });
  assert.equal(t.track.scrollCalls.length, 2, "focusing the already-current card does not scroll again");
  t.root.dispatch("focusout", { relatedTarget: t.dots()[0] });
  assert.deepEqual(t.timers.intervals(), [], "focus moving to a dot keeps it paused");
  t.root.dispatch("focusout", { relatedTarget: null });
  assert.deepEqual(t.timers.intervals(), [PROJECT_ADVANCE_MS], "focus leaving resumes");
});

test("projects hover: pauses and resumes auto-advance", () => {
  const t = bootProjects();
  t.root.dispatch("mouseenter");
  assert.deepEqual(t.timers.intervals(), []);
  t.root.dispatch("mouseleave");
  assert.deepEqual(t.timers.intervals(), [PROJECT_ADVANCE_MS]);
});

test("projects reduced-motion toggle: stops and resumes auto-advance", () => {
  const t = bootProjects();
  t.mq.set(true);
  assert.deepEqual(t.timers.intervals(), []);
  t.mq.set(false);
  assert.deepEqual(t.timers.intervals(), [PROJECT_ADVANCE_MS]);
});

test("projects scroll sync: manual scroll snaps `current` to the nearest slide after 80ms, ignored while a programmatic scroll settles", () => {
  const t = bootProjects();
  // Boot scrolled programmatically; a scroll event inside the 450ms settle window is ignored.
  t.track.scrollLeft = expectedSlideLeft(5) + 10;
  t.track.dispatch("scroll");
  t.advance(PROJECT_SCROLL_SYNC_MS);
  assertProjectSlide(t, 0, "ignored during programmatic scroll");
  // Once settled, the script re-syncs from the live scroll position.
  t.advance(PROJECT_SCROLL_SETTLE_MS - PROJECT_SCROLL_SYNC_MS);
  assertProjectSlide(t, 5, "settle timeout syncs from scrollLeft");
  // A manual scroll now updates after the debounce window, without scrolling programmatically.
  const before = t.track.scrollCalls.length;
  t.track.scrollLeft = expectedSlideLeft(2) - 20;
  t.track.dispatch("scroll"); t.track.dispatch("scroll");
  assertProjectSlide(t, 5, "nothing until the debounce elapses");
  t.advance(PROJECT_SCROLL_SYNC_MS);
  assertProjectSlide(t, 2);
  assert.equal(t.track.scrollCalls.length, before, "sync from a user scroll never fights the user with scrollTo");
  assert.equal(t.links[2].focusCount, 0, "sync never moves focus");
});

test("projects scrollend: when supported, ends the programmatic window early and syncs", () => {
  const t = bootProjects({ scrollend: true });
  t.track.scrollLeft = expectedSlideLeft(3);
  t.track.dispatch("scrollend");
  assertProjectSlide(t, 3);
  // Programmatic flag cleared: a plain scroll event is now honoured immediately after debounce.
  t.track.scrollLeft = expectedSlideLeft(1);
  t.track.dispatch("scroll");
  t.advance(PROJECT_SCROLL_SYNC_MS);
  assertProjectSlide(t, 1);
  const u = bootProjects({ scrollend: false });
  assert.equal((u.track.listeners.scrollend || []).length, 0, "no scrollend listener without support");
});

test("projects IntersectionObserver: observes every slide within the track, picks the most-visible entry, ignores programmatic scrolls", () => {
  const t = bootProjects();
  assert.equal(t.observers.length, 1);
  const obs = t.observers[0];
  assert.equal(obs.opts.root, t.track);
  assert.deepEqual(obs.opts.threshold, [0.55, 0.7, 0.85, 1]);
  assert.deepEqual(obs.observed, t.slides);
  obs.fire([{ target: t.slides[4], isIntersecting: true, intersectionRatio: 1 }]);
  assertProjectSlide(t, 0, "ignored while boot's programmatic scroll settles");
  t.advance(PROJECT_SCROLL_SETTLE_MS);
  obs.fire([
    { target: t.slides[1], isIntersecting: true, intersectionRatio: 0.6 },
    { target: t.slides[2], isIntersecting: true, intersectionRatio: 0.9 },
    { target: t.slides[3], isIntersecting: false, intersectionRatio: 1 },
  ]);
  assertProjectSlide(t, 2, "highest intersecting ratio wins; non-intersecting entries are skipped");
  obs.fire([{ target: t.slides[0], isIntersecting: false, intersectionRatio: 0 }]);
  assertProjectSlide(t, 2, "no intersecting entry -> unchanged");
  const noIO = bootProjects({ intersectionObserver: false });
  assert.equal(noIO.observers.length, 0, "feature-detected; no observer created when absent");
  assertProjectSlide(noIO, 0);
});

test("projects no-op guards: a single slide leaves dots and controls hidden and schedules nothing", () => {
  const t = bootProjects({ slideCount: 1 });
  assert.equal(t.dotsWrap.hidden, true);
  assert.equal(t.controls.hidden, true);
  assert.equal(t.dots().length, 0);
  assert.equal(t.timers.pendingCount(), 0);
  assert.equal(t.track.scrollCalls.length, 0);
});

test("projects without external controls still boots and navigates", () => {
  const t = bootProjects({ withControls: false });
  assert.equal(t.dotsWrap.hidden, false);
  t.dots()[1].dispatch("click");
  assertProjectSlide(t, 1);
});
