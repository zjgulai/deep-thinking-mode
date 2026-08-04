#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readJsonl } from "./lib/jsonl.mjs";
import { canonicalJsonDocumentBytes } from "./lib/json.mjs";
import { CONTRACT_VERSION, validateContract } from "./lib/contracts.mjs";

const DEFAULT_ROOT_DIR = process.cwd();
const DEFAULT_CURRENT_POINTER = ".local/state/current-cleaning.json";
const DEFAULT_SOURCE_MAP_PATH = ".local/state/curation-source-ids.jsonl";
const DEFAULT_OUTPUT_PATH = ".local/reviews/batch-plan.json";
const DEFAULT_PILOT_SOURCE_COUNT = 28;

const BATCH_IDS = [
  "B01", "B02", "B03a", "B03b", "B04", "B05",
  "B06a", "B06b", "B07", "B08a", "B08b", "B09",
  "B10a", "B10b", "B11", "B12"
];

function usage() {
  return `Usage:\n` +
    `  node tools/build-curation-batch-plan.mjs [options]\n\n` +
    `Options:\n` +
    `  --root <path>\n` +
    `  --current-pointer <path>\n` +
    `  --source-map <path>\n` +
    `  --output <path>\n` +
    `  --pilot-count <number>\n` +
    `  --pilot-source-ids <path-or-json>`;
}

function parseArgv(argv) {
  const options = {
    rootDir: DEFAULT_ROOT_DIR,
    currentPointer: DEFAULT_CURRENT_POINTER,
    sourceMapPath: DEFAULT_SOURCE_MAP_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    pilotCount: DEFAULT_PILOT_SOURCE_COUNT,
    pilotSourceIdsPath: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (token.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for ${token}`);
      }
      index += 1;

      if (token === "--root") {
        options.rootDir = value;
        continue;
      }
      if (token === "--current-pointer") {
        options.currentPointer = value;
        continue;
      }
      if (token === "--source-map") {
        options.sourceMapPath = value;
        continue;
      }
      if (token === "--output") {
        options.outputPath = value;
        continue;
      }
      if (token === "--pilot-count") {
        const pilotCount = Number.parseInt(value, 10);
        if (!Number.isFinite(pilotCount) || pilotCount < 0) {
          throw new Error(`invalid --pilot-count: ${value}`);
        }
        options.pilotCount = pilotCount;
        continue;
      }
      if (token === "--pilot-source-ids") {
        options.pilotSourceIdsPath = value;
        continue;
      }
    }
    throw new Error(`unknown argument: ${token}`);
  }

  return options;
}

async function parsePilotSourceIds(rootDir, pathOrJson, sourceIds) {
  if (!pathOrJson) return [];

  const absolute = resolve(rootDir, pathOrJson);
  const sourceIdSet = new Set(sourceIds);
  const raw = await readFile(absolute, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`invalid --pilot-source-ids payload at ${pathOrJson}`);
    error.cause = cause;
    throw error;
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`invalid --pilot-source-ids payload at ${pathOrJson}`);
  }

  const ids = [];
  const seen = new Set();
  for (const id of parsed) {
    if (typeof id === "string" && sourceIdSet.has(id) && !seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }
  return ids;
}

function assertSourceMapRecords(records) {
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`invalid source map record at line ${index + 1}`);
    }
    if (typeof record.source_id !== "string" || record.source_id.length !== 36) {
      throw new Error(`invalid source map record source_id at line ${index + 1}`);
    }
    if (seen.has(record.source_id)) {
      throw new Error(`duplicate source_id in source map: ${record.source_id}`);
    }
    seen.add(record.source_id);
  }
}

function buildAssignments(sourceIds) {
  return sourceIds.map((sourceId, index) => ({
    source_id: sourceId,
    batch_id: BATCH_IDS[index % BATCH_IDS.length],
    assignment_reason: "auto_round_robin",
    model_family_hint: null
  }));
}

function normalizePilotIds(sourceIds, pilotSourceIds, pilotCount) {
  if (pilotSourceIds.length > 0) {
    return pilotSourceIds.slice(0, pilotCount);
  }
  return sourceIds.slice(0, Math.min(sourceIds.length, pilotCount));
}

function buildBatchPlan({
  corpusVersion,
  sourceIds,
  pilotSourceIds,
  pilotCount
}) {
  const assignments = buildAssignments(sourceIds);
  return {
    schema_version: CONTRACT_VERSION,
    corpus_version: corpusVersion,
    baseline_source_count: sourceIds.length,
    current_source_count: sourceIds.length,
    pilot_source_ids: normalizePilotIds(sourceIds, pilotSourceIds, pilotCount),
    assignments,
    revisions: []
  };
}

async function run() {
  const args = parseArgv(process.argv.slice(2));
  const rootDir = resolve(args.rootDir);

  const sourceMapPath = resolve(rootDir, args.sourceMapPath);
  const sourceMap = await readJsonl(sourceMapPath);
  assertSourceMapRecords(sourceMap);

  const sourceIds = sourceMap.map((entry) => entry.source_id).sort();
  if (sourceIds.length === 0) {
    throw new Error("source map is empty");
  }

  const pilotSourceIds = await parsePilotSourceIds(rootDir, args.pilotSourceIdsPath, sourceIds)
    .catch(() => []);

  const currentPointerPath = resolve(rootDir, args.currentPointer);
  let corpusVersion = "unknown-corpus";
  try {
    const pointerRaw = await readFile(currentPointerPath, "utf8");
    const pointer = JSON.parse(pointerRaw);
    if (typeof pointer?.run_sha256 === "string" && pointer.run_sha256.length > 0) {
      corpusVersion = pointer.run_sha256;
    }
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
    corpusVersion = `count:${sourceIds.length}`;
  }

  const plan = buildBatchPlan({
    corpusVersion,
    sourceIds,
    pilotSourceIds,
    pilotCount: args.pilotCount
  });

  const outputPath = resolve(rootDir, args.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, canonicalJsonDocumentBytes(plan));

  process.stdout.write(`created batch plan with ${plan.current_source_count} sources` +
    ` and ${plan.assignments.length} assignments\n`);
}

run().catch((cause) => {
  process.stderr.write(`${cause?.message || cause}\n`);
  if (cause.code) process.stderr.write(`code: ${cause.code}\n`);
  process.exitCode = 1;
});
