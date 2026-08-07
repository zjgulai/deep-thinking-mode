# Brain Model Knowledge System Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 418 份微信 Markdown 建设为本地私有来源层、公开安全的去重知识体系、每模型一张 Codex 共学应用卡、单文件离线 HTML，以及由 GitHub Actions 发布的 GitHub Pages 站点。

**Architecture:** 实施分成四个可独立验收的子系统：先保护原始资料并建立确定性清洗管线，再完成来源级总结与跨文档语义策展，然后生成单文件站点，最后建立公开安全 Git 历史并发布。任何子系统失败都不得破坏上一份可用成果。

**Tech Stack:** Node.js 24.18.0 LTS、npm、原生 ESM、`node:test`、`markdown-it@14.3.0`、原生 HTML/CSS/JavaScript、Git、GitHub Actions、GitHub Pages。

**产品与设计权威：** 产品名为「系统化思维」，目标仓库为 `zjgulai/deep-thinking-mode`，Pages 子路径为 `/deep-thinking-mode/`。资料隐私、安全、来源证据和单文件离线约束以 `2026-07-27-brain-model-knowledge-system-design.md` 为准；网站信息架构、视觉、交互、响应式和发布页面表现以 `2026-07-30-systematic-thinking-site-design.md` 为准。

## Global Constraints

- 只在 `main` 分支工作，禁止 worktree。
- 遵守根目录 `AGENTS.md` 和已确认的设计规格。
- 所有 shell 命令必须以 `rtk` 开头；`rtk` 不可用时停止执行，并请求恢复该命令包装器。不得使用普通 shell 作为替代，任何写操作不得绕过此要求。
- 写入前检查分支和工作区；不得覆盖 `.DS_Store`、`AGENTS.md`、`docs/` 或用户后续新增的未跟踪文件。
- 未经用户单独明确确认，不 commit、不替换 `main` 历史、不添加或修改 remote、不 push、不触发 Pages 发布。
- 原始全文、清理全文、OCR 结果、原始正文图片、私人共学记录和 Git bundle 永不进入公开 Git 历史或 Pages artifact。
- 不根据标题、文件名或相邻文章推断图片型资料正文。
- 医学、心理危机和其他高风险内容在未获专业复核时只能作为带边界的来源观点，不能包装为诊断或治疗建议。
- 每个实现任务先写失败测试，再写最小实现，再运行相关测试；完成一个子系统后才运行全量检查。
- 所有测试 fixture 使用人工合成内容，不复制真实文章段落。
- 唯一的公开提交例外是首版候选 tree 创建的一个无父 root commit；候选 tree、创建 commit、激活 `main`、配置 remote、push/生产部署分别经过下述审批门，不在阶段之间产生临时公开 commit。

---

## 1. 已确认基线

- [ ] 验证当前分支是 `main`。
- [ ] 验证当前原始基线 commit 是 `f876ce90d24ed486cae4060b1a4fe7b0813e9492`。
- [ ] 验证该 commit 中包含 418 个根层 Markdown。
- [ ] 验证当前未跟踪范围只有预期的 `.DS_Store`、`AGENTS.md` 和 `docs/`；若出现其他文件，停止并报告。
- [ ] 验证设计规格路径为 `docs/superpowers/specs/2026-07-27-brain-model-knowledge-system-design.md`。
- [ ] 记录 Node、npm、Git 和 `rtk` 的实际版本或缺失状态。

预期只读命令：

```sh
rtk git branch --show-current
rtk git rev-parse HEAD
rtk git status --short
rtk git ls-tree -r --name-only f876ce90d24ed486cae4060b1a4fe7b0813e9492
rtk node --version
rtk npm --version
```

通过标准：

```text
branch=main
baseline=f876ce90d24ed486cae4060b1a4fe7b0813e9492
baseline_markdown_count=418
```

任何一项不符都停止并向用户报告；只有用户明确批准重新定基线后，才能更新基线说明并继续。

## 2. 子计划与执行顺序

### Phase A：本地安全边界与确定性清洗

执行：

- `docs/superpowers/plans/2026-07-27-public-safe-repository-and-cleaning-pipeline.md`

产出：

- 可恢复的 `.local/backup/raw-baseline-f876ce90d24ed486cae4060b1a4fe7b0813e9492.bundle`
- 418 份 `.local/original/` 原始快照
- `.local/cleaned/runs/<corpus-hash>/` 下的版本化机械清理稿，以及原子切换的当前 run 指针
- 来源目录、指纹、图片清单和清理报告
- 公开范围检查器

当前断点：Phase A 的当前 run 只能由 `.local/state/current-cleaning.json` 选择；后续 reader 必须先稳定读取并验证该 pointer，再使用其已验证的 `catalog_path`。在该 run、catalog 与 report 通过验证前，不进入 Phase B、C 或 D。

Graphify 仅用于本地代码与模块架构审计；它不参与资料语义处理、站点运行或 Pages 构建，`graphify-out/` 及相关配置不进入公开 Git 历史或 Pages artifact。

退出条件：

- 原始 bundle 可独立恢复 `f876ce90d24ed486cae4060b1a4fe7b0813e9492`
- 418 个原始 SHA-256 一致
- 初始 418 个来源均登记；URL 别名、重定向重复和后续版本由 catalog 明确表达
- 237 张正文图片仍可追溯
- 微信壳和操作栏被确定性移除
- Markdown hard break 未被破坏
- `.local/` 与 `inbox/` 已被公开范围规则排除

### Phase B：语义总结、去重模型与 Codex 共学卡

执行：

- `docs/superpowers/plans/2026-07-27-semantic-curation-and-codex-cards.md`

产出：

- 418 条来源级结构化摘要或明确阻塞状态
- 13 章固定目录
- 三层去重关系和来源贡献记录
- 去重后的模型 Markdown
- 每个 ready 模型一张完整 Codex 共学应用卡
- 问题路由、来源索引和 manifest

退出条件：

- 418/418 来源均有状态、主章节和证据边界
- 5 组同名资料及约 61 对长短版均有决定或复核状态
- 初始图片主导资料采用 catalog 中冻结的命名集合，不用字符数阈值盲算；集合内每份资料完成 OCR 复核或明确保留 `needs_ocr`
- 每个 ready 模型只有一个 canonical 骨架
- ready 模型数等于完整应用卡数
- 健康风险内容完成分诊并显示专业升级条件

### Phase C：单文件离线知识站

执行：

- `docs/superpowers/plans/2026-07-27-single-file-knowledge-site.md`

产出：

- `site/index.html`
- 13 章导航
- 全文搜索
- 本地问题匹配器
- Codex 提问生成器
- 模型关系与来源追溯
- 离线、安全、确定性和原子构建测试

退出条件：

- 单文件可由 `file://` 打开
- 可在 `/deep-thinking-mode/` 子路径工作
- 无 CDN、外部字体、网络 API、分析追踪或服务端依赖
- 搜索、匹配和提示词生成全部在浏览器本地完成
- 相同输入生成相同 SHA-256
- 构建失败不覆盖上一份可用 HTML

### Phase D：公开历史与 GitHub Pages 发布

执行：

- `docs/superpowers/plans/2026-07-27-github-pages-release.md`

产出：

- 只含公开安全文件的新 `main` 根历史
- `.github/workflows/pages.yml`
- `origin` 指向 `zjgulai/deep-thinking-mode`
- GitHub Pages 生产部署

退出条件：

- 新 `main` 的可达历史不包含任何私有来源层
- workflow 只上传 `site/`
- Actions 测试、构建和部署成功
- `https://zjgulai.github.io/deep-thinking-mode/` 可访问
- 线上站点知识版本与本地构建一致

## 3. 执行前置与强制审批门

执行编排不是产品安全审批门。开始实现前仍须完成：

- [ ] 用户选择 Subagent-Driven 或 Inline Execution。
- [ ] 用户解决 `rtk` 缺失，或明确批准普通 shell 替代。
- [ ] 用户确认计划文档、`AGENTS.md` 和设计规格属于本项目。

### Gate 1：本地原始资料迁移

- [ ] 展示 bundle 验证、418 个 SHA-256、迁移 dry-run 和目标冲突数。
- [ ] 获得用户明确确认后，才把根层原始 Markdown 迁入 `.local/original/`。

### Gate 2：语义模板冻结

- [ ] 完成覆盖 13 章、同名组、图片型、医学和逻辑内容的固定试点批次。
- [ ] 用户确认摘要、模型文件和 Codex 共学卡样式后，才扩展到全部 418 份。

### Gate 3：OCR 与专业复核

- [ ] OCR 只采用用户批准的本地方法或 Codex 视觉复核流程。
- [ ] 未批准 OCR 方法时，图片主导资料保持 `needs_ocr`。
- [ ] 未指定医学专业复核责任人时，内容保持 `needs_medical_review`，不得进入 `ready`。

### Gate 4A：创建唯一公开 root commit

- [ ] 在临时 index 中完成全部公开文件、workflow、README、最终 `site/index.html` 和精确 allowlist 验证。
- [ ] 展示旧完整 commit OID、候选 tree OID、精确公开文件清单、tree mode、泄漏扫描和 bundle 恢复结果。
- [ ] 获得独立明确确认后，才由候选 tree 创建唯一无父 root commit；此后不得再修改公开候选内容或补第二个 commit。

### Gate 4B：激活本地 `main`

- [ ] 展示新 root commit OID，并在激活命令内部重新验证：无 parent、tree OID 与已批准值一致、完整泄漏扫描为零、无 symlink/gitlink、状态文件未漂移、`HEAD` 仍指向 `refs/heads/main`、旧完整 OID 的 CAS 条件仍成立。
- [ ] 获得独立明确确认后，才原子更新本地 `refs/heads/main`；后续 index 同步失败只报告可恢复状态，不做 hard reset。

### Gate 5：远端绑定与 Pages 配置

- [ ] 展示并确认 GitHub 登录身份、Git author/committer 名称与公开邮箱、仓库 owner、仓库可见性、远端为空和 Pages `build_type=workflow`。
- [ ] 获得独立明确确认后，才添加 `origin`，并完成不会上传内容的 Pages/`github-pages` environment 配置；环境只允许 `main` 部署。

### Gate 6：push 与生产发布

- [ ] 重新验证 Gate 5 的身份、仓库、远端为空、Pages 与 environment 状态。
- [ ] 明确告知 push 到 `origin/main` 会触发生产 Pages 部署。
- [ ] 获得一次明确涵盖“首次 push + 自动生产部署”的确认后，才 push；由于 push 必然触发 workflow，这两项是一个合并外部动作，不虚构为可分离步骤。

## 4. 总体验证矩阵

| 范围 | 自动验证 | 人工复核 |
|---|---|---|
| 原始保护 | bundle verify、commit 恢复、418 个 hash | 迁移清单与冲突 |
| 清理 | 指纹测试、URL/图片/hard break 计数 | 四类代表文章渲染 |
| 摘要 | schema、证据引用、覆盖计数 | 每批抽查证据与遗漏 |
| 去重 | canonical 唯一、关系完整、候选覆盖 | 模型边界与冲突观点 |
| Codex 卡 | 必需章节、统一输入、路由引用 | 是否能解决真实问题 |
| HTML | 离线、子路径、安全、确定性、原子写入 | 桌面与移动阅读体验 |
| 发布 | 可达历史扫描、artifact allowlist、Actions | 线上版本与交互烟测 |

## 5. 总体验收命令

所有子计划完成、且 `rtk` 可用或用户已批准替代后运行：

所有需要 catalog 的验证先稳定读取并验证 `.local/state/current-cleaning.json`，只使用其已验证的 `catalog_path`；不得维护或读取独立 catalog 镜像。

```sh
rtk npm ci
rtk npm test
rtk npm run check
rtk npm run build
rtk npm run corpus -- verify-public --scope worktree --root . --raw-manifest .local/state/raw-baseline.json --current-pointer .local/state/current-cleaning.json
rtk npm run corpus -- verify-public --scope git-ref --root . --git-ref main --raw-manifest .local/state/raw-baseline.json --current-pointer .local/state/current-cleaning.json
rtk npm run corpus -- verify-public --scope artifact --artifact-dir site
rtk git diff --check
rtk git status --short
```

预期摘要：

```text
baseline_sources=418
current_sources=manifest.current_source_count
chapters=13
unprocessed_inputs=0
public_scope_violations=0
site_files=1
tests_failed=0
```

## 6. 完成定义

- [ ] 本地完整保留 418 份原始来源和可恢复 Git bundle。
- [ ] 所有来源都有清理结果、语义状态、主章节和来源追溯。
- [ ] 已形成真正去重、保留边界与冲突的综合知识模型。
- [ ] 每个 ready 模型都有一张可直接驱动 Codex 联合解题的应用卡。
- [ ] 新 Markdown 或 URL 可进入同一增量流程。
- [ ] `site/index.html` 可离线使用，也已由 GitHub Pages 分享。
- [ ] 公开 Git 历史和网页不包含私有来源层。
- [ ] 所有 commit、历史替换、push 与发布均有用户独立确认记录。
