import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { serializeScriptJson } from "../tools/build-site.mjs";

const ROOT = new URL("..", import.meta.url);
const MODEL_LIBRARY = readFileSync(new URL("site/models/index.html", ROOT), "utf8");
const SITE_RUNTIME = readFileSync(new URL("tools/site-assets/site.js", ROOT), "utf8");
const SITEMAP = readFileSync(new URL("site/sitemap.xml", ROOT), "utf8");
const FIXED_SEARCH_CONTRACTS = new Map([
  ["第一性原理", { count: 18, digest: "b37d7512c71e1c98c8d02a856d9d49b80f5fceef7cd1a7a9f6f802264491d157" }],
  ["苏格拉底", { count: 18, digest: "ff98d613ad7f10d8341aff35fb1f55369254b518d422ab5c25c1ab1cca693bd7" }],
  ["决策", { count: 190, digest: "cdeed66c4270214e0bd0a733c29b5550e96a1508adea467222f918c256d81ec0" }],
  ["情绪", { count: 147, digest: "1b46b74c4f71153166303337a368db51659447e344890d2e3d6c78ce6fca9692" }],
  ["AI", { count: 15, digest: "ae30e6061a911e68cbe351fa591c2a950b6f07631f28f50e37427b64d61a648a" }],
]);

function payloadFrom(html) {
  const match = html.match(
    /<script type="application\/json" data-model-library-payload>([\s\S]*?)<\/script>/u,
  );
  assert.ok(match, "model library payload is missing");
  assert.doesNotMatch(match[1], /[<>&\u2028\u2029]/u);
  return JSON.parse(match[1]);
}

function displayName(value) {
  return String(value ?? "")
    .replace(/\*\*/g, "")
    .replace(/_+/g, " · ")
    .replace(/\s*#[^\s#]+.*$/u, "")
    .replace(/\s*[·｜]\s*[\p{Script=Han}]$/u, "")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*·\s*)+/g, " · ")
    .replace(/[，、:：\-·｜]\s*$/u, "")
    .trim();
}

function searchText(model) {
  const title = displayName(model.name) || String(model.name ?? "").trim();
  return [
    model.name,
    title,
    model.core,
    ...model.tags,
    ...model.triggers,
    ...model.role_ids,
  ].join(" ").normalize("NFKC").toLowerCase();
}

test("script JSON serialization is safe inside an inert HTML script", () => {
  assert.equal(
    serializeScriptJson({ value: "<>&\u2028\u2029" }),
    '{"value":"\\u003c\\u003e\\u0026\\u2028\\u2029"}',
  );
});

test("model library ships one bounded first page plus the complete local index", () => {
  const payload = payloadFrom(MODEL_LIBRARY);
  const cards = MODEL_LIBRARY.match(/<article class="model-summary"/gu) ?? [];
  const tags = MODEL_LIBRARY.match(/<[a-z][^>]*>/giu) ?? [];

  assert.equal(payload.schema, "model-library.v1");
  assert.equal(payload.page_size, 48);
  assert.equal(payload.search_render_limit, 250);
  assert.equal(payload.models.length, 2789);
  assert.equal(cards.length, 48);
  assert.ok(tags.length < 1_500, `initial DOM tag count is ${tags.length}`);
  assert.ok(Buffer.byteLength(MODEL_LIBRARY, "utf8") < 2_000_000);
  assert.match(MODEL_LIBRARY, /data-model-library/u);
  assert.match(MODEL_LIBRARY, /data-library-previous/u);
  assert.match(MODEL_LIBRARY, /data-library-next/u);
  assert.match(MODEL_LIBRARY, /data-library-live/u);
  assert.match(MODEL_LIBRARY, /id="model-filter"[^>]*maxlength="80"/u);
  assert.match(MODEL_LIBRARY, /id="model-library-list"[^>]*role="region"[^>]*tabindex="-1"[^>]*aria-label="模型搜索结果"/u);
  assert.match(MODEL_LIBRARY, /data-library-fallback/u);
  assert.match(MODEL_LIBRARY, /data-library-print-range/u);
  assert.match(MODEL_LIBRARY, /<noscript>[\s\S]*按十三章浏览完整模型库[\s\S]*<\/noscript>/u);
  assert.match(SITE_RUNTIME, /list\.focus\(\{\s*preventScroll:\s*true\s*\}\)/u);
  assert.match(SITE_RUNTIME, /list\.scrollIntoView\(\{/u);
  assert.match(SITE_RUNTIME, /prefers-reduced-motion:\s*reduce/u);
  assert.match(SITE_RUNTIME, /queryPrefix[^\n]*`“\$\{query\}”`/u);
  assert.match(SITE_RUNTIME, /input\.value\.slice\(0, 80\)\.normalize\("NFKC"\)/u);
  assert.match(SITE_RUNTIME, /tokens = \[\.\.\.new Set\(/u);
  assert.match(SITE_RUNTIME, /input\.disabled = true/u);
  assert.match(SITE_RUNTIME, /fallback\.hidden = false/u);
  assert.equal((SITE_RUNTIME.match(/focusPageStart\(\);/gu) ?? []).length, 2);
});

test("all payload routes are unique, safe, generated, crawlable, and in the sitemap", () => {
  const payload = payloadFrom(MODEL_LIBRARY);
  const urls = payload.models.map((model) => model.url);
  const detailFiles = readdirSync(new URL("site/models", ROOT))
    .filter((name) => name.endsWith(".html") && name !== "index.html");
  const sitemapModelUrls = new Set(
    [...SITEMAP.matchAll(/<loc>https:\/\/xmind\.lute-tlz-dddd\.top\/models\/([a-z0-9-]+-[a-f0-9]{12}\.html)<\/loc>/gu)]
      .map((match) => match[1]),
  );
  const chapterLinks = new Set(
    readdirSync(new URL("site/chapters", ROOT))
      .filter((name) => name.endsWith(".html"))
      .flatMap((name) => {
        const html = readFileSync(new URL(`site/chapters/${name}`, ROOT), "utf8");
        return [...html.matchAll(/href="\.\.\/models\/([a-z0-9-]+-[a-f0-9]{12}\.html)"/gu)]
          .map((match) => match[1]);
      }),
  );

  assert.equal(new Set(urls).size, 2789);
  assert.equal(detailFiles.length, 2789);
  const sortedUrls = [...urls].sort();
  assert.deepEqual([...detailFiles].sort(), sortedUrls);
  assert.deepEqual([...sitemapModelUrls].sort(), sortedUrls);
  assert.deepEqual([...chapterLinks].sort(), sortedUrls);
  for (const url of urls) {
    assert.match(url, /^[a-z0-9][a-z0-9-]*-[a-f0-9]{12}\.html$/u);
    assert.ok(existsSync(new URL(`site/models/${url}`, ROOT)), url);
  }
});

test("fixed full-index searches retain counts and ordered result identities", () => {
  const payload = payloadFrom(MODEL_LIBRARY);

  for (const [query, expected] of FIXED_SEARCH_CONTRACTS) {
    const token = query.toLowerCase();
    const matches = payload.models.filter((model) => searchText(model).includes(token));
    const digest = createHash("sha256")
      .update(matches.map((model) => model.url).join("\n"))
      .digest("hex");
    assert.equal(matches.length, expected.count, query);
    assert.equal(digest, expected.digest, `${query} ordered result digest`);
  }
});

test("broad searches retain the complete result set and explicit page count", () => {
  const payload = payloadFrom(MODEL_LIBRARY);
  const matches = payload.models.filter((model) => searchText(model).includes("分析"));

  assert.equal(matches.length, 270);
  assert.ok(matches.length > payload.search_render_limit);
  assert.equal(Math.ceil(matches.length / payload.page_size), 6);
});
