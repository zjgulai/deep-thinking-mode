#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCurrentCleaningState } from "./lib/cleaning-state.mjs";
import { readJsonl, writeJsonl } from "./lib/jsonl.mjs";
import { validateContract } from "./lib/contracts.mjs";
import { canonicalizeHttpUrl } from "./lib/url-canonicalizer.mjs";

const DEFAULTS = {
  rootDir: process.cwd(),
  currentPointer: ".local/state/current-cleaning.json",
  sourceMapPath: ".local/state/curation-source-ids.jsonl",
  imageDominantBaselinePath: ".local/reviews/image-dominant-baseline.json",
  sourceSummaryPath: ".local/analysis/source-summaries.jsonl",
  knowledgeSourcesPath: "knowledge/sources.json",
  assetsPath: ".local/ocr/assets.jsonl",
  resultsPath: ".local/ocr/results.jsonl"
};

const SOURCE_ID_RE = /^src_[0-9a-f]{32}$/;
const IMAGE_DOMINANT_BASELINE_COUNT = 25;
const IMAGE_DOMINANT_BASELINE_STATUSES = new Set([
  "approved",
  "needs_visual_review",
  "rejected",
  "fetch_failed"
]);
const BASELINE_STATUS_KEYS = [
  "review_status",
  "ocr_status",
  "status",
  "image_review_status",
  "visual_review_status",
  "baseline_status"
];

function assertOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("register-ocr-assets options must be an object");
  }
  const allowed = new Set([...Object.keys(DEFAULTS), "output"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError(`unknown option key: ${key}`);
    }
  }
  return {
    rootDir: options.rootDir ?? DEFAULTS.rootDir,
    currentPointer: options.currentPointer ?? DEFAULTS.currentPointer,
    sourceMapPath: options.sourceMapPath ?? DEFAULTS.sourceMapPath,
    imageDominantBaselinePath: options.imageDominantBaselinePath ?? DEFAULTS.imageDominantBaselinePath,
    sourceSummaryPath: options.sourceSummaryPath ?? DEFAULTS.sourceSummaryPath,
    knowledgeSourcesPath: options.knowledgeSourcesPath ?? DEFAULTS.knowledgeSourcesPath,
    assetsPath: options.assetsPath ?? options.output ?? DEFAULTS.assetsPath,
    resultsPath: options.resultsPath ?? DEFAULTS.resultsPath
  };
}

function validateSourceId(value, label) {
  if (!SOURCE_ID_RE.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return value;
}

function assertSchemaVersionIsKnown(value, path) {
  if (value !== "1.0.0") {
    throw new Error(`invalid schema version at ${path}`);
  }
}

function resolveSourceMaps(catalogEntries, mapRecords) {
  const catalogByCatalogId = new Map(catalogEntries.map((entry) => [entry.source_id, entry]));
  const sourceByCatalogId = new Map();
  const catalogBySourceId = new Map();

  for (const record of mapRecords) {
    validateContract("curation-source-id", record);
    const catalogSourceId = validateSourceId(record.catalog_source_id, "catalog_source_id");
    const sourceId = validateSourceId(record.source_id, "source_id");

    if (sourceByCatalogId.has(catalogSourceId)) {
      throw new Error(`duplicate catalog_source_id in source map: ${catalogSourceId}`);
    }
    if (catalogBySourceId.has(sourceId)) {
      throw new Error(`duplicate source_id in source map: ${sourceId}`);
    }
    if (!catalogByCatalogId.has(catalogSourceId)) {
      throw new Error(`source map has unknown catalog_source_id: ${catalogSourceId}`);
    }

    sourceByCatalogId.set(catalogSourceId, sourceId);
    catalogBySourceId.set(sourceId, catalogSourceId);
  }

  return { catalogByCatalogId, sourceByCatalogId, catalogBySourceId };
}

function toImageRecord({ sourceId, ordinal, sourceUrl }) {
  return {
    asset_id: `asset_${createHash("sha256").update(`${sourceId}#${ordinal}`).digest("hex").slice(0, 24)}`,
    source_id: sourceId,
    ordinal,
    source_url: sourceUrl,
    local_path: null,
    sha256: null,
    fetch_status: "queued",
    mime_type: null,
    width: null,
    height: null
  };
}

function normalizeBodyImage(value, sourceId) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing image url for source ${sourceId}`);
  }
  return canonicalizeHttpUrl(value);
}

function parseBaselineEntry(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`invalid baseline entry at index ${index}`);
  }
  const sourceId = validateSourceId(
    entry.source_id ?? entry.catalog_source_id,
    "source_id"
  );

  let status;
  for (const key of BASELINE_STATUS_KEYS) {
    if (typeof entry[key] === "string") {
      status = entry[key];
      break;
    }
  }

  if (!IMAGE_DOMINANT_BASELINE_STATUSES.has(status)) {
    throw new Error(`invalid baseline status at index ${index}`);
  }

  return [sourceId, status];
}

function mapBaselineSourceId(rawSourceId, sourceByCatalogId, catalogBySourceId) {
  const sourceId = sourceByCatalogId.get(rawSourceId);
  if (sourceId !== undefined) return sourceId;
  if (catalogBySourceId.has(rawSourceId)) return rawSourceId;
  return null;
}

async function readBaseline(rootDir, relativePath, catalogByCatalogId, sourceByCatalogId, catalogBySourceId) {
  const absolutePath = resolve(rootDir, relativePath);
  const text = await readFile(absolutePath, "utf8");

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`baseline file is not valid JSON: ${absolutePath}`);
  }

  if (!Array.isArray(payload)) {
    throw new Error(`baseline file must be an array`);
  }

  const bySourceId = new Map();
  const sourceIds = [];
  for (let index = 0; index < payload.length; index += 1) {
    const [rawSourceId, status] = parseBaselineEntry(payload[index], index);
    const sourceId = mapBaselineSourceId(rawSourceId, sourceByCatalogId, catalogBySourceId);
    if (sourceId === null) {
      throw new Error(`baseline source_id not in source map: ${rawSourceId}`);
    }

    if (bySourceId.has(sourceId)) {
      throw new Error(`duplicate source in baseline: ${sourceId}`);
    }
    const catalogSourceId = catalogBySourceId.get(sourceId);
    const catalogEntry = catalogByCatalogId.get(catalogSourceId);
    if (!catalogEntry || catalogEntry.content_mode !== "image_dominant") {
      throw new Error(`baseline source_id must be image_dominant: ${sourceId}`);
    }
    if (!Array.isArray(catalogEntry.body_image_urls) || catalogEntry.body_image_urls.length === 0) {
      throw new Error(`baseline source_id must have body images: ${sourceId}`);
    }

    bySourceId.set(sourceId, status);
    sourceIds.push(sourceId);
  }

  if (sourceIds.length !== IMAGE_DOMINANT_BASELINE_COUNT) {
    throw new Error(`baseline image-dominant set must have ${IMAGE_DOMINANT_BASELINE_COUNT} items`);
  }

  return bySourceId;
}

async function readSourceSummaries(rootDir, relativePath) {
  const absolutePath = resolve(rootDir, relativePath);
  const records = await readJsonl(absolutePath);
  const bySourceId = new Map();
  for (const summary of records) {
    validateContract("source-summary", summary);
    bySourceId.set(summary.source_id, summary);
  }
  return bySourceId;
}

async function readKnowledgeSources(path) {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text);
  assertSchemaVersionIsKnown(parsed.schema_version, path);
  validateContract("knowledge-sources", parsed);
  return parsed;
}

function hasRequiredImages(catalogEntry) {
  return catalogEntry.content_mode === "image_dominant" &&
    Array.isArray(catalogEntry.body_image_urls) &&
    catalogEntry.body_image_urls.length > 0;
}

function toBlockedSummary(summary) {
  return {
    ...summary,
    summary_status: "blocked_ocr",
    evidence_mode: "none",
    core_question: null,
    core_conclusion: null,
    key_concepts: [],
    mechanisms: [],
    methods: [],
    use_cases: [],
    limitations: [],
    unique_contributions: [],
    candidate_model_ids: []
  };
}

function updateSourceSummaryRecord(summary, hasRequiredImages, reviewStatus) {
  if (!hasRequiredImages) {
    return summary;
  }

  if (reviewStatus === "approved") {
    return {
      ...summary,
      summary_status: summary.summary_status === "blocked_ocr" ? "new" : summary.summary_status
    };
  }

  return toBlockedSummary(summary);
}

function mapKnowledgeSource(source, hasRequiredImages, reviewStatus) {
  if (!hasRequiredImages) {
    return {
      ...source,
      ocr_status: "not_required"
    };
  }

  if (reviewStatus === "approved") {
    return {
      ...source,
      ocr_status: "approved"
    };
  }

  if (reviewStatus === "needs_visual_review" || reviewStatus === "rejected" || reviewStatus === "fetch_failed") {
    return {
      ...source,
      ocr_status: reviewStatus,
      processing_status: "needs_ocr"
    };
  }

  return {
    ...source,
    ocr_status: "queued",
    processing_status: "needs_ocr"
  };
}

export async function registerOcrAssets(rawOptions = {}) {
  const options = assertOptions(rawOptions);
  const rootDir = resolve(options.rootDir);

  const result = await readCurrentCleaningState({
    rootDir,
    currentPointer: options.currentPointer,
    selectedSourceIds: []
  });
  if (!result.ok) {
    const error = new Error(`unable to read current cleaning state: ${result.error.code}`);
    error.code = result.error.code;
    throw error;
  }

  const catalogEntries = result.value.catalog_entries.map((entry) => ({
    ...entry,
    source_id: validateSourceId(entry.source_id, "catalog source_id")
  }));

  const mapRecords = await readJsonl(resolve(rootDir, options.sourceMapPath));
  const { catalogByCatalogId, sourceByCatalogId, catalogBySourceId } = resolveSourceMaps(catalogEntries, mapRecords);
  const baselineBySourceId = await readBaseline(
    rootDir,
    options.imageDominantBaselinePath,
    catalogByCatalogId,
    sourceByCatalogId,
    catalogBySourceId
  );

  const sourceSummaryById = await readSourceSummaries(rootDir, options.sourceSummaryPath);
  const knowledgeSources = await readKnowledgeSources(resolve(rootDir, options.knowledgeSourcesPath));
  const knowledgeById = new Map(
    knowledgeSources.sources.map((source) => [source.source_id, source])
  );

  const assets = [];
  const nextSourceSummaryById = new Map(sourceSummaryById);
  const nextKnowledgeById = new Map(knowledgeById);

  for (const catalogEntry of catalogEntries) {
    const sourceId = sourceByCatalogId.get(catalogEntry.source_id);
    if (sourceId === undefined) {
      throw new Error(`missing source mapping for catalog source ${catalogEntry.source_id}`);
    }

    const hasImages = hasRequiredImages(catalogEntry);
    const reviewStatus = hasImages
      ? (baselineBySourceId.get(sourceId) ?? "queued")
      : "not_required";

    if (hasImages) {
      catalogEntry.body_image_urls.forEach((candidateUrl, index) => {
        const ordinal = index + 1;
        const sourceUrl = normalizeBodyImage(candidateUrl, sourceId);
        assets.push(toImageRecord({ sourceId, ordinal, sourceUrl }));
      });
    }

    const sourceSummary = sourceSummaryById.get(sourceId);
    if (sourceSummary !== undefined) {
      nextSourceSummaryById.set(
        sourceId,
        updateSourceSummaryRecord(sourceSummary, hasImages, reviewStatus)
      );
    }

    const knowledgeSource = knowledgeById.get(sourceId);
    if (knowledgeSource !== undefined) {
      nextKnowledgeById.set(
        sourceId,
        mapKnowledgeSource(knowledgeSource, hasImages, reviewStatus)
      );
    }
  }

  const nextSourceSummaries = catalogEntries
    .map((entry) => sourceByCatalogId.get(entry.source_id))
    .map((sourceId) => {
      const summary = nextSourceSummaryById.get(sourceId);
      if (summary === undefined) {
        throw new Error(`missing source summary after update: ${sourceId}`);
      }
      return summary;
    });

  const nextKnowledgeSources = {
    ...knowledgeSources,
    sources: knowledgeSources.sources.map((source) => nextKnowledgeById.get(source.source_id) ?? source)
  };

  const assetsPath = resolve(rootDir, options.assetsPath);
  const sourceSummaryPath = resolve(rootDir, options.sourceSummaryPath);
  const knowledgePath = resolve(rootDir, options.knowledgeSourcesPath);
  const resultsPath = resolve(rootDir, options.resultsPath);

  await Promise.all([
    mkdir(dirname(assetsPath), { recursive: true }),
    mkdir(dirname(sourceSummaryPath), { recursive: true }),
    mkdir(dirname(knowledgePath), { recursive: true }),
    mkdir(dirname(resultsPath), { recursive: true })
  ]);

  await Promise.all([
    writeJsonl(assetsPath, assets),
    writeJsonl(resultsPath, []),
    writeJsonl(sourceSummaryPath, nextSourceSummaries),
    writeFile(knowledgePath, Buffer.from(JSON.stringify(nextKnowledgeSources, null, 2) + "\n"))
  ]);

  for (const summary of nextSourceSummaries) {
    validateContract("source-summary", summary);
  }
  validateContract("knowledge-sources", nextKnowledgeSources);

  return {
    assets: assets.length,
    sourceSummaries: nextSourceSummaries.length,
    sourceSummariesPath: options.sourceSummaryPath,
    knowledgeSourcesPath: options.knowledgeSourcesPath
  };
}

function usage() {
  return "Usage:\n" +
    "  node tools/register-ocr-assets.mjs [options]\\n" +
    "\n" +
    "Options:\n" +
    "  --root <path>\n" +
    "  --current-pointer <path>\n" +
    "  --source-map <path>\n" +
    "  --image-dominant-baseline <path>\n" +
    "  --source-summaries <path>\n" +
    "  --knowledge-sources <path>\n" +
    "  --assets <path>\n" +
    "  --output <path>\n" +
    "  --results <path>\n";
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("arguments must be an array");
  }

  const parsed = {
    rootDir: process.cwd(),
    currentPointer: DEFAULTS.currentPointer,
    sourceMapPath: DEFAULTS.sourceMapPath,
    imageDominantBaselinePath: DEFAULTS.imageDominantBaselinePath,
    sourceSummaryPath: DEFAULTS.sourceSummaryPath,
    knowledgeSourcesPath: DEFAULTS.knowledgeSourcesPath,
    assetsPath: DEFAULTS.assetsPath,
    resultsPath: DEFAULTS.resultsPath
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || typeof token !== "string" || !token.startsWith("--")) {
      throw new Error(`unknown argument: ${token}`);
    }

    if (token === "--help") {
      return { help: true };
    }

    const value = argv[index + 1];
    if (value === undefined) {
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
      case "--image-dominant-baseline":
        parsed.imageDominantBaselinePath = value;
        break;
      case "--source-summaries":
        parsed.sourceSummaryPath = value;
        break;
      case "--knowledge-sources":
        parsed.knowledgeSourcesPath = value;
        break;
      case "--assets":
      case "--output":
        parsed.assetsPath = value;
        break;
      case "--results":
        parsed.resultsPath = value;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }

  return parsed;
}

async function runCli(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const output = await registerOcrAssets(parsed);
  process.stdout.write(`registered ${output.assets} ocr assets\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${cause?.message || cause}\n`);
    process.exitCode = 1;
  });
}
