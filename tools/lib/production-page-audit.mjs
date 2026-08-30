import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_SITE_URL,
  fetchUrl,
  verifyProductionSite,
} from "../verify-production.mjs";
import { auditSecurityHeaders } from "./site-security.mjs";

const ATTRIBUTE_PATTERN =
  /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const TAG_PATTERN = /<([a-zA-Z][\w:-]*)\b([^<>]*)>/gu;
const FORBIDDEN_EMBEDDED_ELEMENTS = new Set([
  "applet",
  "embed",
  "iframe",
  "object",
]);

function issue(code, message) {
  return `${code}: ${message}`;
}

function decodeHtmlEntities(value) {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|quot|apos|lt|gt);/giu,
    (match, decimal, hexadecimal) => {
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return ({
        "&amp;": "&",
        "&apos;": "'",
        "&gt;": ">",
        "&lt;": "<",
        "&quot;": '"',
      })[match.toLowerCase()] ?? match;
    },
  );
}

function parseAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(
        name,
        decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ""),
      );
    }
  }
  return attributes;
}

function openTags(markup) {
  const withoutComments = markup.replace(/<!--[\s\S]*?-->/gu, "");
  const withoutRawText = withoutComments.replace(
    /<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>/giu,
    "<$1$2></$1>",
  );
  return [...withoutRawText.matchAll(TAG_PATTERN)].map((match) => ({
    attributes: parseAttributes(match[2]),
    name: match[1].toLowerCase(),
  }));
}

function nonEmptyElementText(markup, name) {
  const matches = [...markup.matchAll(
    new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, "giu"),
  )];
  return matches.map((match) => decodeHtmlEntities(
    match[1].replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim(),
  ));
}

function expectedPageUrl(targetUrl, relativePath) {
  const baseUrl = new URL(targetUrl);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  if (relativePath === "index.html") return baseUrl.href;
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (relativePath.endsWith("/index.html")) {
    return new URL(encodedPath.slice(0, -"index.html".length), baseUrl).href;
  }
  return new URL(encodedPath, baseUrl).href;
}

function hasToken(attributes, attribute, token) {
  return (attributes.get(attribute) ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .includes(token);
}

function positiveIntegerAttribute(attributes, name) {
  return /^[1-9]\d*$/u.test(attributes.get(name) ?? "");
}

/**
 * Audit one generated HTML document for the semantic and interaction contract
 * that byte parity alone cannot prove.
 */
export function auditPageMarkup({ html, relativePath, targetUrl }) {
  if (typeof html !== "string") throw new TypeError("html must be a string");
  if (typeof relativePath !== "string" || !relativePath.endsWith(".html")) {
    throw new TypeError("relativePath must identify an HTML file");
  }

  const errors = [];
  const tags = openTags(html);
  const byName = (name) => tags.filter((tag) => tag.name === name);
  const htmlTags = byName("html");
  const titleTexts = nonEmptyElementText(html, "title");
  const h1Texts = nonEmptyElementText(html, "h1");
  const mains = byName("main");

  if (!/^\s*<!doctype\s+html\b/iu.test(html)) {
    errors.push(issue("DOCTYPE_MISSING", relativePath));
  }
  if (htmlTags.length !== 1 || htmlTags[0].attributes.get("lang") !== "zh-CN") {
    errors.push(issue("DOCUMENT_LANGUAGE_MISMATCH", `${relativePath} must use one html[lang=zh-CN]`));
  }
  if (titleTexts.length !== 1 || !titleTexts[0]) {
    errors.push(issue("MISSING_TITLE", `${relativePath} must have one non-empty title`));
  }
  if (mains.length !== 1 || mains[0].attributes.get("id") !== "main-content") {
    errors.push(issue("MAIN_COUNT_MISMATCH", `${relativePath} must have one main#main-content`));
  }
  if (h1Texts.length !== 1 || !h1Texts[0]) {
    errors.push(issue("H1_COUNT_MISMATCH", `${relativePath} must have one non-empty h1`));
  }
  for (const [landmark, className] of [
    ["header", "site-header"],
    ["nav", "primary-nav"],
    ["footer", "site-footer"],
  ]) {
    if (byName(landmark).filter((tag) => hasToken(tag.attributes, "class", className)).length !== 1) {
      errors.push(issue("LANDMARK_COUNT_MISMATCH", `${relativePath} must have one ${landmark}.${className}`));
    }
  }

  const metas = byName("meta");
  if (!metas.some((tag) => tag.attributes.get("charset")?.toLowerCase() === "utf-8")) {
    errors.push(issue("CHARSET_MISSING", `${relativePath} must declare utf-8`));
  }
  if (!metas.some((tag) =>
    tag.attributes.get("name")?.toLowerCase() === "viewport" &&
    tag.attributes.get("content") === "width=device-width, initial-scale=1")) {
    errors.push(issue("VIEWPORT_MISSING", relativePath));
  }
  if (!metas.some((tag) =>
    tag.attributes.get("name")?.toLowerCase() === "description" &&
    (tag.attributes.get("content") ?? "").trim())) {
    errors.push(issue("DESCRIPTION_MISSING", relativePath));
  }

  const expectedUrl = expectedPageUrl(targetUrl, relativePath);
  const canonicalUrls = byName("link")
    .filter((tag) => hasToken(tag.attributes, "rel", "canonical"))
    .map((tag) => tag.attributes.get("href"));
  if (canonicalUrls.length !== 1 || canonicalUrls[0] !== expectedUrl) {
    errors.push(issue(
      "CANONICAL_URL_MISMATCH",
      `${relativePath} expected ${expectedUrl}, got ${canonicalUrls.join(", ") || "<missing>"}`,
    ));
  }
  const openGraphUrls = metas
    .filter((tag) => tag.attributes.get("property")?.toLowerCase() === "og:url")
    .map((tag) => tag.attributes.get("content"));
  if (openGraphUrls.length !== 1 || openGraphUrls[0] !== expectedUrl) {
    errors.push(issue("OPEN_GRAPH_URL_MISMATCH", `${relativePath} expected ${expectedUrl}`));
  }

  const skipLinks = byName("a").filter((tag) =>
    hasToken(tag.attributes, "class", "skip-link") &&
    tag.attributes.get("href") === "#main-content");
  if (skipLinks.length !== 1) {
    errors.push(issue("MISSING_SKIP_LINK", `${relativePath} must link to #main-content`));
  }

  const labelledControlIds = new Set(
    byName("label")
      .map((tag) => tag.attributes.get("for"))
      .filter(Boolean),
  );
  for (const tag of tags) {
    for (const attribute of tag.attributes.keys()) {
      if (/^on[a-z]+$/u.test(attribute)) {
        errors.push(issue("INLINE_EVENT_HANDLER", `${relativePath} <${tag.name}> ${attribute}`));
      }
    }
    if (FORBIDDEN_EMBEDDED_ELEMENTS.has(tag.name)) {
      errors.push(issue("UNSAFE_EMBEDDED_ELEMENT", `${relativePath} <${tag.name}>`));
    }
    if (tag.name === "img") {
      if (!tag.attributes.has("alt")) {
        errors.push(issue("IMAGE_ALT_MISSING", `${relativePath} ${tag.attributes.get("src") ?? "<unknown>"}`));
      }
      if (!positiveIntegerAttribute(tag.attributes, "width") ||
          !positiveIntegerAttribute(tag.attributes, "height")) {
        errors.push(issue("IMAGE_DIMENSIONS_MISSING", `${relativePath} ${tag.attributes.get("src") ?? "<unknown>"}`));
      }
    }
    if (tag.name === "button" &&
        !new Set(["button", "reset", "submit"]).has(tag.attributes.get("type")?.toLowerCase())) {
      errors.push(issue("BUTTON_TYPE_MISSING", relativePath));
    }
    if (["input", "select", "textarea"].includes(tag.name) &&
        tag.attributes.get("type")?.toLowerCase() !== "hidden") {
      const controlId = tag.attributes.get("id");
      const hasName = Boolean(
        (tag.attributes.get("aria-label") ?? "").trim() ||
        (tag.attributes.get("aria-labelledby") ?? "").trim() ||
        (controlId && labelledControlIds.has(controlId)),
      );
      if (!hasName) errors.push(issue("CONTROL_NAME_MISSING", `${relativePath} <${tag.name}>`));
    }
    if (tag.name === "a" && tag.attributes.get("target")?.toLowerCase() === "_blank") {
      if (!hasToken(tag.attributes, "rel", "noopener") ||
          !hasToken(tag.attributes, "rel", "noreferrer")) {
        errors.push(issue("BLANK_TARGET_REL_MISSING", relativePath));
      }
    }
  }

  return [...new Set(errors)].sort((left, right) => left.localeCompare(right, "en"));
}

export function classifyPage(relativePath) {
  if (relativePath === "index.html") return "root";
  if (relativePath === "404.html") return "error";
  if (relativePath === "router.html") return "router";
  if (/^chapters\/ch\d{2}-[a-z0-9-]+\.html$/u.test(relativePath)) return "chapters";
  if (relativePath === "combinations/index.html") return "combinations-index";
  if (/^combinations\/[a-z0-9-]+\.html$/u.test(relativePath)) return "combinations-detail";
  if (relativePath === "models/index.html") return "models-index";
  if (/^models\/[a-z0-9-]+\.html$/u.test(relativePath)) return "models-detail";
  return "unknown";
}

function tagsWithAttribute(tags, attribute) {
  return tags.filter((tag) => tag.attributes.has(attribute));
}

function tagsWithClass(tags, className) {
  return tags.filter((tag) => hasToken(tag.attributes, "class", className));
}

/** Audit the load-bearing DOM contract for each known generated page family. */
export function auditPageFamilyMarkup({ html, relativePath }) {
  const errors = [];
  const tags = openTags(html);
  const type = classifyPage(relativePath);
  const bodies = tags.filter((tag) => tag.name === "body");
  const scripts = tags.filter((tag) => tag.name === "script");
  const ids = new Set(tags.map((tag) => tag.attributes.get("id")).filter(Boolean));
  const requireBodyClass = (className) => {
    if (bodies.length !== 1 || !hasToken(bodies[0].attributes, "class", className)) {
      errors.push(issue("PAGE_FAMILY_BODY_MISMATCH", `${relativePath} expected body.${className}`));
    }
  };

  if (type === "unknown") {
    return [issue("UNKNOWN_PAGE_FAMILY", relativePath)];
  }
  if (type === "root") {
    requireBodyClass("home-page");
    if (tagsWithClass(tags, "chapter-card").length !== 13) {
      errors.push(issue("HOME_CHAPTER_COUNT_MISMATCH", relativePath));
    }
    if (tagsWithAttribute(tags, "data-home-combination").length !== 5) {
      errors.push(issue("HOME_COMBINATION_COUNT_MISMATCH", relativePath));
    }
  } else if (type === "error") {
    requireBodyClass("error-page");
    const recoveryPaths = new Set(
      tags
        .filter((tag) => tag.name === "a")
        .map((tag) => tag.attributes.get("href")),
    );
    for (const expected of ["/", "/models/", "/combinations/", "/router.html"]) {
      if (!recoveryPaths.has(expected)) {
        errors.push(issue("ERROR_RECOVERY_LINK_MISSING", `${relativePath} ${expected}`));
      }
    }
  } else if (type === "router") {
    requireBodyClass("router-page");
    const requiredMarkers = [
      "data-router-form",
      "data-router-results",
      "data-router-clarify",
      "data-router-safety",
      "data-router-unavailable",
      "data-router-payload",
    ];
    for (const marker of requiredMarkers) {
      if (tagsWithAttribute(tags, marker).length !== 1) {
        errors.push(issue("ROUTER_CONTRACT_MISSING", `${relativePath} ${marker}`));
      }
    }
    const controllerScripts = scripts.filter((tag) =>
      tag.attributes.get("type") === "module" &&
      tag.attributes.get("src") === "assets/router-controller.mjs");
    if (controllerScripts.length !== 1) {
      errors.push(issue("ROUTER_MODULE_MISSING", relativePath));
    }
    if (tagsWithAttribute(tags, "data-route-key").length !== 23) {
      errors.push(issue("ROUTER_ROUTE_COUNT_MISMATCH", relativePath));
    }
  } else if (type === "chapters") {
    requireBodyClass("chapter-page");
    if (bodies.length !== 1 || !/^\d{2}$/u.test(bodies[0].attributes.get("data-chapter") ?? "")) {
      errors.push(issue("CHAPTER_ID_MISSING", relativePath));
    }
    if (tagsWithClass(tags, "mentor-portrait").length < 1) {
      errors.push(issue("CHAPTER_MENTOR_MISSING", relativePath));
    }
    if (tagsWithAttribute(tags, "data-filter-input").length !== 1 ||
        tagsWithAttribute(tags, "data-filter-list").length !== 1 ||
        tagsWithAttribute(tags, "data-filter-item").length < 1) {
      errors.push(issue("CHAPTER_FILTER_CONTRACT_MISSING", relativePath));
    }
  } else if (type === "models-index") {
    requireBodyClass("library-page");
    if (tagsWithAttribute(tags, "data-filter-input").length !== 1 ||
        tagsWithAttribute(tags, "data-filter-list").length !== 1 ||
        tagsWithAttribute(tags, "data-filter-item").length < 1) {
      errors.push(issue("MODEL_INDEX_FILTER_CONTRACT_MISSING", relativePath));
    }
  } else if (type === "models-detail") {
    requireBodyClass("model-page");
    if (tagsWithClass(tags, "model-detail").length !== 1 ||
        tagsWithClass(tags, "model-pager").length !== 1) {
      errors.push(issue("MODEL_DETAIL_CONTRACT_MISSING", relativePath));
    }
    const copyTargets = tagsWithAttribute(tags, "data-copy-target")
      .map((tag) => tag.attributes.get("data-copy-target"));
    if (copyTargets.length !== 1 || !ids.has(copyTargets[0])) {
      errors.push(issue("MODEL_COPY_TARGET_MISMATCH", relativePath));
    }
  } else if (type === "combinations-index") {
    requireBodyClass("combination-index-page");
    if (tagsWithAttribute(tags, "data-combination-card").length !== 5) {
      errors.push(issue("COMBINATION_CARD_COUNT_MISMATCH", relativePath));
    }
  } else if (type === "combinations-detail") {
    requireBodyClass("combination-detail-page");
    if (tagsWithAttribute(tags, "data-combination-id").length !== 1) {
      errors.push(issue("COMBINATION_ID_MISSING", relativePath));
    }
    const sectionOrder = tagsWithAttribute(tags, "data-combination-section")
      .map((tag) => tag.attributes.get("data-combination-section"));
    const expectedOrder = [
      "definition", "applicability", "limits", "input", "phases", "loops",
      "alternatives", "prompt", "evidence",
    ];
    if (sectionOrder.join("\0") !== expectedOrder.join("\0")) {
      errors.push(issue("COMBINATION_SECTION_ORDER_MISMATCH", relativePath));
    }
    const phases = tagsWithAttribute(tags, "data-phase-id");
    if (phases.length < 1 || phases.some((tag, index) =>
      tag.attributes.get("data-phase-order") !== String(index + 1))) {
      errors.push(issue("COMBINATION_PHASE_ORDER_MISMATCH", relativePath));
    }
    const prompts = tags
      .filter((tag) => tag.name === "pre")
      .filter((tag) => tag.attributes.get("id")?.startsWith("combination-prompt-"));
    if (prompts.length !== 1) {
      errors.push(issue("COMBINATION_PROMPT_MISSING", relativePath));
    }
  }

  return [...new Set(errors)].sort((left, right) => left.localeCompare(right, "en"));
}

export function auditNotFoundResponse({ expectedBody, expectedUrl, response }) {
  const errors = [];
  if (response.status !== 404) {
    errors.push(issue("NOT_FOUND_STATUS_MISMATCH", `expected 404, got ${response.status}`));
  }
  if (response.finalUrl !== expectedUrl) {
    errors.push(issue("NOT_FOUND_REDIRECT", `${expectedUrl} -> ${response.finalUrl}`));
  }
  if (response.contentType.split(";", 1)[0].trim().toLowerCase() !== "text/html") {
    errors.push(issue("NOT_FOUND_CONTENT_TYPE_MISMATCH", response.contentType || "<missing>"));
  }
  if (!Buffer.isBuffer(response.body) || !expectedBody.equals(response.body)) {
    errors.push(issue("NOT_FOUND_BODY_MISMATCH", expectedUrl));
  }
  if (!Array.isArray(response.rawHeaders)) {
    errors.push(issue("NOT_FOUND_HEADERS_MISSING", expectedUrl));
  } else {
    errors.push(...auditSecurityHeaders(response.rawHeaders));
  }
  return errors;
}

/**
 * Verify the complete public artifact, then add page-by-page headers and HTML
 * semantics over the exact remote bytes returned by the production origin.
 */
export async function auditProductionPages(options = {}) {
  const targetUrl = options.targetUrl ?? DEFAULT_SITE_URL;
  const verification = await verifyProductionSite({ ...options, targetUrl });
  const errors = [...verification.errors];
  const pageTypes = {};
  let checkedPages = 0;

  for (const result of verification.results) {
    if (!result.relativePath.endsWith(".html") || !result.response) continue;
    checkedPages += 1;
    const type = classifyPage(result.relativePath);
    pageTypes[type] = (pageTypes[type] ?? 0) + 1;

    const rawHeaders = result.response.rawHeaders;
    if (!Array.isArray(rawHeaders)) {
      errors.push(`${result.relativePath}: RESPONSE_HEADERS_MISSING`);
    } else {
      for (const headerError of auditSecurityHeaders(rawHeaders)) {
        errors.push(`${result.relativePath}: ${headerError}`);
      }
    }
    let html;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(result.response.body);
    } catch (decodeError) {
      errors.push(`${result.relativePath}: INVALID_HTML_ENCODING: ${decodeError.message}`);
      continue;
    }
    for (const pageError of auditPageMarkup({
      html,
      relativePath: result.relativePath,
      targetUrl,
    })) {
      errors.push(`${result.relativePath}: ${pageError}`);
    }
    for (const familyError of auditPageFamilyMarkup({
      html,
      relativePath: result.relativePath,
    })) {
      errors.push(`${result.relativePath}: ${familyError}`);
    }
  }

  if (verification.errors.length === 0 && options.probeNotFound !== false) {
    const baseUrl = new URL(targetUrl);
    if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
    const notFoundUrl = new URL("__production-audit-not-found__.html", baseUrl).href;
    try {
      const expectedBody = await readFile(path.join(options.siteDir ?? "site", "404.html"));
      const response = await (options.fetcher ?? fetchUrl)(notFoundUrl, {
        maxBytes: Math.max(expectedBody.length + 1, 1024 * 1024),
      });
      for (const notFoundError of auditNotFoundResponse({
        expectedBody,
        expectedUrl: notFoundUrl,
        response,
      })) {
        errors.push(`404-probe: ${notFoundError}`);
      }
    } catch (notFoundError) {
      errors.push(`404-probe: NOT_FOUND_PROBE_FAILED: ${notFoundError.message}`);
    }
  }

  return {
    checkedFiles: verification.checkedFiles,
    checkedPages,
    errors: [...new Set(errors)].sort((left, right) => left.localeCompare(right, "en")),
    pageTypes: Object.fromEntries(
      Object.entries(pageTypes).sort(([left], [right]) => left.localeCompare(right, "en")),
    ),
  };
}
