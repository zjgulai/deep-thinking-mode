# Public-safe Repository and Cleaning Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在可证明可恢复的前提下，把 418 份原始 Markdown 迁入本地私有层，建立可增量摄取 Markdown 与 URL、保守且确定性的清洗和来源登记管线，并阻止任何私有全文进入公开仓库。

**Architecture:** full-SHA baseline manifest 和已验证 Git bundle 共同定义唯一可迁移的 418 个源文件；迁移采用 no-clobber 发布、逐文件 journal 和“目标验证后才删除来源”的可恢复流程。`.local/cleaned/runs/<run_sha256>/` 保存自包含的不可变清洗 run，每个 run 同时包含来源输出、catalog 和 report；`.local/state/current-cleaning.json` 是唯一可变提交记录和当前 run 选择权威。URL 使用连接级 DNS pinning 和内容寻址版本快照。公开范围检查器把 worktree、Git ref 和 Pages artifact 分成三个独立 scope，并组合 schema allowlist、路径规则、全文 hash 与短来源片段扫描。

**Tech Stack:** Node.js 24.18.0 LTS、npm、原生 ESM、`node:test`、`node:http`、`node:https`、`node:dns/promises`、Git bundle、HMAC-SHA-256、SHA-256、UTF-8 Markdown。

## Global Constraints

- 只在 `main` 工作，禁止 worktree。
- 当前项目要求 shell 命令使用 `rtk`；若 `rtk` 仍不可用，停止写操作并执行总计划 Gate 0。
- 不自动 commit、不改 `main` 引用、不配置 remote、不 push。
- 原始资料只复制或迁移，不改写；清理结果写入独立目录。
- 任何目标文件已存在且 hash 不同都必须停止。
- 不使用 `git reset --hard`、`git checkout --`、递归删除或 force push。
- 所有基线比较必须使用 `f876ce90d24ed486cae4060b1a4fe7b0813e9492`，不得用短 SHA 作为安全边界。
- 基线 418/418/237 只用于首版迁移验收；增量运行的来源、URL 和图片数量从 catalog 动态计算。
- 私有 `source_id` 由本地 HMAC key 生成，不能从公开 URL 直接推导；key、locator 和本地路径永不进入公开文件。
- 清理器只有在完整微信导出指纹匹配时才删除外壳；不按“广告、收藏、推荐”等关键词删除正文。
- 不对非空行执行全局 `rstrip`。
- URL 网络请求必须使用已验证且绑定到实际 socket connect 的 IP；禁止“先查 DNS、再由普通 `fetch` 独立解析”。
- 本计划不做语义总结、OCR 识别、知识模型合并、HTML 构建或远端发布。

---

## File Map

创建或更新的公开文件：

```text
.gitignore
.nvmrc
.npmrc
package.json
package-lock.json
README.md
AGENTS.md
tools/corpus.mjs
tools/config/corpus.json
tools/config/wechat-export-fingerprints.json
tools/config/confirmed-removals.json
tools/lib/cli.mjs
tools/lib/hash.mjs
tools/lib/json.mjs
tools/lib/fs-safety.mjs
tools/lib/cleaning-state.mjs
tools/lib/git-baseline.mjs
tools/lib/source-id-key.mjs
tools/lib/source-id.mjs
tools/lib/source-parser.mjs
tools/lib/input-discovery.mjs
tools/lib/ip-safety.mjs
tools/lib/url-canonicalizer.mjs
tools/lib/url-safety.mjs
tools/lib/pinned-http-client.mjs
tools/lib/url-aliases.mjs
tools/lib/url-snapshot.mjs
tools/lib/wechat-cleaner.mjs
tools/lib/corpus-cleaner.mjs
tools/lib/clean-run-store.mjs
tools/lib/raw-backup.mjs
tools/lib/original-migration.mjs
tools/lib/migration-journal.mjs
tools/lib/local-verifier.mjs
tools/lib/public-scope.mjs
tests/cli.test.mjs
tests/source-id.test.mjs
tests/source-parser.test.mjs
tests/input-discovery.test.mjs
tests/url-safety.test.mjs
tests/pinned-http-client.test.mjs
tests/url-snapshot.test.mjs
tests/wechat-cleaner.test.mjs
tests/corpus-cleaner.test.mjs
tests/raw-backup.test.mjs
tests/original-migration.test.mjs
tests/local-verifier.test.mjs
tests/public-scope.test.mjs
tests/helpers/temp-dir.mjs
tests/helpers/temp-repo.mjs
tests/fixtures/wechat/square-export.md
tests/fixtures/wechat/cognition-export.md
tests/fixtures/wechat/image-dominant-export.md
tests/fixtures/wechat/title-mismatch.md
tests/fixtures/wechat/footer-mismatch.md
tests/fixtures/wechat/ordinary-markdown.md
tests/fixtures/wechat/expected/square-cleaned.md
tests/fixtures/wechat/expected/cognition-cleaned.md
tests/fixtures/wechat/expected/image-dominant-cleaned.md
tests/fixtures/public/safe-file.txt
```

本地生成且必须忽略：

```text
inbox/
.local/original/
.local/cleaned/
.local/ocr/
.local/learning-notes/
.local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle
.local/backup/source-id-key.bin
.local/state/source-id-key.bin
.local/catalog/url-aliases.jsonl
.local/state/raw-baseline.json
.local/state/migration-report.json
.local/state/migration-journal.jsonl
.local/state/current-cleaning.json
.local/state/cleaning-transitions/
.local/state/cleaning-commit.lock
.local/reviews/image-dominant-baseline.json
.local/state/public-scope-report.json
.local/state/url-intake/
.local/original/markdown/
.local/original/url/
.local/cleaned/runs/<run_sha256>/sources/<source_id>.md
.local/cleaned/runs/<run_sha256>/catalog/sources.jsonl
.local/cleaned/runs/<run_sha256>/cleaning-report.json
.local/tmp/
```

`.gitignore` 的必需规则：

```gitignore
.DS_Store
node_modules/
/.local/
/inbox/
*.bundle
/*.md
!/AGENTS.md
!/README.md
```

## Public and Private Contracts

### `tools/config/corpus.json`

```json
{
  "schema_version": "1.0.0",
  "baseline_commit": "f876ce90d24ed486cae4060b1a4fe7b0813e9492",
  "baseline_source_count": 418,
  "baseline_source_url_count": 418,
  "baseline_body_image_count": 237,
  "source_id_algorithm": "hmac-sha256-private-locator-first-32",
  "cleaner_version": "1.0.0"
}
```

首版验收后不得把 `baseline_*` 当作当前 catalog 数量。所有增量报告必须同时输出 `baseline_source_count` 和动态计算的 `registered_source_count`。

### `tools/config/wechat-export-fingerprints.json`

生产 fingerprint 必须精确写入：

```json
{
  "schema_version": "1.0.0",
  "header": {
    "css_sha256": "be0e2c791033d2b7b55495fbd09b0054e90fdb0f811253d0feaa177cdd6ce608",
    "title_line": 1,
    "blank_line": 2,
    "formal_title_line": 3,
    "setext_line": 4,
    "metadata_line": 6,
    "source_url_line": 8
  },
  "footers": {
    "square": {
      "last_line_count": 4,
      "action_icon_count": 5,
      "sha256": "730b1c4bdd950615aca31fda3bc8462fa5892f2c415d12f631e590e2f5ada4ee"
    },
    "cognition": {
      "last_line_count": 4,
      "action_icon_count": 5,
      "sha256": "d97d021099a51ffa977d76a4d0061858bf54a5c787530c96c0c15b4a7185f525"
    }
  }
}
```

所有生产指纹都在任何清理、Unicode 或换行规范化之前计算。CSS 指纹取第一物理行中首个字面量 `\* {` 起至该行末尾的原始 UTF-8 bytes，不包含换行。页脚通常先只移除文件末尾恰好一个 LF，再取最后四个物理行（空分隔行、品牌图片行、空行、五图标操作栏），以单个 LF 连接且末尾不再追加 LF。CRLF、行数或 marker 不符一律先进入 `needs_review`，不得边规范化边凑 fingerprint。

缺失终止 LF 只有冻结基线例外：Gate 0 已确认 HEAD 精确为 `f876ce90d24ed486cae4060b1a4fe7b0813e9492`，且根层 Markdown 路径集合精确为冻结的 418 个路径后，后续只可沿已验证 `raw-baseline.json` 的同一 418-path path/hash 集合使用 `inputMode="verified_baseline"`。该模式直接从缺失终止 LF 的原始 bytes 取最后四个物理行，仍以单个 LF 连接且不追加 LF 后计算 footer hash；不得先补换行再计算。完整清理成功后必须在 `changes` 中记录一次 `EOF_NEWLINE_V1`/`append_eof` 并在输出末尾补且只补一个 LF。`verified_baseline` 不是 CLI 参数，也不得由路径、数量或标题推断；Gate 0、baseline manifest full SHA、418 个 path/hash 和当前输入 hash 任一不符都必须返回 `needs_review` 或对应 baseline mismatch。未来 Markdown/URL 一律使用 `inputMode="incremental"`，缺失终止 LF 时逐 byte 原样返回 `needs_review`。基线只读复算必须得到 CSS 418/418、Square 页脚 393、Cognition 页脚 25。

header 的固定语法按原始 1-based 物理行验证：line 1 必须精确为五个 U+0020、line 3 的完整 UTF-8 bytes、一个 U+0020，再接从字面量 `\* {` 开始的 CSS；line 2/5/7 必须为空；line 3 非空；line 4 必须匹配 `^=+$`；line 6 必须匹配 `^(原创|非原创) (.+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) (.+)$`，依次提取 `originalStatus`、`author`、`publishedAt`、`location`；line 8 必须精确匹配 `> 原文地址: [display-url](target-url)`。先把 display 中的 `\_` 撤销并与 Markdown 中尚未 canonicalize 的 raw target token 逐字符比较；相等后才 canonicalize target，并要求结果为微信 host。不得复用全文扫描 parser 让正文中的候选字段替代固定行。冻结 418 份的该语法只读审计必须逐项得到 418/418。

### `tools/config/confirmed-removals.json`

公开配置只保存 canonical URL 的 SHA-256 与被删行 SHA-256，不保存 URL、CTA 原文或私有 `source_id`：

```json
{
  "schema_version": "1.0.0",
  "entries": [
    {
      "canonical_url_sha256": "896c5568a4c320d8d1aba20895b166947a492cbe16508af6000e527abf5e9ab1",
      "trimmed_line_sha256": "07729259ac53bca3154a02d01a0d92f23af81a8e6326a9f739c9872ec08c2353"
    },
    {
      "canonical_url_sha256": "896c5568a4c320d8d1aba20895b166947a492cbe16508af6000e527abf5e9ab1",
      "trimmed_line_sha256": "88242bceb42c9c1315284fbafb3515287a4ef0572d1bff8cb1e2ab8bc31a276d"
    },
    {
      "canonical_url_sha256": "a30b39b9e378d038d6c1c216ef2dffed3fd89c913b18d8cbebf50c42702282d5",
      "trimmed_line_sha256": "c6b692ca3fc2ae731cc3b021b5c1fb610cf5829a118ff4148b1549a4c3969169"
    },
    {
      "canonical_url_sha256": "5cc36138cde1aa2c2af2567e5e20daf4d77dd847a5f0b5bdb5f3c2a7420ec8ac",
      "trimmed_line_sha256": "d636981573df790341d9df95f6cceae72fde69c10b43f5451663a644a012dd81"
    },
    {
      "canonical_url_sha256": "d2f66df7124978d73465b6b893fe5db973834327ecc5ec177c7d33da90d2d3de",
      "trimmed_line_sha256": "e405cf2d67b22b2485542462ea2d1b4abd2adce2a427a405cef898135cb4c5f2"
    }
  ]
}
```

`trimmed_line_sha256` 在任何 NBSP、Unicode 或换行规范化之前计算：先去掉物理行
terminator，再且只再去掉两端 U+0020 与 HTAB。不得使用 JavaScript Unicode
`trim()` 扩大删除面。同一 `canonical_url_sha256 + trimmed_line_sha256` 在单份来源
命中超过一次时，整份来源逐 byte 原样返回 `needs_review`；零次表示无删除，一次才
删除。Task 8 的冻结基线 verifier 必须额外证明五条生产 entry 在 418 份集合中各命中
且只命中一次。

### Private source ID

`ensureSourceIdKey()` 首次运行时以 `open(..., "wx", 0o600)` 创建 32-byte random key，同时以 no-clobber 方式复制到 `.local/backup/source-id-key.bin`；两份已存在但 hash 不同必须失败。测试注入固定 key，生产 CLI 不得提供从参数传入 key 内容的选项。

```js
const privateLocator =
  sourceUrl !== null
    ? "url\0" + canonicalizeHttpUrl(sourceUrl)
    : "raw\0" + rawSha256;

const sourceId =
  "src_" +
  createHmac("sha256", privateKey)
    .update(privateLocator)
    .digest("hex")
    .slice(0, 32);
```

Catalog 保存 locator 类型与 locator SHA-256，用于检测截断碰撞；不得保存 HMAC key。相同 locator 复用 `source_id`，不同 locator 得到相同截断值时返回 `SOURCE_ID_COLLISION`。当 pointer 已存在时，私有 source-ID key 丢失检查必须使用经验证的 pointer-selected catalog bytes，不得打开其他 catalog 副本。

### `.local/cleaned/runs/<run_sha256>/catalog/sources.jsonl`

每行一个本地来源，字段固定为：

```js
{
  schema_version: "1.0.0",
  source_id: "src_" + thirtyTwoHex,
  source_kind: "baseline_markdown" | "markdown" | "url",
  locator_sha256: sixtyFourHex,
  original_path: string,
  cleaned_path: ".local/cleaned/runs/<run_sha256>/sources/<source_id>.md",
  title: string | null,
  author: string | null,
  original_status: string | null,
  published_at: string | null,
  location: string | null,
  source_url: string | null,
  raw_sha256: sixtyFourHex,
  cleaned_sha256: sixtyFourHex,
  body_image_urls: string[],
  content_mode: "text" | "mixed" | "image_dominant",
  ingest_status: "registered" | "duplicate" | "superseded",
  cleaning_status: "cleaned" | "needs_review",
  processing_status: "new" | "cleaned" | "needs_review" | "ready" |
                     "needs_ocr" | "needs_medical_review",
  cleaner_version: string,
  audit_sha256: sixtyFourHex | null,
  review_state_owner: "mechanical" | "reviewer",
  review_state_version: nonNegativeInteger,
  review_state_bound_raw_sha256: sixtyFourHex,
  review_state_bound_cleaned_sha256: sixtyFourHex,
  review_state_bound_audit_sha256: sixtyFourHex | null,
  review_state_bound_cleaner_version: string,
  snapshot_version: positiveInteger,
  publication_policy: "local_only" | "public_metadata" |
                       "public_synthesis_redacted"
}
```

文件名只出现在 pointer 选中的本地 catalog，公共 `knowledge/sources.json` 不包含本地路径。
Pointer-selected Task 5 run catalog 只包含已经进入该自包含 run 的来源：`original_path`
必须位于 `.local/original/`，`cleaned_path` 必须精确位于同一 run 的
`sources/<source_id>.md`，raw/cleaned hashes 均非 null。尚未取得响应 bytes 的
`fetch_failed` URL 只留在 URL intake/fetch manifest，不进入 pointer-selected run catalog。
当前 418 篇已有公开微信来源，初始为 `public_metadata`；未来新增 Markdown 或 URL 默认 `local_only`，只有用户明确批准后才能改变。
URL 来源的 requested canonical URL、每次 final URL、fetch 状态和版本 manifest 只存在于本地 catalog 与 `.local/original/url/`。同一 URL 的新响应创建新 `snapshot_version`；不得覆盖旧版本。

### `cleanWechatExport(rawBytes, options)`

`options.inputMode` 必须为 `"verified_baseline"` 或 `"incremental"`。只有 baseline
编排层在同一验证链中确认 Gate 0、full SHA、精确 418-path manifest 和当前输入
path/hash 后，才可传入 `"verified_baseline"`；该值不得暴露为 CLI 用户参数。所有未来
Markdown/URL 都必须传入 `"incremental"`。
Task 4 的 `inputMode` 是 corpus 内部 trust label，不是独立安全 capability；Task 4 只验证
mode 值与原始壳。系统级“仅冻结基线可用”保证由 Task 8 的 Gate 0 + manifest path/hash
验证、无 CLI override 和编排失败测试共同强制。除该编排层外，任何 production caller
传入 `"verified_baseline"` 都违反合同。
`rawBytes` 只接受 `Buffer`/`Uint8Array`；清理器先复制 bytes，再以 fatal UTF-8 解码。
非 byte 输入属于 programmer error 并抛出 `TypeError`；解码失败或任何内容校验失败则
返回逐 byte 相同的 `outputBytes`。

```js
{
  status: "cleaned" | "needs_review",
  outputBytes: Buffer,
  cleanedMarkdown: string | null,
  metadata: {
    title: string | null,
    author: string | null,
    originalStatus: string | null,
    publishedAt: string | null,
    location: string | null,
    sourceUrl: string | null
  },
  bodyImages: Array<{
    ordinal: positiveInteger,
    alt: string,
    url: string
  }>,
  changes: Array<{
    ruleId: string,
    kind: "delete" | "normalize" | "append_eof",
    sourceLines: number[] | null,
    beforeSha256: string,
    afterSha256: string
  }>,
  warnings: string[],
  audit: null | {
    source_byte_length: nonNegativeInteger,
    output_byte_length: nonNegativeInteger,
    retained_spans: Array<{
      source_line: positiveInteger,
      source_span: { start: nonNegativeInteger, end: positiveInteger },
      output_span: { start: nonNegativeInteger, end: positiveInteger },
      before_sha256: sixtyFourHex,
      after_sha256: sixtyFourHex
    }>,
    metadata_spans: {
      title: AuditSpan,
      author: AuditSpan,
      original_status: AuditSpan,
      published_at: AuditSpan,
      location: AuditSpan,
      source_url: AuditSpan
    },
    image_spans: Array<{
      ordinal: positiveInteger,
      source_token_span: ByteSpan,
      output_token_span: ByteSpan,
      source_sha256: sixtyFourHex,
      output_sha256: sixtyFourHex,
      alt_sha256: sixtyFourHex,
      url_sha256: sixtyFourHex
    }>,
    hard_breaks: Array<{
      source_line: positiveInteger,
      source_span: ByteSpan,
      output_span: ByteSpan,
      preserved: true
    }>,
    body_output_span: { start: nonNegativeInteger, end: nonNegativeInteger },
    ordered_body_images_preserved: true,
    body_non_whitespace_code_points: nonNegativeInteger
  }
}
```

`ByteSpan` 与 `AuditSpan` 都使用 0-based、half-open byte offsets `[start, end)`，
`0 <= start < end <= corresponding_byte_length`；`body_output_span` 允许
`0 <= start <= end <= output_byte_length`。每个 span collection 内都必须按起点
严格排序且不重叠，不禁止 cross-collection containment。`retained_spans`
按 `source_line` 严格递增，source span 包含该物理行实际存在的 LF，output span
包含对应输出行实际存在的 LF。Metadata、image 与 hard-break 的 source/output
spans 必须分别被对应 retained line span 包含。`image_spans` 按正整数
`ordinal` 严格递增且唯一，token span 只包含 Markdown image token bytes，
不包含 LF，并用 token/alt/URL hashes 与同 ordinal `bodyImages` 逐项
cross-validate count、order 和 bytes。`metadata_spans` 的每个 `AuditSpan` 还含
`{ source_span, output_span, before_sha256, after_sha256, preserved: true }`，由 Task 4
使用它已有的位置化 header ledger 产生。`hard_breaks` 覆盖每个未删除、
原始非空且以两个 U+0020 结尾的物理行，span 精确指向这两个 bytes。
`body_output_span` 精确限定清理后正文，排除 title/header/source-link 结构，
即使正文为空也必须给出 zero-length span。`body_non_whitespace_code_points`
只在该 span 内排除 exact `output_token_span`，对剩余 bytes 执行 fatal UTF-8 解码后
计数 Unicode 非 whitespace code points。所有 normalization、span mapping 与测量
均由 Task 4 一次性拥有；Task 5 不重放 ledger、不重解析。只有完整成功的
`status="cleaned"` 必须返回完整非 null audit，包括成功但零变更的结果；
成功零变更允许 `outputBytes` 与输入相同，但 metadata/bodyImages 仍必须完整且
`changes:[]`。任何 failure/`needs_review` 必须精确返回：byte-identical
`outputBytes`、已按既定规则解码的 `cleanedMarkdown` 或 null、全 null metadata、
空 `bodyImages`、空 `changes`、`audit:null` 与至少一个稳定 warning code。

`sourceLines` 使用原输入的 1-based、升序、无重复物理行号。`delete` 的行号必须连续；
`normalize` 可以非连续，以表达中间 CTA/figure label 删除后才相邻的空白行。before hash
按 `sourceLines` 顺序拼接每条原始 physical-line slice（包含该行实际存在的 LF）计算，
after hash 对 replacement bytes 计算；`delete.afterSha256` 是空 bytes hash。
`append_eof.sourceLines` 为 null，before 是空 bytes hash，after 是单个 `0x0A` hash。
只有 failure/`needs_review` 结果使用上述 exact byte no-op 合同；成功零变更
不是 failure no-op。

`CleanChange.ruleId` 与 `kind` 是 exact mapping：`WECHAT_HEADER_V1`、
`WECHAT_FOOTER_SQUARE_V1`、`WECHAT_FOOTER_COGNITION_V1`、
`DUPLICATE_FIGURE_LABEL_V1`、`CONFIRMED_PLATFORM_CTA_V1` 只能为 `delete`；
`NBSP_NORMALIZATION_V1`、`BLANK_LINE_NORMALIZATION_V1` 只能为 `normalize`；
`EOF_NEWLINE_V1` 只能为 `append_eof`。Cross-pair 一律无效。

允许的 `ruleId`：

```text
WECHAT_HEADER_V1
WECHAT_FOOTER_SQUARE_V1
WECHAT_FOOTER_COGNITION_V1
DUPLICATE_FIGURE_LABEL_V1
CONFIRMED_PLATFORM_CTA_V1
NBSP_NORMALIZATION_V1
BLANK_LINE_NORMALIZATION_V1
EOF_NEWLINE_V1
```

### CLI

统一入口：

```text
rtk npm run corpus -- preflight
rtk npm run corpus -- backup
rtk npm run corpus -- migrate
rtk npm run corpus -- clean
rtk npm run corpus -- verify-local
# verify-public 必须从下方三个 scoped 接口中选择一个
rtk npm run corpus -- discover
rtk npm run corpus -- ingest-markdown
rtk npm run corpus -- finalize-markdown-input
rtk npm run corpus -- prepare-url
rtk npm run corpus -- snapshot-url
rtk npm run corpus -- register-snapshot
rtk npm run corpus -- recover-cleaning-commit
```

精确接口：

```text
preflight --mode baseline|incremental --root PATH --config PATH
backup --baseline FULL_SHA --bundle PATH --manifest PATH --expect-count 418 [--apply --confirm CREATE_VERIFIED_RAW_BUNDLE]
migrate --source-root PATH --destination PATH --baseline-manifest PATH --journal PATH --report PATH [--dry-run | --apply --confirm MOVE_BASELINE_RAW_MARKDOWN_TO_LOCAL]
clean --input PATH --runs-root PATH --current-pointer PATH --key PATH --strict [--dry-run | --apply]
verify-local --baseline-manifest PATH --bundle PATH --current-pointer PATH --key PATH --key-backup PATH --journal PATH
verify-public --scope worktree --root PATH --raw-manifest PATH --current-pointer PATH
verify-public --scope git-ref --root PATH --git-ref REF --raw-manifest PATH --current-pointer PATH
verify-public --scope artifact --artifact-dir PATH [--raw-manifest PATH --current-pointer PATH]
discover --root PATH --current-pointer PATH
ingest-markdown --path PATH --key PATH --runs-root PATH --current-pointer PATH --journal PATH [--dry-run | --apply --confirm INGEST_LOCAL_MARKDOWN]
finalize-markdown-input --journal PATH --source-id SOURCE_ID --current-pointer PATH [--dry-run | --apply --confirm REMOVE_VERIFIED_INPUT]
prepare-url --url URL --output PATH --current-pointer PATH --key PATH
snapshot-url --intake PATH --current-pointer PATH --key PATH --original-root PATH [--apply --confirm FETCH_UNTRUSTED_PUBLIC_URL]
register-snapshot --fetch-manifest PATH --markdown PATH --current-pointer PATH --key PATH --runs-root PATH [--dry-run | --apply --confirm REGISTER_URL_MARKDOWN]
recover-cleaning-commit --root PATH --confirm RECOVER_INTERRUPTED_CLEANING_COMMIT
```

`PATH`、`REF`、`URL` 和 `FULL_SHA` 是 CLI 语法中的参数类型，不是待执行命令。后续任务中的 shell 代码块只使用当前仓库已有的确定路径或合成测试 fixture，不包含伪造域名或伪造 source ID。

所有写命令把机器可读结果输出到 stdout JSON；错误输出包含稳定 `code`。退出码：

```text
preflight          0 success, 2 validation failure
backup             0 success, 2 verification failure, 4 apply confirmation missing
migrate            0 success, 2 conflict, 4 apply confirmation missing
clean              0 success, 2 strict cleaning failure
recover-cleaning-commit 0 recovered/retired, 2 locked/stale/invalid, 4 confirmation missing
verify-local       0 success, 2 invariant failure
verify-public      0 success, 3 public scope violation
discover            0 success, 2 ambiguous input
ingest-markdown      0 success, 2 conflict, 4 apply confirmation missing
finalize-markdown-input 0 success, 2 invariant failure, 4 removal confirmation missing
prepare-url          0 success, 2 invalid or conflicting URL
snapshot-url        0 success, 2 fetch failure, 4 network confirmation missing
register-snapshot   0 success, 2 invalid or conflicting snapshot, 4 apply confirmation missing
all commands         5 Git, filesystem, DNS, HTTP, or unexpected I/O failure
```

写操作必须同时提供 `--apply` 与精确确认串：

```text
backup  -> CREATE_VERIFIED_RAW_BUNDLE
migrate -> MOVE_BASELINE_RAW_MARKDOWN_TO_LOCAL
ingest-markdown -> INGEST_LOCAL_MARKDOWN
finalize-markdown-input -> REMOVE_VERIFIED_INPUT
snapshot-url -> FETCH_UNTRUSTED_PUBLIC_URL
register-snapshot -> REGISTER_URL_MARKDOWN
recover-cleaning-commit -> RECOVER_INTERRUPTED_CLEANING_COMMIT
```

`verify-public` 的三个 scope 不得隐式互相调用。Phase A 的预期结果是 `worktree` 通过、`git-ref main` 因旧历史含原文而返回退出码 3；只有发布计划可以要求三个 scope 同时通过。

## Task 1: Runtime and Repository Preflight

**Files:**

- Create: `.nvmrc`
- Create: `.npmrc`
- Create: `package.json`
- Create: `tools/corpus.mjs`
- Create: `tools/lib/cli.mjs`
- Create: `tools/lib/git-baseline.mjs`
- Create: `tools/lib/cleaning-state.mjs` in Task 5 before enabling incremental mode
- Test: `tests/cli.test.mjs`

**Interfaces:**

- `runPreflight({ mode, rootDir, expectedNodeVersion, expectedBranch, baselineCommit, baselineSourceCount, facts? }) -> Promise<PreflightResult>`；`facts` 仅供单元测试注入 `{ nodeVersion, branch, head, baselinePaths }`，生产 CLI 必须自行只读获取。
- `mode="baseline"` 要求 exact HEAD 与 418 个 baseline 根 Markdown。Task 1 的已完成
  acceptance 只覆盖 baseline preflight；`mode="incremental"` 的 shared-reader 接入、
  dynamic count 与 pointer-window failures 全部延后到 Task 5A，不再是 Task 1
  完成前置。Task 5A 必须复用 `tools/lib/cleaning-state.mjs`，不得在
  `git-baseline.mjs` 复制 pointer/catalog/report parser。
- 所有 Git 只读命令显式使用 `git --no-optional-locks`；status 精确使用 `--porcelain=v1 -z --untracked-files=all`，不能受本地 `status.showUntrackedFiles` 配置影响。
- CLI 成功测试必须使用隔离 fixture 和模块级 `preflightRunner` 依赖注入；生产 `tools/corpus.mjs` 不传入 runner，CLI 参数不得注入 `facts`、runtime 或 Git 状态。测试必须从仓库目录和任意外部 cwd 运行。

- [ ] 写失败测试，要求 runtime 不是 `v24.18.0` 时返回 `RUNTIME_VERSION_MISMATCH`，分支不是 `main` 时返回 `BRANCH_MISMATCH`，baseline mode 的 HEAD 或 418 个路径集合不符时返回 `BASELINE_MISMATCH`；Git 回归测试必须覆盖显式只读 flags 与未跟踪工作区冲突；CLI 成功与 strict config 测试不得依赖 live baseline 或启动 cwd。Incremental 的 dynamic 419、missing/invalid pointer 和 pointer-switch cases 改由 Task 5A 验收。

核心测试：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runPreflight } from "../tools/lib/git-baseline.mjs";

test("preflight rejects a wrong runtime", async () => {
  const result = await runPreflight({
    rootDir: ".",
    expectedNodeVersion: "v24.18.0",
    expectedBranch: "main",
    mode: "baseline",
    baselineCommit: "f876ce90d24ed486cae4060b1a4fe7b0813e9492",
    baselineSourceCount: 418,
    facts: {
      nodeVersion: "v26.0.0",
      branch: "main",
      head: "f876ce90d24ed486cae4060b1a4fe7b0813e9492",
      baselinePaths: Array.from({ length: 418 }, (_, index) => `${index}.md`)
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "RUNTIME_VERSION_MISMATCH");
});
```

- [ ] 运行测试并确认因模块不存在而失败：

```sh
rtk node --test tests/cli.test.mjs
```

预期关键输出：

```text
ERR_MODULE_NOT_FOUND
```

- [ ] 实现 `runPreflight()` 和只读 `preflight` CLI。
- [ ] `.nvmrc` 精确写入 `24.18.0`；`.npmrc` 写入 `engine-strict=true`。
- [ ] `package.json` 使用 `"type": "module"`、`"engines": {"node": "24.18.0"}`，只声明后续站点需要的精确依赖 `"markdown-it": "14.3.0"`；初始 scripts 精确包含 `"corpus": "node tools/corpus.mjs"` 与 `"test": "node --test"`，后续计划只在此基础上增加具名脚本。
- [ ] 在用户批准安装或已有兼容缓存后生成 `package-lock.json`；不得手写 lockfile。
- [ ] 再运行具名测试，要求 `preflight rejects a wrong runtime` 与
  `baseline preflight binds the full commit and exact path set` 均 PASS，且 `fail 0`。
  `incremental preflight accepts a dynamic catalog count` 已正式移入 Task 5A。
- [ ] 对真实仓库运行只读预检；当前 Node 不是 `v24.18.0` 时必须按预期失败并停止后续实现，不写报告文件：

```sh
rtk npm run corpus -- preflight --mode baseline --root . --config tools/config/corpus.json
```

## Task 2: Ignore Rules and Filesystem Safety

**Files:**

- Create: `.gitignore`
- Create: `tools/lib/fs-safety.mjs`
- Test: `tests/original-migration.test.mjs`

**Interfaces:**

- `assertInsideLocalRoot({ repoRoot, candidatePath }) -> Promise<void>`
- `assertNoSymlinkTraversal({ repoRoot, candidatePath }) -> Promise<void>`
- `publishNoClobber({ tempPath, destinationPath, expectedSha256 }) -> Promise<"created" | "same_hash">`

- [ ] 写失败测试，验证 `.local/`、`inbox/`、bundle、根层输入 Markdown 被忽略，而 `AGENTS.md`、`README.md`、`docs/`、`knowledge/`、`tools/`、`tests/` 和 `site/` 可公开。
- [ ] 写失败测试，验证任何目标路径必须位于仓库内的 `.local/`，拒绝 `/`、用户主目录、仓库根和符号链接逃逸。
- [ ] 写失败测试，验证 `publishNoClobber()` 在目标不同 hash、目标符号链接或目标于检查后出现时都返回 `DESTINATION_CONFLICT`，且不覆盖目标。
- [ ] 实现 `assertInsideLocalRoot()`、`assertNoSymlinkTraversal()` 和 `.gitignore`。
- [ ] 运行：

```sh
rtk node --test tests/original-migration.test.mjs
rtk git check-ignore --no-index -v .local/example.md inbox/example.md root-input.md
```

预期：

```text
.local/example.md ignored
inbox/example.md ignored
root-input.md ignored
named ignore and no-clobber tests PASS
fail 0
```

`AGENTS.md` 与 `README.md` 不被忽略由具名单元测试断言；不要用 `git check-ignore` 的预期退出码 1 作为手工成功步骤。

## Task 3: Source ID and Metadata Parser

**Files:**

- Create: `tools/lib/hash.mjs`
- Create: `tools/lib/source-id-key.mjs`
- Update: `tools/lib/source-id-key.mjs` in Task 5 to reuse `cleaning-state.mjs`
- Create: `tools/lib/source-id.mjs`
- Create: `tools/lib/url-canonicalizer.mjs`
- Create: `tools/lib/source-parser.mjs`
- Create: `tests/source-id.test.mjs`
- Create: `tests/source-parser.test.mjs`
- Create: six synthetic WeChat fixtures listed in File Map

**Interfaces:**

- `ensureSourceIdKey({ keyPath, backupPath, currentPointer }) -> Promise<{ key: Buffer, keySha256: string }>`；`currentPointer` 只在尚无首个 baseline run 时可为 null。
- `canonicalizeHttpUrl(input) -> string`：只允许 HTTP/HTTPS、拒绝 credentials、移除 fragment 与默认端口，保留 WHATWG URL 序列化后的 pathname 和 query 原顺序。
- `assertWechatSourceUrl(canonicalUrl) -> void`：要求 HTTPS 且 hostname 精确等于 `mp.weixin.qq.com`。
- `sourceIdForLocator({ privateKey, locatorType, locator }) -> { sourceId, locatorSha256 }`
- `parseWechatMetadata(raw) -> ParsedMetadata`

- [ ] 写失败测试，固定 opaque source ID 测试向量；没有本地 key 时，不能只根据 URL 推导 `source_id`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { sourceIdForLocator } from "../tools/lib/source-id.mjs";

test("source id requires the private key and matches the fixed vector", () => {
  const result = sourceIdForLocator({
    privateKey: Buffer.alloc(32, 0x11),
    locatorType: "url",
    locator: "https://mp.weixin.qq.com/s/synthetic-source"
  });
  assert.equal(result.sourceId, "src_da1f3403ad99e7c55172c7e3be20372c");
  assert.match(result.locatorSha256, /^[0-9a-f]{64}$/);
});
```

- [ ] 写失败测试，验证 key 使用 `0600`、两份 key hash 必须一致、目标不同 hash 不覆盖、仅缺一份时从另一份 no-clobber 恢复，以及不同 locator 的截断碰撞返回 `SOURCE_ID_COLLISION`。本 Task 只验收无 pointer 的首次 baseline key flow。Pointer-existing catalog read 与 `SOURCE_ID_KEY_LOST` 测试已正式移入 Task 5A；在共享 reader 存在前不再要求 Task 3 通过该验收。
- [ ] 写失败测试，覆盖标题、作者、原创状态、日期、地点、来源 URL、正文图片顺序和缺失字段。
- [ ] 写失败测试，验证 canonicalization 精确规则：host/scheme 小写、默认端口移除、fragment 删除、query 顺序保留；credentials、非 HTTP(S) 和微信导出中的非微信 host 被拒绝。
- [ ] 实现本节五个接口；代码库不得暴露任何无 key 的 URL→ID API。
- [ ] 实现元数据解析；字段缺失返回 `needs_review`，不补默认值。
- [ ] 运行：

```sh
rtk node --test tests/source-id.test.mjs tests/source-parser.test.mjs
```

预期：

```text
source id private-key tests PASS
URL canonicalization tests PASS
metadata and image-order tests PASS
fail 0
```

## Task 4: Conservative WeChat Cleaner

**Files:**

- Create: `tools/config/wechat-export-fingerprints.json`
- Create: `tools/config/confirmed-removals.json`
- Create: `tools/lib/wechat-cleaner.mjs`
- Test: `tests/wechat-cleaner.test.mjs`
- Update in Task 5: `tools/lib/wechat-cleaner.mjs`
- Update in Task 5: `tests/wechat-cleaner.test.mjs`

**Interfaces:**

- `cleanWechatExport(rawBytes, { fingerprints, confirmedRemovals, inputMode }) -> CleanWechatResult`
- `rawBytes` 只接受 `Buffer`/`Uint8Array`，返回值以 `outputBytes` 作为字节级权威结果；`cleanedMarkdown` 只在 fatal UTF-8 解码成功时非 null。
- `inputMode` 只允许 `"verified_baseline"` 或 `"incremental"`；baseline 值只能由完成 Gate 0 与 frozen manifest path/hash 复核的 corpus 编排层传入，不能暴露为 CLI 开关或根据文件外观推断。
- `confirmedRemovals` 使用 `canonical_url_sha256 + trimmed_line_sha256`，不得使用私有 source ID 或 CTA 原文。

- [ ] 把本计划 “Public and Private Contracts” 中的 exact fingerprint 与五条 exact confirmed removal 原样写入两个配置文件；实现后从真实基线只读复算并要求逐值相等，任何差异都停止并报告 `WECHAT_FINGERPRINT_BASELINE_MISMATCH`，不得临场修改配置。该专用错误码属于 Task 8 的全量 frozen-baseline verifier；Task 4 单来源 cleaner 的普通壳不匹配固定返回 `needs_review + WECHAT_FINGERPRINT_MISMATCH`。
- [ ] 写失败测试，验证完整匹配时删除首行 CSS/重复标题和末尾品牌卡/固定五图标操作栏。
- [ ] 写失败测试，验证以下内容全部保留：

```text
正式标题
作者日期地点
原文地址
正文图片
正文外链
列表和标题层级
非空行末尾两个空格
正文中包含“广告”或“推广”的案例
```

- [ ] 写失败测试，验证标题不符、footer 不符、普通 Markdown 均原样返回 `needs_review`，不能部分删除。
- [ ] 写失败测试，验证非 byte 输入抛 `TypeError`；无效 UTF-8、CRLF/裸 CR、未知 mode、任一 header 固定行错位或正文中伪造替代 metadata/URL 时，都逐 byte 返回原 `outputBytes`、`cleanedMarkdown` 为 null 或原严格解码 string、`changes=[]`。
- [ ] 写失败测试，验证 line 1 只能使用“五个空格 + line 3 完整标题 + 一个空格 + `\* {` CSS”的真实 wrapper，line 2/5/7、setext、位置化 metadata 和显示/目标一致的微信 URL 全部绑定；不得复用全文扫描 parser。
- [ ] 写失败测试，验证独立 `图N` 只有在同编号 `![图N](...)` 后直接出现，或只隔一条 exact empty physical line 时才删除；隔两条以上空行、whitespace-only 分隔行、不同编号或任何中间非空内容必须保留。冻结基线只读执行必须精确得到 207 条删除。
- [ ] 写失败测试，验证 CTA 只有按原始行两端 U+0020/HTAB 计算的 `canonical_url_sha256 + trimmed_line_sha256` 同时命中才删除；只命中其中一项必须原样保留，同一 pair 命中超过一次必须整份 no-op + `needs_review`。
- [ ] 写失败测试，覆盖原始 `[blank, confirmed CTA, blank]`：CTA 删除后两条原本不连续的 blank 可以折叠，但 `BLANK_LINE_NORMALIZATION_V1.sourceLines` 必须只列两条 blank 的原始行号，before hash 按这两个 raw line slices 拼接计算，不能把 CTA bytes 混入 normalize change。
- [ ] 写失败测试，验证同一份缺失终止 LF 的 synthetic 微信导出在 `inputMode="incremental"` 时逐 byte 原样 + `needs_review`，在 `inputMode="verified_baseline"` 且其余完整 fingerprint 命中时清理成功、`changes` 中记录且只记录一次 `EOF_NEWLINE_V1`/`append_eof`，输出末尾补且只补一个 LF；未知 mode 不得获得例外。Gate 0/path/hash 绑定与 CLI 不暴露 baseline mode 的编排测试归 Task 8，Task 4 不扩写 CLI。
- [ ] 测试用 synthetic CSS/footer 通过依赖注入的 test-only fingerprints；不得把真实文章段落复制进 fixture，也不得把 test-only hash 写入生产配置。
- [ ] 实现清理器的固定顺序：复制 raw bytes、fatal UTF-8 解码、校验 `inputMode` 与原始换行壳，再一次性验证固定 header/title/metadata/source URL/footer 全部 fingerprint；任一失败时返回原 `outputBytes`、空 `changes` 和 `needs_review`。`verified_baseline` 只改变“缺失终止 LF”这一项，不放宽其他 fingerprint。完整通过后先建立 original-line retained ledger 与正文 image tuple，再按 source line 从后向前应用 exact-hash deletes，然后做 NBSP、空白行和 EOF 规范化，最后按 ledger 逐行重新核对正式标题、metadata、ordered body images 与每一条保留非空行的 hard break；任何后置核对失败都丢弃候选并逐 byte 返回原输入。只有实际补齐基线 EOF 时记录一次 `EOF_NEWLINE_V1`/`append_eof`。
- [ ] Task 4 不接受或使用 `shortTextThreshold`，也不返回 `needs_ocr`；短正文、图片主导和 OCR 状态由 Task 8 在清理成功后处理。
- [ ] Task 5 开始前先为本节 exact `audit` schema 扩展 RED/GREEN tests：覆盖
  each-collection sorted/non-overlap、cross-collection containment、LF ownership、
  zero-length-allowed `body_output_span`、只在 body span 内排除 exact image token 后的
  `body_non_whitespace_code_points`、positive/sorted/unique `bodyImages.ordinal`、
  token/alt/URL hash binding、metadata/hard-break/ordered-image preservation、exact failure
  byte no-op，以及 successful zero-change 仍必须 non-null audit。Task 5 production code
  不得在这些 RED/GREEN 证据完成前使用 audit。
- [ ] 运行：

```sh
rtk node --test tests/wechat-cleaner.test.mjs
```

预期：

```text
complete fingerprint removal tests PASS
partial fingerprint no-op tests PASS
body preservation and confirmed-removal tests PASS
fail 0
```

## Task 5A: Shared-reader deferred integration acceptance

- [ ] 在 `tools/lib/cleaning-state.mjs` 落地后，将 Task 1 延后的 incremental
  preflight 接入同一 strict reader。Pass 1 使用 `selectedSourceIds:[]` 验证
  pointer/catalog/report 并取得完整 IDs；incremental empty catalog 返回
  `LOCAL_STATE_INVALID`。Pass 2 使用全部 IDs 验证全部 outputs，并要求两次
  `pointer_bytes` 逐 byte 相同。覆盖 dynamic 419、missing/invalid
  pointer/catalog/report/output、两次间 pointer drift 和 reader 内 pointer-window switch。
  Pass 2 的内部 `INVALID_CLEANING_INPUT` 归一为 pointer path 上的
  `LOCAL_STATE_INVALID`；其他 reader failure 保留，CLI expected/I/O 分别 exit 2/5。
- [ ] 将 Task 3 延后的 pointer-existing source-ID key-loss tests 接入同一 reader。
  `ensureSourceIdKey` exact API 改为 `{keyPath,backupPath,currentPointer}`；两份 key 缺失
  且 pointer 非 null 时，verified catalog 无论 non-empty/empty 都不得生成新 key，reader
  后复读仍缺失则返回 `SOURCE_ID_KEY_LOST`，reader failure 保留精确分类且 key 写入为零。
  `currentPointer:null` 只允许首次 baseline bootstrap；上层串行化首次 pointer publication，
  函数在 bootstrap 开始和每次 key publication 前复核 fixed pointer 缺失，stale/null race
  返回 `SOURCE_ID_KEY_RACE` 并停止后续发布。已 no-clobber 发布的 key 不做破坏性 scrub。
- [ ] Key leaf open 前必须 no-follow `lstat`，使用 `O_NONBLOCK|O_NOFOLLOW`，并在读取前
  验证 regular/identity/`0600`/exact 32-byte size；真实 FIFO/socket/device 与 post-check
  replacement 必须 fail closed 且不可阻塞。
- [ ] Task 1 baseline preflight 和 Task 3 no-pointer key flow 是已完成 scope；不再将
  本节 acceptance 回溯为 `cleaning-state.mjs` 存在前的前置要求。

## Task 5: Corpus Cleaner and Atomic Output

**Files:**

- Create: `tools/lib/json.mjs`
- Create: `tools/lib/cleaning-state.mjs`
- Create: `tools/lib/corpus-cleaner.mjs`
- Create: `tools/lib/clean-run-store.mjs`
- Create: `tests/corpus-cleaner.test.mjs`
- Update: `tools/lib/wechat-cleaner.mjs`
- Update: `tests/wechat-cleaner.test.mjs`
- Update: `tools/lib/git-baseline.mjs`
- Update: `tools/lib/source-id-key.mjs`
- Update: `tools/lib/cli.mjs`
- Update: `tests/cli.test.mjs`
- Update: `tests/source-id.test.mjs`
- Update: `tools/corpus.mjs`

**Interfaces:**

- `prepareCleaningPlan({ rootDir, inputEntries, additionSourceIds, cleanerVersion, runsRoot, currentPointer, stateMode, strict, cleanSource }) -> Promise<PrepareCleaningResult>`
- `stageCleaningRun({ rootDir, runsRoot, plan }) -> Promise<StageCleaningResult>`
- `publishCleaningRun({ rootDir, runsRoot, currentPointer, stagedRun }) -> Promise<PublishCleaningResult>`
- `cleanCorpus({ rootDir, inputEntries, additionSourceIds, cleanerVersion, runsRoot, currentPointer, stateMode, strict, apply, cleanSource }) -> Promise<CleanCorpusResult>`
- `readCurrentCleaningState({ rootDir, currentPointer, selectedSourceIds, readAdditionalArtifacts }) -> Promise<ReadCleaningStateResult>`
- `recoverInterruptedCleaningCommit({ rootDir, confirmation }) -> Promise<RecoveryCleaningResult>`

`inputEntries` 每项必须精确为：

```js
{
  source_id: "src_" + thirtyTwoHex,
  raw_bytes: Buffer | Uint8Array,
  source_kind: "baseline_markdown" | "markdown" | "url",
  locator_sha256: sixtyFourHex,
  original_path: string,
  ingest_status: "registered" | "duplicate" | "superseded",
  snapshot_version: positiveInteger,
  publication_policy: "local_only" | "public_metadata" |
                      "public_synthesis_redacted"
}
```

Input 中禁止 `prior_review_state`。`additionSourceIds` 必须按 ID 严格排序且
唯一。Incremental prepare 自己调用 shared reader；input ID set 必须精确等于
verified base ID set 与 explicit additions 的不相交并集，且 additions 精确是
input 中不在 base 的部分。遗漏/额外/错标 ID 返回
`SOURCE_SET_DISCONTINUITY`。Reviewer state 只从该内部 pointer window 的 verified
catalog 派生，不接受 caller assertion。

`cleanSource({ sourceId, rawBytes })` 必须返回 Task 4 完整 `CleanWechatResult`：
`status` 只为 `cleaned | needs_review`，并含 `outputBytes`、`cleanedMarkdown`、
`metadata`、`bodyImages`、`changes`、`warnings` 和 Task 4 authoritative `audit`。`cleanCorpus()`
只直接验证并消费这些字段；
不得调用 `parseWechatMetadata()` 重新解析输出，也不得用正文内的伪
metadata 覆盖位置化结果。重复 `source_id`、任一 input/result 合同无效、
cleaner 抛错分别返回 `DUPLICATE_SOURCE_ID`、`INVALID_CLEANING_INPUT`、
`INVALID_CLEANING_RESULT` 或 `CLEANER_FAILURE`；I/O 统一为 `CLEANING_IO_FAILURE`。
Expected failures 是值，pointer 不变。

`CleaningError` 是共享 closed failure：

```js
{ ok: false, error: {
    kind: "expected",
    code: "STRICT_CLEANING_FAILED" | "INVALID_CLEANING_INPUT" |
          "INVALID_CLEANING_RESULT" | "DUPLICATE_SOURCE_ID" |
          "SOURCE_SET_DISCONTINUITY" | "LOCAL_STATE_MISSING" |
          "LOCAL_STATE_INVALID" | "CLEANER_FAILURE" |
          "PLAN_BINDING_MISMATCH" | "STAGING_CONFLICT" | "RUN_CONFLICT" |
          "CLEANING_COMMIT_LOCKED" | "STALE_POINTER_TRANSITION" |
          "RECOVERY_CONFIRMATION_REQUIRED" | "RECOVERY_OWNER_ALIVE" |
          "CLEANING_RECOVERY_LOCKED" | "RECOVERY_TARGET_CHANGED" |
          "RECOVERY_UNRESOLVED_TARGET" | "RECOVERY_TARGET_AMBIGUOUS",
    path: string | null,
    source_id: ("src_" + thirtyTwoHex) | null,
    persistent_writes_occurred: boolean
  }
} |
{ ok: false, error: {
    kind: "io",
    code: "CLEANING_IO_FAILURE",
    operation: string,
    path: string | null,
    persistent_writes_occurred: boolean
  }
}
```

Prepare/stage/publish/read/recovery 各有独立 success payload，不再共用 generic
result：

```js
PrepareCleaningResult =
  { ok: true, value: { kind: "prepared", plan: CleaningPlan,
                       persistent_writes_occurred: false } } | CleaningError

StageCleaningResult =
  { ok: true, value: { kind: "staged", staged_run: StagedRun,
                       persistent_writes_occurred: boolean } } | CleaningError

PublishCleaningResult =
  { ok: true, value: {
      kind: "published" | "already_current",
      plan_manifest_sha256: sixtyFourHex,
      run_sha256: sixtyFourHex,
      desired_pointer: CurrentCleaningPointer,
      registered_source_count: nonNegativeInteger,
      persistent_writes_occurred: boolean
  } } | CleaningError

ReadCleaningStateResult =
  { ok: true, value: CurrentCleaningState } | CleaningError

RecoveryCleaningResult =
  { ok: true, value: {
      kind: "recovered" | "stale_lock_retired" |
            "terminal_cleanup_completed" | "no_unresolved_target",
      selected_target_commit_lock_sha256: sixtyFourHex | null,
      current_fixed_commit_lock_sha256: sixtyFourHex | null,
      active_lease_path: string | null,
      final_pointer: CurrentCleaningPointer | null,
      transition_record_path: string | null,
      commit_lock_cleanup: "unlinked_and_fsynced" | "already_absent" |
                           "not_applicable",
      persistent_writes_occurred: boolean
  } } | CleaningError
```

`CleaningPlan` 与 `StagedRun` 精确为：

```js
CleaningPlan = {
  manifest: CleaningPlanManifest,
  manifest_sha256: sixtyFourHex,
  artifacts: ReadonlyArray<{
    relative_path: string, sha256: sixtyFourHex,
    size_bytes: nonNegativeInteger, bytes: Buffer
  }>
}

StagedRun = {
  plan_manifest: CleaningPlanManifest,
  plan_manifest_sha256: sixtyFourHex,
  run_sha256: sixtyFourHex,
  staging_path: ".local/tmp/cleaning-<plan_manifest_sha256>",
  final_run_path: ".local/cleaned/runs/<run_sha256>",
  artifact_manifest: CleaningPlanManifest["artifact_manifest"]
}
```

Stage 只消费 exact prepared plan，返回携带同一 manifest/hash 与 derived
paths 的 verified staged run。Publish 只消费 staged plan，不采样新 prior。Clean CLI
对 success/expected/IO 为 0/2/5；recovery 缺确认串为 4，其他为 2/5。

`CleanCorpusResult` success 只为 `{kind:"dry_run",summary:DryRunSummary}` 或
`{kind:"published"|"already_current",publication:PublishCleaningResult["value"]}`。
`DryRunSummary` 精确包含：`base` 的 expected prior pointer object/hash、prior
run/catalog/report hashes 和 sorted full prior IDs；plan/run hashes；按 source ID 排序的
`{source_id,cleaning_status,processing_status,raw_sha256,cleaned_sha256,audit_sha256,
warning_codes}`；按 path 排序的 artifact `{relative_path,sha256,size_bytes}`；
desired pointer object/hash；registered count；按
`[code,path??"",source_id??"",detail_sha256]` 排序的 exact conflict records；以及
`persistent_writes_occurred:false`。CLI 不输出 plan/artifact bytes。

每个 run 必须自包含：

```text
.local/cleaned/runs/<run_sha256>/sources/<source_id>.md
.local/cleaned/runs/<run_sha256>/catalog/sources.jsonl
.local/cleaned/runs/<run_sha256>/cleaning-report.json
```

`RunPreimage` 是 run identity 的唯一语义输入，精确为：

```js
{
  schema_version: "1.0.0",
  cleaner_version: string,
  sources: Array<{
    source_id: "src_" + thirtyTwoHex,
    source_kind: "baseline_markdown" | "markdown" | "url",
    locator_sha256: sixtyFourHex,
    original_path: string,
    raw_sha256: sixtyFourHex,
    cleaned_relative_path: "sources/<source_id>.md",
    cleaned_sha256: sixtyFourHex,
    title: string | null,
    author: string | null,
    original_status: string | null,
    published_at: string | null,
    location: string | null,
    source_url: string | null,
    body_image_urls: string[],
    content_mode: "text" | "mixed" | "image_dominant",
    ingest_status: "registered" | "duplicate" | "superseded",
    cleaning_status: "cleaned" | "needs_review",
    processing_status: "new" | "cleaned" | "needs_review" | "ready" |
                       "needs_ocr" | "needs_medical_review",
    cleaner_version: string,
    snapshot_version: positiveInteger,
    publication_policy: "local_only" | "public_metadata" |
                        "public_synthesis_redacted",
    review_state_owner: "mechanical" | "reviewer",
    review_state_version: nonNegativeInteger,
    review_state_bound_raw_sha256: sixtyFourHex,
    review_state_bound_cleaned_sha256: sixtyFourHex,
    review_state_bound_audit_sha256: sixtyFourHex | null,
    review_state_bound_cleaner_version: string,
    audit: CleanWechatAudit | null,
    audit_sha256: sixtyFourHex | null,
    changes: CleanWechatResult["changes"],
    warnings: string[]
  }>
}
```

`sources` 按 `source_id` 严格排序且唯一。它包含生成 catalog/report 的每个
非派生语义字段，包括 reviewer carry-forward state、Task 4 audit、changes 和
warnings。`audit` 在且仅在 `cleaning_status="cleaned"` 时非 null，
`audit_sha256` 是其 canonical hash。只排除依赖最终 run ID 才能产生的值：catalog `cleaned_path`、
report `run_sha256`、pointer paths/hashes。`run_sha256 = SHA256(canonicalBytes(RunPreimage))`。
然后才用该 ID 渲染 output/catalog/report 路径。Catalog 是 RunPreimage source 的纯投影，
只额外派生 `.local/cleaned/runs/<run_sha256>/<cleaned_relative_path>`；report 精确为
`{ schema_version: "1.0.0", run_sha256, run_preimage: RunPreimage }`。两者不得接受独立语义输入。
因此 Task 8 classification/review state 变化必然改变 RunPreimage 和 run ID，不会与
旧 immutable run 冲突。Task 5 直接验证并消费 Task 4 `audit`；不重放
physical ledger、不重解析 output。Mechanical `content_mode` 仅按 audit：零 image
ordinals 为 `text`，一个或以上为 `mixed`；`audit.body_non_whitespace_code_points=0`
只是 Task 8 候选，Task 5 不发起 `image_dominant`、`needs_ocr` 或 `ready`。

Prepare 产生 immutable `CleaningPlan={manifest,manifest_sha256,artifacts}`；其 canonical
manifest 精确为：

```js
CleaningPlanManifest = {
  schema_version: "1.0.0",
  state_mode: "initial_verified_baseline" | "incremental",
  expected_prior_pointer: CurrentCleaningPointer | null,
  expected_prior_pointer_sha256: sixtyFourHex | null,
  prior_run_sha256: sixtyFourHex | null,
  prior_catalog_sha256: sixtyFourHex | null,
  prior_report_sha256: sixtyFourHex | null,
  prior_source_ids: ("src_" + thirtyTwoHex)[],
  run_preimage: RunPreimage,
  artifact_manifest: Array<{
    relative_path: string, sha256: sixtyFourHex,
    size_bytes: nonNegativeInteger
  }>,
  desired_pointer: CurrentCleaningPointer,
  desired_pointer_sha256: sixtyFourHex,
  registered_source_count: nonNegativeInteger
}
```

`prior_source_ids`/artifact manifest 分别按 ID/path 严格排序且唯一。Artifact
bytes 只在 prepared in-memory plan 携带，manifest 只绑定 path/hash/size。Initial
mode 的 prior pointer/identities 全为 null 且 prior IDs 为空；incremental 必须绑定
shared-reader pointer-before 的 exact object/raw-bytes hash、run/catalog/report identities 和
完整 prior source set。Stage/publish 传递同一 manifest/hash；P0 plan 在 P1/P2
之后只能 `STALE_POINTER_TRANSITION`。

Pointer schema 固定为：

```json
{
  "schema_version": "1.0.0",
  "run_sha256": "64 lowercase hex",
  "run_path": ".local/cleaned/runs/<run_sha256>",
  "catalog_path": ".local/cleaned/runs/<run_sha256>/catalog/sources.jsonl",
  "catalog_sha256": "64 lowercase hex",
  "report_path": ".local/cleaned/runs/<run_sha256>/cleaning-report.json",
  "report_sha256": "64 lowercase hex"
}
```

- `run_sha256` 的 canonical record 精确为上述 `RunPreimage`。Canonical JSON 递归排序 object keys、保留 array 顺序、拒绝
  `undefined`、non-finite number、BigInt、function、symbol 或 circular value，并写一个
  终止 LF。Catalog JSONL 每项写 canonical object 加 LF；report 和 pointer 也都是
  canonical JSON 加且只加一个终止 LF。
- Pointer 只允许上述七个字段。`run_path`、`catalog_path`、`report_path`
  必须精确派生；绝对路径、`..`、symlink、替代名称或旧固定路径均为
  `LOCAL_STATE_INVALID`。
- `tools/lib/cleaning-state.mjs` 独占 pointer/catalog/report validator。Pointer 必须是
  exact seven-field canonical JSON bytes。Catalog 每行必须是上述 exact catalog schema 的
  canonical JSON object + LF，整体按 `source_id` 严格递增且唯一，不允许
  blank line/unknown key/non-canonical bytes。Report 必须是 exact
  `{schema_version,run_sha256,run_preimage}` canonical JSON + one LF，RunPreimage 满足
  上述 exact schema。Reader 必须重算 RunPreimage hash 等于 pointer/report run ID；
  catalog/report source ID set、count、每个非派生 semantic field 一致。Pointer-selected
  catalog row 是 report source 的唯一纯投影：删除 `cleaned_relative_path`、`audit`、
  `changes`、`warnings`，增加 `schema_version:"1.0.0"`，并由 run ID 与
  `cleaned_relative_path` 派生 `cleaned_path`；这一定义取代本计划更早版本对当前 run
  catalog 的 nullable/`fetch_failed` 解释。只有 `selectedSourceIds` 指定的 output 才被
  打开、读取、验证 regular non-symlink identity/hash 并返回；要求全量 output 验证的
  caller 必须显式传入完整 source ID 列表。Pointer catalog/report hash 一致。
- `readCurrentCleaningState()` 在 pointer-before 后，用 `O_NOFOLLOW` 打开并保留
  file handles，在读前/后 `fstat` 核对 regular file、`dev`、`ino`、size 和 link count，
  并验证 path identity 未换。`selectedSourceIds` 指定必须在 pointer window 内读完、
  hash 验证并返回的 selected outputs；它必须是按 source ID 严格递增且唯一的数组。
  Core artifact 上限固定为 pointer 64 KiB、catalog 64 MiB、catalog 每条物理行
  （包含其必需的终止 LF）1 MiB、report 256 MiB、每个 selected output 64 MiB、
  selected outputs 合计 1 GiB。每个上限先用稳定 `fstat.size` 检查，再分配/读取 bytes。
  Selected set 必须使用低 FD 两阶段：第一阶段逐个 open/stat/path+ancestor identity
  revalidate/close，保存 facts 并在任何 selected content read 前完成 aggregate 检查；第二
  阶段逐个 reopen，要求 facts 与第一阶段完全相同，再 read/hash/close。不得为整个 set
  同时持有每个 path 的完整 ancestor/leaf handles。
  `readAdditionalArtifacts` 只能在同一 window
  内调用 reader 提供的 `readVerifiedArtifact({ repoRelativePath, expectedSha256,
  maxBytes })`；`maxBytes` 必须是正整数且不超过 64 MiB，每个 path 使用同样
  no-follow/identity/hash 验证，最多 1024 个、合计最多 1 GiB。Callback 完全 await 后才读
  pointer-after；前后 raw bytes 不同则丢弃全部 bytes 并返回 `LOCAL_STATE_INVALID`。
  `CurrentCleaningState` 精确为 `{ pointer_bytes, pointer, catalog_bytes,
  catalog_entries, report_bytes, report, selected_output_bytes, additional_result }`；其中
  `selected_output_bytes` 是按 `source_id` 严格递增迭代的
  `ReadonlyMap<string, Buffer>`，运行时只暴露只读 Map 查询/迭代能力且不暴露
  `set`、`delete`、`clear`，不返回任何未验证 bytes。Pointer、catalog、report、
  requested output 或 additional artifact 缠绕窗口内消失返回 `LOCAL_STATE_MISSING`；
  schema/hash/path/symlink/non-regular/identity/size/line-limit 违规或 pointer switch 返回
  `LOCAL_STATE_INVALID`。
- Reader 参数 shape/type 错误、非递增/重复/格式错误的 `selectedSourceIds`、非 function
  callback 或 malformed `readVerifiedArtifact` request 是 programmer misuse，抛
  `TypeError`。格式合法但不在 verified catalog/report 的 selected source 返回
  `INVALID_CLEANING_INPUT` 并携带该 `source_id`。省略 selected IDs 等价 `[]`；省略
  callback 时 `additional_result=null`。Callback 自身 throw/reject 原样抛出；其返回后
  capability 立即失效，后续调用抛 `TypeError` 且 `code="READ_WINDOW_CLOSED"`。
- Caller 提供的 additional `repoRelativePath`/hash/maxBytes 若不是 exact shape 或 canonical
  repo-relative syntax（包括 absolute、backslash、NUL、empty/dot/dot-dot segment），抛
  `TypeError`；`currentPointer` 可以是 absolute 或 repo-relative string，但 resolve 后不是
  exact `<root>/.local/state/current-cleaning.json` 也抛 `TypeError`。相反，pointer/report
  内持久化 path 语法或派生关系错误，以及 syntax 合法的 caller path 在磁盘实际遇到
  symlink、replacement、non-directory ancestor 或 identity escape，才返回
  `LOCAL_STATE_INVALID`。
- Callback settle 后，reader 必须按 issuance index await 所有已经签发但未被 caller await
  的 additional reads。任一 reader-owned local-state/IO failure 优先于 callback return/throw；
  多个 issued reads 失败时选择 issuance index 最小者。Callback throw 只在没有
  reader-owned failure 时原样抛出；cleanup `close` failure 只在没有既有 primary failure
  时成为 `CLEANING_IO_FAILURE(operation:"close")`。
- `rootDir` realpath confinement 下，Node-only traversal 对每个 ancestor 做 no-follow
  directory open/snapshot，leaf 使用 `O_NOFOLLOW`，并在 leaf 操作前后复核完整 ancestor
  `dev/ino` identity；这是检测并拒绝 replacement 的合同，不声称提供 Node path API
  不具备的 kernel `openat` guarantee。File `nlink` 必须为正且读前/后稳定，不要求
  等于 1。Pointer-before identity 保留到 pointer-after；即使 bytes 相同，pointer path
  换 inode 也为 `LOCAL_STATE_INVALID`。Failure `path` 使用 canonical repo-relative path；
  只有 source-specific 失败填 `source_id`。IO `operation` 只为
  `realpath|open|fstat|read|lstat|close`。
- 每个 leaf 在 `open` 前先 `lstat` 并拒绝 symlink/non-regular；leaf open flags 还必须包含
  `O_NONBLOCK`，使检查后被竞态替换为 FIFO/socket/device 时不会在 `fstat` 前阻塞，随后
  仍以 handle/path identity 返回 `LOCAL_STATE_INVALID`。
- Top-level `RunPreimage.cleaner_version` 必须等于每个 source 的 `cleaner_version`。
  Schema 层允许 empty `sources` 与 zero-byte catalog；需要非空 state 的 caller 在 B3
  自己收紧。Additional artifact 重复 path 按每次调用分别计数，实际 bytes 也逐次计入
  aggregate quota，不得以去重绕过限制。
- Shared reader 对全部 sources 验证 audit exact schema、canonical `audit_sha256`、数值边界、
  sorted/non-overlap/containment 和 persisted declaration cross-invariants；不打开 unselected
  output，也不声称重算其 output-token/source-side bytes。Selected output 只额外验证整文件
  `cleaned_sha256`。Audit 与 raw/output bytes 的逐 token binding 属于 prepare 生成阶段，
  由 RunPreimage identity 固化，不在 B2 reader 中重放。
- `metadata_spans` 六个 source spans 和六个 output spans 各自必须 pairwise non-overlap；
  `body_non_whitespace_code_points` 不得大于 body output span byte length 减去其中所有
  non-overlapping image output-token span byte lengths。`preserved:true` 不额外推出 metadata
  before/after hash 相等或 image source/output hash 相等；B2 不得以 producer 当前实现
  恰好相等为由增加未写入 schema 的 equality。
- 所有 Task 5 API 必须收到 `rootDir`。`rootDir` 的 realpath 定义仓库根，
  `runsRoot`、`currentPointer` 必须分别精确 resolve 到
  `.local/cleaned/runs`、`.local/state/current-cleaning.json`；StageIntent subtree/candidate
  只位于 `.local/tmp/cleaning-<plan_manifest_sha256>/`，artifact deterministic temps 只位于
  `.local/cleaned/runs/<run_sha256>/` 内且与对应 canonical artifact 同目录；
  transitions 只在 `.local/state/cleaning-transitions`，lock 只在
  `.local/state/cleaning-commit.lock`，recovery leases 只在
  `.local/state/cleaning-recovery-leases/<target_commit_lock_sha256>/` 的 exact target/root/child/temp
  topology。Persisted path 只允许 canonical POSIX repo-relative
  form，拒绝 absolute path、backslash、empty/dot/dot-dot segment、NUL 和 symlink traversal。
  `stateMode` 只为 `"initial_verified_baseline" | "incremental"`；前者只能由 Task 8
  Gate 0 + frozen manifest 内部 trust chain 传入，不得暴露 CLI override；后者必须
  先完成共享 strict state read。
- [ ] 写失败测试：三份输入生成自包含不可变 run、pure-projection catalog/report
  和 exact pointer；Task 8 classification-only 修改必须改变 RunPreimage/run ID。Shared reader
  覆盖 exact/canonical schema、sorted unique IDs、全部 cross-invariants、requested outputs、
  additional raw artifacts 与整个 consumer read window 内的 pointer switch。
- [ ] 写失败测试：同一输入运行两次，run SHA-256、全部文件 bytes 和 report
  完全一致；只在重新验证当前 catalog/report/每个 output hash 后第二次返回
  `already_current`。已有匹配但非当前 run 可复用，但 pointer commit 前不改变权威。
- [ ] 写失败测试：重复 ID、invalid input/audit/carry-forward、cleaner throw、I/O、
  run conflict、lock contention、stale publisher、pointer rename 前后 crash、owner-alive recovery、
  stale recovery 与 exact prior/desired recovery，并核对每个 result discriminator 与 CLI 0/2/4/5。
- [ ] `needs_review` 是 handled result。`strict=true` 时任一该结果返回
  `STRICT_CLEANING_FAILED`、`persistent_writes_occurred=false`；`strict=false` 时使用其精确
  `outputBytes` 与显式 `needs_review` 状态纳入。
- [ ] Dry-run 返回上述 exact base/source/artifact/pointer/conflict summary，
  `persistent_writes_occurred=false`，不创建或修改任何 directory、file、temp、
  commit/recovery lock、transition record 或 pointer，CLI 不暴露 artifact bytes。
### Task 5 implementation B5: durable single-writer staging

B5 只创建 `tools/lib/clean-run-store.mjs`；只有复用现有 pointer schema/path validator
确有需要时，才允许在 `tools/lib/cleaning-state.mjs` 增加一个 pure pointer value
validator export。B5 将 B4 的整个 in-memory `CleaningPlan` 视为不可信输入，重新验证后
物化一个 immutable run，并返回 verified `StagedRun`。它不读取或修改 current pointer，
也不实现 B6 publish、B7 recovery、CLI apply 或真实语料清理。

调用方必须按 `(canonical rootDir, run_sha256)` 串行化 staging。同一 run 至多有一个
live staging actor 检查、删除、重建或发布 deterministic temps；即使不同 plan manifests
得到同一 run ID，也适用同一约束。Retry 只有在 orchestrator 已证明前一 staging actor
终止后，才可删除 recognized partial。B5 不增加 stage-owner lock，不承诺 overlapping
cross-process concurrent-staging safety；unknown 或 concurrently changing state 一律
fail closed。B6 commit locking 是独立的后续边界。

B5 唯一 production export 与 success result 精确为：

```js
stageCleaningRun({ rootDir, runsRoot, plan }) -> Promise<StageCleaningResult>

{
  ok: true,
  value: {
    kind: "staged",
    staged_run: {
      plan_manifest: CleaningPlanManifest,
      plan_manifest_sha256: sixtyFourHex,
      run_sha256: sixtyFourHex,
      staging_path: ".local/tmp/cleaning-<plan_manifest_sha256>",
      final_run_path: ".local/cleaned/runs/<run_sha256>",
      artifact_manifest: CleaningPlanManifest["artifact_manifest"]
    },
    persistent_writes_occurred: boolean
  }
}
```

返回的 plain objects/arrays 必须与 caller references 分离并 recursively frozen，不返回
artifact bytes；B4 plan 中 Buffer 的可变性不受信任。

Options 必须是在 plain non-Proxy object 上恰有 `rootDir`、`runsRoot`、`plan` 三个 own
data properties；`rootDir`、`runsRoot` 必须是 non-empty strings。Shape/type/accessor/Proxy
misuse 在任何 filesystem mutation 前抛 `TypeError`。`rootDir` 在 first await 前同步
realpath anchor；`runsRoot` 可采用 fixed repo-relative、requested-root absolute 或
canonical-real-root absolute 表示，但必须精确解析为 `.local/cleaned/runs`，否则抛
`TypeError`。调用开始后 retarget caller root symlink 不得移动 operation。所有 persisted
paths 都是 canonical POSIX repo-relative path，拒绝 backslash、NUL、absolute、empty、dot
或 dot-dot segment。Staging/final/canonical/temp paths 全由 B5 派生，不接受 loose caller path。

First await 前，B5 必须读取 own data descriptors、在不调用 custom iterator/accessor 的
前提下 snapshot dense arrays、拒绝 Proxies、复制每个 Buffer/Uint8Array，并
canonical-detach 所有 JSON values。Caller 在 invocation 后的 mutation 不得改变 operation。
确定性的 zero-write validation order 精确为：

1. options programmer misuse；
2. exact plan keys `manifest`、`manifest_sha256`、`artifacts`；
3. exact canonical `CleaningPlanManifest` schema；
4. `manifest_sha256 = SHA256(canonicalJsonBytes(manifest))`，不含 LF；
5. 通过 `compileCleaningStateArtifacts()` 编译 `manifest.run_preimage`；
6. 验证 initial/incremental prior bindings；
7. 验证 compiled desired pointer、pointer document hash 与 registered count；
8. 验证 exact sorted artifact manifest path/hash/size set；
9. 验证 exact sorted plan artifact path/hash/size set 与 copied bytes；
10. 验证 compiled catalog/report bytes 与全部 source output bindings。

步骤 2–10 任一失败只返回：

```js
{
  ok: false,
  error: {
    kind: "expected",
    code: "PLAN_BINDING_MISMATCH",
    path: null,
    source_id: null,
    persistent_writes_occurred: false
  }
}
```

所有 in-memory plan bindings 通过前，除同步 root realpath anchor 外不得调用 filesystem。
`cleaning-state.mjs` 仍是 RunPreimage、catalog、report、pointer schema 的唯一 owner；若 B5
需要 pure pointer validator，只增加一个复用 reader private pointer validator 的
side-effect-free export，不在 `clean-run-store.mjs` 复制 seven pointer keys 或 path derivation。

Initial mode 要求 expected prior pointer、其 hash、prior run/catalog/report identities 全为
null，prior IDs 为空。Incremental mode 要求 non-null valid expected pointer、其包含唯一 LF
的 canonical document hash、与 pointer 相等的 prior run/catalog/report identities，以及
sorted unique prior IDs；producer contract 允许 empty prior ID set。Compiled desired pointer
必须与 manifest pointer byte-for-byte 相同，hash 包含 pointer document 的唯一 LF；registered
count 等于 RunPreimage source count。

Artifact set 精确为每个 sorted RunPreimage source 的
`sources/<source_id>.md`、`catalog/sources.jsonl` 与 `cleaning-report.json`；entries 以 ASCII
排序且唯一。每个 source artifact hash 等于其 `cleaned_sha256`；catalog/report bytes、hashes、
sizes 等于 shared compiler outputs；每个 plan artifact 的 hash/size 等于 copied bytes 和 exact
manifest entry，不得缺少或增加 entry。

Canonical intent path 精确为：

```text
.local/tmp/cleaning-<plan_manifest_sha256>/intent.json
```

`StageIntent` 精确为：

```js
{
  schema_version: "1.0.0",
  record_kind: "staging_intent",
  plan_manifest: CleaningPlanManifest,
  plan_manifest_sha256: sixtyFourHex,
  run_sha256: sixtyFourHex,
  staging_path: ".local/tmp/cleaning-<plan_manifest_sha256>",
  final_run_path: ".local/cleaned/runs/<run_sha256>",
  artifact_intents: Array<{
    relative_path: string,
    canonical_path:
      ".local/cleaned/runs/<run_sha256>/<relative_path>",
    temp_path:
      ".local/cleaned/runs/<run_sha256>/<relative_path>.tmp-<sha256>.partial",
    sha256: sixtyFourHex,
    size_bytes: nonNegativeInteger
  }>
}
```

`artifact_intents` 按 `relative_path` ASCII 排序且唯一，所有值均从 verified plan 派生。
`intent.json` bytes 精确为 `canonicalJsonDocumentBytes(StageIntent)` 并只有一个 terminal LF；
intent file SHA-256 包含该 LF。Deterministic same-directory intent candidate 精确为：

```text
.local/tmp/cleaning-<plan_manifest_sha256>/
  intent.json.tmp-<intent_file_sha256>.partial
```

每个 artifact temp 位于其 final canonical artifact 旁：

```text
<canonical-path>.tmp-<artifact_sha256>.partial
```

New private temp files 使用 mode `0600`，new directories request mode `0700`。Existing exact
regular artifacts 不仅因 mode 更宽而被拒绝，但 symlink/nonregular/identity/link-count
violation 一律 fail closed。

State machine 精确为：

```text
ABSENT -> INTENT_FSYNCED -> TEMPS_WRITTEN ->
CANONICAL_PUBLISHED -> RUN_VERIFIED
```

In-memory validation 后、任何 mutation 前，stable no-follow preflight 的顺序精确为：

1. target staging subtree；
2. target final-run subtree；
3. 各 subtree 内按 canonical repo-relative path 的 ASCII 顺序检查 entries。

Target staging directory 只允许 absent、empty、exact `intent.json`、exact deterministic intent
candidate，或 exact intent 与其 recognized candidate residue 并存。任何其他 name、symlink、
non-directory target、noncanonical/mismatching intent 或 invalid candidate 都是
`STAGING_CONFLICT`。Target final run 只允许 artifact manifest 要求的 exact parent
directories、exact canonical artifacts 与 exact deterministic artifact temps；extra name、
symlink、nonregular leaf、conflicting directory、invalid canonical 或 invalid temp 都是
`RUN_CONFLICT`。`.local/tmp` 与 `.local/cleaned/runs` 下属于其他 manifest/run hashes 的
siblings 不属于 target subtree，不算 extra。

没有 durable exact canonical intent 时，partially materialized final run 或任何 artifact
temp 未获授权，必须在 mutation 前返回 `RUN_CONFLICT`。Complete exact final run 且无 temps
可以复用：先发布缺失的 exact intent，再重验 run 并返回 staged。Intent 发布前 absent 或
empty final run 合法。只有 recognized intent candidate 而没有 canonical intent，不授权 final
partial state。Missing-intent adoption 期间，exact deterministic intent candidate 为 empty、
strict planned prefix 或 full，仅在 final run 仍 complete exact 且无 artifact temp 时才是
accepted crash prefix。Retry 按 normal intent publication protocol 重验并重建或复用
candidate、发布 exact intent、重验 complete run。该 adoption 例外绝不授权 partial final run。
Exact durable intent 存在后，才可 resume missing、prefix-temp、full-temp、
canonical-prefix 或 canonical-plus-recognized-residue state；canonical content 永不删除或覆盖。

Ancestor `.local`、`.local/tmp`、`.local/cleaned`、`.local/cleaned/runs` 的 symlink、
non-directory 或 identity escape 是 `LOCAL_STATE_INVALID`；target staging directory conflict 是
`STAGING_CONFLICT`；target final-run 或 required final subdirectory conflict 是
`RUN_CONFLICT`。Expected failure 的 `source_id` 恒为 null，`path` 是第一个 canonical
repo-relative offending path。优先级为 plan mismatch 高于一切 filesystem issue，staging
conflict 高于 final-run conflict，同类 conflict 以 ASCII path order 决定。

Directories 必须 component-by-component 用 non-recursive `mkdir` 创建，每次成功后立即
fsync parent directory。Existing directory 使用 `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` 打开、
`fstat`，并与 no-follow path identity 比较；每个 child operation 前后都重验 parent identity。
Existing leaf 先 `lstat`，再以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开，验证 stable regular
file、positive stable link count，handle 读取后再验证 leaf/path/parent identity。FIFO/socket/
device race 不得阻塞，必须映射为对应 namespace expected conflict，而不是泄漏 platform exception。

Intent publication 的 durability order 精确为：

```text
create deterministic candidate with O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW
-> complete positional writes
-> fstat regular/size/link facts
-> file sync
-> handle/path/parent/hash proof
-> hard-link candidate to intent.json without clobber
-> fsync staging directory
-> prove same inode and exact bytes
-> unlink only the proven candidate
-> fsync staging directory again
```

在已确认的 single-writer precondition 下，empty 或 strict planned prefix candidate 只有在
stable no-follow inode/link-count/parent proof 后才可删除并重建；full exact candidate 可复用；
non-prefix、changing、symlink 或 nonregular candidate 永不删除。

Intent durable 后才创建 missing final-run directories。必须按 artifact path order 先准备全部
missing artifact temps，再发布任何 new canonical artifact，使 `TEMPS_WRITTEN` 成为真实 global
state；已存在的 exact canonical artifact 不需要 temp。每个 new/rebuilt artifact temp 使用与
intent candidate 相同的 create/write/file-sync/handle-path-parent/hash proof。

全部 missing canonical 都有 exact full temp 后，才按 artifact path order 发布 missing canonicals：

```text
revalidate owned full temp and parent
-> hard-link temp to canonical without clobber
-> fsync artifact parent
-> prove canonical and temp are the same inode and exact planned bytes
-> unlink only the proven temp
-> fsync artifact parent again
```

Preflight 后出现 `EEXIST` 或 path/identity change 是 conflict；违反 single-writer precondition 的
overlapping actor 不解释为 idempotent winner。B5 不因补偿移除 canonical path。若 serialized
crash 后 exact canonical 与 recognized planned temp residue 并存，重验 canonical 与
prefix/full residue，只移除 non-authoritative residue 并 fsync parent；nonmatching residue 是
`RUN_CONFLICT` 且保持不动。

到 `RUN_VERIFIED` 时，staging directory 只能含 exact `intent.json`；final run 只能含 exact
required directories/canonical artifacts，不能有 temp。返回前重新 exact-tree scan，并对每个
artifact 做 stable full size/hash verification。Recognized post-link crash state 会重复 directory
fsync；fsync 本身不计 namespace/content mutation。

B5 可确定性 re-enter：

- staging 与 final 均 absent；
- empty staging directory，final absent/empty；
- intent candidate empty、strict prefix 或 full，final absent/empty；
- intent candidate empty、strict prefix 或 full，加 complete exact final run 且无 artifact temp，
  作为 missing-intent adoption crash prefix；
- exact intent，final absent 或只含 empty required directories；
- exact intent，planned artifact temps 为 empty/prefix/full，包括 zero-byte artifact；
- exact intent，exact canonical artifacts 已形成 prefix，其余 temps 为 full 或 prefix；
- exact intent，exact canonical 与 recognized temp residue 并存；
- exact intent 加 complete exact final run；
- complete exact final run 且没有 staging intent/temp。

B5 不 overwrite 或 recursive delete，并拒绝：

- 没有 durable matching intent 的 final partial/temp state；
- mismatching/noncanonical intent 或 missing/extra intent field；
- non-prefix/changing/symlink/nonregular intent 或 artifact temp；
- mismatching/symlink/nonregular canonical artifact；
- unexpected staging/final entry；
- conflicting target directory；
- 任意 identity drift 或 path replacement。

Expected failures 只使用 `PLAN_BINDING_MISMATCH`、`LOCAL_STATE_INVALID`、
`STAGING_CONFLICT`、`RUN_CONFLICT`，并保持 shared exact expected-failure shape。System I/O
failure 精确为：

```js
{
  ok: false,
  error: {
    kind: "io",
    code: "CLEANING_IO_FAILURE",
    operation: "realpath" | "lstat" | "open" | "fstat" | "read" |
               "readdir" | "mkdir" | "write" | "fsync" | "link" |
               "unlink" | "close",
    path: canonicalRepoRelativePathOrNull,
    persistent_writes_occurred: boolean
  }
}
```

Known symlink/nonregular/identity/race state 必须映射为 expected conflict，而非 I/O failure；
cleanup close failure 只有在此前没有 primary failure 时才能成为 primary。

`persistent_writes_occurred` 是 operation-wide sticky flag。第一次成功的 mutating syscall
即置 true：successful `mkdir`、successful `O_CREAT` temp creation（包括 zero-byte temp）、
successful write、link 或 unlink；cleanup 后也不恢复 false。Pure validation/read/fsync 为
false。Mkdir 成功后 fsync 失败为 true；移除 valid residue 后后续失败仍为 true；完整
already-staged run 仅 verify/fsync 返回 false；complete run 若需补发 missing intent 返回 true。

B5 synthetic test matrix 必须完整覆盖：

1. [ ] 只导出 complete B5 API；exact options misuse 与 fixed-path aliases；
2. [ ] B4 golden plan 产生 exact `StageIntent`、unique LF、intent hash/temp name、`StagedRun`、final bytes 与 path set；
3. [ ] empty corpus 与 zero-byte catalog/temp；
4. [ ] manifest/hash、mode/prior binding、run/pointer/hash/count、artifact path/order/missing/extra/hash/size/bytes、catalog/report/source projection、array descriptor/iterator/accessor/Proxy 与 post-call Buffer mutation；
5. [ ] plan mismatch 以 zero writes 优先于 staging/run conflicts；
6. [ ] staging absent/empty/intent exact，以及 intent candidate empty/prefix/full；
7. [ ] intent unknown key、no LF、extra LF、wrong bytes/name、symlink、FIFO、socket、nonregular、extra entry 与 conflicting directory；
8. [ ] 无 durable intent 的 final partial 被拒绝；无 intent 的 complete exact final 只有在发布 intent 后才可复用；missing-intent adoption 的 intent candidate durable states crash/retry 覆盖 empty/strict-prefix/full，且仅在 final run 保持 complete exact 且无 artifact temp 时接受；
9. [ ] artifact temp absent/empty/prefix/full，包括 zero-byte artifact；
10. [ ] 第一个 new canonical link 前，所有 required missing temps 已完整存在；
11. [ ] 每个 canonical publication prefix、exact canonical reuse 与 canonical-plus-valid-residue cleanup；
12. [ ] mismatching canonical/temp、extra final entry、conflicting directory、symlink、FIFO、socket 与 ancestor traversal failure；
13. [ ] exact completed second call 返回 staged 且 persistent writes 为 false；
14. [ ] first-conflict ordering 与 exact failure path/source shape；
15. [ ] first mutation 前后的 injected I/O operations，包括 later failure 时 sticky true 与 close-failure precedence；
16. [ ] representative durable boundaries 的真实 child-process crash/retry：directory creation、ordinary intent candidate sync/link/dir-sync/cleanup、complete exact no-artifact-temp final run 的 missing-intent adoption intent candidate write/sync/link/dir-sync/cleanup、artifact temp sync、canonical link/parent-sync/temp-cleanup 与 final verification；
17. [ ] root alias retarget 与 parent/leaf identity replacement races；
18. [ ] success values exact、detached、frozen；
19. [ ] serialization boundary 由 orchestration documentation/test 覆盖，tests 不声称 overlapping cross-process staging safety。

Tests 只使用 repository 外的 real synthetic temp directories，不读取 root Markdown 或
repository `.local`。Intent bytes/paths/hashes/result objects 的 expectations 独立推导。需要
crash/failure injection 时，用 child process 加 `syncBuiltinESMExports()` patch narrow Node
filesystem syscall boundary 后动态 import production code；不得增加 production test parameter
或 dependency-injection API。

### Task 5 implementation B6 publication and B7 recovery

- [ ] Cooperating publishers 不使用 lock-free CAS，也不宣称 Node rename 是 CAS。
  它们必须在 pointer mutation 前独占 `.local/state/cleaning-commit.lock`，并持有到
  pointer rename、state-dir fsync 与 completion record 完成。获取时先将完整 canonical
  lock intent 写入唯一 `.local/state/.cleaning-commit.<owner_pid>.<owner_nonce>.tmp`，
  fsync file，再以 atomic no-clobber hard-link 发布到固定 lock path，然后 fsync
  `.local/state`。发布者必须再以 no-follow/fstat 证明两个 path 为同一 inode，
  unlink 自己的唯一 temp 并再 fsync `.local/state`，固定 lock 仍持有该 inode。
  `CommitLockIntent` 精确含 `{schema_version:"1.0.0",owner_pid:positiveInteger,
  owner_nonce:thirtyTwoHex,plan_manifest:CleaningPlanManifest,
  plan_manifest_sha256:sixtyFourHex,expected_prior_pointer_sha256:sixtyFourHex|null,
  desired_pointer_sha256:sixtyFourHex,desired_pointer:CurrentCleaningPointer,
  run_sha256:sixtyFourHex}`。因为完整
  intent 在 hard-link 前已 fsync，不存在空锁窗口。Lock 已存在则返回
  `CLEANING_COMMIT_LOCKED`，不修改 pointer。
- [ ] Lock 内重读 current pointer：只有 plan 的 exact expected prior bytes 可提交；
  exact desired bytes 只在完整 selected-run verification 与该 commit-lock hash 绑定的
  stable completion 写入/验证后以 `already_current` 幂等返回；其他 bytes
  返回 `STALE_POINTER_TRANSITION` 且永不 rename。系统不创建 transition claim，
  claim 不是 recovery prerequisite。Pointer temp 写入/fsync 后只做
  atomic replace，再 fsync state dir；这是 lock-serialized commit，不是 CAS。正常路径
  只在 no-follow/fstat/inode/bytes 证明固定 lock 仍是自己的 intent 后 unlink，
  并 fsync state dir。
- [ ] Recovery 要求 exact `RECOVER_INTERRUPTED_CLEANING_COMMIT`，不要求 claim。它先用
  no-follow handle/path identity 打开 fixed commit lock，验证 exact canonical
  `CommitLockIntent`，并在任何 recovery write 前执行 `kill(intent.owner_pid,0)`。
  Success/`EPERM` 标记 owner alive；只读验证 historical targets 后返回
  `RECOVERY_OWNER_ALIVE` 与 `persistent_writes_occurred:false`。只有 `ESRCH` 可继续。若首次 gate 与 root
  publication 间创建了 recovery directories，root 发布前再做一次 gate。
  Target 是完整 canonical commit-lock file bytes（包含单一 terminal LF）的
  SHA-256；lease topology 只能是
  `.local/state/cleaning-recovery-leases/<target_commit_lock_sha256>/lease-root.json` 和
  `lease-after-<previous_lease_sha256>.json`。每个 node 最多一个 deterministic child；
  fork/alternate name/symlink/extra authoritative node 均无效。

- [ ] Recovery root 和 target-hash child 只能 non-recursive `mkdir`；success 后立即
  fsync parent。`EEXIST` 时用 `O_DIRECTORY|O_NOFOLLOW`/`fstat` 并比较
  no-follow path snapshot 的 `dev/ino`。持有 verified directory handles，每个 child
  operation 前后重验 parent identity。Mkdir 后、target/root 发布前 crash 是
  recognized partial state，retry 按原顺序 re-enter，不递归删目录。

```js
RecoveryTarget = {
  schema_version: "1.0.0", record_kind: "recovery_target",
  target_commit_lock_sha256: sixtyFourHex,
  target_commit_lock_bytes_base64: string
}
```

- [ ] Root lease 前先发布 target-dir `target.json`。Decoded bytes 必须精确是包含
  LF 的 commit-lock canonical bytes，hash 同时等于 field/directory basename，并解析为
  exact intent。Temp 是 `.target.<owner_pid>.<owner_nonce>.tmp`，以 complete
  write/file fsync/no-clobber hard-link/target-dir fsync/same-inode-bytes proof/
  own-temp unlink/dir fsync 发布。Existing target 只接受 exact bytes。Root 只在
  target durable + reverified 后发布。Target dir 只允许 target、root/single-successor
  nodes 和 recognized target/lease candidate temps，unknown entry fail closed。

```js
RecoveryLease = {
  schema_version: "1.0.0", record_kind: "recovery_lease",
  target_commit_lock_sha256: sixtyFourHex,
  previous_lease_sha256: sixtyFourHex | null,
  generation: nonNegativeInteger,
  owner_pid: positiveInteger,
  owner_nonce: thirtyTwoHex
}
```

- [ ] Root 必须 `previous_lease_sha256:null,generation:0`；child 必须绑定 exact
  parent canonical hash 且 generation + 1。`lease_sha256` 精确是包含单一
  terminal LF 的 canonical lease node file bytes SHA-256，它命名 child 并写入
  child `previous_lease_sha256`。Candidate temp 精确为
  `.lease-<root-or-previous-sha256>.<owner_pid>.<owner_nonce>.tmp`，写入顺序为
  `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` mode `0600` open -> complete bytes -> file fsync ->
  no-clobber hard-link node -> lease-dir fsync ->
  same-inode/bytes proof -> own-temp unlink -> lease-dir fsync。Lease nodes append-only，永不
  unlink/覆盖，existing candidate 不 truncate/覆盖。Own candidate 只在 path/inode/bytes
  和 node outcome 验证后清理。Other-owner candidate 只在 owner `ESRCH` 且 exact
  path/inode/bytes/link-count/parent identity 稳定时清理；success/`EPERM` 不动。
  Dead-owner 分别处理 node absent+link-count 1、node same inode、node different inode；三者
  只 unlink candidate，从不 unlink node，然后立即 fsync target dir。Target candidates
  使用相同 live/dead 与 absent/same/different-inode 规则。
- [ ] Losing candidate 读并验 winner。`kill(pid,0)` success/`EPERM` 为 alive，
  返回 `CLEANING_RECOVERY_LOCKED`；只有 `ESRCH` 允许 contenders 在唯一 child
  path 竞争下一 generation。Recovery 从 root 跟踪唯一 successor 到 tip。每次
  pointer mutation、terminal write 或 target unlink 前，caller 重验 target
  path/inode/bytes、full chain、tip PID/nonce 为自己，且 tip successor path 不存在。
  Successor 只能在 tip owner 被证明 dead 后创建。老 commit lock 在全部
  pointer/terminal writes 完成前保持存在。
- [ ] `TransitionCompletion`/`TransitionRetirement` 是 stable canonical audit evidence，
  不是 selection authority。Filenames 仍为
  `complete-<commit_lock_sha256>-<desired_pointer_sha256>.json` 和
  `retire-<commit_lock_sha256>-<observed_pointer_sha256-or-absent>.json`。

```js
TransitionCompletion = {
  schema_version: "1.0.0", record_kind: "completion",
  commit_lock_sha256: sixtyFourHex,
  plan_manifest_sha256: sixtyFourHex,
  expected_prior_pointer_sha256: sixtyFourHex | null,
  desired_pointer_sha256: sixtyFourHex,
  desired_pointer: CurrentCleaningPointer
}
TransitionRetirement = {
  schema_version: "1.0.0", record_kind: "retirement",
  plan_manifest_sha256: sixtyFourHex, commit_lock_sha256: sixtyFourHex,
  expected_prior_pointer_sha256: sixtyFourHex | null,
  desired_pointer_sha256: sixtyFourHex,
  observed_pointer_sha256: sixtyFourHex | null,
  reason: "stale_pointer"
}
```

Completion 与 retirement 都 actor-neutral。Publisher 与每个 recovery generation 对同一
commit attempt 生成 exact same bytes；同 plan 的第二 publisher 使用自己 commit hash/
completion path。

Record 写入顺序为 unique same-dir temp -> file fsync -> no-clobber hard-link ->
transitions-dir fsync -> same-inode verification -> own-temp unlink -> dir fsync；已存在
文件只在 exact canonical bytes 相同时幂等接受。
- [ ] Recovery entry 必须使用下列唯一 ordered state machine，不得重排或使用
  alternate ordering：

  1. 稳定 no-follow 读取 fixed commit path；若 present，将 exact file-byte hash 设为
     `current_target_sha256`，验证 intent 并在任何 write 前执行 original-owner gate；
     absent 则 `current_target_sha256=null`。
  2. 若 recovery root 存在则用 no-follow directory identity 打开/验证，再按
     bytewise basename order 扫描 direct 64-hex target directories。
  3. 对每个 basename 不等于 `current_target_sha256` 的 non-current directory，必须
     有 complete valid `target.json`、valid root-to-tip chain 和恰一 C-bound terminal。
     Missing target/root/terminal 为 `RECOVERY_UNRESOLVED_TARGET`；conflicting/malformed/
     forked/multiple outcome 为 `RECOVERY_TARGET_AMBIGUOUS` 或已定义的
     `LOCAL_STATE_INVALID`。Non-current target 永不获得 partial exemption。
  4. 只有 basename 等于 non-null `current_target_sha256` 的 directory 可以是以下
     ordered prefix：empty directory；只有 recognized `.target.*.tmp` 且 target absent；
     exact durable target + root absent（可带 recognized residues）；exact target + valid
     root-to-tip chain + terminal absent/exact。Unknown/malformed candidates、lease node
     without target/root、alternate node 或 target bytes 不等于 fixed lock 均 fail closed。
  5. 当 current owner alive，只读验证 current prefix，不 mkdir、publish target/root、
     clean candidate 或做其他 repair。所有 non-current targets 通过后返回
     `RECOVERY_OWNER_ALIVE` 与 `persistent_writes_occurred:false`。
  6. 当 current owner dead 且所有 non-current targets 通过，只能按
     `directories -> target.json -> root lease -> successor lease -> pointer/terminal ->
     target unlink -> state-dir fsync` re-enter current prefix；candidate cleanup 仍遵循
     已定 live/dead rules。
  7. `current_target_sha256=null` 时没有任何 partial exemption。Fixed C2 present 时只有
     C2 得到 exemption；不完整 C1 是 historical unresolved，且 C2 bytes 永不得用来
     完成 C1。

  Historical target C 只从它的 target bytes 派生 exact C-bound completion path/bytes，
  并只搜索 C-bound retirement。必须恰有一个 valid outcome。另一个 same-plan target 的
  completion 与 C 无关，不得制造 ambiguity。None 为 `RECOVERY_UNRESOLVED_TARGET`；
  both/multiple/malformed 为 `RECOVERY_TARGET_AMBIGUOUS`。
- [ ] Pointer outcome 和 matching terminal record 验证且 transitions-dir fsync 后，active
  tip 重做 ownership/target/successor-absence proof，unlink target commit lock，再 fsync
  `.local/state`，此后不再修改 pointer/terminal。Terminal 后 crash 的下一 generation
  只验证 existing stable record 并重试 unlink/fsync cleanup。Unlink 后、state fsync 前
  crash 的 retry 无论见 target present/absent 都只验证 terminal outcome 并完成 fsync。
  无 fixed commit lock 时，只在所有 historical target 都恰有一个 terminal 后先
  fsync `.local/state`，再返回 `no_unresolved_target`。检查 historical C1 时若
  fixed path 为不同 C2，C1 只验 terminal + fsync，绝不 unlink/mutate/recover C2。
  C2 只能经其自己 owner-death gate/target hash 处理。Current target 无 terminal + owner
  dead 才扩展 chain；owner alive 在 read-only historical validation 后 zero writes 返回
  `RECOVERY_OWNER_ALIVE`。Completed lease dirs 只是 audit evidence。
- [ ] `stateMode="initial_verified_baseline"` 在 pointer 不存在时可创建首 run；
  `stateMode="incremental"` 必须先得到有效当前状态。增量和 Task 8 review-only
  run 必须对每个来源执行 raw/cleaned/audit/cleaner-version four-way binding。
  只有本次清理成功且四项均等于 prior bindings 才保留 reviewer state；
  否则重置 mechanical owner/version，processing 依 cleaning result 为 `cleaned` 或
  `needs_review`。每个 new/reset mechanical source 精确序列化 owner `mechanical`、
  version 0，bound raw=current raw、bound cleaned=current cleaned、bound audit=current
  `audit_sha256`（仅 cleaning needs review 时 null）、bound cleaner version=current version。
  Reviewer-owned source 必须 version > 0、cleaning success、non-null audit/hash 与当前
  four-way equality，否则序列化上述 mechanical representation。Task 5 永不发起
  reviewer ownership。
- [ ] Recovery acceptance 必须具名覆盖：live original owner zero writes；root/target
  mkdir + parent fsync/no-follow identity 和各 crash re-entry；immutable `target.json`
  exact LF bytes/hash/publication；LF-inclusive lease hash；candidate O_EXCL/O_NOFOLLOW/0600；
  own/live/dead residue 与 dead-owner node absent/same/different-inode；bytewise historical scan；
  fixed absent/C2 isolation；unresolved/ambiguous terminal evidence；idempotent terminal cleanup。
- [ ] Ordered-entry acceptance 必须分别覆盖 current target 的 empty、temp-only、
  target-only、root-chain/no-terminal 与 root-chain/exact-terminal prefixes；同样 prefixes 作为
  non-current 时，empty、temp-only、target-only 与 root-chain/no-terminal 必须
  unresolved/invalid，而 root-chain/exact-terminal 必须作为完整 historical target 通过；
  alive owner 对 current prefix 只读零写；
  same-plan attempt A completion + attempt B retirement 对 B 不得 ambiguity；publisher
  `already_current`、recovery exact-desired 和 terminal cleanup 均使用 C-bound completion。
- [ ] 运行：

```sh
rtk node --test tests/corpus-cleaner.test.mjs
```

预期：

```text
versioned run determinism tests PASS
pointer atomicity and recovery tests PASS
strict no-publish tests PASS
fail 0
```

## Task 6: Verified Git Bundle Backup

**Files:**

- Create: `tools/lib/raw-backup.mjs`
- Create: `tests/raw-backup.test.mjs`
- Update: `tools/corpus.mjs`
- Generate locally: `.local/state/raw-baseline.json`

**Interfaces:**

- `createVerifiedRawBackup({ repoRoot, baselineCommit, bundlePath, manifestPath, expectedCount, apply, confirmation }) -> Promise<BackupResult>`
- `verifyExistingRawBackup({ repoRoot, bundlePath, manifestPath }) -> Promise<BackupVerification>`

- [ ] 写失败测试：错误 commit、损坏 bundle、已存在但内容不同的目标、缺少确认串都失败且不覆盖目标。
- [ ] 写通过测试：临时仓库的两份 Markdown 可打 bundle、`git bundle verify`、克隆到临时目录、恢复 commit 并逐文件核对 SHA-256。
- [ ] 真实创建前先验证 `refs/heads/main` 精确指向 baseline full OID；bundle 使用 `refs/heads/main` 作为可恢复 ref，而不是依赖裸短 SHA 作为 bundle tip。
- [ ] bundle 先写 `.local/tmp/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle.tmp`，完成 verify、临时恢复和 hash 比较后，以 no-clobber 方式发布；已存在同 hash bundle 进入幂等验证，不同 hash 返回 `BUNDLE_CONFLICT`。
- [ ] 只有 bundle 发布并再次验证成功后，才原子写 `.local/state/raw-baseline.json`。Manifest 按 path 排序，使用仓库相对路径，不包含绝对路径：

```js
{
  schema_version: "1.0.0",
  baseline_commit: "f876ce90d24ed486cae4060b1a4fe7b0813e9492",
  bundled_ref: "refs/heads/main",
  bundle_path: ".local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle",
  bundle_sha256: sixtyFourHex,
  source_count: 418,
  source_hashes: Array<{ path: string, sha256: string }>,
  verify_ok: true,
  restore_ok: true
}
```

- [ ] 先运行 dry-run：

```sh
rtk npm run corpus -- backup --baseline f876ce90d24ed486cae4060b1a4fe7b0813e9492 --bundle .local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle --manifest .local/state/raw-baseline.json --expect-count 418
```

预期：

```text
CONFIRMATION_REQUIRED
no_files_written=true
```

- [ ] 向用户展示基线、目标、恢复方式和 dry-run；获得 Gate 1 的备份部分确认。
- [ ] 执行：

```sh
rtk npm run corpus -- backup --baseline f876ce90d24ed486cae4060b1a4fe7b0813e9492 --bundle .local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle --manifest .local/state/raw-baseline.json --expect-count 418 --apply --confirm CREATE_VERIFIED_RAW_BUNDLE
```

- [ ] 独立运行验证并要求具名测试 `bundle restores the full commit and exact path hashes`、`different existing bundle is never overwritten`、`manifest is written only after restore verification` 均 PASS，且 `fail 0`：

```sh
rtk git bundle verify .local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle
rtk node --test tests/raw-backup.test.mjs
```

## Task 7: Original Migration with Recovery Gate

**Files:**

- Create: `tools/lib/original-migration.mjs`
- Create: `tools/lib/migration-journal.mjs`
- Test: `tests/original-migration.test.mjs`
- Update: `tools/corpus.mjs`
- Generate locally: `.local/state/migration-journal.jsonl`
- Generate locally: `.local/state/migration-report.json`

**Interfaces:**

- `planOriginalMigration({ repoRoot, destinationRoot, baselineManifest, journalPath }) -> Promise<MigrationPlan>`
- `applyOriginalMigration({ plan, confirmation }) -> Promise<MigrationReport>`
- `resumeOriginalMigration({ repoRoot, baselineManifest, journalPath }) -> Promise<MigrationReport>`

- [ ] 写失败测试：未验证 bundle、manifest 非 full SHA、源 path/hash 集合错误、manifest 外额外根 Markdown、目标 hash 冲突、符号链接、确认串错误均不删除任何源文件。
- [ ] 写通过测试：同 hash 目标视为幂等；在复制阶段或删除阶段模拟崩溃后，重跑 journal 可恢复，且任何时刻至少有一个已验证副本。
- [ ] 实现时只遍历 `raw-baseline.json.source_hashes` 的 418 条排序路径。`AGENTS.md` 与 `README.md` 是明确豁免的项目控制文档，不读取、不移动、不删除，也不计为未登记输入；除此之外，任何不在 baseline manifest 的根层 `*.md` 都返回 `UNREGISTERED_ROOT_INPUT`，要求先走 Task 11 摄取或由用户确认重新定基线。其他工作区文件同样不得读取、移动或删除。
- [ ] 每个来源执行固定状态机：

```text
PLANNED
  -> TEMP_WRITTEN_AND_FSYNCED
  -> DESTINATION_PUBLISHED_NO_CLOBBER
  -> DESTINATION_HASH_VERIFIED
  -> SOURCE_HASH_REVERIFIED
  -> SOURCE_UNLINKED
```

每个状态以一行 JSON 追加到 `.local/state/migration-journal.jsonl` 并 fsync。目标用临时文件写入后 exclusive/no-clobber 发布；不得用可能覆盖既有目标的 source→destination rename。只有 418 个目标全部达到 `DESTINATION_HASH_VERIFIED` 后才允许进入来源删除阶段。
- [ ] 删除每个来源前重新核对来源仍等于 baseline hash、目标等于同一 hash；任一变化立即停止。崩溃重跑时，来源缺失只在目标 hash 已验证且 journal 已记录时视为已完成。
- [ ] 实现 dry-run 报告：

```js
{
  source_count: 418,
  destination_existing_same_hash: number,
  destination_conflicts: 0,
  files_to_move: number,
  root_files_removed: 0,
  unregistered_root_inputs: 0,
  backup_verified: true,
  baseline_commit: "f876ce90d24ed486cae4060b1a4fe7b0813e9492"
}
```

- [ ] 运行 dry-run：

```sh
rtk npm run corpus -- migrate --source-root . --destination .local/original/baseline --baseline-manifest .local/state/raw-baseline.json --journal .local/state/migration-journal.jsonl --report .local/state/migration-report.json --dry-run
```

- [ ] 向用户展示 full SHA、bundle restore 结果、418 个目标 hash、额外根输入数、冲突数和恢复方式，并获得 Gate 1 的迁移确认。
- [ ] 执行：

```sh
rtk npm run corpus -- migrate --source-root . --destination .local/original/baseline --baseline-manifest .local/state/raw-baseline.json --journal .local/state/migration-journal.jsonl --report .local/state/migration-report.json --apply --confirm MOVE_BASELINE_RAW_MARKDOWN_TO_LOCAL
```

- [ ] 原子写 `.local/state/migration-report.json`，随后验证 manifest 中 418 个根路径全部不存在、`.local/original/baseline/` 中 418 个目标逐项匹配、journal 全部到达 `SOURCE_UNLINKED`。不得以“根目录所有 Markdown 为 0”验收，因为 `AGENTS.md` 与 `README.md` 必须保留。
- [ ] 运行具名测试 `migration selects only manifest paths`、`no-clobber destination never overwrites`、`journal resumes after every state`、`source is removed only after all destinations verify`，要求全部 PASS 且 `fail 0`：

```sh
rtk node --test tests/original-migration.test.mjs
```

## Task 8: Run the Real Cleaning Corpus

**Files:**

- Create: `.local/cleaned/runs/<run_sha256>/sources/<source_id>.md`
- Create: `.local/cleaned/runs/<run_sha256>/catalog/sources.jsonl`
- Create: `.local/cleaned/runs/<run_sha256>/cleaning-report.json`
- Create: `.local/state/current-cleaning.json`
- Create: `.local/state/cleaning-transitions/`
- Create: `.local/reviews/image-dominant-baseline.json`
- Create: `.local/state/source-id-key.bin`
- Create: `.local/backup/source-id-key.bin`

`<run_sha256>` 在这里描述运行时内容寻址目录；执行命令不手填该值，由 `clean --dry-run` 计算并在 JSON 输出中返回。

- [ ] 先创建并双份 no-clobber 保存 source ID key；只有两份 key hash 一致后才能登记首批 418 个来源。
- [ ] `clean` 编排必须先复核 Gate 0 已成功绑定冻结 full SHA 与精确 418 个根路径，再核对 `raw-baseline.json`、migration journal 和 `.local/original/baseline/` 仍是同一 418-path path/hash 集合；只有这些检查全部在同一验证链成功后，才对这些精确输入内部传入 `inputMode="verified_baseline"`。CLI 不得接受覆盖 mode 的参数，集合外输入永远使用 `"incremental"`。
- [ ] 写编排失败测试：错误 baseline commit、不是精确 418-path 集合、任一路径/hash 不一致或尝试从 CLI 传入 baseline mode 时，都不得调用 cleaner 的 `verified_baseline` 分支；应返回对应 baseline mismatch，且不发布 cleaning run。
- [ ] 实现只读 `verifyWechatBaselineFingerprints()`：只接收 Gate 0 已绑定的 frozen manifest 与对应 raw bytes，逐项验证 header/footer、固定 header 语法和五条 confirmed removal 各命中一次；只输出计数、hash 匹配与稳定错误码，不输出文章正文、URL、CTA 或私有 locator。任一差异返回 `WECHAT_FINGERPRINT_BASELINE_MISMATCH`，不得修改生产配置。
- [ ] 在真实资料上执行 strict dry-run；任何未知壳进入 `needs_review` 并阻止 strict apply。
- [ ] 对未知项只扩展 fixture 和明确规则，不叠加模糊 patch。
- [ ] dry-run：

```sh
rtk npm run corpus -- clean --input .local/original/baseline --runs-root .local/cleaned/runs --current-pointer .local/state/current-cleaning.json --key .local/state/source-id-key.bin --strict --dry-run
```

- [ ] 展示 dry-run 的 run SHA、逐来源状态和冲突；确认无未知壳后 apply：

```sh
rtk npm run corpus -- clean --input .local/original/baseline --runs-root .local/cleaned/runs --current-pointer .local/state/current-cleaning.json --key .local/state/source-id-key.bin --strict --apply
```

- [ ] Pointer 发布后，通过 `readCurrentCleaningState()` 验证并读取被选
  `cleaning-report.json`。每条来源必须包含 Task 5 report schema 的 raw/cleaned SHA-256、
  metadata-preserved flags、按 ordinal 排序的 `{ alt_sha256, url_sha256 }` 图片对、
  保留行 hard-break 检查和 removal ledger。真实语料逐来源自动比较，不只比较总数。
- [ ] 从冻结的 418-path baseline manifest 中筛出 metadata 品牌精确等于 `认知结构` 的 25 条，展示完整路径、source ID、URL hash、`audit.body_non_whitespace_code_points` 与图片数供人工核对，然后一次性写入 `.local/reviews/image-dominant-baseline.json`。该文件保存 25 个 frozen source ID、确认理由和 positive `review_version`；Task 8 必须基于已验证当前 run 生成完整新 RunPreimage，对命名集合写 reviewer-owned `image_dominant`/`needs_review|ready|needs_ocr|needs_medical_review`、version 和 bound raw/cleaned/audit/cleaner-version 四项，未修改来源也只能按 exact four-way binding carry forward，并以 prepared-plan + lock-serialized pointer transition 提交。Classification-only 变更必须产生新 run ID。
- [ ] `shortTextThreshold` 只存在于 Task 8 编排层；它只读 Task 4 authoritative `body_non_whitespace_code_points`，不重新扫描 output，且只能把冻结 25 份以外的候选送入 `needs_review`。`needs_ocr` 与 `image_dominant` 只由冻结名单和人工复核决定，不能由 Task 4/5 发起。
- [ ] 首版真实语料验证：

```text
input_count=418
output_count=418
registered_source_count=418
unique_source_urls=418
authors_preserved=418
published_dates_preserved=418
original_status_preserved=418
body_images=237
ordered_body_image_mismatches=0
square_fingerprints=393
cognition_fingerprints=25
duplicate_figure_labels_removed=207
nbsp_normalizations=631
wechat_css_hits=0
data_svg_action_icons=0
hard_break_regressions=0
unknown_fingerprints=0
```

- [ ] `body_images=237` 之外，要求每个来源的 ordered image tuple 与原始输入一致；丢一张并重复另一张必须失败。
- [ ] 对每一条未删除的原始非空行检查尾随两个空格是否仍存在；不得以一个全局计数代替逐行映射。
- [ ] 对四类样本人工比较：最短文件、图片型速查卡、长篇逻辑文章、含正文链接文章。
- [ ] 25 份正文不足或图片主导来源设为 `needs_ocr` 或 `needs_review`；不得把裸字符阈值视作确定事实。
- [ ] 第二次 apply 必须返回 `already_current`，current pointer 与 418 个 cleaned hash 均不变。

## Task 9: Public Scope Scanner

**Files:**

- Create: `tools/lib/public-scope.mjs`
- Create: `tests/public-scope.test.mjs`
- Update: `tools/corpus.mjs`

**Interfaces:**

- `verifyPublicScope({ scope, rootDir?, gitRef?, artifactDir?, rawManifest?, currentPointer? }) -> Promise<PublicScopeReport>`
- `scope` 必须精确为 `"worktree"`、`"git-ref"` 或 `"artifact"`；`git-ref` 接受 commit 或 tree OID/tree-ish，并始终从 Git object database 读取 blobs。`worktree` 与 `git-ref` 必须收到私有 baseline 与 `currentPointer`，把扫描所需 selected outputs 与 original/raw artifacts 全部作为 `readCurrentCleaningState()` 的 `selectedSourceIds`/bounded `readAdditionalArtifacts` 请求，并在 pointer-after 之前完成读取和指纹构建；不得在 reader 返回后重新打开 selected outputs/originals。`artifact` 只要求 `artifactDir` 并执行路径、文件数、HTML 与公共 schema 合同，在显式提供私有 `currentPointer` 时再附加全文泄漏比对。所选 scope 的必需参数缺失返回 `INVALID_SCOPE_ARGUMENTS`。

- [ ] 写失败测试；所有违规输入在临时测试仓库运行时生成，不把故意违规的 sentinel fixture加入公开仓库。以下任一条件均返回退出码 3：

```text
路径位于 .local/ 或 inbox/
扩展名为 .bundle
公开文件包含本地绝对路径
公开文件 hash 等于任何原始或清理全文 hash
公开文件包含人工 fixture 的私有哨兵连续片段
Git 可达树含根层原始 Markdown
site/ 以外的路径进入 Pages artifact
knowledge/sources.json 含 allowlist 外字段、body_image_urls 或本地路径
knowledge/manifest.json 含 allowlist 外字段或全文
短于 200 字的私有正文被嵌入较大 JSON/HTML
```

- [ ] 写通过测试：公开知识摘要、来源 URL、工具、测试、文档和单文件 HTML 可通过。
- [ ] 对 `knowledge/sources.json` 使用与 Phase B 唯一公共合同一致的精确 allowlist。顶层只允许 `schema_version`、`corpus_version`、`sources`；每个来源只允许 `source_id`、`title`、`author`、`published_at`、`date_precision`、`source_url`、`source_fingerprint`、`provenance_visibility`、`primary_chapter_id`、`tags`、`primary_content_type`、`model_roles`、`related_sources`、`processing_status`、`ocr_status`、`medical_review_status`、`logic_review_status`、`risk_flags`、`evidence_boundary`。`model_roles` 与 `related_sources` 的子字段也必须与 Phase B 合同精确相等，不接受 unknown key。
- [ ] 对 `knowledge/manifest.json` 使用同一 Phase B 合同：只允许 `schema_version`、`knowledge_version`、`corpus_version`、`baseline_source_count`、`current_source_count`、`baseline_chapter_counts`、`current_chapter_counts`、`processing_versions`、`counts`、`source_status_counts`、`ocr_status_counts`、`medical_review_status_counts`、`logic_review_status_counts`、`public_files`，并递归检查各嵌套字段。任何绝对路径、私有 locator、catalog source ID、HMAC key、原始/清理正文和正文图片 URL 均失败。
- [ ] 生成泄漏指纹前，从原始/清理内容中剥离被 public schema 明确允许的单值 metadata，剩余部分定义为 private payload。长度至少 200 code points 时生成全部 200-code-point 滑窗 hash；长度 8–199 时生成完整 payload hash，并对公开文本扫描同长度窗口；长度少于 8 时以 exact escaped substring 扫描。指纹和命中上下文只保存于 `.local/state/`，公开报告只输出 source ID 与规则码。
- [ ] 负例必须包括：159 字清理全文嵌入较大 JSON、31 字正文嵌入 HTML、正文只含图片 URL、CRLF/NFC 变化和一份 200 字以上滑窗命中。
- [ ] 运行具名测试：

```sh
rtk node --test tests/public-scope.test.mjs
```

预期 `worktree rejects a short private payload`、`git-ref rejects reachable raw history`、`artifact rejects paths outside site`、`safe public schemas pass` 均 PASS，且 `fail 0`。

- [ ] 根层原文迁移前，以下 worktree 命令必须返回退出码 3；迁移和清洗完成后，同一命令必须通过：

```sh
rtk npm run corpus -- verify-public --scope worktree --root . --raw-manifest .local/state/raw-baseline.json --current-pointer .local/state/current-cleaning.json
```

- [ ] Phase A 结束时单独运行 Git ref scope，必须返回退出码 3 和 `history_safe=false`，因为旧 `main` 可达历史仍含原文；这是预期失败，不得把它改成 worktree 失败：

```sh
rtk npm run corpus -- verify-public --scope git-ref --root . --git-ref main --raw-manifest .local/state/raw-baseline.json --current-pointer .local/state/current-cleaning.json
```

- [ ] Artifact scope 只在发布计划生成 `site/` 后执行；本任务只在临时 fixture 中测试接口，不用不存在的真实 artifact 冒充通过。

## Task 10: Initial Documentation and Core Verification

**Files:**

- Update: `README.md`
- Update: `AGENTS.md`
- Create: `tools/lib/local-verifier.mjs`
- Create: `tests/local-verifier.test.mjs`
- Update: `tools/corpus.mjs`

**Interfaces:**

- `verifyLocalState({ baselineManifest, bundlePath, currentPointer, keyPath, keyBackupPath, journalPath }) -> Promise<LocalVerificationReport>`
- 验证器重新执行 bundle verify/restore、baseline 目标 hash、pointer-selected run/catalog/report/output hashes、动态来源计数、source ID key 双份 hash 和 journal 完成状态；所有 selected outputs 和 original artifacts 必须通过 shared reader 的 `selectedSourceIds`/bounded callback 在 pointer-after 前读完，不得只信已有 report 或在 reader 返回后重新打开私有产物。

- [ ] README 记录：

```text
私有/公开目录边界
如何投递新 Markdown
preflight、backup、migrate、clean、verify-local、三个 verify-public scope 命令
状态含义
如何用空目标目录恢复 raw bundle，以及如何核对 full baseline SHA
commit/push 审批门
```

- [ ] AGENTS 补充：后续任务必须先读本设计、总计划和本计划；不得读取 `.local/learning-notes/` 用于公开输出，除非用户逐条批准去标识化。
- [ ] 写失败测试：篡改 bundle、original、current pointer、catalog hash、source ID key backup 或 migration journal 中任一项时，`verifyLocalState()` 都失败；动态 catalog 从 418 增至 419 时不得因 baseline 数量固定而失败。
- [ ] README 的恢复说明必须使用 full SHA `f876ce90d24ed486cae4060b1a4fe7b0813e9492`，要求用户提供一个不存在的目标目录，并先执行 `git bundle verify`；不得给出 `rm -rf` 或覆盖已有目录的命令。
- [ ] 运行相关与全量测试：

```sh
rtk npm test
rtk npm run corpus -- verify-local --baseline-manifest .local/state/raw-baseline.json --bundle .local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle --current-pointer .local/state/current-cleaning.json --key .local/state/source-id-key.bin --key-backup .local/backup/source-id-key.bin --journal .local/state/migration-journal.jsonl
rtk npm run corpus -- verify-public --scope worktree --root . --raw-manifest .local/state/raw-baseline.json --current-pointer .local/state/current-cleaning.json
rtk git diff --check
rtk git status --short
```

- [ ] 全量结果要求所有具名测试 PASS、`fail 0`、`public_scope_violations=0`、`local_invariant_failures=0`。单独记录 `git-ref main` 的预期 `history_safe=false`，不把它混入 worktree 通过结果。
- [ ] 最终报告只列实际改动、验证结果、仍为私有的资产、尚未处理的来源状态，以及没有执行的 commit/history/remote/push 动作。
- [ ] 所有持久验证结果只写既定 `.local/state/` 路径；不得在仓库根或公开目录保存终端日志。

## Task 11: Incremental Markdown Intake

**Files:**

- Create: `tools/lib/input-discovery.mjs`
- Create: `tests/input-discovery.test.mjs`
- Update: `tools/lib/corpus-cleaner.mjs`
- Update: `tools/corpus.mjs`
- Update: `README.md`

**Interfaces:**

- `discoverInputs({ rootDir, currentPointer }) -> Promise<DiscoveryReport>`
- `ingestMarkdown({ inputPath, keyPath, runsRoot, currentPointer, journalPath, apply, confirmation }) -> Promise<IngestMarkdownResult>`
- `finalizeMarkdownInput({ sourceId, currentPointer, journalPath, apply, confirmation }) -> Promise<FinalizeInputResult>`

- [ ] 写失败测试：`discoverInputs()` 找到 `inbox/` 和根层未登记 Markdown，但排除 `AGENTS.md`、`README.md`、`docs/`、`knowledge/`、`tests/fixtures/`、已登记 locator 和 baseline manifest 中已经迁移的路径。
- [ ] 写失败测试：`ingestMarkdown()` 只接受仓库根或 `inbox/` 中的常规文件，拒绝 symlink、目录、设备文件、仓库外路径和实施中公开文档。
- [ ] 新 Markdown 的私有快照路径固定为：

```text
.local/original/markdown/<source_id>/versions/<raw_sha256>.md
```

`source_id` 使用 private HMAC key；有可解析 URL 时 locator 为 canonical URL，无 URL 时 locator 为 raw SHA-256。相同 locator 与 raw hash 返回幂等 no-op；不同 locator 但 raw/clean hash 相同，保留独立来源并标记 `ingest_status=duplicate`，不得静默合并来源证据。

- [ ] 普通非微信 Markdown 使用 conservative pass-through：输入已有终止 LF 时只允许 NBSP 和空白行规范化，不删除任何非空正文；缺失 EOF newline 时原 bytes + `needs_review`，不得使用冻结基线例外自动补齐。缺失元数据时同样标记 `needs_review`。微信格式仍必须通过完整 fingerprint，并固定传入 `inputMode="incremental"`。
- [ ] `--dry-run` 输出 source ID、raw hash、目标路径、duplicate 关系、动态 catalog count 和 input removal plan，不写文件。
- [ ] `--apply --confirm INGEST_LOCAL_MARKDOWN` 只使用 no-clobber 快照；它必须调用 prepare，由 prepare 在同一 shared-reader pointer window 内验证当前 catalog/report、全部 carry-forward outputs 与必需 original artifacts，并内部派生 reviewer state，不接收 `prior_review_state`。完整 prior source set 必须保留；reviewer state 只在清理成功且 raw/cleaned/audit/cleaner-version 四项 binding 相等时保留。然后用 prepared plan stage/publish，不另行更新 catalog/report。成功后把 journal 推进到 `READY_FOR_INPUT_REMOVAL`；保留原输入。
- [ ] 摄取完成后向用户展示 source ID、原输入路径、raw hash、快照路径/hash、current run、catalog 记录和恢复方式。只有获得独立移除确认后，才调用 `finalize-markdown-input --apply --confirm REMOVE_VERIFIED_INPUT`；该命令在 unlink 前重新核对输入、快照、catalog、current pointer 和 journal，unlink 后 fsync 输入父目录并写 `INPUT_REMOVED`。崩溃重跑最多留下重复输入，不得丢失唯一副本。
- [ ] `publication_policy` 固定默认为 `local_only`；该命令没有改变为公开的参数。
- [ ] 在临时仓库写 RED/GREEN CLI 测试，具体验收：

```text
baseline_source_count=418
registered_source_count_before=418
registered_source_count_after=419
new_snapshot_count=1
new_cleaned_count=1
unchanged_baseline_cleaned_hashes=418
input_preserved_after_ingest=true
input_removed_only_after_separate_confirmation=true
publication_policy=local_only
```

- [ ] 运行具名测试和真实仓库只读发现：

```sh
rtk node --test tests/input-discovery.test.mjs
rtk npm run corpus -- discover --root . --current-pointer .local/state/current-cleaning.json
```

预期 `discover excludes reserved public Markdown`、`ingest publishes before removing input`、`incremental count is dynamic`、`opaque ID requires local key` 均 PASS，且 `fail 0`。真实 `discover` 只报告，不自动 ingest。

## Task 12: Versioned and Pinned URL Intake

**Files:**

- Create: `tools/lib/ip-safety.mjs`
- Create: `tools/lib/url-safety.mjs`
- Create: `tools/lib/pinned-http-client.mjs`
- Create: `tools/lib/url-aliases.mjs`
- Create: `tools/lib/url-snapshot.mjs`
- Create: `tests/url-safety.test.mjs`
- Create: `tests/pinned-http-client.test.mjs`
- Create: `tests/url-snapshot.test.mjs`
- Update: `tools/corpus.mjs`
- Update: `README.md`

**Interfaces:**

- `prepareUrlIntake({ inputUrl, outputDir, currentPointer, keyPath }) -> Promise<UrlIntake>`
- `resolveUrlAlias({ requestedCanonicalUrl, finalCanonicalUrl, aliasPath, sourceId }) -> Promise<{ duplicateOf: string | null, aliases: string[] }>`
- `requestPinned({ url, resolver, connect, timeoutMs, maxBytes, maxRedirects }) -> Promise<PinnedResponse>`
- `snapshotUrl({ intakePath, currentPointer, keyPath, originalRoot, apply, confirmation }) -> Promise<UrlSnapshotResult>`
- `registerSnapshot({ fetchManifestPath, markdownPath, currentPointer, keyPath, runsRoot, apply, confirmation }) -> Promise<RegisterSnapshotResult>`

- [ ] 实施前核对并在代码注释中引用 Node.js 24.18.0 `http.request()`/`https.request()` 的 custom `lookup`、WHATWG `URL`、AbortSignal 与 DNS API；安全决策同时依据 OWASP SSRF 对 DNS rebinding 和 redirect 的要求。不得改回默认 `fetch()`。
- [ ] `canonicalizeHttpUrl()` 只允许 `http:`、`https:`，拒绝 username/password；移除 fragment 和默认端口，保留 WHATWG serialization 后的完整 pathname、query 内容及原顺序，不删除所谓 tracking 参数。
- [ ] `prepare-url` 不访问网络。它生成 `.local/state/url-intake/<canonical_url_sha256>.json`，使用 private key 生成 opaque source ID，并记录 requested canonical URL、URL SHA-256、source ID、创建状态 `new` 和 `publication_policy=local_only`。同 URL 重跑必须幂等，不得覆盖不同内容 intake。
- [ ] source ID 永远绑定 requested canonical URL 的私有 HMAC locator；每个 redirect final canonical URL 只作为 `.local/catalog/url-aliases.jsonl` 中的私有 alias。若 final URL 已是另一来源的 requested/final alias，当前来源保留自己的 opaque ID 并登记 `duplicate_of` 指向既有来源，不能重写 ID、合并证据或让 redirect 改变身份。alias 文件保存完整 URL 仅在 `.local/`，公开输出不得出现其路径或内容。
- [ ] 写 IP 安全测试，拒绝 IPv4/IPv6 loopback、private、link-local、multicast、unspecified、carrier-grade NAT、benchmark、documentation、云 metadata 常用地址、IPv4-mapped IPv6、非 80/443 端口和 DNS 返回的任一不安全地址。
- [ ] 每次请求及每个 redirect 都执行：

```text
WHATWG URL 解析和 scheme/credentials/port 校验
解析全部 A/AAAA 地址并拒绝集合中的任一不安全地址
按 IP bytes 与 family 稳定排序选择地址
通过 http.request()/https.request() 的 custom lookup 把本次 connect 固定到该地址
HTTPS 使用原 hostname 做 Host、SNI 和证书校验
agent=false，不继承 HTTP_PROXY/HTTPS_PROXY
不发送 Cookie、Authorization、Referer 或用户凭据
发送 Accept-Encoding: identity；非 identity content-encoding 返回 needs_review
手工处理 redirect，最多 5 次；每一跳重新解析、解析 DNS、校验并 pin
15 秒包含所有 redirect 的总 deadline
边串流边计数，原始响应超过 10 MiB 立即 abort
只接受 text/html、text/markdown、text/plain
```

- [ ] 写 DNS rebinding 失败测试：验证 resolver 首次返回公网、模拟 connect 再请求解析得到私网时，实际 socket 仍只能使用已 pin 的公网地址；生产 connect 不得自行进行第二次 hostname lookup。
- [ ] 本地 HTTP fixture 覆盖 200、404、429、5xx、总超时、redirect loop、redirect 到私网、错误 MIME、超过 10 MiB、非 identity encoding、乱码和中途断流。Loopback 仅通过测试注入 resolver/connector 允许，生产 CLI 不暴露 allow-private 参数。
- [ ] URL 快照使用追加式内容寻址目录：

```text
.local/original/url/<source_id>/versions/<raw_response_sha256>/response.bin
.local/original/url/<source_id>/versions/<raw_response_sha256>/fetch.json
```

`fetch.json` schema 固定为：

```js
{
  schema_version: "1.0.0",
  source_id: "src_" + thirtyTwoHex,
  snapshot_version: positiveInteger,
  requested_url: string,
  final_url: string,
  status: "fetched" | "fetch_failed" | "needs_review",
  http_status: number | null,
  fetched_at: ISO8601String,
  headers: {
    "content-type"?: string,
    "content-length"?: string,
    "content-encoding"?: string,
    "etag"?: string,
    "last-modified"?: string,
    "cache-control"?: string
  },
  raw_response_sha256: sixtyFourHex | null,
  byte_length: number,
  response_path: string | null,
  redirect_chain: Array<{ url: string, status: number }>
}
```

不得保存 `set-cookie`、认证 header、代理信息或本地绝对路径。

- [ ] 同 URL + 同 response hash 返回幂等 no-op；同 URL + 新 response hash 在同一 source ID 下增加 `snapshot_version`，旧版本保留；失败版本记录 `fetch_failed` 但不替换旧 current snapshot。不同 URL 命中相同 raw/clean hash 时登记 duplicate 关系，不复用可从 URL 推导的 ID。
- [ ] `text/markdown` 与可无损解码的 `text/plain` 在版本目录生成候选 Markdown 并由 `registerSnapshot()` 登记。`text/html` 只保存 raw bytes；经用户授权后，Codex/浏览器把可见正文另存为本地 Markdown，再由 `registerSnapshot()` 核对 fetch manifest、raw HTML hash 与 Markdown hash。JavaScript-only、登录、付费墙或正文不足保持 `fetch_failed`/`needs_review`，不绕过限制。
- [ ] `registerSnapshot()` 对所有 URL 候选固定使用 `inputMode="incremental"`；候选 Markdown 缺失 EOF newline 时保留原 bytes 并进入 `needs_review`，不得复用冻结 418-path 基线例外。
- [ ] `register-snapshot --dry-run` 调用 prepare，在 shared-reader pointer window 内验证当前 catalog/report、全部 carry-forward outputs 与必需 original artifacts，内部派生 reviewer state，并以 raw/cleaned/audit/cleaner-version four-way binding 决定保留或重置，不接受 caller `prior_review_state`。Dry-run 展示 exact CleaningPlan summary 与 fetch manifest、requested/final URL、duplicate/alias、publication policy；只有 `--apply --confirm REGISTER_URL_MARKDOWN` 才用 exact prepared plan stage/publish。登记不删除任何 snapshot。
- [ ] `snapshot-url` 必须同时收到已审核 intake 文件、`--apply` 和 `--confirm FETCH_UNTRUSTED_PUBLIC_URL` 才访问网络。计划中没有真实用户 URL，因此不加入伪造域名或伪造 source ID 的执行命令；真实命令只在用户提供并确认具体 URL 的任务中生成。
- [ ] 运行全部合成测试：

```sh
rtk node --test tests/url-safety.test.mjs tests/pinned-http-client.test.mjs tests/url-snapshot.test.mjs
```

预期 `DNS rebinding cannot change the pinned connect address`、`redirects are revalidated and repinned`、`response versions never overwrite`、`failed fetch preserves the previous version`、`source ID is opaque without the key` 均 PASS，且 `fail 0`。

- [ ] 在临时仓库验收：第一次合成 URL 快照使动态 catalog 从 418 增至 419；相同响应重跑仍为 419；同 URL 新响应只新增 snapshot version；418 个既有 cleaned hash 不变。
- [ ] 再次运行 Task 10 的全量验证，确认 `discover` 没有未登记输入、worktree scope 通过、`git-ref main` 仍按预期报告 `history_safe=false`。
- [ ] 停止并请求用户复核 Phase A；不自动 commit、不创建 root commit object、不更新 `main`、不配置 remote、不 push、不发布。
