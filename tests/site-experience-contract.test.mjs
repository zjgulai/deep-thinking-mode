import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const ROOT = new URL("..", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, ROOT), "utf8");
}

test("mobile navigation keeps a 44px touch target when the header is narrow", () => {
  const css = read("tools/site-assets/site.css");
  const rule = css.match(/\.nav-toggle\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(rule, /min-width:\s*44px\b/);
  assert.match(rule, /min-height:\s*44px\b/);
  assert.match(rule, /flex-shrink:\s*0\b/);
});

test("model library can shrink inside a 390px viewport", () => {
  const css = read("tools/site-assets/site.css");
  const layoutRule = css.match(/\.library-layout\s*>\s*\*\s*\{([^}]*)\}/u)?.[1] ?? "";
  const searchRule = css.match(/\.search-box\s*\{([^}]*)\}/u)?.[1] ?? "";
  const inputRule = css.match(/\.search-box input\s*\{([^}]*)\}/u)?.[1] ?? "";
  const summaryRule = css.match(/\.model-summary\s*\{([^}]*)\}/u)?.[1] ?? "";

  assert.match(layoutRule, /min-width:\s*0\b/u);
  assert.match(searchRule, /min-width:\s*0\b/u);
  assert.match(searchRule, /width:\s*100%(?:\s*;|\s)/u);
  assert.match(inputRule, /flex:\s*1\s+1\s+0%/u);
  assert.match(summaryRule, /min-width:\s*0\b/u);
  assert.match(summaryRule, /overflow-wrap:\s*anywhere\b/u);
});

test("model library pagination controls preserve touch and narrow-screen contracts", () => {
  const css = read("tools/site-assets/site.css");
  const buttonRule = css.match(/\.library-pager button\s*\{([^}]*)\}/u)?.[1] ?? "";
  const resultFocusRule = css.match(/\.model-list\[tabindex="-1"\]:focus-visible\s*\{([^}]*)\}/u)?.[1] ?? "";
  const resultScrollRule = css.match(/\.model-list\[tabindex="-1"\]\s*\{([^}]*)\}/u)?.[1] ?? "";
  const narrowStart = css.indexOf("@media (max-width: 680px)");
  const narrowEnd = css.indexOf("@media (prefers-reduced-motion: reduce)", narrowStart);
  const narrow = css.slice(narrowStart, narrowEnd);
  const print = css.slice(css.indexOf("@media print"));

  assert.match(buttonRule, /min-height:\s*44px\b/u);
  assert.match(resultFocusRule, /outline:\s*2px\s+solid/u);
  assert.match(resultScrollRule, /scroll-margin-top:\s*96px\b/u);
  assert.match(narrow, /\.library-pager[^{}]*\{[^}]*grid-template-columns:\s*1fr/u);
  assert.match(print, /\.library-pager[^}]*display:\s*none\s*!important/u);
  assert.match(print, /\.library-print-note[^}]*display:\s*block\s*!important/u);
});

test("public model tags reject CSS color fragments", async () => {
  let sanitizePublicModelTags;
  try {
    ({ sanitizePublicModelTags } = await import(
      "../tools/lib/public-model-tags.mjs"
    ));
  } catch (error) {
    assert.fail(`public model tag sanitizer is unavailable: ${error.code}`);
  }

  assert.deepEqual(
    sanitizePublicModelTags([
      "ffe58f;",
      "#fff",
      "576B95;",
      "逻辑思维",
      "职场效能",
    ]),
    ["逻辑思维", "职场效能"],
  );
});

test("generated model pages do not expose CSS color fragments as chips", () => {
  const modelDir = new URL("site/models/", ROOT);
  const offenders = [];

  for (const filename of readdirSync(modelDir).filter((name) => name.endsWith(".html"))) {
    const html = read(`site/models/${filename}`);
    if (/<span class="chip">#?[0-9a-f]{3,8};?<\/span>/i.test(html)) {
      offenders.push(filename);
    }
  }

  assert.deepEqual(offenders, []);
});

test("shared site runtime does not register a second Router submit or reset handler", () => {
  const listeners = [];
  const routerForm = {
    addEventListener(type) {
      listeners.push(type);
    },
    querySelector() {
      throw new Error("shared runtime must not inspect Router descendants");
    }
  };
  const document = {
    querySelector(selector) {
      if (selector === "[data-router-form]") return routerForm;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const window = {
    clearTimeout() {},
    setTimeout() {}
  };

  vm.runInNewContext(read("tools/site-assets/site.js"), { document, navigator: {}, window });
  assert.deepEqual(listeners, []);
});

test("Router experience styles preserve touch, narrow-screen, print, and reduced-motion contracts", () => {
  const css = read("tools/site-assets/site.css");
  const media = (start, end) => css.slice(css.indexOf(start), end ? css.indexOf(end, css.indexOf(start) + start.length) : undefined);
  const shortcutRule = css.match(/\.router-shortcut\s*\{([^}]*)\}/u)?.[1] ?? "";
  const clarifyRule = css.match(/\.router-clarify-option\s*\{([^}]*)\}/u)?.[1] ?? "";
  const narrow = media("@media (max-width: 680px)", "@media (prefers-reduced-motion: reduce)");
  const reducedMotion = media("@media (prefers-reduced-motion: reduce)", "@media print");
  const print = media("@media print");

  assert.match(shortcutRule, /min-height:\s*44px\b/u);
  assert.match(clarifyRule, /min-height:\s*44px\b/u);
  assert.match(narrow, /[^{}]*\.router-route-grid[^{}]*\{[^}]*grid-template-columns:\s*1fr/u);
  assert.match(reducedMotion, /\.route-result:hover[\s\S]*transform:\s*none\s*!important/u);
  assert.match(print, /\.router-shortcuts/u);
  assert.match(print, /\.router-copy-button/u);
});

test("combination workshop styles preserve ordered desktop rhythm, single-column reflow, touch, and print contracts", () => {
  const css = read("tools/site-assets/site.css");
  const media = (start, end) => css.slice(css.indexOf(start), end ? css.indexOf(end, css.indexOf(start) + start.length) : undefined);
  const phaseRule = css.match(/\.combination-phases\s*>\s*li\s*\{([^}]*)\}/u)?.[1] ?? "";
  const linkRule = css.match(/\.composition-link\s*\{([^}]*)\}/u)?.[1] ?? "";
  const narrow = media("@media (max-width: 680px)", "@media (prefers-reduced-motion: reduce)");
  const print = media("@media print");

  assert.match(phaseRule, /min-width:\s*0\b/u);
  assert.match(linkRule, /min-height:\s*44px\b/u);
  assert.match(narrow, /[^{}]*\.combination-grid[^{}]*\{[^}]*grid-template-columns:\s*1fr/u);
  assert.match(narrow, /[^{}]*\.combination-phases[^{}]*\{[^}]*grid-template-columns:\s*1fr/u);
  assert.match(print, /\.combination-copy/u);
  assert.match(print, /\.phase-decoration/u);
  assert.match(print, /\.combination-url/u);
});
