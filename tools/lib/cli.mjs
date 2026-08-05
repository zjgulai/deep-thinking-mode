import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { cleanCorpus } from "./corpus-cleaner.mjs";
import { sha256 } from "./hash.mjs";
import { runPreflight } from "./git-baseline.mjs";
import {
  createVerifiedRawBackup
} from "./raw-backup.mjs";

const CORPUS_CONFIG = Object.freeze({
  schema_version: "1.0.0",
  baseline_commit: "f876ce90d24ed486cae4060b1a4fe7b0813e9492",
  baseline_source_count: 418,
  baseline_source_url_count: 418,
  baseline_body_image_count: 237,
  source_id_algorithm: "hmac-sha256-private-locator-first-32",
  cleaner_version: "1.0.0"
});
const CLEANER_VERSION = "1.0.0";
const SOURCE_ID_PATTERN = /^src_[0-9a-f]{32}$/;
const INPUT_FILE_ENCODING = "utf8";
const CLEAN_REQUIRED_ARGS = Object.freeze({
  "--input": "input",
  "--runs-root": "runsRoot",
  "--current-pointer": "currentPointer",
  "--key": "key"
});
const CLEAN_FLAGS = Object.freeze({
  "--strict": "strict",
  "--apply": "apply",
  "--dry-run": "dryRun"
});
const BACKUP_REQUIRED_ARGS = Object.freeze({
  "--baseline": "baseline",
  "--bundle": "bundle",
  "--manifest": "manifest",
  "--expect-count": "expectedCount",
  "--confirm": "confirmation"
});
const BACKUP_FLAGS = Object.freeze({
  "--dry-run": "dryRun",
  "--apply": "apply"
});

function failure(code, message, exitCode) {
  return { ok: false, errors: [{ code, message }], exitCode };
}

function mapExitCode(result) {
  if (result.ok) {
    return { ...result, exitCode: 0 };
  }

  const isIo = result.error?.kind === "io" || result.error?.code === "CLEANING_IO_FAILURE";
  return { ...result, exitCode: isIo ? 5 : 2 };
}

function parsePreflightArguments(args) {
  if (args.length !== 6 || args[0] !== "--mode" || args[2] !== "--root" || args[4] !== "--config") {
    return failure("CLI_ARGUMENT_INVALID", "preflight requires --mode MODE --root PATH --config PATH", 2);
  }
  if (args[1] !== "baseline" && args[1] !== "incremental") {
    return failure("CLI_ARGUMENT_INVALID", "--mode must be baseline or incremental", 2);
  }
  if (!args[3] || !args[5]) {
    return failure("CLI_ARGUMENT_INVALID", "--root and --config require values", 2);
  }
  return { mode: args[1], rootDir: resolve(args[3]), configPath: resolve(args[5]) };
}

function parseCleanArguments(args) {
  const parsed = {
    input: null,
    runsRoot: null,
    currentPointer: null,
    key: null,
    strict: false,
    apply: false,
    dryRun: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== "string" || token === "") {
      return failure("CLI_ARGUMENT_INVALID", "unknown clean argument <empty>", 2);
    }

    const requiredArgKey = CLEAN_REQUIRED_ARGS[token];
    if (requiredArgKey !== undefined) {
      const value = args[index + 1];
      if (value === undefined) {
        return failure("CLI_ARGUMENT_INVALID", `${token} requires a value`, 2);
      }
      parsed[requiredArgKey] = value;
      index += 1;
      continue;
    }

    const flagArgKey = CLEAN_FLAGS[token];
    if (flagArgKey !== undefined) {
      parsed[flagArgKey] = true;
      continue;
    }

    if (!token.startsWith("--")) {
      return failure("CLI_ARGUMENT_INVALID", `unknown clean argument ${token}`, 2);
    }

    return failure("CLI_ARGUMENT_INVALID", `unknown clean argument ${token}`, 2);
  }

  if (parsed.input === null || parsed.runsRoot === null || parsed.currentPointer === null || parsed.key === null) {
    return failure("CLI_ARGUMENT_INVALID", "clean requires --input, --runs-root, --current-pointer, --key", 2);
  }
  if (parsed.apply && parsed.dryRun) {
    return failure("CLI_ARGUMENT_INVALID", "clean cannot use --apply and --dry-run together", 2);
  }
  return parsed;
}

function parseBackupArguments(args) {
  const parsed = {
    baseline: null,
    bundle: null,
    manifest: null,
    expectedCount: null,
    confirmation: null,
    dryRun: true,
    apply: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== "string" || token === "") {
      return failure("CLI_ARGUMENT_INVALID", "unknown backup argument <empty>", 2);
    }

    const requiredArgKey = BACKUP_REQUIRED_ARGS[token];
    if (requiredArgKey !== undefined) {
      const value = args[index + 1];
      if (value === undefined) {
        return failure("CLI_ARGUMENT_INVALID", `${token} requires a value`, 2);
      }
      parsed[requiredArgKey] = value;
      index += 1;
      continue;
    }

    const flagArgKey = BACKUP_FLAGS[token];
    if (flagArgKey !== undefined) {
      if (token === "--apply") {
        parsed.apply = true;
        parsed.dryRun = false;
      } else {
        parsed.dryRun = true;
      }
      continue;
    }

    if (!token.startsWith("--")) {
      return failure("CLI_ARGUMENT_INVALID", `unknown backup argument ${token}`, 2);
    }

    return failure("CLI_ARGUMENT_INVALID", `unknown backup argument ${token}`, 2);
  }

  if (parsed.baseline === null || parsed.bundle === null || parsed.manifest === null || parsed.expectedCount === null) {
    return failure("CLI_ARGUMENT_INVALID", "backup requires --baseline --bundle --manifest --expect-count", 2);
  }
  if (!/^[0-9a-f]{40}$/.test(parsed.baseline)) {
    return failure("CLI_ARGUMENT_INVALID", "--baseline must be a full SHA", 2);
  }
  parsed.expectedCount = Number(parsed.expectedCount);
  if (!Number.isSafeInteger(parsed.expectedCount) || parsed.expectedCount <= 0) {
    return failure("CLI_ARGUMENT_INVALID", "--expect-count must be a positive integer", 2);
  }

  if (parsed.apply && parsed.dryRun) {
    return failure("CLI_ARGUMENT_INVALID", "backup cannot use --apply and --dry-run together", 2);
  }
  return parsed;
}

function asBuffer(rawBytes) {
  if (rawBytes instanceof Uint8Array) return Buffer.from(rawBytes);
  if (Array.isArray(rawBytes)) return Buffer.from(rawBytes);
  if (typeof rawBytes === "string") return Buffer.from(rawBytes, INPUT_FILE_ENCODING);
  return null;
}

function normalizeJsonInputEntry(value) {
  const inputBytes = asBuffer(value?.raw_bytes);
  if (inputBytes === null || !SOURCE_ID_PATTERN.test(value.source_id) ||
      typeof value.source_kind !== "string" ||
      (value.source_kind !== "baseline_markdown" && value.source_kind !== "markdown" &&
      value.source_kind !== "url") ||
      typeof value.locator_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.locator_sha256) ||
      typeof value.original_path !== "string" ||
      (value.ingest_status !== "registered" && value.ingest_status !== "duplicate" &&
      value.ingest_status !== "superseded") ||
      !Number.isSafeInteger(value.snapshot_version) || value.snapshot_version <= 0 ||
      (value.publication_policy !== "local_only" && value.publication_policy !== "public_metadata" &&
      value.publication_policy !== "public_synthesis_redacted")) {
    return null;
  }

  return {
    source_id: value.source_id,
    raw_bytes: inputBytes,
    source_kind: value.source_kind,
    locator_sha256: value.locator_sha256,
    original_path: value.original_path,
    ingest_status: value.ingest_status,
    snapshot_version: value.snapshot_version,
    publication_policy: value.publication_policy
  };
}

async function loadCleanInputsFromDirectory(rootDir, inputPath) {
  const absoluteInput = resolve(rootDir, inputPath);
  let relativeFilePaths;
  try {
    relativeFilePaths = await readdir(absoluteInput, { recursive: true });
  } catch (cause) {
    return { ok: false, error: failure("INPUT_READ_FAILED", `cannot read input directory: ${cause.code ?? cause.message}`, 2) };
  }

  const entries = [];
  for (const relativePath of relativeFilePaths) {
    if (!relativePath.endsWith(".md")) continue;
    const parts = relativePath.split("/");
    const sourceId = parts.at(-1).slice(0, -3);
    if (!SOURCE_ID_PATTERN.test(sourceId)) {
      return { ok: false, error: failure("INPUT_ENTRY_INVALID", `non-source path in input directory: ${relativePath}`, 2) };
    }

    const absoluteFile = resolve(absoluteInput, relativePath);
    let rawBytes;
    try {
      rawBytes = await readFile(absoluteFile);
    } catch (cause) {
      return { ok: false, error: failure("INPUT_READ_FAILED", `cannot read input source: ${cause.code ?? cause.message}`, 2) };
    }

    const originalPath = relative(resolve(rootDir), absoluteFile).replaceAll("\\", "/");
    if (originalPath === "." || originalPath === "" || originalPath.startsWith("..")) {
      return { ok: false, error: failure("INPUT_ENTRY_INVALID", `non-source path in input directory: ${relativePath}`, 2) };
    }

    entries.push({
      source_id: sourceId,
      raw_bytes: Buffer.from(rawBytes),
      source_kind: "baseline_markdown",
      locator_sha256: sha256(rawBytes),
      original_path: originalPath,
      ingest_status: "registered",
      snapshot_version: 1,
      publication_policy: "public_metadata"
    });
  }

  return { ok: true, value: entries };
}

async function loadCleanInputEntries(rootDir, inputPath) {
  const absoluteInput = resolve(rootDir, inputPath);
  let stats;
  try {
    stats = await lstat(absoluteInput);
  } catch (cause) {
    return { ok: false, error: failure("INPUT_READ_FAILED", `cannot stat input: ${cause.code ?? cause.message}`, 2) };
  }

  if (stats.isDirectory()) {
    return loadCleanInputsFromDirectory(rootDir, inputPath);
  }

  if (!stats.isFile()) {
    return { ok: false, error: failure("INPUT_PATH_INVALID", `clean --input must be a file or directory: ${inputPath}`, 2) };
  }

  let rawText;
  try {
    rawText = await readFile(absoluteInput, INPUT_FILE_ENCODING);
  } catch (cause) {
    return { ok: false, error: failure("INPUT_READ_FAILED", `cannot read input file: ${cause.code ?? cause.message}`, 2) };
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return { ok: false, error: failure("INPUT_FILE_INVALID", "input JSON is not valid", 2) };
  }

  if (!Array.isArray(payload)) {
    return { ok: false, error: failure("INPUT_FILE_INVALID", "input JSON must be an array", 2) };
  }

  const result = [];
  for (const [index, value] of payload.entries()) {
    const normalized = normalizeJsonInputEntry(value);
    if (normalized === null) {
      return { ok: false, error: failure("INPUT_FILE_INVALID", `invalid input entry at index ${index}`, 2) };
    }
    result.push(normalized);
  }

  return { ok: true, value: result };
}

function cleanSourceFallback({ rawBytes }) {
  return {
    status: "needs_review",
    outputBytes: Buffer.from(rawBytes),
    cleanedMarkdown: null,
    metadata: {
      title: null,
      author: null,
      originalStatus: null,
      publishedAt: null,
      location: null,
      sourceUrl: null
    },
    bodyImages: [],
    changes: [],
    warnings: ["NEEDS_REVIEW"],
    audit: null
  };
}

async function runClean(args, { cleanCorpusRunner }) {
  const parsed = parseCleanArguments(args);
  if (parsed.exitCode) return parsed;

  const rootDir = process.cwd();
  const inputResult = await loadCleanInputEntries(rootDir, parsed.input);
  if (!inputResult.ok) return inputResult.error;
  if (inputResult.value.length === 0) return failure("INPUT_EMPTY", "clean input has no sources", 2);

  const cleanResult = await cleanCorpusRunner({
    rootDir,
    inputEntries: inputResult.value,
    additionSourceIds: [],
    cleanerVersion: CLEANER_VERSION,
    runsRoot: parsed.runsRoot,
    currentPointer: parsed.currentPointer,
    stateMode: "initial_verified_baseline",
    strict: parsed.strict,
    apply: parsed.apply,
    dryRun: parsed.dryRun,
    cleanSource: cleanSourceFallback
  });

  return mapExitCode(cleanResult);
}

async function runBackup(args, { createVerifiedRawBackupRunner = createVerifiedRawBackup }) {
  const parsed = parseBackupArguments(args);
  if (parsed.exitCode) return parsed;

  const rootDir = process.cwd();
  let result;
  try {
    result = await createVerifiedRawBackupRunner({
      repoRoot: rootDir,
      baselineCommit: parsed.baseline,
      bundlePath: parsed.bundle,
      manifestPath: parsed.manifest,
      expectedCount: parsed.expectedCount,
      apply: parsed.apply,
      confirmation: parsed.confirmation
    });
  } catch (cause) {
    return { ok: false, errors: [{ code: "BACKUP_IO_FAILURE", message: cause.message }], exitCode: 5 };
  }

  if (result.ok) return { ...result, exitCode: 0 };
  const isMissingConfirmation = result.errors.some((item) => item.code === "BACKUP_CONFIRMATION_REQUIRED");
  return {
    ...result,
    exitCode: isMissingConfirmation ? 4 : 2
  };
}

export async function readCorpusConfig(configPath) {
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (cause) {
    return { error: failure("CONFIG_READ_FAILED", `cannot read config: ${cause.code ?? cause.message}`, 5) };
  }

  try {
    return { value: JSON.parse(source) };
  } catch {
    return { error: failure("CONFIG_INVALID", "config must be valid JSON", 2) };
  }
}

function validateCorpusConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return failure("CONFIG_INVALID", "config must exactly match the public corpus contract", 2);
  }
  const expectedKeys = Object.keys(CORPUS_CONFIG).sort();
  const actualKeys = Object.keys(config).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index]) ||
    expectedKeys.some((key) => config[key] !== CORPUS_CONFIG[key])
  ) {
    return failure("CONFIG_INVALID", "config must exactly match the public corpus contract", 2);
  }
  return null;
}

export async function runCorpusCli(args, {
  preflightRunner = runPreflight,
  cleanCorpusRunner = cleanCorpus,
  createVerifiedRawBackupRunner = createVerifiedRawBackup
} = {}) {
  if (args[0] === "preflight") {
    const parsed = parsePreflightArguments(args.slice(1));
    if (parsed.exitCode) return parsed;

    const configResult = await readCorpusConfig(parsed.configPath);
    if (configResult.error) return configResult.error;
    const config = configResult.value;
    const invalidConfig = validateCorpusConfig(config);
    if (invalidConfig) return invalidConfig;

    try {
      const result = await preflightRunner({
        mode: parsed.mode,
        rootDir: parsed.rootDir,
        expectedNodeVersion: "v24.18.0",
        expectedBranch: "main",
        baselineCommit: config.baseline_commit,
        baselineSourceCount: config.baseline_source_count
      });
      const hasIoFailure = result.errors.some((item) => item.kind === "io" || item.code === "CLEANING_IO_FAILURE");
      return { ...result, exitCode: result.ok ? 0 : hasIoFailure ? 5 : 2 };
    } catch (cause) {
      return failure("PREFLIGHT_IO_FAILED", `cannot inspect repository: ${cause.code ?? cause.message}`, 5);
    }
  }

  if (args[0] === "clean") {
    return runClean(args.slice(1), { cleanCorpusRunner });
  }

  if (args[0] === "backup") {
    return runBackup(args.slice(1), { createVerifiedRawBackupRunner });
  }

  return failure("CLI_COMMAND_INVALID", "only preflight, backup and clean are supported", 2);
}
