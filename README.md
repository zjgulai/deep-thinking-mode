# 系统化思维

**2654 个推理引擎 · 13 章知识体系 · 每个含 Codex 可执行协议**

把复杂问题，看成可以理解、选择与行动的系统。

---

## 项目简介

本项目将人类几千年积累的系统化思维模型蒸馏为可与 AI 协作的推理协议。

核心产出：
- **knowledge/models-v3/** — 2654 个 V3 格式思维模型，每个含 4 层 system_prompt（认知模式 / 推理协议 / 质量门禁 / 输出格式）
- **chain-protocols/** — 12 个认知竞技场（Arena），支持多视角同时持有、张力驱动洞察
- **docs/** / **site/** — 单文件知识网站，支持离线使用

来源：
- 419 篇原创微信文章（`data/`，本地私有）
- 31 本书籍提取文本（`ref-extracted/`，本地私有）
- 手工精馏 5 个基准模型

---

## 快速开始

```bash
# 安装依赖
npm ci

# 构建网站（输出到 docs/ 和 site/index.html）
npm run build

# 运行测试（881 tests）
npm test

# 检查代码语法
npm run check

# 检查站点产物（site/ 目录）
npm run check:public

# 运行完整评估（保真度 + 区分度）
node tools/eval-prompt-quality.mjs --all

# 对 29 个漏蒸馏文件重新蒸馏（如 data/ 有更新）
node tools/distill.mjs

# 从书籍提取模型
node tools/distill-ref.mjs

# 升级全量 V3
node tools/upgrade-to-v3.mjs

# 批量修复推理步骤
node tools/batch-refine.mjs
```

---

## 目录结构

```
├── knowledge/
│   ├── models-v2/          # 2654 个 V2 中间格式（推理引擎协议）
│   ├── models-v3/          # 2654 个 V3 格式（含 Codex 应用卡）
│   ├── taxonomy.json       # 13 章分类体系
│   └── model-schema-v3.json
├── chain-protocols/
│   ├── *-arena-*.json      # 12 个认知竞技场
│   ├── *-chain-*.json      # 27 个原始链式协议（已被 Arena 取代）
│   └── arena-schema-v1.json
├── tools/
│   ├── distill.mjs         # data/ 蒸馏引擎 → V2
│   ├── distill-ref.mjs     # ref-extracted/ 书籍蒸馏 → V2
│   ├── upgrade-to-v3.mjs   # V2 → V3 批量升级
│   ├── batch-refine.mjs    # V3 推理步骤补全
│   ├── build-site.mjs      # 网站构建器
│   ├── eval-prompt-quality.mjs  # 三维质量评估
│   ├── build-arena.mjs     # Chain → Arena 升级
│   ├── release-public-root.mjs  # release pipeline CLI
│   ├── check-public-tree.mjs
│   ├── check-public-artifact.mjs
│   ├── verify-production.mjs
│   ├── lib/
│   │   ├── public-history.mjs   # release 安全层核心
│   │   ├── pages-workflow.mjs   # workflow 确定性渲染
│   │   └── ...                  # corpus cleaner 等
│   └── config/
│       ├── public-paths.json    # 公开路径清单（5935 条）
│       └── github-actions-pins.json  # Action SHA 固定
├── specs/
│   ├── system-prompt-quality-standard.md  # 4层结构规范
│   ├── prompt-eval-results.md             # 三维评估结果
│   └── execution-plans/                   # 执行计划存档
├── docs/                   # GitHub Pages 源（多页）
├── site/                   # 单文件发布产物
│   └── index.html
├── tests/                  # 测试套件（881 tests）
└── .github/workflows/
    └── pages.yml           # 自动部署（main + public 分支）
```

---

## Codex 协作使用方式

1. 打开 `docs/chapters/` 中任意章节页
2. 找到目标模型，点击「复制」按钮获取 system_prompt
3. 在新对话开头粘贴 system_prompt，然后描述你的问题
4. 模型会按照推理协议（4 层结构）引导思考

或直接使用认知竞技场（多视角同时持有）：

```
// 示例：决策困境竞技场
chain-protocols/决策困境-arena-1.json → codex.system_prompt
```

---

## 数据质量现状

| 指标 | data 模型 (772) | 书籍模型 (1882) | 总计 (2654) |
|---|---|---|---|
| system_prompt 4层完整 | 77% | 99% | 93% |
| 推理协议有实质内容 | 64% | 1% | 19% |
| anti_triggers 有值 | 33% | 96% | 78% |
| pitfalls 有值 | 10% | 38% | 30% |
| steps ≥ 3步 | 24% | 1% | 7% |

---

## 发布边界

本项目使用双分支结构：

- **`main`** — 原始 markdown 基线 (`f876ce90d24ed486cae4060b1a4fe7b0813e9492`)，保持不变直到正式发布
- **`public`** — 当前工作分支，包含所有工具、知识库和网站文件，触发 Pages 部署

**重要约束：**
- 原始全文（`data/`）、书籍文本（`ref/`、`ref-extracted/`）永不进入公开 Git 历史
- `site/` 只含 `index.html`，运行时无外部依赖
- Pages 部署仅上传 `site/` 目录

**workflow_dispatch 行为：**  
手动触发可在任意分支运行测试和构建，但生产部署仅在 `main` 或 `public` 分支触发。

---

## Release Gate 流程（正式发布）

正式发布需逐步执行，每步需人工确认：

```bash
# 1. 准备候选树
node tools/release-public-root.mjs prepare

# 2. 审查候选（人工确认 OID、manifest digest、模式）
node tools/release-public-root.mjs inspect-candidate

# 3. 批准候选（需输入精确确认字符串）
node tools/release-public-root.mjs approve-candidate

# 4. 创建 root commit（无父提交）
node tools/release-public-root.mjs create-root

# 5. 审查 root（人工确认）
node tools/release-public-root.mjs inspect-root

# 6. 批准 root
node tools/release-public-root.mjs approve-root

# 7. 激活 main（compare-and-swap）
node tools/release-public-root.mjs activate-main

# 8. 验证激活
node tools/release-public-root.mjs verify-active

# 9. 推送（需用户明确确认后执行）
git push origin main

# 10. 验证生产字节
node tools/verify-production.mjs
```

**中断恢复：** 若激活成功但状态写入失败，执行：
```bash
git reset --mixed refs/heads/main
node tools/release-public-root.mjs verify-active
```

---

## 本地验证（发布前必跑）

```bash
npm ci
npm test                                                          # 881 tests pass
npm run check                                                     # 语法检查
npm run build                                                     # 构建
git diff --exit-code -- site/index.html                          # 无漂移
npm run check:public                                              # 站点检查
node tools/check-public-tree.mjs --git-ref HEAD \
  --manifest tools/config/public-paths.json                      # 公开树验证
```

---

## 技术栈

Node.js 20+ · 原生 ESM · `node:test` · 原生 HTML/CSS/JS  
无构建时外部依赖（`epub2`/`markdown-it`/`pdf-parse` 仅用于蒸馏工具）

---

© 2026 · [zjgulai/deep-thinking-mode](https://github.com/zjgulai/deep-thinking-mode)
