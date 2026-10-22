// Shared Content-Security-Policy helpers for the static page gates.
// page-csp.test.mjs uses them to verify every page's <meta> policy; the
// update-csp-hashes.mjs tool uses them to regenerate the sha256- allow-list
// after an inline script changes. Zero dependencies.
import { createHash } from "node:crypto";

// Script types the browser never executes; CSP script-src does not apply.
export const DATA_SCRIPT_TYPES = new Set(["application/ld+json", "application/json", "importmap"]);
const EVENT_HANDLER_RE = /\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

export function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return out;
}

export function sha256Source(source) {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

export function inlineScriptSources(html) {
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const a = attrs(m[1]);
    if (a.src !== undefined) continue;
    const type = (a.type ?? "").trim().toLowerCase();
    if (DATA_SCRIPT_TYPES.has(type)) continue;
    out.push(m[2]);
  }
  return out;
}

export function inlineHandlerSources(html) {
  const out = new Set();
  for (const m of html.matchAll(EVENT_HANDLER_RE)) out.add(m[1] ?? m[2]);
  return [...out];
}

export function externalImageOrigins(html) {
  const out = new Set();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attrs(m[0]).src ?? "";
    if (/^https?:\/\//i.test(src)) out.add(new URL(src).origin);
  }
  return [...out].sort();
}

// The first CSP <meta> in <head>: its full tag text, parsed directives (in
// source order), and where it and the first fetch-triggering tag sit in <head>.
export function parseCsp(html) {
  const head = (/<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html) ?? [, ""])[1];
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)];
  const cspMetas = metas.filter((m) => (attrs(m[0])["http-equiv"] ?? "").toLowerCase() === "content-security-policy");
  if (cspMetas.length === 0) return null;
  const directives = {};
  for (const part of (attrs(cspMetas[0][0]).content ?? "").split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    directives[tokens[0].toLowerCase()] = tokens.slice(1);
  }
  // Index in the head of the policy and of the first fetch-triggering tag, so a
  // policy placed after a <script> or <link> can be reported: CSP in <meta>
  // only governs content that follows it.
  const policyAt = head.indexOf(cspMetas[0][0]);
  const firstFetch = /<(script|link|img|style)\b/i.exec(head);
  return { tag: cspMetas[0][0], count: cspMetas.length, directives, policyAt, firstFetchAt: firstFetch ? firstFetch.index : -1 };
}

// Pointer appended to every hash problem: the fix is one command, not arithmetic.
const REGEN_HINT = "run `node scripts/update-csp-hashes.mjs` to regenerate";

// Every way a page's policy falls short of the gate's rules; empty when correct.
export function problemsOf(html) {
  const problems = [];
  const csp = parseCsp(html);
  if (!csp) return ['missing <meta http-equiv="Content-Security-Policy">'];
  if (csp.count !== 1) problems.push(`expected exactly one CSP meta, found ${csp.count}`);
  if (csp.firstFetchAt !== -1 && csp.firstFetchAt < csp.policyAt) {
    problems.push("CSP meta must precede every <script>/<link>/<img>/<style> in <head> (a meta policy only governs what follows it)");
  }
  const d = csp.directives;
  const scriptSrc = d["script-src"];
  if (!scriptSrc) {
    problems.push("script-src directive missing");
  } else {
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:", "data:"]) {
      if (scriptSrc.includes(bad)) problems.push(`script-src must not contain ${bad}`);
    }
    if (!(d["default-src"] ?? []).includes("'none'")) problems.push("default-src must be 'none' so every fetch type is allow-listed explicitly");

    const wantScripts = inlineScriptSources(html).map(sha256Source);
    const wantHandlers = inlineHandlerSources(html).map(sha256Source);
    const haveHashes = scriptSrc.filter((t) => t.startsWith("'sha256-"));
    for (const h of [...wantScripts, ...wantHandlers]) {
      if (!haveHashes.includes(h)) problems.push(`script-src lacks ${h} for an inline script or event handler (body edited without updating the policy? ${REGEN_HINT})`);
    }
    for (const h of haveHashes) {
      if (!wantScripts.includes(h) && !wantHandlers.includes(h)) problems.push(`script-src has stale hash ${h} that matches no inline script or handler (${REGEN_HINT})`);
    }
    if (wantHandlers.length > 0 && !scriptSrc.includes("'unsafe-hashes'")) problems.push("inline event handlers present but script-src lacks 'unsafe-hashes'");
    if (wantHandlers.length === 0 && scriptSrc.includes("'unsafe-hashes'")) problems.push("'unsafe-hashes' present but no inline event handlers remain");
  }
  const imgSrc = d["img-src"] ?? d["default-src"] ?? [];
  for (const origin of externalImageOrigins(html)) {
    if (!imgSrc.includes(origin) && !imgSrc.includes("https:")) problems.push(`img-src does not allow external <img> origin ${origin}`);
  }
  if (!(d["base-uri"] ?? []).some((t) => t === "'none'" || t === "'self'")) problems.push("base-uri must be 'none' or 'self'");
  if (!d["form-action"]) problems.push("form-action directive missing");
  return problems;
}
