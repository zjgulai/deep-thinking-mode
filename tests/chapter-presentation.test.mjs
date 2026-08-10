import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHAPTER_IDS,
  CHAPTER_STYLE_SYSTEM,
  PORTRAIT_NOTICE,
  compileChapterThemesCss,
  validateChapterPresentation,
  verifyChapterPortraitAssets,
} from "../tools/lib/chapter-presentation.mjs";

const ROOT = new URL("..", import.meta.url);

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, ROOT), "utf8"));
}

function fixture() {
  return {
    taxonomy: readJson("knowledge/taxonomy.json"),
    mentors: readJson("knowledge/chapter-mentors.json"),
    themes: readJson("knowledge/chapter-themes.json"),
  };
}

function clone(value) {
  return structuredClone(value);
}

function expectInvalid(input, pattern) {
  assert.throws(() => validateChapterPresentation(input), pattern);
}

test("chapter presentation validates and joins all taxonomy chapters in stable order", () => {
  const input = fixture();
  const presentation = validateChapterPresentation(input);

  assert.equal(presentation.schema_version, "1.0.0");
  assert.equal(presentation.style_system, CHAPTER_STYLE_SYSTEM);
  assert.deepEqual(presentation.chapters.map((entry) => entry.chapter.id), CHAPTER_IDS);
  assert.deepEqual(
    presentation.chapters.map((entry) => entry.mentor.chapter_id),
    CHAPTER_IDS,
  );
  assert.deepEqual(
    presentation.chapters.map((entry) => entry.theme.chapter_id),
    CHAPTER_IDS,
  );
  assert.equal(presentation.chapters[0].mentor.name, "班昭");
  assert.equal(presentation.chapters[12].mentor.name, "谈允贤");
  assert.ok(Object.isFrozen(presentation));
  assert.ok(Object.isFrozen(presentation.chapters[0].theme.portrait));
});

test("chapter presentation preserves the user-locked mentor and visual matrix", () => {
  const presentation = validateChapterPresentation(fixture());
  assert.deepEqual(
    presentation.chapters.map((entry) => entry.mentor.name),
    [
      "班昭",
      "李清照",
      "苏蕙",
      "谢道韫",
      "王贞仪",
      "黄道婆",
      "武则天",
      "秦良玉",
      "卫铄（卫夫人）",
      "徐惠",
      "蔡琰（蔡文姬）",
      "上官婉儿",
      "谈允贤",
    ],
  );
  assert.deepEqual(
    presentation.chapters.map((entry) => entry.theme.mece.pattern),
    [
      "阶梯目录签纹",
      "内外双环边界纹",
      "八向旋转方格纹",
      "同源双解纹",
      "校准因果光锥纹",
      "经纬反馈网纹",
      "不等权重扇格纹",
      "节拍递进折纹",
      "递进笔势纹",
      "疏密间隔纹",
      "紊乱渐平波形纹",
      "三段递传折页纹",
      "证据点叶脉纹",
    ],
  );
  assert.deepEqual(
    presentation.chapters.map((entry) => entry.theme.mece.object),
    [
      "索引书匣",
      "素面铜镜",
      "无字璇玑方盘",
      "双景漏窗",
      "悬灯",
      "脚踏织机",
      "空白决策板",
      "白杆长枪",
      "毛笔",
      "铜漏刻",
      "纤维修补纸带",
      "空白奏表封函",
      "脉枕",
    ],
  );
  assert.deepEqual(
    presentation.chapters.map((entry) => entry.theme.mece.space),
    [
      "中轴典籍索引阁",
      "内外双重镜庭",
      "正交无字方阵室",
      "双门换景庭",
      "变量验证实验台",
      "连续织造工坊",
      "多门决断台",
      "单向山阶训练廊",
      "示范传习书室",
      "疏朗节制庭院",
      "纤维修复长廊",
      "文书传递廊",
      "安静观察诊察室",
    ],
  );
  assert.deepEqual(
    presentation.chapters.map((entry) => entry.theme.palette.light.accent),
    [
      "#96683F",
      "#6F918B",
      "#74536E",
      "#8299AC",
      "#405C82",
      "#356874",
      "#6C6337",
      "#8A493D",
      "#516853",
      "#B18A4F",
      "#996675",
      "#B35E4B",
      "#6D805C",
    ],
  );
});

test("chapter presentation enforces exact root and record keys", () => {
  const unknownRoot = fixture();
  unknownRoot.themes.extra = true;
  expectInvalid(unknownRoot, /themes: expected exact keys/);

  const missingMentorField = fixture();
  delete missingMentorField.mentors.mentors[0].historical_boundary;
  expectInvalid(missingMentorField, /mentors\.mentors\[0\]: expected exact keys/);

  const unknownPortraitField = fixture();
  unknownPortraitField.themes.themes[0].portrait.sizes = "100vw";
  expectInvalid(unknownPortraitField, /themes\.themes\[0\]\.portrait: expected exact keys/);
});

test("chapter presentation requires an exact ordered taxonomy join", () => {
  const missing = fixture();
  missing.themes.themes.pop();
  expectInvalid(missing, /themes\.themes: expected exactly 13 records/);

  const reordered = fixture();
  [reordered.mentors.mentors[0], reordered.mentors.mentors[1]] = [
    reordered.mentors.mentors[1],
    reordered.mentors.mentors[0],
  ];
  expectInvalid(reordered, /mentors\.mentors\[0\]\.chapter_id: expected 00/);

  const taxonomyDrift = fixture();
  taxonomyDrift.taxonomy.chapters[12].id = "13";
  expectInvalid(taxonomyDrift, /taxonomy\.chapters\[12\]\.id: expected 12/);
});

test("chapter presentation keeps mentor and MECE dimensions globally unique", () => {
  const duplicateMentor = fixture();
  duplicateMentor.mentors.mentors[1].name = duplicateMentor.mentors.mentors[0].name;
  expectInvalid(duplicateMentor, /mentors\.name: duplicate value/);

  for (const key of ["space", "object", "pattern", "divider"]) {
    const duplicate = fixture();
    duplicate.themes.themes[1].mece[key] = duplicate.themes.themes[0].mece[key];
    expectInvalid(duplicate, new RegExp(`themes\\.mece\\.${key}: duplicate value`));
  }

  const duplicateMotif = fixture();
  duplicateMotif.themes.themes[1].motif_key = duplicateMotif.themes.themes[0].motif_key;
  expectInvalid(duplicateMotif, /themes\.motif_key: duplicate value/);
});

test("chapter presentation rejects URLs and HTML or CSS injection in public copy", () => {
  const html = fixture();
  html.mentors.mentors[0].curatorial_intro = "<img src=x onerror=alert(1)>";
  expectInvalid(html, /external URL or HTML\/CSS syntax is forbidden/);

  const external = fixture();
  external.themes.themes[0].portrait.alt = "班昭 https:\/\/example.test";
  expectInvalid(external, /external URL or HTML\/CSS syntax is forbidden/);

  const css = fixture();
  css.mentors.mentors[0].teaching_persona = "url(data:text\/css,body{})";
  expectInvalid(css, /external URL or HTML\/CSS syntax is forbidden/);
});

test("chapter presentation validates colors, focus, alt, notice, aspect and safe paths", () => {
  const color = fixture();
  color.themes.themes[0].palette.light.accent = "red";
  expectInvalid(color, /expected uppercase six-digit hex color/);

  const focus = fixture();
  focus.themes.themes[0].portrait.focus_x = 101;
  expectInvalid(focus, /focus_x: expected integer in \[0, 100\]/);

  const alt = fixture();
  alt.themes.themes[0].portrait.alt = "东方纸雕艺术化讲师形象";
  expectInvalid(alt, /must identify mentor 班昭/);

  const notice = fixture();
  notice.mentors.mentors[0].portrait_notice = "历史真实肖像";
  expectInvalid(notice, new RegExp(PORTRAIT_NOTICE));

  const aspect = fixture();
  aspect.themes.themes[0].portrait.hero.width = 1500;
  expectInvalid(aspect, /expected 960x1200 hero asset/);

  const traversal = fixture();
  traversal.themes.themes[0].portrait.card.avif_path = "chapters/../portrait-card.avif";
  expectInvalid(traversal, /expected safe ASCII relative asset path/);

  const wrongChapter = fixture();
  wrongChapter.themes.themes[0].portrait.card.webp_path =
    "chapters/ch01-metacognition-and-boundaries/v4-20260809/portrait-card.webp";
  expectInvalid(wrongChapter, /expected path under chapters\/ch00-overview-and-toolbox\//);
});

test("chapter theme CSS compilation is deterministic and contains only validated tokens", () => {
  const input = fixture();
  const first = compileChapterThemesCss(input);
  const second = compileChapterThemesCss(input);

  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
  assert.match(first, /^\/\* Generated from knowledge\/chapter-themes\.json\./);
  assert.equal([...first.matchAll(/data-chapter="\d{2}"/g)].length, 13);
  assert.ok(first.indexOf('data-chapter="00"') < first.indexOf('data-chapter="12"'));
  assert.match(first, /--chapter-focus-x: 52%;/);
  assert.match(first, /--chapter-copy-order: 1;/);
  assert.match(first, /--chapter-copy-column: 1;/);
  assert.match(first, /--chapter-media-column: 2;/);
  assert.doesNotMatch(first, /prefers-color-scheme|color-scheme:\s*dark/);
  assert.doesNotMatch(first, /https?:|<style|url\s*\(/i);
});

function makeWebp(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes[24] = encodedWidth & 0xff;
  bytes[25] = (encodedWidth >> 8) & 0xff;
  bytes[26] = (encodedWidth >> 16) & 0xff;
  bytes[27] = encodedHeight & 0xff;
  bytes[28] = (encodedHeight >> 8) & 0xff;
  bytes[29] = (encodedHeight >> 16) & 0xff;
  return bytes;
}

function makeAvif(width, height) {
  const bytes = Buffer.alloc(44);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("avif", 8, "ascii");
  bytes.writeUInt32BE(0, 12);
  bytes.write("avif", 16, "ascii");
  bytes.write("mif1", 20, "ascii");
  bytes.writeUInt32BE(20, 24);
  bytes.write("ispe", 28, "ascii");
  bytes.writeUInt32BE(width, 36);
  bytes.writeUInt32BE(height, 40);
  return bytes;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("portrait file verification is opt-in and checks pinned hash, magic and dimensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "chapter-presentation-"));
  try {
    const input = fixture();
    const portrait = input.themes.themes[0].portrait;
    for (const variant of ["card", "hero"]) {
      const asset = portrait[variant];
      const avif = makeAvif(asset.width, asset.height);
      const webp = makeWebp(asset.width, asset.height);
      asset.avif_sha256 = sha256(avif);
      asset.webp_sha256 = sha256(webp);

      const avifPath = join(root, ...asset.avif_path.split("/"));
      const webpPath = join(root, ...asset.webp_path.split("/"));
      await mkdir(dirname(avifPath), { recursive: true });
      await writeFile(avifPath, avif);
      await writeFile(webpPath, webp);
    }

    const presentation = validateChapterPresentation(input);
    const verified = verifyChapterPortraitAssets({
      assetsRoot: root,
      presentation,
      chapterIds: ["00"],
    });
    assert.equal(verified[0].card.avif.width, 480);
    assert.equal(verified[0].hero.webp.height, 1200);
    assert.equal(verified[0].hero.avif.sha256, portrait.hero.avif_sha256);
    assert.ok(Object.isFrozen(verified));

    const corruptPath = join(root, ...portrait.card.webp_path.split("/"));
    await writeFile(corruptPath, Buffer.from("not-webp"));
    assert.throws(
      () => verifyChapterPortraitAssets({
        assetsRoot: root,
        presentation,
        chapterIds: ["00"],
      }),
      /asset SHA-256 mismatch/,
    );

    const unpinnedInput = fixture();
    for (const variant of ["card", "hero"]) {
      unpinnedInput.themes.themes[0].portrait[variant].avif_sha256 = null;
      unpinnedInput.themes.themes[0].portrait[variant].webp_sha256 = null;
    }
    const unpinned = validateChapterPresentation(unpinnedInput);
    assert.throws(
      () => verifyChapterPortraitAssets({
        assetsRoot: root,
        presentation: unpinned,
        requirePinnedHashes: false,
        chapterIds: ["00"],
      }),
      /invalid WebP file magic/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema validation accepts production-pinned portrait hashes", () => {
  const presentation = validateChapterPresentation(fixture());
  assert.equal(presentation.chapters.length, 13);
  assert.match(presentation.chapters[0].theme.portrait.card.avif_sha256, /^[0-9a-f]{64}$/);
});

test("V4 mentor portraits expose versioned card and hero production assets", () => {
  const presentation = validateChapterPresentation(fixture());
  for (const { chapter, theme } of presentation.chapters) {
    const portrait = theme.portrait;
    assert.equal(portrait.asset_version, "v4-20260809");
    assert.match(portrait.provenance_id, /^mentor-v4-20260809-[a-z0-9-]+$/);
    assert.match(portrait.source_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      [portrait.card.width, portrait.card.height, portrait.hero.width, portrait.hero.height],
      [480, 600, 960, 1200],
    );
    assert.equal(
      portrait.card.avif_path,
      `chapters/ch${chapter.id}-${chapter.slug}/v4-20260809/portrait-card.avif`,
    );
    assert.equal(
      portrait.card.webp_path,
      `chapters/ch${chapter.id}-${chapter.slug}/v4-20260809/portrait-card.webp`,
    );
    assert.equal(
      portrait.hero.avif_path,
      `chapters/ch${chapter.id}-${chapter.slug}/v4-20260809/portrait-hero.avif`,
    );
    assert.equal(
      portrait.hero.webp_path,
      `chapters/ch${chapter.id}-${chapter.slug}/v4-20260809/portrait-hero.webp`,
    );
  }
});

test("all production portrait assets match their pinned hash and real dimensions", () => {
  const presentation = validateChapterPresentation(fixture());
  const assets = verifyChapterPortraitAssets({
    assetsRoot: fileURLToPath(new URL("tools/site-assets", ROOT)),
    presentation,
  });
  assert.equal(assets.length, 13);
  assert.ok(assets.every((entry) =>
    entry.card.avif.width === 480 &&
    entry.card.webp.height === 600 &&
    entry.hero.avif.width === 960 &&
    entry.hero.webp.height === 1200
  ));
  assert.ok(assets.reduce((sum, entry) => sum + entry.card.avif.bytes, 0) < 400_000);
  assert.ok(assets.reduce((sum, entry) => sum + entry.card.webp.bytes, 0) < 650_000);
  assert.ok(assets.reduce((sum, entry) =>
    sum + entry.card.avif.bytes + entry.card.webp.bytes + entry.hero.avif.bytes + entry.hero.webp.bytes,
  0) < 4_000_000);
});
