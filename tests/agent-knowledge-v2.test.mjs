import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveCaseIdentitySha256V2,
  deriveClaimSha256V2,
  deriveDlpSubjectSha256V2,
  deriveSourceBindingSha256V2,
  validateCaseClaimBundleV2Shape,
  validateCaseProvenance,
  validateCaseProvenanceV2Shape
} from "../tools/lib/contracts.mjs";
import { sha256 } from "../tools/lib/hash.mjs";
import { canonicalJsonBytes } from "../tools/lib/json.mjs";

const HEX = Object.freeze({
  episode: "1".repeat(64),
  store: "2".repeat(64),
  file: "3".repeat(64),
  manifest: "4".repeat(64),
  projection: "5".repeat(64),
  plan: "6".repeat(64),
  policy: "7".repeat(64),
  dlpReceipt: "8".repeat(64),
  evidenceReceipt: "9".repeat(64)
});

const MODEL_IDS = new Set(["model-unused"]);
const PROBLEM_TYPE_IDS = new Set(["planning"]);
const AGENT_STAGE_IDS = new Set(["execution"]);

function sessionBinding() {
  return {
    kind: "p2_session_projection_v1",
    root_episode_hmac: HEX.episode,
    store_digest: HEX.store,
    lineage_status: "consistent",
    sources: [{
      file_id_hmac: HEX.file,
      projection_manifest_hmac: HEX.manifest,
      records: [{
        record_no: 0,
        event_kind: "session_meta",
        projection_hmac: HEX.projection
      }]
    }]
  };
}

function cursorPlanBinding() {
  return {
    kind: "p2_cursor_plan_v1",
    plan_hmac: HEX.plan,
    lineage_status: "not_applicable"
  };
}

function baseCase() {
  return {
    id: "case-placeholder",
    title: "语义验收案例",
    primary_model_id: null,
    related_model_ids: [],
    problem_type_ids: ["planning"],
    agent_stage_ids: ["execution"],
    mapping: {
      candidate_model_id: null,
      relation_type: null,
      fit_score: 0,
      runner_up_model_id: null,
      runner_up_score: 0,
      counterevidence: [],
      status: "awaiting_mapping"
    },
    case_kind: "execution",
    lifecycle_status: "awaiting_mapping",
    summary: {
      situation: "工具成功但业务结果仍需验证。",
      goal: "确认业务结果有效。",
      key_actions: ["检查语义指标"],
      outcome: "结果通过验证。",
      lesson: "退出码不能代替业务验收。"
    },
    detail: {
      constraints: ["只使用去标识化信息"],
      observable_steps: [{ order: 1, action: "检查指标", checkpoint: "指标非零" }],
      decisions: [{ decision: "继续验证", rationale_summary: "业务指标仍需确认。" }],
      corrections: [],
      verification: ["独立检查结果"],
      limitations: ["低风险单步任务可简化"],
      failure_conditions: ["缺少可观察指标"]
    },
    evidence: {
      status: "verified_outcome",
      plan_only: false,
      claims: [{
        claim: "业务结果通过独立检查。",
        claim_type: "fact",
        evidence_grade: "independent_verification",
        receipt_ids: [`receipt-${HEX.evidenceReceipt}`],
        freshness: "2026-08",
        invalidation_condition: "后续检查发现结果为空"
      }]
    },
    privacy: {
      deidentified: true,
      dlp_status: "passed",
      publication_status: "pending_mapping",
      dlp_receipt_sha256: HEX.dlpReceipt,
      redaction_summary: "仅保留去标识化的任务结构。"
    },
    tags: ["语义验收"],
    observed_at: "2026-08-13T00:00:00Z",
    verified_at: "2026-08-13T00:00:00Z",
    origin_kind: "session_derived"
  };
}

function identityCaseProjection(caseRecord) {
  const { id: _id, ...withoutId } = caseRecord;
  return {
    ...withoutId,
    evidence: {
      ...withoutId.evidence,
      claims: withoutId.evidence.claims.map((claim) => ({ ...claim, receipt_ids: [] }))
    },
    privacy: {
      ...withoutId.privacy,
      dlp_status: "pending_scan",
      publication_status: "pending_scan",
      dlp_receipt_sha256: null
    }
  };
}

function dlpSubjectProjection(caseRecord) {
  return {
    ...caseRecord,
    privacy: {
      ...caseRecord.privacy,
      dlp_status: "pending_scan",
      publication_status: "pending_scan",
      dlp_receipt_sha256: null
    }
  };
}

function claimProjection(claim) {
  const { receipt_ids: _receiptIds, ...withoutReceipts } = claim;
  return withoutReceipts;
}

function buildBundle(sourceBindings = [sessionBinding()]) {
  const sourceBindingSha256 = sha256(canonicalJsonBytes(sourceBindings));
  const caseRecord = baseCase();
  const identitySha256 = sha256(canonicalJsonBytes({
    case: identityCaseProjection(caseRecord),
    source_binding_sha256: sourceBindingSha256
  }));
  caseRecord.id = `case-${identitySha256}`;
  const claimSha256 = sha256(canonicalJsonBytes(claimProjection(caseRecord.evidence.claims[0])));
  const dlpSubjectSha256 = sha256(canonicalJsonBytes(dlpSubjectProjection(caseRecord)));
  const provenance = {
    schema_version: "2.0.0",
    records: [{
      case_id: caseRecord.id,
      case_identity_sha256: identitySha256,
      source_bindings: sourceBindings,
      source_binding_sha256: sourceBindingSha256,
      extractor_version: "case-claim-compiler-0.1.0",
      redactions: [{ kind: "local_path", count: 1 }],
      excluded_fields: ["agent_reasoning", "encrypted_content", "reasoning"],
      created_at: "2026-08-13T00:01:00Z",
      receipt_bindings: {
        dlp: {
          receipt_id: `receipt-${"a".repeat(64)}`,
          receipt_sha256: HEX.dlpReceipt,
          subject_sha256: dlpSubjectSha256,
          policy_id: "local-agent-knowledge-dlp",
          policy_version: "1.0.0",
          policy_hash: HEX.policy,
          result: "passed",
          status: "active"
        },
        claims: [{
          claim_index: 0,
          claim_sha256: claimSha256,
          calibration: {
            claim_role: "fact",
            calibration_status: "receipt_verified",
            basis: "authenticated_receipt"
          },
          expected_receipt: {
            subject_id: `${caseRecord.id}:claim:0`,
            subject_sha256: identitySha256,
            evidence_grade: "independent_verification",
            policy_id: "synthetic-evidence-policy",
            policy_version: "1.0.0",
            policy_hash: HEX.policy,
            result: "verified",
            status: "active"
          },
          receipts: [{
            receipt_id: `receipt-${HEX.evidenceReceipt}`,
            receipt_sha256: "b".repeat(64)
          }]
        }]
      },
      binding: {
        status: "bound",
        public_case_sha256: sha256(canonicalJsonBytes(caseRecord)),
        bound_at: "2026-08-13T00:02:00Z"
      }
    }]
  };
  return {
    cases: { schema_version: "1.0.0", cases: [caseRecord] },
    provenance,
    publication_authority: false
  };
}

function rebindBundle(bundle) {
  const caseRecord = bundle.cases.cases[0];
  const record = bundle.provenance.records[0];
  const sourceDigest = sha256(canonicalJsonBytes(record.source_bindings));
  const identityDigest = sha256(canonicalJsonBytes({
    case: identityCaseProjection(caseRecord),
    source_binding_sha256: sourceDigest
  }));
  caseRecord.id = `case-${identityDigest}`;
  record.case_id = caseRecord.id;
  record.case_identity_sha256 = identityDigest;
  record.source_binding_sha256 = sourceDigest;
  for (const [claimIndex, claim] of caseRecord.evidence.claims.entries()) {
    const claimBinding = record.receipt_bindings.claims[claimIndex];
    claimBinding.claim_sha256 = sha256(canonicalJsonBytes(claimProjection(claim)));
    if (claimBinding.expected_receipt !== null) {
      claimBinding.expected_receipt.subject_id = `${caseRecord.id}:claim:${claimIndex}`;
      claimBinding.expected_receipt.subject_sha256 = identityDigest;
    }
  }
  record.receipt_bindings.dlp.subject_sha256 = sha256(canonicalJsonBytes(dlpSubjectProjection(caseRecord)));
  record.binding.public_case_sha256 = sha256(canonicalJsonBytes(caseRecord));
  return bundle;
}

function buildPlanBundle() {
  const bundle = buildBundle([cursorPlanBinding()]);
  const caseRecord = bundle.cases.cases[0];
  const claimBinding = bundle.provenance.records[0].receipt_bindings.claims[0];
  caseRecord.origin_kind = "cursor_plan_derived";
  caseRecord.case_kind = "plan";
  caseRecord.evidence.status = "plan_only";
  caseRecord.evidence.plan_only = true;
  caseRecord.evidence.claims[0] = {
    claim: "该记录只证明计划内容存在。",
    claim_type: "unknown",
    evidence_grade: "none",
    receipt_ids: [],
    freshness: "2026-08",
    invalidation_condition: "发现独立执行回执"
  };
  caseRecord.verified_at = null;
  claimBinding.calibration = {
    claim_role: "unknown",
    calibration_status: "unknown",
    basis: "no_receipt"
  };
  claimBinding.expected_receipt = null;
  claimBinding.receipts = [];
  return rebindBundle(bundle);
}

function buildPartiallyVerifiedBundle() {
  const bundle = buildBundle();
  const caseRecord = bundle.cases.cases[0];
  caseRecord.evidence.status = "partially_verified";
  caseRecord.evidence.claims.push({
    claim: "第二条事实只有报告且没有独立回执。",
    claim_type: "fact",
    evidence_grade: "reported_only",
    receipt_ids: [],
    freshness: "2026-08",
    invalidation_condition: "收到独立验证"
  });
  bundle.provenance.records[0].receipt_bindings.claims.push({
    claim_index: 1,
    claim_sha256: "0".repeat(64),
    calibration: {
      claim_role: "fact",
      calibration_status: "reported",
      basis: "no_receipt"
    },
    expected_receipt: null,
    receipts: []
  });
  return rebindBundle(bundle);
}

const OPTIONS = Object.freeze({
  modelIds: MODEL_IDS,
  problemTypeIds: PROBLEM_TYPE_IDS,
  agentStageIds: AGENT_STAGE_IDS,
  dlpPolicy: {
    policy_id: "local-agent-knowledge-dlp",
    policy_version: "1.0.0",
    policy_hash: HEX.policy
  },
  evidencePolicies: new Map([["synthetic-evidence-policy", {
    policy_version: "1.0.0",
    policy_hash: HEX.policy
  }]])
});

test("provenance v2: coexists with v1 and accepts session plus Cursor Plan HMAC bindings", () => {
  const sessionBundle = buildBundle();
  assert.equal(validateCaseProvenanceV2Shape(sessionBundle.provenance, {
    caseIds: new Set([sessionBundle.cases.cases[0].id])
  }), undefined);
  assert.equal(validateCaseClaimBundleV2Shape(sessionBundle, OPTIONS), undefined);

  const planBundle = buildPlanBundle();
  assert.equal(validateCaseClaimBundleV2Shape(planBundle, OPTIONS), undefined);

  assert.throws(
    () => validateCaseProvenance(sessionBundle.provenance, {
      caseIds: new Set([sessionBundle.cases.cases[0].id])
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID"
  );
});

test("provenance v2: Cursor Plan bindings remain plan-only after every digest is recomputed", () => {
  const forgedExecution = buildPlanBundle();
  const caseRecord = forgedExecution.cases.cases[0];
  caseRecord.case_kind = "execution";
  caseRecord.evidence.status = "reported_outcome";
  caseRecord.evidence.plan_only = false;
  rebindBundle(forgedExecution);
  assert.throws(
    () => validateCaseClaimBundleV2Shape(forgedExecution, OPTIONS),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.includes("case_kind")
  );
});

test("provenance v2: Case evidence status is derived from the complete calibration ledger", () => {
  const partial = buildPartiallyVerifiedBundle();
  assert.equal(validateCaseClaimBundleV2Shape(partial, OPTIONS), undefined);

  partial.cases.cases[0].evidence.status = "verified_outcome";
  rebindBundle(partial);
  assert.throws(
    () => validateCaseClaimBundleV2Shape(partial, OPTIONS),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.includes("evidence.status")
  );
});

test("provenance v2: derivation helpers match independent canonical preimages", () => {
  const bundle = buildBundle();
  const caseRecord = bundle.cases.cases[0];
  const sourceBindings = bundle.provenance.records[0].source_bindings;
  assert.equal(
    deriveSourceBindingSha256V2(sourceBindings),
    sha256(canonicalJsonBytes(sourceBindings))
  );
  assert.equal(
    deriveCaseIdentitySha256V2(caseRecord, sourceBindings),
    sha256(canonicalJsonBytes({
      case: identityCaseProjection(caseRecord),
      source_binding_sha256: sha256(canonicalJsonBytes(sourceBindings))
    }))
  );
  assert.equal(
    deriveClaimSha256V2(caseRecord.evidence.claims[0]),
    sha256(canonicalJsonBytes(claimProjection(caseRecord.evidence.claims[0])))
  );
  assert.equal(
    deriveDlpSubjectSha256V2(caseRecord),
    sha256(canonicalJsonBytes(dlpSubjectProjection(caseRecord)))
  );
});

test("provenance v2: rejects raw identifiers, unknown fields, ordering drift, and digest tampering", () => {
  const raw = buildBundle();
  raw.provenance.records[0].source_bindings[0].session_id = "raw-session";
  assert.throws(
    () => validateCaseClaimBundleV2Shape(raw, OPTIONS),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID"
  );

  const unordered = buildBundle();
  const source = unordered.provenance.records[0].source_bindings[0].sources[0];
  source.records = [
    { record_no: 2, event_kind: "task_complete", projection_hmac: "a".repeat(64) },
    ...source.records
  ];
  assert.throws(
    () => validateCaseClaimBundleV2Shape(unordered, OPTIONS),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.includes("records")
  );

  for (const mutate of [
    (bundle) => { bundle.provenance.records[0].source_binding_sha256 = "b".repeat(64); },
    (bundle) => { bundle.provenance.records[0].case_identity_sha256 = "c".repeat(64); },
    (bundle) => { bundle.provenance.records[0].binding.public_case_sha256 = "d".repeat(64); },
    (bundle) => { bundle.provenance.records[0].receipt_bindings.claims[0].claim_sha256 = "e".repeat(64); },
    (bundle) => { bundle.provenance.records[0].receipt_bindings.claims[0].expected_receipt.subject_sha256 = "e".repeat(64); },
    (bundle) => { bundle.provenance.records[0].receipt_bindings.claims[0].expected_receipt.policy_hash = "e".repeat(64); },
    (bundle) => { bundle.provenance.records[0].receipt_bindings.dlp.subject_sha256 = "f".repeat(64); }
  ]) {
    const tampered = buildBundle();
    mutate(tampered);
    assert.throws(
      () => validateCaseClaimBundleV2Shape(tampered, OPTIONS),
      (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID"
    );
  }
});

test("provenance v2: keeps publication authority closed and binds exact receipt sets", () => {
  const authorized = buildBundle();
  authorized.publication_authority = true;
  assert.throws(
    () => validateCaseClaimBundleV2Shape(authorized, OPTIONS),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.endsWith("publication_authority")
  );

  const reused = buildBundle();
  reused.provenance.records[0].receipt_bindings.claims[0].receipts[0].receipt_id = `receipt-${"b".repeat(64)}`;
  assert.throws(
    () => validateCaseClaimBundleV2Shape(reused, OPTIONS),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.includes("receipt_bindings.claims")
  );

  const wrongDlp = buildBundle();
  wrongDlp.provenance.records[0].receipt_bindings.dlp.receipt_sha256 = "c".repeat(64);
  assert.throws(
    () => validateCaseClaimBundleV2Shape(wrongDlp, OPTIONS),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.includes("receipt_bindings.dlp")
  );
});

test("provenance v2: owns every receipt id globally across claims, cases, and policies", () => {
  const acrossClaims = buildBundle();
  const claimBinding = acrossClaims.provenance.records[0].receipt_bindings.claims[0];
  acrossClaims.provenance.records[0].receipt_bindings.claims.push({
    ...structuredClone(claimBinding),
    claim_index: 1,
    claim_sha256: "c".repeat(64),
    expected_receipt: {
      ...claimBinding.expected_receipt,
      subject_id: `${acrossClaims.cases.cases[0].id}:claim:1`,
      policy_id: "second-policy"
    }
  });
  assert.throws(
    () => validateCaseProvenanceV2Shape(acrossClaims.provenance, {
      caseIds: new Set([acrossClaims.cases.cases[0].id])
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.includes("receipt_id")
  );

  const dlpCollision = buildBundle();
  dlpCollision.provenance.records[0].receipt_bindings.dlp.receipt_id =
    dlpCollision.provenance.records[0].receipt_bindings.claims[0].receipts[0].receipt_id;
  assert.throws(
    () => validateCaseProvenanceV2Shape(dlpCollision.provenance, {
      caseIds: new Set([dlpCollision.cases.cases[0].id])
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.includes("receipt_id")
  );

  const acrossCases = buildBundle();
  const firstRecord = acrossCases.provenance.records[0];
  const secondIdentity = firstRecord.case_identity_sha256 === "0".repeat(64)
    ? "f".repeat(64)
    : "0".repeat(64);
  const secondRecord = structuredClone(firstRecord);
  secondRecord.case_id = `case-${secondIdentity}`;
  secondRecord.case_identity_sha256 = secondIdentity;
  acrossCases.provenance.records.push(secondRecord);
  acrossCases.provenance.records.sort((left, right) => left.case_id.localeCompare(right.case_id));
  assert.throws(
    () => validateCaseProvenanceV2Shape(acrossCases.provenance, {
      caseIds: new Set(acrossCases.provenance.records.map((record) => record.case_id))
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.includes("receipt_id")
  );
});
