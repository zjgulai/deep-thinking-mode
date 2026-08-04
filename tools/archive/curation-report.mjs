#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildKnowledgeManifest, validateKnowledgeManifest } from "./lib/knowledge-manifest.mjs";
import { readJsonl } from "./lib/jsonl.mjs";
import { validateContract } from "./lib/contracts.mjs";

const DEFAULT_ROOT_DIR = process.cwd();
const PATHS = {
  sources: "knowledge/sources.json",
  routes: "knowledge/problem-routes.json",
  manifest: "knowledge/manifest.json",
  batchDir: ".local/reviews/batches",
  batchPlan: ".local/reviews/batch-plan.json",
  summaries: ".local/analysis/source-summaries.jsonl",
  contributions: ".local/dedup/model-contributions.jsonl",
  verification: ".local/verification/records.jsonl"
};

function usage() {
  return `Usage:\n  node tools/curation-report.mjs [--all] [--root <path>] [--json]\n  node tools/curation-report.mjs --batch <batch-id> [--root <path>] [--json]\n\n--all\n  report all known knowledge status\n--batch <batch-id>\n  report one batch file\n--json\n  output report as JSON only`; 
}

function formatTimestamp() {
  return new Date().toISOString();
}

async function exists(path) {
  try {
    await readFile(path);
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

async function readOptionalJson(path) {
  if (!(await exists(path))) return null;
  return readJson(path);
}

async function readOptionalJsonl(path) {
  try {
    return await readJsonl(path);
  } catch (cause) {
    if (cause?.code === "JSONL_FORMAT_ERROR" || cause?.code === "JSONL_MISSING_EOF") {
      cause.path = path;
      throw cause;
    }
    if (cause?.code === "ENOENT") return [];
    throw cause;
  }
}

function countBy(list, getKey) {
  const result = {};
  for (const value of list) {
    const key = getKey(value);
    if (key === undefined || key === null) continue;
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function uniqueCountBy(list, getKey) {
  const values = new Set();
  for (const value of list) values.add(getKey(value));
  values.delete(undefined);
  values.delete(null);
  return values.size;
}

function sortKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const ordered = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = value[key];
  }
  return ordered;
}

function summarizeSources(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("knowledge/sources.json must be an object");
  }
  if (!Array.isArray(payload.sources)) {
    throw new Error("knowledge/sources.json.sources must be an array");
  }

  const sources = payload.sources;
  const modelIds = new Set();
  for (const source of sources) {
    if (source && Array.isArray(source.model_roles)) {
      for (const role of source.model_roles) {
        if (role && typeof role.model_id === "string") {
          modelIds.add(role.model_id);
        }
      }
    }
  }

  const byChapter = countBy(sources, (source) => source?.primary_chapter_id ?? "_null");
  const byProcessingStatus = countBy(sources, (source) => source?.processing_status);
  const byOcrStatus = countBy(sources, (source) => source?.ocr_status);
  const byMedicalReview = countBy(sources, (source) => source?.medical_review_status);
  const byLogicReview = countBy(sources, (source) => source?.logic_review_status);

  const readyWithoutModels = sources.filter((source) =>
    source?.processing_status === "ready" &&
    (!Array.isArray(source.model_roles) || source.model_roles.length === 0)
  ).length;

  return {
    total: sources.length,
    ready_count: byProcessingStatus.ready ?? 0,
    ready_without_models: readyWithoutModels,
    by_chapter: sortKeys(byChapter),
    by_processing_status: sortKeys(byProcessingStatus),
    by_ocr_status: sortKeys(byOcrStatus),
    by_medical_review_status: sortKeys(byMedicalReview),
    by_logic_review_status: sortKeys(byLogicReview),
    public_model_count: modelIds.size,
    chapters_with_sources: Object.keys(byChapter).filter((key) => key !== "_null").length
  };
}

function summarizePrivateSummaries(records) {
  const total = records.length;
  const uniqueSourceIds = uniqueCountBy(records, (record) => record?.source_id);
  const statusCounts = countBy(records, (record) => record?.summary_status);
  const evidenceModeCounts = countBy(records, (record) => record?.evidence_mode);
  return {
    total,
    unique_source_ids: uniqueSourceIds,
    by_status: sortKeys(statusCounts),
    by_evidence_mode: sortKeys(evidenceModeCounts)
  };
}

function summarizeContributions(records) {
  return {
    total: records.length,
    by_action: sortKeys(countBy(records, (record) => record?.action))
  };
}

function summarizeVerification(records) {
  return {
    total: records.length,
    by_status: sortKeys(countBy(records, (record) => record?.review_status)),
    by_source: uniqueCountBy(records, (record) => record?.source_id)
  };
}

function summarizeBatch(payload, batchId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`batch file invalid object: ${batchId}`);
  }

  const sourceIds = Array.isArray(payload.source_ids) ? payload.source_ids : [];
  const sourceUpdates = Array.isArray(payload.source_updates) ? payload.source_updates : [];
  const contributionUpdates = Array.isArray(payload.contribution_updates) ? payload.contribution_updates : [];
  const verificationUpdates = Array.isArray(payload.verification_updates) ? payload.verification_updates : [];
  const modelDrafts = Array.isArray(payload.model_drafts) ? payload.model_drafts : [];
  const sourcePublicUpdates = Array.isArray(payload.source_public_updates) ? payload.source_public_updates : [];
  const reviewDecisions = Array.isArray(payload.review_decisions) ? payload.review_decisions : [];

  const routeCandidates = payload.route_candidates && typeof payload.route_candidates === "object" ? payload.route_candidates : {};
  const routes = Array.isArray(routeCandidates.routes) ? routeCandidates.routes : [];
  const modelRelations = Array.isArray(routeCandidates.model_relations) ? routeCandidates.model_relations : [];
  const safetyRules = Array.isArray(routeCandidates.safety_rules) ? routeCandidates.safety_rules : [];
  const modelTombstones = Array.isArray(routeCandidates.model_tombstones) ? routeCandidates.model_tombstones : [];

  const sourceUpdateIds = sourceUpdates
    .map((entry) => entry && typeof entry.source_id === "string" ? entry.source_id : null)
    .filter(Boolean);
  const sourceIdSet = new Set(sourceIds);
  const sourceUpdateIdSet = new Set(sourceUpdateIds);

  return {
    batch_id: payload.batch_id ?? batchId,
    source_ids: sourceIds.length,
    source_id_set_size: sourceIdSet.size,
    source_updates: sourceUpdates.length,
    source_update_id_set_size: sourceUpdateIdSet.size,
    contribution_updates: contributionUpdates.length,
    verification_updates: verificationUpdates.length,
    model_drafts: modelDrafts.length,
    source_public_updates: sourcePublicUpdates.length,
    review_decisions: reviewDecisions.length,
    source_update_ids: [...sourceUpdateIdSet],
    route_candidates: {
      routes: routes.length,
      model_relations: modelRelations.length,
      safety_rules: safetyRules.length,
      model_tombstones: modelTombstones.length
    },
    decision_by_type: sortKeys(countBy(reviewDecisions, (entry) => entry?.type)),
    source_updates_by_action: sortKeys(countBy(sourceUpdates, (entry) => entry?.processing_status ?? entry?.action)),
    source_update_ids_unique: uniqueCountBy(sourceUpdateIds, (sourceId) => sourceId),
    source_id_alignment: {
      source_id_set_match: sourceIdSet.size === sourceUpdateIdSet.size,
      source_ids_match: sourceIds.length === sourceUpdateIds.length && sourceIds.every((id) => sourceUpdateIdSet.has(id))
    }
  };
}

function summarizeRoutes(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("knowledge/problem-routes.json must be an object");
  }

  const routes = Array.isArray(payload.routes) ? payload.routes : [];
  const modelRelations = Array.isArray(payload.model_relations) ? payload.model_relations : [];
  const safetyRules = Array.isArray(payload.safety_rules) ? payload.safety_rules : [];
  const modelTombstones = Array.isArray(payload.model_tombstones) ? payload.model_tombstones : [];

  return {
    route_count: routes.length,
    max_auxiliary_models: payload.max_auxiliary_models ?? null,
    model_relations: modelRelations.length,
    safety_rules: safetyRules.length,
    model_tombstones: modelTombstones.length,
    routes_by_priority: sortKeys(countBy(routes, (route) => route?.priority)),
    routes_by_auxiliary_count: sortKeys(countBy(routes, (route) => {
      if (!Array.isArray(route?.auxiliary_model_ids)) return "n/a";
      return String(route.auxiliary_model_ids.length);
    }))
  };
}

async function listBatchIds(rootDir, report) {
  const absolute = resolve(rootDir, PATHS.batchDir);
  try {
    const entries = await readdir(absolute, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/, ""))
      .sort();
    report.batch_count = ids.length;
    report.batch_ids = ids;
    return ids;
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      report.batch_count = 0;
      report.batch_ids = [];
      report.warnings.push("batch directory missing");
      return [];
    }
    throw cause;
  }
}

function parseArgv(argv) {
  const args = {
    scope: "all",
    rootDir: DEFAULT_ROOT_DIR,
    json: false,
    batchId: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") {
      args.help = true;
      return args;
    }

    if (token === "--all") {
      args.scope = "all";
      continue;
    }

    if (token === "--batch") {
      const batchId = argv[index + 1];
      if (!batchId) throw new Error("missing --batch value");
      args.scope = "batch";
      args.batchId = batchId;
      index += 1;
      continue;
    }

    if (token === "--root") {
      const rootDir = argv[index + 1];
      if (!rootDir) throw new Error("missing --root value");
      args.rootDir = rootDir;
      index += 1;
      continue;
    }

    if (token === "--json") {
      args.json = true;
      continue;
    }

    if (token?.startsWith("--")) {
      throw new Error(`unknown argument: ${token}`);
    }

    throw new Error(`unknown argument: ${token}`);
  }

  if (args.batchId !== null) {
    args.scope = "batch";
  }

  return args;
}

function emitText(report) {
  const lines = [
    `Curation report (${report.scope})`,
    `root: ${report.rootDir}`,
    `generated_at: ${report.generated_at}`,
    `status: ${report.status}`,
    `errors: ${report.errors.length}`,
    `warnings: ${report.warnings.length}`
  ];

  if (report.sources) {
    lines.push("", "Sources:");
    lines.push(`  total=${report.sources.total}`);
    lines.push(`  ready=${report.sources.ready_count}`);
    lines.push(`  ready_without_models=${report.sources.ready_without_models}`);
    lines.push(`  by_processing_status=${JSON.stringify(report.sources.by_processing_status)}`);
    lines.push(`  by_ocr_status=${JSON.stringify(report.sources.by_ocr_status)}`);
    lines.push(`  public_model_count=${report.sources.public_model_count}`);
  }

  if (report.private_summaries) {
    lines.push("", "Private summaries:");
    lines.push(`  total=${report.private_summaries.total}`);
    lines.push(`  unique_source_ids=${report.private_summaries.unique_source_ids}`);
    lines.push(`  by_status=${JSON.stringify(report.private_summaries.by_status)}`);
  }

  if (report.routes) {
    lines.push("", "Routes:");
    lines.push(`  route_count=${report.routes.route_count}`);
    lines.push(`  model_relations=${report.routes.model_relations}`);
    lines.push(`  safety_rules=${report.routes.safety_rules}`);
  }

  if (report.manifest) {
    lines.push("", "Manifest:");
    lines.push(`  schema_version=${report.manifest.schema_version}`);
    lines.push(`  knowledge_version=${report.manifest.knowledge_version}`);
    lines.push(`  corpus_version=${report.manifest.corpus_version}`);
    lines.push(`  current_source_count=${report.manifest.current_source_count}`);
  }

  if (report.batch_plan) {
    lines.push("", "Batch plan:");
    lines.push(`  baseline_source_count=${report.batch_plan.baseline_source_count}`);
    lines.push(`  current_source_count=${report.batch_plan.current_source_count}`);
  }

  if (report.batch) {
    lines.push("", `Batch ${report.batch.batch_id}:`);
    lines.push(`  source_ids=${report.batch.source_ids}`);
    lines.push(`  source_updates=${report.batch.source_updates}`);
    lines.push(`  source_id_set_size=${report.batch.source_id_set_size}`);
    lines.push(`  source_update_id_set_size=${report.batch.source_update_id_set_size}`);
    lines.push(`  review_decisions=${report.batch.review_decisions}`);
    lines.push(`  route_candidates=${JSON.stringify(report.batch.route_candidates)}`);
    if (report.batch.source_id_alignment) {
      if (!report.batch.source_id_alignment.source_ids_match) {
        lines.push("  WARN: source_ids list does not match source_updates source_id list");
      }
      if (!report.batch.source_id_alignment.source_id_set_match) {
        lines.push("  WARN: source_ids set does not match source_updates source_id set");
      }
    }
  }

  if (Array.isArray(report.batch_ids)) {
    lines.push("", `Batches: ${report.batch_ids.length}`);
    if (report.batch_ids.length <= 8) {
      lines.push(`  ids=${report.batch_ids.join(",")}`);
    } else {
      lines.push(`  ids=${report.batch_ids.slice(0, 8).join(",")},...`);
    }
  }

  if (report.errors.length) {
    lines.push("", "Errors:");
    for (const entry of report.errors) {
      lines.push(`- ${entry.code ? `${entry.code}: ` : ""}${entry.message}`);
    }
  }

  if (report.warnings.length) {
    lines.push("", "Warnings:");
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("\n");
  return lines.join("\n");
}

function addError(report, code, message) {
  report.status = "failed";
  report.errors.push({ code, message });
}

function addWarning(report, message) {
  report.warnings.push(message);
}

async function buildAllReport(report) {
  const rootDir = resolve(report.rootDir);

  const sourcesPayload = await readOptionalJson(resolve(rootDir, PATHS.sources));
  const summaries = await readOptionalJsonl(resolve(rootDir, PATHS.summaries));
  const contributions = await readOptionalJsonl(resolve(rootDir, PATHS.contributions));
  const verification = await readOptionalJsonl(resolve(rootDir, PATHS.verification));

  if (sourcesPayload === null) {
    addError(report, "SOURCES_MISSING", "knowledge/sources.json is missing");
  } else {
    try {
      validateContract("knowledge-sources", sourcesPayload);
      report.sources = summarizeSources(sourcesPayload);
    } catch (cause) {
      addError(report, cause.code ?? "SOURCES_INVALID", cause.message);
    }
  }

  const routesPayload = await readOptionalJson(resolve(rootDir, PATHS.routes));
  if (routesPayload === null) {
    addWarning(report, "knowledge/problem-routes.json is missing");
  } else {
    try {
      validateContract("problem-routes", routesPayload);
      report.routes = summarizeRoutes(routesPayload);
    } catch (cause) {
      addWarning(report, `problem-routes invalid: ${cause.message}`);
    }
  }

  const manifestPayload = await readOptionalJson(resolve(rootDir, PATHS.manifest));
  if (manifestPayload === null) {
    addWarning(report, "knowledge/manifest.json is missing");
  } else {
    try {
      validateKnowledgeManifest(manifestPayload);
      const derivedManifest = await buildKnowledgeManifest(rootDir);
      report.manifest = {
        schema_version: manifestPayload.schema_version,
        knowledge_version: manifestPayload.knowledge_version,
        corpus_version: manifestPayload.corpus_version,
        baseline_source_count: manifestPayload.baseline_source_count,
        current_source_count: manifestPayload.current_source_count,
        knowledge_version_matches_derived: manifestPayload.knowledge_version === derivedManifest.knowledge_version,
        corpus_version_matches_derived: manifestPayload.corpus_version === derivedManifest.corpus_version
      };
    } catch (cause) {
      addError(report, cause.code || "MANIFEST_INVALID", cause.message);
    }
  }

  try {
    report.private_summaries = summarizePrivateSummaries(summaries);
  } catch (cause) {
    addWarning(report, `source-summaries.jsonl invalid: ${cause.message}`);
  }

  if (contributions.length !== 0 || verification.length !== 0) {
    try {
      report.dedup = summarizeContributions(contributions);
      report.verification = summarizeVerification(verification);
    } catch (cause) {
      addWarning(report, `verification/contribution summaries invalid: ${cause.message}`);
    }
  }

  const planPayload = await readOptionalJson(resolve(rootDir, PATHS.batchPlan));
  if (planPayload !== null) {
    report.batch_plan = {
      schema_version: planPayload.schema_version,
      baseline_source_count: planPayload.baseline_source_count,
      current_source_count: planPayload.current_source_count,
      pilot_source_count: Array.isArray(planPayload.pilot_source_ids) ? planPayload.pilot_source_ids.length : 0,
      assignment_count: Array.isArray(planPayload.assignments) ? planPayload.assignments.length : 0
    };

    if (Array.isArray(planPayload.assignments) && planPayload.assignments.every((entry) =>
      entry && typeof entry.source_id === "string")) {
      report.batch_plan.assignment_source_ids_unique = new Set(planPayload.assignments.map((entry) => entry.source_id)).size;
    }
  }

  const batchIds = await listBatchIds(rootDir, report);
  if (batchIds.length > 0) {
    const batchReports = {};
    for (const batchId of batchIds) {
      const path = resolve(rootDir, PATHS.batchDir, `${batchId}.json`);
      const payload = await readOptionalJson(path);
      if (payload === null) {
        continue;
      }
      try {
        batchReports[batchId] = summarizeBatch(payload, batchId);
      } catch (cause) {
        batchReports[batchId] = { batch_id: batchId, error: cause.message };
      }
    }
    report.batches = batchReports;
  }

  report.generated_at = formatTimestamp();
}

async function buildBatchReport(report, batchId) {
  const rootDir = resolve(report.rootDir);
  const path = resolve(rootDir, PATHS.batchDir, `${batchId}.json`);
  const payload = await readOptionalJson(path);

  if (payload === null) {
    addError(report, "BATCH_FILE_MISSING", `batch file not found: .local/reviews/batches/${batchId}.json`);
    return;
  }

  try {
    const summarized = summarizeBatch(payload, batchId);
    report.batch = summarized;
  } catch (cause) {
    addError(report, "BATCH_INVALID", cause.message);
  }

  const planPayload = await readOptionalJson(resolve(rootDir, PATHS.batchPlan));
  if (planPayload !== null && Array.isArray(planPayload.assignments)) {
    const assigned = planPayload.assignments
      .filter((entry) => entry && typeof entry.batch_id === "string")
      .filter((entry) => entry.batch_id === batchId)
      .map((entry) => entry.source_id)
      .filter((value) => typeof value === "string");

    report.batch_plan = {
      schema_version: planPayload.schema_version,
      baseline_source_count: planPayload.baseline_source_count,
      current_source_count: planPayload.current_source_count,
      assigned_source_count: assigned.length
    };

    if (report.batch && report.batch.source_update_id_set_size !== undefined && report.batch.source_update_id_set_size !== assigned.length) {
      addWarning(report, "assigned source count does not equal batch source update count");
    }
  }

  report.generated_at = formatTimestamp();
}

async function run() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const report = {
    scope: args.scope,
    rootDir: resolve(args.rootDir),
    generated_at: null,
    status: "ok",
    errors: [],
    warnings: []
  };

  if (args.scope === "batch") {
    await buildBatchReport(report, args.batchId);
  } else {
    await buildAllReport(report);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${emitText(report)}\n`);
  }

  if (report.status !== "ok") {
    process.exitCode = 1;
  }
}

run().catch((cause) => {
  process.stderr.write(`curation report error: ${cause.message}\n`);
  if (cause.code) process.stderr.write(`code: ${cause.code}\n`);
  process.exitCode = 1;
});
