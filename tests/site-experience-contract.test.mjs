import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
