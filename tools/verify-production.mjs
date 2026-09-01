#!/usr/bin/env node
/**
 * Verify every file in the local public artifact against the activated site.
 *
 * Usage:
 *   node tools/verify-production.mjs [--url <site-url>] [--site-dir <path>]
 *     [--frozen-manifest <path> --frozen-artifact-sha-file <path>
 *      --frozen-file-count-file <path>]
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkSite, collectSiteFiles } from "./check-public-artifact.mjs";

export const DEFAULT_SITE_URL =
  process.env.PRODUCTION_URL ||
  process.env.PAGES_URL ||
  "https://xmind.lute-tlz-dddd.top/";
const DEFAULT_SITE_DIR = "site";
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 12;
const FROZEN_OPTION_NAMES = [
  "frozenManifest",
  "frozenArtifactShaFile",
  "frozenFileCountFile",
];

const CONTENT_TYPES = new Map([
  [".avif", ["image/avif"]],
  [".css", ["text/css"]],
  [".gif", ["image/gif"]],
  [".html", ["text/html"]],
  [".ico", ["image/x-icon", "image/vnd.microsoft.icon"]],
  [".jpeg", ["image/jpeg"]],
  [".jpg", ["image/jpeg"]],
  [".js", ["application/javascript", "text/javascript"]],
  [".json", ["application/json"]],
  [".mjs", ["application/javascript", "text/javascript"]],
  [".png", ["image/png"]],
  [".svg", ["image/svg+xml"]],
  [".txt", ["text/plain"]],
  [".webmanifest", ["application/manifest+json", "application/json"]],
  [".webp", ["image/webp"]],
  [".woff", ["font/woff", "application/font-woff"]],
  [".woff2", ["font/woff2"]],
  [".xml", ["application/xml", "text/xml"]],
]);

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function firstDifferingByte(left, right) {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return left.length === right.length ? -1 : sharedLength;
}

function normalizedBaseUrl(targetUrl) {
  const url = new URL(targetUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.search || url.hash) {
    throw new Error("Production URL must not include a query string or fragment");
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function remoteUrlForFile(baseUrl, relativePath) {
  if (relativePath === "index.html") {
    return baseUrl.href;
  }
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(encodedPath, baseUrl).href;
}

function contentTypeMatches(relativePath, contentType) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const expected = CONTENT_TYPES.get(extension);
  if (!expected) {
    return relativePath === ".nojekyll";
  }
  const actual = contentType.split(";", 1)[0].trim().toLowerCase();
  return expected.includes(actual);
}

/**
 * Fetch a URL, following a bounded redirect chain.
 */
export async function fetchUrl(url, options = {}) {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const redirects = options.redirects ?? [];
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const get =
      parsedUrl.protocol === "https:"
        ? httpsGet
        : parsedUrl.protocol === "http:"
          ? httpGet
          : null;
    if (!get) {
      reject(new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`));
      return;
    }

    const request = get(
      parsedUrl,
      {
        headers: {
          accept: "*/*",
          "accept-encoding": "identity",
          "user-agent": "systematic-thinking-production-verifier/1",
        },
        timeout: options.timeoutMs ?? 15_000,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (maxRedirects <= 0) {
            reject(new Error(`Too many redirects: ${url}`));
            return;
          }
          const nextUrl = new URL(location, parsedUrl).href;
          resolve(
            fetchUrl(nextUrl, {
              ...options,
              maxRedirects: maxRedirects - 1,
              redirects: [...redirects, url],
            }),
          );
          return;
        }

        const chunks = [];
        let receivedBytes = 0;
        response.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > (options.maxBytes ?? MAX_RESPONSE_BYTES)) {
            request.destroy(
              new Error(`Response exceeds size limit: ${parsedUrl.href}`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            finalUrl: parsedUrl.href,
            rawHeaders: response.rawHeaders,
            status,
            contentType: response.headers["content-type"] || "",
            redirects,
          });
        });
        response.on("error", reject);
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Request timed out: ${parsedUrl.href}`));
    });
    request.on("error", reject);
  });
}

function compareRemoteFile(relativePath, remoteUrl, localBody, result) {
  const errors = [];
  if (result.status !== 200) {
    errors.push(`${relativePath}: HTTP ${result.status} at ${result.finalUrl}`);
    return errors;
  }
  if (result.finalUrl !== remoteUrl) {
    errors.push(
      `${relativePath}: unexpected redirect ${remoteUrl} -> ${result.finalUrl}`,
    );
  }
  if (!contentTypeMatches(relativePath, result.contentType)) {
    errors.push(
      `${relativePath}: unexpected content type ${result.contentType || "<missing>"}`,
    );
  }
  if (!localBody.equals(result.body)) {
    const offset = firstDifferingByte(localBody, result.body);
    errors.push(
      `${relativePath}: byte mismatch at offset ${offset}; ` +
        `local=${sha256(localBody)} (${localBody.length} bytes), ` +
        `remote=${sha256(result.body)} (${result.body.length} bytes)`,
    );
  }
  return errors;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function isCanonicalFrozenPath(relativePath) {
  return relativePath.length > 0 && !path.posix.isAbsolute(relativePath) &&
    path.posix.normalize(relativePath) === relativePath &&
    !/[\u0000-\u001f\u007f?#%\\]/u.test(relativePath) &&
    relativePath.split("/").every((segment) =>
      segment && segment !== "." && segment !== ".." &&
      (!segment.startsWith(".") || relativePath === ".nojekyll"));
}

async function readFrozenEvidence(filePath, label) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
    return await handle.readFile();
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseFrozenManifest(source) {
  if (!source.endsWith("\n") || source.length === 1) {
    throw new Error("frozen manifest must be a non-empty LF-terminated sha256sum manifest");
  }
  const entries = [];
  const paths = new Set();
  for (const line of source.slice(0, -1).split("\n")) {
    const match = line.match(/^([0-9a-f]{64})  \.\/(.+)$/u);
    const relativePath = match?.[2];
    if (!match || !isCanonicalFrozenPath(relativePath)) {
      throw new Error(`frozen manifest has an invalid entry: ${line}`);
    }
    if (paths.has(relativePath)) {
      throw new Error(`frozen manifest repeats path: ${relativePath}`);
    }
    paths.add(relativePath);
    entries.push({ digest: match[1], relativePath });
  }
  return entries;
}

function parseFrozenArtifactSha(source) {
  if (!/^[0-9a-f]{64}\n$/u.test(source)) {
    throw new Error("frozen artifact SHA file must contain one lowercase SHA-256 and LF");
  }
  return source.slice(0, -1);
}

function parseFrozenFileCount(source) {
  const match = source.match(/^[ \t]*([1-9]\d*)[ \t]*\n$/u);
  const count = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(count)) {
    throw new Error("frozen file count file must contain one positive safe integer and LF");
  }
  return count;
}

async function inspectFrozenArtifact({
  siteDir,
  frozenManifest,
  frozenArtifactShaFile,
  frozenFileCountFile,
}) {
  try {
    const [manifestSource, artifactSource, countSource] = await Promise.all([
      readFrozenEvidence(frozenManifest, "frozen manifest"),
      readFrozenEvidence(frozenArtifactShaFile, "frozen artifact SHA file"),
      readFrozenEvidence(frozenFileCountFile, "frozen file count file"),
    ]);
    const entries = parseFrozenManifest(manifestSource.toString("utf8"));
    const expectedArtifactSha = parseFrozenArtifactSha(artifactSource.toString("utf8"));
    const expectedFileCount = parseFrozenFileCount(countSource.toString("utf8"));
    const actualPaths = (await collectSiteFiles(siteDir))
      .sort((left, right) => left.localeCompare(right, "en"));
    if (actualPaths.some((relativePath) => !isCanonicalFrozenPath(relativePath))) {
      throw new Error("site contains a noncanonical relative path");
    }
    const manifestPaths = entries.map(({ relativePath }) => relativePath);
    const manifestSet = new Set(manifestPaths);
    if (actualPaths.length !== manifestSet.size ||
        actualPaths.some((relativePath) => !manifestSet.has(relativePath))) {
      throw new Error("frozen manifest file set differs from the site file set");
    }
    if (expectedFileCount !== entries.length || expectedFileCount !== actualPaths.length) {
      throw new Error("frozen file count differs from the manifest or site file count");
    }

    const files = [];
    const artifactHash = createHash("sha256");
    const digestByPath = new Map(entries.map((entry) => [entry.relativePath, entry.digest]));
    for (const relativePath of actualPaths) {
      const bytes = await readFrozenEvidence(
        path.join(siteDir, relativePath),
        `site file ${relativePath}`,
      );
      if (sha256(bytes) !== digestByPath.get(relativePath)) {
        throw new Error(`frozen manifest digest mismatch: ${relativePath}`);
      }
      artifactHash.update(relativePath, "utf8");
      artifactHash.update("\0");
      artifactHash.update(bytes);
      artifactHash.update("\0");
      files.push({ bytes, relativePath });
    }
    if (artifactHash.digest("hex") !== expectedArtifactSha) {
      throw new Error("frozen artifact SHA mismatch");
    }
    return { errors: [], files };
  } catch (error) {
    return { errors: [`FROZEN_ARTIFACT_INVALID: ${error.message}`], files: [] };
  }
}

export async function verifyProductionSite({
  targetUrl = DEFAULT_SITE_URL,
  siteDir = DEFAULT_SITE_DIR,
  fetcher = fetchUrl,
  concurrency = DEFAULT_CONCURRENCY,
  frozenManifest,
  frozenArtifactShaFile,
  frozenFileCountFile,
} = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new TypeError("concurrency must be an integer between 1 and 32");
  }
  const frozenValues = [frozenManifest, frozenArtifactShaFile, frozenFileCountFile];
  const frozenCount = frozenValues.filter((value) => value !== undefined).length;
  if (frozenCount !== 0 && frozenCount !== FROZEN_OPTION_NAMES.length) {
    return {
      checkedFiles: 0,
      errors: ["FROZEN_OPTIONS_INCOMPLETE: all three frozen evidence files are required"],
      results: [],
    };
  }

  let files;
  let frozenBytes = null;
  if (frozenCount === FROZEN_OPTION_NAMES.length) {
    const frozen = await inspectFrozenArtifact({
      siteDir, frozenManifest, frozenArtifactShaFile, frozenFileCountFile,
    });
    if (frozen.errors.length > 0) {
      return { checkedFiles: 0, errors: frozen.errors, results: [] };
    }
    files = frozen.files.map(({ relativePath }) => relativePath);
    frozenBytes = new Map(frozen.files.map(({ relativePath, bytes }) => [relativePath, bytes]));
  } else {
    const localErrors = await checkSite({ siteDir });
    if (localErrors.length > 0) {
      return {
        checkedFiles: 0,
        errors: localErrors.map((issue) => `LOCAL_ARTIFACT_INVALID: ${issue}`),
        results: [],
      };
    }
    files = await collectSiteFiles(siteDir);
  }

  const baseUrl = normalizedBaseUrl(targetUrl);
  const results = await mapWithConcurrency(
    files,
    concurrency,
    async (relativePath) => {
      const localBody = frozenBytes?.get(relativePath) ??
        await readFile(path.join(siteDir, relativePath));
      const remoteUrl = remoteUrlForFile(baseUrl, relativePath);
      try {
        const response = await fetcher(remoteUrl, {
          maxBytes: Math.max(localBody.length + 1, 1024 * 1024),
        });
        return {
          relativePath,
          remoteUrl,
          response,
          errors: compareRemoteFile(relativePath, remoteUrl, localBody, response),
        };
      } catch (fetchError) {
        return {
          relativePath,
          remoteUrl,
          response: null,
          errors: [`${relativePath}: fetch failed: ${fetchError.message}`],
        };
      }
    },
  );

  return {
    checkedFiles: files.length,
    errors: results.flatMap((result) => result.errors),
    results,
  };
}

function parseCliArgs(argv) {
  const options = {};
  const valueOptions = new Map([
    ["--url", "targetUrl"],
    ["--site-dir", "siteDir"],
    ["--frozen-manifest", "frozenManifest"],
    ["--frozen-artifact-sha-file", "frozenArtifactShaFile"],
    ["--frozen-file-count-file", "frozenFileCountFile"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const optionName = valueOptions.get(argument);
    if (optionName) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      options[optionName] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const frozenCount = FROZEN_OPTION_NAMES.filter((name) => options[name] !== undefined).length;
  if (frozenCount !== 0 && frozenCount !== FROZEN_OPTION_NAMES.length) {
    throw new Error("--frozen-manifest, --frozen-artifact-sha-file, and --frozen-file-count-file must be provided together");
  }
  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const targetUrl = options.targetUrl ?? DEFAULT_SITE_URL;
  console.log(`Verifying production artifact: ${targetUrl}`);
  const verification = await verifyProductionSite(options);
  if (verification.errors.length > 0) {
    console.error(
      `✗ Production verification failed (${verification.errors.length} error${verification.errors.length === 1 ? "" : "s"}):`,
    );
    for (const issue of verification.errors) {
      console.error(`  ${issue}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `✓ Production byte-for-byte match confirmed for ${verification.checkedFiles} files.`,
  );
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
