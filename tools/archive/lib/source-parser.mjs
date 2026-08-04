import { assertWechatSourceUrl, canonicalizeHttpUrl } from "./url-canonicalizer.mjs";

const EMPTY_METADATA = Object.freeze({
  title: null,
  author: null,
  originalStatus: null,
  publishedAt: null,
  location: null,
  sourceUrl: null
});

function metadataFromLines(lines) {
  const metadata = { ...EMPTY_METADATA };
  const titleLine = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  const setextTitleIndex = lines.findIndex((line, index) => index > 0 && /^\s*=+\s*$/.test(line) && lines[index - 1].trim().length > 0);
  if (titleLine) metadata.title = titleLine.replace(/^#{1,6}\s+/, "").trim();
  else if (setextTitleIndex !== -1) metadata.title = lines[setextTitleIndex - 1].trim();

  const authorLine = lines.find((line) => /^作者[：:]\s*\S/.test(line));
  if (authorLine) {
    const parts = authorLine.replace(/^作者[：:]\s*/, "").split(/\s*[｜·]\s*/).map((part) => part.trim());
    [metadata.author, metadata.originalStatus, metadata.publishedAt, metadata.location] = parts.map((part) => part || null);
  }

  const sourceLine = lines.find((line) => /^(?:原文地址|原文链接|来源链接|来源地址)[：:]\s*\S/.test(line));
  if (sourceLine) {
    const sourceValue = sourceLine.replace(/^(?:原文地址|原文链接|来源链接|来源地址)[：:]\s*/, "").trim();
    const rawUrl = sourceValue.match(/\]\((https?:[^\s)]+)\)/)?.[1] ?? sourceValue;
    try {
      const sourceUrl = canonicalizeHttpUrl(rawUrl);
      assertWechatSourceUrl(sourceUrl);
      metadata.sourceUrl = sourceUrl;
    } catch {
      metadata.sourceUrl = null;
    }
  }
  return metadata;
}

function bodyImagesFromRaw(raw) {
  const images = [];
  const matcher = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const match of raw.matchAll(matcher)) {
    images.push({ ordinal: images.length + 1, alt: match[1], url: match[2] });
  }
  return images;
}

export function parseWechatMetadata(raw) {
  if (typeof raw !== "string") throw new TypeError("raw must be a string");
  const metadata = metadataFromLines(raw.split(/\r?\n/));
  const bodyImages = bodyImagesFromRaw(raw);
  const status = Object.values(metadata).every((value) => value !== null) ? "cleaned" : "needs_review";
  return { status, metadata, bodyImages };
}
