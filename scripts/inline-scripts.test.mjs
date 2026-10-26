import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineScript, inlineUrl } from "./inline-scripts.mjs";

test("inline extraction pins body, page line and stable source URL", () => {
  const html = '<h1>Hi</h1>\n<script>\nwidget();\n</script>';
  assert.equal(inlineScript(html, 'p.html', 'widget').line, 2);
  assert.equal(inlineUrl('p.html', 'widget'), 'inline:p.html#widget');
  assert.equal(inlineScript(html, 'p.html', 'widget').src, '\nwidget();\n\n//# sourceURL=inline:p.html#widget\n');
  assert.throws(() => inlineScript(html, 'p.html', 'missing'), /p.html: expected exactly one.*found 0/);
  assert.throws(() => inlineScript(html + html, 'p.html', 'widget'), /found 2/);
});
