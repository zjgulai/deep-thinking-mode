import { TextDecoder } from "node:util";

import { sha256, isSha256 } from "./hash.mjs";
import { assertWechatSourceUrl, canonicalizeHttpUrl } from "./url-canonicalizer.mjs";

const EMPTY_METADATA = Object.freeze({
  title: null,
  author: null,
  originalStatus: null,
  publishedAt: null,
  location: null,
  sourceUrl: null
});

const HEADER_LINE_CONTRACT = Object.freeze({
  title_line: 1,
  blank_line: 2,
  formal_title_line: 3,
  setext_line: 4,
  metadata_line: 6,
  source_url_line: 8
});

const EMPTY_SHA256 = sha256(Buffer.alloc(0));
const LF_BYTES = Buffer.from("\n", "utf8");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function noOp(inputBytes, cleanedMarkdown, warning) {
  return {
    status: "needs_review",
    outputBytes: Buffer.from(inputBytes),
    cleanedMarkdown,
    metadata: { ...EMPTY_METADATA },
    bodyImages: [],
    changes: [],
    warnings: [warning],
    audit: null
  };
}

function isValidFingerprints(fingerprints) {
  if (fingerprints?.schema_version !== "1.0.0" || !isSha256(fingerprints.header?.css_sha256)) {
    return false;
  }
  for (const [field, value] of Object.entries(HEADER_LINE_CONTRACT)) {
    if (fingerprints.header[field] !== value) return false;
  }
  for (const name of ["square", "cognition"]) {
    const footer = fingerprints.footers?.[name];
    if (footer?.last_line_count !== 4 || footer.action_icon_count !== 5 || !isSha256(footer.sha256)) {
      return false;
    }
  }
  return true;
}

function isValidConfirmedRemovals(confirmedRemovals) {
  if (confirmedRemovals?.schema_version !== "1.0.0" || !Array.isArray(confirmedRemovals.entries)) {
    return false;
  }
  const pairs = new Set();
  for (const entry of confirmedRemovals.entries) {
    if (!isSha256(entry?.canonical_url_sha256) || !isSha256(entry?.trimmed_line_sha256)) {
      return false;
    }
    const pair = `${entry.canonical_url_sha256}:${entry.trimmed_line_sha256}`;
    if (pairs.has(pair)) return false;
    pairs.add(pair);
  }
  return true;
}

function physicalLineSlice(records, sourceLine) {
  const record = records[sourceLine - 1];
  return Buffer.from(record.text + (record.hasLf ? "\n" : ""), "utf8");
}

function sourceSlices(records, sourceLines) {
  return Buffer.concat(sourceLines.map((sourceLine) => physicalLineSlice(records, sourceLine)));
}

function change(ruleId, kind, sourceLines, beforeBytes, afterBytes = Buffer.alloc(0)) {
  return {
    ruleId,
    kind,
    sourceLines,
    beforeSha256: sha256(beforeBytes),
    afterSha256: sha256(afterBytes)
  };
}

function parseMetadataLine(line) {
  const match = /^(原创|非原创) (.+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) (.+)$/d.exec(line);
  if (!match) return null;
  return {
    originalStatus: match[1],
    author: match[2],
    publishedAt: match[3],
    location: match[4],
    ranges: {
      originalStatus: match.indices[1],
      author: match.indices[2],
      publishedAt: match.indices[3],
      location: match.indices[4]
    }
  };
}

function parseSourceLine(line) {
  const match = /^> 原文地址: \[([^\]]+)\]\(([^\s()]+)\)$/d.exec(line);
  if (!match) return null;
  const displayUrl = match[1].replaceAll("\\_", "_");
  const rawTargetUrl = match[2];
  if (displayUrl !== rawTargetUrl) return null;

  try {
    const sourceUrl = canonicalizeHttpUrl(rawTargetUrl);
    assertWechatSourceUrl(sourceUrl);
    return { sourceUrl, targetRange: match.indices[2] };
  } catch {
    return null;
  }
}

function extractImages(entries) {
  const images = [];
  const matcher = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const entry of entries) {
    for (const match of entry.text.matchAll(matcher)) {
      images.push({
        token: match[0],
        alt: match[1],
        url: match[2],
        sourceLine: entry.sourceLine,
        tokenStartIndex: match.index,
        tokenEndIndex: match.index + match[0].length
      });
    }
  }
  return images;
}

function validateEnvelope(lines, fingerprints) {
  if (lines.length < 12) return null;
  const formalTitle = lines[2];
  const wrapperPrefix = `     ${formalTitle} `;
  if (
    formalTitle.length === 0 ||
    lines[1] !== "" ||
    !/^=+$/.test(lines[3]) ||
    lines[4] !== "" ||
    lines[6] !== "" ||
    !lines[0].startsWith(wrapperPrefix)
  ) {
    return null;
  }

  const css = lines[0].slice(wrapperPrefix.length);
  if (!css.startsWith("\\* {") || sha256(Buffer.from(css, "utf8")) !== fingerprints.header.css_sha256) {
    return null;
  }

  const parsedMetadata = parseMetadataLine(lines[5]);
  const parsedSource = parseSourceLine(lines[7]);
  if (!parsedMetadata || parsedSource === null) return null;

  let footerMatch = null;
  for (const name of ["square", "cognition"]) {
    const footer = fingerprints.footers[name];
    const footerLines = lines.slice(-footer.last_line_count);
    const footerText = footerLines.join("\n");
    const actionIconCount = footerText.split("data:image/svg+xml").length - 1;
    if (
      footerLines.length === footer.last_line_count &&
      actionIconCount === footer.action_icon_count &&
      sha256(Buffer.from(footerText, "utf8")) === footer.sha256
    ) {
      footerMatch = {
        name,
        startLine: lines.length - footer.last_line_count + 1,
        endLine: lines.length
      };
      break;
    }
  }
  if (!footerMatch) return null;

  return {
    metadata: {
      title: formalTitle,
      author: parsedMetadata.author,
      originalStatus: parsedMetadata.originalStatus,
      publishedAt: parsedMetadata.publishedAt,
      location: parsedMetadata.location,
      sourceUrl: parsedSource.sourceUrl
    },
    metadataRanges: {
      title: [0, formalTitle.length],
      author: parsedMetadata.ranges.author,
      original_status: parsedMetadata.ranges.originalStatus,
      published_at: parsedMetadata.ranges.publishedAt,
      location: parsedMetadata.ranges.location,
      source_url: parsedSource.targetRange
    },
    footer: footerMatch
  };
}

function asciiTrim(line) {
  return line.replace(/^[ \t]+|[ \t]+$/g, "");
}

function plannedBodyDeletes(records, bodyStartLine, bodyEndLine, sourceUrl, confirmedRemovals) {
  const deletes = new Map();
  for (let sourceLine = bodyStartLine + 1; sourceLine <= bodyEndLine; sourceLine += 1) {
    const previous = records[sourceLine - 2].text;
    const current = records[sourceLine - 1].text;
    const imageLine =
      previous === "" && sourceLine - 2 >= bodyStartLine
        ? records[sourceLine - 3].text
        : previous;
    const imageMatch = /^!\[图(\d+)\]\([^\s)]+(?:\s+[^)]*)?\)$/.exec(imageLine);
    const labelMatch = /^图(\d+)$/.exec(current);
    if (imageMatch && labelMatch && imageMatch[1] === labelMatch[1]) {
      deletes.set(sourceLine, "DUPLICATE_FIGURE_LABEL_V1");
    }
  }

  const canonicalUrlHash = sha256(Buffer.from(sourceUrl, "utf8"));
  for (const entry of confirmedRemovals.entries) {
    if (entry.canonical_url_sha256 !== canonicalUrlHash) continue;
    const matches = [];
    for (let sourceLine = bodyStartLine; sourceLine <= bodyEndLine; sourceLine += 1) {
      const trimmedLineHash = sha256(Buffer.from(asciiTrim(records[sourceLine - 1].text), "utf8"));
      if (trimmedLineHash === entry.trimmed_line_sha256) matches.push(sourceLine);
    }
    if (matches.length > 1) return { ambiguous: true, deletes: new Map() };
    if (matches.length === 1) deletes.set(matches[0], "CONFIRMED_PLATFORM_CTA_V1");
  }
  return { ambiguous: false, deletes };
}

function normalizeRetained(records, deletedLines) {
  const entries = records
    .filter(({ sourceLine }) => !deletedLines.has(sourceLine))
    .map((record) => ({ ...record }));
  const changes = [];

  const allNbspEntries = entries.filter(({ text }) => text.includes("\u00a0"));
  const nbspContentEntries = allNbspEntries.filter(({ text }) => !/^[ \t\u00a0]*$/.test(text));
  if (nbspContentEntries.length > 0) {
    const sourceLines = nbspContentEntries.map(({ sourceLine }) => sourceLine);
    const beforeBytes = sourceSlices(records, sourceLines);
    const afterBytes = Buffer.concat(nbspContentEntries.map((entry) => Buffer.from(
      entry.text.replaceAll("\u00a0", " ") + (entry.hasLf ? "\n" : ""),
      "utf8"
    )));
    changes.push(change("NBSP_NORMALIZATION_V1", "normalize", sourceLines, beforeBytes, afterBytes));
  }
  for (const entry of allNbspEntries) entry.text = entry.text.replaceAll("\u00a0", " ");

  const normalizedEntries = [];
  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (!/^[ \t]*$/.test(entry.text)) {
      normalizedEntries.push(entry);
      index += 1;
      continue;
    }

    const blankRun = [];
    while (index < entries.length && /^[ \t]*$/.test(entries[index].text)) {
      blankRun.push(entries[index]);
      index += 1;
    }
    const isTrailing = index === entries.length;
    const replacementBytes = isTrailing ? Buffer.alloc(0) : LF_BYTES;
    const alreadyCanonical =
      blankRun.length === 1 && blankRun[0].text === "" && blankRun[0].hasLf && !isTrailing;
    if (!alreadyCanonical) {
      const sourceLines = blankRun.map(({ sourceLine }) => sourceLine);
      changes.push(change(
        "BLANK_LINE_NORMALIZATION_V1",
        "normalize",
        sourceLines,
        sourceSlices(records, sourceLines),
        replacementBytes
      ));
    }
    if (!isTrailing) {
      normalizedEntries.push({ ...blankRun[0], text: "", hasLf: true });
    }
  }

  return { entries: normalizedEntries, changes };
}

function addOutputOffsets(entries) {
  let outputOffset = 0;
  return entries.map((entry) => {
    const outputBytes = Buffer.from(`${entry.text}\n`, "utf8");
    const mapped = {
      ...entry,
      outputStart: outputOffset,
      outputEnd: outputOffset + outputBytes.length
    };
    outputOffset = mapped.outputEnd;
    return mapped;
  });
}

function byteOffset(text, characterIndex) {
  return Buffer.byteLength(text.slice(0, characterIndex), "utf8");
}

function sourceTokenSpan(record, range) {
  return {
    start: record.sourceStart + byteOffset(record.text, range[0]),
    end: record.sourceStart + byteOffset(record.text, range[1])
  };
}

function mappedOutputTokenSpan(entry, sourceText, range) {
  const normalizedPrefix = sourceText.slice(0, range[0]).replaceAll("\u00a0", " ");
  const normalizedToken = sourceText.slice(range[0], range[1]).replaceAll("\u00a0", " ");
  const start = entry.outputStart + Buffer.byteLength(normalizedPrefix, "utf8");
  return {
    start,
    end: start + Buffer.byteLength(normalizedToken, "utf8")
  };
}

function buildAudit({ inputBytes, outputBytes, records, finalEntries, envelope, originalBodyImages }) {
  const recordsByLine = new Map(records.map((record) => [record.sourceLine, record]));
  const entriesByLine = new Map(finalEntries.map((entry) => [entry.sourceLine, entry]));
  const retainedSpans = finalEntries.map((entry) => {
    const record = recordsByLine.get(entry.sourceLine);
    const sourceSpan = { start: record.sourceStart, end: record.sourceEnd };
    const outputSpan = { start: entry.outputStart, end: entry.outputEnd };
    return {
      source_line: entry.sourceLine,
      source_span: sourceSpan,
      output_span: outputSpan,
      before_sha256: sha256(inputBytes.subarray(sourceSpan.start, sourceSpan.end)),
      after_sha256: sha256(outputBytes.subarray(outputSpan.start, outputSpan.end))
    };
  });

  const metadataLineByField = {
    title: 3,
    author: 6,
    original_status: 6,
    published_at: 6,
    location: 6,
    source_url: 8
  };
  const metadataSpans = {};
  for (const field of ["title", "author", "original_status", "published_at", "location", "source_url"]) {
    const sourceLine = metadataLineByField[field];
    const record = recordsByLine.get(sourceLine);
    const entry = entriesByLine.get(sourceLine);
    const range = envelope.metadataRanges[field];
    const sourceSpan = sourceTokenSpan(record, range);
    const outputSpan = mappedOutputTokenSpan(entry, record.text, range);
    metadataSpans[field] = {
      source_span: sourceSpan,
      output_span: outputSpan,
      before_sha256: sha256(inputBytes.subarray(sourceSpan.start, sourceSpan.end)),
      after_sha256: sha256(outputBytes.subarray(outputSpan.start, outputSpan.end)),
      preserved: true
    };
  }

  const imageSpans = originalBodyImages.map((image, index) => {
    const record = recordsByLine.get(image.sourceLine);
    const entry = entriesByLine.get(image.sourceLine);
    const range = [image.tokenStartIndex, image.tokenEndIndex];
    const sourceSpan = sourceTokenSpan(record, range);
    const outputSpan = mappedOutputTokenSpan(entry, record.text, range);
    return {
      ordinal: index + 1,
      source_token_span: sourceSpan,
      output_token_span: outputSpan,
      source_sha256: sha256(inputBytes.subarray(sourceSpan.start, sourceSpan.end)),
      output_sha256: sha256(outputBytes.subarray(outputSpan.start, outputSpan.end)),
      alt_sha256: sha256(Buffer.from(image.alt, "utf8")),
      url_sha256: sha256(Buffer.from(image.url, "utf8"))
    };
  });

  const hardBreaks = [];
  for (const entry of finalEntries) {
    const record = recordsByLine.get(entry.sourceLine);
    if (
      !/\S/u.test(record.text) ||
      !record.text.endsWith("  ") ||
      !entry.text.endsWith("  ")
    ) continue;
    const range = [record.text.length - 2, record.text.length];
    hardBreaks.push({
      source_line: record.sourceLine,
      source_span: sourceTokenSpan(record, range),
      output_span: mappedOutputTokenSpan(entry, record.text, range),
      preserved: true
    });
  }

  const sourceLinkEntry = entriesByLine.get(8);
  const bodyOutputSpan = {
    start: sourceLinkEntry.outputEnd,
    end: outputBytes.length
  };
  const bodyTextParts = [];
  let bodyCursor = bodyOutputSpan.start;
  for (const imageSpan of imageSpans) {
    bodyTextParts.push(outputBytes.subarray(bodyCursor, imageSpan.output_token_span.start));
    bodyCursor = imageSpan.output_token_span.end;
  }
  bodyTextParts.push(outputBytes.subarray(bodyCursor, bodyOutputSpan.end));
  const bodyText = UTF8_DECODER.decode(Buffer.concat(bodyTextParts));
  const bodyNonWhitespaceCodePoints = [...bodyText].reduce(
    (count, codePoint) => count + (/\s/u.test(codePoint) ? 0 : 1),
    0
  );

  return {
    source_byte_length: inputBytes.length,
    output_byte_length: outputBytes.length,
    retained_spans: retainedSpans,
    metadata_spans: metadataSpans,
    image_spans: imageSpans,
    hard_breaks: hardBreaks,
    body_output_span: bodyOutputSpan,
    ordered_body_images_preserved: true,
    body_non_whitespace_code_points: bodyNonWhitespaceCodePoints
  };
}

function postcheck(records, finalEntries, deletedLines, envelope, originalBodyImages) {
  const bySourceLine = new Map(finalEntries.map((entry) => [entry.sourceLine, entry.text]));
  if (
    bySourceLine.get(3) !== records[2].text ||
    bySourceLine.get(4) !== records[3].text ||
    bySourceLine.get(6) !== records[5].text ||
    bySourceLine.get(8) !== records[7].text
  ) {
    return false;
  }

  for (const record of records) {
    if (deletedLines.has(record.sourceLine) || /^[ \t\u00a0]*$/.test(record.text)) continue;
    const retained = bySourceLine.get(record.sourceLine);
    if (retained === undefined) return false;
    if (retained !== record.text.replaceAll("\u00a0", " ")) return false;
    if (record.text.endsWith("  ") && !retained.endsWith("  ")) return false;
  }

  const finalBodyEntries = finalEntries.filter(
    ({ sourceLine }) => sourceLine >= 9 && sourceLine < envelope.footer.startLine
  );
  const finalBodyImages = extractImages(finalBodyEntries);
  return originalBodyImages.length === finalBodyImages.length && originalBodyImages.every(
    (image, index) => image.token === finalBodyImages[index].token
  );
}

export function cleanWechatExport(rawBytes, { fingerprints, confirmedRemovals, inputMode } = {}) {
  if (!Buffer.isBuffer(rawBytes) && !(rawBytes instanceof Uint8Array)) {
    throw new TypeError("rawBytes must be a Buffer or Uint8Array");
  }
  const inputBytes = Buffer.from(rawBytes);

  let raw;
  try {
    raw = UTF8_DECODER.decode(inputBytes);
  } catch {
    return noOp(inputBytes, null, "WECHAT_UTF8_INVALID");
  }

  if (inputMode !== "verified_baseline" && inputMode !== "incremental") {
    return noOp(inputBytes, raw, "WECHAT_INPUT_MODE_INVALID");
  }
  if (!isValidFingerprints(fingerprints) || !isValidConfirmedRemovals(confirmedRemovals)) {
    return noOp(inputBytes, raw, "WECHAT_CONFIG_INVALID");
  }
  if (raw.includes("\r")) {
    return noOp(inputBytes, raw, "WECHAT_LINE_ENDINGS_UNSUPPORTED");
  }

  const hasEofLf = raw.endsWith("\n");
  if (!hasEofLf && inputMode === "incremental") {
    return noOp(inputBytes, raw, "WECHAT_EOF_NEWLINE_REQUIRED");
  }
  const rawWithoutEof = hasEofLf ? raw.slice(0, -1) : raw;
  const lines = rawWithoutEof.split("\n");
  let sourceOffset = 0;
  const records = lines.map((text, index) => {
    const hasLf = index < lines.length - 1 || hasEofLf;
    const sourceStart = sourceOffset;
    const sourceEnd = sourceStart + Buffer.byteLength(text, "utf8") + (hasLf ? 1 : 0);
    sourceOffset = sourceEnd;
    return {
      text,
      sourceLine: index + 1,
      hasLf,
      sourceStart,
      sourceEnd
    };
  });

  const envelope = validateEnvelope(lines, fingerprints);
  if (!envelope) return noOp(inputBytes, raw, "WECHAT_FINGERPRINT_MISMATCH");

  const bodyStartLine = 9;
  const bodyEndLine = envelope.footer.startLine - 1;
  const originalBodyImages = extractImages(
    records.filter(({ sourceLine }) => sourceLine >= bodyStartLine && sourceLine <= bodyEndLine)
  );
  const bodyDeletes = plannedBodyDeletes(
    records,
    bodyStartLine,
    bodyEndLine,
    envelope.metadata.sourceUrl,
    confirmedRemovals
  );
  if (bodyDeletes.ambiguous) {
    return noOp(inputBytes, raw, "WECHAT_CONFIRMED_REMOVAL_AMBIGUOUS");
  }

  const footerSourceLines = Array.from(
    { length: envelope.footer.endLine - envelope.footer.startLine + 1 },
    (_, index) => envelope.footer.startLine + index
  );
  const deletedLines = new Set([1, 2, ...footerSourceLines, ...bodyDeletes.deletes.keys()]);
  const changes = [change(
    envelope.footer.name === "square"
      ? "WECHAT_FOOTER_SQUARE_V1"
      : "WECHAT_FOOTER_COGNITION_V1",
    "delete",
    footerSourceLines,
    sourceSlices(records, footerSourceLines)
  )];

  for (const sourceLine of [...bodyDeletes.deletes.keys()].sort((left, right) => right - left)) {
    changes.push(change(
      bodyDeletes.deletes.get(sourceLine),
      "delete",
      [sourceLine],
      physicalLineSlice(records, sourceLine)
    ));
  }
  changes.push(change(
    "WECHAT_HEADER_V1",
    "delete",
    [1, 2],
    sourceSlices(records, [1, 2])
  ));

  const normalized = normalizeRetained(records, deletedLines);
  changes.push(...normalized.changes);
  const finalEntries = addOutputOffsets(normalized.entries);
  const cleanedMarkdown = finalEntries.map(({ text }) => text).join("\n") + "\n";
  if (!hasEofLf) {
    changes.push(change("EOF_NEWLINE_V1", "append_eof", null, Buffer.alloc(0), LF_BYTES));
  }

  if (!postcheck(records, finalEntries, deletedLines, envelope, originalBodyImages)) {
    return noOp(inputBytes, raw, "WECHAT_POSTCHECK_FAILED");
  }

  const outputBytes = Buffer.from(cleanedMarkdown, "utf8");
  const audit = buildAudit({
    inputBytes,
    outputBytes,
    records,
    finalEntries,
    envelope,
    originalBodyImages
  });

  return {
    status: "cleaned",
    outputBytes,
    cleanedMarkdown,
    metadata: envelope.metadata,
    bodyImages: originalBodyImages.map(({ alt, url }, index) => ({ ordinal: index + 1, alt, url })),
    changes,
    warnings: [],
    audit
  };
}
