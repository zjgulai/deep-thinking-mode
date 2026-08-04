import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseWechatMetadata } from "../tools/lib/source-parser.mjs";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wechat");

async function fixture(name) {
  return readFile(join(fixtureRoot, name), "utf8");
}

test("preserves complete WeChat metadata and body image order", async () => {
  const parsed = parseWechatMetadata(await fixture("square-export.md"));
  assert.deepEqual(parsed.metadata, {
    title: "合成方形标题",
    author: "合成作者甲",
    originalStatus: "原创",
    publishedAt: "2026-01-02",
    location: "虚构城",
    sourceUrl: "https://mp.weixin.qq.com/s/square-synthetic?b=2&a=1"
  });
  assert.equal(parsed.status, "cleaned");
  assert.deepEqual(parsed.bodyImages, [
    { ordinal: 1, alt: "第一张合成图", url: "https://images.example.test/synthetic-first.png" },
    { ordinal: 2, alt: "第二张合成图", url: "https://images.example.test/synthetic-second.png" }
  ]);
});

test("accepts another synthetic export shape without rewriting metadata", async () => {
  const parsed = parseWechatMetadata(await fixture("cognition-export.md"));
  assert.deepEqual(parsed.metadata, {
    title: "合成认知标题",
    author: "合成作者乙",
    originalStatus: "非原创",
    publishedAt: "2026年2月3日",
    location: "虚构地",
    sourceUrl: "https://mp.weixin.qq.com/s/cognition-synthetic?z=3&y=2"
  });
  assert.equal(parsed.status, "cleaned");
});

test("marks missing metadata as needs_review instead of inventing fields", async () => {
  const parsed = parseWechatMetadata(await fixture("ordinary-markdown.md"));
  assert.deepEqual(parsed.metadata, {
    title: null,
    author: null,
    originalStatus: null,
    publishedAt: null,
    location: null,
    sourceUrl: null
  });
  assert.equal(parsed.status, "needs_review");
  assert.deepEqual(parsed.bodyImages, []);
});

test("keeps image-dominant export metadata and its only image", async () => {
  const parsed = parseWechatMetadata(await fixture("image-dominant-export.md"));
  assert.equal(parsed.status, "cleaned");
  assert.equal(parsed.metadata.title, "合成图片主导标题");
  assert.deepEqual(parsed.bodyImages, [
    { ordinal: 1, alt: "合成视觉内容", url: "https://images.example.test/synthetic-visual.png" }
  ]);
});

test("parses a synthetic footer-mismatch fixture without using footer contents as metadata", async () => {
  const parsed = parseWechatMetadata(await fixture("footer-mismatch.md"));
  assert.equal(parsed.status, "cleaned");
  assert.equal(parsed.metadata.title, "合成页脚不匹配标题");
  assert.equal(parsed.metadata.sourceUrl, "https://mp.weixin.qq.com/s/footer-mismatch-synthetic");
});

test("rejects an exported non-WeChat source URL without changing other metadata", async () => {
  const parsed = parseWechatMetadata(await fixture("title-mismatch.md"));
  assert.equal(parsed.metadata.title, "合成标题不匹配");
  assert.equal(parsed.metadata.author, "合成作者丙");
  assert.equal(parsed.metadata.sourceUrl, null);
  assert.equal(parsed.status, "needs_review");
});
