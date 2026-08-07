import { types } from "node:util";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  compileCleaningStateArtifacts,
  readCurrentCleaningState
} from "./cleaning-state.mjs";
import { isSha256, sha256 } from "./hash.mjs";
import { publishCleaningRun, stageCleaningRun } from "./clean-run-store.mjs";
import { canonicalJsonBytes } from "./json.mjs";

const SCHEMA_VERSION = "1.0.0";
const POINTER_RELATIVE_PATH = ".local/state/current-cleaning.json";
const RUNS_RELATIVE_PATH = ".local/cleaned/runs";
const SOURCE_ID_PATTERN = /^src_[0-9a-f]{32}$/;
const WARNING_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const OPTION_KEYS = [
  "rootDir",
  "inputEntries",
  "additionSourceIds",
  "cleanerVersion",
  "runsRoot",
  "currentPointer",
  "stateMode",
  "strict",
  "cleanSource"
];
const CLEAN_CORPUS_OPTION_KEYS = [...OPTION_KEYS, "apply"];
const INPUT_KEYS = [
  "source_id",
  "raw_bytes",
  "source_kind",
  "locator_sha256",
  "original_path",
  "ingest_status",
  "snapshot_version",
  "publication_policy"
];
const RESULT_KEYS = [
  "status",
  "outputBytes",
  "cleanedMarkdown",
  "metadata",
  "bodyImages",
  "changes",
  "warnings",
  "audit"
];
const METADATA_RESULT_KEYS = [
  "title",
  "author",
  "originalStatus",
  "publishedAt",
  "location",
  "sourceUrl"
];
const METADATA_AUDIT_KEYS = [
  "title",
  "author",
  "original_status",
  "published_at",
  "location",
  "source_url"
];
const BODY_IMAGE_KEYS = ["ordinal", "alt", "url"];

const SOURCE_KINDS = new Set(["baseline_markdown", "markdown", "url"]);
const INGEST_STATUSES = new Set(["registered", "duplicate", "superseded"]);
const PUBLICATION_POLICIES = new Set([
  "local_only",
  "public_metadata",
  "public_synthesis_redacted"
]);
const STATE_MODES = new Set(["initial_verified_baseline", "incremental"]);

function expected(code, path = null, sourceId = null) {
  return {
    ok: false,
    error: {
      kind: "expected",
      code,
      path,
      source_id: sourceId,
      persistent_writes_occurred: false
    }
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isCanonicalRepoRelativePath(value) {
  if (!isNonEmptyString(value) || value.includes("\\") || value.includes("\0")) return false;
  if (isAbsolute(value) || /^[A-Za-z]:\//.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function dataFields(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) =>
    typeof key !== "string" || !keys.includes(key))) {
    return null;
  }
  const fields = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    fields[key] = descriptor.value;
  }
  return fields;
}

function isBytes(value) {
  return !types.isProxy(value) && (Buffer.isBuffer(value) || value instanceof Uint8Array);
}

function canonicalClone(value) {
  return JSON.parse(canonicalJsonBytes(value).toString("utf8"));
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function snapshotDenseDataArray(value) {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value")) {
    return null;
  }
  const { length } = value;
  let ownIndexCount = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "length") continue;
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < length && String(index) === key) {
      ownIndexCount += 1;
    }
  }
  if (ownIndexCount !== length) return null;

  const snapshot = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    snapshot[index] = descriptor.value;
  }
  return snapshot;
}

function validateCleanCorpusOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      types.isProxy(options)) {
    throw new TypeError("options must be a plain object");
  }
  const optionsValue = dataFields(options, CLEAN_CORPUS_OPTION_KEYS);
  if (optionsValue === null) throw new TypeError("options must have the exact cleanCorpus shape");
  const { apply, ...planOptions } = optionsValue;
  if (typeof apply !== "boolean") throw new TypeError("apply must be a boolean");
  return { apply, planOptions };
}

function cleanCorpusSummaryFromPlan(plan) {
  const manifest = plan.manifest;
  const artifacts = manifest?.artifact_manifest;
  const artifactSummaries = Array.isArray(artifacts)
    ? [...artifacts]
      .sort((left, right) => compareAscii(left.relative_path, right.relative_path))
      .map(({ relative_path: relativePath, sha256: sourceSha256, size_bytes }) => ({
        relative_path: relativePath,
        sha256: sourceSha256,
        size_bytes
      }))
    : [];

  const sourceSummaries = [...manifest.run_preimage.sources]
    .sort((left, right) => compareAscii(left.source_id, right.source_id))
    .map((source) => ({
      source_id: source.source_id,
      cleaning_status: source.cleaning_status,
      processing_status: source.processing_status,
      raw_sha256: source.raw_sha256,
      cleaned_sha256: source.cleaned_sha256,
      audit_sha256: source.audit_sha256,
      warning_codes: [...source.warnings].sort()
    }));

  return {
    base: {
      expected_prior_pointer: manifest.expected_prior_pointer === null
        ? null
        : canonicalClone(manifest.expected_prior_pointer),
      expected_prior_pointer_sha256: manifest.expected_prior_pointer_sha256,
      prior_run_sha256: manifest.prior_run_sha256,
      prior_catalog_sha256: manifest.prior_catalog_sha256,
      prior_report_sha256: manifest.prior_report_sha256,
      prior_source_ids: [...manifest.prior_source_ids].sort(compareAscii)
    },
    plan_manifest_sha256: plan.manifest_sha256,
    run_sha256: manifest.desired_pointer.run_sha256,
    desired_pointer_sha256: plan.manifest.desired_pointer_sha256,
    desired_pointer: canonicalClone(manifest.desired_pointer),
    registered_source_count: manifest.registered_source_count,
    sources: sourceSummaries,
    artifacts: artifactSummaries,
    conflicts: [],
    persistent_writes_occurred: false
  };
}

function validateTopLevel(options) {
  const fields = dataFields(options, OPTION_KEYS);
  if (fields === null) throw new TypeError("options must have the exact prepare shape");
  if (!isNonEmptyString(fields.rootDir) || !Array.isArray(fields.inputEntries) ||
      types.isProxy(fields.inputEntries) || !Array.isArray(fields.additionSourceIds) ||
      types.isProxy(fields.additionSourceIds) || !isNonEmptyString(fields.cleanerVersion) ||
      !isNonEmptyString(fields.runsRoot) || !isNonEmptyString(fields.currentPointer) ||
      !STATE_MODES.has(fields.stateMode) || typeof fields.strict !== "boolean" ||
      typeof fields.cleanSource !== "function") {
    throw new TypeError("prepare options are invalid");
  }

  const requestedRoot = resolve(fields.rootDir);
  let canonicalRoot = null;
  try {
    canonicalRoot = realpathSync(fields.rootDir);
  } catch {
    // The shared reader owns the exact I/O failure if the requested root is unavailable.
  }
  const acceptedRoots = canonicalRoot === null
    ? [requestedRoot]
    : [requestedRoot, resolve(canonicalRoot)];
  const resolvedRuns = isAbsolute(fields.runsRoot)
    ? resolve(fields.runsRoot)
    : resolve(requestedRoot, fields.runsRoot);
  const resolvedPointer = isAbsolute(fields.currentPointer)
    ? resolve(fields.currentPointer)
    : resolve(requestedRoot, fields.currentPointer);
  if (!acceptedRoots.some((root) => resolvedRuns === resolve(root, RUNS_RELATIVE_PATH)) ||
      !acceptedRoots.some((root) =>
        resolvedPointer === resolve(root, POINTER_RELATIVE_PATH))) {
    throw new TypeError("prepare paths must resolve to the fixed cleaning locations");
  }
  if (canonicalRoot !== null) fields.rootDir = canonicalRoot;
  fields.runsRoot = RUNS_RELATIVE_PATH;
  fields.currentPointer = POINTER_RELATIVE_PATH;
  return fields;
}

function copyInputs(inputEntries) {
  const candidates = snapshotDenseDataArray(inputEntries);
  if (candidates === null) {
    return { failure: expected("INVALID_CLEANING_INPUT") };
  }
  const copied = [];
  const copiedBytesByIdentity = new WeakMap();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    let fields;
    try {
      fields = dataFields(candidate, INPUT_KEYS);
    } catch {
      fields = null;
    }
    const sourceId = fields !== null && typeof fields.source_id === "string" &&
      SOURCE_ID_PATTERN.test(fields.source_id)
      ? fields.source_id
      : null;
    let validBytes = false;
    try {
      validBytes = fields !== null && isBytes(fields.raw_bytes);
    } catch {
      validBytes = false;
    }
    if (fields === null || sourceId === null || !validBytes ||
        !SOURCE_KINDS.has(fields.source_kind) || !isSha256(fields.locator_sha256) ||
        !isCanonicalRepoRelativePath(fields.original_path) ||
        !fields.original_path.startsWith(".local/original/") ||
        !INGEST_STATUSES.has(fields.ingest_status) ||
        !isPositiveInteger(fields.snapshot_version) ||
        !PUBLICATION_POLICIES.has(fields.publication_policy)) {
      return { failure: expected("INVALID_CLEANING_INPUT", null, sourceId) };
    }
    let rawBytes = copiedBytesByIdentity.get(fields.raw_bytes);
    if (rawBytes === undefined) {
      rawBytes = Buffer.from(fields.raw_bytes);
      copiedBytesByIdentity.set(fields.raw_bytes, rawBytes);
    }
    copied.push({
      source_id: fields.source_id,
      raw_bytes: rawBytes,
      source_kind: fields.source_kind,
      locator_sha256: fields.locator_sha256,
      original_path: fields.original_path,
      ingest_status: fields.ingest_status,
      snapshot_version: fields.snapshot_version,
      publication_policy: fields.publication_policy
    });
  }
  copied.sort((left, right) => compareAscii(left.source_id, right.source_id));
  for (let index = 1; index < copied.length; index += 1) {
    if (copied[index - 1].source_id === copied[index].source_id) {
      return {
        failure: expected("DUPLICATE_SOURCE_ID", null, copied[index].source_id)
      };
    }
  }
  return { value: copied };
}

function copyAdditions(additionSourceIds) {
  const sourceIds = snapshotDenseDataArray(additionSourceIds);
  if (sourceIds === null) {
    return { failure: expected("INVALID_CLEANING_INPUT") };
  }
  const copied = [];
  let prior = null;
  for (let index = 0; index < sourceIds.length; index += 1) {
    const sourceId = sourceIds[index];
    if (typeof sourceId !== "string" || !SOURCE_ID_PATTERN.test(sourceId) ||
        (prior !== null && sourceId <= prior)) {
      const responsible = typeof sourceId === "string" && SOURCE_ID_PATTERN.test(sourceId)
        ? sourceId
        : null;
      return { failure: expected("INVALID_CLEANING_INPUT", null, responsible) };
    }
    copied.push(sourceId);
    prior = sourceId;
  }
  return { value: copied };
}

function firstContinuityDifference(inputIds, priorIds, additionIds) {
  const priorSet = new Set(priorIds);
  const inputSet = new Set(inputIds);
  const additionSet = new Set(additionIds);
  const candidates = new Set([...inputIds, ...priorIds, ...additionIds]);
  for (const sourceId of [...candidates].sort()) {
    const expectedPresent = priorSet.has(sourceId) || additionSet.has(sourceId);
    const overlap = priorSet.has(sourceId) && additionSet.has(sourceId);
    const correctAddition = additionSet.has(sourceId) ===
      (inputSet.has(sourceId) && !priorSet.has(sourceId));
    if (overlap || inputSet.has(sourceId) !== expectedPresent || !correctAddition) {
      return sourceId;
    }
  }
  return null;
}

function cloneCleanerResult(value) {
  const fields = dataFields(value, RESULT_KEYS);
  if (fields === null || !isBytes(fields.outputBytes)) return null;
  const metadataFields = dataFields(fields.metadata, METADATA_RESULT_KEYS);
  if (metadataFields === null) return null;
  if (METADATA_RESULT_KEYS.some((key) =>
    metadataFields[key] !== null && typeof metadataFields[key] !== "string")) {
    return null;
  }

  let bodyImages;
  let changes;
  let warnings;
  let audit;
  try {
    bodyImages = canonicalClone(fields.bodyImages);
    changes = canonicalClone(fields.changes);
    warnings = canonicalClone(fields.warnings);
    audit = fields.audit === null ? null : canonicalClone(fields.audit);
  } catch {
    return null;
  }
  if (!Array.isArray(bodyImages) || !Array.isArray(changes) || !Array.isArray(warnings)) {
    return null;
  }
  let priorOrdinal = 0;
  for (const image of bodyImages) {
    const imageFields = dataFields(image, BODY_IMAGE_KEYS);
    if (imageFields === null || !isPositiveInteger(imageFields.ordinal) ||
        imageFields.ordinal <= priorOrdinal || typeof imageFields.alt !== "string" ||
        typeof imageFields.url !== "string") {
      return null;
    }
    priorOrdinal = imageFields.ordinal;
  }
  if (!warnings.every((warning, index) =>
    typeof warning === "string" && WARNING_PATTERN.test(warning) &&
    (index === 0 || warnings[index - 1] < warning))) {
    return null;
  }

  return {
    status: fields.status,
    outputBytes: Buffer.from(fields.outputBytes),
    cleanedMarkdown: fields.cleanedMarkdown,
    metadata: { ...metadataFields },
    bodyImages,
    changes,
    warnings,
    audit
  };
}

function validateDecodedMarkdown(result, rawBytes) {
  let decoded = null;
  let decodes = true;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(result.outputBytes);
  } catch {
    decodes = false;
  }
  if (decodes ? result.cleanedMarkdown !== decoded : result.cleanedMarkdown !== null) {
    return false;
  }
  if (result.status === "cleaned") return decodes && result.audit !== null;
  if (result.status !== "needs_review") return false;
  return result.outputBytes.equals(rawBytes) &&
    METADATA_RESULT_KEYS.every((key) => result.metadata[key] === null) &&
    result.bodyImages.length === 0 && result.changes.length === 0 &&
    result.audit === null && result.warnings.length > 0;
}

function buildSource(input, result, cleanerVersion, priorSource) {
  const rawSha256 = sha256(input.raw_bytes);
  const cleanedSha256 = sha256(result.outputBytes);
  const auditSha256 = result.audit === null
    ? null
    : sha256(canonicalJsonBytes(result.audit));
  const mechanicalContentMode = result.bodyImages.length === 0 ? "text" : "mixed";
  const carryReviewer = priorSource?.review_state_owner === "reviewer" &&
    result.status === "cleaned" &&
    rawSha256 === priorSource.review_state_bound_raw_sha256 &&
    cleanedSha256 === priorSource.review_state_bound_cleaned_sha256 &&
    auditSha256 === priorSource.review_state_bound_audit_sha256 &&
    cleanerVersion === priorSource.review_state_bound_cleaner_version;

  return {
    source_id: input.source_id,
    source_kind: input.source_kind,
    locator_sha256: input.locator_sha256,
    original_path: input.original_path,
    raw_sha256: rawSha256,
    cleaned_relative_path: `sources/${input.source_id}.md`,
    cleaned_sha256: cleanedSha256,
    title: result.metadata.title,
    author: result.metadata.author,
    original_status: result.metadata.originalStatus,
    published_at: result.metadata.publishedAt,
    location: result.metadata.location,
    source_url: result.metadata.sourceUrl,
    body_image_urls: result.bodyImages.map(({ url }) => url),
    content_mode: carryReviewer ? priorSource.content_mode : mechanicalContentMode,
    ingest_status: input.ingest_status,
    cleaning_status: result.status,
    processing_status: carryReviewer
      ? priorSource.processing_status
      : (result.status === "cleaned" ? "cleaned" : "needs_review"),
    cleaner_version: cleanerVersion,
    snapshot_version: input.snapshot_version,
    publication_policy: input.publication_policy,
    review_state_owner: carryReviewer ? "reviewer" : "mechanical",
    review_state_version: carryReviewer ? priorSource.review_state_version : 0,
    review_state_bound_raw_sha256: rawSha256,
    review_state_bound_cleaned_sha256: cleanedSha256,
    review_state_bound_audit_sha256: auditSha256,
    review_state_bound_cleaner_version: cleanerVersion,
    audit: result.audit,
    audit_sha256: auditSha256,
    changes: result.changes,
    warnings: result.warnings
  };
}

function auditBindingsAreValid(rawBytes, result) {
  if (result.status !== "cleaned") return true;
  const { audit } = result;
  const outputBytes = result.outputBytes;
  if (audit.source_byte_length !== rawBytes.length ||
      audit.output_byte_length !== outputBytes.length) return false;

  for (const item of audit.retained_spans) {
    if (sha256(rawBytes.subarray(item.source_span.start, item.source_span.end)) !==
          item.before_sha256 ||
        sha256(outputBytes.subarray(item.output_span.start, item.output_span.end)) !==
          item.after_sha256) return false;
  }
  for (const key of METADATA_AUDIT_KEYS) {
    const item = audit.metadata_spans[key];
    if (sha256(rawBytes.subarray(item.source_span.start, item.source_span.end)) !==
          item.before_sha256 ||
        sha256(outputBytes.subarray(item.output_span.start, item.output_span.end)) !==
          item.after_sha256) return false;
  }
  if (audit.image_spans.length !== result.bodyImages.length) return false;
  for (let index = 0; index < audit.image_spans.length; index += 1) {
    const item = audit.image_spans[index];
    const image = result.bodyImages[index];
    if (item.ordinal !== image.ordinal ||
        sha256(rawBytes.subarray(
          item.source_token_span.start,
          item.source_token_span.end
        )) !== item.source_sha256 ||
        sha256(outputBytes.subarray(
          item.output_token_span.start,
          item.output_token_span.end
        )) !== item.output_sha256 ||
        sha256(Buffer.from(image.alt, "utf8")) !== item.alt_sha256 ||
        sha256(Buffer.from(image.url, "utf8")) !== item.url_sha256) return false;
  }
  for (const item of audit.hard_breaks) {
    if (!rawBytes.subarray(item.source_span.start, item.source_span.end).equals(
      Buffer.from("  ", "utf8")
    ) || !outputBytes.subarray(item.output_span.start, item.output_span.end).equals(
      Buffer.from("  ", "utf8")
    )) return false;
  }

  const bodyParts = [];
  let offset = audit.body_output_span.start;
  for (const image of audit.image_spans) {
    bodyParts.push(outputBytes.subarray(offset, image.output_token_span.start));
    offset = image.output_token_span.end;
  }
  bodyParts.push(outputBytes.subarray(offset, audit.body_output_span.end));
  let bodyText;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(bodyParts));
  } catch {
    return false;
  }
  const count = [...bodyText].filter((character) => !/\s/u.test(character)).length;
  return count === audit.body_non_whitespace_code_points;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value) ||
      ArrayBuffer.isView(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function makeArtifacts(sources, results, compiled) {
  const artifacts = sources.map((source, index) => ({
    relative_path: source.cleaned_relative_path,
    sha256: source.cleaned_sha256,
    size_bytes: results[index].outputBytes.length,
    bytes: Buffer.from(results[index].outputBytes)
  }));
  artifacts.push(
    {
      relative_path: "catalog/sources.jsonl",
      sha256: sha256(compiled.catalog_bytes),
      size_bytes: compiled.catalog_bytes.length,
      bytes: Buffer.from(compiled.catalog_bytes)
    },
    {
      relative_path: "cleaning-report.json",
      sha256: sha256(compiled.report_bytes),
      size_bytes: compiled.report_bytes.length,
      bytes: Buffer.from(compiled.report_bytes)
    }
  );
  artifacts.sort((left, right) => compareAscii(left.relative_path, right.relative_path));
  return artifacts;
}

export async function prepareCleaningPlan(options) {
  const fields = validateTopLevel(options);
  const inputCopy = copyInputs(fields.inputEntries);
  if (inputCopy.failure !== undefined) return inputCopy.failure;
  const additionCopy = copyAdditions(fields.additionSourceIds);
  if (additionCopy.failure !== undefined) return additionCopy.failure;
  const inputs = inputCopy.value;
  const additionSourceIds = additionCopy.value;

  const firstState = await readCurrentCleaningState({
    rootDir: fields.rootDir,
    currentPointer: fields.currentPointer,
    selectedSourceIds: []
  });

  let base;
  if (fields.stateMode === "initial_verified_baseline") {
    if (firstState.ok) {
      return expected("INVALID_CLEANING_INPUT", POINTER_RELATIVE_PATH);
    }
    if (firstState.error.kind !== "expected" ||
        firstState.error.code !== "LOCAL_STATE_MISSING" ||
        firstState.error.path !== POINTER_RELATIVE_PATH) {
      return firstState;
    }
    if (additionSourceIds.length > 0) {
      return expected("INVALID_CLEANING_INPUT", null, additionSourceIds[0]);
    }
    base = {
      expectedPriorPointer: null,
      expectedPriorPointerSha256: null,
      priorRunSha256: null,
      priorCatalogSha256: null,
      priorReportSha256: null,
      priorSourceIds: [],
      priorSourceById: new Map()
    };
  } else {
    if (!firstState.ok) return firstState;
    const priorSourceIds = firstState.value.report.run_preimage.sources.map(
      ({ source_id: sourceId }) => sourceId
    );
    const differingSourceId = firstContinuityDifference(
      inputs.map(({ source_id: sourceId }) => sourceId),
      priorSourceIds,
      additionSourceIds
    );
    if (differingSourceId !== null) {
      return expected("SOURCE_SET_DISCONTINUITY", null, differingSourceId);
    }

    const rawShaByBytes = new Map();
    const secondState = await readCurrentCleaningState({
      rootDir: fields.rootDir,
      currentPointer: fields.currentPointer,
      selectedSourceIds: priorSourceIds,
      readAdditionalArtifacts: async ({ readVerifiedArtifact }) => {
        const verifications = inputs.map((input) => {
          let expectedSha256 = rawShaByBytes.get(input.raw_bytes);
          if (expectedSha256 === undefined) {
            expectedSha256 = sha256(input.raw_bytes);
            rawShaByBytes.set(input.raw_bytes, expectedSha256);
          }
          return readVerifiedArtifact({
            repoRelativePath: input.original_path,
            expectedSha256,
            maxBytes: Math.max(1, Math.min(input.raw_bytes.length, MAX_ARTIFACT_BYTES))
          }).then((bytes) => bytes.equals(input.raw_bytes) ? null : input.original_path);
        });
        const mismatches = await Promise.all(verifications);
        return mismatches.find((path) => path !== null) ?? null;
      }
    });
    if (!secondState.ok) {
      if (secondState.error.kind === "expected" &&
          secondState.error.code === "INVALID_CLEANING_INPUT") {
        return expected("LOCAL_STATE_INVALID", POINTER_RELATIVE_PATH);
      }
      return secondState;
    }
    if (!secondState.value.pointer_bytes.equals(firstState.value.pointer_bytes)) {
      return expected("LOCAL_STATE_INVALID", POINTER_RELATIVE_PATH);
    }
    if (secondState.value.additional_result !== null) {
      return expected("LOCAL_STATE_INVALID", secondState.value.additional_result);
    }
    base = {
      expectedPriorPointer: secondState.value.pointer,
      expectedPriorPointerSha256: sha256(secondState.value.pointer_bytes),
      priorRunSha256: secondState.value.pointer.run_sha256,
      priorCatalogSha256: secondState.value.pointer.catalog_sha256,
      priorReportSha256: secondState.value.pointer.report_sha256,
      priorSourceIds,
      priorSourceById: new Map(secondState.value.report.run_preimage.sources.map(
        (source) => [source.source_id, source]
      ))
    };
  }

  const results = [];
  const sources = [];
  for (const input of inputs) {
    let returned;
    try {
      returned = await fields.cleanSource({
        sourceId: input.source_id,
        rawBytes: Buffer.from(input.raw_bytes)
      });
    } catch {
      return expected("CLEANER_FAILURE", null, input.source_id);
    }
    let result;
    try {
      result = cloneCleanerResult(returned);
    } catch {
      result = null;
    }
    if (result === null || !validateDecodedMarkdown(result, input.raw_bytes)) {
      return expected("INVALID_CLEANING_RESULT", null, input.source_id);
    }
    const source = buildSource(
      input,
      result,
      fields.cleanerVersion,
      base.priorSourceById.get(input.source_id)
    );
    let sourceValidation;
    try {
      sourceValidation = compileCleaningStateArtifacts({
        schema_version: SCHEMA_VERSION,
        cleaner_version: fields.cleanerVersion,
        sources: [source]
      });
    } catch {
      return expected("INVALID_CLEANING_RESULT", null, input.source_id);
    }
    if (!sourceValidation.ok || !auditBindingsAreValid(input.raw_bytes, result)) {
      return expected("INVALID_CLEANING_RESULT", null, input.source_id);
    }
    results.push(result);
    sources.push(source);
  }

  const runPreimage = {
    schema_version: SCHEMA_VERSION,
    cleaner_version: fields.cleanerVersion,
    sources
  };
  let compiledResult;
  try {
    compiledResult = compileCleaningStateArtifacts(runPreimage);
  } catch {
    const sourceId = sources.length > 0 ? sources[0].source_id : null;
    return expected("INVALID_CLEANING_RESULT", null, sourceId);
  }
  if (!compiledResult.ok) {
    return expected("INVALID_CLEANING_RESULT", null, compiledResult.source_id);
  }
  if (fields.strict) {
    const strictFailure = sources.find((source) => source.cleaning_status === "needs_review");
    if (strictFailure !== undefined) {
      return expected("STRICT_CLEANING_FAILED", null, strictFailure.source_id);
    }
  }

  const compiled = compiledResult.value;
  const artifacts = makeArtifacts(sources, results, compiled);
  const artifactManifest = artifacts.map(({ bytes: _bytes, ...artifact }) => artifact);
  const manifest = {
    schema_version: SCHEMA_VERSION,
    state_mode: fields.stateMode,
    expected_prior_pointer: base.expectedPriorPointer,
    expected_prior_pointer_sha256: base.expectedPriorPointerSha256,
    prior_run_sha256: base.priorRunSha256,
    prior_catalog_sha256: base.priorCatalogSha256,
    prior_report_sha256: base.priorReportSha256,
    prior_source_ids: [...base.priorSourceIds],
    run_preimage: runPreimage,
    artifact_manifest: artifactManifest,
    desired_pointer: compiled.pointer,
    desired_pointer_sha256: sha256(compiled.pointer_bytes),
    registered_source_count: sources.length
  };
  const plan = {
    manifest,
    manifest_sha256: sha256(canonicalJsonBytes(manifest)),
    artifacts
  };
  deepFreeze(plan);
  return {
    ok: true,
    value: {
      kind: "prepared",
      plan,
      persistent_writes_occurred: false
    }
  };
}

export async function cleanCorpus(options) {
  const { apply, planOptions } = validateCleanCorpusOptions(options);
  const planResult = await prepareCleaningPlan(planOptions);
  if (!planResult.ok) {
    return planResult;
  }
  const { plan } = planResult.value;

  if (!apply) {
    return {
      ok: true,
      value: {
        kind: "dry_run",
        summary: deepFreeze(canonicalClone(cleanCorpusSummaryFromPlan(plan)))
      }
    };
  }

  const stageResult = await stageCleaningRun({
    rootDir: planOptions.rootDir,
    runsRoot: planOptions.runsRoot,
    plan
  });
  if (!stageResult.ok) {
    return stageResult;
  }

  const publishResult = await publishCleaningRun({
    rootDir: planOptions.rootDir,
    runsRoot: planOptions.runsRoot,
    currentPointer: planOptions.currentPointer,
    stagedRun: stageResult.value.staged_run
  });
  if (!publishResult.ok) {
    return publishResult;
  }

  return {
    ok: true,
    value: {
      kind: publishResult.value.kind,
      publication: deepFreeze(canonicalClone(publishResult.value))
    }
  };
}
