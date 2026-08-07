# Semantic Curation and Codex Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 418 份来源逐一形成可追溯的深度摘要，通过三层去重融合为 13 章综合知识模型，并为每个 ready 模型维护一张可直接驱动 Codex 联合解题的应用卡。

**Architecture:** 私有 JSONL 保存来源全文证据、OCR、摘要、去重贡献和人工复核；公开 JSON 保存最小来源元数据、分类、关系、风险和问题路由；模型与章节使用 Markdown。验证器从模型 Markdown 的固定元数据与标题合同生成站点数据，不人工维护第二份模型索引。

**Tech Stack:** Node.js 24.18.0 LTS、原生 ESM、`node:test`、JSON/JSONL、Markdown、Codex 语义策展、可选本地 OCR 或 Codex 视觉复核。

## Global Constraints

- 先完成并验证本地来源与清洗计划。
- 只在 `main` 工作，禁止 worktree。
- shell 命令遵守总计划 Gate 0。
- 不自动 commit、改历史、push 或发布。
- 不把 `.local/` 中的全文、OCR、证据片段、私人笔记或绝对路径复制到公开文件。
- 任何公开结论都必须能追溯到至少一个 `source_id`；来源主张与独立核验结论必须区分。
- 图片主导资料在 OCR/视觉复核通过前不得生成正文摘要或模型贡献。
- 标题、文件名、发布日期和相邻文章不能作为正文证据。
- 不同数字体系、理论层级、用途或适用边界不能仅因标题相似而合并。
- 每个来源和模型恰有一个主章节；跨主题只用标签和关系。
- 每个 ready 模型恰有一张完整 Codex 共学应用卡。
- 医学、心理危机和其他高风险建议必须显示停止条件与专业升级条件。
- 本计划允许 `needs_ocr`、`needs_medical_review` 和 `needs_review` 作为诚实终态；不为追求全 ready 而补写。

---

## File Map

公开知识文件：

```text
knowledge/taxonomy.json
knowledge/sources.json
knowledge/problem-routes.json
knowledge/manifest.json
knowledge/chapters/00-overview.md
knowledge/chapters/01-metacognition.md
knowledge/chapters/02-formal-logic-language.md
knowledge/chapters/03-problem-framing.md
knowledge/chapters/04-structured-root-cause.md
knowledge/chapters/05-systems-networks-complexity.md
knowledge/chapters/06-decisions-risk-biases.md
knowledge/chapters/07-action-habits-execution.md
knowledge/chapters/08-learning-knowledge-growth.md
knowledge/chapters/09-time-focus-energy.md
knowledge/chapters/10-emotions-stress-rumination.md
knowledge/chapters/11-communication-expression-relationships.md
knowledge/chapters/12-neuroscience-body-health.md
knowledge/models/mdl-problem-reframing.md
```

模型文件集合由语义复核结果动态确定。每个实际文件必须使用已经登记的完整 ASCII ID；首个合同样例使用 `knowledge/models/mdl-problem-reframing.md`，其余文件由批准后的 `model_id` 一一生成。

私有工作文件：

```text
.local/analysis/source-summaries.jsonl
.local/state/curation-source-ids.jsonl
.local/dedup/model-contributions.jsonl
.local/ocr/assets.jsonl
.local/ocr/results.jsonl
.local/verification/records.jsonl
.local/reviews/queue.jsonl
.local/reviews/pilot-28.json
.local/reviews/batch-plan.json
.local/reviews/batches/B01.json
.local/reviews/batches/B02.json
.local/reviews/batches/B03a.json
.local/reviews/batches/B03b.json
.local/reviews/batches/B04.json
.local/reviews/batches/B05.json
.local/reviews/batches/B06a.json
.local/reviews/batches/B06b.json
.local/reviews/batches/B07.json
.local/reviews/batches/B08a.json
.local/reviews/batches/B08b.json
.local/reviews/batches/B09.json
.local/reviews/batches/B10a.json
.local/reviews/batches/B10b.json
.local/reviews/batches/B11.json
.local/reviews/batches/B12.json
```

工具与测试：

```text
tools/validate-knowledge.mjs
tools/curation-report.mjs
tools/prepare-incremental-review.mjs
tools/build-curation-source-map.mjs
tools/build-curation-batch-plan.mjs
tools/apply-curation-batch.mjs
tools/register-ocr-assets.mjs
tools/fetch-body-images.mjs
tools/lib/contracts.mjs
tools/lib/evidence.mjs
tools/lib/jsonl.mjs
tools/lib/model-markdown.mjs
tools/lib/route-matcher.mjs
tools/lib/knowledge-manifest.mjs
tests/contracts.test.mjs
tests/evidence.test.mjs
tests/model-markdown.test.mjs
tests/dedup.test.mjs
tests/taxonomy.test.mjs
tests/problem-routes.test.mjs
tests/curation-coverage.test.mjs
tests/medical-safety.test.mjs
tests/incremental-curation.test.mjs
tests/ocr-evidence.test.mjs
tests/batch-apply.test.mjs
tests/fixtures/curation/source-summary-valid.json
tests/fixtures/curation/source-summary-invalid-evidence.json
tests/fixtures/curation/model-valid.md
tests/fixtures/curation/model-missing-card.md
tests/fixtures/curation/problem-routes-valid.json
tests/fixtures/curation/problem-routes-invalid.json
```

## Data Contracts

### `knowledge/taxonomy.json`

```js
{
  schema_version: "1.0.0",
  chapters: Array<{
    id: "00" | "01" | "02" | "03" | "04" | "05" | "06" |
        "07" | "08" | "09" | "10" | "11" | "12",
    order: number,
    slug: string,
    title: string,
    description: string,
    baseline_source_count: number,
    subchapters: Array<{
      id: string,
      order: number,
      slug: string,
      title: string
    }>,
    allowed_tags: string[]
  }>,
  content_types: [
    "canonical",
    "card",
    "case",
    "comparison",
    "series",
    "related"
  ],
  risk_flags: [
    "needs_ocr",
    "needs_medical_review",
    "needs_logic_review",
    "evidence_limited"
  ]
}
```

固定初始计数：

```text
00=10, 01=15, 02=16, 03=41, 04=38, 05=28, 06=49,
07=32, 08=43, 09=29, 10=65, 11=22, 12=30
```

### Source Identity Boundary

语义层的 `source_id` 是首次登记后永久保存的 opaque ID，不得由 URL、标题、路径、raw hash 或 cleaned hash 推导。这样未来默认 `local_only` 的私人来源不会通过 ID 暴露其 URL 指纹。

`.local/state/curation-source-ids.jsonl` 只在私有层保存：

```js
{
  schema_version: "1.0.0",
  catalog_source_id: string,
  source_id: "src_" + thirtyTwoLowerHex,
  created_by: "crypto_random",
  created_at: string
}
```

`build-curation-source-map` 对尚未映射的 catalog 记录使用 `crypto.randomBytes(16)` 生成 ID，使用 `O_EXCL` 锁和临时文件加 rename 一次写入；重跑必须复用已保存映射。该工具不得接受手填 ID，也不得把 canonical URL 或其 hash 写入映射。`catalog_source_id` 只用于连接 Phase A 的本地文件，不能进入摘要证据、公共文件、模型或 route。确定性重复检测继续使用私有 catalog 的 URL/raw/clean 指纹，与 opaque `source_id` 分离。

### `.local/analysis/source-summaries.jsonl`

```js
{
  schema_version: "1.0.0",
  source_id: string,
  cleaned_sha256: string,
  summary_status: "new" | "draft" | "needs_review" |
                  "blocked_ocr" | "approved" | "rejected",
  evidence_mode: "none" | "cleaned_text" | "approved_ocr" |
                 "mixed" | "independent_verification",
  core_question: EvidenceClaim | null,
  core_conclusion: EvidenceClaim | null,
  key_concepts: Array<{
    term: string,
    definition: EvidenceClaim
  }>,
  mechanisms: EvidenceClaim[],
  methods: Array<{
    name: EvidenceClaim,
    steps: Array<{ order: number, claim: EvidenceClaim }>,
    use_cases: EvidenceClaim[],
    stop_conditions: EvidenceClaim[]
  }>,
  use_cases: EvidenceClaim[],
  limitations: EvidenceClaim[],
  unique_contributions: EvidenceClaim[],
  candidate_model_ids: string[],
}
```

```js
EvidenceClaim = {
  claim_id: string,
  text: string,
  claim_status: "source_claim" | "cross_source_consensus" |
                "independently_verified" | "conflicted",
  evidence_refs: Array<{
    kind: "cleaned_lines" | "ocr_blocks" | "verification_record",
    source_id: string,
    artifact_sha256?: string,
    start_line?: number,
    end_line?: number,
    asset_id?: string,
    block_ids?: string[],
    verification_id?: string
  }>
}
```

每个非空 `EvidenceClaim.text` 至少有一个合法证据引用。`claim_id` 以 `(source_id, claim_id)` 为稳定复合键，在来源摘要内唯一且冻结。`cleaned_lines` 必须带对应来源当前 `cleaned_sha256`、合法行号和相同 artifact hash；`ocr_blocks` 必须引用该来源已批准的 OCR blocks；`verification_record` 必须解析到相同 `(source_id, claim_id)` 的批准记录。`cross_source_consensus` 至少引用两个不同 opaque source ID，且每个引用都能解析到各自 artifact；`independently_verified` 至少引用一个批准的 verification record。标题、文件名、发布日期、URL 和相邻文章永远不是正文证据。

### `.local/verification/records.jsonl`

```js
{
  schema_version: "1.0.0",
  verification_id: string,
  claim_id: string,
  source_id: string,
  url: string,
  publisher: string,
  title: string,
  accessed_at: string,
  retrieved_artifact_sha256: string,
  evidence_locator: string,
  evidence_excerpt: string,
  verification_result: "supports" | "contradicts" | "mixed" | "insufficient",
  evidence_note: string,
  review_status: "draft" | "approved" | "rejected"
}
```

`accessed_at` 使用 RFC 3339；verification artifact、locator 和不超过 500 字的必要 excerpt 仅保存在私有层。批准记录必须能由 `retrieved_artifact_sha256 + evidence_locator` 重放定位，且其 `(source_id, claim_id)` 与 claim 引用一致。首版不要求无边界事实核验；没有批准记录时只能使用 `source_claim`、`cross_source_consensus` 或 `conflicted`，不能标记 `independently_verified`。

### `knowledge/sources.json`

```js
{
  schema_version: "1.0.0",
  corpus_version: string,
  sources: Array<{
    source_id: string,
    title: string,
    author: string | null,
    published_at: string | null,
    date_precision: "datetime" | "date" | "month" | "year" | "unknown",
    source_url: string | null,
    source_fingerprint: string | null,
    provenance_visibility: "public_metadata" | "public_synthesis_redacted",
    primary_chapter_id: string | null,
    tags: string[],
    primary_content_type: "canonical" | "card" | "case" |
                          "comparison" | "series" | "related" | null,
    model_roles: Array<{
      model_id: string,
      content_role: "canonical" | "card" | "case" |
                    "comparison" | "series" | "related"
    }>,
    related_sources: Array<{
      source_id: string,
      relation: "duplicate_of" | "short_version_of" | "card_for" |
                "case_for" | "comparison_of" | "series_part_of" |
                "related_to"
    }>,
    processing_status: "new" | "cleaned" | "ready" | "needs_review" |
                       "needs_ocr" | "needs_medical_review" |
                       "fetch_failed" | "duplicate" | "superseded",
    ocr_status: "not_required" | "queued" | "needs_visual_review" |
                "approved" | "rejected" | "fetch_failed",
    medical_review_status: "not_triaged" | "not_applicable" |
                           "needs_expert" | "approved" | "rejected",
    logic_review_status: "not_triaged" | "not_applicable" |
                         "needs_expert" | "approved" | "rejected",
    risk_flags: string[],
    evidence_boundary: string
  }>
}
```

公共来源条目不得包含本地文件名、路径、正文、OCR、图片 URL、reviewer 身份或私人备注。
`public_synthesis_redacted` 条目使用去标识化标题，且 `author`、`published_at`、`source_url`、`source_fingerprint` 必须为 null。`local_only` 来源不得进入公共来源索引或公开模型内容；当前 418 篇基线全部是 `public_metadata`。
`published_at` 非 null 时必须是 RFC 3339；仅能恢复部分日期时使用规范化最小日期配合 `date_precision`，网页按精度显示，不能伪装成精确时间。

`processing_status` 是单一发布阻塞状态，优先级固定为：`fetch_failed` → `needs_ocr` → `needs_medical_review` → `needs_review` → `cleaned` → `ready`；`duplicate` 与 `superseded` 是策展终态。OCR、医学和逻辑三个状态是正交字段，可以同时表达多个风险。任一专家状态为 `needs_expert` 或 `rejected` 时不得 `ready`；`medical_review_status=needs_expert` 映射为 `needs_medical_review`，`logic_review_status=needs_expert` 映射为 `needs_review` 并带 `needs_logic_review`。只有摘要已批准、OCR 为 `not_required|approved`、医学和逻辑均为 `not_applicable|approved`、至少关联一个合法模型且公开 evidence boundary 完整时才可 `ready`。

### `.local/dedup/model-contributions.jsonl`

```js
{
  schema_version: "1.0.0",
  source_id: string,
  model_id: string,
  content_role: "canonical" | "card" | "case" |
                "comparison" | "series" | "related",
  merge_action: "keep_separate" | "merge_unique" |
                "visual_companion" | "supersede_curated" |
                "pending_ocr" | "pending_review",
  unique_contribution_claim_ids: string[],
  related_source_ids: string[],
  review_status: "draft" | "approved" | "needs_review",
  review_note: string
}
```

不存在 `delete` 动作；原始来源始终保留。

### `.local/reviews/queue.jsonl`

```js
{
  schema_version: "1.0.0",
  review_id: string,
  source_id: string,
  review_type: "ocr_visual" | "medical" | "logic" |
               "dedup" | "classification" | "publication",
  status: "open" | "in_review" | "approved" | "rejected",
  reason: string,
  required_qualification: string,
  reviewer_record: {
    reviewer_label: string,
    qualification_note: string,
    reviewed_at: string,
    decision_note: string
  } | null
}
```

Codex 可以创建分诊和复核任务，但不能自行把 `medical` 或需要专家的 `logic` 任务改为批准。只有用户指定且在私有记录中说明资质的 reviewer 可以做出 `approved` 或 `rejected` 决定；未指定 reviewer 时保持 `needs_expert`。本系统不使用“附带条件批准”状态；边界或停止条件不完整就不能批准。

### Model Markdown Contract

每个模型文件必须满足：

```md
# 问题重构

<!-- model-meta: {"schema_version":"1.0.0","model_id":"mdl-problem-reframing","model_type":"framework","primary_chapter_id":"03","aliases":["问题重新定义"],"tags":["问题定义"],"review_status":"ready","risk_flags":[],"source_ids":["src_0123456789abcdef0123456789abcdef"]} -->

<!-- card-meta: {"schema_version":"1.0.0","card_id":"card-mdl-problem-reframing","required_inputs":["situation","goal","facts","assumptions","constraints","attempted","desired_output"],"primary_model_id":"mdl-problem-reframing","auxiliary_model_ids":["mdl-five-whys"],"expected_sections":["问题重述","模型匹配","综合分析","行动步骤","验证指标"],"validation_questions":["什么证据会推翻当前的问题定义？"],"stop_conditions":["涉及紧急健康或人身安全风险时停止并升级专业支持"]} -->

## 核心定义
## 底层机制
## 适用问题与识别信号
## 不适用场景
## 操作步骤
## 示例
## 常见误用
## 验证方式
## 前置模型
## 推荐组合
## 替代模型
## 停止条件
## 来源与证据边界
## 与 Codex 共学应用卡

### 何时使用
### 用户需要提供的背景
### 快速诊断提问模板
### 深度分析提问模板
### 行动方案提问模板
### 推荐模型组合
### 期望输出结构
### 追问、验证与修正
### 停止条件与专业升级
### 完整协作示例
```

`model_type` 只允许：

```text
principle
framework
method
diagnostic
decision_rule
practice
explainer
```

`model-meta` 必需字段固定为 `schema_version`、`model_id`、`model_type`、`primary_chapter_id`、`aliases`、`tags`、`review_status`、`risk_flags` 和 `source_ids`；`review_status` 只允许 `draft|needs_review|ready|retired`，不允许未声明字段。

`card-meta` 必需字段固定为 `schema_version`、`card_id`、`required_inputs`、`primary_model_id`、`auxiliary_model_ids`、`expected_sections`、`validation_questions` 和 `stop_conditions`。`primary_model_id` 必须等于本文件 `model_id`，辅助模型最多两个且全部存在。

固定章节标题必须按上述顺序各出现一次。正文不得为空，完整协作示例必须去标识化。

### `knowledge/problem-routes.json`

```js
{
  schema_version: "1.0.0",
  matching_disclaimer: "本地关键词导航，不是 AI 诊断或专业建议。",
  max_auxiliary_models: 2,
  safety_rules: Array<{
    safety_rule_id: string,
    priority: number,
    trigger_terms: string[],
    risk_type: "medical" | "mental_health" | "legal" | "financial" |
               "personal_safety",
    user_message: string,
    prohibited_outputs: string[],
    test_cases: Array<{
      case_id: string,
      input: ProblemInput,
      expected: "safety_stop"
    }>
  }>,
  model_tombstones: Array<{
    retired_model_id: string,
    successor_model_id: string | null,
    reason: string
  }>,
  model_relations: Array<{
    from_model_id: string,
    to_model_id: string,
    type: "prerequisite" | "complements" | "alternative" |
          "confused_with" | "applied_before" | "stop_and_escalate",
    reason: string
  }>,
  routes: Array<{
    route_id: string,
    priority: number,
    title: string,
    trigger_terms: Array<{ term: string, weight: number }>,
    exclude_terms: string[],
    minimum_score: number,
    required_context_fields: Array<
      "situation" | "goal" | "facts" | "assumptions" |
      "constraints" | "attempted" | "desired_output"
    >,
    primary_model_id: string,
    auxiliary_model_ids: string[],
    clarifying_questions: string[],
    stop_conditions: string[],
    safety_gate: "general" | "medical" | "mental_health" | "legal" | "financial",
    output_sections: [
      "问题重述",
      "模型匹配",
      "综合分析",
      "行动步骤",
      "验证指标"
    ],
    test_cases: Array<{
      case_id: string,
      input: ProblemInput,
      expected: "match" | "no_match" | "safety_stop"
    }>
  }>
}
```

模型关系的唯一机器可读来源是 `problem-routes.json.model_relations`；`model-meta` 不重复存 relations。模型 Markdown 的“前置、组合、替代”章节必须与该数组一致，validator 据此检查悬空或冲突关系。

所有 route、card 和站点提示词输入统一使用 snake_case：

```js
ProblemInput = {
  situation: string,
  goal: string,
  facts: string,
  assumptions: string,
  constraints: string,
  attempted: string,
  desired_output: string
}

matchProblem(input: ProblemInput, config): {
  matched: boolean,
  outcome: "match" | "no_match" | "safety_stop",
  route_id: string | null,
  primary_model_id: string | null,
  auxiliary_model_ids: string[],
  clarifying_question: string | null,
  reason: string
}
```

所有字段只接受上述 snake_case 名称，不提供 camelCase 别名。`safety_rules` 是全局且先于普通 routes 执行；站点构建器必须直接 import `tools/lib/route-matcher.mjs`，不得复制算法。

## Batch and Data-flow Contracts

`.local/reviews/batch-plan.json`：

```js
{
  schema_version: "1.0.0",
  corpus_version: string,
  baseline_source_count: 418,
  current_source_count: number,
  pilot_source_ids: string[],
  assignments: Array<{
    source_id: string,
    batch_id: "B01" | "B02" | "B03a" | "B03b" | "B04" | "B05" |
              "B06a" | "B06b" | "B07" | "B08a" | "B08b" | "B09" |
              "B10a" | "B10b" | "B11" | "B12",
    assignment_reason: string,
    model_family_hint: string | null
  }>,
  revisions: Array<{
    source_id: string,
    from_batch_id: string,
    to_batch_id: string,
    reason: string
  }>
}
```

首版 assignments 并集必须等于冻结基线的 418 个 source ID，交集为空，`current_source_count` 从输入 catalog 计算且等于 assignments 长度；任何测试不得把当前数量另写成常量。先根据已知同名/长短版候选和章节生成并人工冻结；复核发现新模型族时只通过 revision 记录移动整个族，不静默改变归属。未来新增来源走增量复核文件，不改写首版 16 批的历史归属。

每个 `.local/reviews/batches/B01.json` 等文件使用同一 `BatchReview`：

```js
{
  schema_version: "1.0.0",
  batch_id: "PILOT-28" | "B01" | "B02" | "B03a" | "B03b" |
            "B04" | "B05" | "B06a" | "B06b" | "B07" |
            "B08a" | "B08b" | "B09" | "B10a" | "B10b" |
            "B11" | "B12",
  source_ids: string[],
  base_sha256: {
    summaries: string,
    contributions: string,
    public_sources: string,
    problem_routes: string,
    review_queue: string,
    verification_records: string
  },
  source_updates: SourceSummary[],
  contribution_updates: ModelContribution[],
  verification_updates: VerificationRecord[],
  model_drafts: Array<{
    model_id: string,
    expected_old_sha256: string | null,
    markdown: string
  }>,
  source_public_updates: PublicSource[],
  route_candidates: {
    routes: Route[],
    model_relations: ModelRelation[],
    safety_rules: SafetyRule[],
    model_tombstones: ModelTombstone[]
  },
  review_queue_updates: ReviewQueueItem[],
  review_decisions: Array<{
    decision_id: string,
    type: "summary" | "dedup" | "classification" |
          "model" | "route" | "risk",
    target_id: string,
    decision: string,
    reason: string
  }>
}
```

`SourceSummary`、`ModelContribution`、`VerificationRecord`、`PublicSource`、`Route`、`ModelRelation`、`SafetyRule`、`ModelTombstone` 和 `ReviewQueueItem` 分别引用本节已经声明的 allowlist schema，不是任意 object。生产 batch 的 `source_updates` 必须与该 batch frozen assignments 一一对应；pilot 必须与 `pilot_source_ids` 一一对应。`verification_updates` 中每条记录必须被本 batch claim 引用或明确标为复核证据，不能追加孤儿记录。

`tools/apply-curation-batch.mjs` 必须显式且互斥地接收 `--dry-run` 或 `--apply`；不带模式、同时带两种模式或使用未冻结 batch plan 都失败。它先在事务目录生成全部 next bytes，验证旧 SHA、批次 source 集、重复 source/model ID、跨批覆盖、状态倒退、模型合同、证据闭环和 route 引用。`--dry-run` 永不写目标；`--apply` 获得单写者锁后再次验证 base SHA，再以 journal、原字节备份和逐文件 rename 更新摘要、贡献、verification records、公共来源、模型 Markdown、routes 与 review queue。写入异常必须恢复全部旧 bytes；发现未完成 journal 时，任何 validator/build 拒绝运行，恢复命令先完成 rollback。验证失败或冲突时所有目标 bytes 不变。

关键任务的数据流：

| Task | Consumes | Produces |
|---|---|---|
| 1–3 | 已确认设计、合成 fixtures | 合同、taxonomy、evidence validator |
| 4 | local catalog、cleaned files | opaque source map、动态 source skeleton、空贡献/验证/复核文件 |
| 5 | catalog 的图片清单 | OCR assets/results、图片复核状态 |
| 5A | Tasks 1–5 合同与证据 | parser、matcher、dedup/batch validators、frozen plan、事务 applier |
| 6 | 28 个 pilot source、批准证据、5A 工具 | pilot BatchReview、首批模型、卡与 routes |
| 7 | source summaries、候选关系 | model contributions、公共 source roles |
| 8.01–8.16 | frozen assignments、上一个 snapshot | 16 个独立 BatchReview 与逐批事务结果 |
| 9–12 | 已应用模型、来源、关系 | 单 parser 验证、完整卡、routes、安全门、13 章 |
| 13–14 | 全部知识和协议版本 | manifest、全量报告、增量复核队列 |

## Task 1: Contract Validators First

**Files:**

- Create: `tools/lib/contracts.mjs`
- Create: `tools/lib/jsonl.mjs`
- Create: `tests/contracts.test.mjs`
- Create: contract fixtures listed above

**Interfaces:**

- Consumes: 本计划全部字段 allowlist、ID pattern 和 RFC 3339 规则。
- Produces: `validateContract(kind, value)`、`readJsonl(path)`、`writeJsonlBytes(records)`；后续任务只通过这些入口读写合同数据。

- [ ] 写失败测试，拒绝未知字段、错误 schema version、无效 ID、重复 ID、未排序数组和缺少 EOF newline。
- [ ] 写失败测试，拒绝公共文件中的绝对路径、正文键、OCR 键、图片 URL 和 reviewer 键。
- [ ] 实现显式字段 allowlist 验证器，不引入 schema 依赖。
- [ ] 运行：

```sh
rtk node --test tests/contracts.test.mjs
```

预期：命令退出码为 0，且 TAP 摘要 `fail 0`；不固定测试个数。

## Task 2: Freeze the 13-chapter Taxonomy

**Files:**

- Create: `knowledge/taxonomy.json`
- Create: `tests/taxonomy.test.mjs`

**Interfaces:**

- Consumes: 设计规格第 7 节已经确认的 13 章和基线计数。
- Produces: `taxonomy.json`；`getChapter(id)` 和公共合同验证器可据此验证章节、标签与内容类型。

- [ ] 写失败测试，要求章节 ID 恰为 `00` 到 `12`、order 恰为 0 到 12、slug 唯一、固定基线计数合计 418。
- [ ] 写失败测试，内容类型与风险标识只能使用合同允许值。
- [ ] 写入设计规格中已经确认的 13 章、二级目录、说明和允许标签。
- [ ] 运行：

```sh
rtk node --test tests/taxonomy.test.mjs
```

预期：

```text
chapter_count=13
baseline_source_count=418
```

## Task 3: Evidence Validation

**Files:**

- Create: `tools/lib/evidence.mjs`
- Create: `tests/evidence.test.mjs`

**Interfaces:**

- Consumes: opaque source map、cleaned artifact 索引、OCR records、verification records。
- Produces: `validateEvidenceClaim(claim, evidenceStore)` 与 `validateSourceSummary(summary, evidenceStore)`，供 batch dry-run、apply 和全量验证唯一复用。

- [ ] 写失败测试，验证非空 claim 没有 evidence ref、缺 source ID、清理行号越界、artifact hash 不匹配、OCR block 不存在、标题作为证据、单来源伪装跨源共识、无验证记录却标记独立核验都失败。
- [ ] 写通过测试，验证清理文本行引用、已批准 OCR block、两个来源支持的共识和批准 verification record。
- [ ] 实现：

```js
validateEvidenceClaim(claim, evidenceStore)
validateSourceSummary(summary, evidenceStore)
```

- [ ] 运行：

```sh
rtk node --test tests/evidence.test.mjs
```

预期：命令退出码为 0，且 TAP 摘要 `fail 0`；不固定测试个数。

## Task 4: Create Source Skeletons without Semantic Guessing

**Catalog discovery contract:** 任何语义任务先稳定读取并验证 `.local/state/current-cleaning.json`，再使用其中已验证的 `catalog_path` 读取 catalog。不得创建、读取或同步第二份可漂移 catalog。资料隐私、安全和来源证据仍服从 `2026-07-27-brain-model-knowledge-system-design.md`；网站呈现需求由 `2026-07-30-systematic-thinking-site-design.md` 约束。

**Files:**

- Create: `.local/state/curation-source-ids.jsonl`
- Create: `tools/build-curation-source-map.mjs`
- Create: `.local/analysis/source-summaries.jsonl`
- Create: `.local/dedup/model-contributions.jsonl`
- Create: `.local/verification/records.jsonl`
- Create: `.local/reviews/queue.jsonl`
- Create: `knowledge/sources.json`

**Interfaces:**

- Consumes: pointer 选中的已验证 catalog 的 catalog ID、publication policy、cleaned hash、content mode 和正文图片清单。
- Produces: 持久 opaque ID 映射、每个 catalog 来源一条私有摘要 skeleton，以及仅获准公开来源的公共 skeleton。

- [ ] 先写失败测试：相同 catalog 重跑复用 source ID；新记录得到随机 opaque ID；ID 不能等于或包含 URL/hash 前缀；`local_only` 不进入任何公共文件。
- [ ] 运行 `build-curation-source-map`，为 catalog 中每条记录冻结 opaque `source_id`；后续所有语义层文件只使用该 ID。
- [ ] 从 catalog 生成与当前 catalog 数量相等的私有摘要 skeleton；公共 skeleton 数量等于当期获准公开记录数，测试从输入计算两者，不硬编码当前数量。
- [ ] 初始私有摘要状态全部为 `new`；图片主导且未有批准 OCR 的记录为 `blocked_ocr`。
- [ ] 初始公共状态由清理管线映射为 `cleaned`、`needs_review` 或 `needs_ocr`，不得直接设为 `ready`。
- [ ] 尚未语义复核的 skeleton 使用 `primary_chapter_id=null`、`primary_content_type=null`、空 tags 和空 model roles；不得为了通过 schema 预填分类。
- [ ] contributions、verification records 和 review queue 以合法空 JSONL 文件开始；图片、医学、逻辑和发布风险随后追加具名 review 项。
- [ ] `public_metadata` 的 `source_fingerprint` 使用 canonical URL 的 SHA-256，不暴露原始正文 hash；它与随机 `source_id` 无关；redacted 来源为 null。
- [ ] 只为 `public_metadata` 和用户已批准的 `public_synthesis_redacted` 来源生成公共 skeleton；`local_only` 来源只存在于私有摘要和复核队列。
- [ ] 运行合同、唯一性和计数验证：

```sh
rtk node tools/validate-knowledge.mjs --scope sources
```

预期：私有条目数等于 catalog 条目数，公共条目数等于获准公开条目数，opaque source ID 全局唯一，`ready_sources=0`。首版基线另行验证 catalog 与公开来源均为 418，未来运行不得把 418 当作当前数量常量。

## Task 5: OCR and Visual Evidence Contract

**Files:**

- Read: `.local/reviews/image-dominant-baseline.json`
- Create: `.local/ocr/assets.jsonl`
- Create: `.local/ocr/results.jsonl`
- Create: `tools/register-ocr-assets.mjs`
- Create: `tools/fetch-body-images.mjs`
- Create: `tests/ocr-evidence.test.mjs`

**Interfaces:**

- Consumes: Phase A 冻结的 25-source image-dominant named set、pointer 选中的已验证 catalog ordered body-image tuples 与 Task 4 opaque source map。
- Produces: 可解析的 OCR asset/result records，以及每个来源独立的 `ocr_status`；Task 6 之后的任何语义步骤只读批准 blocks。

- [ ] 为正文图片登记：

```js
{
  asset_id: string,
  source_id: string,
  ordinal: number,
  source_url: string,
  local_path: string | null,
  sha256: string | null,
  fetch_status: "queued" | "fetched" | "fetch_failed",
  mime_type: string | null,
  width: number | null,
  height: number | null
}
```

- [ ] OCR 或 Codex 视觉复核结果使用：

```js
{
  ocr_id: string,
  asset_id: string,
  method: "local_ocr" | "codex_visual_review",
  engine_name: string,
  engine_version: string,
  language: "zh-Hans",
  status: "queued" | "ocr_failed" | "needs_visual_review" |
          "approved" | "rejected",
  blocks: Array<{
    block_id: string,
    text: string,
    bbox: [number, number, number, number],
    confidence: number | null
  }>,
  visual_review_status: "pending" | "approved" | "rejected",
  review_note: string
}
```

- [ ] 用户未批准具体 OCR 方法前，只实现合同、图片登记、下载安全和 `needs_ocr` 状态，不安装依赖。
- [ ] `register-ocr-assets` 从 pointer 选中的已验证 catalog 的 ordered body-image tuples 登记全部 237 个资产；queued 时本地字段为 null。
- [ ] `fetch-body-images` 复用 URL intake 的 scheme、redirect、DNS pin、超时、大小和 MIME 安全规则，写内容寻址文件并原子更新 asset；不覆盖不同 hash 的旧文件。
- [ ] `status=approved` 当且仅当 `visual_review_status=approved`；本地 OCR 置信度不能绕过视觉复核。
- [ ] 来源级 `ocr_status` 按全部必要正文图片聚合：无必要图片为 `not_required`；全部已视觉批准才为 `approved`；任一 queued/待复核/拒绝/下载失败分别映射为 `queued|needs_visual_review|rejected|fetch_failed`。除 `not_required|approved` 外都强制 `processing_status=needs_ocr`。
- [ ] `content_mode=image_dominant` 且视觉复核未批准时，强制：

```text
summary_status=blocked_ocr
evidence_mode=none
core_question=null
core_conclusion=null
key_concepts=[]
mechanisms=[]
methods=[]
use_cases=[]
limitations=[]
unique_contributions=[]
candidate_model_ids=[]
```

- [ ] 上述 `blocked_ocr` 记录除 `schema_version`、`source_id`、`cleaned_sha256`、`summary_status`、`evidence_mode` 外，所有语义字段必须严格等于上表的 null/空数组；不得保存 review note、候选模型、标题推断或占位 claim，原因写入私有 review queue。
- [ ] 公式、表格、流程图没有自动批准路径，必须逐图复核。
- [ ] 图片下载失败设置 `ocr_status=fetch_failed` 和 `processing_status=needs_ocr`；文章页面抓取失败才使用来源级 `processing_status=fetch_failed`。
- [ ] 读取并验证 `.local/reviews/image-dominant-baseline.json` 恰有 25 个唯一 source ID、全部存在于 catalog 且 `content_mode=image_dominant`；逐项得到 OCR `approved`、`needs_visual_review`、`rejected` 或 `fetch_failed` 并映射到来源状态。不得用正文字符阈值重算或扩充这份首版名单；集合外候选仍走 `needs_review`。
- [ ] 运行：

```sh
rtk node --test tests/ocr-evidence.test.mjs
rtk node tools/register-ocr-assets.mjs --current-pointer .local/state/current-cleaning.json --output .local/ocr/assets.jsonl
```

## Task 5A: Pre-Pilot Model, Route, Dedup and Batch Infrastructure

本任务是试点的强制前置，不得跳过。它只建立解析、验证和事务工具，不生成任何来源结论。

**Files:**

- Create: `tools/lib/model-markdown.mjs`
- Create: `tools/lib/route-matcher.mjs`
- Create: `tools/build-curation-batch-plan.mjs`
- Create: `tools/apply-curation-batch.mjs`
- Create: `tests/model-markdown.test.mjs`
- Create: `tests/problem-routes.test.mjs`
- Create: `tests/medical-safety.test.mjs`
- Create: `tests/dedup.test.mjs`
- Create: `tests/batch-apply.test.mjs`
- Create: `.local/reviews/batch-plan.json`
- Create: `knowledge/problem-routes.json`

**Interfaces:**

- Consumes: Tasks 1–5 的 contracts、taxonomy、evidence store、opaque source IDs 和 OCR 状态。
- Produces: 唯一 `parseModelMarkdown()`、`validateModelDocument()`、`matchProblem()`、冻结 batch plan，以及只接受显式 `--dry-run|--apply` 的事务式 batch applier。

- [ ] 先写 model parser 失败测试：缺/乱序/重复/空 H2、缺任一 meta、无 source ID、悬空关系、缺 Codex H3、meta 注释残留在 renderable Markdown、真实个人信息示例均失败。
- [ ] 实现并导出：

```js
parseModelMarkdown(markdown, sourcePath)
validateModelDocument(modelDocument, knowledgeSnapshot)
```

固定返回：

```js
{
  title: string,
  meta: object,
  card_meta: object,
  sections: Record<string, string>,
  card_sections: Record<string, string>,
  renderable_markdown: string
}
```

- [ ] parser 只读取 H1、紧随 H1 的唯一 `model-meta`/`card-meta` JSON 和固定 H2/H3；`renderable_markdown` 删除两条 meta 注释后才交给 `markdown-it`。验证器、batch applier 和站点必须 import 此模块，禁止第二套 regex/parser。
- [ ] 写 route 失败测试覆盖全局 safety-first、exclude、阈值、跨主模型并列、同主模型稳定选择、snake_case 输入、最多两个辅助模型、悬空/retired 模型。
- [ ] 实现 `matchProblem(input, config)`：对全部 top `(score, priority)` 候选取 distinct `primary_model_id`；多于一个时返回 `matched:false`，只有一个时才按 `route_id` 升序选择。不得先用 `route_id` 消除跨主模型歧义。
- [ ] 写 medical/logic gate 测试；Codex 只可分诊，未有用户指定合格 reviewer 的记录时保持 `needs_expert`，任何合同外批准状态都必须失败。
- [ ] 写 dedup 失败测试：确定性重复不创建第二个语义 source、相同标题不同正文只入队、ready 模型恰有一个 canonical、self/dangling relation 和缺失双向 `related_to` 均失败。
- [ ] 生成并人工冻结 `batch-plan.json`；测试读取 catalog 计算 current count，验证 assignments 并集等于冻结首版 source 集、两两交集为空、28 个 pilot ID 是其子集，不能把当前数量写死在实现中。
- [ ] 写 batch apply 失败测试：缺模式、双模式、base SHA 漂移、跨批 source、重复 source/model、状态倒退、证据断链、悬空 route、模型合同失败及写入异常时，目标 bytes 全部不变或完整 rollback。
- [ ] 实现两阶段事务，并由测试在临时 root 中分别调用 CLI 的 `--dry-run` 与 `--apply` 路径：

```sh
rtk node --test tests/batch-apply.test.mjs
```

测试中的 dry-run 不得写目标；apply case 只在完整 staging、二次 SHA 检查和锁成功后写入临时 fixture。测试不能改真实知识文件。
- [ ] 运行：

```sh
rtk node --test tests/model-markdown.test.mjs tests/problem-routes.test.mjs tests/medical-safety.test.mjs tests/dedup.test.mjs tests/batch-apply.test.mjs
```

预期：退出码为 0，且 TAP 摘要 `fail 0`；不固定测试个数。

## Task 6: Fixed 28-source Pilot

**Files:**

- Create: `.local/reviews/pilot-28.json`
- Update: `.local/analysis/source-summaries.jsonl`
- Update: `.local/dedup/model-contributions.jsonl`
- Create: first approved model files in `knowledge/models/`

**Interfaces:**

- Consumes: Tasks 1–5A 的批准 evidence、正交风险状态、唯一 model/card parser、route matcher、frozen batch plan 和 batch applier。
- Produces: `batch_id=PILOT-28` 的完整 `BatchReview`、首批已应用摘要/贡献/模型/card/routes，以及 Gate 2 人工样例。

- [ ] 固定以下 28 份来源作为模板试点；首次按 catalog 元数据定位后立即通过私有 source map 解析为 opaque `source_id`，冻结在 `pilot_source_ids`，后续不依赖路径或 URL：

```text
结构化思维_从混乱到清晰_解锁高效思考密码.md
结构化思维_从混乱到清晰解锁高效思考密码.md
问题重构法_破局解困_升维认知的难题破解框架.md
问题重构法破局解困升维认知的难题破解框架.md
第二序改变_跳出困局_认知跃迁的底层破局框架.md
第二序改变跳出困局认知跃迁的底层破局框架.md
框架思维不是万能药_正视局限_方显认知高度.md
框架思维不是万能药_正视局限方显认知高度.md
OODA循环_不确定环境下的快速决策与行动法则.md
OODA循环不确定环境下的快速决策与行动法则.md
思维工具箱_16个被反复验证的底层认知模型.md
认知解离.md
_汉语语言学_.md
逻辑四维合一_读懂概念_判断_推理_论证_重塑你的底层思维.md
形式逻辑_概念篇_超精细完整版（逐级细化_零漏洞_通俗落地可直接使用）.md
形式逻辑等价关系篇_一张图秒杀_为什么_如果P则Q___非P或Q__.md
鱼骨图分析速查卡.md
系统思维_看清关联_高效破局的底层认知框架.md
决策心理学20个核心概念_从底层逻辑到决策优化.md
WOOP思维_直面阻碍_知行合一的科学行动框架.md
经验学习四步法_从经历中提炼能力（附复盘问题清单）.md
睡眠管理四支柱速查卡.md
内耗能量路径图.md
压力是什么.md
金字塔原理_理清逻辑_高效表达的底层思维框架.md
万能表达框架.md
交感神经是怎么被激活的.md
神经系统中交感神经被激活后该如何关闭.md
```

- [ ] 对证据已就绪的来源完成七项摘要：核心问题、结论、概念、机制、方法、边界、独有贡献。图片主导且 OCR 未批准的来源只保留 `blocked_ocr` 空摘要，不为凑齐试点补写。
- [ ] 每条 `blocked_ocr` 都满足 `evidence_mode=none` 和 Task 5 的全空语义字段合同；其余字段不得出现标题推断。
- [ ] 每个 claim 加证据引用；只有存在批准 verification record 时才可使用 `independently_verified`。
- [ ] 对 5 组同名资料做 canonical/card/related 决策，不自动覆盖。
- [ ] 试点至少形成问题重构、结构化思维、第二序改变、OODA、系统思维、WOOP、经验学习、金字塔原理等真实模型文件。
- [ ] 把试点写成完整 `BatchReview`，依次运行：

```sh
rtk node tools/validate-knowledge.mjs --batch PILOT-28
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/pilot-28.json --dry-run
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/pilot-28.json --apply
rtk node tools/validate-knowledge.mjs --all
```

只有 dry-run 与人工复核都通过才执行明确的 `--apply`；验证失败不得产生部分写入。
- [ ] 向用户展示一个完整来源摘要、一个模型、一个结构化 card-meta 加自然语言 Codex 共学卡、一个 blocked OCR 示例和一个冲突或证据边界示例，执行总计划 Gate 2。

## Task 7: Three-layer Deduplication Review

**Files:**

- Update: `tests/dedup.test.mjs`
- Update: `.local/dedup/model-contributions.jsonl`
- Update: `knowledge/sources.json`

**Interfaces:**

- Consumes: Phase A 确定性 fingerprints、Task 5A dedup validator、试点决定和冻结候选队列。
- Produces: 每个来源—模型作用的 `ModelContribution`、完整关系方向和所有候选的决定或明确 `needs_review`。

- [ ] 写失败测试：同 canonical URL、同 raw hash、同 clean hash 的重复导入不能新建第二个 `source_id`。
- [ ] 写失败测试：标题相同但正文 hash 不同只能进入复核。
- [ ] 写失败测试：每个 ready 模型必须恰有一个 canonical 来源；非 canonical 来源必须有 merge action。
- [ ] 写失败测试：self relation、悬空 relation、不成对的对称 relation 均失败。
- [ ] `related_to` 是唯一要求双向成对的来源关系；`duplicate_of`、`short_version_of`、`card_for`、`case_for`、`comparison_of`、`series_part_of` 均为定向关系。
- [ ] 为基线已知 5 组规范化同名和候选生成器当期识别的长短版集合生成冻结复核队列；约 61 对只作为审计基线，不在测试中硬编码候选数。
- [ ] 按 canonical、card、case、comparison、series、related 做语义判断。
- [ ] 同一来源对不同模型的角色写入 `model_roles`，`primary_content_type` 只表示该来源在知识库中的主要用途。
- [ ] 对五步/五层/六层/七种/十种问题重构、八种/十种知识整合、内耗系列、机制/行动型神经科学内容建立边界，不强行融合。
- [ ] 运行：

```sh
rtk node --test tests/dedup.test.mjs
```

预期：基线 5 组同名资料全部有决定；冻结候选集合的每一对都有决定或 `needs_review`；`automatic_semantic_merges=0`。报告显示实际候选数，不固定为某个测试常量。

## Task 8: Full 418-source Semantic Batches

**Files:**

- Update: `.local/reviews/batch-plan.json`
- Update: `.local/analysis/source-summaries.jsonl`
- Update: `.local/dedup/model-contributions.jsonl`
- Update: `knowledge/sources.json`
- Create or update: `knowledge/models/` files named by approved model IDs
- Update: `knowledge/problem-routes.json`
- Create: `.local/reviews/batches/B01.json` through `.local/reviews/batches/B12.json` using the 16 fixed batch IDs
- Update: `tools/build-curation-batch-plan.mjs`
- Update: `tools/apply-curation-batch.mjs`
- Update: `tests/batch-apply.test.mjs`

**Interfaces:**

- Consumes: 用户通过 Gate 2 的模板、冻结 assignments、批准 evidence/专业复核和上一个已应用 snapshot。
- Produces: 16 个相互隔离的 `BatchReview`，每个经 dry-run、人工抽查和显式 `--apply` 后推进一个完整 snapshot。

- [ ] 按以下固定批次推进；跨章节模型族全部归入 canonical 主章节所在批次：

```text
B01   chapters 00+01, baseline 25 sources
B02   chapter 02, baseline 16 sources
B03a  first stable half of chapter 03, initial target 21
B03b  second stable half of chapter 03, initial target 20
B04   chapter 04, baseline 38 sources
B05   chapter 05, baseline 28 sources
B06a  first stable half of chapter 06, initial target 25
B06b  second stable half of chapter 06, initial target 24
B07   chapter 07, baseline 32 sources
B08a  first stable half of chapter 08, initial target 22
B08b  second stable half of chapter 08, initial target 21
B09   chapter 09, baseline 29 sources
B10a  first stable half of chapter 10, initial target 33
B10b  second stable half of chapter 10, initial target 32
B11   chapter 11, baseline 22 sources
B12   chapter 12, baseline 30 sources
```

初始稳定分半规则：按 opaque `source_id` 升序，奇数条进入 `a`，偶数条进入 `b`。上述数量只是首版 418 基线的生成目标；真正验收读取冻结 assignments，不在测试实现中重复硬编码。先结合已知同名/长短版候选和标题族群生成 `batch-plan.json`，人工冻结 418 个唯一归属；复核后发现的新族群只通过 revision 移动整个族，不在 apply 时临时猜归属。

- [ ] 每个批次由一个明确 owner 只写自己的私有 batch 文件；主代理在批次通过验证后统一合并 JSONL 和公共知识文件，避免并发覆盖。
- [ ] 写 `batch-apply` 失败测试：base SHA 漂移、跨批 source、重复 source/model、状态倒退、悬空 route、模型合同失败时所有目标 bytes 不变。
- [ ] 每个生产批次都必须产出：全部 source summaries 或明确 blocked 状态、model contributions、公共 source 更新、新建或更新的模型 Markdown 及其 card-meta/应用卡、route candidates 和 review decisions。
- [ ] 试点 28 份在所属生产批次中复用现有批准记录并检查协议版本，不重复生成摘要。
- [ ] 每批完成后都必须按其独立子任务依次运行 validate、report、`--dry-run`、人工抽查、`--apply` 和 post-validate；不得用一次全局 apply 合并未分别批准的 batch。

```sh
rtk node tools/validate-knowledge.mjs --batch B01
rtk node tools/curation-report.mjs --batch B01
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B01.json --dry-run
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B01.json --apply
rtk node tools/validate-knowledge.mjs --all
```

上述 B01 命令只是共同合同的首个实例；下面 16 个子任务逐一列出各自路径和命令。

- [ ] 每批人工抽查至少：

```text
3 条核心结论的证据
2 个模型边界
1 个非合并决定
1 个 Codex 卡真实问题演练
全部高风险来源
```

- [ ] 批次不通过时保持 `needs_review`，不进入下一批相同模型族。
每个子任务内部按 batch plan 的 `source_id` 升序逐条完成“摘要 → 证据验证 → 贡献/去重 → 模型与卡 → route 候选”，完成一条即验证该条；批次全量 dry-run 和人工抽查通过后才执行 `--apply`。

### Task 8.01: Curate and Apply B01

**Files:** Create `.local/reviews/batches/B01.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B01 assignments, approved evidence and current snapshot hashes. Produces one complete B01 `BatchReview` and the next validated snapshot.

- [ ] 完成 B01 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B01
rtk node tools/curation-report.mjs --batch B01
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B01.json --dry-run
```

- [ ] 完成本节人工抽查合同后运行应用与回归：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B01.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.02: Curate and Apply B02

**Files:** Create `.local/reviews/batches/B02.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B02 assignments, approved evidence and B01-applied snapshot hashes. Produces one complete B02 `BatchReview` and the next validated snapshot.

- [ ] 完成 B02 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B02
rtk node tools/curation-report.mjs --batch B02
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B02.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B02.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.03: Curate and Apply B03a

**Files:** Create `.local/reviews/batches/B03a.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B03a assignments, approved evidence and B02-applied snapshot hashes. Produces one complete B03a `BatchReview` and the next validated snapshot.

- [ ] 完成 B03a 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B03a
rtk node tools/curation-report.mjs --batch B03a
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B03a.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B03a.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.04: Curate and Apply B03b

**Files:** Create `.local/reviews/batches/B03b.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B03b assignments, approved evidence and B03a-applied snapshot hashes. Produces one complete B03b `BatchReview` and the next validated snapshot.

- [ ] 完成 B03b 全部 assigned sources；同模型族未通过 B03a 时，本批相关项保持 `needs_review`。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B03b
rtk node tools/curation-report.mjs --batch B03b
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B03b.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B03b.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.05: Curate and Apply B04

**Files:** Create `.local/reviews/batches/B04.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B04 assignments, approved evidence and B03b-applied snapshot hashes. Produces one complete B04 `BatchReview` and the next validated snapshot.

- [ ] 完成 B04 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B04
rtk node tools/curation-report.mjs --batch B04
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B04.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B04.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.06: Curate and Apply B05

**Files:** Create `.local/reviews/batches/B05.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B05 assignments, approved evidence and B04-applied snapshot hashes. Produces one complete B05 `BatchReview` and the next validated snapshot.

- [ ] 完成 B05 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B05
rtk node tools/curation-report.mjs --batch B05
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B05.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B05.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.07: Curate and Apply B06a

**Files:** Create `.local/reviews/batches/B06a.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B06a assignments, approved evidence and B05-applied snapshot hashes. Produces one complete B06a `BatchReview` and the next validated snapshot.

- [ ] 完成 B06a 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B06a
rtk node tools/curation-report.mjs --batch B06a
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B06a.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B06a.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.08: Curate and Apply B06b

**Files:** Create `.local/reviews/batches/B06b.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B06b assignments, approved evidence and B06a-applied snapshot hashes. Produces one complete B06b `BatchReview` and the next validated snapshot.

- [ ] 完成 B06b 全部 assigned sources；同模型族未通过 B06a 时，本批相关项保持 `needs_review`。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B06b
rtk node tools/curation-report.mjs --batch B06b
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B06b.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B06b.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.09: Curate and Apply B07

**Files:** Create `.local/reviews/batches/B07.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B07 assignments, approved evidence and B06b-applied snapshot hashes. Produces one complete B07 `BatchReview` and the next validated snapshot.

- [ ] 完成 B07 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B07
rtk node tools/curation-report.mjs --batch B07
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B07.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B07.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.10: Curate and Apply B08a

**Files:** Create `.local/reviews/batches/B08a.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B08a assignments, approved evidence and B07-applied snapshot hashes. Produces one complete B08a `BatchReview` and the next validated snapshot.

- [ ] 完成 B08a 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B08a
rtk node tools/curation-report.mjs --batch B08a
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B08a.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B08a.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.11: Curate and Apply B08b

**Files:** Create `.local/reviews/batches/B08b.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B08b assignments, approved evidence and B08a-applied snapshot hashes. Produces one complete B08b `BatchReview` and the next validated snapshot.

- [ ] 完成 B08b 全部 assigned sources；同模型族未通过 B08a 时，本批相关项保持 `needs_review`。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B08b
rtk node tools/curation-report.mjs --batch B08b
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B08b.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B08b.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.12: Curate and Apply B09

**Files:** Create `.local/reviews/batches/B09.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B09 assignments, approved evidence and B08b-applied snapshot hashes. Produces one complete B09 `BatchReview` and the next validated snapshot.

- [ ] 完成 B09 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B09
rtk node tools/curation-report.mjs --batch B09
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B09.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B09.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.13: Curate and Apply B10a

**Files:** Create `.local/reviews/batches/B10a.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B10a assignments, approved evidence and B09-applied snapshot hashes. Produces one complete B10a `BatchReview` and the next validated snapshot.

- [ ] 完成 B10a 全部 assigned sources；全部高风险来源都要完成正交 gate 分诊。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B10a
rtk node tools/curation-report.mjs --batch B10a
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B10a.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B10a.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.14: Curate and Apply B10b

**Files:** Create `.local/reviews/batches/B10b.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B10b assignments, approved evidence and B10a-applied snapshot hashes. Produces one complete B10b `BatchReview` and the next validated snapshot.

- [ ] 完成 B10b 全部 assigned sources；同模型族未通过 B10a 时，本批相关项保持 `needs_review`。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B10b
rtk node tools/curation-report.mjs --batch B10b
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B10b.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B10b.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.15: Curate and Apply B11

**Files:** Create `.local/reviews/batches/B11.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B11 assignments, approved evidence and B10b-applied snapshot hashes. Produces one complete B11 `BatchReview` and the next validated snapshot.

- [ ] 完成 B11 全部 assigned sources；blocked 项也必须有合法空摘要和 review decision。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B11
rtk node tools/curation-report.mjs --batch B11
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B11.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B11.json --apply
rtk node tools/validate-knowledge.mjs --all
```

### Task 8.16: Curate and Apply B12

**Files:** Create `.local/reviews/batches/B12.json`; update curation targets only through the applier.

**Interfaces:** Consumes frozen B12 assignments, approved evidence and B11-applied snapshot hashes. Produces one complete B12 `BatchReview` and the final production-batch snapshot.

- [ ] 完成 B12 全部 assigned sources；全部医学/健康来源都要完成正交 gate 分诊。
- [ ] 运行预检：

```sh
rtk node tools/validate-knowledge.mjs --batch B12
rtk node tools/curation-report.mjs --batch B12
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B12.json --dry-run
```

- [ ] 完成人工抽查后运行：

```sh
rtk node tools/apply-curation-batch.mjs --batch-plan .local/reviews/batch-plan.json --batch-file .local/reviews/batches/B12.json --apply
rtk node tools/validate-knowledge.mjs --all
```

## Task 9: Model Markdown Parser Integration Validation

**Files:**

- Update: `tools/lib/model-markdown.mjs`
- Update: `tests/model-markdown.test.mjs`

**Interfaces:**

- Consumes: Task 5A parser contract、全部已应用模型 Markdown、`problem-routes.json.model_relations`。
- Produces: 对完整模型集合的单 parser 证明，以及站点可直接消费且不含 meta 注释的 `renderable_markdown`。

- [ ] 写失败测试，拒绝：缺 H2、顺序错误、重复 H2、空章节、无 meta、无 source ID、悬空关系、缺 Codex H3、真实个人信息示例。
- [ ] 复核唯一导出签名保持为：

```js
parseModelMarkdown(markdown, sourcePath)
validateModelDocument(modelDocument, knowledgeSnapshot)
```

- [ ] `parseModelMarkdown()` 固定返回：

```js
{
  title: string,
  meta: object,
  card_meta: object,
  sections: Record<string, string>,
  card_sections: Record<string, string>,
  renderable_markdown: string
}
```

- [ ] parser 只读取 H1、紧随 H1 的唯一 `model-meta` 与 `card-meta` JSON、固定 H2/H3 和各节正文；不执行 HTML。`renderable_markdown` 只删除这两条已解析元数据行，其他 HTML-like 文本不删除。
- [ ] 悬空关系检查只读取 `problem-routes.json.model_relations`；模型自然语言关系章节与该唯一结构化来源不一致时失败。
- [ ] 搜索 `tools/`、`tests/` 与站点构建代码，除 `tools/lib/model-markdown.mjs` 外不得存在解析 `model-meta`/`card-meta` 的实现；所有模型文件通过后，站点构建器直接消费解析结果，不创建人工维护的 `knowledge/models/index.json`。
- [ ] 运行：

```sh
rtk node --test tests/model-markdown.test.mjs
```

预期：命令退出码为 0，且 TAP 摘要 `fail 0`；不固定测试个数。

## Task 10: Codex Co-learning Cards

**Files:**

- Update: every ready model file in `knowledge/models/`
- Create: `tests/curation-coverage.test.mjs`

**Interfaces:**

- Consumes: Task 9 的 parsed model/card documents 与 ready model 集。
- Produces: 每个 ready model 恰好一张完整卡；`readyModelCount === completeCodexCardCount`。

- [ ] 为每个模型填写统一输入：

```text
情境
目标
已知事实
仍属假设的判断
约束
已经尝试
希望得到的输出
```

- [ ] 三种模板都必须说明该模型如何使用，而不是只复述模型名称：

```text
快速诊断：帮助识别是否匹配及最高价值缺失事实
深度分析：区分事实/假设/推断并综合主辅模型
行动方案：给出步骤、验证指标、停止条件和复盘节点
```

- [ ] 推荐组合始终只有一个核心模型和最多两个辅助模型。
- [ ] 完整示例必须包含用户输入、Codex 选择理由、一次最高价值追问、综合分析、行动步骤、验证指标和停止条件。
- [ ] 写测试：

```js
assert.equal(readyModelCount, completeCodexCardCount);
assert.ok(cards.every((card) => card.card_meta.auxiliary_model_ids.length <= 2));
```

- [ ] 对每章至少选一个模型进行真实问题演练并将私人过程写入 `.local/learning-notes/`；只有用户逐条批准的去标识化经验才能回写公开示例。

## Task 11: Problem Routes and Safety Gates

**Files:**

- Update: `tools/lib/route-matcher.mjs`
- Update: `knowledge/problem-routes.json`
- Update: `tests/problem-routes.test.mjs`
- Update: `tests/medical-safety.test.mjs`

**Interfaces:**

- Consumes: Task 5A matcher/gate 实现、全部 ready models/cards、所有来源的正交状态和 review queue。
- Produces: 完整 routes、global safety rules、model relations/tombstones，以及动态全来源 medical/logic 分诊结果。

- [ ] 实现固定匹配算法：

```text
NFKC 规范化输入
safety_rules 按 priority 优先匹配；命中即 safety_stop，不执行普通 route
命中 exclude_terms 则排除 route
累加 trigger_terms.weight
低于 minimum_score 不匹配
按 score 降序、priority 降序
取最高 score 与 priority 的完整并列集合
并列集合含多个主模型则不匹配
并列集合只有同一主模型时按 route_id 升序稳定选择
只返回一个主模型和最多两个辅助模型
缺关键输入时返回最高价值澄清问题
```

- [ ] 每条 route 的 `test_cases` 至少包含 3 个 `match` 和 2 个 `no_match`；每条 safety rule 至少有 2 个 `safety_stop` 测试。
- [ ] 高风险词先经过 medical/mental_health safety gate，不直接返回自助治疗模型。
- [ ] 分数不足、跨主模型并列不确定或只有泛化词时返回 `matched: false`。
- [ ] 对当期 source summary 集的全部来源做 medical 和 logic 分诊；测试和实现从输入计算数量。首版报告另行证明基线 418 条无遗漏；需要专家者写入私有 review queue，未指定合格 reviewer 时不批准。
- [ ] 高风险来源要有公开 risk flag 和 evidence boundary。Validator 以该来源 `model_roles[].model_id` 与 ready model 集的交集作为 `linked_ready_model_ids`；集合中每个模型的 card-meta 和自然语言卡都必须有停止/升级条件。集合为空或任一模型不安全时，该来源不得 `ready`。
- [ ] 页面显示固定免责声明，不把规则匹配称为 AI 诊断。

## Task 12: Chapter Synthesis

**Files:**

- Create: 13 chapter files listed in File Map

**Interfaces:**

- Consumes: 已批准模型、source contributions、taxonomy、正交风险状态和 current public source set。
- Produces: 固定 13 个章节文件；每个来源只计入一个主章节，跨主题只建关系。

每章固定结构：

```md
# 章节名

## 本章解决什么问题
## 核心模型地图
## 推荐学习顺序
## 常见模型组合
## 易混淆边界
## 跨章节关系
## 风险与证据提示
## 来源覆盖
```

- [ ] 从已批准模型和来源贡献综合每章，不复制原文。
- [ ] 核心模型地图链接到真实存在的模型 ID。
- [ ] 来源覆盖列出 ready、needs_review、needs_ocr、needs_medical_review 的计数。
- [ ] baseline chapter counts 保留并合计 418；current chapter counts 每次从当期公开来源计算并等于 manifest `current_source_count`。若主章节因复核调整，私有审计记录旧值、新值和理由。

## Task 13: Manifest and Full Curation Verification

**Files:**

- Create: `tools/lib/knowledge-manifest.mjs`
- Create: `tools/validate-knowledge.mjs`
- Create: `tools/curation-report.mjs`
- Create: `knowledge/manifest.json`
- Update: `README.md`
- Update: `AGENTS.md`

**Interfaces:**

- Consumes: 全部公共知识文件、私有 summary/catalog 计数和 processing protocol versions。
- Produces: 确定性 manifest、动态覆盖报告与 Phase C 唯一知识快照入口。

`knowledge/manifest.json` 固定字段：

```js
{
  schema_version: "1.0.0",
  knowledge_version: string,
  corpus_version: string,
  baseline_source_count: 418,
  current_source_count: number,
  baseline_chapter_counts: Record<string, number>,
  current_chapter_counts: Record<string, number>,
  processing_versions: {
    cleaner: "1.0.0",
    summary_protocol: "1.0.0",
    curation_protocol: "1.0.0",
    model_contract: "1.0.0",
    route_contract: "1.0.0"
  },
  counts: {
    chapters: 13,
    models: number,
    codex_cards: number,
    routes: number
  },
  source_status_counts: Record<string, number>,
  ocr_status_counts: Record<string, number>,
  medical_review_status_counts: Record<string, number>,
  logic_review_status_counts: Record<string, number>,
  public_files: Array<{ path: string, sha256: string }>
}
```

- [ ] `public_files` 只列 taxonomy、sources、problem routes、13 章和模型 Markdown；不列 `knowledge/manifest.json` 自身，也不列由它生成的 `site/index.html`，避免递归 hash。
- [ ] manifest 不写当前时间；`knowledge_version` 等于上述 `public_files` 按 path 升序串联后所得集合 hash 的前 16 位，确保相同输入得到相同版本。
- [ ] `corpus_version` 等于公开来源记录按 source ID 升序序列化后的集合 hash 前 16 位并加 `corpus-` 前缀；新增、撤回或改变公开来源都会得到新版本，不永久写死日期字符串。
- [ ] `current_source_count` 每次等于 `knowledge/sources.json.sources.length`，`current_chapter_counts` 每次从同一数组聚合且总和相等；`baseline_source_count` 与 `baseline_chapter_counts` 只保存批准的首版 418 快照，不参与未来 current 校验。
- [ ] 写覆盖测试：

```text
initial baseline source count = 418
initial current source count = baseline source count
current source count = public sources array length
current chapter counts total = current source count
private summary record count = current local catalog source count
unique private summary source IDs = current local catalog source count
approved + blocked_ocr + needs_review + rejected + new + draft = current local catalog source count
every public source has one primary chapter
every ready source references at least one model
every ready model has one canonical source
ready models = complete Codex cards
all route model references exist and are ready
auxiliary models <= 2
all high-risk sources have risk flags and evidence boundaries
all ready models linked from high-risk sources have stop/escalation conditions
all frozen same-title groups have a decision
all generated long/short candidates have a decision or needs_review
all image-dominant sources have approved, needs_visual_review, rejected, or fetch_failed OCR status
all processing status and orthogonal review status counts sum correctly
```

- [ ] 运行：

```sh
rtk node --test tests/contracts.test.mjs tests/evidence.test.mjs tests/dedup.test.mjs tests/model-markdown.test.mjs tests/taxonomy.test.mjs tests/problem-routes.test.mjs tests/curation-coverage.test.mjs tests/medical-safety.test.mjs
rtk node tools/validate-knowledge.mjs --all
rtk node tools/curation-report.mjs --all
rtk npm run corpus -- verify-public --scope worktree --root . --raw-manifest .local/state/raw-baseline.json --current-pointer .local/state/current-cleaning.json
rtk git diff --check
```

- [ ] 首版报告基线 418 条的全部 processing、OCR、medical 和 logic 状态；未来报告分别从 local catalog 与 public sources 计算 current count，不得只报告成功项，也不得把 418 复制成未来断言。
- [ ] 保留完整验证报告，继续验证未来增量更新流程。

## Task 14: Incremental Codex Curation Workflow

**Files:**

- Create: `tools/prepare-incremental-review.mjs`
- Create: `tests/incremental-curation.test.mjs`
- Create or update: `.local/reviews/incremental-current.json`
- Update: `README.md`
- Update: `AGENTS.md`

**Interfaces:**

- Consumes: previous manifest/protocol versions、pointer 选中的已验证 current catalog、opaque ID map、summaries/contributions、routes/tombstones。
- Produces: 只含真实 invalidation 的 incremental review、稳定新 source/model IDs、更新后的完整知识快照和全量站点重建信号。

- [ ] 写失败测试，给定 fixture 中动态读取的 `N` 个 unchanged source 和 1 个新 source 时，只把新 source 放入语义复核队列；测试不得把 `N` 写成 418。
- [ ] 写失败测试，cleaned hash 变化时把旧摘要标记为 stale；URL、raw hash、clean hash 均未变时不得重做摘要。
- [ ] 写失败测试，确定性 duplicate 不新建模型；疑似重复只生成复核候选。
- [ ] `incremental-current.json` 固定记录：

```js
{
  schema_version: "1.0.0",
  new_source_ids: string[],
  changed_source_ids: string[],
  removed_source_ids: string[],
  unchanged_source_ids: string[],
  deterministic_duplicate_ids: string[],
  semantic_review_ids: string[],
  prior_affected_model_ids: string[],
  final_affected_model_ids: string[],
  affected_chapter_ids: string[],
  retired_model_ids: string[],
  protocol_changes: Array<{
    protocol: "cleaner" | "summary" | "curation" |
              "model_contract" | "route_contract",
    from_version: string,
    to_version: string
  }>,
  stale_artifacts: Array<{
    type: "summary" | "contribution" | "model" | "card" |
          "chapter" | "route" | "manifest" | "site",
    id: string,
    reason: string
  }>
}
```

- [ ] Codex 每次处理新增来源时按固定顺序：

```text
读取来源元数据、清理正文和批准的 OCR
提取目标问题、核心结论、概念、机制、方法、边界、独有贡献
为每个 claim 添加证据引用
检查确定性重复与疑似重复
选择一个主章节、标签和内容角色
判断更新现有模型还是创建新稳定模型 ID
同步更新 Codex 共学卡
同步更新相关章节、来源索引、manifest 和问题路由
标记所有未解决风险
```

- [ ] 增量修改只触及受影响的来源、模型、章节和 route；但完成后必须重新运行全量知识验证，并由站点计划重建整个 `site/index.html`。
- [ ] cleaner、summary、curation、model 或 route 协议版本逐项比较 old/new；按以下固定失效图生成 `stale_artifacts`，不能用单个 boolean 丢失变化原因：

```text
cleaner change        -> affected summaries -> contributions -> models/cards -> chapters/routes -> manifest/site
summary change        -> affected summaries -> contributions -> models/cards -> chapters/routes -> manifest/site
curation change       -> all contributions -> models/cards -> chapters/routes -> manifest/site
model_contract change -> all models/cards -> chapters/routes -> manifest/site
route_contract change -> all routes -> manifest/site
source changed        -> that summary -> its prior contributions/models -> affected chapters/routes -> manifest/site
source removed        -> its contributions/models -> affected chapters/routes -> manifest/site
visibility changed    -> public source index -> affected models/chapters/routes -> manifest/site
```

只有从既有 contributions 反向可达的模型可进入 `prior_affected_model_ids`；新来源在语义分析前不贡献 prior model。
- [ ] 来源撤回只撤销公开索引并把本地记录保留为 `superseded`，不得删除原始 snapshot；使相关 contribution/model/chapter/route 失效。模型合并或改名把旧 ID 写入 `model_tombstones`，可指向 successor，并保留 alias；任何新模型不得复用 retired ID。
- [ ] 语义复核前只能填写 `prior_affected_model_ids`；分析完成后才锁定 `final_affected_model_ids`，不能根据标题预猜最终模型。
- [ ] 新 catalog 来源先通过 Task 4 工具取得一次性 opaque source ID；URL、标题、路径和任何 fingerprint 的变化都不能重新计算 source ID，尤其 `local_only` ID 不得由 URL 推导。
- [ ] 新 URL 抓取失败时不修改旧模型；记录 `fetch_failed` 并报告用户可补本地 Markdown snapshot。
- [ ] 新模型若缺完整卡、证据或边界，只能保持 `needs_review`，不能进入 ready。
- [ ] 运行：

```sh
rtk node --test tests/incremental-curation.test.mjs
rtk node tools/prepare-incremental-review.mjs --current-pointer .local/state/current-cleaning.json --summaries .local/analysis/source-summaries.jsonl --output .local/reviews/incremental-current.json
rtk node tools/validate-knowledge.mjs --all
```

预期合成测试（`N` 来自 fixture，不是固定常量）：

```text
new_sources=1
changed_sources=0
unchanged_sources=N
semantic_review_sources=1
unchanged_summary_rewrites=0
```

- [ ] README 给用户两种入口：

```text
把 Markdown 放进 inbox/
把 URL 发给 Codex，由 Codex 先保存和登记本地快照
```

- [ ] AGENTS 要求后续 Codex 先运行 discover 和 incremental review，再做语义判断；不可只改 HTML 或只追加一篇孤立摘要。
- [ ] 再运行 Task 13 全量验证，停止并请用户复核完整知识体系、Codex 共学卡与增量流程；不自动 commit 或进入发布。
