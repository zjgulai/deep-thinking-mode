#!/usr/bin/env node
import { dirname, relative, resolve } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

import { readJsonl, writeJsonlBytes } from "./lib/jsonl.mjs";
import { canonicalJsonDocumentBytes } from "./lib/json.mjs";
import { validateContract, CONTRACT_VERSION } from "./lib/contracts.mjs";
import { validateSourceSummary } from "./lib/evidence.mjs";
import { sha256 } from "./lib/hash.mjs";

const DEFAULT_ROOT_DIR = process.cwd();
const DEFAULT_BATCH_PLAN_PATH = ".local/reviews/batch-plan.json";
const BATCH_PLAN_SHA_KEYS = {
  summaries: "summaries",
  contributions: "contributions",
  public_sources: "public_sources",
  problem_routes: "problem_routes",
  review_queue: "review_queue",
  verification_records: "verification_records"
};
const BATCH_TARGET_PATH_BY_NAME = {
  summaries: ".local/analysis/source-summaries.jsonl",
  contributions: ".local/dedup/model-contributions.jsonl",
  public_sources: "knowledge/sources.json",
  problem_routes: "knowledge/problem-routes.json",
  review_queue: ".local/reviews/queue.jsonl",
  verification_records: ".local/verification/records.jsonl"
};
const DEFAULT_BATCH_IDS = [
  "B01", "B02", "B03a", "B03b", "B04", "B05",
  "B06a", "B06b", "B07", "B08a", "B08b", "B09",
  "B10a", "B10b", "B11", "B12", "PILOT-28"
];
const LOCK_FILE = ".local/reviews/batch-apply.lock";
const STATE_FILE = ".local/reviews/batch-apply.state.jsonl";
const SOURCE_ID_RE = /^src_[0-9a-f]{32}$/;
const STATE_JOURNAL_SUFFIX = ".tmp-batch-apply";
const ROUTE_ARRAY_KEYS = new Set([
  "routes",
  "safety_rules",
  "model_relations",
  "model_tombstones"
]);

function usage() {
  return `Usage:
  node tools/apply-curation-batch.mjs --batch-plan <path> --batch-file <path> --dry-run
  node tools/apply-curation-batch.mjs --batch-plan <path> --batch-file <path> --apply [--root <path>]`;
}

function parseArgv(argv) {
  const options = {
    rootDir: DEFAULT_ROOT_DIR,
    batchPlanPath: DEFAULT_BATCH_PLAN_PATH,
    batchFilePath: null,
    mode: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.mode = "help";
      return options;
    }
    if (token === "--root") {
      options.rootDir = argv[index + 1];
      if (!options.rootDir) throw new Error("missing --root value");
      index += 1;
      continue;
    }
    if (token === "--batch-plan") {
      options.batchPlanPath = argv[index + 1];
      if (!options.batchPlanPath) throw new Error("missing --batch-plan value");
      index += 1;
      continue;
    }
    if (token === "--batch-file") {
      options.batchFilePath = argv[index + 1];
      if (!options.batchFilePath) throw new Error("missing --batch-file value");
      index += 1;
      continue;
    }
    if (token === "--dry-run" || token === "--apply") {
      if (options.mode !== null) {
        throw new Error("cannot combine --apply and --dry-run");
      }
      options.mode = token.slice(2);
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  if (options.batchFilePath === null) throw new Error("--batch-file is required");
  if (options.mode === null) throw new Error("missing --dry-run or --apply");
  return options;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonSafe(path, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    if (cause?.code === "ENOENT" && optional) return null;
    throw cause;
  }
}

async function readJsonlSafe(path) {
  try {
    return await readJsonl(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") return [];
    throw cause;
  }
}

async function readBytes(path, { optional = false } = {}) {
  try {
    return await readFile(path);
  } catch (cause) {
    if (optional && cause?.code === "ENOENT") return null;
    throw cause;
  }
}

function recordError(errors, code, message) {
  errors.push({ code, message });
}

function ensureSourceId(value, where, errors, code = "INVALID_SOURCE_ID") {
  if (!SOURCE_ID_RE.test(value ?? "")) {
    recordError(errors, code, where);
    return false;
  }
  return true;
}

function validateModeArgs(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [{ code: "INVALID_BATCH_PAYLOAD", message: "batch file must be an object" }];
  }
  const errors = [];
  const allowed = new Set(Object.keys(BATCH_TARGET_PATH_BY_NAME));
  if (typeof payload.batch_id !== "string" || payload.batch_id.length < 1) {
    recordError(errors, "INVALID_BATCH_ID", "batch.batch_id must be a string");
  }
  if (!Array.isArray(payload.source_ids) || payload.source_ids.length === 0) {
    recordError(errors, "INVALID_BATCH_SOURCE_IDS", "batch.source_ids must be non-empty array");
  }
  for (const arrayField of ["source_updates", "contribution_updates", "verification_updates", "model_drafts"]) {
    if (payload[arrayField] !== undefined && !Array.isArray(payload[arrayField])) {
      recordError(errors, "INVALID_BATCH_FIELD", `${arrayField} must be an array`);
    }
  }
  const routeCandidates = payload.route_candidates;
  if (routeCandidates !== undefined) {
    if (!isObject(routeCandidates)) {
      recordError(errors, "INVALID_BATCH_FIELD", "route_candidates must be an object");
    } else {
      for (const key of Object.keys(routeCandidates)) {
        if (!allowed.has(key)) continue;
        if (!Array.isArray(routeCandidates[key])) {
          recordError(errors, "INVALID_BATCH_FIELD", `route_candidates.${key} must be an array`);
        }
      }
    }
  }
  if (payload.source_public_updates !== undefined && !Array.isArray(payload.source_public_updates)) {
    recordError(errors, "INVALID_BATCH_FIELD", "source_public_updates must be an array");
  }
  if (payload.review_queue_updates !== undefined && !Array.isArray(payload.review_queue_updates)) {
    recordError(errors, "INVALID_BATCH_FIELD", "review_queue_updates must be an array");
  }
  if (payload.review_decisions !== undefined && !Array.isArray(payload.review_decisions)) {
    recordError(errors, "INVALID_BATCH_FIELD", "review_decisions must be an array");
  }
  return errors;
}

function normalizeContractPayload(path, value, errors, code = "CONTRACT_INVALID") {
  try {
    validateContract(path, value);
  } catch (cause) {
    recordError(errors, code, `${path}: ${cause.message}`);
  }
}

function buildEvidenceStore(rootSources, additionalUpdates, verificationRecords) {
  const sourceArtifacts = Object.create(null);
  for (const entry of [...rootSources, ...additionalUpdates]) {
    if (!isObject(entry) || typeof entry.source_id !== "string") continue;
    const lineCount = Number.isSafeInteger(entry.line_count) && entry.line_count > 0
      ? entry.line_count
      : 1_000_000;
    sourceArtifacts[entry.source_id] = {
      source_id: entry.source_id,
      cleaned_sha256: entry.cleaned_sha256 ?? null,
      line_count: lineCount
    };
  }
  const approved_ocr_blocks = [];
  const sourceArtifactsEntries = Object.entries(sourceArtifacts);
  for (const [sourceId, artifact] of sourceArtifactsEntries) {
    if (!artifact.cleaned_sha256) continue;
    approved_ocr_blocks.push({ source_id: sourceId });
  }
  return {
    source_artifacts: sourceArtifacts,
    verification_records: verificationRecords,
    approved_ocr_blocks
  };
}

async function validateSourceUpdates(batch, errors, existingSummaries) {
  const evidenceStore = buildEvidenceStore(existingSummaries, batch.source_updates, []);
  for (const [index, summary] of (batch.source_updates ?? []).entries()) {
    if (!isObject(summary)) {
      recordError(errors, "INVALID_SOURCE_SUMMARY", `source_updates[${index}] must be object`);
      continue;
    }
    normalizeContractPayload("source-summary", summary, errors, "SOURCE_SUMMARY_INVALID");
    if (!summary.source_id || typeof summary.source_id !== "string") {
      recordError(errors, "INVALID_SOURCE_ID", `source_updates[${index}].source_id invalid`);
      continue;
    }
    try {
      validateSourceSummary(summary, evidenceStore);
    } catch (cause) {
      recordError(errors, cause.code || "SOURCE_SUMMARY_EVIDENCE_INVALID", `source_updates[${index}].source_id=${summary.source_id}: ${cause.message}`);
    }
  }
}

function mergeByKey(existing, updates, keyOf, errors, codePrefix) {
  const map = new Map();
  const usedKeys = new Set();
  for (const item of existing) {
    const key = keyOf(item);
    if (key === null) continue;
    map.set(key, item);
  }
  for (const [index, item] of updates.entries()) {
    const key = keyOf(item);
    if (key === null) {
      recordError(errors, `${codePrefix}_INVALID_KEY`, `invalid key in update index ${index}`);
      continue;
    }
    if (usedKeys.has(key)) {
      recordError(errors, `${codePrefix}_DUPLICATE_KEY`, `duplicate update key ${key}`);
      continue;
    }
    usedKeys.add(key);
    map.set(key, item);
  }
  return { records: [...map.values()], keys: usedKeys };
}

function makeMapFromArray(records, keyOf, errors, code) {
  const map = new Map();
  for (const [index, item] of records.entries()) {
    const key = keyOf(item);
    if (key === null) {
      recordError(errors, `${code}_INVALID_KEY`, `invalid entry key at index ${index}`);
      continue;
    }
    if (map.has(key)) {
      recordError(errors, `${code}_DUPLICATE_KEY`, `duplicate key ${key}`);
    } else {
      map.set(key, item);
    }
  }
  return map;
}

function mergeRoutes(existingRoutes, updates, errors) {
  const merged = isObject(existingRoutes) ? existingRoutes : null;
  if (merged === null) {
    return {
      schema_version: CONTRACT_VERSION,
      matching_disclaimer: "",
      max_auxiliary_models: 2,
      safety_rules: [],
      model_tombstones: [],
      model_relations: [],
      routes: []
    };
  }
  const result = structuredClone(merged);
  if (updates === undefined) return result;
  const arrays = {
    routes: "route_id",
    safety_rules: "safety_rule_id",
    model_tombstones: ["retired_model_id", "successor_model_id", "reason"],
    model_relations: ["from_model_id", "to_model_id", "type"]
  };
  for (const [field, idKey] of Object.entries(arrays)) {
    const incoming = Array.isArray(updates[field]) ? updates[field] : [];
    const existing = makeMapFromArray(Array.isArray(result[field]) ? result[field] : [], (entry) => {
      if (!isObject(entry)) return null;
      if (Array.isArray(idKey)) {
        const [fromModelId, toModelId, type] = idKey;
        if (typeof entry[fromModelId] !== "string" || entry[fromModelId].length === 0) return null;
        if (typeof entry[toModelId] !== "string" || entry[toModelId].length === 0) return null;
        if (typeof entry[type] !== "string" || entry[type].length === 0) return null;
        return `${field}:${entry[fromModelId]}:${entry[toModelId]}:${entry[type]}`;
      }
      if (typeof entry[idKey] !== "string" || entry[idKey].length === 0) return null;
      return `${field}:${entry[idKey]}`;
    }, errors, `ROUTE_${field.toUpperCase()}`);
    for (const [index, entry] of incoming.entries()) {
      if (!isObject(entry)) {
        recordError(errors, "ROUTE_UPDATE_INVALID", `${field}[${index}] must be object`);
        continue;
      }
      const [fromModelId, toModelId, type] = Array.isArray(idKey) ? idKey : [];
      let relationKey = `${field}:${entry[idKey]}`;
      if (Array.isArray(idKey)) {
        if (typeof fromModelId !== "string" || typeof entry[fromModelId] !== "string" || entry[fromModelId].length === 0) {
          recordError(errors, "ROUTE_UPDATE_INVALID_ID", `${field}[${index}] requires ${fromModelId}`);
          continue;
        }
        if (typeof toModelId !== "string" || typeof entry[toModelId] !== "string" || entry[toModelId].length === 0) {
          recordError(errors, "ROUTE_UPDATE_INVALID_ID", `${field}[${index}] requires ${toModelId}`);
          continue;
        }
        if (typeof type !== "string" || typeof entry[type] !== "string" || entry[type].length === 0) {
          recordError(errors, "ROUTE_UPDATE_INVALID_ID", `${field}[${index}] requires ${type}`);
          continue;
        }
        relationKey = `${field}:${entry[fromModelId]}:${entry[toModelId]}:${entry[type]}`;
      } else if (typeof entry[idKey] !== "string" || entry[idKey].length === 0) {
        recordError(errors, "ROUTE_UPDATE_INVALID_ID", `${field}[${index}] requires ${idKey}`);
        continue;
      }
      existing.set(relationKey, entry);
    }
    result[field] = [...existing.values()].map((entry) => {
      if (!isObject(entry)) return entry;
      if (field === "routes") {
        return entry;
      }
      return entry;
    });
  }
  return result;
}

function mergeSourceUpdates(batchSourceUpdates, sourceSummaries, sourceIds) {
  const assigned = new Set(sourceIds);
  const updates = Array.isArray(batchSourceUpdates) ? batchSourceUpdates : [];
  const map = new Map();
  for (const source of sourceSummaries) {
    if (isObject(source) && typeof source.source_id === "string") {
      map.set(source.source_id, source);
    }
  }
  for (const [index, summary] of updates.entries()) {
    if (!isObject(summary)) continue;
    if (!assigned.has(summary.source_id)) continue;
    map.set(summary.source_id, summary);
  }
  return [...map.values()];
}

function mergeJsonlRecords({ errors, updates, existingRecords, sourceIds, keyName, codePrefix }) {
  const updatesArray = Array.isArray(updates) ? updates : [];
  const map = new Map();
  const consumed = [];
  for (const record of existingRecords) {
    if (!isObject(record) || typeof record.source_id !== "string") {
      continue;
    }
    map.set(record.source_id, record);
  }
  for (const [index, update] of updatesArray.entries()) {
    if (!isObject(update)) {
      recordError(errors, `${codePrefix}_INVALID`, `${keyName}[${index}] must be object`);
      continue;
    }
    if (typeof update.source_id !== "string") {
      recordError(errors, `${codePrefix}_INVALID`, `${keyName}[${index}].source_id invalid`);
      continue;
    }
    if (!sourceIds.has(update.source_id)) {
      recordError(errors, `${codePrefix}_BATCH_MISMATCH`, `${keyName}[${index}].source_id not in batch`);
      continue;
    }
    if (map.has(update.source_id)) {
      map.set(update.source_id, { ...map.get(update.source_id), ...update, source_id: update.source_id });
      consumed.push(update.source_id);
    } else {
      map.set(update.source_id, update);
      consumed.push(update.source_id);
    }
  }
  const records = [...map.values()];
  return { records, consumed };
}

function toJsonlBytes(records) {
  return writeJsonlBytes(records);
}

async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, canonicalJsonDocumentBytes({
      pid: process.pid,
      startedAt: new Date().toISOString()
    }), { flag: "wx", mode: 0o600 });
    return true;
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      return false;
    }
    throw cause;
  }
}

async function releaseLock(path) {
  try {
    await unlink(path);
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      throw cause;
    }
  }
}

async function validateAndBuildPlan(rootDir, batchPlanPath, batchFilePath) {
  const errors = [];
  const plan = await readJsonSafe(resolve(rootDir, batchPlanPath));
  if (!isObject(plan)) {
    recordError(errors, "INVALID_BATCH_PLAN", `batch plan invalid: ${batchPlanPath}`);
    return { ok: false, errors, batchPlan: null, batch: null };
  }
  const batch = await readJsonSafe(resolve(rootDir, batchFilePath));
  if (!isObject(batch)) {
    recordError(errors, "INVALID_BATCH_FILE", `batch file invalid: ${batchFilePath}`);
    return { ok: false, errors, batchPlan: plan, batch: null };
  }

  if (typeof batch.batch_id !== "string" || batch.batch_id.length < 1) {
    recordError(errors, "INVALID_BATCH_ID", "batch_id missing");
  } else if (!DEFAULT_BATCH_IDS.includes(batch.batch_id)) {
    recordError(errors, "UNKNOWN_BATCH_ID", `unsupported batch id: ${batch.batch_id}`);
  }
  if (!isObject(plan.revisions)) {
    // optional
  }
  if (!Array.isArray(plan.assignments) || plan.assignments.length === 0) {
    recordError(errors, "INVALID_BATCH_PLAN_ASSIGNMENTS", "batch plan assignments must be non-empty");
  }
  if (typeof plan.current_source_count !== "number" || !Number.isSafeInteger(plan.current_source_count)) {
    recordError(errors, "INVALID_BATCH_PLAN_COUNT", "current_source_count invalid");
  }
  if (typeof plan.schema_version !== "string") {
    recordError(errors, "INVALID_BATCH_PLAN_SCHEMA_VERSION", "schema_version missing");
  }

  const modeErrors = validateModeArgs(batch);
  errors.push(...modeErrors);

  const sourceIds = Array.isArray(batch.source_ids) ? batch.source_ids : [];
  const sourceIdSet = new Set();
  for (const sourceId of sourceIds) {
    if (!ensureSourceId(sourceId, `batch source_id ${sourceId}`, errors)) continue;
    if (sourceIdSet.has(sourceId)) recordError(errors, "DUPLICATE_SOURCE_ID", `duplicate batch source_id ${sourceId}`);
    sourceIdSet.add(sourceId);
  }

  const assignmentBySourceId = new Map();
  const assignmentByBatch = new Map();
  for (const [index, assignment] of (plan.assignments || []).entries()) {
    if (!isObject(assignment)) {
      recordError(errors, "INVALID_ASSIGNMENT", `assignments[${index}] must be object`);
      continue;
    }
    if (!ensureSourceId(assignment.source_id, `assignments[${index}].source_id`, errors)) continue;
    if (typeof assignment.batch_id !== "string" || !DEFAULT_BATCH_IDS.includes(assignment.batch_id)) {
      recordError(errors, "INVALID_ASSIGNMENT_BATCH", `assignments[${index}].batch_id`);
    } else {
      assignmentByBatch.set(assignment.batch_id, (assignmentByBatch.get(assignment.batch_id) || 0) + 1);
      assignmentBySourceId.set(assignment.source_id, assignment.batch_id);
    }
  }

  const pilotIds = new Set(Array.isArray(plan.pilot_source_ids) ? plan.pilot_source_ids : []);
  const allowedByPlan = new Set();
  for (const id of sourceIdSet) allowedByPlan.add(id);
  if (batch.batch_id.startsWith("PILOT-")) {
    for (const id of pilotIds) allowedByPlan.add(id);
    if (pilotIds.size === 0) {
      recordError(errors, "PLAN_PILOT_IDS_MISSING", "pilot batch requires pilot_source_ids");
    }
  } else if (batch.batch_id !== "PILOT-28") {
    for (const [sourceId, batchId] of assignmentBySourceId.entries()) {
      if (batchId === batch.batch_id) allowedByPlan.add(sourceId);
    }
  }

  for (const sourceId of sourceIdSet) {
    if (assignmentBySourceId.get(sourceId) !== batch.batch_id && !batch.batch_id.startsWith("PILOT-")) {
      recordError(errors, "BATCH_SCOPE_MISMATCH", `source_id ${sourceId} not assigned to batch ${batch.batch_id}`);
    }
    if (!allowedByPlan.has(sourceId)) {
      recordError(errors, "BATCH_SCOPE_MISMATCH", `${sourceId} not in batch plan scope`);
    }
  }

  const currentSources = await readJsonlSafe(resolve(rootDir, BATCH_TARGET_PATH_BY_NAME.summaries));
  const existingContributions = await readJsonlSafe(resolve(rootDir, BATCH_TARGET_PATH_BY_NAME.contributions));
  const existingVerification = await readJsonlSafe(resolve(rootDir, BATCH_TARGET_PATH_BY_NAME.verification_records));

  const existingRoutes = await readJsonSafe(resolve(rootDir, BATCH_TARGET_PATH_BY_NAME.problem_routes), { optional: true });
  const existingSourcePublic = await readJsonSafe(resolve(rootDir, BATCH_TARGET_PATH_BY_NAME.public_sources), { optional: true });
  const existingQueue = await readJsonlSafe(resolve(rootDir, BATCH_TARGET_PATH_BY_NAME.review_queue));

  if (errors.length > 0) {
    return { ok: false, errors, batchPlan: plan, batch };
  }
  await validateSourceUpdates(batch, errors, currentSources);
  if (existingRoutes && isObject(existingRoutes)) {
    try {
      validateContract("problem-routes", existingRoutes);
    } catch (cause) {
      recordError(errors, "INVALID_EXISTING_ROUTES", `problem-routes invalid: ${cause.message}`);
    }
  } else if (batch.route_candidates && batch.route_candidates.routes?.length > 0 && batch.batch_id !== "PILOT-28") {
    // if batch wants route updates, require route container exists
    recordError(errors, "ROUTE_FILE_MISSING", `missing knowledge/problem-routes.json`);
  }

  let sourcePublicPayload = existingSourcePublic;
  if (!isObject(existingSourcePublic)) {
    sourcePublicPayload = {
      schema_version: CONTRACT_VERSION,
      corpus_version: String(plan.corpus_version || "unknown"),
      sources: []
    };
    if ((Array.isArray(batch.source_public_updates) ? batch.source_public_updates.length : 0) > 0 || batch.route_candidates || batch.model_drafts?.length) {
      recordError(errors, "MISSING_PUBLIC_SOURCE_FILE", "knowledge/sources.json missing or invalid");
    }
  } else {
    try {
      normalizeContractPayload("knowledge-sources", existingSourcePublic, errors, "INVALID_EXISTING_SOURCES");
    } catch {
      // intentionally ignored: validation already recorded
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors, batchPlan: plan, batch };
  }

  const sourcePublicMap = makeMapFromArray(sourcePublicPayload?.sources || [], (source) => {
    if (!isObject(source) || typeof source.source_id !== "string") return null;
    return source.source_id;
  }, errors, "EXISTING_SOURCE_INVALID");
  for (const sourceId of sourceIdSet) {
    if (!sourcePublicMap.has(sourceId) && !batch.batch_id.startsWith("PILOT-")) {
      recordError(errors, "PUBLIC_SOURCE_MISSING", `source_id ${sourceId} missing in knowledge/sources.json`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    batchPlan: plan,
    batch,
    sourceIdSet,
    sourcePublicMap,
    currentSources,
    existingContributions,
    existingVerification,
    existingRoutes: existingRoutes || null,
    existingSourcePublic: sourcePublicPayload,
    existingQueue
  };
}

async function compareBaseSha({ batchPlan, rootDir }) {
  const mismatches = [];
  for (const [name, key] of Object.entries(BATCH_PLAN_SHA_KEYS)) {
    const expected = batchPlan?.base_sha256?.[key];
    if (!expected) continue;
    const absolute = resolve(rootDir, BATCH_TARGET_PATH_BY_NAME[name]);
    const existing = await readBytes(absolute, { optional: true });
    if (existing === null) {
      mismatches.push({
        path: BATCH_TARGET_PATH_BY_NAME[name],
        expected,
        actual: null
      });
      continue;
    }
    const actual = sha256(existing);
    if (actual !== expected) {
      mismatches.push({
        path: BATCH_TARGET_PATH_BY_NAME[name],
        expected,
        actual
      });
    }
  }
  return mismatches;
}

async function buildWrites(options) {
  const {
    batch,
    sourceIdSet,
    sourcePublicMap,
    currentSources,
    existingContributions,
    existingVerification,
    existingRoutes,
    existingSourcePublic,
    existingQueue,
    rootDir
  } = options;
  const absoluteRoot = resolve(rootDir);
  const writes = new Map();
  const errors = [];
  const warnings = [];
  const sourceIds = sourceIdSet;

  const sourceUpdates = Array.isArray(batch.source_updates) ? batch.source_updates : [];
  const sourcePublicUpdates = Array.isArray(batch.source_public_updates) ? batch.source_public_updates : [];
  const contributionUpdates = Array.isArray(batch.contribution_updates) ? batch.contribution_updates : [];
  const verificationUpdates = Array.isArray(batch.verification_updates) ? batch.verification_updates : [];
  const reviewQueueUpdates = Array.isArray(batch.review_queue_updates) ? batch.review_queue_updates : [];
  const reviewDecisions = Array.isArray(batch.review_decisions) ? batch.review_decisions : [];
  const routeCandidates = batch.route_candidates || {};
  const sourceUpdateIds = new Set();

  for (const [index, update] of sourceUpdates.entries()) {
    if (!isObject(update) || !ensureSourceId(update.source_id, `source_updates[${index}]`, errors)) {
      continue;
    }
    if (!sourceIds.has(update.source_id)) {
      recordError(errors, "SOURCE_UPDATE_SCOPE", `source_updates includes ${update.source_id} not in batch source_ids`);
      continue;
    }
    if (sourceUpdateIds.has(update.source_id)) {
      recordError(errors, "SOURCE_UPDATE_DUPLICATE", `source_updates duplicate source_id ${update.source_id}`);
      continue;
    }
    sourceUpdateIds.add(update.source_id);
  }
  if (sourceUpdateIds.size > 0 && sourceUpdateIds.size !== sourceIds.size) {
    recordError(errors, "SOURCE_UPDATE_INCOMPLETE", "source_updates must cover batch source_ids");
  }

  for (const [index, update] of sourcePublicUpdates.entries()) {
    if (!isObject(update) || !ensureSourceId(update.source_id, `source_public_updates[${index}]`, errors)) {
      continue;
    }
    if (!sourceIds.has(update.source_id)) {
      recordError(errors, "SOURCE_PUBLIC_SCOPE", `source_public_updates includes ${update.source_id} not in batch`);
      continue;
    }
    const existing = sourcePublicMap.get(update.source_id);
    if (!existing) {
      recordError(errors, "SOURCE_PUBLIC_UNKNOWN", `source_public_updates target missing from knowledge/sources.json: ${update.source_id}`);
    }
  }

  for (const [index, update] of contributionUpdates.entries()) {
    if (!isObject(update) || !ensureSourceId(update.source_id, `contribution_updates[${index}]`, errors)) {
      continue;
    }
    if (!sourceIds.has(update.source_id)) {
      recordError(errors, "CONTRIBUTION_SCOPE", `contribution_updates includes ${update.source_id} not in batch`);
    }
    if (typeof update.model_id !== "string" || update.model_id.length < 1) {
      recordError(errors, "CONTRIBUTION_INVALID_MODEL", `contribution for ${update.source_id} missing model_id`);
    }
  }

  for (const [index, update] of verificationUpdates.entries()) {
    if (!isObject(update) || typeof update.verification_id !== "string" || update.verification_id.length < 1) {
      recordError(errors, "VERIFICATION_INVALID", "verification_updates requires verification_id");
    }
    if (update.source_id && !ensureSourceId(update.source_id, `verification_updates[${index}]`, errors)) {
      continue;
    }
    if (update.source_id && !sourceIds.has(update.source_id)) {
      recordError(errors, "VERIFICATION_SCOPE", `verification_updates includes ${update.source_id} not in batch`);
    }
  }

  for (const [index, draft] of Array.isArray(batch.model_drafts) ? batch.model_drafts.entries() : []) {
    if (!isObject(draft) || typeof draft.model_id !== "string" || draft.model_id.length < 1) {
      recordError(errors, "MODEL_DRAFT_INVALID", `model_drafts[${index}] must contain model_id`);
      continue;
    }
    if (typeof draft.markdown !== "string") {
      recordError(errors, "MODEL_DRAFT_INVALID", `model_drafts[${index}] markdown must be string`);
    }
    if (draft.expected_old_sha256 !== null && draft.expected_old_sha256 !== undefined &&
      (typeof draft.expected_old_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(draft.expected_old_sha256))) {
      recordError(errors, "MODEL_DRAFT_INVALID_HASH", `model_drafts[${index}].expected_old_sha256`);
      continue;
    }
    if (typeof draft.expected_old_sha256 === "string") {
      const existingModel = await readBytes(resolve(absoluteRoot, `knowledge/models/${draft.model_id}.md`), { optional: true });
      if (existingModel === null) {
        recordError(errors, "MODEL_DRAFT_MISSING_TARGET", `model_drafts[${index}] expected_old_sha256 requires existing file knowledge/models/${draft.model_id}.md`);
      } else if (sha256(existingModel) !== draft.expected_old_sha256) {
        recordError(errors, "MODEL_DRAFT_HASH_MISMATCH", `model_drafts[${index}] expected_old_sha256 mismatch`);
      }
    }
  }

  if (!isObject(routeCandidates)) {
    recordError(errors, "ROUTE_CANDIDATES_INVALID", "route_candidates must be object");
  } else {
    for (const key of Object.keys(routeCandidates)) {
      if (!ROUTE_ARRAY_KEYS.has(key)) {
        recordError(errors, "ROUTE_CANDIDATES_INVALID", `route_candidates has unexpected key ${key}`);
        continue;
      }
      if (!Array.isArray(routeCandidates[key])) {
        recordError(errors, "ROUTE_CANDIDATES_INVALID", `${key} must be an array`);
      }
    }
  }

  const mergedSources = mergeSourceUpdates(sourceUpdates, currentSources, sourceIds);
  const sourceSummariesBytes = toJsonlBytes(mergedSources.sort((left, right) => left.source_id.localeCompare(right.source_id)));
  writes.set(resolve(absoluteRoot, BATCH_TARGET_PATH_BY_NAME.summaries), sourceSummariesBytes);

  const mergedContrib = mergeJsonlRecords({
    errors,
    updates: contributionUpdates,
    existingRecords: existingContributions,
    sourceIds,
    keyName: "contribution_updates",
    codePrefix: "CONTRIBUTION"
  }).records;
  if (contributionUpdates.length > 0 || mergedContrib.length > 0) {
    writes.set(resolve(absoluteRoot, BATCH_TARGET_PATH_BY_NAME.contributions), toJsonlBytes(mergedContrib));
  }

  const mergedVerification = mergeJsonlRecords({
    errors,
    updates: verificationUpdates,
    existingRecords: existingVerification,
    sourceIds,
    keyName: "verification_updates",
    codePrefix: "VERIFICATION"
  }).records;
  if (verificationUpdates.length > 0 || mergedVerification.length > 0) {
    writes.set(resolve(absoluteRoot, BATCH_TARGET_PATH_BY_NAME.verification_records), toJsonlBytes(mergedVerification));
  }

  const sourcePublicSources = isObject(existingSourcePublic)
    ? structuredClone(existingSourcePublic)
    : { schema_version: CONTRACT_VERSION, corpus_version: "unknown", sources: [] };
  const sourcePublicById = new Map();
  for (const source of sourcePublicSources.sources) {
    if (isObject(source) && typeof source.source_id === "string") {
      sourcePublicById.set(source.source_id, source);
    }
  }
  for (const [index, sourceUpdate] of sourcePublicUpdates.entries()) {
    if (!isObject(sourceUpdate) || !ensureSourceId(sourceUpdate.source_id, `source_public_updates[${index}]`, errors)) {
      continue;
    }
    const sourceId = sourceUpdate.source_id;
    const prior = sourcePublicById.get(sourceId) || {};
    sourcePublicById.set(sourceId, { ...prior, ...sourceUpdate, source_id: sourceId });
  }
  const routeAwareSourceUpdates = sourcePublicUpdates.map((entry) => entry?.source_id).filter(Boolean);
  if (routeAwareSourceUpdates.length === 0 && sourceIdSet.size > 0) {
    warnings.push(`no source_public_updates for ${batch.batch_id}; sources file only merged by source_id keys`);
  }
  const nextPublicSources = {
    ...sourcePublicSources,
    sources: [...sourcePublicById.values()].sort((left, right) => left.source_id.localeCompare(right.source_id))
  };
  if (sourcePublicUpdates.length > 0) {
    normalizeContractPayload("knowledge-sources", nextPublicSources, errors, "SOURCE_PUBLIC_INVALID");
    writes.set(resolve(absoluteRoot, BATCH_TARGET_PATH_BY_NAME.public_sources), canonicalJsonDocumentBytes(nextPublicSources));
  }

  const mergedRoutes = mergeRoutes(existingRoutes || null, routeCandidates || {}, errors);
  if (isObject(routeCandidates)) {
    const hasRouteUpdate = Object.keys(routeCandidates).some((key) => ROUTE_ARRAY_KEYS.has(key) && Array.isArray(routeCandidates[key]) && routeCandidates[key].length > 0);
    if (hasRouteUpdate) {
      normalizeContractPayload("problem-routes", mergedRoutes, errors, "ROUTE_INVALID");
      writes.set(resolve(absoluteRoot, BATCH_TARGET_PATH_BY_NAME.problem_routes), canonicalJsonDocumentBytes(mergedRoutes));
    }
  }

  const reviewQueueMap = makeMapFromArray(existingQueue, (entry) => {
    if (!isObject(entry)) return null;
    if (typeof entry.decision_id === "string") return `decision:${entry.decision_id}`;
    return `raw:${JSON.stringify(entry)}`;
  }, errors, "REVIEW_QUEUE");
  const queueIncoming = [...reviewQueueUpdates, ...reviewDecisions];
  for (const [index, update] of queueIncoming.entries()) {
    if (!isObject(update)) {
      recordError(errors, "REVIEW_QUEUE_INVALID", `review queue entry ${index} not object`);
      continue;
    }
    const sourceId = update.source_id;
    if (sourceId && !ensureSourceId(sourceId, `review_queue[${index}]`, errors)) {
      continue;
    }
    const key = typeof update.decision_id === "string" ? `decision:${update.decision_id}` : `raw:${index}:${JSON.stringify(update)}`;
    reviewQueueMap.set(key, update);
  }
  if (queueIncoming.length > 0) {
    writes.set(resolve(absoluteRoot, BATCH_TARGET_PATH_BY_NAME.review_queue), toJsonlBytes([...reviewQueueMap.values()]));
  }

  for (const [index, draft] of Array.isArray(batch.model_drafts) ? batch.model_drafts.entries() : []) {
    if (!isObject(draft) || typeof draft.model_id !== "string" || typeof draft.markdown !== "string") continue;
    const modelPath = resolve(absoluteRoot, `knowledge/models/${draft.model_id}.md`);
    writes.set(modelPath, Buffer.from(draft.markdown, "utf8"));
  }

  return { writes, errors, warnings };
}

async function validateBaseAndWrite(rootDir, plan, writes, requireStrictMatch) {
  const mismatches = [];
  const baseExpected = plan.base_sha256 || {};
  const baseMap = {
    summaries: BATCH_TARGET_PATH_BY_NAME.summaries,
    contributions: BATCH_TARGET_PATH_BY_NAME.contributions,
    public_sources: BATCH_TARGET_PATH_BY_NAME.public_sources,
    problem_routes: BATCH_TARGET_PATH_BY_NAME.problem_routes,
    review_queue: BATCH_TARGET_PATH_BY_NAME.review_queue,
    verification_records: BATCH_TARGET_PATH_BY_NAME.verification_records
  };
  for (const [name, relativePath] of Object.entries(baseMap)) {
    const expected = baseExpected[name];
    if (!expected) continue;
    const absolute = resolve(rootDir, relativePath);
    const current = await readBytes(absolute, { optional: true });
    const actual = current === null ? null : sha256(current);
    if (actual !== expected) {
      mismatches.push({ path: relativePath, expected, actual });
    }
  }
  if (requireStrictMatch && mismatches.length > 0) {
    return { ok: false, errors: mismatches.map((entry) => ({
      code: "BASE_SHA_MISMATCH",
      message: `${entry.path} base sha256 mismatch`
    })) };
  }

  const staged = new Map();
  const changed = [];
  for (const [absolutePath, nextBytes] of writes.entries()) {
    const relativePath = relative(resolve(rootDir), absolutePath);
    const before = await readBytes(absolutePath, { optional: true });
    const beforeSha = before === null ? null : sha256(before);
    const afterSha = sha256(nextBytes);
    if (beforeSha !== afterSha) {
      staged.set(absolutePath, { before, next: nextBytes });
      changed.push(relativePath);
    }
  }
  return { ok: true, mismatches, staged, changed };
}

function makeJournalPath(rootDir) {
  return resolve(rootDir, STATE_FILE);
}

function parseJournalState(rawState) {
  if (!rawState) return [];
  const trimmed = rawState.toString().trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeJournalState(statePath, entries) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(entries, null, 0)}\n`, { mode: 0o600 });
}

async function recoverStateJournal(rootDir) {
  const statePath = makeJournalPath(rootDir);
  const raw = await readBytes(statePath, { optional: true });
  const entries = parseJournalState(raw);
  if (!raw || entries.length === 0) {
    await unlink(statePath).catch(() => void 0);
    return;
  }
  for (const entry of entries.slice().reverse()) {
    if (!isObject(entry)) continue;
    if (entry.backupPath) {
      const backup = await readBytes(entry.backupPath, { optional: true });
      if (backup !== null) {
        await mkdir(dirname(entry.path), { recursive: true });
        await writeFile(entry.path, backup);
      } else if (entry.hadTargetBefore) {
        await unlink(entry.path).catch(() => void 0);
      }
      await unlink(entry.backupPath).catch(() => void 0);
    } else {
      await unlink(entry.path).catch(() => void 0);
    }
    if (entry.tempPath) {
      await unlink(entry.tempPath).catch(() => void 0);
    }
  }
  await unlink(statePath).catch(() => void 0);
}

async function applyStagedWrites(staged, rootDir) {
  const statePath = makeJournalPath(rootDir);
  await recoverStateJournal(rootDir);
  if (staged.size === 0) {
    return { ok: true, changed: 0 };
  }
  const entries = [];
  for (const [absoluteTarget, payload] of staged.entries()) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempPath = `${absoluteTarget}${STATE_JOURNAL_SUFFIX}-${suffix}`;
    const backupPath = payload.before === null ? null : `${absoluteTarget}${STATE_JOURNAL_SUFFIX}-${suffix}.bak`;
    entries.push({
      path: absoluteTarget,
      tempPath,
      backupPath,
      hadTargetBefore: payload.before !== null,
      status: "prepared"
    });
    await mkdir(dirname(absoluteTarget), { recursive: true });
    await writeFile(tempPath, payload.next);
    if (payload.before !== null) {
      await writeFile(backupPath, payload.before);
    }
  }
  await writeJournalState(statePath, entries);
  try {
    for (const entry of entries) {
      await rename(entry.tempPath, entry.path);
      entry.status = "written";
      await writeJournalState(statePath, entries);
    }
    for (const entry of entries.slice().reverse()) {
      if (entry.backupPath && entry.hadTargetBefore) {
        await unlink(entry.backupPath).catch(() => void 0);
      }
    }
    await unlink(statePath).catch(() => void 0);
    return { ok: true, changed: entries.length };
  } catch (cause) {
    for (const entry of entries.slice().reverse()) {
      try {
        if (entry.status === "written") {
          if (entry.backupPath) {
            const backup = await readBytes(entry.backupPath, { optional: true });
            if (backup !== null) await writeFile(entry.path, backup);
          } else {
            await unlink(entry.path).catch(() => void 0);
          }
        } else if (entry.status === "prepared") {
          if (entry.hadTargetBefore) {
            const backup = await readBytes(entry.backupPath, { optional: true });
            if (backup === null) {
              await unlink(entry.path).catch(() => void 0);
            }
          } else {
            await unlink(entry.path).catch(() => void 0);
          }
        }
      } catch {
        // best effort
      }
    }
    await recoverStateJournal(rootDir);
    throw cause;
  }
}

async function run() {
  const args = parseArgv(process.argv.slice(2));
  if (args.mode === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const rootDir = resolve(args.rootDir);
  try {
    await recoverStateJournal(rootDir);
    const loaded = await validateAndBuildPlan(
      rootDir,
      args.batchPlanPath,
      args.batchFilePath
    );
    if (!loaded.ok) {
      for (const error of loaded.errors) {
        process.stderr.write(`${error.code}: ${error.message}\n`);
      }
      process.exitCode = 1;
      return;
    }
    const planResult = await buildWrites({
      batch: loaded.batch,
      sourceIdSet: loaded.sourceIdSet,
      sourcePublicMap: loaded.sourcePublicMap,
      currentSources: loaded.currentSources,
      existingContributions: loaded.existingContributions,
      existingVerification: loaded.existingVerification,
      existingRoutes: loaded.existingRoutes,
      existingSourcePublic: loaded.existingSourcePublic,
      existingQueue: loaded.existingQueue,
      rootDir
    });
    if (planResult.errors.length > 0) {
      for (const error of planResult.errors) {
        process.stderr.write(`${error.code}: ${error.message}\n`);
      }
      process.exitCode = 1;
      return;
    }
    const validation = await validateBaseAndWrite(rootDir, loaded.batchPlan, planResult.writes, args.mode === "apply");
    if (!validation.ok) {
      for (const error of validation.errors) {
        process.stderr.write(`${error.code}: ${error.message}\n`);
      }
      process.exitCode = 1;
      return;
    }
    if (args.mode === "dry-run") {
      process.stdout.write(`curation batch ${loaded.batch.batch_id} dry-run ok (${Array.from(planResult.writes.keys()).length} writes)\n`);
      if (validation.mismatches.length > 0) {
        for (const mismatch of validation.mismatches) {
          process.stdout.write(`base-sha mismatch: ${mismatch.path}\n`);
        }
      }
      if (planResult.warnings.length > 0) {
        for (const warning of planResult.warnings) {
          process.stdout.write(`warn: ${warning}\n`);
        }
      }
      return;
    }

    const lockPath = resolve(rootDir, LOCK_FILE);
    const locked = await acquireLock(lockPath);
    if (!locked) {
      process.stderr.write("BATCH_APPLY_LOCKED: another apply is running\n");
      process.exitCode = 1;
      return;
    }
    try {
      const latestMismatches = await compareBaseSha({ batchPlan: loaded.batchPlan, rootDir });
      if (latestMismatches.length > 0) {
        process.stderr.write(`BASE_SHA_MISMATCH: ${latestMismatches.map((entry) => entry.path).join(", ")}\n`);
        process.exitCode = 1;
        return;
      }
      const applyResult = await applyStagedWrites(validation.staged, rootDir);
      if (!applyResult.ok) {
        process.stderr.write(`BATCH_APPLY_FAILED: ${applyResult.error || "unknown"}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`curation batch ${loaded.batch.batch_id} applied (${applyResult.changed ?? validation.staged.size} writes)\n`);
      if (planResult.warnings.length > 0) {
        for (const warning of planResult.warnings) {
          process.stdout.write(`warn: ${warning}\n`);
        }
      }
    } finally {
      await releaseLock(lockPath);
      await unlink(resolve(rootDir, STATE_FILE)).catch(() => void 0);
    }
  } catch (cause) {
    if (cause?.code) process.stderr.write(`${cause.code}: ${cause.message}\n`);
    else process.stderr.write(`failed: ${cause?.message ?? String(cause)}\n`);
    process.exitCode = 1;
  }
}

run();
