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
const SCRIPT_STORAGE_PATTERN =
  /\b(?:localStorage|sessionStorage|indexedDB)\s*(?:\.|\[)/i;
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
    return;
  }

  const compactForScheme = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (compactForScheme.startsWith("//")) {
    errors.push(error("EXTERNAL_RESOURCE", `${sourceLabel}: ${value}`));
    return;
  }

  const schemeMatch = compactForScheme.match(/^([a-z][a-z0-9+.-]*:)/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (allowExternalNavigation && SAFE_NAVIGATION_SCHEMES.has(scheme)) {
      return;
    }
    errors.push(error("EXTERNAL_RESOURCE", `${sourceLabel}: ${value}`));
    return;
  }

  const { rawPath, rawFragment } = splitReference(value);
  const targetFile = resolveInternalTarget({
    currentFile,
    rawPath,
    sourceLabel,
    errors,
  });
  if (!targetFile) {
    return;
  }
  if (!fileSet.has(targetFile)) {
    errors.push(
      error("MISSING_TARGET", `${sourceLabel}: ${value} -> ${targetFile}`),
    );
    return;
  }

  if (rawFragment) {
    let fragment;
    try {
      fragment = decodeURIComponent(rawFragment);
    } catch {
      errors.push(error("INVALID_URL_ENCODING", `${sourceLabel}: #${rawFragment}`));
      return;
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
    if (
      !isDataScript &&
      SCRIPT_STORAGE_PATTERN.test(javascriptCodeOnly(scriptMatch[2]))
    ) {
      errors.push(
        error(
          "STORAGE_CAPABLE_SCRIPT",
          `${currentFile} contains inline script with a browser storage capability`,
        ),
      );
    }
  }
}

function javascriptCodeOnly(script) {
  let code = "";
  let mode = "code";
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    const next = script[index + 1];

    if (mode === "code") {
      if (character === "/" && next === "/") {
        code += "  ";
        index += 1;
        mode = "line-comment";
      } else if (character === "/" && next === "*") {
        code += "  ";
        index += 1;
        mode = "block-comment";
      } else if (character === "'" || character === '"' || character === "`") {
        code += " ";
        mode = character;
      } else {
        code += character;
      }
      continue;
    }

    if (mode === "line-comment") {
      if (character === "\n") {
        code += "\n";
        mode = "code";
      } else {
        code += " ";
      }
      continue;
    }

    if (mode === "block-comment") {
      if (character === "*" && next === "/") {
        code += "  ";
        index += 1;
        mode = "code";
      } else {
        code += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (character === "\\") {
      code += " ";
      if (index + 1 < script.length) {
        code += script[index + 1] === "\n" ? "\n" : " ";
        index += 1;
      }
    } else if (character === mode) {
      code += " ";
      mode = "code";
    } else {
      code += character === "\n" ? "\n" : " ";
    }
  }
  return code;
}

function inspectScript(script, relativePath, errors) {
  if (SCRIPT_NETWORK_PATTERN.test(script) || REMOTE_URL_PATTERN.test(script)) {
    errors.push(
      error(
        "NETWORK_CAPABLE_SCRIPT",
        `${relativePath} contains a remote/network capability`,
      ),
    );
  }
  if (SCRIPT_STORAGE_PATTERN.test(javascriptCodeOnly(script))) {
    errors.push(
      error(
        "STORAGE_CAPABLE_SCRIPT",
        `${relativePath} contains a browser storage capability`,
      ),
    );
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
      inspectScript(content, relativePath, errors);
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
