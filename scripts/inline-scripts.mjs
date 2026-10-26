// Registry of the inline behaviour scripts the pages ship and the harness test
// that extracts and runs each one. page-scripts.test.mjs requires an entry per
// block, the harnesses extract their block through `inlineScript`, and
// coverage-floor.test.mjs reads the V8 coverage of each block under the URL
// `inlineScript` tags it with — so a branch added to a page script that no
// harness test asserts fails the floor the same way a helper branch does.
export const HARNESSED_SCRIPTS = {
  "index.html": [
    { hook: "[data-hero-carousel]", harness: "scripts/carousels.test.mjs" },
    { hook: "[data-acmm-levels]", harness: "scripts/acmm-levels.test.mjs" },
    { hook: "[data-carousel]", harness: "scripts/carousels.test.mjs" },
  ],
  "stories/index.html": [
    { hook: 'getElementById("story-dialog")', harness: "scripts/story-dialog.test.mjs" },
  ],
};

export const INLINE_URL_PREFIX = "inline:";

// The script URL V8 reports for a block run via `new Function`: a `//# sourceURL`
// trailer names the function body, which otherwise has the empty URL.
export function inlineUrl(page, hook) {
  return `${INLINE_URL_PREFIX}${page}#${hook}`;
}

// The single plain `<script>` block of `html` (committed as `page`) whose body
// mentions `hook`: `src` is the body with the sourceURL trailer appended, ready
// for `new Function(...params, src)`; `line` is the 1-based page line of the
// opening tag. Throws unless exactly one block matches, so a harness can never
// silently test the wrong script.
export function inlineScript(html, page, hook) {
  const hits = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].filter((m) => m[1].includes(hook));
  if (hits.length !== 1) throw new Error(`${page}: expected exactly one <script> block mentioning ${hook}, found ${hits.length}`);
  const [m] = hits;
  return { src: `${m[1]}\n//# sourceURL=${inlineUrl(page, hook)}\n`, line: html.slice(0, m.index).split("\n").length };
}
