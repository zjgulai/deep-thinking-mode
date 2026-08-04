#!/usr/bin/env node
import { randomBytes, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonl, writeJsonl } from "./lib/jsonl.mjs";
import { assertInsideLocalRoot, assertNoSymlinkTraversal } from "./lib/fs-safety.mjs";
import { canonicalizeHttpUrl } from "./lib/url-canonicalizer.mjs";

const DEFAULT_ROOT_DIR = process.cwd();
const DEFAULT_ASSETS_PATH = ".local/ocr/assets.jsonl";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 6_000_000;
const DEFAULT_MAX_REDIRECTS = 4;
const IMAGE_MIME_PREFIX = "image/";

function parsePositiveInteger(value, label) {
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return candidate;
}

function parseArgs(argv) {
  if (argv.includes("--help")) {
    return { help: true };
  }

  const parsed = {
    rootDir: DEFAULT_ROOT_DIR,
    assetsPath: DEFAULT_ASSETS_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    maxRedirects: DEFAULT_MAX_REDIRECTS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) {
      throw new Error(`unknown argument: ${token}`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${token}`);
    }
    index += 1;

    switch (token) {
      case "--root":
        parsed.rootDir = value;
        break;
      case "--assets":
        parsed.assetsPath = value;
        break;
      case "--timeout-ms":
        parsed.timeoutMs = parsePositiveInteger(value, "--timeout-ms");
        break;
      case "--max-bytes":
        parsed.maxBytes = parsePositiveInteger(value, "--max-bytes");
        break;
      case "--max-redirects":
        parsed.maxRedirects = parsePositiveInteger(value, "--max-redirects");
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }

  return parsed;
}

function mergeOptions(rawOptions = {}) {
  if (!rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new TypeError("fetch-body-images options must be an object");
  }

  const parsed = parseArgs([]);
  const unknownKeys = Object.keys(rawOptions).filter((key) => !new Set([
    "rootDir",
    "assetsPath",
    "timeoutMs",
    "maxBytes",
    "maxRedirects"
  ]).has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`unknown option key: ${unknownKeys[0]}`);
  }

  return {
    rootDir: rawOptions.rootDir ?? parsed.rootDir,
    assetsPath: rawOptions.assetsPath ?? parsed.assetsPath,
    timeoutMs: parsePositiveInteger(rawOptions.timeoutMs ?? parsed.timeoutMs, "timeoutMs"),
    maxBytes: parsePositiveInteger(rawOptions.maxBytes ?? parsed.maxBytes, "maxBytes"),
    maxRedirects: parsePositiveInteger(rawOptions.maxRedirects ?? parsed.maxRedirects, "maxRedirects")
  };
}

function ensureNonNegativeInteger(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("width and height must be a non-negative integer");
  }
  return value;
}

function inferExtensionFromMime(mimeType) {
  const value = `${mimeType}`.toLowerCase().split(";")[0].trim();
  if (!value.startsWith(IMAGE_MIME_PREFIX)) return "bin";
  if (value === "image/jpeg") return "jpg";
  if (value === "image/svg+xml") return "svg";
  return value.slice(IMAGE_MIME_PREFIX.length);
}

function validateAsset(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("asset record must be an object");
  }
  if (typeof record.asset_id !== "string" || record.asset_id.length === 0) {
    throw new Error("asset_id is required");
  }
  if (!/^src_[0-9a-f]{32}$/.test(record.source_id)) {
    throw new Error(`invalid source_id: ${record.source_id}`);
  }
  if (!Number.isInteger(record.ordinal) || record.ordinal <= 0) {
    throw new Error(`invalid ordinal for asset ${record.asset_id}`);
  }
  if (typeof record.source_url !== "string" || record.source_url.length === 0) {
    throw new Error(`asset ${record.asset_id} has invalid source_url`);
  }
  if (!["queued", "fetched", "fetch_failed"].includes(record.fetch_status)) {
    throw new Error(`asset ${record.asset_id} has invalid fetch_status`);
  }
  if (record.width !== null) ensureNonNegativeInteger(record.width);
  if (record.height !== null) ensureNonNegativeInteger(record.height);
  return record;
}

function toCanonicalMime(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().trim().split(";")[0];
  if (!normalized.startsWith(IMAGE_MIME_PREFIX)) return null;
  return normalized;
}

function toFailureAsset(asset, reason) {
  return {
    ...asset,
    fetch_status: "fetch_failed",
    local_path: null,
    sha256: null,
    mime_type: null,
    width: null,
    height: null
  };
}

function toSuccessAsset(asset, next) {
  return {
    ...asset,
    ...next,
    fetch_status: "fetched"
  };
}

function createFailure(code, message) {
  const cause = new Error(message);
  cause.code = code;
  return cause;
}

async function parseAddressSet(url) {
  const parsed = new URL(url);
  const records = await lookup(parsed.hostname, { all: true });
  const addresses = new Set(records.map((record) => record.address));
  if (addresses.size === 0) {
    throw createFailure("DNS_ERROR", "DNS lookup returned no addresses");
  }
  return addresses;
}

function sameAddressSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function assertSourceUrl(rawUrl) {
  try {
    return canonicalizeHttpUrl(rawUrl);
  } catch (cause) {
    throw new Error(`invalid source_url: ${cause.message}`);
  }
}

async function resolveSafePath(rootDir, relativePath) {
  const absolute = resolve(rootDir, relativePath);
  await assertInsideLocalRoot({ repoRoot: rootDir, candidatePath: absolute });
  await assertNoSymlinkTraversal({ repoRoot: rootDir, candidatePath: absolute });
  return absolute;
}

async function readExistingHash(absolutePath) {
  let bytes;
  try {
    bytes = await readFile(absolutePath);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function absoluteToRelative(rootDir, absolutePath) {
  const root = resolve(rootDir);
  const relativePath = relative(root, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("path escapes repository root");
  }
  return relativePath.replaceAll("\\", "/");
}

function makeDestination(digest, mimeType) {
  const extension = inferExtensionFromMime(mimeType);
  const subdir = digest.slice(0, 2);
  const fileName = `${digest}.${extension}`;
  return `.local/ocr/downloads/${subdir}/${fileName}`;
}

async function writeAtomicBytes(rootDir, relativeTarget, bytes) {
  const absoluteTarget = await resolveSafePath(rootDir, relativeTarget);
  const absoluteDirectory = dirname(absoluteTarget);

  await mkdir(absoluteDirectory, { recursive: true });

  const tempPath = `${absoluteTarget}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tempPath, bytes);
  try {
    const digest = hashBytes(bytes);
    const existingDigest = await readExistingHash(absoluteTarget);
    if (existingDigest !== null) {
      if (existingDigest !== digest) {
        throw createFailure("FETCH_DESTINATION_HASH_CONFLICT", "existing destination has different hash");
      }
      await unlink(tempPath).catch(() => undefined);
      return absoluteToRelative(rootDir, absoluteTarget);
    }

    try {
      await rename(tempPath, absoluteTarget);
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const secondCheck = await readExistingHash(absoluteTarget);
      if (secondCheck === digest) {
        await unlink(tempPath).catch(() => undefined);
        return absoluteToRelative(rootDir, absoluteTarget);
      }
      throw createFailure("FETCH_DESTINATION_HASH_CONFLICT", "existing destination has different hash");
    }

    return absoluteToRelative(rootDir, absoluteTarget);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function readResponseBytes(response, maxBytes) {
  const body = response.body;
  if (body === null) {
    throw createFailure("NETWORK_ERROR", "response has no body");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw createFailure("NETWORK_ERROR", "invalid content-length header");
    }
    if (parsed > maxBytes) {
      throw createFailure("IMAGE_TOO_LARGE", `response exceeds max bytes: ${parsed}`);
    }
  }

  const chunks = [];
  let size = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw createFailure("IMAGE_TOO_LARGE", "response exceeds max bytes");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks);
}

async function fetchAsset(asset, options) {
  const sourceUrl = assertSourceUrl(asset.source_url);
  let currentUrl = new URL(sourceUrl);
  let startUrl;
  let pinnedAddressSet;

  try {
    startUrl = new URL(sourceUrl);
    pinnedAddressSet = await parseAddressSet(startUrl);
  } catch (cause) {
    return toFailureAsset(asset, cause.code === "NETWORK_ERROR" ? "dns lookup failed" : "invalid source url");
  }

  const visited = new Set([currentUrl.href]);
  let redirects = 0;

  while (true) {
    let currentAddressSet;
    try {
      currentAddressSet = await parseAddressSet(currentUrl);
    } catch {
      return toFailureAsset(asset, "dns lookup failed");
    }
    if (!sameAddressSet(currentAddressSet, pinnedAddressSet)) {
      return toFailureAsset(asset, "dns pin mismatch");
    }

    if (canonicalizeHttpUrl(currentUrl.href) !== currentUrl.href) {
      return toFailureAsset(asset, "invalid source url");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let response;
    try {
      response = await fetch(currentUrl.href, {
        method: "GET",
        headers: { accept: "image/*" },
        redirect: "manual",
        signal: controller.signal
      });
    } catch {
      clearTimeout(timeout);
      return toFailureAsset(asset, "request failed");
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (typeof location !== "string" || location.length === 0) {
        return toFailureAsset(asset, "redirect missing location");
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return toFailureAsset(asset, "invalid redirect target");
      }
      if (nextUrl.href === currentUrl.href) {
        return toFailureAsset(asset, "redirect loop");
      }
      if (!nextUrl.origin || nextUrl.origin !== startUrl.origin) {
        return toFailureAsset(asset, "redirect changed origin");
      }
      if (redirects >= options.maxRedirects) {
        return toFailureAsset(asset, "max redirects exceeded");
      }
      if (visited.has(nextUrl.href)) {
        return toFailureAsset(asset, "redirect loop");
      }

      redirects += 1;
      visited.add(nextUrl.href);
      currentUrl = nextUrl;
      continue;
    }

    if (response.status !== 200) {
      return toFailureAsset(asset, `unexpected response ${response.status}`);
    }

    const mimeType = toCanonicalMime(response.headers.get("content-type"));
    if (mimeType === null) {
      return toFailureAsset(asset, "invalid response content-type");
    }

    let bytes;
    try {
      bytes = await readResponseBytes(response, options.maxBytes);
    } catch (cause) {
      if (cause.code === "IMAGE_TOO_LARGE") {
        return toFailureAsset(asset, "image exceeds maximum size");
      }
      return toFailureAsset(asset, "response read failed");
    }

    if (bytes.length > options.maxBytes) {
      return toFailureAsset(asset, "image exceeds maximum size");
    }

    const digest = hashBytes(bytes);
    const localPath = makeDestination(digest, mimeType);

    let relativePath;
    try {
      relativePath = await writeAtomicBytes(options.rootDir, localPath, bytes);
    } catch {
      return toFailureAsset(asset, "image write failed");
    }

    return toSuccessAsset(asset, {
      local_path: relativePath,
      sha256: digest,
      mime_type: mimeType,
      width: null,
      height: null
    });
  }
}

export async function fetchBodyImages(rawOptions = {}) {
  const options = mergeOptions(rawOptions);
  const records = await readJsonl(resolve(options.rootDir, options.assetsPath)).then((entries) =>
    entries.map((record) => validateAsset(record))
  );

  const nextRecords = [];
  let fetched = 0;
  let failed = 0;
  for (const record of records) {
    if (record.fetch_status !== "queued") {
      nextRecords.push({
        ...record,
        width: record.width === null ? null : ensureNonNegativeInteger(record.width),
        height: record.height === null ? null : ensureNonNegativeInteger(record.height)
      });
      continue;
    }

    const next = await fetchAsset(record, options);
    if (next.fetch_status === "fetched") fetched += 1;
    if (next.fetch_status === "fetch_failed") failed += 1;
    nextRecords.push(next);
  }

  const destination = resolve(options.rootDir, options.assetsPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeJsonl(destination, nextRecords);

  return {
    processed: nextRecords.length,
    fetched,
    failed
  };
}

function usage() {
  return "Usage:\n" +
    "  node tools/fetch-body-images.mjs [options]\n\n" +
    "Options:\n" +
    "  --root <path>\n" +
    "  --assets <path>\n" +
    "  --timeout-ms <ms>\n" +
    "  --max-bytes <count>\n" +
    "  --max-redirects <count>\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = 0;
  } else {
    fetchBodyImages(parsed).then((result) => {
      process.stdout.write(`fetched ${result.fetched}/${result.processed} images\n`);
    }).catch((cause) => {
      process.stderr.write(`${cause?.message || cause}\n`);
      process.exitCode = 1;
    });
  }
}
