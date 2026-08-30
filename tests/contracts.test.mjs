import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  validateAgentKnowledgeBundle,
  validateCaseProvenance,
  validateContract,
  validateModelCaseCatalogShape,
  validateProblemSolvingFrameworkCatalogShape
} from "../tools/lib/contracts.mjs";
import { canonicalJsonBytes } from "../tools/lib/json.mjs";
import { sha256 } from "../tools/lib/hash.mjs";
import { readJsonl, writeJsonlBytes } from "../tools/lib/jsonl.mjs";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "curation");

function readFixture(name) {
  return readFile(join(FIXTURE_ROOT, name), "utf8").then((contents) => JSON.parse(contents));
}

function assertContractError(promise, code) {
  return assert.rejects(promise, (cause) => cause.code === code);
}

const TAXONOMY_VALID = {
  schema_version: "1.0.0",
  content_types: ["canonical", "card", "case", "comparison", "series", "related"],
  risk_flags: ["needs_ocr", "needs_medical_review", "needs_logic_review", "evidence_limited"],
  chapters: [
    ...Array.from({ length: 13 }, (_, index) => ({
      id: String(index).padStart(2, "0"),
      order: index,
      slug: `chapter-${index}`,
      title: `Chapter ${index}`,
      description: `desc-${index}`,
      baseline_source_count: 0,
      subchapters: [],
      allowed_tags: []
    }))
  ]
};

const MODEL_IDS = new Set(["model-primary", "model-related"]);
const PROBLEM_TYPE_IDS = new Set(["planning", "diagnosis"]);
const AGENT_STAGE_IDS = new Set(["planning", "execution"]);
const KNOWN_ASSET_IDS = new Set(["react-agent-chain"]);

const MODEL_CASES_VALID = {
  schema_version: "1.0.0",
  cases: [{
    id: "case-evidence-gated-retry",
    title: "成功码之后继续做语义验收",
    primary_model_id: "model-primary",
    related_model_ids: ["model-related"],
    problem_type_ids: ["planning"],
    agent_stage_ids: ["execution"],
    mapping: {
      candidate_model_id: "model-primary",
      relation_type: "behavioral",
      fit_score: 0.86,
      runner_up_model_id: "model-related",
      runner_up_score: 0.61,
      counterevidence: ["没有显式点名该模型"],
      status: "mapped"
    },
    case_kind: "execution",
    lifecycle_status: "candidate",
    summary: {
      situation: "工具返回成功，但业务产物为空。",
      goal: "确认任务是否真正完成。",
      key_actions: ["检查语义指标", "清理污染状态后重跑"],
      outcome: "有效产物通过独立验证。",
      lesson: "工具成功码不能代替结果验收。"
    },
    detail: {
      constraints: ["不能把退出码当作业务成功"],
      observable_steps: [{ order: 1, action: "执行工具", checkpoint: "读取业务指标" }],
      decisions: [{ decision: "拒绝空产物", rationale_summary: "关键业务指标仍为零。" }],
      corrections: [{ failure: "产物为空", correction: "清理缓存并从空目录重跑", result: "产物有效" }],
      verification: ["独立检查产物数量与引用关系"],
      limitations: ["低风险、结果显然的简单命令可使用轻量门禁"],
      failure_conditions: ["缺少可观察的结果指标"]
    },
    evidence: {
      status: "verified_outcome",
      plan_only: false,
      claims: [{
        claim: "重跑后的业务产物有效",
        claim_type: "fact",
        evidence_grade: "independent_verification",
        receipt_ids: ["receipt-independent-check"],
        freshness: "2026-07",
        invalidation_condition: "后续校验发现产物为空或引用断裂"
      }]
    },
    privacy: {
      deidentified: true,
      dlp_status: "pending_scan",
      publication_status: "pending_scan",
      dlp_receipt_sha256: null,
      redaction_summary: "移除项目名、路径和会话标识。"
    },
    tags: ["语义验收", "执行纠偏"],
    observed_at: "2026-07-22T00:00:00Z",
    verified_at: "2026-07-22T00:00:00Z",
    origin_kind: "session_derived"
  }]
};

const FRAMEWORKS_VALID = {
  schema_version: "1.0.0",
  frameworks: [{
    id: "framework-evidence-gated-react",
    name: "Evidence-Gated ReAct",
    lifecycle_status: "candidate",
    promotion_mode: "automatic",
    nearest_existing_asset_ids: ["react-agent-chain"],
    semantic_signature: {
      problem_representation: "把工具结果与目标状态分开表示。",
      decomposition_operators: ["按语义不变量拆解验证"],
      control_policy: "Act 后先进入证据门，再决定继续、修复或停止。",
      structural_invariants: ["成功码不等于语义成功"],
      leaf_task_contract: "每个动作都必须产生可观察输出和 verifier。",
      replanning_policy: "FAIL 时仅重规划受影响节点。",
      termination_condition: "所有关键语义不变量通过。",
      evaluation_contract: "由独立结果指标判断通过。"
    },
    human_version: {
      definition: "用语义证据约束行动—观察—修正循环。",
      triggers: ["工具成功但业务结果仍可能为空"],
      anti_triggers: ["低风险且结果可直接目测的单步任务"],
      steps: [{ order: 1, action: "声明语义不变量", checkpoint: "存在可验证指标" }],
      stop_conditions: ["缺少验证数据时保持 HOLD"],
      failure_modes: ["只检查退出码"]
    },
    ai_protocol: {
      inputs: ["目标", "约束", "语义指标"],
      state: ["READY", "PASS", "HOLD", "FAIL"],
      steps: [{ order: 1, action: "执行", branch: "按指标进入 PASS/HOLD/FAIL", checkpoint: "证据已绑定" }],
      tool_contracts: ["记录命令、退出状态和结果摘要"],
      stop_conditions: ["PASS 才允许晋级"],
      rollback_conditions: ["结果退化或来源失效"]
    },
    promotion_evidence: {
      independent_episode_count: 1,
      task_type_count: 1,
      failure_or_non_trigger_count: 1,
      case_ids: ["case-evidence-gated-retry"],
      task_type_ids: ["planning"],
      failure_or_non_trigger_case_ids: ["case-evidence-gated-retry"],
      comparison_summary: "相较基础 ReAct，增加语义证据与晋级授权。",
      verification_status: "insufficient_for_promotion",
      gate_receipt_sha256: null
    },
    privacy: {
      deidentified: true,
      dlp_status: "pending_scan",
      publication_status: "pending_scan",
      dlp_receipt_sha256: null,
      redaction_summary: "只保留去标识化框架结构。"
    }
  }]
};

const PROVENANCE_VALID = {
  schema_version: "1.0.0",
  records: [{
    case_id: "case-evidence-gated-retry",
    root_episode_id: "episode-local-001",
    source_spans: [{
      source_kind: "session",
      relative_path: "coding_session/sessions/synthetic.jsonl",
      artifact_sha256: "a".repeat(64),
      start_line: 1,
      end_line: 2,
      event_ids: ["event-10", "event-12"]
    }],
    extractor_version: "case-distiller-0.1.0",
    redactions: [{ kind: "local_path", count: 2 }],
    excluded_fields: ["reasoning", "encrypted_content", "agent_reasoning"],
    created_at: "2026-08-13T00:00:00Z",
    binding: {
      status: "captured",
      public_case_sha256: null,
      bound_at: null
    }
  }]
};

test("contract: accepts valid source summary fixture", async () => {
  const summary = await readFixture("source-summary-valid.json");
  assert.equal(validateContract("source-summary", summary), undefined);
});

test("contract: accepts valid problem route fixture", async () => {
  const routes = await readFixture("problem-routes-valid.json");
  assert.equal(validateContract("problem-routes", routes), undefined);
});

test("contract: rejects unknown root fields", async () => {
  const summary = await readFixture("source-summary-valid.json");
  await assertContractError(
    Promise.resolve().then(() => validateContract("source-summary", { ...summary, extra_field: true })),
    "CONTRACT_SCHEMA_INVALID"
  );
});

test("contract: rejects invalid schema version", async () => {
  const summary = await readFixture("source-summary-valid.json");
  const modified = structuredClone(summary);
  modified.schema_version = "0.9.0";
  await assertContractError(Promise.resolve().then(() => validateContract("source-summary", modified)), "CONTRACT_SCHEMA_INVALID");
});

test("contract: rejects duplicate route ids and preserves fail-fast", async () => {
  const invalidRoutes = await readFixture("problem-routes-invalid.json");
  await assertContractError(Promise.resolve().then(() => validateContract("problem-routes", invalidRoutes)), "CONTRACT_SCHEMA_INVALID");
});

test("contract: rejects taxonomy chapter unsorted and duplicate id", () => {
  const unsorted = structuredClone(TAXONOMY_VALID);
  unsorted.chapters = [
    unsorted.chapters[1],
    unsorted.chapters[0],
    ...unsorted.chapters.slice(2)
  ];
  unsorted.chapters[0].id = "01";
  unsorted.chapters[1].id = "01";

  assert.throws(() => validateContract("taxonomy", unsorted), (cause) => cause.code === "CONTRACT_SCHEMA_INVALID");
});

test("agent knowledge contracts: accept public cases, public frameworks, and private provenance", () => {
  assert.equal(validateModelCaseCatalogShape(MODEL_CASES_VALID, {
    modelIds: MODEL_IDS,
    problemTypeIds: PROBLEM_TYPE_IDS,
    agentStageIds: AGENT_STAGE_IDS
  }), undefined);
  assert.equal(validateProblemSolvingFrameworkCatalogShape(FRAMEWORKS_VALID, {
    caseIds: new Set(MODEL_CASES_VALID.cases.map((entry) => entry.id)),
    problemTypeIds: PROBLEM_TYPE_IDS,
    knownAssetIds: KNOWN_ASSET_IDS
  }), undefined);
  assert.equal(validateCaseProvenance(PROVENANCE_VALID, {
    caseIds: new Set(MODEL_CASES_VALID.cases.map((entry) => entry.id))
  }), undefined);
});

test("agent knowledge contracts: reject raw CoT and private provenance in public catalogs", () => {
  const withRawReasoning = structuredClone(MODEL_CASES_VALID);
  withRawReasoning.cases[0].reasoning = "private chain of thought";
  assert.throws(
    () => validateModelCaseCatalogShape(withRawReasoning, {
      modelIds: MODEL_IDS,
      problemTypeIds: PROBLEM_TYPE_IDS,
      agentStageIds: AGENT_STAGE_IDS
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path === "model-cases.cases[0]"
  );

  const withPrivateSource = structuredClone(MODEL_CASES_VALID);
  withPrivateSource.cases[0].source_path = "/Users/example/private/session.jsonl";
  assert.throws(
    () => validateModelCaseCatalogShape(withPrivateSource, {
      modelIds: MODEL_IDS,
      problemTypeIds: PROBLEM_TYPE_IDS,
      agentStageIds: AGENT_STAGE_IDS
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID"
  );
});

test("agent knowledge contracts: enforce mapping ambiguity and automatic promotion gates", () => {
  const ambiguous = structuredClone(MODEL_CASES_VALID);
  ambiguous.cases[0].mapping.fit_score = 0.77;
  ambiguous.cases[0].mapping.runner_up_score = 0.71;
  assert.throws(
    () => validateModelCaseCatalogShape(ambiguous, {
      modelIds: MODEL_IDS,
      problemTypeIds: PROBLEM_TYPE_IDS,
      agentStageIds: AGENT_STAGE_IDS
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.endsWith("mapping.status")
  );

  const premature = structuredClone(FRAMEWORKS_VALID);
  premature.frameworks[0].lifecycle_status = "automatically_promoted";
  premature.frameworks[0].promotion_evidence.verification_status = "promotion_gate_passed";
  assert.throws(
    () => validateProblemSolvingFrameworkCatalogShape(premature, {
      caseIds: new Set(MODEL_CASES_VALID.cases.map((entry) => entry.id)),
      problemTypeIds: PROBLEM_TYPE_IDS,
      knownAssetIds: KNOWN_ASSET_IDS
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.includes("promotion_evidence")
  );
});

test("agent knowledge contracts: represent unmapped cases without a fake primary model", () => {
  const awaiting = structuredClone(MODEL_CASES_VALID);
  awaiting.cases[0].primary_model_id = null;
  awaiting.cases[0].related_model_ids = [];
  awaiting.cases[0].mapping.fit_score = 0.72;
  awaiting.cases[0].mapping.status = "awaiting_mapping";
  awaiting.cases[0].lifecycle_status = "awaiting_mapping";
  assert.equal(validateModelCaseCatalogShape(awaiting, {
    modelIds: MODEL_IDS,
    problemTypeIds: PROBLEM_TYPE_IDS,
    agentStageIds: AGENT_STAGE_IDS
  }), undefined);

  awaiting.cases[0].primary_model_id = "model-primary";
  assert.throws(
    () => validateModelCaseCatalogShape(awaiting, {
      modelIds: MODEL_IDS,
      problemTypeIds: PROBLEM_TYPE_IDS,
      agentStageIds: AGENT_STAGE_IDS
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.endsWith("primary_model_id")
  );
});

test("agent knowledge contracts: standalone catalogs cannot self-authorize promotion", () => {
  const promoted = structuredClone(FRAMEWORKS_VALID);
  const evidence = promoted.frameworks[0].promotion_evidence;
  promoted.frameworks[0].lifecycle_status = "automatically_promoted";
  evidence.independent_episode_count = 3;
  evidence.task_type_count = 2;
  evidence.case_ids = ["case-a", "case-b", "case-c"];
  evidence.task_type_ids = ["diagnosis", "planning"];
  evidence.failure_or_non_trigger_case_ids = ["case-c"];
  evidence.verification_status = "promotion_gate_passed";
  evidence.gate_receipt_sha256 = "b".repeat(64);
  assert.throws(
    () => validateProblemSolvingFrameworkCatalogShape(promoted, {
      caseIds: new Set(["case-a", "case-b", "case-c"]),
      problemTypeIds: PROBLEM_TYPE_IDS,
      knownAssetIds: KNOWN_ASSET_IDS
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.endsWith("lifecycle_status")
  );

  promoted.frameworks[0].lifecycle_status = "candidate";
  evidence.verification_status = "insufficient_for_promotion";
  evidence.gate_receipt_sha256 = null;
  evidence.task_type_count = 3;
  assert.throws(
    () => validateProblemSolvingFrameworkCatalogShape(promoted, {
      caseIds: new Set(["case-a", "case-b", "case-c"]),
      problemTypeIds: PROBLEM_TYPE_IDS,
      knownAssetIds: KNOWN_ASSET_IDS
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.endsWith("task_type_count")
  );
});

test("agent knowledge contracts: private provenance requires all excluded reasoning fields", () => {
  const missingExclusion = structuredClone(PROVENANCE_VALID);
  missingExclusion.records[0].excluded_fields = ["reasoning", "encrypted_content"];
  assert.throws(
    () => validateCaseProvenance(missingExclusion, {
      caseIds: new Set(MODEL_CASES_VALID.cases.map((entry) => entry.id))
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.endsWith("excluded_fields")
  );
});

test("agent knowledge bundle: binds pending cases, receipts, and provenance hashes", () => {
  const cases = structuredClone(MODEL_CASES_VALID);
  const frameworks = structuredClone(FRAMEWORKS_VALID);
  const provenance = structuredClone(PROVENANCE_VALID);
  const caseRecord = cases.cases[0];
  const framework = frameworks.frameworks[0];
  provenance.records[0].binding = {
    status: "bound",
    public_case_sha256: sha256(canonicalJsonBytes(caseRecord)),
    bound_at: "2026-08-13T01:00:00Z"
  };
  const bundle = { cases, frameworks, provenance };
  const options = {
    modelIds: MODEL_IDS,
    problemTypeIds: PROBLEM_TYPE_IDS,
    agentStageIds: AGENT_STAGE_IDS,
    knownAssetIds: KNOWN_ASSET_IDS,
    receiptIds: new Set(["receipt-independent-check"])
  };
  assert.equal(validateAgentKnowledgeBundle(bundle, options), undefined);

  const mismatched = structuredClone(bundle);
  mismatched.provenance.records[0].binding.public_case_sha256 = "e".repeat(64);
  assert.throws(
    () => validateAgentKnowledgeBundle(mismatched, options),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.endsWith("provenance")
  );
});

test("agent knowledge bundle: cannot self-authorize automatic publication", () => {
  const cases = structuredClone(MODEL_CASES_VALID);
  const caseRecord = cases.cases[0];
  caseRecord.privacy.dlp_status = "passed";
  caseRecord.privacy.publication_status = "auto_publishable";
  caseRecord.privacy.dlp_receipt_sha256 = "c".repeat(64);
  const provenance = structuredClone(PROVENANCE_VALID);
  provenance.records[0].binding = {
    status: "bound",
    public_case_sha256: sha256(canonicalJsonBytes(caseRecord)),
    bound_at: "2026-08-13T01:00:00Z"
  };
  assert.throws(
    () => validateAgentKnowledgeBundle({
      cases,
      frameworks: structuredClone(FRAMEWORKS_VALID),
      provenance
    }, {
      modelIds: MODEL_IDS,
      problemTypeIds: PROBLEM_TYPE_IDS,
      agentStageIds: AGENT_STAGE_IDS,
      knownAssetIds: KNOWN_ASSET_IDS,
      receiptIds: new Set(["receipt-independent-check"]),
      dlpReceipts: new Map([[caseRecord.id, "c".repeat(64)]])
    }),
    (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.endsWith("publication_status")
  );
});

test("agent knowledge shapes: DLP passed remains ready but not publishable", () => {
  const cases = structuredClone(MODEL_CASES_VALID);
  cases.cases[0].privacy = {
    ...cases.cases[0].privacy,
    dlp_status: "passed",
    publication_status: "ready_not_publishable",
    dlp_receipt_sha256: "c".repeat(64)
  };
  assert.equal(validateModelCaseCatalogShape(cases, {
    modelIds: MODEL_IDS,
    problemTypeIds: PROBLEM_TYPE_IDS,
    agentStageIds: AGENT_STAGE_IDS
  }), undefined);

  const frameworks = structuredClone(FRAMEWORKS_VALID);
  frameworks.frameworks[0].privacy = {
    ...frameworks.frameworks[0].privacy,
    dlp_status: "passed",
    publication_status: "ready_not_publishable",
    dlp_receipt_sha256: "d".repeat(64)
  };
  assert.equal(validateProblemSolvingFrameworkCatalogShape(frameworks, {
    caseIds: new Set(MODEL_CASES_VALID.cases.map((entry) => entry.id)),
    problemTypeIds: PROBLEM_TYPE_IDS,
    knownAssetIds: KNOWN_ASSET_IDS
  }), undefined);
});

test("agent knowledge shapes: formal maturity is not publication authority", () => {
  const formal = structuredClone(MODEL_CASES_VALID);
  formal.cases[0].lifecycle_status = "formal";
  formal.cases[0].privacy = {
    ...formal.cases[0].privacy,
    dlp_status: "failed",
    publication_status: "quarantined",
    dlp_receipt_sha256: "e".repeat(64)
  };
  assert.equal(validateModelCaseCatalogShape(formal, {
    modelIds: MODEL_IDS,
    problemTypeIds: PROBLEM_TYPE_IDS,
    agentStageIds: AGENT_STAGE_IDS
  }), undefined);
  assert.notEqual(formal.cases[0].lifecycle_status, "published_formal");
});

test("agent knowledge contracts: block sensitive text in allowed public fields", () => {
  for (const sensitive of [
    "user@example.com",
    "file:///Users/example/private.jsonl",
    "/tmp/private-output.txt",
    "coding_session/sessions/private.jsonl",
    "api_key=synthetic-secret-value",
    "<analysis>private reasoning</analysis>"
  ]) {
    const catalog = structuredClone(MODEL_CASES_VALID);
    catalog.cases[0].summary.lesson = sensitive;
    assert.throws(
      () => validateModelCaseCatalogShape(catalog, {
        modelIds: MODEL_IDS,
        problemTypeIds: PROBLEM_TYPE_IDS,
        agentStageIds: AGENT_STAGE_IDS
      }),
      (cause) => cause.code === "AGENT_KNOWLEDGE_SCHEMA_INVALID" && cause.path.endsWith("summary.lesson")
    );
  }
});

test("agent knowledge contracts: compare mapping scores in fixed basis points", () => {
  const exactBoundary = structuredClone(MODEL_CASES_VALID);
  exactBoundary.cases[0].mapping.fit_score = 0.85;
  exactBoundary.cases[0].mapping.runner_up_score = 0.75;
  assert.equal(validateModelCaseCatalogShape(exactBoundary, {
    modelIds: MODEL_IDS,
    problemTypeIds: PROBLEM_TYPE_IDS,
    agentStageIds: AGENT_STAGE_IDS
  }), undefined);

  const belowBoundary = structuredClone(exactBoundary);
  belowBoundary.cases[0].mapping.runner_up_score = 0.7501;
  belowBoundary.cases[0].mapping.status = "awaiting_mapping";
  belowBoundary.cases[0].primary_model_id = null;
  belowBoundary.cases[0].related_model_ids = [];
  belowBoundary.cases[0].lifecycle_status = "awaiting_mapping";
  belowBoundary.cases[0].privacy.publication_status = "pending_scan";
  assert.equal(validateModelCaseCatalogShape(belowBoundary, {
    modelIds: MODEL_IDS,
    problemTypeIds: PROBLEM_TYPE_IDS,
    agentStageIds: AGENT_STAGE_IDS
  }), undefined);
});

test("contract: validates jsonl newline requirement", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "bm-contract-jsonl-"));
  const path = join(tempDir, "items.jsonl");
  const records = [{ source_id: "src_00000000000000000000000000000000" }, { source_id: "src_11111111111111111111111111111111" }];
  await writeFile(path, JSON.stringify(records[0]) + "\n" + JSON.stringify(records[1]));  // missing final newline
  await assertContractError(readJsonl(path), "JSONL_MISSING_EOF_NEWLINE");
  await writeFile(path, writeJsonlBytes(records));
  const parsed = await readJsonl(path);
  assert.deepEqual(parsed, records);
  await unlink(path);
});
