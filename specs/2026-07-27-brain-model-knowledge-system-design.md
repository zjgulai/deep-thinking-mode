# 思维模型综合知识系统设计

## 1. 背景

当前目录包含 418 篇 Markdown，均由微信公众号文章导出：

- 393 篇来自「正方形SQUARE」。
- 25 篇来自「认知结构」。
- 原始文件合计 44,605 个逻辑行，约 5.01 MB。
- 418 篇均包含重复标题、整段 CSS、作者品牌卡、微信操作栏和内嵌 SVG。
- 169 篇包含 237 张应保留的正文图片。
- 25 篇剥离模板和图片后有效文本不超过 100 字，主要知识可能只存在于图片中。
- 没有字节级完全重复文件，也没有重复来源 URL。
- 存在 5 组标点归一后的同名资料，以及约 61 对高置信度的长文与短版或速查卡关系。

原始资料已经建立本地 Git 基线：

- 分支：`main`
- Commit：`f876ce9 chore: preserve original markdown baseline`
- 基线包含 418 篇原始 Markdown。

用户要求把资料建设为可长期维护的综合知识系统，而非逐篇全文堆叠。系统还必须支持未来由用户与 Codex 共同学习：用户新增 Markdown 或提供链接后，由 Codex 完成清理、理解、去重、总结、归档、模型关联、应用卡更新和 HTML 重建。

## 2. 已确认目标

网站产品名、公开仓库、Pages 子路径和网站表现以
`2026-07-30-systematic-thinking-site-design.md` 为准；资料隐私、安全、来源证据和单文件离线约束仍以本文为准。

1. 保留 418 份原始资料及未来来源的完整本地快照。
2. 在不改写原始来源的前提下生成清理全文。
3. 深度分析全部资料，识别重复、系列、卡片、案例、对比和相关关系。
4. 把资料融合为去重后的综合知识体系。
5. 每个去重后的知识模型或方法都提供「与 Codex 共学应用卡」。
6. 生成单个、可离线打开的 `site/index.html`。
7. 同一产物通过 GitHub Pages 发布为可分享网址。
8. 未来新增 Markdown 或 URL 时只处理新增或变更资料，但重新生成完整 HTML。
9. 公开内容保留来源追溯，同时不公开原始全文、清理全文、OCR 内容或私人共学记录。

## 3. 非目标

- 不把 418 篇原文按顺序直接拼接到网页。
- 不在 GitHub Actions 中调用 LLM。
- 不引入自动运行的外部 LLM API。
- 不根据标题猜测图片型或抓取不完整资料的正文。
- 不把标题相近但模型不同的资料自动合并。
- 不对全部心理学、神经科学、医学和逻辑学主张进行无边界的事实核验。
- 不自动 commit、push 或发布未经用户确认的内容。
- 首版不建设多页 CMS、账户系统、数据库、在线编辑器或云端搜索服务。

## 4. 核心设计原则

### 4.1 来源与策展分离

原始来源、机械清理结果、OCR 结果、综合知识和发布产物是不同层，不能互相覆盖。

### 4.2 一个主章节，多重关联

每份资料和每个模型只有一个主章节。跨主题关系通过标签、相关模型和问题路由表达，不复制多份正文。

### 4.3 确定性处理与语义处理分离

脚本负责清理、提取、指纹、状态、验证和构建；Codex 负责理解、去重判断、综合、应用卡和案例沉淀。

### 4.4 无证据不补写

正文不足、OCR 失败、分类模糊或观点冲突时，保留明确状态和来源，不生成看似完整但无法追溯的结论。

这条原则同时约束本地状态恢复：不完整 bytes 不是可被解释的语义对象。系统只能对当下
完整可观察的 filename、topology、file type、mode、no-follow identity 与 parent
continuity 做严格判断；只有 durable、canonical、完整的对象才进入 schema、hash、
binding 与业务语义验证。已识别但内容不完整的 crash residue 必须保持显式
`RECOVERY_UNRESOLVED_TARGET` 和零持久写入，不能凭局部 Base64、UTF-8 或 JSON 前缀猜测
它“本来应该是什么”，也不能据此取得 ownership、清理 residue 或继续 mutation。

未来新增思维类书籍也沿用同一证据阶梯：来源全文、页码/章节定位、OCR 或抓取结果未完整
且不可追溯时，只记录 `needs_ocr`、`needs_review` 或 `fetch_failed`，不补写作者观点、
模型定义或「与 Codex 共学应用卡」；证据完整后再做严格萃取、去重、引用绑定和复核。

### 4.5 公开最小化

GitHub 和 GitHub Pages 只发布理解知识体系所必需的综合内容和来源元数据。

## 5. 三层架构

```text
本地资料层（不推送）
├── inbox/                       新增 Markdown 投递入口
├── .local/original/             原始文件与 URL 快照
├── .local/cleaned/runs/         自包含的不可变清理 run（全文、catalog 和 report）
├── .local/ocr/                  正文图片与 OCR 结果
├── .local/learning-notes/       私人共学记录
├── .local/state/
│   ├── current-cleaning.json   唯一可变提交记录与当前 run 选择权威
│   ├── cleaning-transitions/  只追加的并发发布恢复记录，不是选择权威
│   └── cleaning-commit.lock   完整 intent 原子 no-clobber 发布的独占提交锁
└── .local/backup/
    └── raw-baseline-f876ce9.bundle

综合知识层（可推送）
├── knowledge/chapters/          13 章总览、阅读顺序和关系说明
├── knowledge/models/            每个去重模型或方法的独立知识文件
├── knowledge/taxonomy.json      固定章节、顺序和允许标签
├── knowledge/problem-routes.json
├── knowledge/sources.json       公开安全的来源与关系索引
└── knowledge/manifest.json      指纹、状态和处理版本

工具与规范（可推送）
├── tools/                       清理、检查、构建脚本
├── tests/                       固定样例与自动检查
├── AGENTS.md                    后续 Codex 的必读规则
├── README.md                    使用、更新与发布说明
├── package.json
└── package-lock.json

发布层（可推送）
├── site/index.html
└── .github/workflows/pages.yml
```

用户可以把新 Markdown 放入 `inbox/`。如果文件仍被放在仓库根目录，Codex 也必须识别未登记的根层 Markdown，将其纳入相同流程，并在完成本地快照后整理到本地资料层。

## 6. 公开 Git 历史边界

当前 `f876ce9` 已包含 418 篇原始全文，不能直接推送到公开仓库。

首次公开推送前必须：

1. 从 `f876ce9` 创建 `.local/backup/raw-baseline-f876ce9.bundle`。
2. 验证 bundle 可列出并恢复该 commit。
3. 把 418 篇原始文件迁入 `.local/original/`。
4. 生成 `.local/cleaned/`，但不加入公开 Git 索引。
5. 使用 `.gitignore` 排除 `inbox/`、`.local/`、根层临时资料和其他本地输入。
6. 在 `main` 上建立全新的公开安全历史。
7. 推送前扫描 Git 树和待发布构件，确认不存在原始全文、本地清理稿、OCR 文件、bundle 或私人记录。

全程不创建 worktree。历史替换和首次 push 必须在执行前再次获得用户明确确认。

## 7. 知识目录

每篇资料只进入一个主章节。当前 418 篇的初始主归档如下：

| ID | 一级章节 | 当前数量 | 二级结构 |
|---|---|---:|---|
| 00 | 综合索引与工具箱 | 10 | 模型总览与选型、组合工具箱与闭环、跨主题导航 |
| 01 | 元认知与认知边界 | 15 | 观察者视角、认知融合与解离、批判性与整合思维、模型边界与过拟合 |
| 02 | 形式逻辑、概念与语言 | 16 | 概念与定义、判断与推理、论证、命题等价与逻辑关系、句法语义语用 |
| 03 | 问题定义与提问重构 | 41 | 问题识别、精准定义、重构方法、苏格拉底与爱因斯坦式提问、破解导航 |
| 04 | 结构化分析与根因拆解 | 38 | 结构化与框架思维、逻辑树与 MECE、5 Whys、鱼骨图、冰山、第一性原理 |
| 05 | 系统、网络与复杂性 | 28 | 系统核心、系统基模、延迟反馈、网络与弱连接、涌现与动态关系 |
| 06 | 决策、风险与认知偏差 | 49 | 决策流程、启发式、前景理论、框架效应、概率风险、逆向思维 |
| 07 | 行动、习惯与执行 | 32 | 拖延、动力、多巴胺、习惯、福格模型、WOOP、SOP |
| 08 | 学习、知识与成长 | 43 | 知识整合、经验学习、复盘、刻意练习、成长陷阱、自我效能 |
| 09 | 时间、专注与精力 | 29 | 时间块、帕累托、注意力、心流、疲劳、精力、睡眠与恢复 |
| 10 | 情绪、压力与内耗 | 65 | 内耗管理系统、情绪调节、焦虑反刍、压力失控、意志力、情绪急救 |
| 11 | 沟通、表达与关系 | 22 | 金字塔、STAR、SBI、反馈冲突、框架说服、人际视角与关系 |
| 12 | 脑科学、身体与健康 | 30 | 脑区、默认模式网络、神经递质、自主神经、运动代谢、睡眠与健康风险 |

内容类型与章节分离。允许的主要内容类型为：

- `canonical`
- `card`
- `case`
- `comparison`
- `series`
- `related`

健康医学内容必须带 `needs_medical_review`。未来明显超出目录边界的资料先进入 `needs_review`，由 Codex 判断扩展现有二级结构还是新增一级章节。

## 8. 清理规则

### 8.1 安全自动清理

清理器以 `Buffer`/`Uint8Array` 接收原始 bytes，并使用 fatal UTF-8 解码。非 UTF-8、
CRLF/裸 CR、未知输入模式或任一结构校验失败时，必须返回逐 byte 相同的输入和
`needs_review`，不能先转成 JavaScript string 再声称保留了原 bytes。

仅在完整匹配微信导出指纹时执行：

1. 删除第 1 行重复标题与整段 CSS，以及紧随其后的空行。
2. 保留第 3 至第 4 行形成的正式标题。
3. 保留第 6 行作者、原创状态、日期和地点。
4. 保留第 8 行原文地址，并将其解析为来源元数据。
5. 删除末尾作者 CDN 品牌卡。
6. 删除每篇固定的 5 个 `data:image/svg+xml` 操作图标及阅读、赞、分享、推荐、留言文字。
7. 删除同编号 `![图N](...)` 后直接出现，或只隔一条完全空白物理行后出现的独立
   `图N` 行；隔两条以上空行、含空格的分隔行、不同编号或任何中间正文都不得删除。
8. 删除已确认的平台收藏或关注 CTA，不按广告关键词盲删正文案例。
9. 把 U+00A0 转为普通空格。
10. 清除空白行内部空格，折叠连续空白行，补齐 EOF newline。

不得对非空行执行全局 `rstrip`，因为原始资料有 Markdown 双空格硬换行。

微信 header 使用 1-based 原始物理行固定语法：第 1 行必须精确为“五个 U+0020 +
第 3 行正式标题 bytes + 一个 U+0020 + 以字面量 `\* {` 开头的 CSS”；第 2、5、7
行必须为空，第 4 行必须只含 `=`，第 6 行按“原创状态、作者、发布日期时间、地点”
的固定位置解析，第 8 行必须是可解析且显示 URL 与目标 URL 一致的微信原文链接。
不得用全文搜索到的另一处标题、作者或 URL 替代这些固定行。

缺失 EOF newline 只有一个窄例外：Gate 0 已确认 HEAD 精确为冻结基线 full SHA
`f876ce90d24ed486cae4060b1a4fe7b0813e9492`，且根层 Markdown 路径集合精确为冻结的
418 个路径后，这 418 份基线原始 bytes 才允许在缺失终止 LF 的情况下继续清理。header
与 footer 指纹仍必须在任何换行补齐之前按原始 bytes 计算；清理成功后必须记录
`EOF_NEWLINE_V1`，并在输出末尾补且只补一个 LF。该授权只沿已验证 baseline
manifest 的精确 path/hash 集合传递，不得作为用户可选 CLI 开关。

未来新增 Markdown、URL 转换得到的 Markdown、普通 Markdown 以及任何未进入上述冻结
集合的输入，只要缺失 EOF newline，都必须原样返回并进入 `needs_review`；不得借用
基线例外自动补换行。CRLF 和其他换行壳差异也不属于该例外。

所有删除与规范化写入 byte-level `changes` ledger。删除、规范化和 EOF 追加分别使用
`delete`、`normalize`、`append_eof`；记录原始 1-based 行号数组以及变更前后 bytes 的
SHA-256。`normalize` 的行号允许非连续，以便在中间 CTA 删除后审计新相邻的空白行；
hash 按行号升序拼接各原始物理行 slice 后计算。`append_eof` 使用 null 行号、空 bytes
的 before hash 和单个 LF 的 after hash。任何失败返回空 ledger。

CTA 的 `trimmed_line_sha256` 只允许在原始物理行去掉两端 U+0020 与 HTAB 后计算，
不做 Unicode 或换行规范化；URL hash 与行 hash 必须同时命中。相同 pair 在一份来源
中命中超过一次时整份进入 `needs_review`。正文图片与 Markdown 硬换行按原始行号建立
保留 ledger，清理后逐项核对，不能只比较总数。

机械清理器不使用短文本阈值决定 `needs_ocr`。正文长度、图片主导状态与首版冻结的
25 份 OCR 名单由 corpus 编排层在清理成功后判断。
corpus 编排层必须直接消费清理器返回的位置化 `metadata` 与正文 `bodyImages`；不得再用
全文扫描 parser 解析清理结果，避免正文中的同形字段替代固定 header 元数据。

为使上述边界可验证，Task 4 成功结果必须在原始/output ledger 仍可用时
产生 authoritative `audit`：`source_byte_length`、`output_byte_length`、
`retained_spans`、`metadata_spans`、`image_spans`、`hard_breaks`、
zero-length-allowed `body_output_span`、`ordered_body_images_preserved` 与
`body_non_whitespace_code_points`。这些字段分别表达
0-based half-open source/output byte spans、包含实际 LF 的保留 physical-line mappings 与
before/after hash、固定 metadata span preservation、按正整数 ordinal 严格排序且唯一的
body-image token spans、每行 hard-break span preservation 和 ordered-body-image preservation；
body measurement 只在 `body_output_span` 内排除 exact output image-token spans。Line span
包含 LF，image token span 不含 LF。每个 collection 内 spans 有界、排序且不重叠；
cross-collection containment 允许且必须验证，metadata/image/hard-break spans 要被
retained line spans 包含。`bodyImages.ordinal` 为 positive/sorted/unique，audit image
通过 `output_sha256`/`alt_sha256`/`url_sha256` 与其 token/alt/URL 逐项绑定。
Failure/`needs_review` 使用 exact byte no-op
且 `audit:null`；successful zero-change 仍返回完整 non-null audit。
Task 5 只验证并消费这个 audit，不重放 ledger、不重解析 output。Task 4
必须先以 synthetic RED/GREEN tests 锁定该 schema，Task 5 才可实施。

### 8.2 必须保留

- 正式标题。
- 作者、日期、地点和原创状态。
- 原文 URL。
- 237 张正文图片。
- 正文链接、列表、标题结构和 Markdown 硬换行。
- 对理解模型有价值的系列导航和引用链接。

### 8.3 需要语义判断

- Hashtag 是否迁移为标签。
- 系列预告和跨文章链接。
- “收藏这张图”等正文末尾 CTA。
- 文内长段重复。
- 抓取不完整文件。
- 可能只是视觉摘要的短版或速查卡。

### 8.4 清理事务、确定性与唯一权威

每次不可变清理 run 必须自包含于
`.local/cleaned/runs/<run_sha256>/`：每个权威输出 byte stream 位于
`sources/<source_id>.md`，当次权威 catalog 位于 `catalog/sources.jsonl`，
当次权威 report 位于 `cleaning-report.json`。
`.local/state/current-cleaning.json` 是唯一可变提交记录，也是选择当前
run 的唯一权威；不保留独立 catalog 或 report 镜像。

Pointer schema 保持 `1.0.0` 且只允许下列字段：

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

`run_path`、`catalog_path` 和 `report_path` 这三个 path 必须精确满足上述派生关系。
绝对路径、`..`、symlink、替代文件名或旧固定路径均无效。每个 reader
必须接收 `currentPointer`，在读取被选中的不可变产物前后稳定双读
pointer 原始 bytes，验证精确 schema 与路径关系，拒绝 symlink 和非常规文件，
验证 catalog/report SHA-256、exact canonical schema/bytes、sorted unique source IDs、
pointer/catalog/report/output cross-invariants 与 size limit，然后且只能使用这些
已验证 bytes。Reader 使用 no-follow file handles 和读前/后 `fstat`/path identity；
pointer-after 必须等到 consumer 请求的 selected outputs 与有界
`readAdditionalArtifacts` callback
全部读取、hash 验证并 await 完成后才执行。Pointer bytes 变化时丢弃全部
已读 bytes。动态登记来源数从被选 catalog 计算。共享实现唯一位于
`tools/lib/cleaning-state.mjs`，Task 1/3 和后续 reader 不得复制 validator。

Shared reader 的核心容量上限固定为：pointer 64 KiB、catalog 64 MiB、catalog
单条物理行（包含其终止 LF）1 MiB、report 256 MiB、每个 selected output 64 MiB、
全部 selected outputs 合计 1 GiB；读文件前先按稳定 `fstat.size` 拒绝超限对象。
`selected_output_bytes` 是按 `source_id` 严格递增迭代的
`ReadonlyMap<string, Buffer>`：运行时返回值只暴露只读 Map 查询/迭代能力，不暴露
`set`、`delete` 或 `clear`。Additional artifact 仍为每个 64 MiB、最多 1024 个、
合计 1 GiB，且 consumer 传入的 `maxBytes` 不能放宽该硬上限。

Task 1 baseline preflight 与 Task 3 no-pointer key flow 是已完成边界。两者原先要求的
incremental/pointer-existing acceptance 正式移入 Task 5A，只在 shared reader 落地后
接入并验收，不回溯阻塞已完成 scope。

Task 5A 的 incremental preflight 使用两次同一 strict shared reader：第一次以空
`selectedSourceIds` 验证 pointer/catalog/report 并取得完整、严格递增的 source ID；空
catalog 对 B2 schema 合法，但对 incremental consumer 返回 `LOCAL_STATE_INVALID`。第二次
以全部 source ID 验证全部 cleaned outputs。两次 canonical `pointer_bytes` 必须逐 byte
相同；不同或第二次因第一轮派生 ID 失效而返回 `INVALID_CLEANING_INPUT`，统一为 pointer
path 上的 `LOCAL_STATE_INVALID`。其他 reader missing/invalid/I/O failure 保留精确分类；
preflight CLI 将 expected failure 映射为 exit 2、I/O failure 映射为 exit 5。

`ensureSourceIdKey({keyPath,backupPath,currentPointer})` 只在两份 key 都缺失时检查
cleaning state。`currentPointer` 非 null 时必须调用 shared reader，且 pointer 一旦存在就
禁止重新生成 identity key：reader 成功后无论 catalog 是否为空，若并发复读仍确认两份
key 缺失则返回 `SOURCE_ID_KEY_LOST`，该分支 key 持久写入为零；reader failure 保留其
code/path/operation。`currentPointer:null` 是首次 baseline bootstrap capability，上层必须
将它与首次 pointer publication 串行化；函数在 bootstrap 开始和每次 key publication 前
复核固定 pointer 缺失，已存在或中途出现时返回 `SOURCE_ID_KEY_RACE`，不得继续发布新
copy。已 no-clobber 发布的 key 不因随后发现竞态而 truncate，避免破坏可能已采用该 key
的并发状态；后续 non-null 调用可从 surviving copy 恢复另一份。

Key leaf 读取也必须在 open 前 no-follow `lstat`，以 `O_NONBLOCK|O_NOFOLLOW` 打开，
在分配/读取前以稳定 `fstat` 拒绝非 regular、identity drift、非 `0600` 或 size 不等于
32 bytes 的对象；实际 FIFO/socket/device 及 post-check replacement 不得阻塞。

`run_sha256` 是 exact canonical `RunPreimage` 的 SHA-256。Preimage 精确为
`{schema_version:"1.0.0", cleaner_version, sources}`；`sources` 按 `source_id`
严格排序且唯一，每条包含生成 catalog/report 的每个非派生语义字段、
`cleaned_relative_path`、output SHA-256、Task 4 audit、changes/warnings，以及经 hash
绑定的 reviewer carry-forward classification/status/owner/version。只排除 catalog
`cleaned_path`、report `run_sha256` 和 pointer paths/hashes 这些依赖 eventual run ID
的值。先计算 run ID，再渲染路径；catalog/report 是 preimage 的纯投影，
不允许独立语义输入。Task 8 classification-only 变更因此必然产生新 run ID。
Pointer-selected catalog row 精确删除 source 的 `cleaned_relative_path`、`audit`、
`changes`、`warnings`，增加 `schema_version:"1.0.0"`，并增加由 run ID 与
`cleaned_relative_path` 派生的 `cleaned_path`。只有 caller 在 `selectedSourceIds`
明确指定的 output 才被打开、hash 验证和返回；全量验证由 caller 传完整 source ID
列表表达。Reader 对每个 ancestor 使用 Node no-follow directory identity snapshot、
对 leaf 使用 `O_NOFOLLOW` 并前后复核 ancestor/path identity；`nlink` 必须为正且稳定。
全部 sources 的 audit 在 reader 中验证 exact schema、canonical hash、range/order/
containment 和声明间结构关系；只有 selected output 额外读取并验证整文件
`cleaned_sha256`。Reader 不为 audit byte binding 打开 unselected output，也不重放 prepare
阶段已经写入 RunPreimage identity 的 raw/output token 计算。
Metadata source/output spans 在各自坐标中 pairwise non-overlap；body non-whitespace count
不得超过 body bytes 扣除 image output-token bytes 的结构上限。`preserved:true` 不推出
metadata before/after 或 image source/output digest equality。Selected outputs 使用低 FD
两阶段 stable stat/close -> aggregate gate -> reopen/same-facts/read/hash/close。所有 leaf
open 前先 `lstat` 拒绝 non-regular/symlink，并加 `O_NONBLOCK` 防止竞态 FIFO/socket/device
阻塞。Change rule 与 kind 使用五 delete、两 normalize、一 append_eof 的 exact mapping。
Canonical JSON 递归排序 object key、保留 array 顺序、拒绝 JSON 无法确定表示的值，
并写且只写一个终止 LF。Catalog JSONL 按 `source_id` 排序，每条为一个
canonical object 加 LF；report 和 pointer 都是 canonical JSON 加一个终止 LF。

Read-only prepare 产生 immutable `CleaningPlan`。其 canonical manifest 绑定
`state_mode`、exact `expected_prior_pointer`/`expected_prior_pointer_sha256` 或 null、
prior run/catalog/report identities、sorted complete `prior_source_ids`、完整 RunPreimage、按 path
排序的 artifact path/hash/size manifest、desired pointer object/hash 和 registered count。
Artifact bytes 只在 in-memory plan 携带，不进入 canonical manifest。Incremental
prepare 必须自己使用 shared reader，input IDs 必须精确等于全部 verified
base IDs + explicit additions，否则返回 `SOURCE_SET_DISCONTINUITY`；reviewer provenance
也只能内部派生。Stage 只接收
exact plan 并返回携带 plan manifest/hash 和 derived paths 的 verified `StagedRun`；
publish 只接收该 staged plan，不在 publish 时采样新 prior。P0 plan 在 P1/P2
之后必须 stale。Prepare/stage/publish/read/recovery 使用各自 exact success
payload 与共享 closed `CleaningError`；cleaner throw 精确为 `CLEANER_FAILURE`。
Dry-run 精确返回 base identity、per-source statuses/hashes/warning codes、artifact
manifest、desired pointer、sorted conflicts 与 `persistent_writes_occurred:false`，CLI 不暴露 bytes。

Dry-run 必须计算完整 run、所有产物 hash、目标 pointer 和只读冲突报告，
且不创建或修改任何目录、文件、临时文件、lock、过渡 claim 或 pointer。
#### B5 durable single-writer staging 冻结契约

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

1. 只导出 complete B5 API；exact options misuse 与 fixed-path aliases；
2. B4 golden plan 产生 exact `StageIntent`、unique LF、intent hash/temp name、`StagedRun`、final bytes 与 path set；
3. empty corpus 与 zero-byte catalog/temp；
4. manifest/hash、mode/prior binding、run/pointer/hash/count、artifact path/order/missing/extra/hash/size/bytes、catalog/report/source projection、array descriptor/iterator/accessor/Proxy 与 post-call Buffer mutation；
5. plan mismatch 以 zero writes 优先于 staging/run conflicts；
6. staging absent/empty/intent exact，以及 intent candidate empty/prefix/full；
7. intent unknown key、no LF、extra LF、wrong bytes/name、symlink、FIFO、socket、nonregular、extra entry 与 conflicting directory；
8. 无 durable intent 的 final partial 被拒绝；无 intent 的 complete exact final 只有在发布 intent 后才可复用；missing-intent adoption 的 intent candidate durable states crash/retry 覆盖 empty/strict-prefix/full，且仅在 final run 保持 complete exact 且无 artifact temp 时接受；
9. artifact temp absent/empty/prefix/full，包括 zero-byte artifact；
10. 第一个 new canonical link 前，所有 required missing temps 已完整存在；
11. 每个 canonical publication prefix、exact canonical reuse 与 canonical-plus-valid-residue cleanup；
12. mismatching canonical/temp、extra final entry、conflicting directory、symlink、FIFO、socket 与 ancestor traversal failure；
13. exact completed second call 返回 staged 且 persistent writes 为 false；
14. first-conflict ordering 与 exact failure path/source shape；
15. first mutation 前后的 injected I/O operations，包括 later failure 时 sticky true 与 close-failure precedence；
16. representative durable boundaries 的真实 child-process crash/retry：directory creation、ordinary intent candidate sync/link/dir-sync/cleanup、complete exact no-artifact-temp final run 的 missing-intent adoption intent candidate write/sync/link/dir-sync/cleanup、artifact temp sync、canonical link/parent-sync/temp-cleanup 与 final verification；
17. root alias retarget 与 parent/leaf identity replacement races；
18. success values exact、detached、frozen；
19. serialization boundary 由 orchestration documentation/test 覆盖，tests 不声称 overlapping cross-process staging safety。

Tests 只使用 repository 外的 real synthetic temp directories，不读取 root Markdown 或
repository `.local`。Intent bytes/paths/hashes/result objects 的 expectations 独立推导。需要
crash/failure injection 时，用 child process 加 `syncBuiltinESMExports()` patch narrow Node
filesystem syscall boundary 后动态 import production code；不得增加 production test parameter
或 dependency-injection API。

#### B6 publication and B7 recovery

Pointer 发布只在 final run 验证后进行：同目录
pointer temp 写入并 fsync，atomic rename 覆盖 `current-cleaning.json`，再 fsync pointer
目录。Rename 前故障保留旧 pointer；rename 后只可见旧或新 pointer，两者均引用
完整不可变 run。

协作发布者不使用 lock-free CAS，Node atomic rename 也不是 CAS。每个 publisher
先将完整 canonical commit intent（含 owner PID/nonce、prior/desired pointer hashes/desired
pointer）写入唯一 state-dir temp 并 fsync，再以 atomic no-clobber hard-link 发布为
`.local/state/cleaning-commit.lock`，然后 fsync state dir。发布者验证 temp 与固定 lock
仍为同一 inode 后，移除自己的 temp 并再 fsync state dir；固定 lock 持续
引用该 inode。这样没有空锁窗口。
锁已存在返回 `CLEANING_COMMIT_LOCKED` 且不修改 pointer。持锁期间重读 pointer：
exact prior 可提交，exact desired 只可在 full selected-run verification 后幂等返回，
其他 bytes 返回 `STALE_POINTER_TRANSITION` 且永不 rename。系统不创建
transition claim，claim 不是 recovery prerequisite；publisher 持锁到 pointer rename、
state-dir fsync 和 completion record 后，
只在 no-follow/inode/bytes 证明锁仍属于自己时移除锁并 fsync state dir。

Crash-surviving lock 不得自动偷取。显式 recovery 必须收到
`RECOVER_INTERRUPTED_CLEANING_COMMIT`，先用 no-follow handle/path identity 验证完整
lock intent/plan/desired run，再在任何 recovery path write 之前对原 publisher
`owner_pid` 执行 `kill(pid,0)` fail-closed 判定：成功或 `EPERM` 标记 owner
alive，只读验证 historical targets 后返回 `RECOVERY_OWNER_ALIVE` 且
`persistent_writes_occurred:false`；只有 `ESRCH`
可继续。如果 root publication 前已经发生 recovery directory creation，必须再做一次
owner gate。Current pointer 为 exact prior 可完成提交，exact desired
可完成验证/记录，其他 bytes 只退役锁而永不 rename。

Recovery ownership 使用按 target commit-lock canonical bytes SHA-256 分隔的 append-only
generational lease chain。Exact directory 是
`.local/state/cleaning-recovery-leases/<target_commit_lock_sha256>/`；root 只是
`lease-root.json`，每个 canonical hash 为 `<previous_lease_sha256>` 的 node 最多只有
一个 `lease-after-<previous_lease_sha256>.json` child。`RecoveryLease` 精确含
schema/record kind、target hash、previous hash/null、generation、owner PID/nonce。Root
是 generation 0；child 必须 parent hash 一致且 generation + 1。Candidate temp 只能是
`.lease-<root-or-previous-sha256>.<owner_pid>.<owner_nonce>.tmp`，用 complete-write/
file-fsync/no-clobber-hard-link/dir-fsync/same-inode-proof/own-temp-unlink/dir-fsync 发布。
Lease nodes 永不 unlink/覆盖；只能在 exact path/inode/bytes/link-count/parent proof
后清理 non-authoritative candidate residue。

Recovery root 与 target-hash child 只用 non-recursive mkdir，success 后立即 fsync
parent；`EEXIST` 使用 `O_DIRECTORY|O_NOFOLLOW`/`fstat` 和 no-follow path snapshot
比较 `dev/ino`。全部 child operation 前后重验 parent identity；mkdir 后、target/root
前 crash 按相同顺序 re-enter，不递归删目录。Root 前必须先发布
immutable `target.json`，其 `RecoveryTarget` 绑定 target hash 与 exact commit-lock
bytes base64。Decoded bytes 包含唯一 terminal LF，hash 必须等于 field/directory
basename，并解析为 exact intent。Target temp 只是
`.target.<owner_pid>.<owner_nonce>.tmp`，按 complete-write/fsync/no-clobber/dir-fsync/
same-inode proof/own-temp unlink/dir-fsync 发布。Root 只在 target durable+reverified 后发布。

Lease node hash 精确对 canonical node file bytes（包含唯一 terminal LF）计算，用于
命名唯一 child 与 child `previous_lease_sha256`。Target/lease candidates 均用
`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` mode `0600`，existing path 永不 truncate。
Own temp 在 inode/bytes/node outcome 证明后清理；other-owner temp 只在 owner `ESRCH`
且 path/inode/bytes/link-count/parent 稳定时清理，success/`EPERM` 不动。Dead owner
必须区分 node absent+link-count 1、same inode 和 different inode；三者只 unlink
candidate 并立即 fsync target dir，永不 unlink node。Unknown target-dir entry fail closed。

Loser 验证 winner；tip owner 的 `kill(pid,0)` success/`EPERM` 为 alive，只有
alive 时返回 `CLEANING_RECOVERY_LOCKED`，只有 `ESRCH` 允许 contenders 在唯一
successor path 上竞争新 generation。在每次
pointer mutation、terminal write 和 target unlink 前，caller 重验 target
path/inode/bytes、root-to-tip full chain、tip PID/nonce 为自己，且 tip successor 不存在。
老 commit lock 在 pointer/terminal writes 完成前持续阻断 publisher。

Stable `TransitionCompletion` 精确为以下 actor-neutral canonical object：

```js
TransitionCompletion = {
  schema_version: "1.0.0",
  record_kind: "completion",
  commit_lock_sha256: sixtyFourHex,
  plan_manifest_sha256: sixtyFourHex,
  expected_prior_pointer_sha256: sixtyFourHex | null,
  desired_pointer_sha256: sixtyFourHex,
  desired_pointer: CurrentCleaningPointer
}
```

它的 path 精确为
`.local/state/cleaning-transitions/complete-<commit_lock_sha256>-<desired_pointer_sha256>.json`。
Stable `TransitionRetirement` 只包含
schema/kind、plan/commit-lock/expected/desired/observed hashes 和 `stale_pointer` reason，不含
actor。Publisher/任一 recovery generation 对同一 commit attempt 生成 exact same
actor-neutral bytes；同 plan 的第二 publisher 使用自己的 commit-lock hash/path，attempt A
的 completion 不能完成或混淆 attempt B。
Pointer outcome 与 terminal record 持久化/验证/dir-fsync 后，active tip 重做上述证明，
unlink target commit lock 并 fsync `.local/state`，此后不再写 pointer/terminal。
Terminal 后 crash 的新 generation 只重试幂等 target unlink/state fsync；已完成
lease directories 只是 audit evidence，不阻塞新 target hash。

Recovery entry 只能按以下 ordered state machine 执行：

1. 稳定 no-follow 读取 fixed commit path；present 时将 exact file-byte hash 设为
   `current_target_sha256`，验证 intent，并在任何 recovery write 前执行 original-owner
   liveness gate；absent 时设 `current_target_sha256=null`。
2. Recovery root 若存在，先用 no-follow identity 打开/验证，再按 bytewise basename
   order 扫描 direct 64-lowercase-hex target directories。
3. 每个 basename 不等于 `current_target_sha256` 的 non-current directory 都必须有
   complete valid `target.json`、valid root-to-tip chain 和恰一个从该 target C 派生的
   C-bound terminal。Partial state 无 mutation exemption；missing target/root/terminal
   为 `RECOVERY_UNRESOLVED_TARGET`，conflicting/malformed/forked/multiple outcome 为
   `RECOVERY_TARGET_AMBIGUOUS` 或 `LOCAL_STATE_INVALID`。当 `target.json` 缺失时，exact
   recognized `.target.<owner_pid>.<owner_nonce>.tmp` 只验证 filename、private regular
   mode、no-follow identity、parent continuity 与 topology；candidate bytes 视为 opaque
   incomplete evidence，不做增量 Base64、UTF-8、JSON、schema 或 hash 推断，并在目录级
   返回零写入 `RECOVERY_UNRESOLVED_TARGET`。该分类不证明 candidate 正确，也不授权清理、
   ownership 或任何 mutation。
4. 只有 basename 等于 non-null `current_target_sha256` 的 directory 可处于以下
   ordered prefix：empty；只有 recognized `.target.*.tmp` 且 target absent；durable exact
   target、root absent 且可带 recognized residues；exact target、valid root-to-tip chain、
   terminal absent 或 exact。当前 fixed C 已提供唯一 expected target bytes，因此 current
   candidate 必须是该 bytes 的 exact prefix；任一 durable `target.json` 存在时，其 candidate
   也必须是 durable bytes 的 exact prefix。Unknown candidate name、non-private/non-regular
   type、unstable identity/topology、lease without target/root、alternate node 或
   target/fixed-lock bytes mismatch 一律 fail closed；这里的 malformed candidate 不包含
   第 3 项所定义的 historical missing-target opaque bytes。
5. Current owner alive 时只读验证 current prefix；不得 mkdir、发布 target/root、清理
   candidate 或 repair。所有 non-current target 先通过，随后返回
   `RECOVERY_OWNER_ALIVE` 与 `persistent_writes_occurred:false`。
6. Current owner dead 且 non-current pass 完成后，只能按
   `directories -> target.json -> root lease -> successor lease -> pointer/terminal ->
   target unlink -> state-dir fsync` re-enter current prefix。
7. `current_target_sha256=null` 时没有 partial exemption。Fixed C2 present 时只有 C2
   得到 mutation exemption；不完整 C1 是 historical unresolved，C2 bytes 永不得完成
   C1。C1 只有 recognized target candidate 且 `target.json` absent 时，candidate contents
   仍按第 3 项视为 opaque incomplete evidence，必须零写入返回 unresolved。

Historical target C 只从自己的 target bytes 派生 exact C-bound completion path/bytes，
并只搜索 C-bound retirement，必须恰有一个 valid outcome。另一个 same-plan target 的
completion 与 C 无关。Fixed path absent 时全部 historical targets 必须 resolved，fsync
`.local/state` 后才 `no_unresolved_target`。检查 C1 时 fixed path 若是不同 C2，C1 只验
terminal/fsync，绝不 touch C2；C2 只能通过自己 owner-death gate 与 target directory 处理。
推导 C1 terminal 时必须使用 C1 `target.json` decoded lock 自己的 validated layout，禁止
借用 current/fixed C2 layout。同一次 recovery invocation 第一次需要 terminal evidence 时，
必须锚定 `cleaning-transitions` 的 absent/present、directory identity 与完整 names snapshot；
后续 targets 只在重验该首次 snapshot 后从中选择自己的 C-bound outcome，任何
absent/present、identity 或 names drift 都返回 `LOCAL_STATE_INVALID`，不得把新观察覆盖为
新的扫描基线。

完全相同的第二次 run 只在重新验证当前 run 的 catalog、report、每个输出 hash 和该
commit attempt 的 C-bound completion 后返回 `already_current`。Recovery 的 exact-desired
outcome 与 terminal cleanup 也只接受当前 target C 的 C-bound completion。已有匹配但非当前的
run 可复用，但 pointer commit 前不改变权威。

Corpus 编排直接验证并消费 `CleanWechatResult.outputBytes`、`metadata`、
`bodyImages`、`changes`、`status`、`warnings` 和 authoritative `audit`，不重新解析输出，也不用正文
中的伪 metadata 替代位置化结果。重复 `source_id`、输入/输出合同无效、
cleaner 抛错或 I/O 失败会中止整个操作且 pointer 不变。`needs_review` 是可处理
的单来源结果；`strict=true` 时任一该结果返回 `STRICT_CLEANING_FAILED`
并且持久写入为零，`strict=false` 时可使用精确 `outputBytes` 与显式复核状态纳入。
清理完整性使用独立 `cleaning_status="cleaned"|"needs_review"`；reviewer-facing
`processing_status` 另为 `new|cleaned|needs_review|ready|needs_ocr|needs_medical_review`。
Audit 在且仅在 cleaning success 时非 null。编排层只用 audit 产生 mechanical
`text|mixed`，并从自己的 verified pointer window 内部派生 prior reviewer state。
只有本次清理成功，且 raw/cleaned/canonical-audit hashes 和 cleaner version
全部精确等于 `review_state_bound_raw_sha256`、`review_state_bound_cleaned_sha256`、
`review_state_bound_audit_sha256` 和 `review_state_bound_cleaner_version`，才 carry forward
reviewer-owned `image_dominant`、
`needs_review|ready|needs_ocr|needs_medical_review` 和 version；否则重置 mechanical
owner/version 与当前 mechanical processing state。每个 new/reset mechanical source 都序列化
owner `mechanical`、version 0，并将 bound raw/cleaned/audit/cleaner-version 四字段精确
设为本 run 当前值；`audit_sha256` 只在 cleaning needs review 时为 null。
Reviewer-owned source 还必须 version > 0、cleaning success 和 non-null audit/hash，否则
使用 exact mechanical serialization。Task 5 可保留这些已验证状态，
永不发起它们；carry-forward state 是 RunPreimage 一部分。

所有清理状态/store/corpus API 都接收 `rootDir`，并将 runs、tmp、pointer、
transitions 和 commit lock 精确限定在同一 repository 下的 `.local/cleaned/runs`、
`.local/tmp`、`.local/state/current-cleaning.json`、`.local/state/cleaning-transitions`、
`.local/state/cleaning-commit.lock` 和
`.local/state/cleaning-recovery-leases/<target_commit_lock_sha256>/` exact target/root/child/temp topology。
持久 path 只允许 canonical POSIX repo-relative form，
拒绝 absolute/backslash/dot segment/NUL/symlink traversal。状态模式只为内部
`initial_verified_baseline` 或 `incremental`；初始标签只由 Task 8 Gate 0/frozen manifest
信任链传入，不是 CLI override，incremental 必须先完成 strict current-state read。

每个 API 的 success payload 独立封闭；只共享 `ok:false` 的 closed
`CleaningError`。Expected code 包含 strict/input/result/duplicate/source-continuity/
local-state/cleaner/plan-binding/staging/run/commit-lock/stale-transition/recovery failures，并使用
`persistent_writes_occurred:boolean`；cleaner throw 精确是 `CLEANER_FAILURE`，I/O 统一为
`CLEANING_IO_FAILURE`。Clean CLI 精确
将 success/expected/IO 映射为 0/2/5；recovery 缺确认串为 4。
Recovery success 独立表达 `recovered|stale_lock_retired|terminal_cleanup_completed|
no_unresolved_target`，selected/current target hashes、active lease/terminal path 可为 null，并精确报告
commit-lock cleanup 是 unlinked+fsynced、already absent 或 not applicable。

## 9. 完整性、OCR 与状态

每条来源使用以下状态之一：

- `new`
- `cleaned`
- `ready`
- `needs_review`
- `needs_ocr`
- `needs_medical_review`
- `fetch_failed`
- `duplicate`
- `superseded`

正文不足但含正文图片时：

1. 在本地保存正文图片。
2. 对图片执行 OCR。
3. 把 OCR 结果与图片顺序、来源文件和图片 URL 绑定。
4. Codex 复核 OCR 是否足以支撑摘要。
5. 不足时保留 `needs_ocr`，不根据标题补写。

远程图片下载失败时不删除原来源，也不把该资料标记为 `ready`。

## 10. 三层去重

### 10.1 确定性重复

相同 canonical URL、相同原始指纹或相同清理正文指纹视为重复导入，不新增知识条目。

### 10.2 疑似重复

标题、发布日期、正文相似度和内容类型共同生成候选关系。疑似重复只进入复核，不自动覆盖。

### 10.3 语义复核

Codex 判断每份资料对知识体系的作用：

- 结构完整、定义机制步骤边界齐全的资料优先成为 `canonical`。
- 速查卡成为 `card`。
- 独立案例成为 `case`。
- 明确比较两个模型的资料成为 `comparison`。
- 同一课程或文章序列成为 `series`。
- 相关但不能合并的资料成为 `related`。

现有 5 组规范化同名资料和约 61 对长短版构成首批复核队列。

不同数字体系、不同理论层级或不同适用场景不能仅凭标题相近强行融合。例如，问题重构的五步、五层、六层、七种和十种体系必须保留各自边界；八种与十种知识整合方式应建立映射，而不是默认后者覆盖前者。

## 11. 深度总结与跨文档综合

每份来源先形成结构化摘要：

1. 核心问题。
2. 核心结论。
3. 关键概念与定义。
4. 原理或因果机制。
5. 方法、步骤与适用场景。
6. 局限、风险和常见误用。
7. 对所属模型或章节的独有贡献。

跨文档融合时：

- 以最完整来源作为结构骨架。
- 只吸收其他来源的独有观点、案例、步骤和边界。
- 不重复堆叠同义内容。
- 冲突观点并列呈现并注明差异。
- 来源中的事实主张默认标记为来源观点。
- 只有经过独立核验的内容才能标记为已验证结论。
- 健康医学和高风险建议必须显示证据边界与专业复核提示。
- 每个模型保留全部贡献来源的标题、URL、发布日期和内容作用。

## 12. 模型知识文件

每个去重后的模型或方法使用稳定 ID 和独立 Markdown 文件。文件至少包含：

1. 核心定义。
2. 底层机制。
3. 适用问题与识别信号。
4. 不适用场景。
5. 操作步骤。
6. 示例。
7. 常见误用。
8. 验证方式。
9. 前置模型。
10. 推荐组合。
11. 替代模型。
12. 停止条件。
13. 来源与证据边界。
14. 与 Codex 共学应用卡。

模型关系不能只存在于自然语言中，还必须写入 `knowledge/problem-routes.json`，供 Codex 和网页问题匹配器读取。

## 13. 与 Codex 共学应用卡

每个模型或方法只维护一张应用卡，不与 418 份原始资料一一重复。

应用卡包括：

- 何时使用。
- 用户需要提供的背景。
- 快速诊断提问模板。
- 深度分析提问模板。
- 行动方案提问模板。
- 推荐的主模型和辅助模型。
- 期望输出结构。
- 追问、验证和修正方法。
- 停止条件和专业升级条件。
- 一段完整的人机协作示例。

统一输入框架：

```text
情境：
目标：
已知事实：
仍属假设的判断：
约束：
已经尝试：
希望得到的输出：
```

Codex 的统一处理约定：

1. 先提取目标、约束、时间范围、风险和证据。
2. 从问题路由中找出候选模型。
3. 选择一个核心模型和最多两个辅助模型。
4. 简要说明选择理由。
5. 关键事实不足时只问最有价值的问题。
6. 区分事实、假设和推断。
7. 按“问题重述、模型匹配、综合分析、行动步骤、验证指标”输出。
8. 模型失效、高风险或需要专业人士时明确停止。

真实对话和个人信息只记录在 `.local/learning-notes/`。只有经用户确认、完成去标识化且具有通用价值的经验才能进入公开案例。

## 14. 增量处理流程

每次用户新增 Markdown 或提供 URL 时：

1. 检查 Git 分支和工作区，避免覆盖用户未提交改动。
2. 发现 `inbox/` 和根层未登记输入。
3. 保存本地原始快照。
4. 计算原始指纹。
5. 先检查 EOF newline；缺失时保留原 bytes 并进入 `needs_review`，存在时再机械清理并提取元数据。
6. 检查正文完整性。
7. 必要时下载正文图片并 OCR。
8. 生成来源级结构化摘要。
9. 检查确定性重复和疑似重复。
10. 选择主章节、标签、内容类型和相关模型。
11. 更新模型知识文件和 Codex 应用卡。
12. 更新章节总览、来源索引、manifest 和问题路由。
13. 重建完整 HTML。
14. 执行全部验证。
15. 向用户报告新增、更新、重复、待复核、OCR 和失败项目。
16. 仅在用户明确确认后 commit、push 和发布。

增量模式必须先通过 `current-cleaning.json` 稳定读取并验证当前 run；缺失或
无效 pointer 不得继续。新 Markdown 或 URL 登记必须使用已验证的当前全量
来源加新来源构建一个完整自包含的 immutable run，然后只以一次 pointer
transition 提交；不允许单独改写 catalog 或 report。只有初始 baseline 可在 pointer
不存在时创建第一个 run。

## 15. HTML 产品设计

最终产物为 `site/index.html`：

- 单文件。
- CSS、JavaScript、目录、知识索引和问题路由全部内嵌。
- 可离线双击打开。
- 可在 GitHub Pages 子路径下运行。
- 不使用 CDN、外部字体、在线 API 或分析追踪。
- 用户输入只在浏览器本地处理。

### 15.1 页面结构

- 顶部：全局搜索、章节入口和“我遇到一个问题”入口。
- 左侧：13 章目录和二级目录。
- 中间：章节总览、模型正文、步骤、示例和边界。
- 右侧：Codex 应用卡、模型关系和来源。
- 移动端：目录抽屉与单列布局。

### 15.2 核心功能

1. 全文搜索：模型、概念、问题信号、场景和标签。
2. 问题匹配器：基于策展规则推荐一个核心模型和最多两个辅助模型。
3. Codex 提问生成器：生成可复制的结构化提问。
4. 模型关系导航：前置、组合、替代、易混淆和停止条件。
5. 来源追溯：标题、URL、发布日期、内容类型和复核状态。
6. 风险提示：健康、高风险和证据不足内容采用显著标识。
7. 阅读辅助：章节折叠、复制、返回顶部、打印和键盘操作。

问题匹配器只负责本地导航，不把关键词匹配结果伪装成 AI 判断。

## 16. 技术栈

- Node.js：24.18.0 LTS。
- 包管理器：npm，使用 lockfile。
- Markdown 渲染器：精确锁定 `markdown-it@14.3.0`。
- `markdown-it` 设置：
  - `html: false`
  - `linkify: false`
  - 不加载插件
  - 保留 Markdown 硬换行语义
  - 外部链接由自定义 renderer 增加 `rel="noopener noreferrer"`
- 浏览器端：原生 HTML、CSS 和 JavaScript。
- GitHub Actions：
  - `actions/checkout@v6`
  - `actions/setup-node@v6`
  - `actions/configure-pages@v5`
  - `actions/upload-pages-artifact@v4`
  - `actions/deploy-pages@v4`

`markdown-it` 只在构建时运行。发布后的 `site/index.html` 不加载 npm 包。

## 17. GitHub Pages 发布

远程仓库：

- `https://github.com/zjgulai/deep-thinking-mode`

用户在 Settings → Pages → Build and deployment 中选择 GitHub Actions。

Workflow：

- 在 `main` push 时运行。
- 支持 `workflow_dispatch`。
- 使用 `contents: read`、`pages: write` 和 `id-token: write`。
- 使用 `github-pages` environment。
- 安装锁定依赖。
- 执行公开范围检查、测试和构建。
- 只上传 `site/`。
- 成功后使用 `actions/deploy-pages` 发布。
- 使用 concurrency 避免并发部署覆盖。

预期默认地址为：

- `https://zjgulai.github.io/deep-thinking-mode/`

首次 push 之前必须重新确认远程身份、仓库可访问性、公开安全历史和 Pages 设置。

## 18. 失败处理

- URL 无法访问、需要登录、付费墙、JS-only 或抓取不完整：记录 `fetch_failed`，保留旧知识版本。
- URL 重定向到不安全地址或非 HTTP/HTTPS scheme：拒绝抓取。
- OCR 结果不足：保留 `needs_ocr`。
- 重复或分类不确定：保留 `needs_review`。
- LLM 语义输出缺少来源支撑：不得进入 `ready`。
- 构建失败：不覆盖上一个可用 HTML。
- 发现未处理输入：阻止发布。
- 发现公开 Git 树或 Pages artifact 包含本地资料：阻止发布。
- 单条资料失败：严格模式下阻止知识版本发布，除非该资料已被明确标记为允许延期处理。

## 19. 验收标准

### 19.1 基线与覆盖

- 来源索引包含 418 条当前来源，且每条只出现一次。
- 13 章初始资料计数合计为 418。
- 418 个原文 URL、作者和日期均可追溯。
- 5 组规范化同名资料和约 61 对长短版都有明确关系或复核状态。

### 19.2 清理

- 微信 CSS 指纹命中为 0。
- `data:image/svg+xml` 操作图标命中为 0。
- 微信阅读、赞、分享、推荐、留言组合操作栏命中为 0。
- 原文地址和作者日期元数据仍为 418。
- 237 张正文图片在本地清理层保持可追溯。
- 非空行的 Markdown 双空格硬换行没有被全局清除。

### 19.3 知识质量

- 每个模型有稳定 ID、一个主章节、标签、关系和来源。
- 每个模型有完整 Codex 共学应用卡。
- 不同理论体系没有仅凭标题相似被强行融合。
- 冲突观点和证据边界可见。
- 25 份图片主导资料已完成 OCR 或明确标记 `needs_ocr`。
- 健康医学内容带复核提示。

### 19.4 HTML

- `site/index.html` 可离线打开。
- 不依赖 CDN、外部字体、在线 API 或服务端。
- 目录、搜索、问题匹配、模型关联和提示词复制的数据完整。
- 所有内部锚点有效。
- 外部链接使用安全属性。
- 危险 HTML、事件属性、iframe 和表单不进入产物。
- 来源计数与 manifest 一致。

### 19.5 发布安全

- 公开 Git 历史不包含原始全文、清理全文、OCR、bundle 或私人共学记录。
- Pages artifact 只包含 `site/`。
- Actions 构建和部署成功。
- 发布网址可访问且展示的知识版本与本地构建一致。

## 20. 用户确认记录

用户已确认：

- 使用去重后的综合知识体系，而非逐篇全文排列。
- 由用户与 Codex 共同负责未来语义总结和归档。
- 同时交付本地单文件 HTML 和 GitHub Pages 分享网址。
- 原始 418 篇全文不公开。
- 采用“确定性本地处理 + Codex 语义策展 + 单文件静态 HTML”方案。
- 使用 13 章目录。
- 使用本文定义的清理、去重、综合和失败处理规则。
- 每个去重后的模型或方法挂载 Codex 共学应用卡。
- 使用本文定义的 HTML 阅读与联合解题体验。
- 使用 GitHub Actions 发布，并保留 commit、push 和发布确认门。
- 接受 `markdown-it` 作为唯一构建依赖。
