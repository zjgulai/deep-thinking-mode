# Router 2.0 与组合工坊实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前只做字面关键词包含判断的 Router v1 升级为确定性、可解释、可澄清、具备高风险停止边界的 Router 2.0，并把五条已有 Agent Chain 建成可发现、可阅读、可复制、可反向进入的一级“组合工坊”。

**Architecture:** `tools/lib/v3-agent-data.mjs` 负责 V3、Router、Chain、精选集合的 fail-closed 验证与只读构建视图；`tools/site-assets/router-engine.mjs` 是 Node 与浏览器共用的唯一纯匹配内核；`tools/site-assets/router-controller.mjs` 只管理五种 DOM 状态；`tools/build-site.mjs` 确定性渲染 Router、组合总览、五个组合详情及章节/模型反向入口。浏览器不联网、不持久化输入、不执行 Chain，也不把规则匹配描述为 AI。

**Tech Stack:** Node.js 原生 ESM、`node:test`、原生 HTML/CSS/JavaScript、现有静态多页构建器、现有公开构件检查器、Docker Compose、Nginx、腾讯云轻量应用服务器。

## Global Constraints

- 只在 `main` 分支工作，禁止 worktree；每条 shell 命令必须以 `rtk` 开头。
- 开始每个任务前执行 `rtk git status --short --branch`，不得覆盖、格式化、删除或提交与本任务无关的工作区文件。
- 当前未跟踪 `AGENTS.md` 属于用户工作区边界；本计划的所有 `git add` 命令均显式列路径，不包含它。
- 不新增 runtime 或 test dependency，不引入分词器、前端框架、bundler、远程字体、远程脚本、analytics、XHR 或 `fetch`。
- 13 个现有知识章节保持不变；“组合工坊”是新的一级能力，不作为第 14 章。
- `model.meta.agent_roles` 是唯一 Agent 角色权威；模型、Router、Chain、精选集合之间只用稳定 ID 关联。
- Router 输入与规范化值只存在内存，不进入 URL、storage、cookie、日志、控制台、截图文件名或构建产物。
- 匹配结果只说“本地规则导航”“命中信号”“需要澄清”，不使用 AI、概率或未经计算的“高置信”。
- 构建失败不得覆盖上一份 `site/` 或 `docs/`；相同输入连续构建必须路径集合与文件 bytes 完全一致。
- 本地验收、Git 提交、push、镜像替换和生产发布是五个独立门；没有对应明确授权，不跨门执行。
- Task 1–6 的 commit 仅是本地可回退实施检查点；由于数据、页面和生成构件按批次接通，它们不单独 push 或发布。只有 Task 7 提交生成候选并恢复完整公开树门后，HEAD 才重新成为发布候选。
- 每个代码任务按 RED → GREEN → 受影响回归 → 精确提交执行；第三次验证仍失败时停止局部补丁，回查数据合同和状态边界。

## 当前基线与完成标准

实施前基线：

```bash
rtk git branch --show-current
rtk git status --short --branch
rtk git log --oneline --decorate -3
rtk node --test tests/v3-agent-data.test.mjs
rtk npm run check:public
```

期望分支为 `main`；不得假设工作区洁净。实施者需在日志中记录测试总数、退出码和既有非本任务变更。

完成时必须同时满足：

1. 8 类问题、8 个 Agent 阶段、23 条路由、13 条非空 Chain 建议、5 条 Chain 及其阶段全部通过稳定 ID 交叉验证。
2. 96 条黄金问题达到设计规格中的三项准确率/安全门，7 条生产复现问题不再进入死空态。
3. Router 五种状态互斥且可键盘完成；低置信只追问一次；安全停止不展示自助解决链。
4. `site/combinations/index.html` 与 5 个详情页存在；Router、首页、模型详情和章节页均能发现组合能力。
5. 主题精选与组合协议在数据、文案和页面上保持不同概念；运行时没有名称 fallback。
6. `npm run release:check`、公开路径清单、两次确定性构建、`site/`/`docs/` byte 对等和浏览器 E2E 全绿。
7. 获得单独生产授权后，才替换 `xmind_site` 镜像并完成生产 Router、组合页、TLS 和 32 个邻接域名回归。

---

## Task 1：冻结 Router/Chain V2 数据合同并完成稳定 ID 迁移

**Files:**

- Modify: `tools/lib/v3-agent-data.mjs`
- Modify: `tools/validate-v3-agent-data.mjs`
- Modify: `tests/v3-agent-data.test.mjs`
- Modify: `chain-protocols/agent-router-index.json`
- Modify: `chain-protocols/agent-router-prompt.json`
- Modify: `chain-protocols/cot-critic-chain.json`
- Modify: `chain-protocols/deep-research-chain.json`
- Modify: `chain-protocols/plan-execute-reflect-chain.json`
- Modify: `chain-protocols/react-agent-chain.json`
- Modify: `chain-protocols/tot-tree-of-thought-chain.json`
- Modify: `knowledge/curated-collections.json`

**Frozen interfaces:**

`agent-router-index.json` 使用以下顶层结构；对象数组按 `priority`、再按 ASCII `id` 稳定排序：

```json
{
  "schema_version": "2.0-router",
  "problem_types": [
    {
      "id": "diagnosis",
      "label": "诊断根因",
      "priority": 10,
      "positive_phrases": [{ "text": "哪里出了问题", "weight": 8 }],
      "negative_phrases": [{ "text": "不需要找原因", "weight": 10 }],
      "examples": ["产品数据突然变差，我想知道发生了什么"],
      "clarify_label": "我想找出原因"
    }
  ],
  "agent_stages": [
    {
      "id": "intent",
      "label": "意图澄清",
      "priority": 10,
      "positive_phrases": [{ "text": "先弄清楚问题", "weight": 8 }]
    }
  ],
  "safety_signals": [
    {
      "id": "immediate_personal_danger",
      "label": "紧急人身危险",
      "phrases": ["正在伤害自己", "马上伤害别人"],
      "message": "请优先联系当地紧急服务、可信赖的人或合格专业人士。"
    }
  ],
  "routes": [
    {
      "id": "diagnosis::intent",
      "problem_type_id": "diagnosis",
      "agent_stage_id": "intent",
      "recommended_role_ids": ["intent_clarifier", "problem_framer"],
      "model_ids": ["苏格拉底式提问实操指南_层层追问_直"],
      "chain_id": null
    }
  ]
}
```

实施中的全部 `model_ids` 必须来自现有 V3 `id`；示例中的 ID 是当前 `diagnosis::intent` 已引用模型的真实 ID。安全信号保持窄范围明确短语，分别覆盖 `immediate_personal_danger`、`medical_diagnosis_or_treatment`、`legal_advice_with_deadline`、`high_stakes_financial_instruction`；不得因普通“健康”“合同”“投资学习”等宽泛词直接停止。

五个文件的 V2 `id` 固定等于文件 stem：

| 文件 | `id` |
| --- | --- |
| `cot-critic-chain.json` | `cot-critic-chain` |
| `deep-research-chain.json` | `deep-research-chain` |
| `plan-execute-reflect-chain.json` | `plan-execute-reflect-chain` |
| `react-agent-chain.json` | `react-agent-chain` |
| `tot-tree-of-thought-chain.json` | `tot-tree-of-thought-chain` |

每条 Chain 使用 `2.0-agent-chain`，阶段字段固定为 `id`、`order`、`name`、`agent_role`、`model_ids`、`input`、`output`、`checkpoint`、`stop_condition`、`loop_back_to`。旧 `phase`、显示名称型 `model` 和括号文本型回跳必须全部移除。13 条现有非空建议的映射保持：

- `diagnosis::cot_step`、`decision::cot_step`、`creative::cot_step` → `cot-critic-chain`
- `diagnosis::tot_branch`、`decision::tot_branch`、`creative::tot_branch` → `tot-tree-of-thought-chain`
- `diagnosis::reflect`、`planning::planning`、`planning::reflect`、`decision::reflect`、`reflection::reflect` → `plan-execute-reflect-chain`
- `planning::execution` → `react-agent-chain`
- `research::research` → `deep-research-chain`

`knowledge/curated-collections.json` 保留六个集合的顺序、标题、说明、标签和关键词；每个旧 `models[]` 项缩减为 `{ "model_id": "现有稳定 ID" }`，移除重复的 `name/core/activation/sp/quality/clean` 快照。构建显示内容一律回到 `modelsById` 读取。

- [ ] **Step 1：先写 V2 合同失败测试**

在 `tests/v3-agent-data.test.mjs` 增加以下反例与正例：

- 只接受 `2.0-router`、`2.0-router-prompt`、`2.0-agent-chain`。
- 拒绝重复问题类型、重复阶段、重复 route key、权重非 1–10 整数、同一类型正负短语相同。
- 拒绝未知角色、未知模型 ID、未知 Chain ID、Chain 文件 stem 与 `id` 不同。
- 拒绝阶段 `order` 不从 1 连续递增、重复 phase ID、回跳到自身或后续阶段。
- 拒绝阶段模型未声明该 `agent_role`。
- 拒绝 Router、Chain、精选集合中继续出现 `file`、`name` 关联或 `chain_suggestion`。
- 验证 23 条路由、13 条非空 Chain 引用、5 条 Chain 和 48 个精选模型引用均解析成功。
- 验证返回值及嵌套 Map/Array 冻结，修改源对象不会改变构建视图。

- [ ] **Step 2：运行 RED**

```bash
rtk node --test tests/v3-agent-data.test.mjs
```

期望失败原因是 loader 尚不识别 V2 `problem_types/routes/chains`，不是 JSON 语法错误。

- [ ] **Step 3：扩展公开安全加载边界**

在 `PUBLIC_V3_AGENT_PATHS` 增加：

```js
chainsDir: "chain-protocols",
curatedCollections: "knowledge/curated-collections.json"
```

loader 只允许五个 `*-chain.json` 白名单；继续拒绝软链、路径逃逸、非普通文件和私有目录。`validateV3AgentData()` 接收 `{models,taxonomy,routerIndex,routerPrompt,chains,curatedCollections}`，完成所有 schema 与交叉引用后才返回：

```js
{
  modelsById,
  problemTypes,
  agentStages,
  routesByProblemAndStage,
  chainsById,
  curatedCollections,
  compositionsByModelId,
  compositionsByChapterId,
  safetySignals,
  roleCounts,
  stats
}
```

`routesByProblemAndStage` 的 key 固定为 `${problemTypeId}::${agentStageId}`；反向索引的值按 Chain ID、phase order、model ID 稳定排序并深冻结。

- [ ] **Step 4：迁移真实数据**

对 Router 当前每个 `stateful_models[*].file` 读取对应 V3 的 `id` 后写入 `model_ids`。Chain 阶段候选优先取同一 Chain 已关联 route 中、声明对应 `agent_role` 的模型；同角色多候选按 `quality.overall` 降序、`id` ASCII 升序选择，选择结果直接固化为 ID，运行时不保留选择算法或名称 fallback。

将 Router Prompt 的结构化引用改为：

```json
{
  "schema_version": "2.0-router-prompt",
  "references": {
    "router_schema": "2.0-router",
    "problem_type_ids": [],
    "agent_stage_ids": [],
    "role_ids": [],
    "model_ids": [],
    "chain_ids": []
  }
}
```

数组必须覆盖 Prompt 文本实际提到的全部稳定 ID；浏览器永远不解析 Prompt 文本决定路由。

- [ ] **Step 5：运行 GREEN 与语料回归**

```bash
rtk node --test tests/v3-agent-data.test.mjs
rtk node tools/validate-v3-agent-data.mjs
rtk npm run validate:data
rtk git diff --check
```

期望 CLI 明确打印 2789 个唯一 V3、8 类问题、8 个阶段、23 条路由、5 条 Chain、13 条非空 Chain 引用、48 个精选引用；任何数目不符退出 1。

- [ ] **Step 6：精确提交 Task 1**

```bash
rtk git add tools/lib/v3-agent-data.mjs tools/validate-v3-agent-data.mjs tests/v3-agent-data.test.mjs chain-protocols/agent-router-index.json chain-protocols/agent-router-prompt.json chain-protocols/cot-critic-chain.json chain-protocols/deep-research-chain.json chain-protocols/plan-execute-reflect-chain.json chain-protocols/react-agent-chain.json chain-protocols/tot-tree-of-thought-chain.json knowledge/curated-collections.json
rtk git diff --cached --check
rtk git commit -m "feat: 升级 Router 与 Chain 稳定数据合同"
```

---

## Task 2：实现唯一纯匹配内核与 96 条黄金问题集

**Files:**

- Create: `tools/site-assets/router-engine.mjs`
- Create: `tests/router-engine.test.mjs`
- Create: `tests/fixtures/router/router-golden-cases.json`
- Modify: `chain-protocols/agent-router-index.json`
- Modify: `package.json`

**Public API:**

```js
export function normalizeRouterText(input) {}
export function createBigrams(normalizedCompactText) {}
export function scoreProblemTypes({ query, shortcutIntentId, problemTypes }) {}
export function detectAgentStage({ query, agentStages }) {}
export function matchRoute({ query, shortcutIntentId = null, routerData }) {}
```

`matchRoute()` 只返回本地规则结果，不返回模型对象或 HTML：

```js
{
  state: "idle|needs_input|matched|clarify|safety_stop",
  problemTypeId: null,
  auxiliaryProblemTypeIds: [],
  agentStageId: null,
  evidence: {
    matchedPositivePhrases: [],
    matchedNegativePhrases: [],
    closestExample: null,
    shortcutIntentId: null
  },
  clarificationOptionIds: [],
  safetySignalId: null
}
```

- [ ] **Step 1：创建完整黄金集与失败测试**

`router-golden-cases.json` 顶层为 96 个对象，每个对象字段固定：

```json
{
  "id": "diagnosis-01",
  "group": "single_intent",
  "input": "项目连续延期，我想先找出真正原因",
  "shortcut_intent_id": null,
  "expected_state": "matched",
  "expected_problem_type_id": "diagnosis",
  "allowed_auxiliary_type_ids": ["planning"],
  "expected_agent_stage_id": "intent",
  "allowed_chain_ids": [],
  "forbidden_problem_type_ids": ["communication"]
}
```

构成严格为：8 类 × 8 条单意图 = 64；多目标 16；低信息/歧义/高风险 16。中文口语、书面语、否定表达、ASCII 大小写、全角标点分别进入不同 case；7 条线上复现输入使用 `production-regression-01` 至 `07` 固定 ID，包含在上述 96 条内而不是额外计数。

测试逐条验证状态、核心类型、阶段、辅助不超过 2、禁止类型未出现；再聚合验证单意图 Top-1 ≥ 85%、多目标核心 ≥ 80%、低信息/歧义/高风险 100% 为 `clarify` 或 `safety_stop`。

- [ ] **Step 2：运行 RED**

```bash
rtk node --test tests/router-engine.test.mjs
```

期望 `ERR_MODULE_NOT_FOUND` 指向 `router-engine.mjs`。

- [ ] **Step 3：按冻结算法实现最小内核**

实现顺序固定：NFKC → Unicode 小写 → 标点/空白折叠 → 保留中文/字母/数字 → 同时生成紧凑文本。每个正向短语只计一次；完整公式计算后最低归零；最佳示例二元组 Jaccard 小于 0.22 不奖励，否则奖励 `Math.min(6, Math.floor(similarity * 6))`；快捷意图只给同 ID +8。

只有负向短语使用有界否定作用域：内部规范化保留标点形成的硬分句边界，普通空白可忽略，且不得改变公开 `normalizeRouterText()` 返回合同。负向短语只能在同一分句内精确命中，或按字符顺序作为 subsequence 命中；从首字符到末字符的总额外插入字符最多 4。若候选起点前同一分句内存在 `不是`、`并非` 或 `并不是`，且 marker 末尾到候选起点之间最多 4 个字符，该候选视为双重否定反转，不计负分。marker 和负向短语均不得跨标点。同一 phrase 有多个候选时，任一未反转候选即可计负分，整条 phrase 仍最多计一次。正向、示例、快捷意图与安全信号保持既有匹配规则。

`matched` 条件固定为第一名 ≥8 且存在正向或快捷命中；第一名 <8，或前两名都 ≥6 且分差 <2 时为 `clarify`；辅助只取分数 ≥6 的第二、第三名。排序为分数降序、`priority` 升序、ASCII `id` 升序。安全门先于普通评分；阶段无命中时固定为 `intent`。

内核不得读取 DOM、`window`、时间、随机数、locale 排序或任何存储。

- [ ] **Step 4：只根据失败类别校准公开信号**

黄金集失败时只修改对应类型的 `positive_phrases`、`negative_phrases`、`examples` 或权重；不得为单句加入完整原句的过拟合短语。每轮记录失败 case ID 和变更字段；第三轮仍失败时停止加词，检查类型边界或阈值。

- [ ] **Step 5：运行 GREEN 与静态检查**

```bash
rtk node --test tests/router-engine.test.mjs
rtk node --test tests/v3-agent-data.test.mjs tests/router-engine.test.mjs
rtk node --check tools/site-assets/router-engine.mjs
rtk git diff --check
```

在 `package.json#scripts.check` 的 `node --check` 文件列表中加入 `tools/site-assets/router-engine.mjs`。

- [ ] **Step 6：精确提交 Task 2**

```bash
rtk git add tools/site-assets/router-engine.mjs tests/router-engine.test.mjs tests/fixtures/router/router-golden-cases.json chain-protocols/agent-router-index.json package.json
rtk git diff --cached --check
rtk git commit -m "feat: 实现可解释的本地 Router 匹配内核"
```

---

## Task 3：实现 Router DOM 控制器与五种状态

**Files:**

- Create: `tools/site-assets/router-controller.mjs`
- Create: `tests/router-controller.test.mjs`
- Create: `tests/helpers/fake-router-dom.mjs`
- Modify: `package.json`

**Controller boundary:**

```js
export function parseRouterPayload(scriptNode) {}
export function createRouterController({ root, matcher = matchRoute }) {}
export function bootRouter(root = document) {}
```

控制器只消费已构建的 compact payload 和预渲染节点。它不得拼接 `innerHTML`；用户输入、状态和解释只写 `textContent`、`value`、`hidden`、ARIA attribute。路由详情通过 `data-route-key="problem::stage"` 查找并显隐，澄清选项通过 `data-clarify-option="problem"` 查找并显隐。

- [ ] **Step 1：先建立不依赖 jsdom 的 DOM 合同测试**

`tests/helpers/fake-router-dom.mjs` 只实现控制器需要的 `querySelector`、`querySelectorAll`、`addEventListener`、`dispatchEvent`、`setAttribute`、`getAttribute`、`focus`、`scrollIntoView`、`hidden`、`textContent` 和 `value`。不得模拟 CSS 或浏览器布局。

测试必须覆盖：

- 初始化 `idle`，示例/快捷项可见，结果区隐藏。
- 空输入或少于 2 个有效字符进入 `needs_input`，焦点留在输入，不滚动。
- `matched` 只显示一个 core route、最多两个 auxiliary route，标题获得程序焦点且 `aria-live` 只写一句。
- `clarify` 一次只显示 2–4 个按钮；点击一次后重跑；第二次仍不足则显示八类快捷入口，不继续递归追问。
- `safety_stop` 隐藏所有 route/chain 卡，只显示对应边界与“整理事实与问题清单”。
- reset 清空输入、快捷选择、澄清计数和结果，回到 `idle`。
- payload 缺失、JSON 破损或 schema 不符时显示“路由数据不可用”，不调用 matcher。
- 复制成功显示“已复制”；失败时选中文本并提示手动复制。

- [ ] **Step 2：运行 RED**

```bash
rtk node --test tests/router-controller.test.mjs
```

期望缺少 controller module。

- [ ] **Step 3：实现状态控制器**

内部只保存 `selectedShortcutIntentId` 和 `clarificationCount` 两个瞬时值。快捷按钮第一次点击只更新选中态并提示可以继续补充；用户提交或第二次点击已选快捷项才执行匹配。澄清按钮把选择作为 `shortcutIntentId` 重新匹配；reset 与 `pagehide` 清除引用和输入。

结果滚动遵循 `matchMedia("(prefers-reduced-motion: reduce)")`：reduce 时 `auto`，否则 `smooth`。`aria-live` 只播报“需要补充”“需要澄清”“已匹配 N 条路径”或安全停止，不朗读整个结果卡。

- [ ] **Step 4：运行 GREEN**

```bash
rtk node --test tests/router-controller.test.mjs tests/router-engine.test.mjs
rtk node --check tools/site-assets/router-controller.mjs
rtk git diff --check
```

将 controller 加入 `package.json#scripts.check`。

- [ ] **Step 5：精确提交 Task 3**

```bash
rtk git add tools/site-assets/router-controller.mjs tests/router-controller.test.mjs tests/helpers/fake-router-dom.mjs package.json
rtk git diff --cached --check
rtk git commit -m "feat: 实现 Router 五状态交互控制器"
```

---

## Task 4：构建 Router 2.0 页面并移除 v1 运行时

**Files:**

- Modify: `tools/build-site.mjs`
- Modify: `tools/site-assets/site.js`
- Modify: `tools/site-assets/site.css`
- Create: `tests/router-page.test.mjs`
- Modify: `tests/site-experience-contract.test.mjs`

**Renderer changes:**

`shell()` 增加可选 `moduleScripts = []`，仅 Router 页输出：

```html
<script type="module" src="assets/router-controller.mjs"></script>
```

全站原有 `assets/site.js` 继续负责导航、复制和模型筛选；删除其中从 `const routerForm` 开始的完整 v1 `query.includes` 匹配块。构建器把 `router-engine.mjs` 与 `router-controller.mjs` 逐字节复制到 `site/assets/`。

Router 页面预渲染：输入表单、8 个快捷意图、5 个互斥状态容器、23 个 route article、8 个澄清按钮、4 个安全停止面板和唯一 payload script。Compact payload 只含 problem types、stages、safety signals、route keys、label/priority/phrase/example；模型标题、短定义、URL 和 Chain 链接直接存在预渲染 route HTML，不把 2789 个模型全集塞入 JSON。

- [ ] **Step 1：写页面 RED 测试**

`tests/router-page.test.mjs` 直接 import `build-site.mjs` 导出的纯函数：

```js
serializeScriptJson(value)
createRouterPayload(buildView)
renderRouterPage(context)
```

为避免 import 即全量构建，`build-site.mjs` 改为导出 `buildSite()`，仅在 `process.argv[1]` 等于当前文件时执行。测试断言：

- payload 未压缩 UTF-8 bytes ≤ 96 KiB。
- `serializeScriptJson` 转义 `<`、`</script`、U+2028、U+2029，往返 JSON 等值。
- 页面恰有一个 module controller、8 个快捷按钮、5 个状态容器、23 个 route key。
- 每条 route 只引用已验证的 model URL；核心 Chain 最多一个。
- 页面没有 inline event、外部资源、`fetch`、storage 或旧 `data-keywords`。
- `site.js` 不再含 `query.includes(keyword)` 或 `[data-route-card]` Router 控制代码。

- [ ] **Step 2：运行 RED**

```bash
rtk node --test tests/router-page.test.mjs tests/site-experience-contract.test.mjs
```

期望缺少导出和新页面结构。

- [ ] **Step 3：实现 payload、预渲染结构和脚本接线**

问题理解区显示问题类型、阶段和缺失信息；解释区最多 3 个正向信号与 1 个近似示例；核心 route 最多 4 个模型；辅助 route 每类最多 2 个模型；Chain 只来自核心 `${problemTypeId}::${agentStageId}` route。route 没有 Chain 时固定显示“当前没有已策展的完整组合”。

页面可复制的结构化提问由已验证模板和用户当前输入在客户端通过 `textContent` 组合，不写回 HTML 字符串。

- [ ] **Step 4：完成大气、克制且状态清晰的 Router 视觉**

沿用暖纸底、深墨正文、陶朱强调；匹配状态不新增大面积深色背景。快捷按钮和澄清按钮 `min-height:44px`；core/aux/clarify/safety 同时有标题文字和边线差异；320px 单列无横滚；200% zoom 可达；打印隐藏输入、快捷项和复制按钮；reduce motion 关闭平滑滚动和位移动效。

- [ ] **Step 5：运行 GREEN 与构建烟测**

```bash
rtk node --test tests/router-page.test.mjs tests/router-controller.test.mjs tests/router-engine.test.mjs tests/site-experience-contract.test.mjs
rtk npm run build
rtk npm run check:public
rtk git diff --check
```

检查 `site/router.html` 与 `docs/router.html` 都引用本地 `.mjs`，两份源 module bytes 完全相同：

```bash
rtk cmp tools/site-assets/router-engine.mjs site/assets/router-engine.mjs
rtk cmp tools/site-assets/router-controller.mjs site/assets/router-controller.mjs
rtk cmp site/router.html docs/router.html
```

- [ ] **Step 6：精确提交 Task 4 源文件与定向测试**

本任务先不提交全量生成的 `site/`、`docs/`；它们在 Task 7 经确定性审计后统一提交。

```bash
rtk git add tools/build-site.mjs tools/site-assets/site.js tools/site-assets/site.css tests/router-page.test.mjs tests/site-experience-contract.test.mjs
rtk git diff --cached --check
rtk git commit -m "feat: 构建 Router 2.0 本地交互页面"
```

---

## Task 5：建设组合工坊、五个详情页与反向入口

**Files:**

- Modify: `tools/build-site.mjs`
- Modify: `tools/site-assets/site.css`
- Create: `tests/combination-workshop.test.mjs`
- Modify: `tests/site-experience-contract.test.mjs`

**Stable routes:**

```text
/combinations/
/combinations/cot-critic-chain.html
/combinations/deep-research-chain.html
/combinations/plan-execute-reflect-chain.html
/combinations/react-agent-chain.html
/combinations/tot-tree-of-thought-chain.html
```

- [ ] **Step 1：写组合页面 RED 测试**

测试 import 以下纯 renderer：

```js
renderCombinationIndex(context)
renderCombinationDetail({ chain, modelsById, chapterById, modelFile })
renderCompositionLinks(compositions)
```

断言总览恰有 5 张稳定 Chain 卡；详情页恰有有序 `ol` 阶段、输入合同、不适用/停止条件、角色、模型链接、checkpoint、loop、复合 Prompt 和边界说明；每个 loop anchor 指向本页更早 phase；所有模型链接存在。再验证 `compositionsByModelId` 与 `compositionsByChapterId` 的页面入口数量与 loader 返回一致。

- [ ] **Step 2：运行 RED**

```bash
rtk node --test tests/combination-workshop.test.mjs
```

期望缺少 renderer。

- [ ] **Step 3：渲染组合总览和详情**

总览先解释“单体模型 / 主题精选 / 组合协议”，再按 Chain ID 稳定排序展示五条协议。卡片只显示适用问题、触发信号、阶段数、核心角色、回退关系和所需输入完整度，不显示虚构时长或成功率。

详情严格按：定义 → 适用 → 不适用/停止 → 输入合同 → 有序阶段 → 回退/循环 → 替代边界 → 复合 Prompt → 事实/假设/专业升级提醒。时间线用 `ol`；纸条编号只表示顺序，细线只表示交接，回环标记只表示 `loop_back_to`，章节色只用于模型微签名。

- [ ] **Step 4：加入全站可发现入口**

- 全局导航在“模型库”与“Agent 路由”之间加入“组合工坊”，并支持 `aria-current`。
- 首页在主题精选之后增加 5 个组合预览卡，文案明确精选不是组合。
- Router matched 核心 route 显示唯一组合详情链接。
- 模型详情仅在该稳定 ID 被引用时显示“参与组合”，列出组合、阶段和角色。
- 章节页仅在本章模型被引用时显示“本章参与的组合”，按 Chain ID 去重。
- Breadcrumb、404 返回入口和 sitemap 加入组合路径。

- [ ] **Step 5：完成响应式、打印和无障碍样式**

1440/1024 使用有序横向节奏，390/320 改为单列；长 phase output、Prompt 和 URL 自然换行；打印保留阶段、停止条件和 URL，隐藏复制与装饰；所有链接和按钮触控高度 ≥44px；装饰不得承载唯一关系语义。

- [ ] **Step 6：运行 GREEN**

```bash
rtk node --test tests/combination-workshop.test.mjs tests/router-page.test.mjs tests/site-experience-contract.test.mjs
rtk npm run build
rtk npm run check:public
rtk git diff --check
```

额外确认 6 个组合页面在 `site/` 与 `docs/` 成对存在：

```bash
rtk ls -l site/combinations/index.html site/combinations/cot-critic-chain.html site/combinations/deep-research-chain.html site/combinations/plan-execute-reflect-chain.html site/combinations/react-agent-chain.html site/combinations/tot-tree-of-thought-chain.html
rtk diff -qr site/combinations docs/combinations
```

- [ ] **Step 7：精确提交 Task 5 源文件与测试**

```bash
rtk git add tools/build-site.mjs tools/site-assets/site.css tests/combination-workshop.test.mjs tests/site-experience-contract.test.mjs
rtk git diff --cached --check
rtk git commit -m "feat: 建设五条思维组合协议工坊"
```

---

## Task 6：补齐产品说明、发布合同和 Docker allowlist

**Files:**

- Modify: `README.md`
- Modify: `manuals/USER_GUIDE.md`
- Modify: `manuals/CAPABILITY_MAP.md`
- Modify: `manuals/RELEASE_CHECKLIST.md`
- Modify: `deploy/tencent-cloud/xmind-site/.dockerignore`
- Modify: `deploy/tencent-cloud/xmind-site/RUNBOOK.md`
- Modify: `tests/public-artifact.test.mjs`
- Modify: `tests/production-verifier.test.mjs`

- [ ] **Step 1：先写发布边界 RED 测试**

扩展公开构件 fixture，使合法树包含 `combinations/index.html`、一个组合详情、`assets/router-engine.mjs`、`assets/router-controller.mjs`；验证 checker 递归接受合法 `.mjs`，并继续拒绝缺失组合目标、跨页坏锚点、路径逃逸、外部 module、`fetch`、storage、软链和未知扩展名。

扩展 production verifier fixture：当组合详情或本地 module 远端 404、Content-Type 错误、发生意外重定向或 bytes 不一致时必须退出 1。

- [ ] **Step 2：运行 RED**

```bash
rtk node --test tests/public-artifact.test.mjs tests/production-verifier.test.mjs
```

期望 Docker/文档尚未覆盖组合路径；checker 若已支持 `.mjs`，相应断言应直接为 GREEN，不为制造失败而破坏正确逻辑。

- [ ] **Step 3：更新用户与能力说明**

- README 产品能力加入 Router 2.0 五状态、96 条黄金集、5 条组合协议和本地隐私边界。
- USER_GUIDE 给出“描述问题 → 必要时澄清 → 查看核心/辅助 → 进入唯一组合”的完整例子，并解释普通模型、主题精选、组合协议三者差异。
- CAPABILITY_MAP 将“Router 召回有限”替换为可验证的 V2 能力与仍然存在的规则边界，不称自然语言理解 AI。
- RELEASE_CHECKLIST 增加 Router 96 条门、5 个组合详情、反向入口、payload 预算、双构建和生产复现问题。

- [ ] **Step 4：更新镜像白名单与 Runbook**

`.dockerignore` 明确允许：

```text
!context/site/combinations/
!context/site/combinations/**
```

Runbook 的站点树清单、暂存检查、容器烟测、生产逐文件验证和回滚验收加入 `combinations/**` 与 `assets/*.mjs`。构建上下文仍然是 `deploy/tencent-cloud/xmind-site/`，不得扩大到仓库根；`DDDD.pem`、`.git`、`data/` 和 `.local/` 不得进入 daemon 或镜像。

- [ ] **Step 5：运行 GREEN**

```bash
rtk node --test tests/public-artifact.test.mjs tests/production-verifier.test.mjs
rtk docker compose --project-directory deploy/tencent-cloud/xmind-site config --quiet
rtk git diff --check
```

- [ ] **Step 6：精确提交 Task 6**

```bash
rtk git add README.md manuals/USER_GUIDE.md manuals/CAPABILITY_MAP.md manuals/RELEASE_CHECKLIST.md deploy/tencent-cloud/xmind-site/.dockerignore deploy/tencent-cloud/xmind-site/RUNBOOK.md tests/public-artifact.test.mjs tests/production-verifier.test.mjs
rtk git diff --cached --check
rtk git commit -m "docs: 补齐 Router 与组合工坊发布说明"
```

---

## Task 7：生成候选站点并完成确定性与全量自动验收

**Files:**

- Modify: `site/**`（只接受 `npm run build` 的确定性产物）
- Modify: `docs/**`（由同一候选逐字节复制）
- Modify: `tools/config/public-paths.json`
- Modify: `package.json`（仅当新 `.mjs` 尚未进入 `scripts.check`）

- [ ] **Step 1：清点工作区并运行全部源测试**

```bash
rtk git status --short --branch
rtk npm test
rtk npm run validate:data
```

任何失败先回到产生它的 Task；不得用忽略测试、缩小 glob 或修改期望值掩盖。此时不运行包含 `manifest:check` 的 `npm run check`，因为新源文件与生成路径要在 Step 3 一次性进入候选清单；完整 `check` 在 Step 4 执行。

- [ ] **Step 2：执行两次独立构建并比较 bytes**

```bash
rtk install -d -m 0700 .local/reviews/router-2/determinism/build-1
rtk npm run build
rtk rsync -a --delete site/ .local/reviews/router-2/determinism/build-1/
rtk npm run artifact:hash
rtk npm run build
rtk diff -qr .local/reviews/router-2/determinism/build-1 site
rtk diff -qr site docs
```

两次构件 hash、文件数和 `diff` 都必须一致；`.local/reviews/router-2/` 不进入 Git 或 Docker context。

- [ ] **Step 3：运行公开构件、安全和路径门**

```bash
rtk npm run check:public
rtk npm run artifact:hash
rtk npm run manifest:update
rtk npm run manifest:check
rtk git diff --check
```

审查 `tools/config/public-paths.json` 只新增本功能源文件、测试、文档和生成站点路径；不得包含 `DDDD.pem`、`data/`、`.local/` 或部署暂存树。

- [ ] **Step 4：执行完整 release gate**

```bash
rtk npm run release:check
rtk node tools/check-public-tree.mjs --git-ref HEAD --manifest tools/config/public-paths.json
```

注意：提交前 `check-public-tree --git-ref HEAD` 仍检查上一个 commit，可能因候选文件未入 HEAD 而失败；它不是可忽略项，而是在 Step 6 提交后必须重跑的 Git 树门。

- [ ] **Step 5：精确审查生成 diff 并提交候选**

```bash
rtk git status --short
rtk git diff --stat -- site docs tools/config/public-paths.json package.json
rtk git diff --check -- site docs tools/config/public-paths.json package.json
rtk git add site docs tools/config/public-paths.json package.json
rtk git diff --cached --check
rtk git commit -m "build: 生成 Router 2.0 与组合工坊站点"
```

如果 `package.json` 本任务没有变化，则从 `git add` 列表中删除该路径；不得使用 `git add .` 或 `git add -A`。

- [ ] **Step 6：提交后重跑 Git 树和全量门**

```bash
rtk node tools/check-public-tree.mjs --git-ref HEAD --manifest tools/config/public-paths.json
rtk npm run release:check
rtk git status --short --branch
```

期望只剩用户已知的非本任务文件；自动测试、构建和公开树全部退出 0。

---

## Task 8：本地浏览器 E2E、视觉 QA 与用户候选签字

**Files:**

- Create locally only: `.local/reviews/router-2/**`（被忽略，不提交）
- Modify source only if a reproducible defect requires回到 Task 2–6

- [ ] **Step 1：启动只读静态服务**

```bash
rtk python3 -m http.server 4173 --bind 127.0.0.1 --directory site
```

在单独终端保持服务；不得使用会注入脚本或代理远程资源的 preview 工具。

- [ ] **Step 2：四视口执行 Router E2E**

使用浏览器自动化依次检查 1440×1000、1024×768、390×844、320×720：

- 7 条 `production-regression-*` 全部进入预期匹配或澄清。
- 一条多目标问题显示 1 个核心、≤2 个辅助、唯一核心 Chain。
- 一条歧义问题只追问一次，键盘选择后恢复。
- 四类安全信号分别进入 `safety_stop`，不出现模型解决链。
- 快捷意图、清空、复制成功与复制 fallback 可操作。
- 刷新后 textarea 为空；URL 不含输入；local/session storage 与 cookie 未新增。
- Network 只有同源静态文件，无外部请求；console 无 error 和未解释 warning。

- [ ] **Step 3：执行组合工坊 E2E**

逐个打开总览与五个详情，检查阶段顺序、模型链接、回跳目标、停止条件、复合 Prompt、打印预览。再从首页、Router、至少一个被引用模型和至少一个相关章节反向进入组合详情。

- [ ] **Step 4：视觉、无障碍和内容审查**

- 320px 无页面级横滚，200% zoom 下输入、结果、组合时间线和复制仍可达。
- Tab 顺序为跳转链接 → 导航 → 输入 → 快捷意图 → 提交 → 澄清/结果 → 组合入口。
- 焦点环可见；状态不只靠颜色；reduce motion 与打印规则生效。
- 组合工坊保持东方高明度纸面、深墨文字和小面积陶朱，不新增深色大块或导师石像；组合装饰职责符合 MECE。
- 文案不把导师称为协议作者，不把规则匹配称 AI，不把模型写成医疗、法律或投资结论。

截图、console/network 摘要和 case 结果只写 `.local/reviews/router-2/`。把候选 URL、构件 hash、96 条统计和四视口结论汇总给用户；获得“本地候选通过、允许进入发布准备”的明确签字后才进入 Task 9。

---

## Task 9：生产发布、逐文件验证与严格回滚门

**Approval gate:** 本任务会连接 `101.34.52.232`、构建/传输镜像并 reload 共享 Nginx。开始前必须再次取得明确的生产发布授权；本计划获批不自动授权生产变更。

**Files:**

- Local staging only: `deploy/tencent-cloud/xmind-site/context/site/**`
- Local audit only: `deploy/tencent-cloud/xmind-site/audit/**`
- Remote release root: `/opt/xmind-site/releases/${ARTIFACT_SHA256}/`（值来自候选构件 hash 的 64 位十六进制 digest）
- Remote current pointer/project: `/opt/xmind-site/current`
- Shared edge config: `/opt/ai-video/deploy/lighthouse/nginx.conf`（只按 Runbook 最小 patch）

- [ ] **Step 1：重新确认本地候选与服务器只读基线**

```bash
rtk chmod 600 DDDD.pem
rtk npm run release:check
rtk npm run artifact:hash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'hostname; df -h /; docker version; docker compose version; docker ps --format "{{.Names}}\t{{.Image}}\t{{.Ports}}"'
```

磁盘、Docker、80/443 占用、现有 `ai_video_nginx`、证书和 32 个域名基线必须与 Runbook 一致。不得执行 `docker system prune`、删除镜像/volume 或把新容器接入现有应用网络。

- [ ] **Step 2：构建 deny-all 上下文与不可变镜像**

```bash
rtk install -d -m 0755 deploy/tencent-cloud/xmind-site/context/site
rtk rsync -a --delete --exclude='.gitignore' --exclude='.DS_Store' site/ deploy/tencent-cloud/xmind-site/context/site/
rtk rsync -rcn --delete --exclude='.gitignore' --exclude='.DS_Store' site/ deploy/tencent-cloud/xmind-site/context/site/
rtk docker compose --project-directory deploy/tencent-cloud/xmind-site config --quiet
```

dry-run 必须无输出；上下文只包含站点树、Nginx 配置、Dockerfile 与 Compose 文件。按 Runbook 生成 artifact SHA、镜像 tar 和 checksum，并用临时容器验证 `/healthz`、Router、两个 module、组合总览、五个详情、模型与章节样本。

- [ ] **Step 3：只传输精确 release 文件并启动隔离项目**

遵循 `deploy/tencent-cloud/xmind-site/RUNBOOK.md` 的精确 `scp` 清单，把 release 放到 `/opt/xmind-site/releases/${ARTIFACT_SHA256}/`；Compose project 固定 `xmind_site`，容器/网络名使用 `xmind-site-*`，端口只绑定 `172.20.0.1:18888`。不得传仓库根、私钥、`.git`、`data/` 或 `.local/`。

启动前保存旧 image digest、旧 release 目录、共享 Nginx checksum 和 32 域名基线。启动后只对新 origin 做健康检查，未通过不得切入口。

- [ ] **Step 4：最小切换共享入口**

按 Runbook 先申请/确认 `xmind.lute-tlz-dddd.top` 专属证书，再将已审计 server block proxy 到 `172.20.0.1:18888`。必须依次通过配置测试和 graceful reload：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker exec ai_video_nginx nginx -t'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker exec ai_video_nginx nginx -s reload'
```

任何证书、server block 或 origin 失败立即恢复旧配置并 reload；不做第二轮试探 patch。

- [ ] **Step 5：生产逐文件与 E2E 验收**

```bash
rtk node tools/verify-production.mjs --url https://xmind.lute-tlz-dddd.top --site-dir site
rtk npm run verify:security -- --url https://xmind.lute-tlz-dddd.top/
```

再在生产域名执行 Task 8 的 7 条复现、歧义、安全停止、五个组合详情、移动端和键盘 E2E；检查严格 TLS、无意外 redirect、Content-Type、bytes、CSP、无外部请求。对 `existing-domains.txt` 的 32 个邻接域名比较发布前后 TLS、状态和目标，不允许任何回归。

- [ ] **Step 6：验收或严格回滚**

以下任一条件立即回滚：Router 产生死空态、组合页/模块 404、严格 TLS 失败、共享 Nginx 配置异常、邻接域名变化、生产 bytes 不等于候选、容器健康失败。回滚只恢复上一不可变镜像、上一 current 指针与上一 Nginx 配置，然后再次执行 `nginx -t`、reload 和邻接域名回归。

仅当 origin、生产域名、Router、组合工坊、逐文件验证、安全头和邻接域名全部通过，才记录生产 artifact SHA、image digest、上线时间、回滚点和验收结论。不得 prune 旧镜像或删除最近回滚 release。

---

## 规格覆盖索引

| 设计规格能力 | 实施任务 |
| --- | --- |
| Router/Chain V2、稳定 ID、只读构建视图 | Task 1 |
| 规范化、信号、评分、阈值、阶段、黄金集 | Task 2 |
| 五种状态、一次澄清、焦点、复制、无持久化 | Task 3 |
| 安全 payload、Router 页面、v1 移除、响应式 | Task 4 |
| 组合总览、五个详情、首页/Router/模型/章节入口 | Task 5 |
| 说明书、能力图谱、发布清单、Docker allowlist | Task 6 |
| 全量测试、确定性、公开树、生成候选 | Task 7 |
| 四视口 E2E、视觉/无障碍、用户签字 | Task 8 |
| 腾讯云发布、TLS、逐文件验收、32 域名与回滚 | Task 9 |

## 执行交接

推荐按 Task 1 → 9 顺序执行，不并发修改 `tools/lib/v3-agent-data.mjs`、`tools/build-site.mjs`、`tools/site-assets/site.css` 或生成目录。每完成一个任务，先给出实际测试命令、通过/失败总数、diff 范围和未完成项，再进入下一个任务。Task 8 的用户签字与 Task 9 的生产授权必须分别获取。
