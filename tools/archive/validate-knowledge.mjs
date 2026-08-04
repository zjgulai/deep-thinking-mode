#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { buildKnowledgeManifest, readKnowledgeSources, readProblemRoutes, validateKnowledgeManifest } from "./lib/knowledge-manifest.mjs";
import { validateContract } from "./lib/contracts.mjs";
import { readJsonl } from "./lib/jsonl.mjs";
import { readCurrentCleaningState } from "./lib/cleaning-state.mjs";

const SOURCES_PATH = ".local/analysis/source-summaries.jsonl";
const BATCH_DIR = ".local/reviews/batches";
const CURRENT_POINTER = ".local/state/current-cleaning.json";
const MANIFEST_PATH = "knowledge/manifest.json";

const PROCESSING_STATUSES = new Set([
  "new", "cleaned", "ready", "needs_review", "needs_ocr", "needs_medical_review",
  "fetch_failed", "duplicate", "superseded"
]);
const OCR_STATUSES = new Set([
  "not_required", "queued", "needs_visual_review", "approved", "rejected", "fetch_failed"
]);
const MEDICAL_STATUSES = new Set(["not_triaged", "not_applicable", "needs_expert", "approved", "rejected"]);
const LOGIC_STATUSES = new Set(["not_triaged", "not_applicable", "needs_expert", "approved", "rejected"]);
const SOURCE_ID_RE = /^src_[0-9a-f]{32}$/;
const MODEL_ROLE_RE = /^mdl-[0-9a-z-]+$/;

function usage() {
  return `Usage:
  node tools/validate-knowledge.mjs [--all] [--root <path>]
  node tools/validate-knowledge.mjs --scope sources [--root <path>]
  node tools/validate-knowledge.mjs --scope routes [--root <path>]
  node tools/validate-knowledge.mjs --batch <batch-id> [--root <path>]
  node tools/validate-knowledge.mjs --help`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

async function readJson(path) {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error(`invalid json file: ${path}`);
    error.code = "INVALID_JSON";
    error.path = path;
    throw error;
  }
}

function addError(result, code, message, path) {
  result.errors.push({ code, message, ...(path ? { path } : null) });
  result.passed = false;
}

function addWarning(result, code, message, path) {
  result.warnings.push({ code, message, ...(path ? { path } : null) });
}

function assertUnique(list, getKey, result, code, pathTemplate, suffix) {
  const seen = new Set();
  for (const item of list) {
    const key = getKey(item);
    if (seen.has(key)) {
      addError(result, code, `${suffix}重复: ${key}`, pathTemplate);
      return;
    }
    seen.add(key);
  }
}

function countBy(records, getValue) {
  const counts = Object.create(null);
  for (const record of records) {
    const key = getValue(record);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function validateSources(result, rootDir) {
  const payload = await readJson(resolve(rootDir, "knowledge/sources.json"));
  validateContract("knowledge-sources", payload);
  const sources = payload.sources;
  assertUnique(sources, (source) => source.source_id, result, "SOURCE_ID_DUPLICATE", "knowledge/sources.json", "source_id");

  const sourceById = new Map();
  for (const source of sources) {
    sourceById.set(source.source_id, source);
    if (!SOURCE_ID_RE.test(source.source_id)) {
      addError(result, "SOURCE_ID_INVALID", `invalid source_id: ${source.source_id}`, "knowledge/sources.json");
    }
    if (!PROCESSING_STATUSES.has(source.processing_status)) {
      addError(result, "SOURCE_STATUS_INVALID", `${source.source_id} processing_status invalid`, `knowledge/sources.json`);
    }
    if (!OCR_STATUSES.has(source.ocr_status)) {
      addError(result, "SOURCE_OCR_STATUS_INVALID", `${source.source_id} ocr_status invalid`, "knowledge/sources.json");
    }
    if (!MEDICAL_STATUSES.has(source.medical_review_status)) {
      addError(result, "SOURCE_MEDICAL_STATUS_INVALID", `${source.source_id} medical_review_status invalid`, "knowledge/sources.json");
    }
    if (!LOGIC_STATUSES.has(source.logic_review_status)) {
      addError(result, "SOURCE_LOGIC_STATUS_INVALID", `${source.source_id} logic_review_status invalid`, "knowledge/sources.json");
    }

    if (source.provenance_visibility === "public_synthesis_redacted") {
      if (source.author !== null || source.source_url !== null || source.published_at !== null || source.source_fingerprint !== null) {
        addError(result, "SOURCE_REDACTION_MISMATCH", `${source.source_id} must hide public fields`, `knowledge/sources.json`);
      }
    }

    if (source.processing_status === "ready") {
      if (source.primary_chapter_id === null) {
        addError(result, "SOURCE_READY_NO_CHAPTER", `${source.source_id} ready requires primary_chapter_id`, `knowledge/sources.json`);
      }
      if (!Array.isArray(source.model_roles) || source.model_roles.length === 0) {
        addError(result, "SOURCE_READY_NO_MODEL_ROLES", `${source.source_id} ready requires model_roles`, `knowledge/sources.json`);
      } else {
        for (const role of source.model_roles) {
          if (role === null || typeof role !== "object") {
            addError(result, "SOURCE_MODEL_ROLE_INVALID", `${source.source_id} model role invalid`, `knowledge/sources.json`);
            continue;
          }
          if (typeof role.model_id !== "string" || !MODEL_ROLE_RE.test(role.model_id)) {
            addError(result, "SOURCE_MODEL_ID_INVALID", `${source.source_id} model_id invalid`, `knowledge/sources.json`);
          }
        }
      }
      if (source.ocr_status !== "approved" && source.ocr_status !== "not_required") {
        addError(result, "SOURCE_READY_OCR_BLOCKED", `${source.source_id} ready must have ocr_status approved/not_required`, `knowledge/sources.json`);
      }
      if (source.medical_review_status !== "approved" && source.medical_review_status !== "not_applicable") {
        addError(result, "SOURCE_READY_MEDICAL_BLOCKED", `${source.source_id} ready must clear medical_review_status`, `knowledge/sources.json`);
      }
      if (source.logic_review_status !== "approved" && source.logic_review_status !== "not_applicable") {
        addError(result, "SOURCE_READY_LOGIC_BLOCKED", `${source.source_id} ready must clear logic_review_status`, `knowledge/sources.json`);
      }
      if (typeof source.evidence_boundary !== "string" || source.evidence_boundary.length < 1) {
        addError(result, "SOURCE_READY_MISSING_EVIDENCE_BOUNDARY", `${source.source_id} ready requires evidence_boundary`, `knowledge/sources.json`);
      }
    }
  }

  const sourceStatuses = countBy(sources, (source) => source.processing_status);
  const ocrStatuses = countBy(sources, (source) => source.ocr_status);
  const medicalStatuses = countBy(sources, (source) => source.medical_review_status);
  const logicStatuses = countBy(sources, (source) => source.logic_review_status);

  result.report.sourceCount = sources.length;
  result.report.source_status_counts = sourceStatuses;
  result.report.ocr_status_counts = ocrStatuses;
  result.report.medical_review_status_counts = medicalStatuses;
  result.report.logic_review_status_counts = logicStatuses;
  result.report.ready_source_count = sourceStatuses.ready ?? 0;

  const summaryPath = resolve(rootDir, SOURCES_PATH);
  if (await exists(summaryPath)) {
    const summaries = await readJsonl(summaryPath);
    if (summaries.length !== 0) {
      const seen = new Set();
      for (const summary of summaries) {
        try {
          validateContract("source-summary", summary);
        } catch (cause) {
          addError(result, cause.code ?? "SOURCE_SUMMARY_INVALID", `source-summary invalid: ${cause.message}`, SOURCES_PATH);
          break;
        }
        if (!SOURCE_ID_RE.test(summary.source_id)) {
          addError(result, "SOURCE_SUMMARY_SOURCE_ID_INVALID", `invalid source_summary source_id: ${summary.source_id}`, SOURCES_PATH);
        }
        if (seen.has(summary.source_id)) {
          addError(result, "SOURCE_SUMMARY_SOURCE_ID_DUPLICATE", `duplicate summary source_id: ${summary.source_id}`, SOURCES_PATH);
        }
        seen.add(summary.source_id);
      }
      result.report.private_summary_count = summaries.length;
      result.report.private_summary_ids = seen.size;
    } else {
      result.report.private_summary_count = 0;
      result.report.private_summary_ids = 0;
    }
  } else {
    addWarning(result, "PRIVATE_SUMMARY_MISSING", "source summaries not yet generated", SOURCES_PATH);
  }

  if (await exists(resolve(rootDir, CURRENT_POINTER))) {
    const state = await readCurrentCleaningState({
      rootDir: resolve(rootDir),
      currentPointer: CURRENT_POINTER,
      selectedSourceIds: []
    });
    if (state.ok) {
      const pointerSourceCount = state.value.catalog_entries?.length;
      if (Number.isInteger(pointerSourceCount)) {
        result.report.current_catalog_source_count = pointerSourceCount;
        if (await exists(resolve(rootDir, SOURCES_PATH)) && result.report.private_summary_count !== null) {
          if (result.report.private_summary_count !== pointerSourceCount) {
            addWarning(
              result,
              "SOURCE_SUMMARY_CATALOG_MISMATCH",
              `source-summary count ${result.report.private_summary_count} != catalog count ${pointerSourceCount}`,
              SOURCES_PATH
            );
          }
        }
      }
    }
  }

  result.payloadSources = sourceById;
  return result;
}

async function validateRoutes(result, rootDir) {
  const routesPath = resolve(rootDir, "knowledge/problem-routes.json");
  if (!(await exists(routesPath))) {
    addWarning(result, "PROBLEM_ROUTES_MISSING", "problem-routes.json not found", "knowledge/problem-routes.json");
    return result;
  }
  const payload = await readJson(routesPath);
  try {
    validateContract("problem-routes", payload);
  } catch (cause) {
    addError(result, cause.code || "PROBLEM_ROUTES_INVALID", `problem-routes invalid: ${cause.message}`, "knowledge/problem-routes.json");
    return result;
  }
  result.report.problem_route_count = payload.routes?.length ?? 0;
  return result;
}

async function validateManifest(result, rootDir) {
  const manifestPath = resolve(rootDir, MANIFEST_PATH);
  if (!(await exists(manifestPath))) {
    addWarning(result, "MANIFEST_MISSING", "knowledge/manifest.json not found", MANIFEST_PATH);
    return result;
  }
  const manifest = await readJson(manifestPath);
  try {
    validateKnowledgeManifest(manifest);
  } catch (cause) {
    addError(result, cause.code || "MANIFEST_INVALID", `manifest invalid: ${cause.message}`, MANIFEST_PATH);
    return result;
  }
  result.report.manifest_present = true;
  const computed = await buildKnowledgeManifest(rootDir);
  if (computed.current_source_count !== manifest.current_source_count) {
    addWarning(
      result,
      "MANIFEST_SOURCE_COUNT_DRIFT",
      `computed=${computed.current_source_count} manifest=${manifest.current_source_count}`,
      MANIFEST_PATH
    );
  }
  result.report.manifest = {
    knowledge_version: manifest.knowledge_version,
    corpus_version: manifest.corpus_version,
    current_source_count: manifest.current_source_count
  };
  return result;
}

async function validateBatch(result, rootDir, batchId) {
  const path = resolve(rootDir, BATCH_DIR, `${batchId}.json`);
  if (!(await exists(path))) {
    addError(result, "BATCH_MISSING", `batch file not found: ${batchId}`, `local/reviews/batches/${batchId}.json`);
    return result;
  }

  const batch = await readJson(path);
  if (batch?.batch_id !== undefined && batch.batch_id !== batchId) {
    addError(result, "BATCH_ID_MISMATCH", `batch file id ${batch.batch_id} != ${batchId}`, `${batchId}.json`);
  }
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
    addError(result, "BATCH_INVALID", "batch must be an object", `${batchId}.json`);
    return result;
  }

  for (const key of ["source_updates", "source_public_updates", "review_decisions"]) {
    if (batch[key] !== undefined && !Array.isArray(batch[key])) {
      addError(result, "BATCH_FIELD_INVALID", `${key} must be array`, `${batchId}.json`);
    }
  }

  const sourceUpdates = Array.isArray(batch.source_updates) ? batch.source_updates : [];
  const decisions = Array.isArray(batch.review_decisions) ? batch.review_decisions : [];
  result.report.batch_id = batchId;
  result.report.batch_source_updates = sourceUpdates.length;
  result.report.batch_review_decisions = decisions.length;
  return result;
}

async function parseArguments(argv) {
  const args = {
    scope: "all",
    rootDir: process.cwd(),
    batchId: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") return { ...args, help: true };
    if (token === "--all") {
      args.scope = "all";
      continue;
    }
    if (token === "--scope") {
      args.scope = argv[index + 1];
      if (!args.scope) throw new Error("missing --scope value");
      index += 1;
      continue;
    }
    if (token === "--root") {
      args.rootDir = argv[index + 1];
      if (!args.rootDir) throw new Error("missing --root value");
      index += 1;
      continue;
    }
    if (token === "--batch") {
      args.batchId = argv[index + 1];
      if (!args.batchId) throw new Error("missing --batch value");
      index += 1;
      continue;
    }
    if (token?.startsWith("--")) throw new Error(`unknown argument: ${token}`);
    throw new Error(`unknown argument: ${token}`);
  }

  if (args.batchId !== null) args.scope = "batch";
  return args;
}

async function run() {
  const args = await parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const rootDir = resolve(args.rootDir);
  const result = {
    scope: args.scope,
    batchId: args.batchId,
    rootDir,
    passed: true,
    errors: [],
    warnings: [],
    report: {}
  };

  if (args.scope === "sources") {
    await validateSources(result, rootDir);
  } else if (args.scope === "routes") {
    await validateRoutes(result, rootDir);
  } else if (args.scope === "manifest") {
    await validateManifest(result, rootDir);
  } else if (args.scope === "batch") {
    await validateBatch(result, rootDir, args.batchId);
  } else if (args.scope === "all" || args.scope === "full") {
    await validateSources(result, rootDir);
    await validateRoutes(result, rootDir);
    await validateManifest(result, rootDir);
  } else {
    addError(result, "INVALID_SCOPE", `unknown scope: ${args.scope}`);
  }

  if (!result.passed) {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stderr.write(`validation failed: ${result.errors.length} errors\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write(`\nvalidation passed (${result.scope})\n`);
}

run().catch((cause) => {
  process.stderr.write(`validation error: ${cause.message ?? cause}\n`);
  if (cause.code) process.stderr.write(`code: ${cause.code}\n`);
  process.exitCode = 1;
});
