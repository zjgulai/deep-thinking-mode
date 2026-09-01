const OPEN_TAG_PATTERN = /<[a-zA-Z][\w:-]*\b[^<>]*>/gu;
const ATTRIBUTE_PATTERN =
  /\s+([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

const REQUIRED_MARKERS = [
  "data-library-input", "data-filter-input", "data-library-list", "data-filter-list",
  "data-library-count", "data-filter-count", "data-filter-empty", "data-library-fallback",
  "data-library-pager", "data-library-previous", "data-library-next", "data-library-range",
  "data-library-page-number", "data-library-page-count", "data-library-print-range",
  "data-library-live",
];

const ALIAS_PAIRS = [
  ["data-library-input", "data-filter-input"],
  ["data-library-list", "data-filter-list"],
  ["data-library-count", "data-filter-count"],
];
const MODEL_URL_PATTERN = /^[a-z0-9][a-z0-9-]*-[a-f0-9]{12}\.html$/u;

function issue(code, message) {
  return `${code}: ${message}`;
}

function maskComments(markup) {
  return markup.replace(/<!--[\s\S]*?-->/gu, (comment) => " ".repeat(comment.length));
}

function commentsAreBalanced(markup) {
  let cursor = 0;
  while (cursor < markup.length) {
    const opening = markup.indexOf("<!--", cursor);
    const closing = markup.indexOf("-->", cursor);
    if (closing !== -1 && (opening === -1 || closing < opening)) return false;
    if (opening === -1) return true;
    const end = markup.indexOf("-->", opening + 4);
    const nested = markup.indexOf("<!--", opening + 4);
    if (end === -1 || (nested !== -1 && nested < end)) return false;
    cursor = end + 3;
  }
  return true;
}

function attributeEntries(raw) {
  return [...raw.matchAll(ATTRIBUTE_PATTERN)].map((match) => ({
    name: match[1].toLowerCase(),
    value: match[2] ?? match[3] ?? match[4] ?? "",
  }));
}

function parseOpeningTag(raw, index) {
  return {
    attributes: attributeEntries(raw),
    index,
    name: raw.match(/^<([a-zA-Z][\w:-]*)/u)?.[1].toLowerCase() ?? "",
    raw,
  };
}

function openTags(markup) {
  const masked = maskComments(markup).replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
    (rawText) => {
      const opening = rawText.slice(0, rawText.indexOf(">") + 1);
      return opening + " ".repeat(rawText.length - opening.length);
    },
  );
  return [...masked.matchAll(OPEN_TAG_PATTERN)]
    .map((match) => parseOpeningTag(match[0], match.index));
}

function markerCount(markup, marker) {
  return openTags(markup)
    .reduce((count, tag) => count + tag.attributes.filter(({ name }) => name === marker).length, 0);
}

function tagHasMarker(tag, marker) {
  return tag.attributes.some(({ name }) => name === marker);
}

function attributeValue(tag, name) {
  return tag?.attributes.find((attribute) => attribute.name === name)?.value;
}

function tagHasClass(tag, token) {
  return (attributeValue(tag, "class") ?? "").split(/\s+/u).includes(token);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isModelRecord(model) {
  return model !== null && typeof model === "object" &&
    typeof model.name === "string" && typeof model.url === "string" && MODEL_URL_PATTERN.test(model.url) &&
    typeof model.skill_name === "string" && Number.isInteger(model.steps) && model.steps >= 0 &&
    typeof model.core === "string" && isStringArray(model.tags) &&
    isStringArray(model.triggers) && isStringArray(model.role_ids);
}

function isModelLibraryPayload(payload) {
  const roleLabels = payload?.role_labels;
  return payload?.schema === "model-library.v1" && payload?.page_size === 48 &&
    payload?.search_render_limit === 250 && roleLabels !== null && typeof roleLabels === "object" &&
    !Array.isArray(roleLabels) && Object.values(roleLabels).every((label) => typeof label === "string") &&
    Array.isArray(payload.models) && payload.models.length === 2789 && payload.models.every(isModelRecord);
}

function elementMarkupByMarker(markup, tagName, marker) {
  const openings = openTags(markup)
    .filter((tag) => tag.name === tagName && tagHasMarker(tag, marker));
  if (openings.length !== 1) return "";
  const opening = openings[0];
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "giu");
  tagPattern.lastIndex = opening.index;
  const masked = maskComments(markup);
  let depth = 0;
  for (const match of masked.matchAll(tagPattern)) {
    const isClosing = match[0].startsWith("</");
    const isSelfClosing = /\/>$/u.test(match[0]);
    depth += isClosing ? -1 : isSelfClosing ? 0 : 1;
    if (depth === 0) return markup.slice(opening.index, match.index + match[0].length);
  }
  return "";
}

function directChildTags(markup) {
  const withoutRawText = maskComments(markup).replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
    (rawText) => " ".repeat(rawText.length),
  );
  const tokens = [...withoutRawText.matchAll(/<(\/)?([a-zA-Z][\w:-]*)\b[^<>]*>/gu)];
  const children = [];
  let depth = 0;
  for (const token of tokens) {
    const name = token[2].toLowerCase();
    if (token[1]) {
      depth -= 1;
      continue;
    }
    if (depth === 1) children.push(parseOpeningTag(token[0], token.index));
    if (!VOID_ELEMENTS.has(name) && !/\/>$/u.test(token[0])) depth += 1;
  }
  return depth === 0 ? children : [];
}

function tagMatches(tag, { name, values = {}, present = [] }) {
  return tag?.name === name &&
    Object.entries(values).every(([attribute, value]) => attributeValue(tag, attribute) === value) &&
    present.every((attribute) => tagHasMarker(tag, attribute));
}

export function auditModelLibraryMarkup({ html, relativePath }) {
  const errors = [];
  const rootTags = openTags(html).filter((tag) => tagHasMarker(tag, "data-model-library"));
  const libraryMarkup = elementMarkupByMarker(html, "section", "data-model-library");
  const libraryTags = openTags(libraryMarkup);
  const listMarkup = elementMarkupByMarker(libraryMarkup, "div", "data-library-list");

  if (!commentsAreBalanced(html) || rootTags.length !== 1 || rootTags[0].name !== "section" ||
      !tagHasClass(rootTags[0], "library-layout") || !libraryMarkup ||
      markerCount(html, "data-model-library") !== 1) {
    errors.push(issue("MODEL_INDEX_LIBRARY_ROOT_INVALID", relativePath));
  }
  for (const marker of REQUIRED_MARKERS) {
    if (markerCount(html, marker) !== 1 || markerCount(libraryMarkup, marker) !== 1) {
      errors.push(issue("MODEL_INDEX_LIBRARY_MARKER_INVALID", `${relativePath} ${marker}`));
    }
  }
  for (const pair of ALIAS_PAIRS) {
    if (libraryTags.filter((tag) => pair.every((marker) => tagHasMarker(tag, marker))).length !== 1) {
      errors.push(issue("MODEL_INDEX_LIBRARY_ALIAS_MISMATCH", `${relativePath} ${pair.join("+")}`));
    }
  }

  const elementContracts = [
    ["data-library-input", { name: "input", values: { id: "model-filter", type: "search", maxlength: "80", "aria-controls": "model-library-list" } }],
    ["data-library-list", { name: "div", values: { id: "model-library-list", role: "region", tabindex: "-1", "aria-label": "模型搜索结果" } }],
    ["data-library-count", { name: "strong" }],
    ["data-filter-empty", { name: "p", present: ["hidden"] }],
    ["data-library-fallback", { name: "p", present: ["hidden"] }],
    ["data-library-pager", { name: "nav", values: { "aria-label": "模型库分页" }, present: ["hidden"] }],
    ["data-library-previous", { name: "button", values: { type: "button", "aria-controls": "model-library-list" } }],
    ["data-library-next", { name: "button", values: { type: "button", "aria-controls": "model-library-list" } }],
    ["data-library-range", { name: "span" }],
    ["data-library-page-number", { name: "strong" }],
    ["data-library-page-count", { name: "strong" }],
    ["data-library-print-range", { name: "span" }],
    ["data-library-live", { name: "p", values: { role: "status", "aria-live": "polite", "aria-atomic": "true" } }],
  ];
  for (const [marker, contract] of elementContracts) {
    const matches = libraryTags.filter((tag) => tagHasMarker(tag, marker));
    if (matches.length !== 1 || !tagMatches(matches[0], contract)) {
      errors.push(issue("MODEL_INDEX_LIBRARY_ELEMENT_INVALID", `${relativePath} ${marker}`));
    }
  }

  const payloadTags = openTags(html).filter((tag) => tagHasMarker(tag, "data-model-library-payload"));
  const scopedPayloadTags = libraryTags.filter((tag) => tagHasMarker(tag, "data-model-library-payload"));
  const payloadMarkup = elementMarkupByMarker(libraryMarkup, "script", "data-model-library-payload");
  if (markerCount(html, "data-model-library-payload") !== 1 ||
      markerCount(libraryMarkup, "data-model-library-payload") !== 1 ||
      payloadTags.length !== 1 || scopedPayloadTags.length !== 1 ||
      payloadTags[0].name !== "script" || attributeValue(payloadTags[0], "type") !== "application/json" ||
      !payloadMarkup) {
    errors.push(issue("MODEL_INDEX_LIBRARY_PAYLOAD_MARKER_INVALID", relativePath));
  }
  const payloadSource = payloadMarkup
    ? payloadMarkup.slice(payloadMarkup.indexOf(">") + 1, payloadMarkup.toLowerCase().lastIndexOf("</script"))
    : "";
  let payload = null;
  try { payload = JSON.parse(payloadSource);
  } catch { payload = null; }
  if (!isModelLibraryPayload(payload)) {
    errors.push(issue("MODEL_INDEX_LIBRARY_PAYLOAD_INVALID", relativePath));
  }
  const summaryCount = (markup) => openTags(markup)
    .filter((tag) => tag.name === "article" && tagHasClass(tag, "model-summary")).length;
  const directCards = directChildTags(listMarkup);
  if (summaryCount(libraryMarkup) !== 48 || directCards.length !== 48 ||
      !directCards.every((tag) => tag.name === "article" && tagHasClass(tag, "model-summary"))) {
    errors.push(issue("MODEL_INDEX_INITIAL_PAGE_COUNT_MISMATCH", relativePath));
  }
  if (markerCount(libraryMarkup, "data-filter-item") !== 0) {
    errors.push(issue("MODEL_INDEX_LEGACY_FILTER_ITEMS_PRESENT", relativePath));
  }
  return errors;
}
