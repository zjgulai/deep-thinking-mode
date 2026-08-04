import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { cleanWechatExport } from "../tools/lib/wechat-cleaner.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const EMPTY_SHA256 = sha256(Buffer.alloc(0));
const LF_SHA256 = sha256(Buffer.from("\n", "utf8"));
const TITLE = "合成正式标题";
const METADATA = "原创 合成作者 2026-03-04 05:06 虚构地";
const SOURCE_URL = "https://mp.weixin.qq.com/s/cleaner_synthetic?b=2&a=1";
const SOURCE_DISPLAY = SOURCE_URL.replaceAll("_", "\\_");
const SOURCE_LINE = `> 原文地址: [${SOURCE_DISPLAY}](${SOURCE_URL})`;
const CSS = "\\* { color: synthetic;\u00a0} .fixture { display: block; }";
const SQUARE_BRAND = "![合成方形品牌卡](https://assets.example.test/square-brand.png)";
const COGNITION_BRAND = "![合成认知品牌卡](https://assets.example.test/cognition-brand.png)";
const ACTION_BAR = Array.from(
  { length: 5 },
  (_, index) => `![合成操作${index + 1}](data:image/svg+xml,synthetic-${index + 1}) 操作${index + 1}`
).join(" ");

function footerLines(brandLine) {
  return ["", brandLine, "", ACTION_BAR];
}

function makeFingerprints() {
  return {
    schema_version: "1.0.0",
    header: {
      css_sha256: sha256(Buffer.from(CSS, "utf8")),
      title_line: 1,
      blank_line: 2,
      formal_title_line: 3,
      setext_line: 4,
      metadata_line: 6,
      source_url_line: 8
    },
    footers: {
      square: {
        last_line_count: 4,
        action_icon_count: 5,
        sha256: sha256(Buffer.from(footerLines(SQUARE_BRAND).join("\n"), "utf8"))
      },
      cognition: {
        last_line_count: 4,
        action_icon_count: 5,
        sha256: sha256(Buffer.from(footerLines(COGNITION_BRAND).join("\n"), "utf8"))
      }
    }
  };
}

function makeExportText({
  bodyLines = ["合成正文足够长，用于验证保守清理行为。"],
  brandLine = SQUARE_BRAND,
  wrapperPrefix = `     ${TITLE} `,
  line2 = "",
  formalTitle = TITLE,
  setextLine = "================",
  line5 = "",
  metadataLine = METADATA,
  line7 = "",
  sourceLine = SOURCE_LINE,
  trailingLf = true
} = {}) {
  const lines = [
    `${wrapperPrefix}${CSS}`,
    line2,
    formalTitle,
    setextLine,
    line5,
    metadataLine,
    line7,
    sourceLine,
    "",
    ...bodyLines,
    ...footerLines(brandLine)
  ];
  return lines.join("\n") + (trailingLf ? "\n" : "");
}

function makeExport(overrides) {
  return Buffer.from(makeExportText(overrides), "utf8");
}

function sourceLineFor(url) {
  return `> 原文地址: [${url.replaceAll("_", "\\_")}](${url})`;
}

function options(overrides = {}) {
  return {
    fingerprints: makeFingerprints(),
    confirmedRemovals: { schema_version: "1.0.0", entries: [] },
    inputMode: "incremental",
    ...overrides
  };
}

function assertByteNoop(result, raw, expectedMarkdown = raw.toString("utf8")) {
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.outputBytes, raw);
  assert.equal(result.cleanedMarkdown, expectedMarkdown);
  assert.deepEqual(result.metadata, {
    title: null,
    author: null,
    originalStatus: null,
    publishedAt: null,
    location: null,
    sourceUrl: null
  });
  assert.deepEqual(result.bodyImages, []);
  assert.deepEqual(result.changes, []);
  assert.equal(result.audit, null);
  assert.equal(result.warnings.length >= 1, true);
  assert.deepEqual(result.warnings, [...new Set(result.warnings)].sort());
}

function assertContained(inner, outer) {
  assert.equal(inner.start >= outer.start, true);
  assert.equal(inner.end <= outer.end, true);
}

function assertOrderedNonOverlapping(spans, selectSpan) {
  for (let index = 1; index < spans.length; index += 1) {
    assert.equal(selectSpan(spans[index - 1]).end <= selectSpan(spans[index]).start, true);
  }
}

test("authoritative cleaning audit tests", async (t) => {
  await t.test("maps retained lines, metadata, images, hard breaks, and the cleaned body exactly", () => {
    const firstImage = "![图1](https://images.example.test/audit-one.png)";
    const secondImage = "![合成审计图](https://images.example.test/audit-two.png)";
    const raw = makeExport({
      bodyLines: ["正文甲\u00a0乙  ", firstImage, "", secondImage]
    });
    const result = cleanWechatExport(raw, options());
    const output = result.outputBytes;
    const audit = result.audit;

    assert.equal(result.status, "cleaned");
    assert.deepEqual(Object.keys(audit).sort(), [
      "body_non_whitespace_code_points",
      "body_output_span",
      "hard_breaks",
      "image_spans",
      "metadata_spans",
      "ordered_body_images_preserved",
      "output_byte_length",
      "retained_spans",
      "source_byte_length"
    ]);
    assert.equal(audit.source_byte_length, raw.length);
    assert.equal(audit.output_byte_length, output.length);
    assert.equal(audit.ordered_body_images_preserved, true);
    assert.equal(audit.body_non_whitespace_code_points, 4);

    assertOrderedNonOverlapping(audit.retained_spans, ({ source_span }) => source_span);
    assertOrderedNonOverlapping(audit.retained_spans, ({ output_span }) => output_span);
    assert.deepEqual(audit.retained_spans.map(({ source_line }) => source_line),
      [...audit.retained_spans.map(({ source_line }) => source_line)].sort((a, b) => a - b));
    for (const retained of audit.retained_spans) {
      const sourceSlice = raw.subarray(retained.source_span.start, retained.source_span.end);
      const outputSlice = output.subarray(retained.output_span.start, retained.output_span.end);
      assert.equal(sourceSlice.at(-1), 0x0a);
      assert.equal(outputSlice.at(-1), 0x0a);
      assert.equal(retained.before_sha256, sha256(sourceSlice));
      assert.equal(retained.after_sha256, sha256(outputSlice));
    }
    const normalizedBodyLine = audit.retained_spans.find(({ source_line }) => source_line === 10);
    assert.notEqual(normalizedBodyLine.before_sha256, normalizedBodyLine.after_sha256);
    const expectedBodySourceStart = Buffer.byteLength([
      `     ${TITLE} ${CSS}`,
      "",
      TITLE,
      "================",
      "",
      METADATA,
      "",
      SOURCE_LINE,
      ""
    ].join("\n") + "\n", "utf8");
    assert.deepEqual(normalizedBodyLine.source_span, {
      start: expectedBodySourceStart,
      end: expectedBodySourceStart + Buffer.byteLength("正文甲\u00a0乙  \n", "utf8")
    });
    assert.deepEqual(
      raw.subarray(normalizedBodyLine.source_span.start, normalizedBodyLine.source_span.end),
      Buffer.from("正文甲\u00a0乙  \n", "utf8")
    );
    const expectedBodyOutputStart = Buffer.byteLength(
      `${TITLE}\n================\n\n${METADATA}\n\n${SOURCE_LINE}\n\n`,
      "utf8"
    );
    assert.deepEqual(normalizedBodyLine.output_span, {
      start: expectedBodyOutputStart,
      end: expectedBodyOutputStart + Buffer.byteLength("正文甲 乙  \n", "utf8")
    });
    assert.deepEqual(
      output.subarray(normalizedBodyLine.output_span.start, normalizedBodyLine.output_span.end),
      Buffer.from("正文甲 乙  \n", "utf8")
    );

    assert.deepEqual(Object.keys(audit.metadata_spans).sort(), [
      "author", "location", "original_status", "published_at", "source_url", "title"
    ]);
    const retainedBySourceLine = new Map(
      audit.retained_spans.map((retained) => [retained.source_line, retained])
    );
    for (const [name, metadataSpan] of Object.entries(audit.metadata_spans)) {
      const sourceLine = name === "title" ? 3 : name === "source_url" ? 8 : 6;
      assert.equal(metadataSpan.preserved, true);
      assertContained(metadataSpan.source_span, retainedBySourceLine.get(sourceLine).source_span);
      assertContained(metadataSpan.output_span, retainedBySourceLine.get(sourceLine).output_span);
      assert.equal(metadataSpan.before_sha256,
        sha256(raw.subarray(metadataSpan.source_span.start, metadataSpan.source_span.end)));
      assert.equal(metadataSpan.after_sha256,
        sha256(output.subarray(metadataSpan.output_span.start, metadataSpan.output_span.end)));
    }
    const expectedMetadataSourceStart = Buffer.byteLength([
      `     ${TITLE} ${CSS}`,
      "",
      TITLE,
      "================",
      ""
    ].join("\n") + "\n", "utf8");
    assert.deepEqual(audit.metadata_spans.author.source_span, {
      start: expectedMetadataSourceStart + Buffer.byteLength("原创 ", "utf8"),
      end: expectedMetadataSourceStart + Buffer.byteLength("原创 合成作者", "utf8")
    });
    assert.equal(raw.subarray(
      audit.metadata_spans.author.source_span.start,
      audit.metadata_spans.author.source_span.end
    ).toString("utf8"), "合成作者");
    const expectedMetadataOutputStart = Buffer.byteLength(
      `${TITLE}\n================\n\n`,
      "utf8"
    );
    assert.deepEqual(audit.metadata_spans.author.output_span, {
      start: expectedMetadataOutputStart + Buffer.byteLength("原创 ", "utf8"),
      end: expectedMetadataOutputStart + Buffer.byteLength("原创 合成作者", "utf8")
    });
    assert.equal(output.subarray(
      audit.metadata_spans.author.output_span.start,
      audit.metadata_spans.author.output_span.end
    ).toString("utf8"), "合成作者");

    assert.deepEqual(result.bodyImages, [
      { ordinal: 1, alt: "图1", url: "https://images.example.test/audit-one.png" },
      { ordinal: 2, alt: "合成审计图", url: "https://images.example.test/audit-two.png" }
    ]);
    assert.deepEqual(audit.image_spans.map(({ ordinal }) => ordinal), [1, 2]);
    assertOrderedNonOverlapping(audit.image_spans, ({ source_token_span }) => source_token_span);
    assertOrderedNonOverlapping(audit.image_spans, ({ output_token_span }) => output_token_span);
    for (const [index, imageSpan] of audit.image_spans.entries()) {
      const image = result.bodyImages[index];
      const sourceToken = raw.subarray(imageSpan.source_token_span.start, imageSpan.source_token_span.end);
      const outputToken = output.subarray(imageSpan.output_token_span.start, imageSpan.output_token_span.end);
      assert.equal(sourceToken.includes(0x0a), false);
      assert.equal(outputToken.includes(0x0a), false);
      assert.equal(imageSpan.source_sha256, sha256(sourceToken));
      assert.equal(imageSpan.output_sha256, sha256(outputToken));
      assert.equal(imageSpan.alt_sha256, sha256(Buffer.from(image.alt, "utf8")));
      assert.equal(imageSpan.url_sha256, sha256(Buffer.from(image.url, "utf8")));
      assertContained(imageSpan.output_token_span, audit.body_output_span);
    }

    assert.equal(audit.hard_breaks.length, 1);
    assert.equal(audit.hard_breaks[0].source_line, 10);
    assert.equal(audit.hard_breaks[0].preserved, true);
    assert.deepEqual(raw.subarray(
      audit.hard_breaks[0].source_span.start,
      audit.hard_breaks[0].source_span.end
    ), Buffer.from("  "));
    assert.deepEqual(output.subarray(
      audit.hard_breaks[0].output_span.start,
      audit.hard_breaks[0].output_span.end
    ), Buffer.from("  "));

    const fixedHeader = Buffer.from(
      `${TITLE}\n================\n\n${METADATA}\n\n${SOURCE_LINE}\n`,
      "utf8"
    );
    assert.equal(audit.body_output_span.start, fixedHeader.length);
    assert.equal(output.subarray(
      audit.body_output_span.start,
      audit.body_output_span.end
    ).includes(Buffer.from(TITLE, "utf8")), false);
  });

  await t.test("counts image-only bodies as no text and represents an absent body with a zero span", () => {
    const imageOnly = cleanWechatExport(makeExport({
      bodyLines: ["![图1](https://images.example.test/only-image.png)"]
    }), options());
    assert.equal(imageOnly.status, "cleaned");
    assert.equal(imageOnly.audit.body_non_whitespace_code_points, 0);
    assert.equal(
      imageOnly.audit.body_output_span.end > imageOnly.audit.body_output_span.start,
      true
    );

    const absent = cleanWechatExport(makeExport({ bodyLines: [] }), options());
    assert.equal(absent.status, "cleaned");
    assert.equal(absent.audit.body_non_whitespace_code_points, 0);
    assert.deepEqual(absent.audit.body_output_span, {
      start: absent.outputBytes.length,
      end: absent.outputBytes.length
    });
  });

  await t.test("does not report normalized whitespace-only lines as hard breaks", () => {
    const raw = makeExport({
      bodyLines: ["正文前", "  ", "正文中", "   ", "普通正文保留  "]
    });
    const result = cleanWechatExport(raw, options());

    assert.equal(result.status, "cleaned");
    assert.deepEqual(result.audit.hard_breaks.map(({ source_line }) => source_line), [14]);
    const hardBreak = result.audit.hard_breaks[0];
    const retained = result.audit.retained_spans.find(({ source_line }) => source_line === 14);
    assertContained(hardBreak.source_span, retained.source_span);
    assertContained(hardBreak.output_span, retained.output_span);
    assert.deepEqual(
      raw.subarray(hardBreak.source_span.start, hardBreak.source_span.end),
      Buffer.from("  ")
    );
    assert.deepEqual(
      result.outputBytes.subarray(hardBreak.output_span.start, hardBreak.output_span.end),
      Buffer.from("  ")
    );
    assert.equal(
      result.audit.hard_breaks.some(({ source_line }) => source_line === 11 || source_line === 13),
      false
    );
  });
});

test("complete fingerprint removal tests", async (t) => {
  await t.test("removes only a fully matched wrapper and square footer with an auditable byte ledger", () => {
    const raw = makeExport();
    const result = cleanWechatExport(raw, options());
    const lines = makeExportText().slice(0, -1).split("\n");
    const headerBytes = Buffer.from(`${lines[0]}\n\n`, "utf8");
    const footerBytes = Buffer.from(`${footerLines(SQUARE_BRAND).join("\n")}\n`, "utf8");

    assert.equal(result.status, "cleaned");
    assert.equal(Buffer.isBuffer(result.outputBytes), true);
    assert.equal(result.cleanedMarkdown, result.outputBytes.toString("utf8"));
    assert.equal(result.cleanedMarkdown.startsWith(`${TITLE}\n================\n`), true);
    assert.equal(result.cleanedMarkdown.includes(CSS), false);
    assert.equal(result.cleanedMarkdown.includes(SQUARE_BRAND), false);
    assert.equal(result.cleanedMarkdown.includes("data:image/svg+xml"), false);
    assert.equal(result.cleanedMarkdown.endsWith("\n"), true);
    assert.equal(result.cleanedMarkdown.endsWith("\n\n"), false);
    assert.deepEqual(result.changes, [
      {
        ruleId: "WECHAT_FOOTER_SQUARE_V1",
        kind: "delete",
        sourceLines: [11, 12, 13, 14],
        beforeSha256: sha256(footerBytes),
        afterSha256: EMPTY_SHA256
      },
      {
        ruleId: "WECHAT_HEADER_V1",
        kind: "delete",
        sourceLines: [1, 2],
        beforeSha256: sha256(headerBytes),
        afterSha256: EMPTY_SHA256
      }
    ]);
  });

  await t.test("matches the second injected raw-byte footer fingerprint", () => {
    const result = cleanWechatExport(makeExport({ brandLine: COGNITION_BRAND }), options());

    assert.equal(result.status, "cleaned");
    assert.equal(result.cleanedMarkdown.includes(COGNITION_BRAND), false);
    assert.equal(result.changes[0].ruleId, "WECHAT_FOOTER_COGNITION_V1");
  });

  await t.test("grants the missing-LF exception only to a fully verified baseline mode", () => {
    const raw = makeExport({ trailingLf: false });

    assertByteNoop(cleanWechatExport(raw, options()), raw);

    const baseline = cleanWechatExport(raw, options({ inputMode: "verified_baseline" }));
    assert.equal(baseline.status, "cleaned");
    assert.equal(baseline.outputBytes.at(-1), 0x0a);
    assert.notEqual(baseline.outputBytes.at(-2), 0x0a);
    assert.deepEqual(
      baseline.changes.filter(({ ruleId }) => ruleId === "EOF_NEWLINE_V1"),
      [{
        ruleId: "EOF_NEWLINE_V1",
        kind: "append_eof",
        sourceLines: null,
        beforeSha256: EMPTY_SHA256,
        afterSha256: LF_SHA256
      }]
    );
    assert.equal(baseline.audit.source_byte_length, raw.length);
    assert.equal(baseline.audit.output_byte_length, baseline.outputBytes.length);
    assert.equal(
      baseline.audit.retained_spans.every(({ source_span }) => source_span.end <= raw.length),
      true
    );

    for (const inputMode of [undefined, "baseline", "unknown"]) {
      assertByteNoop(cleanWechatExport(raw, { ...options(), inputMode }), raw);
    }

    const badTitle = makeExport({ wrapperPrefix: "     不匹配标题 ", trailingLf: false });
    assertByteNoop(
      cleanWechatExport(badTitle, options({ inputMode: "verified_baseline" })),
      badTitle
    );
  });
});

test("partial fingerprint no-op tests", async (t) => {
  await t.test("throws TypeError for every non-byte input", () => {
    for (const raw of [makeExportText(), null, {}, new ArrayBuffer(4), new DataView(new ArrayBuffer(4))]) {
      assert.throws(() => cleanWechatExport(raw, options()), TypeError);
    }
  });

  await t.test("copies Uint8Array input and returns Buffer output", () => {
    const bytes = new Uint8Array(makeExport());
    const result = cleanWechatExport(bytes, options());

    assert.equal(result.status, "cleaned");
    assert.equal(Buffer.isBuffer(result.outputBytes), true);
    assert.notEqual(result.outputBytes.buffer, bytes.buffer);
  });

  await t.test("returns invalid UTF-8 byte-for-byte with no decoded Markdown", () => {
    const raw = Buffer.from([0xff, 0xfe, 0x0a]);
    const result = cleanWechatExport(raw, options());

    assertByteNoop(result, raw, null);
  });

  await t.test("returns a UTF-8 BOM export byte-for-byte instead of shifting source offsets", () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), makeExport()]);

    assertByteNoop(cleanWechatExport(raw, options()), raw);
  });

  await t.test("returns CRLF and bare-CR shells byte-for-byte", () => {
    const crlf = Buffer.from(makeExportText().replaceAll("\n", "\r\n"), "utf8");
    const bareCr = Buffer.from(makeExportText().replace("\n", "\r"), "utf8");
    assertByteNoop(cleanWechatExport(crlf, options()), crlf);
    assertByteNoop(cleanWechatExport(bareCr, options()), bareCr);
  });

  await t.test("binds all eight fixed header lines and ignores forged replacements in the body", () => {
    const mismatches = [
      { wrapperPrefix: `    ${TITLE} ` },
      { wrapperPrefix: `     ${TITLE}  ` },
      { line2: " " },
      { formalTitle: "另一个合成标题" },
      { setextLine: "---" },
      { line5: "\t" },
      { metadataLine: "合成作者 2026-03-04" },
      { line7: " " },
      { sourceLine: `> 原文地址: [${SOURCE_DISPLAY}](https://mp.weixin.qq.com/s/different)` },
      { sourceLine: "> 原文地址: [https://example.test/x](https://example.test/x)" }
    ];
    for (const mismatch of mismatches) {
      const raw = makeExport(mismatch);
      assertByteNoop(cleanWechatExport(raw, options()), raw);
    }

    const forgedBody = makeExport({
      metadataLine: "非法元数据",
      sourceLine: "非法来源",
      bodyLines: [METADATA, SOURCE_LINE, "合成正文"]
    });
    assertByteNoop(cleanWechatExport(forgedBody, options()), forgedBody);
  });

  await t.test("compares the display URL to the raw target token before canonicalization", () => {
    const rawTarget = `${SOURCE_URL}#synthetic-fragment`;
    const raw = makeExport({ sourceLine: sourceLineFor(rawTarget) });
    const result = cleanWechatExport(raw, options());

    assert.equal(result.status, "cleaned");
    assert.equal(result.metadata.sourceUrl, SOURCE_URL);
  });

  await t.test("returns title, footer, ordinary Markdown, and unknown-mode mismatches whole-file", () => {
    const cases = [
      [makeExport({ wrapperPrefix: "     其他标题 " }), options()],
      [makeExport({ brandLine: "![未知合成品牌](https://assets.example.test/unknown.png)" }), options()],
      [Buffer.from("# 普通合成 Markdown\n\n不含微信导出模板。\n", "utf8"), options()],
      [makeExport(), options({ inputMode: "unknown" })]
    ];
    for (const [raw, callOptions] of cases) {
      assertByteNoop(cleanWechatExport(raw, callOptions), raw);
    }
  });
});

test("body preservation and confirmed-removal tests", async (t) => {
  await t.test("preserves fixed metadata, structure, ordered body images, hard breaks, and ad terms", () => {
    const bodyLines = [
      "## 合成二级标题",
      "",
      "- 合成列表项",
      "- 另一个合成列表项",
      "",
      "合成硬换行必须保留两个空格  ",
      "包含广告案例与推广分析的正文必须保留。",
      "普通保留行的字节序列不得改写 \t",
      "[合成正文外链](https://outside.example.test/reference)",
      "非原创 伪造作者 2030-01-01 00:00 伪造地",
      `> 原文地址: [${SOURCE_DISPLAY}](${SOURCE_URL})`,
      "![图1](https://images.example.test/body-one.png)",
      "图1",
      "![合成正文图](https://images.example.test/body-two.png)"
    ];
    const result = cleanWechatExport(makeExport({ bodyLines }), options());

    assert.equal(result.status, "cleaned");
    assert.equal(result.cleanedMarkdown.includes(TITLE), true);
    assert.equal(result.cleanedMarkdown.includes(METADATA), true);
    assert.equal(result.cleanedMarkdown.includes(SOURCE_LINE), true);
    assert.equal(result.cleanedMarkdown.includes("## 合成二级标题"), true);
    assert.equal(result.cleanedMarkdown.includes("- 合成列表项"), true);
    assert.equal(result.cleanedMarkdown.includes("合成硬换行必须保留两个空格  \n"), true);
    assert.equal(result.cleanedMarkdown.includes("广告案例与推广分析"), true);
    assert.equal(result.cleanedMarkdown.includes("普通保留行的字节序列不得改写 \t\n"), true);
    assert.equal(result.cleanedMarkdown.includes("https://outside.example.test/reference"), true);
    assert.equal(result.cleanedMarkdown.includes("\n图1\n"), false);
    assert.deepEqual(result.metadata, {
      title: TITLE,
      author: "合成作者",
      originalStatus: "原创",
      publishedAt: "2026-03-04 05:06",
      location: "虚构地",
      sourceUrl: SOURCE_URL
    });
    assert.deepEqual(result.bodyImages, [
      { ordinal: 1, alt: "图1", url: "https://images.example.test/body-one.png" },
      { ordinal: 2, alt: "合成正文图", url: "https://images.example.test/body-two.png" }
    ]);
  });

  await t.test("removes a same-number label only when direct or separated by one exact empty line", () => {
    const bodyLines = [
      "![图1](https://images.example.test/one.png)",
      "图1",
      "![图2](https://images.example.test/two.png)",
      "",
      "图2",
      "![图3](https://images.example.test/three.png)",
      "",
      "",
      "图3",
      "![图4](https://images.example.test/four.png)",
      " ",
      "图4",
      "![图5](https://images.example.test/five.png)",
      "",
      "图6",
      "![图7](https://images.example.test/seven.png)",
      "合成中间正文",
      "图7",
      "正文中的图8不是独立标签。"
    ];
    const result = cleanWechatExport(makeExport({ bodyLines }), options());

    assert.equal(result.cleanedMarkdown.includes("\n图1\n"), false);
    assert.equal(result.cleanedMarkdown.includes("\n图2\n"), false);
    assert.equal(result.cleanedMarkdown.includes("\n图3\n"), true);
    assert.equal(result.cleanedMarkdown.includes("\n图4\n"), true);
    assert.equal(result.cleanedMarkdown.includes("\n图6\n"), true);
    assert.equal(result.cleanedMarkdown.includes("\n图7\n"), true);
    assert.equal(result.cleanedMarkdown.includes("正文中的图8不是独立标签。"), true);
    assert.equal(
      result.changes.filter(({ ruleId }) => ruleId === "DUPLICATE_FIGURE_LABEL_V1").length,
      2
    );
  });

  await t.test("uses ASCII-only trim and requires both hashes for one CTA deletion", () => {
    const confirmedLine = " \t合成待确认平台提示\t ";
    const sameUrlUnconfirmedLine = "同一合成来源但未确认的提示";
    const nbspWrappedLine = "\u00a0合成待确认平台提示\u00a0";
    const confirmedRemovals = {
      schema_version: "1.0.0",
      entries: [{
        canonical_url_sha256: sha256(Buffer.from(SOURCE_URL, "utf8")),
        trimmed_line_sha256: sha256(Buffer.from("合成待确认平台提示", "utf8"))
      }]
    };
    const matching = cleanWechatExport(
      makeExport({ bodyLines: [confirmedLine, sameUrlUnconfirmedLine, nbspWrappedLine] }),
      options({ confirmedRemovals })
    );

    assert.equal(matching.cleanedMarkdown.includes(confirmedLine), false);
    assert.equal(matching.cleanedMarkdown.includes(sameUrlUnconfirmedLine), true);
    assert.equal(matching.cleanedMarkdown.includes(" 合成待确认平台提示 "), true);
    assert.equal(
      matching.changes.filter(({ ruleId }) => ruleId === "CONFIRMED_PLATFORM_CTA_V1").length,
      1
    );

    const otherUrl = "https://mp.weixin.qq.com/s/other_synthetic";
    const lineOnly = cleanWechatExport(
      makeExport({ bodyLines: [confirmedLine], sourceLine: sourceLineFor(otherUrl) }),
      options({ confirmedRemovals })
    );
    assert.equal(lineOnly.cleanedMarkdown.includes(confirmedLine), true);
    assert.equal(
      lineOnly.changes.some(({ ruleId }) => ruleId === "CONFIRMED_PLATFORM_CTA_V1"),
      false
    );
  });

  await t.test("rejects a source when the same confirmed pair occurs more than once", () => {
    const line = "合成重复平台提示";
    const confirmedRemovals = {
      schema_version: "1.0.0",
      entries: [{
        canonical_url_sha256: sha256(Buffer.from(SOURCE_URL, "utf8")),
        trimmed_line_sha256: sha256(Buffer.from(line, "utf8"))
      }]
    };
    const raw = makeExport({ bodyLines: [line, "合成正文", line] });

    assertByteNoop(cleanWechatExport(raw, options({ confirmedRemovals })), raw);
  });

  await t.test("audits blank folding across a deleted CTA with non-contiguous original lines", () => {
    const line = "合成单次平台提示";
    const confirmedRemovals = {
      schema_version: "1.0.0",
      entries: [{
        canonical_url_sha256: sha256(Buffer.from(SOURCE_URL, "utf8")),
        trimmed_line_sha256: sha256(Buffer.from(line, "utf8"))
      }]
    };
    const result = cleanWechatExport(
      makeExport({ bodyLines: [line, "", "删除后的合成段落"] }),
      options({ confirmedRemovals })
    );
    const blankChange = result.changes.find(
      ({ ruleId }) => ruleId === "BLANK_LINE_NORMALIZATION_V1"
    );

    assert.equal(result.status, "cleaned");
    assert.deepEqual(blankChange, {
      ruleId: "BLANK_LINE_NORMALIZATION_V1",
      kind: "normalize",
      sourceLines: [9, 11],
      beforeSha256: sha256(Buffer.from("\n\n", "utf8")),
      afterSha256: LF_SHA256
    });
    assert.equal(blankChange.beforeSha256 === sha256(Buffer.from(`${line}\n`, "utf8")), false);
  });

  await t.test("normalizes NBSP and blank lines after validation without stripping hard breaks", () => {
    const bodyLines = [
      "包含\u00a0合成空格",
      "   ",
      "",
      "下一段",
      "非空行末尾双空格仍保留  "
    ];
    const result = cleanWechatExport(makeExport({ bodyLines }), options());

    assert.equal(result.status, "cleaned");
    assert.equal(result.cleanedMarkdown.includes("包含 合成空格"), true);
    assert.equal(result.cleanedMarkdown.includes("\u00a0"), false);
    assert.equal(result.cleanedMarkdown.includes("\n\n\n"), false);
    assert.equal(result.cleanedMarkdown.includes("非空行末尾双空格仍保留  \n"), true);
    assert.equal(result.changes.some(({ ruleId }) => ruleId === "NBSP_NORMALIZATION_V1"), true);
    assert.equal(result.changes.some(({ ruleId }) => ruleId === "BLANK_LINE_NORMALIZATION_V1"), true);
    const retainedByLine = new Map(
      result.audit.retained_spans.map((retained) => [retained.source_line, retained])
    );
    assert.equal(retainedByLine.has(12), false);
    assert.equal(
      retainedByLine.get(11).before_sha256,
      sha256(Buffer.from("   \n", "utf8"))
    );
    assert.equal(retainedByLine.get(11).after_sha256, LF_SHA256);
  });

  await t.test("records an NBSP-only blank in one non-overlapping replayable normalization", () => {
    const result = cleanWechatExport(
      makeExport({ bodyLines: ["前一段", "\u00a0", "后一段"] }),
      options()
    );
    const normalizeChanges = result.changes.filter(({ kind }) => kind === "normalize");
    const occurrences = normalizeChanges.flatMap(({ sourceLines }) => sourceLines);

    assert.equal(result.status, "cleaned");
    assert.equal(new Set(occurrences).size, occurrences.length);
    assert.deepEqual(normalizeChanges, [{
      ruleId: "BLANK_LINE_NORMALIZATION_V1",
      kind: "normalize",
      sourceLines: [11],
      beforeSha256: sha256(Buffer.from("\u00a0\n", "utf8")),
      afterSha256: LF_SHA256
    }]);
  });
});
