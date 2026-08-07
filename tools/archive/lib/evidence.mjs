import { types } from "node:util";

import { validateContract } from "./contracts.mjs";

const CLAIM_STATUSES = new Set([
  "source_claim",
  "cross_source_consensus",
  "independently_verified",
  "conflicted"
]);
const EVIDENCE_KINDS = new Set([
  "cleaned_lines",
  "ocr_blocks",
  "verification_record"
]);
const REVIEW_STATUS_APPROVED = "approved";
const SOURCE_ID_RE = /^src_[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isString(value) {
  return typeof value === "string";
}

function isIntegerInRange(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && (max === null || value <= max);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function throwEvidenceError(code, path, details = "") {
  const error = new Error(details || code);
  error.code = code;
  if (path) error.path = path;
  throw error;
}

function getArtifactRecord(evidenceStore, sourceId) {
  if (!evidenceStore) return null;
  const map = evidenceStore.source_artifacts ??
    evidenceStore.cleaned_artifacts ??
    evidenceStore.sources ??
    evidenceStore.sourceArtifacts ??
    {};
  if (map instanceof Map) return map.get(sourceId) ?? null;
  if (isPlainObject(map)) return map[sourceId] ?? null;
  return null;
}

function assertSha256(value, path) {
  if (!SHA256_RE.test(value || "")) {
    throwEvidenceError("INVALID_SHA256", path);
  }
}

function assertSourceId(value, path) {
  if (!SOURCE_ID_RE.test(value || "")) {
    throwEvidenceError("INVALID_SOURCE_ID", path);
  }
}

function findVerifiedVerificationRecord(evidenceStore, sourceId, verificationId) {
  const candidates = toArray(evidenceStore?.verification_records ??
    evidenceStore?.verificationRecords ??
    []);
  return candidates.find((record) =>
    record &&
    isPlainObject(record) &&
    record.verification_id === verificationId &&
    record.source_id === sourceId &&
    record.review_status === REVIEW_STATUS_APPROVED
  ) || null;
}

function findVerificationRecordOrAny(evidenceStore, sourceId, verificationId) {
  const candidates = toArray(evidenceStore?.verification_records ??
    evidenceStore?.verificationRecords ??
    []);
  return candidates.find((record) =>
    record &&
    isPlainObject(record) &&
    record.verification_id === verificationId &&
    record.source_id === sourceId
  ) || null;
}

function isApprovedOcrBlock(evidenceStore, sourceId, assetId, blockId) {
  const records = toArray(evidenceStore?.approved_ocr_blocks ??
    evidenceStore?.ocr_blocks ??
    evidenceStore?.ocrRecords ??
    []);
  return records.some((record) => {
    if (!record || !isPlainObject(record)) return false;
    if (record.source_id !== sourceId || record.asset_id !== assetId) return false;
    if (record.review_status && record.review_status !== REVIEW_STATUS_APPROVED) return false;
    return Array.isArray(record.block_ids) && record.block_ids.includes(blockId);
  });
}

function isApprovedOcrRecord(evidenceStore, sourceId, assetId, blockIds) {
  if (!Array.isArray(blockIds) || blockIds.length === 0) {
    return false;
  }
  return blockIds.every((blockId) => isApprovedOcrBlock(evidenceStore, sourceId, assetId, blockId));
}

function assertEvidenceRefBasics(ref, path) {
  if (!isPlainObject(ref)) throwEvidenceError("EVIDENCE_REF_INVALID", path);
  if (!EVIDENCE_KINDS.has(ref.kind)) throwEvidenceError("EVIDENCE_REF_KIND_INVALID", `${path}.kind`);
  if (!isString(ref.source_id) || ref.source_id.length === 0) {
    throwEvidenceError("INVALID_EVIDENCE_REF_SOURCE", `${path}.source_id`);
  }
  assertSourceId(ref.source_id, `${path}.source_id`);
}

function validateEvidenceRef(ref, claim, context, path) {
  const claimSourceId = context.summarySourceId;
  const requiresSameSource = claim.claim_status !== "cross_source_consensus";

  assertEvidenceRefBasics(ref, path);
  if (requiresSameSource && claimSourceId && ref.source_id !== claimSourceId) {
    throwEvidenceError("EVIDENCE_SOURCE_MISMATCH", path);
  }

  if (ref.kind === "cleaned_lines") {
    if (!isString(ref.artifact_sha256)) throwEvidenceError("INVALID_EVIDENCE_REF_ARTIFACT", `${path}.artifact_sha256`);
    if (!isIntegerInRange(ref.start_line, 1, null) || !isIntegerInRange(ref.end_line, 1, null) || ref.start_line > ref.end_line) {
      throwEvidenceError("INVALID_EVIDENCE_REF_LINES", `${path}.lines`);
    }
    const artifact = getArtifactRecord(context.store, ref.source_id);
    if (!artifact) throwEvidenceError("EVIDENCE_ARTIFACT_NOT_FOUND", `${path}.source_id`);
    const expectedArtifactSha = isString(artifact.cleaned_sha256) ? artifact.cleaned_sha256 :
      isString(artifact.sha256) ? artifact.sha256 : null;
    if (!expectedArtifactSha) throwEvidenceError("EVIDENCE_ARTIFACT_MISSING_SHA", `${path}.artifact_sha256`);
    assertSha256(expectedArtifactSha, `${path}.artifact_sha256`);
    assertSha256(ref.artifact_sha256, `${path}.artifact_sha256`);
    if (artifact.cleaned_sha256 && artifact.cleaned_sha256 !== ref.artifact_sha256) {
      throwEvidenceError("EVIDENCE_ARTIFACT_MISMATCH", `${path}.artifact_sha256`);
    } else if (artifact.sha256 && artifact.sha256 !== ref.artifact_sha256) {
      throwEvidenceError("EVIDENCE_ARTIFACT_MISMATCH", `${path}.artifact_sha256`);
    }
    const lineCount = Number.isSafeInteger(artifact.line_count) ? artifact.line_count :
      Number.isSafeInteger(artifact.lines) ? artifact.lines : null;
    if (lineCount === null || lineCount < 1) throwEvidenceError("EVIDENCE_ARTIFACT_INVALID_LINES", `${path}.artifact`);
    if (ref.start_line > lineCount || ref.end_line > lineCount) {
      throwEvidenceError("INVALID_EVIDENCE_REF_LINES", `${path}.lines`);
    }
    return;
  }

  if (ref.kind === "ocr_blocks") {
    if (!isString(ref.asset_id) || ref.asset_id.length === 0) {
      throwEvidenceError("INVALID_EVIDENCE_REF_ASSET", `${path}.asset_id`);
    }
    if (!Array.isArray(ref.block_ids) || ref.block_ids.length === 0) {
      throwEvidenceError("INVALID_EVIDENCE_REF_BLOCKS", `${path}.block_ids`);
    }
    if (!isApprovedOcrRecord(context.store, ref.source_id, ref.asset_id, ref.block_ids)) {
      throwEvidenceError("EVIDENCE_OCR_BLOCK_NOT_APPROVED", `${path}.block_ids`);
    }
    return;
  }

  const verificationId = ref.verification_id;
  if (!isString(verificationId) || verificationId.length === 0) {
    throwEvidenceError("INVALID_EVIDENCE_REF_VERIFICATION", `${path}.verification_id`);
  }
  const anyRecord = findVerificationRecordOrAny(context.store, ref.source_id, verificationId);
  if (!anyRecord) {
    throwEvidenceError("EVIDENCE_VERIFICATION_NOT_FOUND", `${path}.verification_id`);
  }
  if (anyRecord.claim_id !== claim.claim_id) {
    throwEvidenceError("EVIDENCE_VERIFICATION_CLAIM_MISMATCH", `${path}.verification_id`);
  }
  if (anyRecord.review_status !== REVIEW_STATUS_APPROVED) {
    throwEvidenceError("EVIDENCE_VERIFICATION_NOT_APPROVED", `${path}.verification_id`);
  }
  if (!RFC3339_RE.test(`${anyRecord.accessed_at}`)) {
    throwEvidenceError("INVALID_VERIFICATION_ACCESS_TIME", `${path}.verification_record`);
  }
}

function validateEvidenceClaim(claim, evidenceStore = {}) {
  const context = { store: evidenceStore, summarySourceId: evidenceStore.source_id ?? null };
  if (!isPlainObject(claim)) throwEvidenceError("EVIDENCE_CLAIM_INVALID", "claim");
  const allowed = new Set(["claim_id", "text", "claim_status", "evidence_refs"]);
  if (Object.keys(claim).some((key) => !allowed.has(key))) {
    throwEvidenceError("EVIDENCE_CLAIM_UNKNOWN_FIELDS", "claim");
  }
  if (!isString(claim.claim_id) || claim.claim_id.length === 0) {
    throwEvidenceError("EVIDENCE_CLAIM_ID_INVALID", "claim.claim_id");
  }
  if (!isString(claim.text)) {
    throwEvidenceError("EVIDENCE_CLAIM_TEXT_INVALID", `claim.${claim.claim_id || "text"}`);
  }
  if (!CLAIM_STATUSES.has(claim.claim_status)) {
    throwEvidenceError("EVIDENCE_CLAIM_STATUS_INVALID", `claim.${claim.claim_id}.claim_status`);
  }
  if (!Array.isArray(claim.evidence_refs)) throwEvidenceError("EVIDENCE_REF_NOT_ARRAY", `claim.${claim.claim_id}.evidence_refs`);

  const hasText = claim.text.trim().length > 0;
  if (hasText && claim.evidence_refs.length === 0) {
    throwEvidenceError("EVIDENCE_REF_REQUIRED", `claim.${claim.claim_id}.evidence_refs`);
  }

  const seenSources = new Set();
  for (const [index, ref] of claim.evidence_refs.entries()) {
    const refPath = `claim.${claim.claim_id}.evidence_refs[${index}]`;
    if (!isPlainObject(ref)) throwEvidenceError("EVIDENCE_REF_INVALID", refPath);
    validateEvidenceRef(ref, claim, context, refPath);
    if (isString(ref.source_id)) seenSources.add(ref.source_id);
  }

  if (claim.claim_status === "cross_source_consensus") {
    if (seenSources.size < 2) {
      throwEvidenceError("EVIDENCE_CONSENSUS_QUORUM", `claim.${claim.claim_id}`);
    }
  }

  if (claim.claim_status === "independently_verified") {
    const hasApprovedVerification = claim.evidence_refs.some((ref) =>
      ref.kind === "verification_record" &&
      findVerifiedVerificationRecord(context.store, ref.source_id, ref.verification_id) !== null
    );
    if (!hasApprovedVerification) throwEvidenceError("EVIDENCE_VERIFICATION_REQUIRED", `claim.${claim.claim_id}`);
  }
}

function assertUniqueClaimIds(claimEntries) {
  const seen = new Set();
  for (const { claim_id, path } of claimEntries) {
    if (seen.has(claim_id)) throwEvidenceError("SOURCE_SUMMARY_DUPLICATE_CLAIM_ID", path);
    seen.add(claim_id);
  }
}

function collectClaimsFromSummary(summary) {
  const collected = [];
  const pushClaim = (path, claim) => {
    if (claim === null) return;
    if (!isPlainObject(claim)) {
      throwEvidenceError("SOURCE_SUMMARY_CLAIM_INVALID", path);
    }
    collected.push({ path: `summary.${path}`, claim_id: `${claim.claim_id}`, claim });
  };

  pushClaim("core_question", summary.core_question);
  pushClaim("core_conclusion", summary.core_conclusion);

  for (const [keyIndex, concept] of summary.key_concepts.entries()) {
    if (concept === null || !isPlainObject(concept)) {
      throwEvidenceError("SOURCE_SUMMARY_KEY_CONCEPT_INVALID", `summary.key_concepts[${keyIndex}]`);
    }
    if (!isString(concept.term) || concept.term.length === 0) {
      throwEvidenceError("SOURCE_SUMMARY_KEY_CONCEPT_TERM_INVALID", `summary.key_concepts[${keyIndex}].term`);
    }
    pushClaim(`key_concepts[${keyIndex}].definition`, concept.definition);
  }

  for (const [mechanismIndex, claim] of summary.mechanisms.entries()) {
    pushClaim(`mechanisms[${mechanismIndex}]`, claim);
  }

  for (const [methodIndex, method] of summary.methods.entries()) {
    if (!isPlainObject(method)) throwEvidenceError("SOURCE_SUMMARY_METHOD_INVALID", `summary.methods[${methodIndex}]`);
    pushClaim(`methods[${methodIndex}].name`, method.name);
    if (!Array.isArray(method.steps)) throwEvidenceError("SOURCE_SUMMARY_METHOD_STEPS_INVALID", `summary.methods[${methodIndex}].steps`);
    for (const [stepIndex, step] of method.steps.entries()) {
      if (!isPlainObject(step)) throwEvidenceError("SOURCE_SUMMARY_METHOD_STEP_INVALID", `summary.methods[${methodIndex}].steps[${stepIndex}]`);
      if (!isPlainObject(step.claim)) throwEvidenceError("SOURCE_SUMMARY_METHOD_CLAIM_INVALID", `summary.methods[${methodIndex}].steps[${stepIndex}].claim`);
      pushClaim(`methods[${methodIndex}].steps[${stepIndex}].claim`, step.claim);
    }
    for (const [useCaseIndex, claim] of method.use_cases.entries()) {
      pushClaim(`methods[${methodIndex}].use_cases[${useCaseIndex}]`, claim);
    }
    for (const [stopIndex, claim] of method.stop_conditions.entries()) {
      pushClaim(`methods[${methodIndex}].stop_conditions[${stopIndex}]`, claim);
    }
  }

  for (const [index, claim] of summary.use_cases.entries()) {
    pushClaim(`use_cases[${index}]`, claim);
  }
  for (const [index, claim] of summary.limitations.entries()) {
    pushClaim(`limitations[${index}]`, claim);
  }
  for (const [index, claim] of summary.unique_contributions.entries()) {
    pushClaim(`unique_contributions[${index}]`, claim);
  }

  return collected;
}

function validateSourceSummary(summary, evidenceStore = {}) {
  validateContract("source-summary", summary);

  const claims = collectClaimsFromSummary(summary);
  assertUniqueClaimIds(claims);
  const contextStore = { ...evidenceStore, source_id: summary.source_id };

  for (const entry of claims) {
    validateEvidenceClaim(entry.claim, contextStore);
  }
}

export { validateEvidenceClaim, validateSourceSummary };
