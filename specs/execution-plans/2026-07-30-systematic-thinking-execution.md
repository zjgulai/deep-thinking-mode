# “系统化思维”完整执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从当前 Phase A Task 5/B5 的真实断点继续，完成私有来源保护、确定性清洗、语义策展、单文件“系统化思维”知识网站、公开历史重建和 `zjgulai/deep-thinking-mode` GitHub Pages 发布。

**Architecture:** 本计划是四份已存在、可独立验收子计划的总编排与差异修正规格；子计划继续提供逐接口、逐测试的实施细节，本计划冻结当前断点、跨计划数据合同、执行顺序和审批门。原始全文、OCR、证据与共学记录只存在 `.local/`，公开 `knowledge/` 只保存综合知识和最小来源索引，构建器把全部公开数据、CSS 与 JavaScript 原子内联到唯一的 `site/index.html`，最后从字面量公开路径清单创建唯一无父提交并部署到 Pages。

**Tech Stack:** Node.js `24.18.0`、npm、原生 ESM、`node:test`、`markdown-it@14.3.0`、原生 HTML/CSS/JavaScript、Graphify CLI `0.9.28`、Git plumbing、GitHub CLI、GitHub Actions、GitHub Pages。

## Global Constraints

- 只在 `main` 分支工作，禁止 worktree。
- 每条 shell 命令必须以 `rtk` 开头。
- 当前原始历史基线必须保持为 `f876ce90d24ed486cae4060b1a4fe7b0813e9492`，直至 Gate 4B 激活唯一公开 root commit。
- 不执行普通开发 commit；Gate 4A 前所有实现均保持为已审计工作区文件，最终只允许一个经批准、无父提交的公开历史。
- 未经对应审批门，不迁移原始资料、不冻结语义模板、不创建 root commit、不移动 `main`、不配置 remote、不 push、不启用 Pages。
- 原始 Markdown、清理全文、OCR 结果、证据片段、绝对路径、HMAC key、私人共学记录、Graphify 图和 Graphify 项目级安装文件不得进入公开 Git 历史或 Pages 构件。
- 公开仓库只允许综合知识、最小来源索引、构建与检查工具、测试、说明文档、工作流和 `site/index.html`。
- 每份资料只能有一个主章节；跨主题关系使用标签、模型关系和问题路由表达。
- 图片型或抓取不完整资料不得按标题补写，必须保持 `needs_ocr`、`needs_review` 或 `fetch_failed`。
- 每个 `ready` 知识模型必须包含一张完整“与 Codex 共学应用卡”。
- 网站产品名固定为“系统化思维”，公开仓库固定为 `zjgulai/deep-thinking-mode`，Pages 子路径固定为 `/deep-thinking-mode/`。
- 发布产物只有 `site/index.html`，运行时不得依赖 CDN、外部字体、远程图片、远程视频、客户端 API、analytics、service worker、XHR 或 `fetch`。
- 网站视觉与交互以 `docs/superpowers/specs/2026-07-30-systematic-thinking-site-design.md` 为唯一新增设计权威；旧计划中的产品名、仓库名、子路径和视觉描述若冲突，以该规格为准。
- Graphify 只分析公开代码与构建工具；必须使用 `--code-only`，不得使用 `--no-gitignore`，`.codex/` 与 `graphify-out/` 永久本地忽略。
- 不使用 `git reset --hard`、`git checkout --`、递归删除、force push、`git add .`、`git add -A` 或真实 index 组装公开树。
- 所有非琐碎任务按 TDD 执行：先确认针对性测试失败，再写最小实现，再运行针对性测试与受影响回归。
- 每个任务通过实现审查和质量审查后才进入下一个任务；任何第三次仍失败的验证必须停止局部 patch，重新审查数据流、状态边界和依赖关系。

---

## 1. 权威文档与执行顺序

以下文件必须由每个实施者完整阅读；本计划只负责编排，不复制其已经冻结的逐步测试和接口合同：

1. `AGENTS.md`
2. `docs/superpowers/specs/2026-07-27-brain-model-knowledge-system-design.md`
3. `docs/superpowers/specs/2026-07-30-systematic-thinking-site-design.md`
4. `docs/superpowers/plans/2026-07-27-public-safe-repository-and-cleaning-pipeline.md`
5. `docs/superpowers/plans/2026-07-27-semantic-curation-and-codex-cards.md`
6. `docs/superpowers/plans/2026-07-27-single-file-knowledge-site.md`
7. `docs/superpowers/plans/2026-07-27-github-pages-release.md`

固定顺序为：

```text
合同校准
  -> Phase A 当前断点修复
  -> Graphify 本地代码图
  -> Phase A 完成与 Gate 1
  -> Phase B 合同、28 份 pilot 与 Gate 2
  -> Phase B 全量批次与 Gate 3
  -> Phase C 单文件网站
  -> Phase D 本地发布安全层
  -> Graphify/隐私/视觉/构建总审计
  -> Gate 4A/4B/5/6
```

Graphify 安装可在 Phase A 写代码期间存在，但首次完整代码图必须在合同校准后、继续大规模实现前生成；发布前必须重新生成并比较一次。

---

## 2. 当前真实断点

- Git：`main`，`HEAD=f876ce90d24ed486cae4060b1a4fe7b0813e9492`，尚无本地 remote。
- 历史：当前唯一 root commit 含 418 份原始 Markdown；它不能被推送到公开仓库。
- 工作区：已确认的未跟踪计划、规格、工具和测试属于本次连续工作，不是可丢弃杂项。
- Phase A 已实现：runtime/config、文件系统安全、source ID、metadata parser、保守 WeChat cleaner、严格 cleaning-state reader、`prepareCleaningPlan()`、`compileCleaningStateArtifacts()`、`stageCleaningRun()`。
- Phase A 未实现：B6 publication、B7 recovery、`cleanCorpus()` 编排、CLI apply、Task 6–12。
- 当前测试：精确 Node `24.18.0` 下 `tests/corpus-cleaner.test.mjs` 为 412 项、407 通过、5 失败；失败只位于 B5 固定祖先 identity continuity 组。
- Graphify：全局 CLI `graphifyy 0.9.28` 已存在；项目 skill、hook、ignore 和代码图尚未安装或生成。
- Phase B：尚未开始。
- Phase C：新设计规格已批准，构建器和 `site/index.html` 尚未开始。
- Phase D：远端 `zjgulai/deep-thinking-mode` 已知为空且公开，但本地 remote、Pages 与 workflow 尚未配置。

基线重验命令：

```bash
rtk git branch --show-current
rtk git rev-parse HEAD
rtk git status --short
rtk npx --yes node@24.18.0 --test tests/corpus-cleaner.test.mjs
```

期望：分支为 `main`，HEAD 为完整基线 SHA，工作区只含已确认文件，测试只出现上述 5 个固定祖先失败。

---

## 3. 文件责任图

### 3.1 合同与本地工具边界

| 文件 | 操作 | 唯一责任 |
|---|---|---|
| `AGENTS.md` | 修改 | 强制后续任务同时读取两份设计规格 |
| `docs/superpowers/specs/2026-07-27-brain-model-knowledge-system-design.md` | 修改 | 校准公开仓库、Pages 子路径和产品名 |
| `docs/superpowers/plans/2026-07-27-brain-model-knowledge-system.md` | 修改 | 校准总 rollout 状态、远端和入口命令 |
| `docs/superpowers/plans/2026-07-27-semantic-curation-and-codex-cards.md` | 修改 | 统一 catalog 读取到 current-cleaning pointer 合同 |
| `docs/superpowers/plans/2026-07-27-single-file-knowledge-site.md` | 修改 | 接入批准的新视觉规格和 `/deep-thinking-mode/` |
| `docs/superpowers/plans/2026-07-27-github-pages-release.md` | 修改 | 统一目标仓库、网址、remote 与 Pages API 路径 |
| `.gitignore` | 修改 | 忽略 `.local/`、`inbox/`、`.codex/`、`graphify-out/` 和原始根 Markdown |
| `.graphifyignore` | 创建 | 排除原始全文、私有目录、fixtures、文档和生成图 |
| `.codex/skills/graphify/**` | 本地生成 | Graphify 项目 skill；始终被 Git 忽略 |
| `.codex/hooks.json` | 本地生成 | Graphify hook；含本机路径，始终被 Git 忽略 |
| `graphify-out/**` | 本地生成 | 代码图和缓存；始终被 Git 忽略 |

### 3.2 Phase A：私有来源与清洗

权威文件集合和接口定义来自 `2026-07-27-public-safe-repository-and-cleaning-pipeline.md`。当前修改集中在：

```text
tools/lib/clean-run-store.mjs
tools/lib/cleaning-state.mjs
tools/lib/corpus-cleaner.mjs
tools/lib/cli.mjs
tools/corpus.mjs
tests/corpus-cleaner.test.mjs
tests/cli.test.mjs
```

随后按子计划创建：

```text
tools/lib/input-discovery.mjs
tools/lib/ip-safety.mjs
tools/lib/url-safety.mjs
tools/lib/pinned-http-client.mjs
tools/lib/url-aliases.mjs
tools/lib/url-snapshot.mjs
tools/lib/raw-backup.mjs
tools/lib/original-migration.mjs
tools/lib/migration-journal.mjs
tools/lib/local-verifier.mjs
tools/lib/public-scope.mjs
tests/input-discovery.test.mjs
tests/url-safety.test.mjs
tests/pinned-http-client.test.mjs
tests/url-snapshot.test.mjs
tests/raw-backup.test.mjs
tests/original-migration.test.mjs
tests/local-verifier.test.mjs
tests/public-scope.test.mjs
```

### 3.3 Phase B：综合知识与 Codex 共学卡

权威文件集合和 JSON/Markdown 合同来自 `2026-07-27-semantic-curation-and-codex-cards.md`：

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
knowledge/models/<approved-model-id>.md
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
```

`.local/analysis/`、`.local/dedup/`、`.local/ocr/`、`.local/reviews/` 和 `.local/verification/` 仅保存私有证据与复核状态。

### 3.4 Phase C：单文件网站

权威模块接口来自 `2026-07-27-single-file-knowledge-site.md`；视觉和产品行为来自已批准的 `2026-07-30-systematic-thinking-site-design.md`：

```text
tools/build-site.mjs
tools/check-site.mjs
tools/lib/load-knowledge.mjs
tools/lib/validate-knowledge.mjs
tools/lib/render-markdown.mjs
tools/lib/build-search-index.mjs
tools/lib/serialize-for-html.mjs
tools/lib/scan-html.mjs
tools/lib/render-site.mjs
tools/lib/atomic-write.mjs
tools/lib/html-audit.mjs
tools/site/template.html
tools/site/styles.css
tools/site/client.js
tests/load-knowledge.test.mjs
tests/markdown-rendering.test.mjs
tests/search.test.mjs
tests/problem-matcher.test.mjs
tests/prompt-generator.test.mjs
tests/client-init.test.mjs
tests/site-build.test.mjs
tests/atomic-build.test.mjs
tests/site-security.test.mjs
tests/dom-smoke.test.mjs
tests/helpers/load-client.mjs
tests/helpers/minimal-dom.mjs
tests/helpers/static-subpath-server.mjs
site/index.html
```

### 3.5 Phase D：公开历史与 Pages

权威发布合同来自 `2026-07-27-github-pages-release.md`：

```text
tools/config/public-paths.json
tools/config/github-actions-pins.json
tools/lib/public-history.mjs
tools/lib/pages-workflow.mjs
tools/check-public-tree.mjs
tools/check-public-artifact.mjs
tools/release-public-root.mjs
tools/verify-production.mjs
tests/public-history.test.mjs
tests/pages-workflow.test.mjs
tests/production-verifier.test.mjs
.github/workflows/pages.yml
README.md
```

---

## 4. 任务与验证检查表

### Task 1：校准跨计划合同

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-07-27-brain-model-knowledge-system-design.md`
- Modify: `docs/superpowers/plans/2026-07-27-brain-model-knowledge-system.md`
- Modify: `docs/superpowers/plans/2026-07-27-semantic-curation-and-codex-cards.md`
- Modify: `docs/superpowers/plans/2026-07-27-single-file-knowledge-site.md`
- Modify: `docs/superpowers/plans/2026-07-27-github-pages-release.md`
- Modify: this Task 1 section only, so its verification does not self-match obsolete contract text

**Interfaces:**
- Consumes: 已批准的网站设计规格、Phase A `CurrentCleaningPointer.catalog_path`、目标仓库 `zjgulai/deep-thinking-mode`。
- Produces: 无冲突的产品名、远端、子路径、catalog 发现方式和设计权威关系。

- [x] 把所有旧仓库名、旧 Pages 子路径和对应 Pages URL 精确替换为 `deep-thinking-mode` 版本。
- [x] 把语义计划中固定的旧独立 catalog 路径改为先读取 `.local/state/current-cleaning.json`，再使用其已验证的 `catalog_path`；不创建第二份可漂移 catalog。
- [x] 在单文件网站计划 Task 7 中加入已批准的暖色 hero、13 章地图、`240/720/280` 三栏知识工作台、右侧问题面板、暗色 token、响应式和 reduced-motion 验收。
- [x] 在总 rollout 中记录 Phase A 当前断点、Graphify 本地边界和“仅一个无父公开提交”的 commit 例外。
- [x] 运行冲突扫描：

```bash
rtk rg -n 'deep-thinking-mode[g]|zjgulai/deep-thinking-mode[g]|/deep-thinking-mode[g]/|\.local/catalog/sources[.]jsonl' docs AGENTS.md
```

期望：无命中；`.local/cleaned/runs/<run_sha256>/catalog/sources.jsonl` 和 pointer 中的 `catalog_path` 仍保留。

- [x] 运行路径与设计引用扫描：

```bash
rtk rg -n 'deep-thinking-mode|系统化思维|2026-07-30-systematic-thinking-site-design' AGENTS.md docs/superpowers
```

期望：两份设计规格和四份子计划的权威关系明确，目标仓库与 Pages 子路径一致。

**Review checkpoint:** 只审查文档合同；不改代码、不 commit。

### Task 2：修复 B5 固定祖先 identity continuity

**Files:**
- Modify: `tools/lib/clean-run-store.mjs`
- Test: `tests/corpus-cleaner.test.mjs:7400`
- Test: `tests/corpus-cleaner.test.mjs:7454`
- Test: `tests/corpus-cleaner.test.mjs:7508`
- Test: `tests/corpus-cleaner.test.mjs:7569`

**Interfaces:**
- Consumes: `stageCleaningRun(plan, { root, runsRoot })`、现有 `ensureDirectory()`、已存在的 inode/device identity 比较器和 `LOCAL_STATE_INVALID` 错误合同。
- Produces: 在 proof 到最后一次 descendant mutation 的完整窗口内绑定 `.local`、`.local/tmp`、`.local/cleaned`、`.local/cleaned/runs` 的 identity；任何替换都在写入前 fail closed。

- [x] 先运行精确 red test：

```bash
rtk npx --yes node@24.18.0 --test --test-name-pattern='B5 root alias anchoring|fixed .* ancestor remains bound' tests/corpus-cleaner.test.mjs
```

期望：父测试名使嵌套组被选中，4 个子测试失败，父组计入第 5 个失败；失败表现为替换祖先后出现意外持久写入。只匹配子测试名会让 Node 在父级过滤时跳过整组，不能作为 RED 证据。

- [x] 在 stage context 中保存固定祖先 proof，而不是让 `ensureDirectory()` 对已存在目录直接丢弃 identity：

```js
context.fixedAncestorProofs = new Map();

async function rememberFixedAncestor(context, absolutePath) {
  const identity = await proveDirectoryIdentity(context, absolutePath);
  context.fixedAncestorProofs.set(absolutePath, identity);
  return identity;
}

async function reproveFixedAncestors(context) {
  for (const [absolutePath, expectedIdentity] of context.fixedAncestorProofs) {
    const actualIdentity = await proveDirectoryIdentity(context, absolutePath);
    assertSameIdentity(actualIdentity, expectedIdentity, absolutePath);
  }
}
```

函数名可匹配现有私有 helper 命名，但必须保留三个语义：首次 proof 入 context、按根到叶稳定顺序复验、使用现有 exact error code/path/operation。

- [x] 在每个可能创建、link、rename、unlink 或 fsync descendant 的边界前复验全部已记忆固定祖先；如果当前 helper 已在 mutation 前有统一 gate，只在该统一 gate 接入一次，不复制散落检查。
- [x] 再运行上述 4 个子测试，期望全部通过且替换目录中没有新增文件。
- [x] 运行完整文件回归：

```bash
rtk npx --yes node@24.18.0 --test tests/corpus-cleaner.test.mjs
```

期望：412/412 通过。

- [x] 运行全套回归：

```bash
rtk npx --yes node@24.18.0 --test
```

期望：当前 511/511 通过；若测试数因本任务增加，以零失败为准。

**Review checkpoint:** 先规格一致性审查，再代码质量审查；不 commit。

### Task 3：安全安装 Graphify 项目 skill 并生成第一份代码图

**Files:**
- Modify: `.gitignore`
- Create: `.graphifyignore`
- Generate locally: `.codex/skills/graphify/**`
- Generate locally: `.codex/hooks.json`
- Generate locally: `graphify-out/**`

**Interfaces:**
- Consumes: Graphify CLI `0.9.28`、Git ignore、公开代码目录。
- Produces: 可复用的本地 Graphify skill、只含代码结构的 `graphify-out/graph.json` 和零私有全文泄漏审计结果。v0.9.28 的 `extract --code-only` 不生成 HTML；首轮不得追加 `cluster-only`，因为已批准规格明确只执行 extract。

- [x] 在 `.gitignore` 加入：

```gitignore
/.codex/
/graphify-out/
```

- [x] 创建 `.graphifyignore`：

```gitignore
/*.md
/.local/
/inbox/
/docs/
/tests/fixtures/
/.codex/
/graphify-out/
```

- [x] 验证 CLI 与包版本：

```bash
rtk graphify --version
```

期望：`0.9.28`。

- [x] 安装项目集成：

```bash
rtk graphify install --project --platform codex
```

期望：生成 `.codex/skills/graphify/` 与 `.codex/hooks.json`；检查安装器对 `AGENTS.md` 的任何修改，不能覆盖项目规则。

- [x] 生成代码图：

```bash
rtk env GRAPHIFY_QUERY_LOG_DISABLE=1 graphify extract . --code-only
```

期望：`graphify-out/graph.json` 存在；命令没有使用 `--no-gitignore`，且不追加可能进入另一聚类流程的命令。

- [x] 证明本地输出不会被公开：

```bash
rtk git check-ignore -v .codex/hooks.json graphify-out/graph.json
```

期望：两个路径均被 `.gitignore` 命中。

- [x] 扫描图输出不得含工作区绝对路径、任一原始 Markdown 文件名或 `.local/` 私有记录内容；诊断只输出命中规则和相对文件，不打印潜在私密正文。

**Review checkpoint:** Graphify 仅作为本地审查工具；不将安装产物或图加入公开文件。

### Task 4：完成 Phase A Task 5 的 B6、B7 与 `cleanCorpus()`

**Files:**
- Modify: `tools/lib/clean-run-store.mjs`
- Modify: `tools/lib/cleaning-state.mjs`
- Modify: `tools/lib/corpus-cleaner.mjs`
- Modify: `tools/lib/cli.mjs`
- Modify: `tools/corpus.mjs`
- Modify: `tests/corpus-cleaner.test.mjs`
- Modify: `tests/cli.test.mjs`

**Interfaces:**
- Consumes: `prepareCleaningPlan()`、`stageCleaningRun()`、`readCurrentCleaningState()`、`compileCleaningStateArtifacts()`。
- Produces: 子计划精确定义的 `publishCleaningRun()`、`recoverInterruptedCleaningCommit()`、`cleanCorpus()` 和 CLI apply；当前 pointer 是唯一可变 commit record。

- [ ] 完整执行清洗子计划 `Task 5 implementation B6 publication and B7 recovery` 的每一个 checkbox，保持其 `StageIntent`、transition record、lock、fsync、crash recovery 和 exact error precedence 合同。
- [ ] B7 historical missing-target candidate 遵循
  `docs/superpowers/plans/2026-08-03-b7-incomplete-evidence-policy.md`：不完整 bytes
  不做语义猜测，只做可观察结构验证并零写入 unresolved；完整对象与当前已知 C 继续严格验证。
- [ ] B7 historical terminal classification 遵循
  `docs/superpowers/plans/2026-08-03-b7-historical-terminal-classification.md`：
  每个 target 只使用自己的 C/layout 选择恰一个 exact completion 或 retirement，
  other-C/same-plan attempts 不进入 outcome set，全部 historical 通过后才可返回 owner alive。
- [ ] B7 Tranche C 遵循
  `docs/superpowers/plans/2026-08-03-b7-recovery-lease-stale-retirement.md`：
  只有 original owner dead 且全部 historical targets 通过后，current C 才能发布 target、
  取得 root/successor lease、按 liveness 规则清理 candidate，并完成不改 pointer 的
  C-bound stale retirement 与 fixed-lock durability cleanup。
- [ ] 完整执行同一子计划 Task 5 的 orchestration 与 CLI checkbox；不得把未完成的 publisher 暴露为部分成功。
- [ ] 每加入一个 public export，先写 `node:test` contract test，确认缺失 export 或错误行为导致 red，再实现最小 green。
- [ ] 对每个真实 child-process crash point 做可恢复性回归；恢复后 current pointer、run tree 和 transition record 必须形成同一个提交状态。
- [ ] 运行：

```bash
rtk npx --yes node@24.18.0 --test tests/corpus-cleaner.test.mjs tests/cli.test.mjs
```

期望：零失败，且所有失败路径不残留未声明持久状态。

**Review checkpoint:** 每完成 B6、B7、orchestration 中的一项即执行一次规格审查和质量审查；不把三个大步骤合并成一次审查。

### Task 5：完成 Phase A Task 6–12

**Files:** 使用清洗子计划 File Map 中 Task 6–12 的精确文件集合。

**Interfaces:**
- Consumes: 完成的 `cleanCorpus()`、current pointer、不可变 run、source ID 和 fs-safety primitives。
- Produces: 已验证 Git bundle、可恢复原始迁移、增量 Markdown/URL ingestion、DNS-pinned HTTP、local verifier 和 worktree/git-ref/pages-artifact 三 scope 隐私检查器。

- [ ] 依次执行子计划 Task 6 `Verified Git Bundle Backup` 至 Task 12 `Public Scope Verification`；每个子任务必须完成其 red/green/review 循环后再进入下一个。
- [ ] URL intake 必须把 DNS validation 绑定到实际 socket connect；普通 `fetch` 不能替代 `pinned-http-client`。
- [ ] 原始迁移必须 no-clobber、逐文件 journal，并且只有目标 hash 验证成功后才能删除源文件。
- [ ] `verifyPublicScope()` 必须分别验证 `worktree`、`git-ref`、`pages-artifact`，任何一个 scope 的成功不能替代另一个。
- [ ] 运行 Phase A 全套：

```bash
rtk npx --yes node@24.18.0 --test tests/cli.test.mjs tests/input-discovery.test.mjs tests/url-safety.test.mjs tests/pinned-http-client.test.mjs tests/url-snapshot.test.mjs tests/raw-backup.test.mjs tests/original-migration.test.mjs tests/local-verifier.test.mjs tests/public-scope.test.mjs
```

期望：零失败。

- [ ] 运行项目全套：

```bash
rtk npx --yes node@24.18.0 --test
```

期望：零失败。

**Review checkpoint:** Task 6–12 分别审查；不 commit。

### Gate 1：批准真实 bundle、迁移与首个全量 clean

Gate 1 前只能运行 dry-run、fixtures 和临时目录测试。向用户提交以下证据后暂停：

- baseline SHA、418 个路径和 hash 总结；
- bundle 路径、bundle SHA-256 和 `git bundle verify` 结果；
- migration dry-run 的 source/destination/no-clobber 统计；
- current pointer 与不可变 run 的预期关系；
- rollback/recovery 命令和不会进入公开范围的证明。

只有用户明确批准后，才执行真实 bundle、原始迁移和全量 clean；完成后重新运行 local verifier 与 worktree scope 检查。

### Task 6：建立 Phase B 合同与 28 份 pilot

**Files:** 使用语义子计划 Task 1–8 的精确公开、私有、fixture 和测试文件。

**Interfaces:**
- Consumes: 已验证 current pointer 指向的 catalog 和 cleaned outputs。
- Produces: 13 章 taxonomy、严格 evidence/schema contracts、source map、batch plan、28 份 pilot 摘要、候选模型贡献和 Gate 2 审计报告。

- [ ] 从 current pointer 解析 catalog，验证 run、catalog hash、report hash 后才允许构建 curation source map。
- [ ] 按语义子计划实现并测试 contracts、evidence、model Markdown、taxonomy、routes、medical safety、incremental curation 和 batch apply。
- [ ] 运行 28 份分层 pilot；图片主导或证据不足来源只产生明确状态，不生成正文推断。
- [ ] 输出 pilot 覆盖率、去重冲突、模型边界、医学升级条件、问题路由和 Codex 卡样例审计。

```bash
rtk npx --yes node@24.18.0 --test tests/contracts.test.mjs tests/evidence.test.mjs tests/model-markdown.test.mjs tests/dedup.test.mjs tests/taxonomy.test.mjs tests/problem-routes.test.mjs tests/medical-safety.test.mjs tests/incremental-curation.test.mjs tests/batch-apply.test.mjs
```

期望：零失败。

### Gate 2：批准语义模板与合并边界

向用户展示 28 份 pilot 的来源状态、摘要样例、候选模型、合并/不合并理由、完整 Codex 卡和高风险停止条件。用户批准前不执行剩余来源的全量策展。

### Task 7：完成 Phase B 全量批次、OCR 与公开知识

**Files:** 使用语义子计划剩余任务和 `B01` 至 `B12`（含 `03a/03b`、`06a/06b`、`08a/08b`、`10a/10b`）的精确文件集合。

**Interfaces:**
- Consumes: Gate 2 冻结合同与 batch plan。
- Produces: 完整公开 `knowledge/`、私有证据账本、OCR/review queue 和通过验证的 manifest。

- [ ] 严格按批准 batch plan 处理每个来源；每个来源恰有一个终态，每个公开结论至少关联一个 `source_id`。
- [ ] 对需要 OCR 或专业复核的来源建立队列，不在未批准时自动升级为 `ready`。
- [ ] 每批运行 batch apply、coverage、dedup、medical safety 和 incremental checks；批间不得手工修改派生 manifest。
- [ ] 完成后运行：

```bash
rtk npx --yes node@24.18.0 tools/validate-knowledge.mjs
rtk npx --yes node@24.18.0 tools/curation-report.mjs
rtk npx --yes node@24.18.0 --test tests/contracts.test.mjs tests/evidence.test.mjs tests/model-markdown.test.mjs tests/dedup.test.mjs tests/taxonomy.test.mjs tests/problem-routes.test.mjs tests/curation-coverage.test.mjs tests/medical-safety.test.mjs tests/incremental-curation.test.mjs tests/ocr-evidence.test.mjs tests/batch-apply.test.mjs
```

期望：validator 成功、报告数量自洽、测试零失败。

### Gate 3：OCR 与专业复核处置

向用户报告 `ready`、`needs_ocr`、`needs_review`、`needs_medical_review`、`fetch_failed` 的实际数量和公开影响。只有用户提供或批准 OCR/专业复核输入后才更新这些状态；诚实的未完成状态可进入公开索引，但不能伪装为完整模型。

### Task 8：实现安全单文件站点核心

**Files:** 使用网站子计划 Task 1–6 与 Task 8–9 的精确文件集合。

**Interfaces:**
- Consumes: `knowledge/` 与 manifest。
- Produces: `loadKnowledge()`、`validateKnowledge()`、`renderMarkdown()`、`buildSearchIndex()`、`serializeForHtml()`、`lexHtml()`、`auditHtml()`、`renderSite()`、`atomicWriteFile()` 和安全构建 CLI。

- [ ] 按网站子计划逐项完成 knowledge cross-validation、Markdown 安全渲染、稳定搜索、本地问题匹配、Codex prompt、HTML serialization、原子构建和结构化 HTML audit。
- [ ] CSP 只使用构建期计算的 CSS/JS SHA-256；Markdown HTML 关闭；图片不生成 `<img>`；用户输入不进入 `innerHTML`。
- [ ] 运行：

```bash
rtk npx --yes node@24.18.0 --test tests/load-knowledge.test.mjs tests/markdown-rendering.test.mjs tests/search.test.mjs tests/problem-matcher.test.mjs tests/prompt-generator.test.mjs tests/client-init.test.mjs tests/site-build.test.mjs tests/atomic-build.test.mjs tests/site-security.test.mjs
```

期望：零失败。

### Task 9：实现批准的“系统化思维”视觉与交互

**Files:**
- Modify: `tools/site/template.html`
- Modify: `tools/site/styles.css`
- Modify: `tools/site/client.js`
- Modify: `tools/lib/render-site.mjs`
- Test: `tests/dom-smoke.test.mjs`
- Test: `tests/site-build.test.mjs`
- Build: `site/index.html`

**Interfaces:**
- Consumes: Task 8 的安全渲染数据和本地 matcher/prompt APIs。
- Produces: 批准规格中的 header、暖色 hero、关系网络、13 章地图、三栏知识工作台、问题面板、亮暗主题、响应式和 reduced-motion 行为。

- [ ] 先扩充 DOM smoke/build assertions，精确覆盖：产品名、13 个 chapter card、左右 rail、中心模型正文、问题入口、离线状态、主题切换、复制提示词、窄屏 drawer 和 `aria-live`。
- [ ] 实现 `clamp(440px, 56svh, 640px)` hero、暖色 CSS gradient、内联装饰 SVG 关系网络、玻璃问题卡；不引入附件中的远程视频、外部字体或运行时资源。
- [ ] 实现 desktop `240px minmax(0,720px) 280px` 工作台；在 `1024px` 和 `760px` 断点按规格折叠，不出现横向滚动。
- [ ] 实现规格中的 light/dark tokens、focus ring、44px 交互热区、keyboard navigation、`prefers-reduced-motion` 和复制失败反馈。
- [ ] 原子构建并检查：

```bash
rtk npx --yes node@24.18.0 tools/build-site.mjs
rtk npx --yes node@24.18.0 tools/check-site.mjs site/index.html
rtk npx --yes node@24.18.0 --test tests/dom-smoke.test.mjs tests/site-build.test.mjs tests/site-security.test.mjs
```

期望：`site/` 只有 `index.html`，全部测试通过，无外部运行请求。

- [ ] 离线与子路径验证：

```bash
rtk npx --yes node@24.18.0 tests/helpers/static-subpath-server.mjs --root site --mount /deep-thinking-mode/
```

期望：`file://` 与 `http://127.0.0.1:4173/deep-thinking-mode/` 均可完成导航、搜索、问题匹配和 prompt 复制，无根绝对路径请求。

**Review checkpoint:** 自动检查通过后做桌面、平板、手机、亮暗模式和 reduced-motion 五组截图/交互审计；不以代码检查替代视觉审计。

### Task 10：实现 Phase D 本地发布安全层与 Pages workflow

**Files:** 使用发布子计划 Task 1–3 的精确文件集合。

**Interfaces:**
- Consumes: 最终 `knowledge/`、`site/index.html`、Phase A public-scope verifier、完整测试套件。
- Produces: 字面量 `public-paths.json`、固定 SHA Actions workflow、临时 index candidate tree、无父 root 创建器、CAS main activation 和 production byte verifier。

- [ ] 按发布子计划 Task 1–3 的 red/green 顺序实现 public-history、workflow pins、artifact checker、release CLI、README 和 production verifier。
- [ ] GitHub Actions 必须在 deploy 前执行 Node 24.18.0、`npm ci`、全测试、knowledge validation、site rebuild/drift、public tree 和 artifact scope checks。
- [ ] workflow 的每个 `uses:` 固定到已审查 40-hex SHA；只有 deploy job 拥有 `pages: write` 与 `id-token: write`。
- [ ] 运行：

```bash
rtk npx --yes node@24.18.0 --test tests/public-history.test.mjs tests/pages-workflow.test.mjs tests/production-verifier.test.mjs
rtk npx --yes node@24.18.0 tools/check-public-artifact.mjs site
```

期望：零失败；测试证明真实 index、HEAD 和 `refs/heads/main` 没有变化。

### Task 11：总验证、Graphify 复审与候选公开树准备

**Files:** 只修改验证发现的本次任务缺陷；任何公开 byte 变化都会使此前 candidate 失效并重新开始本任务。

- [ ] 在精确 Node 24.18.0 环境运行依赖安装、全测试、knowledge validator、site build/check、worktree privacy check 和 `git diff --check`。
- [ ] 重新运行 Graphify code-only extract，比较首次图，审查清洗状态边界、知识 manifest 流、站点数据嵌入和 release gate 是否有孤立模块或越权路径。提取后检查 `graphify-out/.graphify_root`；若它是本轮生成的被忽略常规文件，精确删除该单文件并重新做绝对路径隐私扫描，不做递归清理。
- [ ] 复查 `AGENTS.md` 不含 installer 自动追加的 `## graphify` 段、无未加 `rtk` 前缀的 Graphify 命令；本地 skill/hook 只保留在被忽略的 `.codex/`。
- [ ] 扫描公开候选输入，确认无 `.local/`、原始 Markdown、绝对路径、credential、Graphify 输出、附件路径或未批准远程资源。
- [ ] 确认 `public-paths.json` 与 candidate tree 的路径、mode、blob 类型、knowledge manifest 和 `site/` 单文件完全相等。
- [ ] 输出自证报告：测试数量、build SHA-256、site bytes、知识来源/模型/章节/状态统计、public path count、Graphify 图摘要、隐私 scope 结果、尚需人工 Gate。

建议命令序列由工具内部编排，不使用 shell 链接：

```bash
rtk npm ci
rtk npm test
rtk npm run validate:knowledge
rtk npm run build:site
rtk npm run check:site
rtk npm run verify:public:worktree
rtk git diff --check
rtk env GRAPHIFY_QUERY_LOG_DISABLE=1 graphify extract . --code-only
```

期望：全部成功；Graphify 产物仍被忽略。

### Gate 4A：创建唯一候选 root object

用户审查 Task 11 的完整证据、最终 public path manifest、author name/email、commit message 和 candidate tree OID 后，只有明确批准 Gate 4A 才可创建无父 commit object。不得移动 `main`、添加 remote 或 push。

### Gate 4B：激活本地 `main`

向用户展示 root commit OID、无 parent 证明、tree equality、bundle verify、author/message 和 ref 未变证明。只有明确批准 Gate 4B，release 工具才可用 `git update-ref` compare-and-swap 激活；随后立即复验工作区、index、root 和 bundle。

### Gate 5：远端与 Pages 配置

只读确认 `gh` 登录账户为 `zjgulai`、`zjgulai/deep-thinking-mode` 仍为空、visibility 为 public、目标 remote URL 正确。向用户确认后才添加 `origin` 并把 Pages build type 设置为 GitHub Actions；不在本门 push。

### Gate 6：push、Actions 与生产字节验证

只有明确批准 Gate 6 才执行一次普通 push 到空远端 `main`。等待对应 root OID 的 workflow 与 Pages deployment 成功，再请求 `https://zjgulai.github.io/deep-thinking-mode/`，比较解码响应体与本地 `site/index.html` 的 SHA-256 和字节；三者不一致则发布未完成，不能用 HTTP 200 代替字节证明。

---

## 5. 完成定义

- [ ] Phase A 全测试通过，418 份原始资料已在批准后完成可恢复保护/迁移，current pointer 与不可变 run 自洽。
- [ ] Phase B 每个来源有一个诚实终态，13 章、模型、来源索引、问题路由和 Codex 卡通过完整验证。
- [ ] `site/index.html` 是唯一站点文件，可离线和 `/deep-thinking-mode/` 子路径使用，符合批准的视觉、响应式、无障碍和安全规格。
- [ ] Graphify 项目 skill 可用，代码图完成两次审查，所有 Graphify 产物保持本地忽略。
- [ ] 唯一公开历史只有一个经 Gate 4A/4B 批准的无父 root commit，原始基线存在已验证 bundle。
- [ ] `zjgulai/deep-thinking-mode` 的 `main`、Actions deployment 与 Pages 生产内容绑定同一个 root OID。
- [ ] 生产响应 bytes 与本地 `site/index.html` 完全相同。
- [ ] 最终汇报只陈述实际改动、原因、验证结果、各 Gate 证据和仍未完成事项，不把未验证状态描述为完成。
