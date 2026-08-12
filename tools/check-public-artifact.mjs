#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  PUBLIC_SCRIPT_POLICY,
  TRUSTED_PUBLIC_SCRIPTS,
  auditPublicScript,
} from "./lib/public-script-policy.mjs";
import { META_CONTENT_SECURITY_POLICY } from "./lib/site-security.mjs";

const DEFAULT_SITE_DIR = "site";
const TRUSTED_SCRIPT_PATHS = new Set(Object.keys(TRUSTED_PUBLIC_SCRIPTS));

export const PUBLIC_FILE_EXTENSIONS = new Set([
  ".avif", ".css", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".js",
  ".json", ".mjs", ".png", ".svg", ".txt", ".webmanifest", ".webp",
  ".woff", ".woff2", ".xml",
]);

const PUBLIC_FILE_NAMES = new Set([".nojekyll"]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".css", ".html", ".js", ".json", ".mjs", ".svg", ".txt",
  ".webmanifest", ".xml",
]);
const NAVIGATION_ELEMENTS = new Set(["a", "area"]);
const SAFE_NAVIGATION_SCHEMES = new Set(["https:", "mailto:", "tel:"]);
const INERT_SCRIPT_TYPES = new Set(["application/json", "application/ld+json"]);
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
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return ({
        "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">",
      })[match.toLowerCase()] ?? match;
    },
  );
}

function parseAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(name, decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ""));
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
  if (/[\u0000-\u001f\u007f?#%\\]/.test(relativePath)) return false;
  return relativePath.split("/").every(
    (segment) => segment && segment !== "." && segment !== ".." &&
      (!segment.startsWith(".") || relativePath === ".nojekyll"),
  );
}

async function walkSite(siteDir) {
  const files = [];
  const errors = [];
  try {
    const rootStat = await lstat(siteDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      errors.push(error("UNSAFE_FILE_TYPE", `${siteDir} must be a real directory`));
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
      errors.push(error("SITE_READ_FAILED", `${absoluteDir}: ${walkError.message}`));
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, entry.name)
        : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(error("UNSAFE_FILE_TYPE", `${relativePath} must not be a symbolic link`));
      } else if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        errors.push(error("UNSAFE_FILE_TYPE", `${relativePath} is not a regular file`));
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
    if (next === decoded) return next;
    decoded = next;
  }
  return decoded;
}

function splitReference(reference) {
  const fragmentIndex = reference.indexOf("#");
  const beforeFragment = fragmentIndex === -1 ? reference : reference.slice(0, fragmentIndex);
  const queryIndex = beforeFragment.indexOf("?");
  return {
    rawPath: queryIndex === -1 ? beforeFragment : beforeFragment.slice(0, queryIndex),
    rawFragment: fragmentIndex === -1 ? "" : reference.slice(fragmentIndex + 1),
  };
}

function resolveInternalTarget({ currentFile, rawPath, sourceLabel, errors }) {
  if (rawPath === "") return currentFile;
  const decodedPath = decodeUrlPath(rawPath, sourceLabel, errors);
  if (decodedPath === null) return null;
  const rootRelative = decodedPath.startsWith("/");
  const withoutLeadingSlash = rootRelative ? decodedPath.slice(1) : decodedPath;
  const joined = rootRelative
    ? withoutLeadingSlash
    : path.posix.join(path.posix.dirname(currentFile), withoutLeadingSlash);
  const normalized = path.posix.normalize(joined);
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    errors.push(error("PATH_TRAVERSAL", `${sourceLabel}: ${rawPath}`));
    return null;
  }
  if (decodedPath.endsWith("/") || normalized === "." || normalized === "") {
    return path.posix.join(normalized === "." ? "" : normalized, "index.html");
  }
  return normalized;
}

function validateReference({
  reference, attribute, element, currentFile, fileSet, idsByFile, errors,
  allowExternalNavigation = false,
}) {
  const value = reference.trim();
  const sourceLabel = `${currentFile} <${element}> ${attribute}`;
  if (!value) {
    if (attribute !== "href") errors.push(error("EMPTY_REFERENCE", sourceLabel));
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
    if (allowExternalNavigation && SAFE_NAVIGATION_SCHEMES.has(scheme)) return null;
    errors.push(error("EXTERNAL_RESOURCE", `${sourceLabel}: ${value}`));
    return null;
  }
  const { rawPath, rawFragment } = splitReference(value);
  const targetFile = resolveInternalTarget({ currentFile, rawPath, sourceLabel, errors });
  if (!targetFile) return null;
  if (!fileSet.has(targetFile)) {
    errors.push(error("MISSING_TARGET", `${sourceLabel}: ${value} -> ${targetFile}`));
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
      errors.push(error(
        "MISSING_FRAGMENT",
        `${sourceLabel}: ${value} -> #${fragment} not found in ${targetFile}`,
      ));
    }
  }
  return targetFile;
}

function collectIds(markup, relativePath, errors) {
  const ids = new Set();
  for (const { name, attributes } of markupTags(markup)) {
    const candidates = [];
    if (attributes.has("id")) candidates.push(attributes.get("id"));
    if (name === "a" && attributes.has("name")) candidates.push(attributes.get("name"));
    for (const id of candidates) {
      if (!id) errors.push(error("EMPTY_FRAGMENT_ID", `${relativePath} contains an empty id`));
      else if (ids.has(id)) errors.push(error("DUPLICATE_FRAGMENT_ID", `${relativePath} duplicates #${id}`));
      else ids.add(id);
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
  for (const match of withoutComments.matchAll(/@import\s+(?!url\s*\()["']([^"']+)["']/gi)) {
    references.push(match[1]);
  }
  return references;
}

function validateCss({ css, currentFile, fileSet, idsByFile, errors, element }) {
  for (const reference of cssReferences(css)) {
    validateReference({
      reference, attribute: "src", element, currentFile, fileSet, idsByFile, errors,
    });
  }
}

function validateScriptImport({ specifier, currentFile, fileSet, idsByFile, errors }) {
  const value = specifier.trim();
  const compact = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (compact.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(compact)) {
    errors.push(error("EXTERNAL_SCRIPT_IMPORT", `${currentFile}: ${value}`));
    return;
  }
  if (!value.startsWith("./") && !value.startsWith("../") && !value.startsWith("/")) {
    errors.push(error("UNTRUSTED_SCRIPT_IMPORT", `${currentFile}: ${value}`));
    return;
  }
  const { rawPath } = splitReference(value);
  if (fileExtension(rawPath) !== ".mjs") {
    errors.push(error("INVALID_SCRIPT_IMPORT_TARGET", `${currentFile}: ${value}`));
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
  if (targetFile && !TRUSTED_SCRIPT_PATHS.has(targetFile)) {
    errors.push(error("UNTRUSTED_SCRIPT_IMPORT", `${currentFile}: ${value} -> ${targetFile}`));
  }
}

function validateExternalScriptType({ attributes, currentFile, targetFile, errors }) {
  const policy = PUBLIC_SCRIPT_POLICY[targetFile];
  if (!policy) return;
  const htmlType = attributes.has("type")
    ? attributes.get("type").trim().toLowerCase()
    : null;
  if (!policy.htmlTypes.includes(htmlType)) {
    const actual = htmlType === null ? "<missing>" : JSON.stringify(htmlType);
    const expected = policy.htmlTypes
      .map((value) => value === null ? "an omitted type" : JSON.stringify(value))
      .join(" or ");
    errors.push(error(
      "SCRIPT_TYPE_MISMATCH",
      `${currentFile} references ${targetFile} with type ${actual}; expected ${expected}`,
    ));
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
      errors.push(error("UNSUPPORTED_BASE_URL", `${currentFile} uses <base>`));
    }
    if (name === "meta" && attributes.get("http-equiv")?.toLowerCase() === "refresh") {
      errors.push(error("UNSAFE_META_REFRESH", `${currentFile} uses meta refresh`));
    }
    if (name === "meta" && attributes.get("http-equiv")?.toLowerCase() === "content-security-policy") {
      cspMetaPolicies.push(attributes.get("content") ?? "");
    }

    for (const attribute of ["href", "src", "xlink:href"]) {
      if (!attributes.has(attribute)) continue;
      const linkRelations = new Set(
        (attributes.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean),
      );
      const allowExternalNavigation = attribute === "href" &&
        (NAVIGATION_ELEMENTS.has(name) || (name === "link" && linkRelations.has("canonical")));
      const targetFile = validateReference({
        reference: attributes.get(attribute), attribute, element: name, currentFile,
        fileSet, idsByFile, errors, allowExternalNavigation,
      });
      if (name === "script" && attribute === "src" && targetFile && !TRUSTED_SCRIPT_PATHS.has(targetFile)) {
        errors.push(error("UNTRUSTED_SCRIPT", `${currentFile} references ${targetFile}`));
      }
      if (name === "script" && attribute === "src" && targetFile) {
        validateExternalScriptType({ attributes, currentFile, targetFile, errors });
      }
    }

    if (attributes.has("srcdoc")) {
      errors.push(error("UNSAFE_EMBEDDED_DOCUMENT", `${currentFile} <${name}> uses srcdoc`));
    }
    if (attributes.has("srcset")) {
      for (const candidate of attributes.get("srcset").split(",")) {
        validateReference({
          reference: candidate.trim().split(/\s+/, 1)[0], attribute: "src", element: name,
          currentFile, fileSet, idsByFile, errors,
        });
      }
    }
    if (attributes.has("style")) {
      validateCss({
        css: attributes.get("style"), currentFile, fileSet, idsByFile, errors,
        element: `${name}[style]`,
      });
    }
  }

  if (fileExtension(currentFile) === ".html") {
    if (cspMetaPolicies.length === 0) {
      errors.push(error("CSP_META_MISSING", `${currentFile} has no CSP meta policy`));
    } else if (cspMetaPolicies.length !== 1 || cspMetaPolicies[0] !== META_CONTENT_SECURITY_POLICY) {
      errors.push(error("CSP_META_MISMATCH", `${currentFile} CSP meta policy is not canonical`));
    }
  }

  for (const styleMatch of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    validateCss({
      css: styleMatch[1], currentFile, fileSet, idsByFile, errors, element: "style",
    });
  }

  for (const scriptMatch of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = parseAttributes(scriptMatch[1]);
    if (attributes.has("src")) continue;
    const type = attributes.get("type")?.trim().toLowerCase() ?? "";
    if (!INERT_SCRIPT_TYPES.has(type)) {
      errors.push(error("INLINE_EXECUTABLE_SCRIPT", `${currentFile} contains inline executable script`));
      continue;
    }
    try {
      JSON.parse(scriptMatch[2]);
    } catch (parseError) {
      errors.push(error("INVALID_DATA_SCRIPT", `${currentFile}: ${parseError.message}`));
    }
    if (/[<>&\u2028\u2029]/u.test(scriptMatch[2])) {
      errors.push(error("UNSAFE_DATA_SCRIPT", `${currentFile} data script is not HTML-safe serialized JSON`));
    }
  }
}

export async function collectSiteFiles(siteDir = DEFAULT_SITE_DIR) {
  const inventory = await walkSite(siteDir);
  if (inventory.errors.length > 0) throw new Error(inventory.errors.join("\n"));
  return inventory.files;
}

export async function inspectSiteArtifact(options = {}) {
  const siteDir = typeof options === "string" ? options : (options.siteDir ?? DEFAULT_SITE_DIR);
  const inventory = await walkSite(siteDir);
  const errors = [...inventory.errors];
  const files = inventory.files;
  const fileSet = new Set(files);
  if (!fileSet.has("index.html")) errors.push(error("MISSING_INDEX", `${siteDir}/index.html is required`));

  for (const relativePath of files) {
    if (!isSafePublicPath(relativePath)) errors.push(error("UNSAFE_PUBLIC_PATH", relativePath));
    if (!isAllowedPublicFile(relativePath)) errors.push(error("DISALLOWED_FILE_TYPE", relativePath));
    if ([".js", ".mjs"].includes(fileExtension(relativePath)) && !TRUSTED_SCRIPT_PATHS.has(relativePath)) {
      errors.push(error("UNTRUSTED_SCRIPT", `${relativePath} is not in the public script allowlist`));
    }
  }

  const bytesByFile = new Map();
  const textByFile = new Map();
  for (const relativePath of files) {
    try {
      const bytes = await readFile(path.join(siteDir, relativePath));
      bytesByFile.set(relativePath, bytes);
      if (TEXT_FILE_EXTENSIONS.has(fileExtension(relativePath))) {
        textByFile.set(relativePath, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      }
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

  const trustedBytesByFile = new Map();
  for (const [relativePath, sourceUrl] of Object.entries(TRUSTED_PUBLIC_SCRIPTS)) {
    trustedBytesByFile.set(relativePath, await readFile(sourceUrl));
  }

  for (const [relativePath, content] of textByFile) {
    const extension = fileExtension(relativePath);
    if (extension === ".html" || extension === ".svg") {
      inspectMarkup({ markup: content, currentFile: relativePath, fileSet, idsByFile, errors });
    } else if (extension === ".css") {
      validateCss({ css: content, currentFile: relativePath, fileSet, idsByFile, errors, element: "css" });
    } else if (extension === ".js" || extension === ".mjs") {
      const trustedBytes = trustedBytesByFile.get(relativePath);
      if (trustedBytes && !bytesByFile.get(relativePath).equals(trustedBytes)) {
        errors.push(error("SCRIPT_BYTES_MISMATCH", `${relativePath} differs from its trusted source`));
      }
      const audit = auditPublicScript({ source: content, relativePath });
      for (const issue of audit.errors) errors.push(error(issue.code, issue.message));
      for (const specifier of audit.imports) {
        validateScriptImport({ specifier, currentFile: relativePath, fileSet, idsByFile, errors });
      }
    }
  }

  return {
    errors: [...new Set(errors)].sort((left, right) => left.localeCompare(right, "en")),
    files: files
      .filter((relativePath) => bytesByFile.has(relativePath))
      .map((relativePath) => ({ relativePath, bytes: bytesByFile.get(relativePath) })),
  };
}

export async function checkSite(options = {}) {
  return (await inspectSiteArtifact(options)).errors;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--site-dir") throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error("--site-dir requires a value");
    options.siteDir = value;
    index += 1;
  }
  return options;
}

async function main() {
  const errors = await checkSite(parseCliArgs(process.argv.slice(2)));
  if (errors.length > 0) {
    console.error(`✗ public-artifact check failed (${errors.length} error${errors.length === 1 ? "" : "s"}):`);
    for (const issue of errors) console.error(`  ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log("✓ public-artifact check passed");
}

if (import.meta.main) {
  main().catch((mainError) => {
    console.error(mainError.stack ?? mainError.message);
    process.exitCode = 1;
  });
}
