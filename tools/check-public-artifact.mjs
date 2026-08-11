#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { META_CONTENT_SECURITY_POLICY } from "./lib/site-security.mjs";

const DEFAULT_SITE_DIR = "site";

export const PUBLIC_FILE_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".mjs",
  ".png",
  ".svg",
  ".txt",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
  ".xml",
]);

const PUBLIC_FILE_NAMES = new Set([".nojekyll"]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);
const NAVIGATION_ELEMENTS = new Set(["a", "area"]);
const SAFE_NAVIGATION_SCHEMES = new Set(["https:", "mailto:", "tel:"]);
const SCRIPT_NETWORK_PATTERN =
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(|\bnavigator\s*\.\s*sendBeacon\s*\(/i;
const STORAGE_IDENTIFIERS = new Set([
  "indexedDB",
  "localStorage",
  "sessionStorage",
]);
const BROWSER_GLOBAL_IDENTIFIERS = new Set(["globalThis", "self", "window"]);
const REGEX_AFTER_CONTROL_HEAD_IDENTIFIERS = new Set([
  "catch",
  "for",
  "if",
  "switch",
  "while",
  "with",
]);
const REGEX_PREFIX_IDENTIFIERS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const REGEX_PREFIX_PUNCTUATORS = new Set([
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "=",
  "!",
  "?",
  "=>",
  "+",
  "-",
  "*",
  "%",
  "&",
  "|",
  "^",
  "~",
  "<",
  ">",
]);
const REMOTE_URL_PATTERN = /(?:https?:)?\/\/[^\s"'<>`)}]+/i;
const ATTRIBUTE_PATTERN =
  /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const TAG_PATTERN = /<([a-zA-Z][\w:-]*)\b([^<>]*)>/g;

function error(code, message) {
  return `${code}: ${message}`;
}

function decodeHtmlEntities(value) {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|quot|apos|lt|gt);/gi,
    (match, decimal, hexadecimal) => {
      if (decimal) {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      }
      if (hexadecimal) {
        return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      }
      const named = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
      };
      return named[match.toLowerCase()] ?? match;
    },
  );
}

function parseAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!attributes.has(name)) {
      attributes.set(name, decodeHtmlEntities(value));
    }
  }
  return attributes;
}

function markupTags(markup) {
  const withoutComments = markup.replace(/<!--[\s\S]*?-->/g, "");
  const withoutRawText = withoutComments.replace(
    /<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi,
    "<$1$2></$1>",
  );
  return [...withoutRawText.matchAll(TAG_PATTERN)].map((match) => ({
    name: match[1].toLowerCase(),
    attributes: parseAttributes(match[2]),
  }));
}

function fileExtension(relativePath) {
  return path.posix.extname(relativePath).toLowerCase();
}

function isAllowedPublicFile(relativePath) {
  const name = path.posix.basename(relativePath);
  return PUBLIC_FILE_NAMES.has(name) || PUBLIC_FILE_EXTENSIONS.has(fileExtension(name));
}

function isSafePublicPath(relativePath) {
  if (/[\u0000-\u001f\u007f?#%\\]/.test(relativePath)) {
    return false;
  }
  const segments = relativePath.split("/");
  return segments.every(
    (segment) =>
      segment &&
      segment !== "." &&
      segment !== ".." &&
      (!segment.startsWith(".") || relativePath === ".nojekyll"),
  );
}

async function walkSite(siteDir) {
  const files = [];
  const errors = [];

  try {
    const rootStat = await lstat(siteDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      errors.push(
        error("UNSAFE_FILE_TYPE", `${siteDir} must be a real directory`),
      );
      return { files, errors };
    }
  } catch (rootError) {
    errors.push(error("SITE_MISSING", `${siteDir}: ${rootError.message}`));
    return { files, errors };
  }

  async function walk(absoluteDir, relativeDir) {
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (walkError) {
      errors.push(
        error(
          "SITE_READ_FAILED",
          `${absoluteDir}: ${walkError.message}`,
        ),
      );
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, entry.name)
        : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(
          error("UNSAFE_FILE_TYPE", `${relativePath} must not be a symbolic link`),
        );
      } else if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        errors.push(
          error("UNSAFE_FILE_TYPE", `${relativePath} is not a regular file`),
        );
      }
    }
  }

  await walk(siteDir, "");
  return { files, errors };
}

function decodeUrlPath(urlPath, sourceLabel, errors) {
  let decoded = urlPath;
  for (let depth = 0; depth < 3; depth += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      errors.push(error("INVALID_URL_ENCODING", `${sourceLabel}: ${urlPath}`));
      return null;
    }
    if (/[\u0000-\u001f\u007f\\]/.test(next)) {
      errors.push(error("PATH_TRAVERSAL", `${sourceLabel}: ${urlPath}`));
      return null;
    }
    if (next === decoded) {
      return next;
    }
    decoded = next;
  }
  return decoded;
}

function splitReference(reference) {
  const fragmentIndex = reference.indexOf("#");
  const beforeFragment =
    fragmentIndex === -1 ? reference : reference.slice(0, fragmentIndex);
  const rawFragment = fragmentIndex === -1 ? "" : reference.slice(fragmentIndex + 1);
  const queryIndex = beforeFragment.indexOf("?");
  return {
    rawPath:
      queryIndex === -1 ? beforeFragment : beforeFragment.slice(0, queryIndex),
    rawFragment,
  };
}

function resolveInternalTarget({ currentFile, rawPath, sourceLabel, errors }) {
  if (rawPath === "") {
    return currentFile;
  }

  const decodedPath = decodeUrlPath(rawPath, sourceLabel, errors);
  if (decodedPath === null) {
    return null;
  }

  const rootRelative = decodedPath.startsWith("/");
  const withoutLeadingSlash = rootRelative ? decodedPath.slice(1) : decodedPath;
  const joined = rootRelative
    ? withoutLeadingSlash
    : path.posix.join(path.posix.dirname(currentFile), withoutLeadingSlash);
  const normalized = path.posix.normalize(joined);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    errors.push(error("PATH_TRAVERSAL", `${sourceLabel}: ${rawPath}`));
    return null;
  }

  if (decodedPath.endsWith("/") || normalized === "." || normalized === "") {
    return path.posix.join(normalized === "." ? "" : normalized, "index.html");
  }
  return normalized;
}

function validateReference({
  reference,
  attribute,
  element,
  currentFile,
  fileSet,
  idsByFile,
  errors,
  allowExternalNavigation = false,
}) {
  const value = reference.trim();
  const sourceLabel = `${currentFile} <${element}> ${attribute}`;
  if (!value) {
    if (attribute !== "href") {
      errors.push(error("EMPTY_REFERENCE", sourceLabel));
    }
    return null;
  }

  const compactForScheme = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (compactForScheme.startsWith("//")) {
    errors.push(error("EXTERNAL_RESOURCE", `${sourceLabel}: ${value}`));
    return null;
  }

  const schemeMatch = compactForScheme.match(/^([a-z][a-z0-9+.-]*:)/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (allowExternalNavigation && SAFE_NAVIGATION_SCHEMES.has(scheme)) {
      return;
    }
    errors.push(error("EXTERNAL_RESOURCE", `${sourceLabel}: ${value}`));
    return null;
  }

  const { rawPath, rawFragment } = splitReference(value);
  const targetFile = resolveInternalTarget({
    currentFile,
    rawPath,
    sourceLabel,
    errors,
  });
  if (!targetFile) {
    return null;
  }
  if (!fileSet.has(targetFile)) {
    errors.push(
      error("MISSING_TARGET", `${sourceLabel}: ${value} -> ${targetFile}`),
    );
    return null;
  }

  if (rawFragment) {
    let fragment;
    try {
      fragment = decodeURIComponent(rawFragment);
    } catch {
      errors.push(error("INVALID_URL_ENCODING", `${sourceLabel}: #${rawFragment}`));
      return null;
    }
    const targetIds = idsByFile.get(targetFile);
    if ((attribute === "href" || targetIds) && !targetIds?.has(fragment)) {
      errors.push(
        error(
          "MISSING_FRAGMENT",
          `${sourceLabel}: ${value} -> #${fragment} not found in ${targetFile}`,
        ),
      );
    }
  }
  return targetFile;
}

function collectIds(markup, relativePath, errors) {
  const ids = new Set();
  for (const { name, attributes } of markupTags(markup)) {
    const candidates = [];
    if (attributes.has("id")) {
      candidates.push(attributes.get("id"));
    }
    if (name === "a" && attributes.has("name")) {
      candidates.push(attributes.get("name"));
    }
    for (const id of candidates) {
      if (!id) {
        errors.push(error("EMPTY_FRAGMENT_ID", `${relativePath} contains an empty id`));
      } else if (ids.has(id)) {
        errors.push(
          error("DUPLICATE_FRAGMENT_ID", `${relativePath} duplicates #${id}`),
        );
      } else {
        ids.add(id);
      }
    }
  }
  return ids;
}

function cssReferences(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const references = [];
  for (const match of withoutComments.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    references.push(match[2]);
  }
  for (const match of withoutComments.matchAll(
    /@import\s+(?!url\s*\()["']([^"']+)["']/gi,
  )) {
    references.push(match[1]);
  }
  return references;
}

function validateCss({ css, currentFile, fileSet, idsByFile, errors, element }) {
  for (const reference of cssReferences(css)) {
    validateReference({
      reference,
      attribute: "src",
      element,
      currentFile,
      fileSet,
      idsByFile,
      errors,
    });
  }
}

function inspectMarkup({ markup, currentFile, fileSet, idsByFile, errors }) {
  if (fileExtension(currentFile) === ".html") {
    if (!/^\s*<!doctype\s+html\b/i.test(markup)) {
      errors.push(error("INVALID_HTML", `${currentFile} is missing an HTML doctype`));
    }
    if (!/<html\b[^>]*>[\s\S]*<\/html>\s*$/i.test(markup)) {
      errors.push(error("INVALID_HTML", `${currentFile} has no complete html element`));
    }
  }

  const cspMetaPolicies = [];
  for (const { name, attributes } of markupTags(markup)) {
    if (name === "base") {
      errors.push(
        error(
          "UNSUPPORTED_BASE_URL",
          `${currentFile} uses <base>, so internal paths cannot be verified safely`,
        ),
      );
    }
    if (
      name === "meta" &&
      attributes.get("http-equiv")?.toLowerCase() === "refresh"
    ) {
      errors.push(error("UNSAFE_META_REFRESH", `${currentFile} uses meta refresh`));
    }
    if (
      name === "meta" &&
      attributes.get("http-equiv")?.toLowerCase() === "content-security-policy"
    ) {
      cspMetaPolicies.push(attributes.get("content") ?? "");
    }

    for (const attribute of ["href", "src", "xlink:href"]) {
      if (!attributes.has(attribute)) {
        continue;
      }
      const linkRelations = new Set(
        (attributes.get("rel") ?? "")
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean),
      );
      const allowExternalNavigation =
        attribute === "href" &&
        (NAVIGATION_ELEMENTS.has(name) ||
          (name === "link" && linkRelations.has("canonical")));
      validateReference({
        reference: attributes.get(attribute),
        attribute,
        element: name,
        currentFile,
        fileSet,
        idsByFile,
        errors,
        allowExternalNavigation,
      });
    }

    if (attributes.has("srcdoc")) {
      errors.push(
        error(
          "UNSAFE_EMBEDDED_DOCUMENT",
          `${currentFile} <${name}> uses srcdoc, which cannot be audited as a standalone file`,
        ),
      );
    }

    if (attributes.has("srcset")) {
      for (const candidate of attributes.get("srcset").split(",")) {
        const reference = candidate.trim().split(/\s+/, 1)[0];
        validateReference({
          reference,
          attribute: "src",
          element: name,
          currentFile,
          fileSet,
          idsByFile,
          errors,
        });
      }
    }

    if (attributes.has("style")) {
      validateCss({
        css: attributes.get("style"),
        currentFile,
        fileSet,
        idsByFile,
        errors,
        element: `${name}[style]`,
      });
    }
  }

  if (fileExtension(currentFile) === ".html") {
    if (cspMetaPolicies.length === 0) {
      errors.push(error("CSP_META_MISSING", `${currentFile} has no CSP meta policy`));
    } else if (
      cspMetaPolicies.length !== 1 ||
      cspMetaPolicies[0] !== META_CONTENT_SECURITY_POLICY
    ) {
      errors.push(error("CSP_META_MISMATCH", `${currentFile} CSP meta policy is not canonical`));
    }
  }

  for (const styleMatch of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    validateCss({
      css: styleMatch[1],
      currentFile,
      fileSet,
      idsByFile,
      errors,
      element: "style",
    });
  }

  for (const scriptMatch of markup.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
  )) {
    const attributes = parseAttributes(scriptMatch[1]);
    if (attributes.has("src")) {
      continue;
    }
    const type = attributes.get("type")?.trim().toLowerCase() ?? "";
    const isDataScript =
      type === "application/json" || type === "application/ld+json";
    if (
      !isDataScript &&
      (SCRIPT_NETWORK_PATTERN.test(scriptMatch[2]) ||
        REMOTE_URL_PATTERN.test(scriptMatch[2]))
    ) {
      errors.push(
        error(
          "NETWORK_CAPABLE_SCRIPT",
          `${currentFile} contains inline script with a remote/network capability`,
        ),
      );
    }
    if (!isDataScript) {
      inspectScript({
        script: scriptMatch[2],
        relativePath: currentFile,
        fileSet,
        idsByFile,
        errors,
        inspectImports: type === "module",
        sourceKind: "inline script",
      });
    }
  }
}

function tokenizeJavaScript(script) {
  const tokens = [];
  let index = 0;

  function fail(message) {
    throw new Error(`${message} at byte ${Buffer.byteLength(script.slice(0, index), "utf8")}`);
  }

  function codePoint() {
    const value = script.codePointAt(index);
    return value === undefined ? "" : String.fromCodePoint(value);
  }

  function isIdentifierStart(character) {
    return character !== "" && /[$_\p{ID_Start}]/u.test(character);
  }

  function isIdentifierPart(character) {
    return character !== "" && /[$\u200c\u200d_\p{ID_Continue}]/u.test(character);
  }

  function readIdentifier() {
    const start = index;
    let value = "";
    let first = true;
    while (index < script.length) {
      if (script[index] === "\\" && script[index + 1] === "u") {
        const escapeStart = index;
        index += 2;
        let digits;
        if (script[index] === "{") {
          const close = script.indexOf("}", index + 1);
          digits = close === -1 ? "" : script.slice(index + 1, close);
          if (!/^[0-9a-f]{1,6}$/i.test(digits)) {
            fail("invalid Unicode identifier escape");
          }
          index = close + 1;
        } else {
          digits = script.slice(index, index + 4);
          if (!/^[0-9a-f]{4}$/i.test(digits)) {
            fail("invalid Unicode identifier escape");
          }
          index += 4;
        }
        const point = Number.parseInt(digits, 16);
        if (point > 0x10ffff) {
          fail("out-of-range Unicode identifier escape");
        }
        const decoded = String.fromCodePoint(point);
        if (first ? !isIdentifierStart(decoded) : !isIdentifierPart(decoded)) {
          index = escapeStart;
          fail("invalid escaped identifier character");
        }
        value += decoded;
        first = false;
        continue;
      }
      const character = codePoint();
      if (first ? !isIdentifierStart(character) : !isIdentifierPart(character)) {
        break;
      }
      value += character;
      index += character.length;
      first = false;
    }
    tokens.push({ type: "identifier", value, start });
  }

  function readString(quote) {
    const start = index;
    let value = "";
    index += 1;
    while (index < script.length) {
      const character = script[index];
      if (character === quote) {
        index += 1;
        tokens.push({ type: "string", value, start });
        return;
      }
      if (character === "\n" || character === "\r") {
        fail("unterminated string literal");
      }
      if (character !== "\\") {
        value += character;
        index += 1;
        continue;
      }

      index += 1;
      if (index >= script.length) {
        fail("unterminated string escape");
      }
      const escaped = script[index];
      const simpleEscapes = new Map([
        ["b", "\b"],
        ["f", "\f"],
        ["n", "\n"],
        ["r", "\r"],
        ["t", "\t"],
        ["v", "\v"],
        ["0", "\0"],
      ]);
      if (escaped === "\n") {
        index += 1;
      } else if (escaped === "\r") {
        index += script[index + 1] === "\n" ? 2 : 1;
      } else if (escaped === "x") {
        const digits = script.slice(index + 1, index + 3);
        if (!/^[0-9a-f]{2}$/i.test(digits)) {
          fail("invalid hexadecimal string escape");
        }
        value += String.fromCodePoint(Number.parseInt(digits, 16));
        index += 3;
      } else if (escaped === "u") {
        if (script[index + 1] === "{") {
          const close = script.indexOf("}", index + 2);
          const digits = close === -1 ? "" : script.slice(index + 2, close);
          if (!/^[0-9a-f]{1,6}$/i.test(digits)) {
            fail("invalid Unicode string escape");
          }
          const point = Number.parseInt(digits, 16);
          if (point > 0x10ffff) {
            fail("out-of-range Unicode string escape");
          }
          value += String.fromCodePoint(point);
          index = close + 1;
        } else {
          const digits = script.slice(index + 1, index + 5);
          if (!/^[0-9a-f]{4}$/i.test(digits)) {
            fail("invalid Unicode string escape");
          }
          value += String.fromCodePoint(Number.parseInt(digits, 16));
          index += 5;
        }
      } else {
        value += simpleEscapes.get(escaped) ?? escaped;
        index += 1;
      }
    }
    fail("unterminated string literal");
  }

  function regexCanStart() {
    const previous = tokens.at(-1);
    if (!previous) {
      return true;
    }
    if (previous.type === "identifier") {
      return REGEX_PREFIX_IDENTIFIERS.has(previous.value);
    }
    if (previous.type !== "punctuator") {
      return false;
    }
    if (previous.value === ")") {
      let depth = 0;
      for (let cursor = tokens.length - 1; cursor >= 0; cursor -= 1) {
        if (tokens[cursor].value === ")") {
          depth += 1;
        } else if (tokens[cursor].value === "(") {
          depth -= 1;
          if (depth === 0) {
            const controlHead = tokens[cursor - 1];
            return controlHead?.type === "identifier" &&
              REGEX_AFTER_CONTROL_HEAD_IDENTIFIERS.has(controlHead.value);
          }
        }
      }
      return false;
    }
    return REGEX_PREFIX_PUNCTUATORS.has(previous.value);
  }

  function readRegex() {
    const start = index;
    let inCharacterClass = false;
    index += 1;
    while (index < script.length) {
      const character = script[index];
      if (character === "\n" || character === "\r") {
        fail("unterminated regular expression literal");
      }
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "[") {
        inCharacterClass = true;
      } else if (character === "]") {
        inCharacterClass = false;
      } else if (character === "/" && !inCharacterClass) {
        index += 1;
        while (index < script.length && isIdentifierPart(codePoint())) {
          index += codePoint().length;
        }
        tokens.push({ type: "regex", value: null, start });
        return;
      }
      index += 1;
    }
    fail("unterminated regular expression literal");
  }

  function readTemplate() {
    const start = index;
    index += 1;
    while (index < script.length) {
      const character = script[index];
      if (character === "\\") {
        index += 2;
      } else if (character === "`") {
        index += 1;
        tokens.push({ type: "template", value: null, start });
        return;
      } else if (character === "$" && script[index + 1] === "{") {
        index += 2;
        readCode(true);
      } else {
        index += 1;
      }
    }
    fail("unterminated template literal");
  }

  function readCode(stopAtTemplateBrace = false) {
    let braceDepth = 0;
    while (index < script.length) {
      const character = script[index];
      const next = script[index + 1];
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      if (character === "/" && next === "/") {
        index += 2;
        while (index < script.length && !/[\r\n]/u.test(script[index])) {
          index += 1;
        }
        continue;
      }
      if (character === "/" && next === "*") {
        index += 2;
        const close = script.indexOf("*/", index);
        if (close === -1) {
          fail("unterminated block comment");
        }
        index = close + 2;
        continue;
      }
      if (character === "'" || character === '"') {
        readString(character);
        continue;
      }
      if (character === "`") {
        readTemplate();
        continue;
      }
      if (character === "/" && regexCanStart()) {
        readRegex();
        continue;
      }
      if (stopAtTemplateBrace && character === "}" && braceDepth === 0) {
        index += 1;
        return;
      }
      if (
        isIdentifierStart(codePoint()) ||
        (character === "\\" && next === "u")
      ) {
        readIdentifier();
        continue;
      }
      if (/\d/u.test(character)) {
        const start = index;
        index += 1;
        while (index < script.length && /[\w.]/u.test(script[index])) {
          index += 1;
        }
        tokens.push({ type: "number", value: script.slice(start, index), start });
        continue;
      }

      const start = index;
      const punctuator = ["===", "!==", ">>>", "**=", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "++", "--", "&&", "||", "??", "?.", "**", "<<", ">>"].find(
        (candidate) => script.startsWith(candidate, index),
      ) ?? character;
      index += punctuator.length;
      tokens.push({ type: "punctuator", value: punctuator, start });
      if (stopAtTemplateBrace) {
        if (punctuator === "{") {
          braceDepth += 1;
        } else if (punctuator === "}") {
          braceDepth -= 1;
        }
      }
    }
    if (stopAtTemplateBrace) {
      fail("unterminated template expression");
    }
  }

  readCode();
  return tokens;
}

function hasStorageCapability(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "identifier" && STORAGE_IDENTIFIERS.has(token.value)) {
      return true;
    }
    const bracketOffset = tokens[index + 1]?.value === "?." ? 2 : 1;
    if (
      token.type === "identifier" &&
      BROWSER_GLOBAL_IDENTIFIERS.has(token.value) &&
      tokens[index + bracketOffset]?.value === "[" &&
      tokens[index + bracketOffset + 1]?.type === "string" &&
      STORAGE_IDENTIFIERS.has(tokens[index + bracketOffset + 1].value) &&
      tokens[index + bracketOffset + 2]?.value === "]"
    ) {
      return true;
    }
  }
  return false;
}

function matchingBrace(tokens, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === "{") {
      depth += 1;
    } else if (tokens[index].value === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function moduleSpecifiers(tokens, relativePath, errors) {
  const specifiers = [];

  function addStringToken(token, context) {
    if (token?.type !== "string") {
      errors.push(error("INVALID_MODULE_IMPORT", `${relativePath} has malformed ${context}`));
      return;
    }
    specifiers.push(token.value);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    if (token.type !== "identifier" || previous?.value === "." || previous?.value === "?.") {
      continue;
    }

    if (token.value === "import") {
      const next = tokens[index + 1];
      if (next?.value === ".") {
        continue;
      }
      if (next?.value === "(") {
        if (tokens[index + 2]?.type !== "string" || tokens[index + 3]?.value !== ")") {
          errors.push(
            error(
              "NON_LITERAL_DYNAMIC_IMPORT",
              `${relativePath} contains a non-literal or unsupported dynamic import`,
            ),
          );
        } else {
          specifiers.push(tokens[index + 2].value);
        }
        continue;
      }
      if (next?.type === "string") {
        specifiers.push(next.value);
        continue;
      }

      let cursor = index + 1;
      if (tokens[cursor]?.type === "identifier") {
        cursor += 1;
        if (tokens[cursor]?.value === ",") {
          cursor += 1;
        }
      }
      if (tokens[cursor]?.value === "{") {
        cursor = matchingBrace(tokens, cursor) + 1;
      } else if (tokens[cursor]?.value === "*") {
        cursor += 1;
        if (tokens[cursor]?.value === "as" && tokens[cursor + 1]?.type === "identifier") {
          cursor += 2;
        }
      }
      if (cursor <= 0 || tokens[cursor]?.value !== "from") {
        errors.push(error("INVALID_MODULE_IMPORT", `${relativePath} has malformed static import`));
      } else {
        addStringToken(tokens[cursor + 1], "static import");
      }
      continue;
    }

    if (token.value !== "export") {
      continue;
    }
    let cursor = index + 1;
    if (tokens[cursor]?.value === "{") {
      cursor = matchingBrace(tokens, cursor) + 1;
      if (cursor > 0 && tokens[cursor]?.value === "from") {
        addStringToken(tokens[cursor + 1], "export-from");
      }
    } else if (tokens[cursor]?.value === "*") {
      cursor += 1;
      if (tokens[cursor]?.value === "as" && tokens[cursor + 1]?.type === "identifier") {
        cursor += 2;
      }
      if (tokens[cursor]?.value !== "from") {
        errors.push(error("INVALID_MODULE_IMPORT", `${relativePath} has malformed export-from`));
      } else {
        addStringToken(tokens[cursor + 1], "export-from");
      }
    }
  }

  return specifiers;
}

function validateModuleSpecifier({
  specifier,
  currentFile,
  fileSet,
  idsByFile,
  errors,
}) {
  const value = specifier.trim();
  const compactForScheme = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  const isExternal = compactForScheme.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(compactForScheme);
  if (!isExternal && !value.startsWith("./") && !value.startsWith("../") && !value.startsWith("/")) {
    errors.push(error("UNSAFE_MODULE_SPECIFIER", `${currentFile} module import: ${value}`));
    return;
  }

  const targetFile = validateReference({
    reference: value,
    attribute: "src",
    element: "module",
    currentFile,
    fileSet,
    idsByFile,
    errors,
  });
  if (targetFile && ![".js", ".mjs"].includes(fileExtension(targetFile))) {
    errors.push(
      error(
        "INVALID_MODULE_TARGET",
        `${currentFile} module import: ${value} -> ${targetFile}`,
      ),
    );
  }
}

function inspectScript({
  script,
  relativePath,
  fileSet,
  idsByFile,
  errors,
  inspectImports = true,
  sourceKind = "script",
}) {
  if (SCRIPT_NETWORK_PATTERN.test(script) || REMOTE_URL_PATTERN.test(script)) {
    errors.push(
      error(
        "NETWORK_CAPABLE_SCRIPT",
        `${relativePath} contains a remote/network capability`,
      ),
    );
  }
  let tokens;
  try {
    tokens = tokenizeJavaScript(script);
  } catch (tokenError) {
    errors.push(
      error(
        "SCRIPT_LEXING_FAILED",
        `${relativePath} ${sourceKind} cannot be audited: ${tokenError.message}`,
      ),
    );
    return;
  }
  if (hasStorageCapability(tokens)) {
    errors.push(
      error(
        "STORAGE_CAPABLE_SCRIPT",
        `${relativePath} contains ${sourceKind} with a browser storage capability`,
      ),
    );
  }
  if (inspectImports) {
    for (const specifier of moduleSpecifiers(tokens, relativePath, errors)) {
      validateModuleSpecifier({
        specifier,
        currentFile: relativePath,
        fileSet,
        idsByFile,
        errors,
      });
    }
  }
}

export async function collectSiteFiles(siteDir = DEFAULT_SITE_DIR) {
  const inventory = await walkSite(siteDir);
  if (inventory.errors.length > 0) {
    throw new Error(inventory.errors.join("\n"));
  }
  return inventory.files;
}

export async function checkSite(options = {}) {
  const siteDir =
    typeof options === "string" ? options : (options.siteDir ?? DEFAULT_SITE_DIR);
  const inventory = await walkSite(siteDir);
  const errors = [...inventory.errors];
  const files = inventory.files;
  const fileSet = new Set(files);

  if (!fileSet.has("index.html")) {
    errors.push(error("MISSING_INDEX", `${siteDir}/index.html is required`));
  }

  for (const relativePath of files) {
    if (!isSafePublicPath(relativePath)) {
      errors.push(error("UNSAFE_PUBLIC_PATH", relativePath));
    }
    if (!isAllowedPublicFile(relativePath)) {
      errors.push(error("DISALLOWED_FILE_TYPE", relativePath));
    }
  }

  const textByFile = new Map();
  for (const relativePath of files) {
    if (!TEXT_FILE_EXTENSIONS.has(fileExtension(relativePath))) {
      continue;
    }
    try {
      const bytes = await readFile(path.join(siteDir, relativePath));
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      textByFile.set(relativePath, content);
    } catch (readError) {
      const code = readError instanceof TypeError ? "INVALID_TEXT_ENCODING" : "FILE_READ_FAILED";
      errors.push(error(code, `${relativePath}: ${readError.message}`));
    }
  }

  const idsByFile = new Map();
  for (const [relativePath, content] of textByFile) {
    if ([".html", ".svg"].includes(fileExtension(relativePath))) {
      idsByFile.set(relativePath, collectIds(content, relativePath, errors));
    }
  }

  for (const [relativePath, content] of textByFile) {
    const extension = fileExtension(relativePath);
    if (extension === ".html" || extension === ".svg") {
      inspectMarkup({
        markup: content,
        currentFile: relativePath,
        fileSet,
        idsByFile,
        errors,
      });
    } else if (extension === ".css") {
      validateCss({
        css: content,
        currentFile: relativePath,
        fileSet,
        idsByFile,
        errors,
        element: "css",
      });
    } else if (extension === ".js" || extension === ".mjs") {
      inspectScript({
        script: content,
        relativePath,
        fileSet,
        idsByFile,
        errors,
      });
    }
  }

  return [...new Set(errors)].sort((left, right) => left.localeCompare(right, "en"));
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--site-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--site-dir requires a value");
      }
      options.siteDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const errors = await checkSite(parseCliArgs(process.argv.slice(2)));
  if (errors.length > 0) {
    console.error(`✗ public-artifact check failed (${errors.length} error${errors.length === 1 ? "" : "s"}):`);
    for (const issue of errors) {
      console.error(`  ${issue}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("✓ public-artifact check passed");
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((mainError) => {
    console.error(mainError.stack ?? mainError.message);
    process.exitCode = 1;
  });
}
