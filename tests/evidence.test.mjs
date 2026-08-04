import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  validateEvidenceClaim,
  validateSourceSummary
} from "../tools/lib/evidence.mjs";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "curation");

function readFixture(name) {
  return readFile(join(FIXTURE_ROOT, name), "utf8").then((contents) => JSON.parse(contents));
}

function assertEvidenceError(promise, code) {
  const wrapped = typeof promise === "function" ?
    Promise.resolve().then(promise) :
    Promise.resolve().then(() => promise);
  return assert.rejects(wrapped, (cause) => cause.code === code);
}

const SOURCE_A = "src_0123456789abcdef0123456789abcdef";
const SOURCE_B = "src_22222222222222222222222222222222";
const SOURCE_A_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SOURCE_B_SHA = "2222222222222222222222222222222222222222222222222222222222222222";

const BASE_EVIDENCE_STORE = {
  source_artifacts: {
    [SOURCE_A]: { cleaned_sha256: SOURCE_A_SHA, line_count: 24 },
    [SOURCE_B]: { cleaned_sha256: SOURCE_B_SHA, line_count: 18 }
  },
  approved_ocr_blocks: [
    {
      source_id: SOURCE_A,
      asset_id: "asset-a",
      block_ids: ["ocr-block-1", "ocr-block-2"],
      review_status: "approved"
    }
  ],
  verification_records: [
    {
      schema_version: "1.0.0",
      verification_id: "vrf-001",
      claim_id: "v_approved",
      source_id: SOURCE_A,
      url: "https://example.com/verified-a",
      publisher: "verified-source",
      title: "复核标题",
      accessed_at: "2026-08-01T00:00:00Z",
      retrieved_artifact_sha256: SOURCE_A_SHA,
      evidence_locator: "p-1",
      evidence_excerpt: "经审核确认",
      verification_result: "supports",
      evidence_note: "通过复核",
      review_status: "approved"
    },
    {
      schema_version: "1.0.0",
      verification_id: "vrf-002",
      claim_id: "unapproved-verification",
      source_id: SOURCE_A,
      url: "https://example.com/verify-pending",
      publisher: "pending-source",
      title: "未审批复核",
      accessed_at: "2026-08-01T00:00:00Z",
      retrieved_artifact_sha256: SOURCE_A_SHA,
      evidence_locator: "p-2",
      evidence_excerpt: "待审复核",
      verification_result: "supports",
      evidence_note: "待审批",
      review_status: "draft"
    }
  ]
};

test("evidence: rejects non-empty claim without valid references", async () => {
  const summary = await readFixture("source-summary-invalid-evidence.json");
  await assertEvidenceError(() => validateSourceSummary(summary, BASE_EVIDENCE_STORE), "EVIDENCE_REF_REQUIRED");
});

test("evidence: rejects cleaned_lines ref missing source_id", async () => {
  await assertEvidenceError(
    () => validateEvidenceClaim({
      claim_id: "missing-source",
      text: "测试文本",
      claim_status: "source_claim",
      evidence_refs: [{
        kind: "cleaned_lines",
        source_id: "",
        artifact_sha256: SOURCE_A_SHA,
        start_line: 1,
        end_line: 1
      }]
    }, BASE_EVIDENCE_STORE),
    "INVALID_EVIDENCE_REF_SOURCE"
  );
});

test("evidence: rejects cleaned_lines line out of range", async () => {
  await assertEvidenceError(
    () => validateEvidenceClaim({
      claim_id: "out-of-range",
      text: "测试文本",
      claim_status: "source_claim",
      evidence_refs: [{
        kind: "cleaned_lines",
        source_id: SOURCE_A,
        artifact_sha256: SOURCE_A_SHA,
        start_line: 1,
        end_line: 40
      }]
    }, BASE_EVIDENCE_STORE),
    "INVALID_EVIDENCE_REF_LINES"
  );
});

test("evidence: rejects cleaned_lines artifact hash mismatch", async () => {
  await assertEvidenceError(
    () => validateEvidenceClaim({
      claim_id: "hash-mismatch",
      text: "测试文本",
      claim_status: "source_claim",
      evidence_refs: [{
        kind: "cleaned_lines",
        source_id: SOURCE_A,
        artifact_sha256: SOURCE_B_SHA,
        start_line: 1,
        end_line: 1
      }]
    }, BASE_EVIDENCE_STORE),
    "EVIDENCE_ARTIFACT_MISMATCH"
  );
});

test("evidence: rejects missing approved OCR block", async () => {
  await assertEvidenceError(
    () => validateEvidenceClaim({
      claim_id: "missing-ocr",
      text: "测试文本",
      claim_status: "source_claim",
      evidence_refs: [{
        kind: "ocr_blocks",
        source_id: SOURCE_A,
        asset_id: "asset-no-exist",
        block_ids: ["missing"]
      }]
    }, BASE_EVIDENCE_STORE),
    "EVIDENCE_OCR_BLOCK_NOT_APPROVED"
  );
});

test("evidence: rejects cross-source consensus without two distinct sources", async () => {
  await assertEvidenceError(
    () => validateEvidenceClaim({
      claim_id: "single-consensus",
      text: "测试文本",
      claim_status: "cross_source_consensus",
      evidence_refs: [
        {
          kind: "cleaned_lines",
          source_id: SOURCE_A,
          artifact_sha256: SOURCE_A_SHA,
          start_line: 1,
          end_line: 1
        },
        {
          kind: "cleaned_lines",
          source_id: SOURCE_A,
          artifact_sha256: SOURCE_A_SHA,
          start_line: 2,
          end_line: 2
        }
      ]
    }, BASE_EVIDENCE_STORE),
    "EVIDENCE_CONSENSUS_QUORUM"
  );
});

test("evidence: rejects independently_verified claim without approved verification record", async () => {
  await assertEvidenceError(
    () => validateEvidenceClaim({
      claim_id: "unapproved-verification",
      text: "测试文本",
      claim_status: "independently_verified",
      evidence_refs: [{
        kind: "verification_record",
        source_id: SOURCE_A,
        verification_id: "vrf-002"
      }]
    }, BASE_EVIDENCE_STORE),
    "EVIDENCE_VERIFICATION_NOT_APPROVED"
  );
});

test("evidence: accepts source_claim with valid cleaned_lines", async () => {
  await validateEvidenceClaim({
    claim_id: "valid-cleaned",
    text: "测试文本",
    claim_status: "source_claim",
    evidence_refs: [{
      kind: "cleaned_lines",
      source_id: SOURCE_A,
      artifact_sha256: SOURCE_A_SHA,
      start_line: 1,
      end_line: 3
    }]
  }, BASE_EVIDENCE_STORE);
});

test("evidence: accepts source_claim with approved ocr block", async () => {
  await validateEvidenceClaim({
    claim_id: "valid-ocr",
    text: "测试文本",
    claim_status: "source_claim",
    evidence_refs: [{
      kind: "ocr_blocks",
      source_id: SOURCE_A,
      asset_id: "asset-a",
      block_ids: ["ocr-block-1"]
    }]
  }, BASE_EVIDENCE_STORE);
});

test("evidence: accepts cross_source_consensus with two distinct source IDs", async () => {
  await validateEvidenceClaim({
    claim_id: "valid-consensus",
    text: "测试文本",
    claim_status: "cross_source_consensus",
    evidence_refs: [
      {
        kind: "cleaned_lines",
        source_id: SOURCE_A,
        artifact_sha256: SOURCE_A_SHA,
        start_line: 1,
        end_line: 1
      },
      {
        kind: "cleaned_lines",
        source_id: SOURCE_B,
        artifact_sha256: SOURCE_B_SHA,
        start_line: 1,
        end_line: 1
      }
    ]
  }, BASE_EVIDENCE_STORE);
});

test("evidence: accepts independently_verified with approved verification record", async () => {
  await validateEvidenceClaim({
    claim_id: "v_approved",
    text: "测试文本",
    claim_status: "independently_verified",
    evidence_refs: [{
      kind: "verification_record",
      source_id: SOURCE_A,
      verification_id: "vrf-001"
    }]
  }, BASE_EVIDENCE_STORE);
});

test("evidence: accepts source-summary validation when claims all include legal evidence", async () => {
  const summary = await readFixture("source-summary-valid.json");
  const summaryWithEvidence = structuredClone(summary);
  summaryWithEvidence.core_question.evidence_refs = [{
    kind: "cleaned_lines",
    source_id: SOURCE_A,
    artifact_sha256: SOURCE_A_SHA,
    start_line: 1,
    end_line: 1
  }];
  summaryWithEvidence.core_conclusion.evidence_refs = [{
    kind: "cleaned_lines",
    source_id: SOURCE_A,
    artifact_sha256: SOURCE_A_SHA,
    start_line: 2,
    end_line: 2
  }];
  summaryWithEvidence.key_concepts[0].definition.evidence_refs = [{
    kind: "cleaned_lines",
    source_id: SOURCE_A,
    artifact_sha256: SOURCE_A_SHA,
    start_line: 3,
    end_line: 3
  }];
  await validateSourceSummary(summaryWithEvidence, BASE_EVIDENCE_STORE);
});
