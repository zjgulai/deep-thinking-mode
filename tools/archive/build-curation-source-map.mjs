import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { readCurrentCleaningState } from "./lib/cleaning-state.mjs";
import { CONTRACT_VERSION, validateContract } from "./lib/contracts.mjs";
import { canonicalJsonDocumentBytes } from "./lib/json.mjs";
import { canonicalizeHttpUrl } from "./lib/url-canonicalizer.mjs";
import { readJsonl, writeJsonlBytes } from "./lib/jsonl.mjs";
import { sha256 } from "./lib/hash.mjs";

const DEFAULT_ROOT_DIR = process.cwd();
const SOURCE_ID_PREFIX = "src_";
const SOURCE_MAP_CREATED_BY = "crypto_random";
const SOURCE_ID_RE = /^src_[0-9a-f]{32}$/;
const DEFAULT_ARGS = {
  currentPointer: ".local/state/current-cleaning.json",
  sourceMapPath: ".local/state/curation-source-ids.jsonl",
  sourceSummaryPath: ".local/analysis/source-summaries.jsonl",
  modelContributionsPath: ".local/dedup/model-contributions.jsonl",
  verificationRecordsPath: ".local/verification/records.jsonl",
  reviewQueuePath: ".local/reviews/queue.jsonl",
  knowledgeSourcesPath: "knowledge/sources.json"
};

function assertOptions(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("buildCurationSourceMap options must be an object");
  }
  return {
    rootDir: options.rootDir ?? DEFAULT_ROOT_DIR,
    currentPointer: options.currentPointer ?? DEFAULT_ARGS.currentPointer,
    sourceMapPath: options.sourceMapPath ?? DEFAULT_ARGS.sourceMapPath,
    sourceSummaryPath: options.sourceSummaryPath ?? DEFAULT_ARGS.sourceSummaryPath,
    modelContributionsPath: options.modelContributionsPath ?? DEFAULT_ARGS.modelContributionsPath,
    verificationRecordsPath: options.verificationRecordsPath ?? DEFAULT_ARGS.verificationRecordsPath,
    reviewQueuePath: options.reviewQueuePath ?? DEFAULT_ARGS.reviewQueuePath,
    knowledgeSourcesPath: options.knowledgeSourcesPath ?? DEFAULT_ARGS.knowledgeSourcesPath
  };
}

function parseArgv(argv) {
  const parsed = {
    rootDir: DEFAULT_ROOT_DIR,
    currentPointer: DEFAULT_ARGS.currentPointer,
    sourceMapPath: DEFAULT_ARGS.sourceMapPath,
    sourceSummaryPath: DEFAULT_ARGS.sourceSummaryPath,
    modelContributionsPath: DEFAULT_ARGS.modelContributionsPath,
    verificationRecordsPath: DEFAULT_ARGS.verificationRecordsPath,
    reviewQueuePath: DEFAULT_ARGS.reviewQueuePath,
    knowledgeSourcesPath: DEFAULT_ARGS.knowledgeSourcesPath
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    if (token === "--help") {
      const cause = new Error("usage");
      cause.code = "usage";
      throw cause;
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
      case "--current-pointer":
        parsed.currentPointer = value;
        break;
      case "--source-map":
        parsed.sourceMapPath = value;
        break;
      case "--source-summaries":
        parsed.sourceSummaryPath = value;
        break;
      case "--model-contributions":
        parsed.modelContributionsPath = value;
        break;
      case "--verification-records":
        parsed.verificationRecordsPath = value;
        break;
      case "--review-queue":
        parsed.reviewQueuePath = value;
        break;
      case "--knowledge-sources":
        parsed.knowledgeSourcesPath = value;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }

  return parsed;
}

function isSourceLocalOnly(publicationPolicy) {
  return publicationPolicy === "local_only";
}

function isImageDominant(entry) {
  return entry.content_mode === "image_dominant";
}

function isImageDominantSummary(entry) {
  return isImageDominant(entry) &&
    Array.isArray(entry.body_image_urls) &&
    entry.body_image_urls.length > 0;
}

function createSourceId() {
  return `${SOURCE_ID_PREFIX}${randomBytes(16).toString("hex")}`;
}

function isValidCurationSourceId(value) {
  return SOURCE_ID_RE.test(value);
}

function createSourceMapRecord(catalogSourceId, sourceId, createdAt) {
  return {
    schema_version: CONTRACT_VERSION,
    catalog_source_id: catalogSourceId,
    source_id: sourceId,
    created_by: SOURCE_MAP_CREATED_BY,
    created_at: createdAt
  };
}

async function loadExistingSourceMap(path) {
  try {
    return await readJsonl(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") return [];
    throw cause;
  }
}

function deriveSourceFingerprint(sourceUrl) {
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return null;
  try {
    return sha256(canonicalizeHttpUrl(sourceUrl));
  } catch {
    return null;
  }
}

function mapInitialProcessingStatus(entry, blockedOcr) {
  if (blockedOcr) return "needs_ocr";
  if (entry.processing_status === "ready" || entry.processing_status === "cleaned") return "cleaned";
  if (entry.processing_status === "needs_review" || entry.processing_status === "needs_ocr") return entry.processing_status;
  if (entry.processing_status === "needs_medical_review") return "needs_medical_review";
  if (entry.processing_status === "fetch_failed") return "fetch_failed";
  return "needs_review";
}

function mapInitialOcrStatus(entry, blockedOcr) {
  if (!isImageDominant(entry)) return "not_required";
  return blockedOcr ? "needs_visual_review" : "queued";
}

function toPublicSourceRecord(entry, sourceId, blockedOcr) {
  const provenanceVisibility = entry.publication_policy === "public_synthesis_redacted"
    ? "public_synthesis_redacted"
    : "public_metadata";
  const isRedacted = provenanceVisibility === "public_synthesis_redacted";
  const hasSourceUrl = typeof entry.source_url === "string" && entry.source_url.length > 0;

  return {
    source_id: sourceId,
    title: typeof entry.title === "string" && entry.title.length > 0 ? entry.title : "Untitled source",
    author: isRedacted ? null : (entry.author ?? null),
    published_at: null,
    date_precision: "unknown",
    source_url: isRedacted || !hasSourceUrl ? null : entry.source_url,
    source_fingerprint: isRedacted ? null : deriveSourceFingerprint(entry.source_url),
    provenance_visibility: provenanceVisibility,
    primary_chapter_id: null,
    tags: [],
    primary_content_type: null,
    model_roles: [],
    related_sources: [],
    processing_status: mapInitialProcessingStatus(entry, blockedOcr),
    ocr_status: mapInitialOcrStatus(entry, blockedOcr),
    medical_review_status: "not_applicable",
    logic_review_status: "not_applicable",
    risk_flags: [],
    evidence_boundary: null
  };
}

function toSourceSummary(entry, sourceId) {
  const isBlocked = isImageDominantSummary(entry);

  return {
    schema_version: CONTRACT_VERSION,
    source_id: sourceId,
    cleaned_sha256: entry.cleaned_sha256,
    summary_status: isBlocked ? "blocked_ocr" : "new",
    evidence_mode: isBlocked ? "none" : "cleaned_text",
    core_question: isBlocked ? null : null,
    core_conclusion: isBlocked ? null : null,
    key_concepts: [],
    mechanisms: [],
    methods: [],
    use_cases: [],
    limitations: [],
    unique_contributions: [],
    candidate_model_ids: []
  };
}

async function writeJsonl(path, records) {
  await mkdir(dirname(path), { recursive: true });
  if (records.length === 0) {
    await writeFile(path, Buffer.alloc(0));
    return;
  }
  await writeFile(path, writeJsonlBytes(records));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonicalJsonDocumentBytes(value));
}

function assertValidExistingMap(records) {
  const seenCatalogIds = new Set();
  const seenSourceIds = new Set();
  for (const record of records) {
    validateContract("curation-source-id", record);
    if (seenCatalogIds.has(record.catalog_source_id)) {
      throw new Error(`duplicate catalog_source_id in existing source map: ${record.catalog_source_id}`);
    }
    if (seenSourceIds.has(record.source_id)) {
      throw new Error(`duplicate source_id in existing source map: ${record.source_id}`);
    }
    seenCatalogIds.add(record.catalog_source_id);
    seenSourceIds.add(record.source_id);
  }
}

function assertSafeString(value, messagePrefix) {
  if (typeof value !== "string" || value.length < 1) {
    throw new Error(messagePrefix);
  }
}

export async function buildCurationSourceMap(rawOptions) {
  const options = assertOptions(rawOptions);
  const result = await readCurrentCleaningState({
    rootDir: resolve(options.rootDir),
    currentPointer: options.currentPointer,
    selectedSourceIds: []
  });
  if (!result.ok) {
    throw new Error(`unable to read current cleaning state: ${result.error.code}`);
  }

  const sourceMapPath = resolve(options.rootDir, options.sourceMapPath);
  const sourceSummaryPath = resolve(options.rootDir, options.sourceSummaryPath);
  const modelContributionsPath = resolve(options.rootDir, options.modelContributionsPath);
  const verificationRecordsPath = resolve(options.rootDir, options.verificationRecordsPath);
  const reviewQueuePath = resolve(options.rootDir, options.reviewQueuePath);
  const knowledgeSourcesPath = resolve(options.rootDir, options.knowledgeSourcesPath);

  const existingMap = await loadExistingSourceMap(sourceMapPath);
  assertValidExistingMap(existingMap);

  const mapByCatalogId = new Map();
  for (const record of existingMap) {
    mapByCatalogId.set(record.catalog_source_id, record);
  }
  const usedSourceIds = new Set(existingMap.map((record) => record.source_id));

  const catalogSourceIds = new Set();
  const createdAt = new Date().toISOString();
  const curationSourceIds = [];
  const sourceSummaries = [];
  const publicSources = [];

  for (const entry of result.value.catalog_entries) {
    const catalogSourceId = entry.source_id;
    assertSafeString(catalogSourceId, `missing catalog source id`);
    if (catalogSourceIds.has(catalogSourceId)) {
      throw new Error(`duplicate catalog source id: ${catalogSourceId}`);
    }
    catalogSourceIds.add(catalogSourceId);

    let sourceId = mapByCatalogId.get(catalogSourceId)?.source_id;
    if (sourceId === undefined) {
      do {
        sourceId = createSourceId();
      } while (!isValidCurationSourceId(sourceId) || usedSourceIds.has(sourceId));
      usedSourceIds.add(sourceId);
      mapByCatalogId.set(catalogSourceId, createSourceMapRecord(
        catalogSourceId,
        sourceId,
        createdAt
      ));
    }

    const mapRecord = mapByCatalogId.get(catalogSourceId);
    curationSourceIds.push(mapRecord);
    sourceSummaries.push(toSourceSummary(entry, sourceId));

    if (!isSourceLocalOnly(entry.publication_policy)) {
      publicSources.push(toPublicSourceRecord(entry, sourceId, isImageDominantSummary(entry)));
    }
  }

  const knowledgeSources = {
    schema_version: CONTRACT_VERSION,
    corpus_version: result.value.pointer.run_sha256,
    sources: publicSources
  };

  for (const summary of sourceSummaries) {
    validateContract("source-summary", summary);
  }
  for (const mapping of curationSourceIds) {
    validateContract("curation-source-id", mapping);
  }
  validateContract("knowledge-sources", knowledgeSources);

  await Promise.all([
    writeJsonl(sourceMapPath, curationSourceIds),
    writeJsonl(sourceSummaryPath, sourceSummaries),
    writeJsonl(modelContributionsPath, []),
    writeJsonl(verificationRecordsPath, []),
    writeJsonl(reviewQueuePath, []),
    writeJson(knowledgeSourcesPath, knowledgeSources)
  ]);

  return {
    sourceMapRecords: curationSourceIds,
    sourceSummaries,
    knowledgeSources
  };
}

function usage() {
  return `Usage:\n` +
    `  node tools/build-curation-source-map.mjs [options]\n\n` +
    `Options:\n` +
    `  --root <path>\n` +
    `  --current-pointer <path>\n` +
    `  --source-map <path>\n` +
    `  --source-summaries <path>\n` +
    `  --model-contributions <path>\n` +
    `  --verification-records <path>\n` +
    `  --review-queue <path>\n` +
    `  --knowledge-sources <path>`;
}

function runCli(argv) {
  if (argv.includes("--help")) {
    process.stdout.write(usage() + "\n");
    return Promise.resolve();
  }
  const options = parseArgv(argv);
  return buildCurationSourceMap(options).then((result) => {
    process.stdout.write(`created ${result.sourceMapRecords.length} source-id mappings and ` +
      `${result.sourceSummaries.length} source summaries\n`);
  });
}

if (process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli(process.argv.slice(2)).catch((cause) => {
    if (cause?.code === "usage") {
      process.stdout.write(usage() + "\n");
      return;
    }
    process.stderr.write(`${cause?.message || cause}\n`);
    process.exitCode = 1;
  });
}
