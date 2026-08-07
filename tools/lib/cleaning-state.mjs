import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { isSha256, sha256 } from "./hash.mjs";
import {
  canonicalJsonBytes,
  canonicalJsonDocumentBytes
} from "./json.mjs";

const SCHEMA_VERSION = "1.0.0";
const POINTER_RELATIVE_PATH = ".local/state/current-cleaning.json";
const SOURCE_ID_PATTERN = /^src_[0-9a-f]{32}$/;
const WARNING_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const POINTER_MAX_BYTES = 64 * 1024;
const CATALOG_MAX_BYTES = 64 * 1024 * 1024;
const CATALOG_LINE_MAX_BYTES = 1024 * 1024;
const REPORT_MAX_BYTES = 256 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const OUTPUT_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;
const ADDITIONAL_MAX_CALLS = 1024;
const ADDITIONAL_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const EMPTY_SHA256 = sha256(Buffer.alloc(0));
const LF_SHA256 = sha256(Buffer.from([0x0a]));

const POINTER_KEYS = [
  "schema_version",
  "run_sha256",
  "run_path",
  "catalog_path",
  "catalog_sha256",
  "report_path",
  "report_sha256"
];
const REPORT_KEYS = ["schema_version", "run_sha256", "run_preimage"];
const RUN_PREIMAGE_KEYS = ["schema_version", "cleaner_version", "sources"];
const SOURCE_KEYS = [
  "source_id",
  "source_kind",
  "locator_sha256",
  "original_path",
  "raw_sha256",
  "cleaned_relative_path",
  "cleaned_sha256",
  "title",
  "author",
  "original_status",
  "published_at",
  "location",
  "source_url",
  "body_image_urls",
  "content_mode",
  "ingest_status",
  "cleaning_status",
  "processing_status",
  "cleaner_version",
  "snapshot_version",
  "publication_policy",
  "review_state_owner",
  "review_state_version",
  "review_state_bound_raw_sha256",
  "review_state_bound_cleaned_sha256",
  "review_state_bound_audit_sha256",
  "review_state_bound_cleaner_version",
  "audit",
  "audit_sha256",
  "changes",
  "warnings"
];
const CATALOG_KEYS = [
  "schema_version",
  ...SOURCE_KEYS.filter((key) => ![
    "cleaned_relative_path",
    "audit",
    "changes",
    "warnings"
  ].includes(key)),
  "cleaned_path"
];
const AUDIT_KEYS = [
  "source_byte_length",
  "output_byte_length",
  "retained_spans",
  "metadata_spans",
  "image_spans",
  "hard_breaks",
  "body_output_span",
  "ordered_body_images_preserved",
  "body_non_whitespace_code_points"
];
const RETAINED_SPAN_KEYS = [
  "source_line",
  "source_span",
  "output_span",
  "before_sha256",
  "after_sha256"
];
const METADATA_KEYS = [
  "title",
  "author",
  "original_status",
  "published_at",
  "location",
  "source_url"
];
const AUDIT_SPAN_KEYS = [
  "source_span",
  "output_span",
  "before_sha256",
  "after_sha256",
  "preserved"
];
const IMAGE_SPAN_KEYS = [
  "ordinal",
  "source_token_span",
  "output_token_span",
  "source_sha256",
  "output_sha256",
  "alt_sha256",
  "url_sha256"
];
const HARD_BREAK_KEYS = [
  "source_line",
  "source_span",
  "output_span",
  "preserved"
];
const CHANGE_KEYS = [
  "ruleId",
  "kind",
  "sourceLines",
  "beforeSha256",
  "afterSha256"
];
const ADDITIONAL_REQUEST_KEYS = [
  "repoRelativePath",
  "expectedSha256",
  "maxBytes"
];

const SOURCE_KINDS = new Set(["baseline_markdown", "markdown", "url"]);
const CONTENT_MODES = new Set(["text", "mixed", "image_dominant"]);
const INGEST_STATUSES = new Set(["registered", "duplicate", "superseded"]);
const CLEANING_STATUSES = new Set(["cleaned", "needs_review"]);
const PROCESSING_STATUSES = new Set([
  "new",
  "cleaned",
  "needs_review",
  "ready",
  "needs_ocr",
  "needs_medical_review"
]);
const REVIEWER_PROCESSING_STATUSES = new Set([
  "needs_review",
  "ready",
  "needs_ocr",
  "needs_medical_review"
]);
const PUBLICATION_POLICIES = new Set([
  "local_only",
  "public_metadata",
  "public_synthesis_redacted"
]);
const REVIEW_STATE_OWNERS = new Set(["mechanical", "reviewer"]);
const CHANGE_RULE_KINDS = new Map([
  ["WECHAT_HEADER_V1", "delete"],
  ["WECHAT_FOOTER_SQUARE_V1", "delete"],
  ["WECHAT_FOOTER_COGNITION_V1", "delete"],
  ["DUPLICATE_FIGURE_LABEL_V1", "delete"],
  ["CONFIRMED_PLATFORM_CTA_V1", "delete"],
  ["NBSP_NORMALIZATION_V1", "normalize"],
  ["BLANK_LINE_NORMALIZATION_V1", "normalize"],
  ["EOF_NEWLINE_V1", "append_eof"]
]);

class ReaderFailure extends Error {
  constructor(result) {
    super(result.error.code);
    this.result = result;
  }
}

class SchemaFailure extends Error {
  constructor(sourceId = null) {
    super("Invalid cleaning-state schema");
    this.sourceId = sourceId;
  }
}

function expected(code, path, sourceId = null) {
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

function ioFailure(operation, path) {
  return {
    ok: false,
    error: {
      kind: "io",
      code: "CLEANING_IO_FAILURE",
      operation,
      path,
      persistent_writes_occurred: false
    }
  };
}

function failExpected(code, path, sourceId = null) {
  throw new ReaderFailure(expected(code, path, sourceId));
}

function failInvalid(path, sourceId = null) {
  failExpected("LOCAL_STATE_INVALID", path, sourceId);
}

function programmerError(message, code) {
  const error = new TypeError(message);
  if (code !== undefined) error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actual.length === expectedKeys.length &&
    actual.every((key, index) => key === expectedKeys[index]);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isStrictlyIncreasing(values, predicate) {
  if (!Array.isArray(values)) return false;
  let previous = null;
  for (const value of values) {
    if (!predicate(value) || (previous !== null && value <= previous)) return false;
    previous = value;
  }
  return true;
}

function isCanonicalRepoRelativePath(value) {
  if (!isNonEmptyString(value) || value.includes("\\") || value.includes("\0")) return false;
  if (isAbsolute(value) || /^[A-Za-z]:\//.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function assertCanonicalAdditionalPath(value) {
  if (!isCanonicalRepoRelativePath(value)) {
    throw programmerError("repoRelativePath must be a canonical repository-relative path");
  }
}

function schema(condition, sourceId = null) {
  if (!condition) throw new SchemaFailure(sourceId);
}

function validSpan(value, limit, allowEmpty = false) {
  return hasExactKeys(value, ["start", "end"]) &&
    isNonNegativeInteger(value.start) &&
    isNonNegativeInteger(value.end) &&
    (allowEmpty ? value.start <= value.end : value.start < value.end) &&
    value.end <= limit;
}

function contains(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function spansAreStrictlyOrdered(values, key) {
  let priorEnd = -1;
  for (const value of values) {
    const current = value[key];
    if (current.start < priorEnd) return false;
    priorEnd = current.end;
  }
  return true;
}

function spansArePairwiseNonOverlapping(values, key) {
  const ordered = [...values].sort((left, right) =>
    left[key].start - right[key].start || left[key].end - right[key].end);
  let priorEnd = -1;
  for (const value of ordered) {
    if (value[key].start < priorEnd) return false;
    priorEnd = value[key].end;
  }
  return true;
}

function isContainedByRetained(retained, sourceSpan, outputSpan, sourceLine = null) {
  return retained.some((item) =>
    (sourceLine === null || item.source_line === sourceLine) &&
    contains(item.source_span, sourceSpan) &&
    contains(item.output_span, outputSpan));
}

function validateAudit(audit, bodyImageUrls, sourceId) {
  schema(hasExactKeys(audit, AUDIT_KEYS), sourceId);
  schema(isNonNegativeInteger(audit.source_byte_length), sourceId);
  schema(isNonNegativeInteger(audit.output_byte_length), sourceId);
  schema(Array.isArray(audit.retained_spans), sourceId);
  schema(hasExactKeys(audit.metadata_spans, METADATA_KEYS), sourceId);
  schema(Array.isArray(audit.image_spans), sourceId);
  schema(Array.isArray(audit.hard_breaks), sourceId);
  schema(validSpan(audit.body_output_span, audit.output_byte_length, true), sourceId);
  schema(audit.ordered_body_images_preserved === true, sourceId);
  schema(isNonNegativeInteger(audit.body_non_whitespace_code_points), sourceId);

  let priorLine = 0;
  for (const retained of audit.retained_spans) {
    schema(hasExactKeys(retained, RETAINED_SPAN_KEYS), sourceId);
    schema(isPositiveInteger(retained.source_line) && retained.source_line > priorLine, sourceId);
    priorLine = retained.source_line;
    schema(validSpan(retained.source_span, audit.source_byte_length), sourceId);
    schema(validSpan(retained.output_span, audit.output_byte_length), sourceId);
    schema(isSha256(retained.before_sha256) && isSha256(retained.after_sha256), sourceId);
  }
  schema(spansAreStrictlyOrdered(audit.retained_spans, "source_span"), sourceId);
  schema(spansAreStrictlyOrdered(audit.retained_spans, "output_span"), sourceId);

  for (const key of METADATA_KEYS) {
    const item = audit.metadata_spans[key];
    schema(hasExactKeys(item, AUDIT_SPAN_KEYS), sourceId);
    schema(validSpan(item.source_span, audit.source_byte_length), sourceId);
    schema(validSpan(item.output_span, audit.output_byte_length), sourceId);
    schema(isSha256(item.before_sha256) && isSha256(item.after_sha256), sourceId);
    schema(item.preserved === true, sourceId);
    schema(
      item.output_span.end <= audit.body_output_span.start ||
      audit.body_output_span.end <= item.output_span.start,
      sourceId
    );
    schema(
      isContainedByRetained(audit.retained_spans, item.source_span, item.output_span),
      sourceId
    );
  }
  const metadataSpans = METADATA_KEYS.map((key) => audit.metadata_spans[key]);
  schema(spansArePairwiseNonOverlapping(metadataSpans, "source_span"), sourceId);
  schema(spansArePairwiseNonOverlapping(metadataSpans, "output_span"), sourceId);

  schema(audit.image_spans.length === bodyImageUrls.length, sourceId);
  let priorOrdinal = 0;
  for (let index = 0; index < audit.image_spans.length; index += 1) {
    const item = audit.image_spans[index];
    schema(hasExactKeys(item, IMAGE_SPAN_KEYS), sourceId);
    schema(isPositiveInteger(item.ordinal) && item.ordinal > priorOrdinal, sourceId);
    priorOrdinal = item.ordinal;
    schema(validSpan(item.source_token_span, audit.source_byte_length), sourceId);
    schema(validSpan(item.output_token_span, audit.output_byte_length), sourceId);
    schema(
      isSha256(item.source_sha256) && isSha256(item.output_sha256) &&
      isSha256(item.alt_sha256) && isSha256(item.url_sha256),
      sourceId
    );
    schema(
      isContainedByRetained(
        audit.retained_spans,
        item.source_token_span,
        item.output_token_span
      ),
      sourceId
    );
    schema(contains(audit.body_output_span, item.output_token_span), sourceId);
    schema(sha256(Buffer.from(bodyImageUrls[index], "utf8")) === item.url_sha256, sourceId);
  }
  schema(spansAreStrictlyOrdered(audit.image_spans, "source_token_span"), sourceId);
  schema(spansAreStrictlyOrdered(audit.image_spans, "output_token_span"), sourceId);
  const imageOutputBytes = audit.image_spans.reduce(
    (total, item) => total + item.output_token_span.end - item.output_token_span.start,
    0
  );
  const bodyByteCapacity =
    audit.body_output_span.end - audit.body_output_span.start - imageOutputBytes;
  schema(audit.body_non_whitespace_code_points <= bodyByteCapacity, sourceId);

  priorLine = 0;
  for (const item of audit.hard_breaks) {
    schema(hasExactKeys(item, HARD_BREAK_KEYS), sourceId);
    schema(isPositiveInteger(item.source_line) && item.source_line > priorLine, sourceId);
    priorLine = item.source_line;
    schema(validSpan(item.source_span, audit.source_byte_length), sourceId);
    schema(validSpan(item.output_span, audit.output_byte_length), sourceId);
    schema(item.source_span.end - item.source_span.start === 2, sourceId);
    schema(item.output_span.end - item.output_span.start === 2, sourceId);
    schema(item.preserved === true, sourceId);
    schema(
      isContainedByRetained(
        audit.retained_spans,
        item.source_span,
        item.output_span,
        item.source_line
      ),
      sourceId
    );
  }
  schema(spansAreStrictlyOrdered(audit.hard_breaks, "source_span"), sourceId);
  schema(spansAreStrictlyOrdered(audit.hard_breaks, "output_span"), sourceId);
}

function validateChanges(changes, sourceId) {
  schema(Array.isArray(changes), sourceId);
  for (const change of changes) {
    schema(hasExactKeys(change, CHANGE_KEYS), sourceId);
    schema(CHANGE_RULE_KINDS.get(change.ruleId) === change.kind, sourceId);
    schema(isSha256(change.beforeSha256) && isSha256(change.afterSha256), sourceId);
    if (change.kind === "append_eof") {
      schema(change.ruleId === "EOF_NEWLINE_V1", sourceId);
      schema(change.sourceLines === null, sourceId);
      schema(change.beforeSha256 === EMPTY_SHA256 && change.afterSha256 === LF_SHA256, sourceId);
    } else {
      schema(change.ruleId !== "EOF_NEWLINE_V1", sourceId);
      schema(
        Array.isArray(change.sourceLines) && change.sourceLines.length > 0 &&
        isStrictlyIncreasing(change.sourceLines, isPositiveInteger),
        sourceId
      );
      if (change.kind === "delete") {
        schema(
          change.sourceLines.every((line, index) =>
            index === 0 || line === change.sourceLines[index - 1] + 1),
          sourceId
        );
        schema(change.afterSha256 === EMPTY_SHA256, sourceId);
      }
    }
  }
}

function validateWarnings(warnings, sourceId) {
  schema(isStrictlyIncreasing(warnings, (value) =>
    typeof value === "string" && WARNING_PATTERN.test(value)), sourceId);
}

function validateSource(source, topCleanerVersion) {
  const sourceId = isPlainObject(source) && SOURCE_ID_PATTERN.test(source.source_id ?? "")
    ? source.source_id
    : null;
  schema(hasExactKeys(source, SOURCE_KEYS), sourceId);
  schema(SOURCE_ID_PATTERN.test(source.source_id), sourceId);
  schema(SOURCE_KINDS.has(source.source_kind), sourceId);
  schema(isSha256(source.locator_sha256), sourceId);
  schema(
    isCanonicalRepoRelativePath(source.original_path) &&
    source.original_path.startsWith(".local/original/"),
    sourceId
  );
  schema(isSha256(source.raw_sha256), sourceId);
  schema(source.cleaned_relative_path === `sources/${source.source_id}.md`, sourceId);
  schema(isSha256(source.cleaned_sha256), sourceId);
  schema(isNullableString(source.title), sourceId);
  schema(isNullableString(source.author), sourceId);
  schema(isNullableString(source.original_status), sourceId);
  schema(isNullableString(source.published_at), sourceId);
  schema(isNullableString(source.location), sourceId);
  schema(isNullableString(source.source_url), sourceId);
  schema(
    Array.isArray(source.body_image_urls) &&
    source.body_image_urls.every((value) => typeof value === "string"),
    sourceId
  );
  schema(CONTENT_MODES.has(source.content_mode), sourceId);
  schema(INGEST_STATUSES.has(source.ingest_status), sourceId);
  schema(CLEANING_STATUSES.has(source.cleaning_status), sourceId);
  schema(PROCESSING_STATUSES.has(source.processing_status), sourceId);
  schema(isNonEmptyString(source.cleaner_version), sourceId);
  schema(source.cleaner_version === topCleanerVersion, sourceId);
  schema(isPositiveInteger(source.snapshot_version), sourceId);
  schema(PUBLICATION_POLICIES.has(source.publication_policy), sourceId);
  schema(REVIEW_STATE_OWNERS.has(source.review_state_owner), sourceId);
  schema(isNonNegativeInteger(source.review_state_version), sourceId);
  schema(isSha256(source.review_state_bound_raw_sha256), sourceId);
  schema(isSha256(source.review_state_bound_cleaned_sha256), sourceId);
  schema(
    source.review_state_bound_audit_sha256 === null ||
    isSha256(source.review_state_bound_audit_sha256),
    sourceId
  );
  schema(isNonEmptyString(source.review_state_bound_cleaner_version), sourceId);
  validateChanges(source.changes, sourceId);
  validateWarnings(source.warnings, sourceId);

  if (source.cleaning_status === "cleaned") {
    schema(source.audit !== null && isSha256(source.audit_sha256), sourceId);
    validateAudit(source.audit, source.body_image_urls, sourceId);
    schema(sha256(canonicalJsonBytes(source.audit)) === source.audit_sha256, sourceId);
  } else {
    schema(source.audit === null && source.audit_sha256 === null, sourceId);
    schema(source.raw_sha256 === source.cleaned_sha256, sourceId);
    schema([
      source.title,
      source.author,
      source.original_status,
      source.published_at,
      source.location,
      source.source_url
    ].every((value) => value === null), sourceId);
    schema(source.body_image_urls.length === 0, sourceId);
    schema(source.changes.length === 0, sourceId);
    schema(source.warnings.length > 0, sourceId);
  }

  const boundAudit = source.audit_sha256;
  schema(source.review_state_bound_raw_sha256 === source.raw_sha256, sourceId);
  schema(source.review_state_bound_cleaned_sha256 === source.cleaned_sha256, sourceId);
  schema(source.review_state_bound_audit_sha256 === boundAudit, sourceId);
  schema(source.review_state_bound_cleaner_version === source.cleaner_version, sourceId);

  const mechanicalContentMode = source.body_image_urls.length === 0 ? "text" : "mixed";
  if (source.review_state_owner === "mechanical") {
    schema(source.review_state_version === 0, sourceId);
    schema(
      source.processing_status ===
        (source.cleaning_status === "cleaned" ? "cleaned" : "needs_review"),
      sourceId
    );
    schema(source.content_mode === mechanicalContentMode, sourceId);
  } else {
    schema(source.review_state_version > 0, sourceId);
    schema(source.cleaning_status === "cleaned", sourceId);
    schema(REVIEWER_PROCESSING_STATUSES.has(source.processing_status), sourceId);
    if (source.content_mode !== "image_dominant") {
      schema(source.content_mode === mechanicalContentMode, sourceId);
    }
  }
}

function validateRunPreimage(runPreimage) {
  schema(hasExactKeys(runPreimage, RUN_PREIMAGE_KEYS));
  schema(runPreimage.schema_version === SCHEMA_VERSION);
  schema(isNonEmptyString(runPreimage.cleaner_version));
  schema(Array.isArray(runPreimage.sources));
  let previous = null;
  for (const source of runPreimage.sources) {
    validateSource(source, runPreimage.cleaner_version);
    schema(previous === null || source.source_id > previous, source.source_id);
    previous = source.source_id;
  }
}

function parseCanonicalDocument(bytes, path) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!canonicalJsonDocumentBytes(value).equals(bytes)) failInvalid(path);
    return value;
  } catch (error) {
    if (error instanceof ReaderFailure) throw error;
    failInvalid(path);
  }
}

function parseCanonicalCatalog(bytes, path) {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0x0a) failInvalid(path);
  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) failInvalid(path);
    const physicalLength = newline - offset + 1;
    if (physicalLength <= 1 || physicalLength > CATALOG_LINE_MAX_BYTES) failInvalid(path);
    const line = bytes.subarray(offset, newline);
    try {
      const entry = JSON.parse(line.toString("utf8"));
      if (!canonicalJsonDocumentBytes(entry).equals(bytes.subarray(offset, newline + 1))) {
        failInvalid(path);
      }
      entries.push(entry);
    } catch (error) {
      if (error instanceof ReaderFailure) throw error;
      failInvalid(path);
    }
    offset = newline + 1;
  }
  return entries;
}

function projectCatalogEntry(source, runSha256) {
  const {
    cleaned_relative_path: cleanedRelativePath,
    audit: _audit,
    changes: _changes,
    warnings: _warnings,
    ...persisted
  } = source;
  return {
    schema_version: SCHEMA_VERSION,
    ...persisted,
    cleaned_path: `.local/cleaned/runs/${runSha256}/${cleanedRelativePath}`
  };
}

function deepFreezeStructure(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value) ||
      ArrayBuffer.isView(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreezeStructure(value[key], seen);
  return Object.freeze(value);
}

export function compileCleaningStateArtifacts(runPreimage) {
  let runPreimageBytes;
  let snapshot;
  try {
    runPreimageBytes = canonicalJsonBytes(runPreimage);
    snapshot = JSON.parse(runPreimageBytes.toString("utf8"));
    validateRunPreimage(snapshot);
  } catch (error) {
    if (error instanceof SchemaFailure) {
      return { ok: false, source_id: error.sourceId };
    }
    throw error;
  }

  const runSha256 = sha256(runPreimageBytes);
  const catalogEntries = snapshot.sources.map((source) =>
    projectCatalogEntry(source, runSha256));
  const catalogBytes = catalogEntries.length === 0
    ? Buffer.alloc(0)
    : Buffer.concat(catalogEntries.map((entry) => canonicalJsonDocumentBytes(entry)));
  const report = {
    schema_version: SCHEMA_VERSION,
    run_sha256: runSha256,
    run_preimage: snapshot
  };
  const reportBytes = canonicalJsonDocumentBytes(report);
  const runPath = `.local/cleaned/runs/${runSha256}`;
  const pointer = {
    schema_version: SCHEMA_VERSION,
    run_sha256: runSha256,
    run_path: runPath,
    catalog_path: `${runPath}/catalog/sources.jsonl`,
    catalog_sha256: sha256(catalogBytes),
    report_path: `${runPath}/cleaning-report.json`,
    report_sha256: sha256(reportBytes)
  };

  const value = {
    run_sha256: runSha256,
    catalog_entries: catalogEntries,
    catalog_bytes: catalogBytes,
    report,
    report_bytes: reportBytes,
    pointer,
    pointer_bytes: canonicalJsonDocumentBytes(pointer)
  };
  deepFreezeStructure(value);
  return { ok: true, value };
}

function validatePointer(pointer, path) {
  if (!hasExactKeys(pointer, POINTER_KEYS) || pointer.schema_version !== SCHEMA_VERSION ||
      !isSha256(pointer.run_sha256) || !isSha256(pointer.catalog_sha256) ||
      !isSha256(pointer.report_sha256)) {
    failInvalid(path);
  }
  const runPath = `.local/cleaned/runs/${pointer.run_sha256}`;
  if (pointer.run_path !== runPath ||
      pointer.catalog_path !== `${runPath}/catalog/sources.jsonl` ||
      pointer.report_path !== `${runPath}/cleaning-report.json`) {
    failInvalid(path);
  }
}

export function isValidCleaningPointerValue(pointer) {
  try {
    validatePointer(pointer, POINTER_RELATIVE_PATH);
    return true;
  } catch (error) {
    if (error instanceof ReaderFailure) return false;
    throw error;
  }
}

function validateReportAndCatalog(report, catalogEntries, pointer) {
  const reportPath = pointer.report_path;
  const catalogPath = pointer.catalog_path;
  try {
    schema(hasExactKeys(report, REPORT_KEYS));
    schema(report.schema_version === SCHEMA_VERSION);
    schema(isSha256(report.run_sha256));
    validateRunPreimage(report.run_preimage);
    const calculatedRunSha256 = sha256(canonicalJsonBytes(report.run_preimage));
    schema(report.run_sha256 === calculatedRunSha256);
    schema(pointer.run_sha256 === calculatedRunSha256);
  } catch (error) {
    if (error instanceof SchemaFailure) failInvalid(reportPath, error.sourceId);
    throw error;
  }

  const sources = report.run_preimage.sources;
  if (catalogEntries.length !== sources.length) failInvalid(catalogPath);
  for (let index = 0; index < sources.length; index += 1) {
    const entry = catalogEntries[index];
    const sourceId = isPlainObject(entry) && SOURCE_ID_PATTERN.test(entry.source_id ?? "")
      ? entry.source_id
      : null;
    if (!hasExactKeys(entry, CATALOG_KEYS)) failInvalid(catalogPath, sourceId);
    const projected = projectCatalogEntry(sources[index], pointer.run_sha256);
    try {
      if (!canonicalJsonBytes(entry).equals(canonicalJsonBytes(projected))) {
        failInvalid(catalogPath, sourceId);
      }
    } catch (error) {
      if (error instanceof ReaderFailure) throw error;
      failInvalid(catalogPath, sourceId);
    }
  }
}

function mapFsError(error, operation, path) {
  if (error instanceof ReaderFailure) return error;
  if (operation !== "close" && error?.code === "ENOENT") {
    return new ReaderFailure(expected("LOCAL_STATE_MISSING", path));
  }
  if (operation !== "close" && ["ELOOP", "ENOTDIR", "EISDIR"].includes(error?.code)) {
    return new ReaderFailure(expected("LOCAL_STATE_INVALID", path));
  }
  return new ReaderFailure(ioFailure(operation, path));
}

async function fsOperation(operation, path, action) {
  try {
    return await action();
  } catch (error) {
    throw mapFsError(error, operation, path);
  }
}

function fileFacts(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    nlink: stat.nlink
  };
}

function sameFacts(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.nlink === right.nlink;
}

function validStatFacts(stat) {
  return Number.isSafeInteger(stat.size) && stat.size >= 0 &&
    Number.isSafeInteger(stat.nlink) && stat.nlink > 0;
}

async function closeHandles(handles, path) {
  let firstFailure = null;
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    try {
      await handles[index].close();
    } catch (error) {
      if (firstFailure === null) firstFailure = mapFsError(error, "close", path);
    }
  }
  if (firstFailure !== null) throw firstFailure;
}

async function openFileContext(rootDir, repoRelativePath, maxBytes, sourceId = null) {
  const absolutePath = join(rootDir, ...repoRelativePath.split("/"));
  const parentSegments = repoRelativePath.split("/").slice(0, -1);
  const directorySnapshots = [];
  const handles = [];
  let primaryFailure = null;
  try {
    const directoryPaths = [rootDir];
    let current = rootDir;
    for (const segment of parentSegments) {
      current = join(current, segment);
      directoryPaths.push(current);
    }

    for (const directoryPath of directoryPaths) {
      const beforePathStat = await fsOperation(
        "lstat",
        repoRelativePath,
        () => lstat(directoryPath)
      );
      if (!beforePathStat.isDirectory() || beforePathStat.isSymbolicLink() ||
          !validStatFacts(beforePathStat)) {
        failInvalid(repoRelativePath, sourceId);
      }
      const handle = await fsOperation(
        "open",
        repoRelativePath,
        () => open(directoryPath, DIRECTORY_FLAGS)
      );
      handles.push(handle);
      const handleStat = await fsOperation("fstat", repoRelativePath, () => handle.stat());
      if (!handleStat.isDirectory() || !validStatFacts(handleStat) ||
          !sameFacts(fileFacts(beforePathStat), fileFacts(handleStat))) {
        failInvalid(repoRelativePath, sourceId);
      }
      directorySnapshots.push({
        path: directoryPath,
        handle,
        facts: fileFacts(handleStat)
      });
    }

    const beforeLeafPathStat = await fsOperation(
      "lstat",
      repoRelativePath,
      () => lstat(absolutePath)
    );
    if (!beforeLeafPathStat.isFile() || beforeLeafPathStat.isSymbolicLink() ||
        !validStatFacts(beforeLeafPathStat)) {
      failInvalid(repoRelativePath, sourceId);
    }
    let leafHandle;
    try {
      leafHandle = await open(absolutePath, FILE_FLAGS);
    } catch (openError) {
      const afterFailedOpenPathStat = await fsOperation(
        "lstat",
        repoRelativePath,
        () => lstat(absolutePath)
      );
      if (!afterFailedOpenPathStat.isFile() ||
          afterFailedOpenPathStat.isSymbolicLink() ||
          !validStatFacts(afterFailedOpenPathStat) ||
          !sameFacts(
            fileFacts(beforeLeafPathStat),
            fileFacts(afterFailedOpenPathStat)
          )) {
        failInvalid(repoRelativePath, sourceId);
      }
      throw mapFsError(openError, "open", repoRelativePath);
    }
    handles.push(leafHandle);
    const beforeHandleStat = await fsOperation("fstat", repoRelativePath, () => leafHandle.stat());
    if (!beforeHandleStat.isFile() || !validStatFacts(beforeHandleStat)) {
      failInvalid(repoRelativePath, sourceId);
    }
    if (beforeHandleStat.size > maxBytes) failInvalid(repoRelativePath, sourceId);
    const afterOpenPathStat = await fsOperation(
      "lstat",
      repoRelativePath,
      () => lstat(absolutePath)
    );
    if (!afterOpenPathStat.isFile() || afterOpenPathStat.isSymbolicLink() ||
        !validStatFacts(afterOpenPathStat) ||
        !sameFacts(fileFacts(beforeLeafPathStat), fileFacts(beforeHandleStat)) ||
        !sameFacts(fileFacts(beforeHandleStat), fileFacts(afterOpenPathStat))) {
      failInvalid(repoRelativePath, sourceId);
    }

    return {
      repoRelativePath,
      sourceId,
      absolutePath,
      handles,
      directorySnapshots,
      leafHandle,
      beforeFacts: fileFacts(beforeHandleStat),
      size: beforeHandleStat.size,
      closed: false
    };
  } catch (error) {
    if (error instanceof ReaderFailure && sourceId !== null &&
        error.result.error.kind === "expected") {
      primaryFailure = new ReaderFailure(expected(
        error.result.error.code,
        error.result.error.path,
        sourceId
      ));
    } else {
      primaryFailure = error;
    }
  }

  try {
    await closeHandles(handles, repoRelativePath);
  } catch (closeFailure) {
    if (primaryFailure === null) primaryFailure = closeFailure;
  }
  throw primaryFailure;
}

async function revalidateDirectorySnapshots(context) {
  for (const snapshot of context.directorySnapshots) {
    const handleStat = await fsOperation(
      "fstat",
      context.repoRelativePath,
      () => snapshot.handle.stat()
    );
    const pathStat = await fsOperation(
      "lstat",
      context.repoRelativePath,
      () => lstat(snapshot.path)
    );
    if (!handleStat.isDirectory() || !pathStat.isDirectory() || pathStat.isSymbolicLink() ||
        !validStatFacts(handleStat) || !validStatFacts(pathStat) ||
        !sameFacts(snapshot.facts, fileFacts(handleStat)) ||
        !sameFacts(snapshot.facts, fileFacts(pathStat))) {
      failInvalid(context.repoRelativePath, context.sourceId);
    }
  }
}

async function revalidateOpenContext(context) {
  const afterHandleStat = await fsOperation(
    "fstat",
    context.repoRelativePath,
    () => context.leafHandle.stat()
  );
  const afterPathStat = await fsOperation(
    "lstat",
    context.repoRelativePath,
    () => lstat(context.absolutePath)
  );
  if (!afterHandleStat.isFile() || !afterPathStat.isFile() ||
      afterPathStat.isSymbolicLink() ||
      !validStatFacts(afterHandleStat) || !validStatFacts(afterPathStat) ||
      !sameFacts(context.beforeFacts, fileFacts(afterHandleStat)) ||
      !sameFacts(context.beforeFacts, fileFacts(afterPathStat))) {
    failInvalid(context.repoRelativePath, context.sourceId);
  }
  await revalidateDirectorySnapshots(context);
}

async function readOpenContext(context) {
  const bytes = Buffer.allocUnsafe(context.size);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await fsOperation(
      "read",
      context.repoRelativePath,
      () => context.leafHandle.read(bytes, offset, bytes.length - offset, offset)
    );
    if (result.bytesRead === 0) failInvalid(context.repoRelativePath, context.sourceId);
    offset += result.bytesRead;
  }

  await revalidateOpenContext(context);
  return Buffer.from(bytes);
}

async function closeContext(context) {
  if (context.closed) return;
  context.closed = true;
  await closeHandles(context.handles, context.repoRelativePath);
}

async function stableReadFile(rootDir, repoRelativePath, maxBytes, sourceId = null) {
  let context = null;
  let bytes = null;
  let primaryFailure = null;
  try {
    context = await openFileContext(rootDir, repoRelativePath, maxBytes, sourceId);
    bytes = await readOpenContext(context);
  } catch (error) {
    primaryFailure = error;
  }
  if (context !== null) {
    try {
      await closeContext(context);
    } catch (closeFailure) {
      if (primaryFailure === null) primaryFailure = closeFailure;
    }
  }
  if (primaryFailure !== null) throw primaryFailure;
  return { bytes, facts: context.beforeFacts };
}

async function stableFileFacts(rootDir, repoRelativePath, maxBytes, sourceId = null) {
  let context = null;
  let primaryFailure = null;
  try {
    context = await openFileContext(rootDir, repoRelativePath, maxBytes, sourceId);
    await revalidateOpenContext(context);
  } catch (error) {
    primaryFailure = error;
  }
  if (context !== null) {
    try {
      await closeContext(context);
    } catch (closeFailure) {
      if (primaryFailure === null) primaryFailure = closeFailure;
    }
  }
  if (primaryFailure !== null) throw primaryFailure;
  return { facts: context.beforeFacts, size: context.size };
}

async function stableReadWithExpectedFacts(
  rootDir,
  repoRelativePath,
  maxBytes,
  expectedFacts,
  sourceId = null
) {
  let context = null;
  let bytes = null;
  let primaryFailure = null;
  try {
    context = await openFileContext(rootDir, repoRelativePath, maxBytes, sourceId);
    if (!sameFacts(context.beforeFacts, expectedFacts)) {
      failInvalid(repoRelativePath, sourceId);
    }
    bytes = await readOpenContext(context);
  } catch (error) {
    primaryFailure = error;
  }
  if (context !== null) {
    try {
      await closeContext(context);
    } catch (closeFailure) {
      if (primaryFailure === null) primaryFailure = closeFailure;
    }
  }
  if (primaryFailure !== null) throw primaryFailure;
  return bytes;
}

async function readSelectedOutputs(rootDir, pointer, sourceById, selectedSourceIds) {
  const snapshots = [];
  const entries = [];
  let totalBytes = 0;
  for (const sourceId of selectedSourceIds) {
    const source = sourceById.get(sourceId);
    if (source === undefined) {
      failExpected("INVALID_CLEANING_INPUT", null, sourceId);
    }
    const path = `${pointer.run_path}/sources/${sourceId}.md`;
    const snapshot = await stableFileFacts(rootDir, path, OUTPUT_MAX_BYTES, sourceId);
    snapshots.push({ ...snapshot, source, path });
    totalBytes += snapshot.size;
    if (totalBytes > OUTPUT_TOTAL_MAX_BYTES) failInvalid(path, sourceId);
  }

  for (const { facts, source, path } of snapshots) {
    const bytes = await stableReadWithExpectedFacts(
      rootDir,
      path,
      OUTPUT_MAX_BYTES,
      facts,
      source.source_id
    );
    if (sha256(bytes) !== source.cleaned_sha256) failInvalid(path, source.source_id);
    if (source.audit !== null && source.audit.output_byte_length !== bytes.length) {
      failInvalid(path, source.source_id);
    }
    entries.push([source.source_id, Buffer.from(bytes)]);
  }
  return entries;
}

function makeReadonlyMap(entries) {
  const backing = new Map(entries.map(([key, value]) => [key, Buffer.from(value)]));
  let facade;
  facade = Object.freeze({
    get size() {
      return backing.size;
    },
    get(key) {
      return backing.get(key);
    },
    has(key) {
      return backing.has(key);
    },
    keys() {
      return backing.keys();
    },
    values() {
      return backing.values();
    },
    entries() {
      return backing.entries();
    },
    forEach(callback, thisArg) {
      if (typeof callback !== "function") throw programmerError("callback must be a function");
      backing.forEach((value, key) => callback.call(thisArg, value, key, facade));
    },
    [Symbol.iterator]() {
      return backing[Symbol.iterator]();
    }
  });
  return facade;
}

function validateArguments(options) {
  if (!isPlainObject(options)) throw programmerError("options must be an object");
  const allowed = new Set([
    "rootDir",
    "currentPointer",
    "selectedSourceIds",
    "readAdditionalArtifacts"
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw programmerError("options contains an unknown key");
  }
  if (!isNonEmptyString(options.rootDir)) throw programmerError("rootDir must be a string");
  if (!isNonEmptyString(options.currentPointer)) {
    throw programmerError("currentPointer must be a string");
  }
  const selectedSourceIds = options.selectedSourceIds === undefined
    ? []
    : options.selectedSourceIds;
  if (!isStrictlyIncreasing(selectedSourceIds, (value) =>
    typeof value === "string" && SOURCE_ID_PATTERN.test(value))) {
    throw programmerError("selectedSourceIds must be strictly increasing source IDs");
  }
  if (options.readAdditionalArtifacts !== undefined &&
      typeof options.readAdditionalArtifacts !== "function") {
    throw programmerError("readAdditionalArtifacts must be a function");
  }
  return { selectedSourceIds, readAdditionalArtifacts: options.readAdditionalArtifacts };
}

async function resolveRoot(rootDir) {
  try {
    return await realpath(rootDir);
  } catch (error) {
    throw new ReaderFailure(ioFailure("realpath", null));
  }
}

function validateCurrentPointerLocation(rootDir, requestedRootDir, currentPointer) {
  const resolvedPointer = isAbsolute(currentPointer)
    ? resolve(currentPointer)
    : resolve(rootDir, currentPointer);
  const expectedPointer = resolve(rootDir, POINTER_RELATIVE_PATH);
  const requestedRootPointer = resolve(requestedRootDir, POINTER_RELATIVE_PATH);
  if (resolvedPointer !== expectedPointer && resolvedPointer !== requestedRootPointer) {
    throw programmerError("currentPointer must resolve to the fixed cleaning pointer");
  }
}

function validateAdditionalRequest(request) {
  if (!hasExactKeys(request, ADDITIONAL_REQUEST_KEYS)) {
    throw programmerError("readVerifiedArtifact request has an invalid shape");
  }
  assertCanonicalAdditionalPath(request.repoRelativePath);
  if (!isSha256(request.expectedSha256)) {
    throw programmerError("expectedSha256 must be an exact lowercase SHA-256");
  }
  if (!isPositiveInteger(request.maxBytes) || request.maxBytes > OUTPUT_MAX_BYTES) {
    throw programmerError("maxBytes must be a positive safe integer no greater than 64 MiB");
  }
}

async function runAdditionalReads(rootDir, callback) {
  if (callback === undefined) return { additionalResult: null, readerFailure: null, callbackError: null };

  let active = true;
  let callCount = 0;
  let totalBytes = 0;
  let tail = Promise.resolve();
  const issued = [];

  function readVerifiedArtifact(request) {
    if (!active) {
      return Promise.reject(programmerError("read window is closed", "READ_WINDOW_CLOSED"));
    }
    validateAdditionalRequest(request);
    const issuanceIndex = callCount;
    callCount += 1;
    const task = tail.then(async () => {
      if (issuanceIndex >= ADDITIONAL_MAX_CALLS) {
        failInvalid(request.repoRelativePath);
      }
      const context = await openFileContext(
        rootDir,
        request.repoRelativePath,
        request.maxBytes
      );
      let bytes = null;
      let primaryFailure = null;
      try {
        if (totalBytes + context.size > ADDITIONAL_TOTAL_MAX_BYTES) {
          failInvalid(request.repoRelativePath);
        }
        totalBytes += context.size;
        bytes = await readOpenContext(context);
        if (sha256(bytes) !== request.expectedSha256) failInvalid(request.repoRelativePath);
      } catch (error) {
        primaryFailure = error;
      }
      try {
        await closeContext(context);
      } catch (closeFailure) {
        if (primaryFailure === null) primaryFailure = closeFailure;
      }
      if (primaryFailure !== null) throw primaryFailure;
      return Buffer.from(bytes);
    });
    tail = task.catch(() => {});
    const outcome = task.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error })
    );
    issued.push(outcome);
    return task;
  }

  let additionalResult = null;
  let callbackError = null;
  try {
    additionalResult = await callback({ readVerifiedArtifact });
  } catch (error) {
    callbackError = error;
  } finally {
    active = false;
  }

  let readerFailure = null;
  for (const outcomePromise of issued) {
    const outcome = await outcomePromise;
    if (!outcome.ok && outcome.error instanceof ReaderFailure && readerFailure === null) {
      readerFailure = outcome.error;
    }
  }
  return { additionalResult, readerFailure, callbackError };
}

export async function readCurrentCleaningState(options) {
  const { selectedSourceIds, readAdditionalArtifacts } = validateArguments(options);
  let rootDir;
  try {
    rootDir = await resolveRoot(options.rootDir);
    validateCurrentPointerLocation(rootDir, options.rootDir, options.currentPointer);

    const pointerBeforeRead = await stableReadFile(
      rootDir,
      POINTER_RELATIVE_PATH,
      POINTER_MAX_BYTES
    );
    const pointer = parseCanonicalDocument(pointerBeforeRead.bytes, POINTER_RELATIVE_PATH);
    validatePointer(pointer, POINTER_RELATIVE_PATH);

    const catalogRead = await stableReadFile(
      rootDir,
      pointer.catalog_path,
      CATALOG_MAX_BYTES
    );
    if (sha256(catalogRead.bytes) !== pointer.catalog_sha256) {
      failInvalid(pointer.catalog_path);
    }
    const catalogEntries = parseCanonicalCatalog(catalogRead.bytes, pointer.catalog_path);

    const reportRead = await stableReadFile(rootDir, pointer.report_path, REPORT_MAX_BYTES);
    if (sha256(reportRead.bytes) !== pointer.report_sha256) failInvalid(pointer.report_path);
    const report = parseCanonicalDocument(reportRead.bytes, pointer.report_path);
    validateReportAndCatalog(report, catalogEntries, pointer);

    const sourceById = new Map(
      report.run_preimage.sources.map((source) => [source.source_id, source])
    );
    for (const sourceId of selectedSourceIds) {
      if (!sourceById.has(sourceId)) {
        failExpected("INVALID_CLEANING_INPUT", null, sourceId);
      }
    }
    const selectedEntries = await readSelectedOutputs(
      rootDir,
      pointer,
      sourceById,
      selectedSourceIds
    );

    const additional = await runAdditionalReads(rootDir, readAdditionalArtifacts);
    let pointerAfterFailure = null;
    let pointerAfterRead = null;
    try {
      pointerAfterRead = await stableReadFile(
        rootDir,
        POINTER_RELATIVE_PATH,
        POINTER_MAX_BYTES
      );
      if (!pointerAfterRead.bytes.equals(pointerBeforeRead.bytes) ||
          !sameFacts(pointerAfterRead.facts, pointerBeforeRead.facts)) {
        failInvalid(POINTER_RELATIVE_PATH);
      }
    } catch (error) {
      pointerAfterFailure = error;
    }

    if (additional.readerFailure !== null) throw additional.readerFailure;
    if (pointerAfterFailure !== null) throw pointerAfterFailure;
    if (additional.callbackError !== null) throw additional.callbackError;

    return {
      ok: true,
      value: {
        pointer_bytes: Buffer.from(pointerBeforeRead.bytes),
        pointer,
        catalog_bytes: Buffer.from(catalogRead.bytes),
        catalog_entries: catalogEntries,
        report_bytes: Buffer.from(reportRead.bytes),
        report,
        selected_output_bytes: makeReadonlyMap(selectedEntries),
        additional_result: additional.additionalResult
      }
    };
  } catch (error) {
    if (error instanceof ReaderFailure) return error.result;
    throw error;
  }
}
