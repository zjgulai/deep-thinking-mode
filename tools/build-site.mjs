#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadV3AgentData } from "./lib/v3-agent-data.mjs";
import { findPublicModelResidue } from "./lib/public-model-sanitizer.mjs";
import { sanitizePublicModelTags } from "./lib/public-model-tags.mjs";
import { META_CONTENT_SECURITY_POLICY } from "./lib/site-security.mjs";
import {
  compileChapterThemesCss,
  validateChapterPresentation,
  verifyChapterPortraitAssets,
} from "./lib/chapter-presentation.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODELS_DIR = join(ROOT, "knowledge", "models-v3");
const TAXONOMY_PATH = join(ROOT, "knowledge", "taxonomy.json");
const CHAPTER_MENTORS_PATH = join(ROOT, "knowledge", "chapter-mentors.json");
const CHAPTER_THEMES_PATH = join(ROOT, "knowledge", "chapter-themes.json");
const CURATED_PATH = join(ROOT, "knowledge", "curated-collections.json");
const ASSETS_DIR = join(ROOT, "tools", "site-assets");
const SITE_DIR = join(ROOT, "site");
const DOCS_DIR = join(ROOT, "docs");
const ORIGIN = "https://xmind.lute-tlz-dddd.top";
const PRODUCT_NAME = "前车之鉴-思维制胜";
const PRODUCT_SUBTITLE = "在对的方向上前行，效率不值一提";

function writeTextFile(path, content) {
  writeFileSync(path, content.replace(/[ \t]+$/gm, ""));
}
const REPOSITORY_URL = "https://github.com/zjgulai/deep-thinking-mode";

const AGENT_ROLE_LABELS = {
  intent_clarifier: "意图澄清",
  problem_framer: "问题重构",
  first_principles: "第一性原理",
  causal_reasoner: "因果推理",
  systems_thinker: "系统思维",
  logical_analyzer: "逻辑分析",
  multi_perspective: "多视角",
  hypothesis_tester: "假设检验",
  decision_maker: "决策判断",
  bias_detector: "偏差识别",
  planner: "计划制定",
  decomposer: "任务分解",
  prioritizer: "优先排序",
  action_executor: "行动执行",
  observer_reflector: "观察反思",
  knowledge_synthesizer: "知识整合",
  pattern_recognizer: "模式识别",
  communicator: "表达输出",
  simplifier: "复杂简化",
};

const AGENT_FLOWS = [
  { code: "01", name: "意图澄清", description: "先校准目标、事实与假设，再开始推理。", roles: ["intent_clarifier", "problem_framer"] },
  { code: "02", name: "结构推演", description: "把复杂问题拆为可验证的因果与结构。", roles: ["first_principles", "causal_reasoner", "logical_analyzer"] },
  { code: "03", name: "多路探索", description: "展开替代路径，比较证据并主动剪枝。", roles: ["multi_perspective", "hypothesis_tester"] },
  { code: "04", name: "决策取舍", description: "显式处理风险、偏差、代价与可逆性。", roles: ["decision_maker", "bias_detector"] },
  { code: "05", name: "计划执行", description: "从目标分解到优先级与行动闭环。", roles: ["planner", "decomposer", "prioritizer", "action_executor"] },
  { code: "06", name: "复盘校正", description: "观察反馈、识别误差并更新认知。", roles: ["observer_reflector"] },
  { code: "07", name: "知识综合", description: "连接多源证据，压缩成可复用框架。", roles: ["knowledge_synthesizer", "pattern_recognizer"] },
  { code: "08", name: "清晰表达", description: "把复杂结论转化为可沟通的结构。", roles: ["communicator", "simplifier"] },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function compareText(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function serializeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

export function createRouterPayload(buildView) {
  return {
    schema_version: "2.0-router",
    problem_types: buildView.problemTypes.map((problemType) => ({
      id: problemType.id,
      label: problemType.label,
      priority: problemType.priority,
      positive_phrases: problemType.positive_phrases.map(({ text, weight }) => ({ text, weight })),
      negative_phrases: problemType.negative_phrases.map(({ text, weight }) => ({ text, weight })),
      examples: [...problemType.examples],
      clarify_label: problemType.clarify_label
    })),
    agent_stages: buildView.agentStages.map((agentStage) => ({
      id: agentStage.id,
      label: agentStage.label,
      priority: agentStage.priority,
      positive_phrases: agentStage.positive_phrases.map(({ text, weight }) => ({ text, weight }))
    })),
    safety_signals: buildView.safetySignals.map((signal) => ({
      id: signal.id,
      label: signal.label,
      message: signal.message,
      phrases: [...signal.phrases]
    })),
    route_keys: [...buildView.routesByProblemAndStage.keys()]
  };
}

// 移除 emoji 及其前后紧邻空格，用于展示性文字（标题、描述）
function stripEmoji(value) {
  return String(value ?? "")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/gu, "")
    .trim();
}

function displayName(value) {
  return String(value ?? "")
    .replace(/\*\*/g, "")
    .replace(/_+/g, " · ")
    .replace(/\s*#[^\s#]+.*$/u, "")
    .replace(/\s*[·｜]\s*[\p{Script=Han}]$/u, "")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*·\s*)+/g, " · ")
    .replace(/[，、:：\-·｜]\s*$/u, "")
    .trim();
}

function plainText(value) {
  return String(value ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s*/g, "$1")
    .replace(/[*`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(value, limit = 150) {
  const text = plainText(value);
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function presentationScore(model) {
  const name = displayName(model.meta?.name);
  const definition = plainText(model.core_definition);
  let score = 0;
  if (name.length >= 4 && name.length <= 32) score += 4;
  else if (name.length > 48) score -= 4;
  if (!/^[\d一二三四五六七八九十]+[.、．\s-]/u.test(name)) score += 3;
  if (!/^(核心|定义|特征|机制|第一部分|第二部分)/u.test(name)) score += 2;
  if (!/[“”][^“”]{28,}[“”]?/u.test(name)) score += 1;
  if (definition.length >= 18 && definition.length <= 260) score += 3;
  if (!/[#*`]/.test(String(model.core_definition ?? ""))) score += 2;
  if ((model.reasoning_steps?.length ?? 0) >= 3) score += 3;
  if ((model.when_to_use?.triggers?.length ?? 0) >= 2) score += 2;
  if (model.codex_integration?.system_prompt) score += 2;
  if ((model.meta?.agent_roles?.length ?? 0) > 0) score += 5;
  return score;
}

function textList(items, className = "plain-list") {
  if (!Array.isArray(items) || items.length === 0) return "";
  return `<ul class="${className}">${items.map((item) => `<li>${escapeHtml(plainText(item))}</li>`).join("")}</ul>`;
}

function deterministicModelFile(model) {
  const id = String(model.id ?? "");
  const ascii = id
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${ascii || "model"}-${hash}.html`;
}

function canonical(pathname) {
  return `${ORIGIN}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function assetPrefix(depth) {
  return depth > 0 ? "../".repeat(depth) : "";
}

function shell({ title, description, pathname, depth = 0, active = "", body, pageClass = "", chapterId = "", themeKey = "", moduleScripts = [] }) {
  const prefix = assetPrefix(depth);
  const pageTitle = title === PRODUCT_NAME ? title : `${title}｜${PRODUCT_NAME}`;
  const nav = [
    ["home", `${prefix}index.html`, "首页"],
    ["models", `${prefix}models/index.html`, "模型库"],
    ["router", `${prefix}router.html`, "Agent 路由"],
  ];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#f7f2e8">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="${META_CONTENT_SECURITY_POLICY}">
  <link rel="canonical" href="${canonical(pathname)}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="zh_CN">
  <meta property="og:site_name" content="${PRODUCT_NAME}">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonical(pathname)}">
  <link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${prefix}assets/site.css">
  <link rel="stylesheet" href="${prefix}assets/chapter-themes.css">
  <title>${escapeHtml(pageTitle)}</title>
</head>
<body class="${escapeHtml(pageClass)}"${chapterId ? ` data-chapter="${escapeHtml(chapterId)}"` : ""}${themeKey ? ` data-theme="${escapeHtml(themeKey)}"` : ""}>
  <a class="skip-link" href="#main-content">跳至正文</a>
  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="${prefix}index.html" aria-label="${PRODUCT_NAME}首页">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span><strong>${PRODUCT_NAME}</strong><small>Lessons Forward · Think to Win</small></span>
      </a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="primary-nav" data-nav-toggle><span></span><span></span><span></span><span class="sr-only">打开导航</span></button>
      <nav class="primary-nav" id="primary-nav" aria-label="主导航" data-primary-nav>
        ${nav.map(([key, href, label]) => `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
        <a class="nav-repo" href="${REPOSITORY_URL}" rel="noopener noreferrer">GitHub <span aria-hidden="true">↗</span></a>
      </nav>
    </div>
  </header>
  <main id="main-content">${body}</main>
  <footer class="site-footer">
    <div><strong>${PRODUCT_NAME}</strong><span>${PRODUCT_SUBTITLE}</span></div>
    <p>本地静态运行 · 无追踪 · 内容仅作认知工具，不替代医疗、法律或财务专业意见</p>
  </footer>
  <div class="toast" role="status" aria-live="polite" aria-atomic="true" data-toast></div>
  <script src="${prefix}assets/site.js" defer></script>
  ${moduleScripts.map((source) => `<script type="module" src="${prefix}${escapeHtml(source)}"></script>`).join("\n  ")}
</body>
</html>`;
}

export function renderRouterPage({ buildView, modelFile }) {
  const problemTypeById = new Map(buildView.problemTypes.map((problemType) => [problemType.id, problemType]));
  const agentStageById = new Map(buildView.agentStages.map((agentStage) => [agentStage.id, agentStage]));
  const routeCards = [...buildView.routesByProblemAndStage.entries()].map(([routeKey, route], index) => {
    const problemType = problemTypeById.get(route.problem_type_id);
    const agentStage = agentStageById.get(route.agent_stage_id);
    const models = route.model_ids.map((modelId) => {
      const model = buildView.modelsById.get(modelId);
      const file = modelFile.get(modelId);
      if (!model || !file) throw new Error(`Router route ${routeKey} 引用未验证模型: ${modelId}`);
      return { file, model };
    });
    const modelLinks = (kind, limit) => models.slice(0, limit).map(({ file, model }) => `<a data-router-model-link="${kind}" href="models/${escapeHtml(file)}"><strong>${escapeHtml(displayName(model.meta.name))}</strong><span>${escapeHtml(excerpt(model.core_definition, 82))}</span></a>`).join("");
    const chain = route.chain_id === null ? null : buildView.chainsById.get(route.chain_id);
    if (route.chain_id !== null && !chain) throw new Error(`Router route ${routeKey} 引用未验证 Chain: ${route.chain_id}`);
    const chainPanel = chain ? `<section class="route-chain" data-router-chain>
        <p class="route-section-label">推荐组合</p><h3>${escapeHtml(chain.meta.title)}</h3><p>${escapeHtml(chain.meta.description)}</p>
        <ol>${chain.phases.map((phase) => `<li><strong>${escapeHtml(phase.name)}</strong><span>输入：${escapeHtml(phase.input)}</span><span>输出：${escapeHtml(phase.output)}</span><span>停止：${escapeHtml(phase.stop_condition)}</span></li>`).join("")}</ol>
        <a class="text-link" href="combinations/${escapeHtml(chain.id)}.html">查看完整组合协议 <span aria-hidden="true">→</span></a>
      </section>` : `<p class="route-chain-empty">当前没有已策展的完整组合</p>`;
    return `<article class="route-result" data-route-key="${escapeHtml(routeKey)}" data-route-kind="" hidden>
      <div class="route-result-number">${String(index + 1).padStart(2, "0")}</div>
      <div class="route-result-body">
        <header><p class="eyebrow">ROUTE ${escapeHtml(routeKey)}</p><div class="route-kind-row"><span class="route-kind route-kind-core">核心路径</span><span class="route-kind route-kind-auxiliary">辅助路径</span></div><h2>${escapeHtml(problemType.label)} · ${escapeHtml(agentStage.label)}</h2></header>
        <div class="route-explanation-grid">
          <section><p class="route-section-label">问题理解</p><dl><div><dt>问题类型</dt><dd>${escapeHtml(problemType.label)}</dd></div><div><dt>Agent 阶段</dt><dd>${escapeHtml(agentStage.label)}</dd></div><div><dt>仍缺少</dt><dd>支持“${escapeHtml(problemType.clarify_label)}”的可验证事实、约束与停止条件</dd></div></dl></section>
          <section><p class="route-section-label">为什么这样匹配</p><p>可解释信号：${escapeHtml(problemType.positive_phrases.slice(0, 3).map(({ text }) => text).join(" · "))}</p><p>近似示例：${escapeHtml(problemType.examples[0])}</p></section>
        </div>
        ${roleChips(route.recommended_role_ids)}
        <section class="route-model-section"><p class="route-section-label">策展模型</p><div class="route-models route-models-core">${modelLinks("core", 4) || "<p>当前路径没有已策展的单体模型。</p>"}</div><div class="route-models route-models-auxiliary">${modelLinks("auxiliary", 2) || "<p>当前路径没有已策展的单体模型。</p>"}</div></section>
        ${chainPanel}
      </div>
    </article>`;
  }).join("");
  const shortcuts = buildView.problemTypes.map((problemType) => `<button class="router-shortcut" type="button" data-shortcut-intent="${escapeHtml(problemType.id)}" aria-pressed="false">${escapeHtml(problemType.clarify_label)}</button>`).join("");
  const clarificationButtons = buildView.problemTypes.map((problemType) => `<button class="router-clarify-option" type="button" data-clarify-option="${escapeHtml(problemType.id)}" hidden>${escapeHtml(problemType.clarify_label)}</button>`).join("");
  const safetyPanels = buildView.safetySignals.map((signal) => `<article class="router-safety-panel" data-safety-signal="${escapeHtml(signal.id)}" hidden><h2>${escapeHtml(signal.label)}</h2><p>${escapeHtml(signal.message)}</p><p>本站只能帮助整理事实与待咨询问题，不代替专业判断或紧急支持。</p></article>`).join("");
  const payload = serializeScriptJson(createRouterPayload(buildView));
  const body = `${breadcrumbs([{ href: "index.html", label: "首页" }, { label: "Agent 路由" }])}
    <section class="router-hero section-shell"><div><p class="kicker">LOCAL RULE ROUTER 2.0</p><h1>把问题说清，<em>再选择路径。</em></h1><p>在本地规则中识别问题类型和 Agent 阶段，返回一条核心路径与最多两条辅助路径。</p></div>
      <form class="problem-form" data-router-form><label for="problem-input">你现在真正想解决什么？</label><textarea id="problem-input" rows="6" placeholder="例如：项目连续延期，我想判断根因并制定下一步计划……" autocomplete="off" data-router-input></textarea><div><button class="button button-primary" type="submit">匹配推理路径</button><button class="button button-ghost" type="reset">清空</button></div><p class="form-note">本地规则导航 · 输入不会上传或保存 · 结果需要结合事实验证</p><p class="router-hint" data-router-hint></p><p class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-router-live></p></form>
    </section>
    <section class="router-entry section-shell" data-router-examples><div><p class="eyebrow">TRY AN EXAMPLE</p><h2>从一个具体问题开始</h2><p>说明你看到的现象、希望达到的结果，以及已知约束。信息不足时，系统只会追问一个关键问题。</p></div></section>
    <section class="router-shortcuts section-shell" data-router-shortcuts aria-label="意图快捷项"><div class="section-intro"><p class="kicker">QUICK INTENTS</p><h2>或先选择一个意图</h2><p>首次点击只选中；继续补充后提交，或再次点击已选项匹配。</p></div><div class="router-shortcut-grid">${shortcuts}</div></section>
    <section class="router-match section-shell" data-router-results hidden><h2 class="router-result-title" tabindex="-1" data-router-result-title hidden>本地路由结果</h2><div class="router-route-grid">${routeCards}</div><section class="router-copy"><div><p class="route-section-label">NEXT STEP</p><h2>带着结构化问题继续思考</h2><p>提问只在当前页内组合，离开或清空即丢弃。</p></div><textarea class="router-copy-text" readonly rows="14" aria-label="结构化提问" data-router-copy-text></textarea><div><button class="button button-secondary router-copy-button" type="button" data-router-copy>复制结构化提问</button><span role="status" aria-live="polite" data-router-copy-status></span></div></section></section>
    <section class="router-clarify section-shell" data-router-clarify hidden><p class="kicker">ONE CLARIFYING QUESTION</p><h2 data-router-clarify-question></h2><div class="router-clarify-grid">${clarificationButtons}</div><p>也可以回到输入框补充更多事实与约束。</p></section>
    <section class="router-safety section-shell" data-router-safety hidden><p class="kicker">SAFETY STOP</p>${safetyPanels}<div class="router-safety-facts" data-safety-facts hidden><h2>整理事实与问题清单</h2><ul><li>记录已经发生且可核对的事实。</li><li>区分你的判断与仍需确认的假设。</li><li>写下要向当地专业人士或紧急服务询问的问题。</li></ul></div></section>
    <section class="router-unavailable section-shell" data-router-unavailable hidden><p class="kicker">ROUTER UNAVAILABLE</p><h2>路由数据不可用</h2><p>请刷新页面，或先进入模型库按主题浏览。</p></section>
    <script type="application/json" data-router-payload>${payload}</script>`;
  return shell({
    title: "Agent 路由",
    description: "在浏览器本地识别问题类型与 Agent 阶段，并查看已策展的模型与组合。",
    pathname: "/router.html",
    active: "router",
    body,
    pageClass: "router-page",
    moduleScripts: ["assets/router-controller.mjs"]
  });
}

function chapterPortrait(entry, prefix, { eager = false, className = "mentor-portrait", variant = "hero" } = {}) {
  const portrait = entry.theme.portrait;
  const asset = portrait[variant];
  if (!asset) throw new Error(`Unknown chapter portrait variant: ${variant}`);
  const loading = eager ? "eager" : "lazy";
  const priority = eager ? ' fetchpriority="high"' : "";
  return `<picture class="${className}" data-asset-version="${portrait.asset_version}">
    <source srcset="${prefix}assets/${asset.avif_path}" type="image/avif">
    <source srcset="${prefix}assets/${asset.webp_path}" type="image/webp">
    <img src="${prefix}assets/${asset.webp_path}" width="${asset.width}" height="${asset.height}" alt="${escapeHtml(portrait.alt)}" loading="${loading}" decoding="async"${priority}>
  </picture>`;
}

function breadcrumbs(items) {
  return `<nav class="breadcrumbs" aria-label="面包屑">${items.map((item, index) => {
    const content = item.href ? `<a href="${item.href}">${escapeHtml(item.label)}</a>` : `<span aria-current="page">${escapeHtml(item.label)}</span>`;
    return `${index ? '<span aria-hidden="true">/</span>' : ""}${content}`;
  }).join("")}</nav>`;
}

function roleChips(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return "";
  return `<div class="chip-row" aria-label="Agent 角色">${roles.map((role) => `<span class="chip chip-agent">${escapeHtml(AGENT_ROLE_LABELS[role] || role)}</span>`).join("")}</div>`;
}

function modelSummaryCard(model, url) {
  const triggers = model.when_to_use?.triggers?.slice(0, 2) ?? [];
  const title = model.__displayName;
  const skillName = displayName(model.meta?.skill_name) || "思维模型";
  const search = [model.meta?.name, title, model.core_definition, ...(model.meta?.tags ?? []), ...triggers, ...(model.meta?.agent_roles ?? [])].join(" ");
  return `<article class="model-summary" data-filter-item data-search="${escapeHtml(search.toLowerCase())}">
    <div class="model-summary-top"><span class="eyebrow">${escapeHtml(skillName)}</span><span class="quality">${model.reasoning_steps?.length ?? 0} 步协议</span></div>
    <h2><a href="${url}">${escapeHtml(title)}</a></h2>
    <p>${escapeHtml(excerpt(model.core_definition))}</p>
    ${triggers.length ? `<div class="signal-line"><strong>适用：</strong>${escapeHtml(triggers.map((item) => excerpt(item, 54)).join(" · "))}</div>` : ""}
    ${roleChips(model.meta?.agent_roles)}
    <a class="text-link" href="${url}" aria-label="查看 ${escapeHtml(title)} 的完整推理协议">查看完整协议 <span aria-hidden="true">→</span></a>
  </article>`;
}

function section(title, content, options = {}) {
  if (!content) return "";
  const className = options.className ? ` ${options.className}` : "";
  return `<section class="detail-section${className}"><div class="section-heading"><span>${escapeHtml(options.index || "")}</span><h2>${escapeHtml(title)}</h2></div>${content}</section>`;
}

function replaceDirectory(candidate, target) {
  const backup = `${target}.previous`;
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, backup);
  try {
    renameSync(candidate, target);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
}

function assertRequiredAssets() {
  for (const name of ["site.css", "site.js", "favicon.svg", "router-engine.mjs", "router-controller.mjs"]) {
    if (!existsSync(join(ASSETS_DIR, name))) throw new Error(`缺少站点源资产: tools/site-assets/${name}`);
  }
}

function loadModels() {
  const files = readdirSync(MODELS_DIR).filter((file) => file.endsWith(".json")).sort(compareText);
  const seen = new Set();
  return files.map((file) => {
    const model = readJson(join(MODELS_DIR, file));
    if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error(`模型不是 JSON object: ${file}`);
    if (typeof model.id !== "string" || !model.id) throw new Error(`模型缺少 id: ${file}`);
    if (seen.has(model.id)) throw new Error(`模型 id 重复: ${model.id}`);
    seen.add(model.id);
    if (typeof model.meta?.name !== "string" || !model.meta.name) throw new Error(`模型缺少 meta.name: ${file}`);
    if (typeof model.meta?.category !== "string" || !model.meta.category) throw new Error(`模型缺少 meta.category: ${file}`);
    if (typeof model.core_definition !== "string" || !model.core_definition.trim()) throw new Error(`模型缺少 core_definition: ${file}`);
    const residue = findPublicModelResidue(model);
    if (residue.length) throw new Error(`模型含原始摄取残留: ${file}:${residue[0]}`);
    return {
      ...model,
      __sourceFile: file,
      __displayName: displayName(model.meta.name) || model.meta.name.trim(),
      __presentationScore: presentationScore(model),
    };
  }).sort((left, right) => {
    const presentation = right.__presentationScore - left.__presentationScore;
    if (presentation) return presentation;
    const quality = (Number(right.quality?.overall) || 0) - (Number(left.quality?.overall) || 0);
    return quality || compareText(left.meta.name, right.meta.name) || compareText(left.id, right.id);
  });
}

export async function buildSite() {
  assertRequiredAssets();
  const buildView = await loadV3AgentData(ROOT);
  const taxonomy = readJson(TAXONOMY_PATH);
  const presentation = validateChapterPresentation({
    taxonomy,
    mentors: readJson(CHAPTER_MENTORS_PATH),
    themes: readJson(CHAPTER_THEMES_PATH),
  });
  const portraitAssets = verifyChapterPortraitAssets({ assetsRoot: ASSETS_DIR, presentation });
  const presentationById = new Map(presentation.chapters.map((entry) => [entry.chapter.id, entry]));
  const chapters = [...taxonomy.chapters].sort((a, b) => Number(a.order) - Number(b.order));
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const models = loadModels();
  const curated = existsSync(CURATED_PATH) ? readJson(CURATED_PATH) : {};

  const byChapter = new Map(chapters.map((chapter) => [chapter.id, []]));
  for (const model of models) {
    if (!byChapter.has(model.meta.category)) throw new Error(`模型 ${model.id} 引用未知章节 ${model.meta.category}`);
    byChapter.get(model.meta.category).push(model);
  }

  const modelFile = new Map(models.map((model) => [model.id, deterministicModelFile(model)]));
  const modelsByName = new Map();
  for (const model of models) {
    const name = model.meta.name.trim();
    if (!modelsByName.has(name)) modelsByName.set(name, []);
    modelsByName.get(name).push(model);
  }

  const roleCount = {};
  for (const model of models) {
    for (const role of model.meta.agent_roles ?? []) roleCount[role] = (roleCount[role] ?? 0) + 1;
  }

  const tempRoot = mkdtempSync(join(ROOT, ".site-build-"));
  const output = join(tempRoot, "site");
  const chaptersDir = join(output, "chapters");
  const modelsDir = join(output, "models");
  const assetsDir = join(output, "assets");
  mkdirSync(chaptersDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  for (const name of ["site.css", "site.js", "favicon.svg", "router-engine.mjs", "router-controller.mjs"]) cpSync(join(ASSETS_DIR, name), join(assetsDir, name));
  writeTextFile(join(assetsDir, "chapter-themes.css"), compileChapterThemesCss(presentation));
  for (const result of portraitAssets) {
    for (const asset of [
      result.card.avif,
      result.card.webp,
      result.hero.avif,
      result.hero.webp,
    ]) {
      const target = join(assetsDir, asset.path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(ASSETS_DIR, asset.path), target);
    }
  }

  const chapterCards = chapters.map((chapter) => {
    const entry = presentationById.get(chapter.id);
    const count = byChapter.get(chapter.id).length;
    const signals = (chapter.allowed_tags ?? []).slice(0, 3);
    return `<a class="chapter-card" data-chapter="${chapter.id}" data-theme="${entry.theme.theme_key}" href="chapters/ch${chapter.id}-${chapter.slug}.html">
      <div class="chapter-card-media">${chapterPortrait(entry, "", { className: "mentor-portrait mentor-portrait-card", variant: "card" })}<span class="chapter-number">${chapter.id}</span></div>
      <div class="chapter-card-copy"><p class="eyebrow">CHAPTER ${chapter.id} · ${escapeHtml(entry.mentor.dynasty)}</p><h3>${escapeHtml(chapter.title)}</h3><p>${escapeHtml(chapter.description)}</p><p class="chapter-mentor-name">章节导师 · ${escapeHtml(entry.mentor.name)}</p></div>
      <div class="chapter-card-footer"><span>${count} 个模型</span><span>${escapeHtml(signals.join(" · "))}</span><b aria-hidden="true">↗</b></div>
    </a>`;
  }).join("");

  const curatedCards = Object.entries(curated).map(([key, collection], curatedIndex) => {
    const matched = [];
    const seenCurated = new Set();
    for (const item of collection.models ?? []) {
      const model = modelsByName.get(item.name)?.[0];
      if (model && !seenCurated.has(model.id)) {
        seenCurated.add(model.id);
        matched.push(model);
      }
      if (matched.length === 4) break;
    }
    const first = matched[0];
    const indexLabel = String(curatedIndex + 1).padStart(2, "0");
    return `<article class="curated-card">
      <div class="curated-index">${indexLabel} · ${escapeHtml(key.replace(/_/g, " "))}</div>
      <h3>${escapeHtml(stripEmoji(collection.title))}</h3><p>${escapeHtml(stripEmoji(collection.desc))}</p>
      <div class="curated-links">${matched.map((model) => `<a href="models/${modelFile.get(model.id)}">${escapeHtml(model.__displayName)}</a>`).join("") || "<span>内容整理中</span>"}</div>
      ${first ? `<a class="text-link" href="models/${modelFile.get(first.id)}">从首个模型开始 <span aria-hidden="true">→</span></a>` : ""}
    </article>`;
  }).join("");

  const agentCards = AGENT_FLOWS.map((flow) => {
    const count = flow.roles.reduce((sum, role) => sum + (roleCount[role] ?? 0), 0);
    return `<a class="agent-flow-card" href="router.html"><span>${flow.code}</span><h3>${escapeHtml(flow.name)}</h3><p>${escapeHtml(flow.description)}</p><small>${count} 个角色关联模型</small></a>`;
  }).join("");

  const leadChapter = presentationById.get("00");
  const homeBody = `<section class="hero section-shell" data-chapter="00" data-theme="${leadChapter.theme.theme_key}">
    <div class="hero-copy"><p class="kicker"><span></span> ORIENTAL THINKING WORKBENCH</p>
      <h1>前车之鉴<em>思维制胜</em></h1>
      <p class="hero-subtitle">${PRODUCT_SUBTITLE}</p>
      <p class="hero-lead">由 ${models.length} 个思维模型与十三位东方章节导师构成的本地知识工作台。先辨方向，再选框架，最终形成可验证的行动。</p>
      <div class="hero-actions"><a class="button button-primary" href="router.html">描述问题，匹配模型</a><a class="button button-secondary" href="models/index.html">浏览全部模型</a></div>
      <dl class="hero-metrics"><div><dt>${models.length}</dt><dd>结构化模型</dd></div><div><dt>${chapters.length}</dt><dd>认知章节</dd></div><div><dt>${Object.keys(roleCount).length}</dt><dd>Agent 角色</dd></div></dl>
    </div>
    <figure class="hero-monument">${chapterPortrait(leadChapter, "", { eager: true, className: "mentor-portrait mentor-portrait-lead" })}<figcaption><strong>${escapeHtml(leadChapter.mentor.name)}</strong><span>${escapeHtml(leadChapter.mentor.role)} · ${escapeHtml(leadChapter.mentor.portrait_notice)}</span></figcaption></figure>
  </section>
  <section class="section-shell value-strip" aria-label="产品原则"><div><span>01</span><strong>问题优先</strong><p>从真实问题出发，不从模型名称出发。</p></div><div><span>02</span><strong>证据边界</strong><p>显式区分事实、假设、风险与待复核内容。</p></div><div><span>03</span><strong>可执行协议</strong><p>每个模型落到步骤、检查点和 Codex 提示词。</p></div></section>
  <section class="section-shell section-block"><div class="section-intro"><p class="kicker">CURATED PATHS</p><h2>按场景，直达关键模型</h2><p>六条经过策展的起步路径，帮你避开“模型很多，却不知道先用哪个”。</p></div><div class="curated-grid">${curatedCards}</div></section>
  <section class="agent-band"><div class="section-shell"><div class="section-intro inverse"><p class="kicker">AGENT REASONING</p><h2>让模型进入完整推理流程</h2><p>从澄清、推演到执行与复盘，把零散工具组合成可持续工作的 Agent 角色。</p></div><div class="agent-flow-grid">${agentCards}</div><a class="button button-light" href="router.html">进入 Agent 路由器</a></div></section>
  <section class="section-shell section-block"><div class="section-intro"><p class="kicker">KNOWLEDGE MAP</p><h2>十三章认知地图</h2><p>每个模型只有一个主章节，同时通过标签和 Agent 角色建立跨章节连接。</p></div><div class="chapter-grid">${chapterCards}</div></section>`;
  writeTextFile(join(output, "index.html"), shell({ title: PRODUCT_NAME, description: `${PRODUCT_SUBTITLE}。把复杂问题转化为可理解、可选择、可执行的推理协议。`, pathname: "/", active: "home", body: homeBody, pageClass: "home-page" }));

  const allModelCards = models.map((model) => modelSummaryCard(model, modelFile.get(model.id))).join("");
  const modelsBody = `${breadcrumbs([{ href: "../index.html", label: "首页" }, { label: "模型库" }])}
    <section class="page-hero section-shell compact"><p class="kicker">MODEL LIBRARY</p><h1>模型库</h1><p>从 ${models.length} 个模型中按名称、定义、触发信号、标签与 Agent 角色筛选。</p></section>
    <section class="section-shell library-layout"><aside class="filter-panel"><label for="model-filter">搜索模型</label><div class="search-box"><span aria-hidden="true">⌕</span><input id="model-filter" type="search" placeholder="例如：根因、决策、系统…" autocomplete="off" data-filter-input></div><p><strong data-filter-count>${models.length}</strong> 个结果</p><a href="../router.html">不确定用什么？试试 Agent 路由器 →</a></aside><div><div class="model-list" data-filter-list>${allModelCards}</div><p class="empty-state" hidden data-filter-empty>没有匹配结果。尝试减少关键词，或使用 Agent 路由器描述问题。</p></div></section>`;
  writeTextFile(join(modelsDir, "index.html"), shell({ title: "模型库", description: `浏览和筛选 ${models.length} 个系统化思维模型。`, pathname: "/models/", depth: 1, active: "models", body: modelsBody, pageClass: "library-page" }));

  for (const chapter of chapters) {
    const entry = presentationById.get(chapter.id);
    const chapterModels = byChapter.get(chapter.id);
    const chapterPath = `ch${chapter.id}-${chapter.slug}.html`;
    const cards = chapterModels.map((model) => modelSummaryCard(model, `../models/${modelFile.get(model.id)}`)).join("");
    const subchapters = (chapter.subchapters ?? []).map((item) => `<li class="topic-pill">${escapeHtml(item.title)}</li>`).join("");
    const index = chapters.findIndex((item) => item.id === chapter.id);
    const previous = chapters[index - 1];
    const next = chapters[index + 1];
    const chapterBody = `${breadcrumbs([{ href: "../index.html", label: "首页" }, { label: `Ch.${chapter.id} ${chapter.title}` }])}
      <section class="page-hero section-shell chapter-hero"><div class="chapter-heading"><p class="kicker">CHAPTER ${chapter.id} · ${escapeHtml(entry.mentor.dynasty)}</p><h1>${escapeHtml(chapter.title)}</h1><p class="chapter-description">${escapeHtml(chapter.description)}</p></div><div class="mentor-intro"><span>章节导师</span><h2>${escapeHtml(entry.mentor.name)}<small>${escapeHtml(entry.mentor.role)}</small></h2><p>${escapeHtml(entry.mentor.curatorial_intro)}</p></div><dl class="chapter-symbols"><div><dt>空间</dt><dd>${escapeHtml(entry.theme.mece.space)}</dd></div><div><dt>器物</dt><dd>${escapeHtml(entry.theme.mece.object)}</dd></div><div><dt>纹样</dt><dd>${escapeHtml(entry.theme.mece.pattern)}</dd></div></dl><figure class="mentor-figure">${chapterPortrait(entry, "../", { eager: true })}<figcaption><strong>${escapeHtml(entry.mentor.name)}</strong><span>${escapeHtml(entry.mentor.portrait_notice)}</span></figcaption></figure></section>
      <section class="section-shell chapter-topics" aria-labelledby="topics-${chapter.id}"><div class="chapter-section-title"><span aria-hidden="true"></span><div><p class="eyebrow">CHAPTER THREADS</p><h2 id="topics-${chapter.id}">本章脉络</h2></div></div><ul>${subchapters}</ul></section>
      <section class="section-shell chapter-library"><div class="chapter-toolbar"><div><h2>本章模型</h2><p>按质量与名称稳定排序 · <strong data-filter-count>${chapterModels.length}</strong> 个结果</p></div><div class="search-box small"><span aria-hidden="true">⌕</span><label class="sr-only" for="filter-${chapter.id}">筛选本章模型</label><input id="filter-${chapter.id}" type="search" placeholder="筛选本章…" autocomplete="off" data-filter-input></div></div><div class="model-list" data-filter-list>${cards}</div><p class="empty-state" hidden data-filter-empty>本章没有匹配的模型。请减少关键词，或返回本章脉络重新选择。</p></section>
      <nav class="chapter-pager section-shell" aria-label="章节翻页">${previous ? `<a href="ch${previous.id}-${previous.slug}.html"><span>上一章</span><strong>Ch.${previous.id} ${escapeHtml(previous.title)}</strong></a>` : "<span></span>"}${next ? `<a class="next" href="ch${next.id}-${next.slug}.html"><span>下一章</span><strong>Ch.${next.id} ${escapeHtml(next.title)}</strong></a>` : "<span></span>"}</nav>`;
    writeTextFile(join(chaptersDir, chapterPath), shell({ title: `Ch.${chapter.id} ${chapter.title}`, description: chapter.description, pathname: `/chapters/${chapterPath}`, depth: 1, body: chapterBody, pageClass: "chapter-page has-chapter-theme", chapterId: chapter.id, themeKey: entry.theme.theme_key }));
  }

  for (const model of models) {
    const chapter = chapterById.get(model.meta.category);
    const chapterModels = byChapter.get(chapter.id);
    const position = chapterModels.findIndex((item) => item.id === model.id);
    const previous = chapterModels[position - 1];
    const next = chapterModels[position + 1];
    const triggers = textList(model.when_to_use?.triggers);
    const antiTriggers = textList(model.when_to_use?.anti_triggers, "plain-list warning-list");
    const beforeAfter = model.before_after?.without_model || model.before_after?.with_model ? `<div class="before-after"><div><span>WITHOUT</span><h3>没有这个模型</h3><p>${escapeHtml(plainText(model.before_after?.without_model))}</p></div><div><span>WITH</span><h3>使用这个模型</h3><p>${escapeHtml(plainText(model.before_after?.with_model))}</p></div></div>` : "";
    const steps = (model.reasoning_steps ?? []).map((step, index) => `<li><span>${String(index + 1).padStart(2, "0")}</span><div><h3>${escapeHtml(plainText(step.action || `步骤 ${step.step || index + 1}`))}</h3>${step.checkpoint ? `<p><strong>检查点：</strong>${escapeHtml(plainText(step.checkpoint))}</p>` : ""}</div></li>`).join("");
    const scenarios = Object.entries(model.scenarios ?? {}).map(([domain, scenario]) => `<article><span>${escapeHtml(plainText(domain))}</span><h3>${escapeHtml(plainText(scenario.situation || "应用场景"))}</h3><p>${escapeHtml(plainText(scenario.application || ""))}</p></article>`).join("");
    const promptId = `prompt-${createHash("sha256").update(model.id).digest("hex").slice(0, 10)}`;
    const activation = model.codex_integration?.activation;
    const systemPrompt = model.codex_integration?.system_prompt;
    const codexCard = activation || systemPrompt ? `<div class="codex-panel"><div class="codex-panel-head"><div><span>CODEX PLAYBOOK</span><h3>与 Codex 共学应用卡</h3></div>${systemPrompt ? `<button class="button button-copy" type="button" data-copy-target="${promptId}">复制完整提示词</button>` : ""}</div>${activation ? `<p class="activation"><strong>激活方式</strong>${escapeHtml(activation)}</p>` : ""}${systemPrompt ? `<pre id="${promptId}" tabindex="0"><code>${escapeHtml(systemPrompt)}</code></pre>` : ""}</div>` : "";
    const tags = sanitizePublicModelTags(model.meta.tags)
      .map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`)
      .join("");
    const chapterPresentation = presentationById.get(chapter.id);
    const modelBody = `${breadcrumbs([{ href: "../index.html", label: "首页" }, { href: `../chapters/ch${chapter.id}-${chapter.slug}.html`, label: `Ch.${chapter.id} ${chapter.title}` }, { label: model.__displayName }])}
      <article class="model-detail section-shell"><header class="model-detail-hero"><div><p class="kicker">${escapeHtml(displayName(model.meta.skill_name) || `CHAPTER ${chapter.id}`)}</p><p class="model-mentor-link"><a href="../chapters/ch${chapter.id}-${chapter.slug}.html">本章导师 · ${escapeHtml(chapterPresentation.mentor.name)}</a></p><h1>${escapeHtml(model.__displayName)}</h1><p class="definition">${escapeHtml(plainText(model.core_definition))}</p><div class="chip-row">${tags}</div>${roleChips(model.meta.agent_roles)}</div><aside><span>PROTOCOL</span><strong>${model.reasoning_steps?.length ?? 0}<small>步</small></strong><p>${escapeHtml(chapter.title)}</p></aside></header>
        <div class="detail-grid"><div class="detail-main">
          ${beforeAfter}
          ${section("适用信号", triggers, { index: "01" })}
          ${section("不适用与停止条件", antiTriggers, { index: "02", className: "warning-section" })}
          ${section("推理协议", steps ? `<ol class="protocol-list">${steps}</ol>` : "", { index: "03" })}
          ${section("场景示例", scenarios ? `<div class="scenario-grid">${scenarios}</div>` : "", { index: "04" })}
          ${section("常见误区", textList(model.pitfalls), { index: "05" })}
        </div><aside class="detail-aside">${codexCard}<div class="evidence-note"><span>EVIDENCE NOTE</span><h3>使用边界</h3><p>模型用于组织思考，不代表事实已经成立。关键结论仍需回到来源、数据和真实反馈中验证。</p></div></aside></div>
      </article>
      <nav class="model-pager section-shell" aria-label="模型翻页">${previous ? `<a href="${modelFile.get(previous.id)}"><span>上一个模型</span><strong>${escapeHtml(previous.__displayName)}</strong></a>` : "<span></span>"}${next ? `<a class="next" href="${modelFile.get(next.id)}"><span>下一个模型</span><strong>${escapeHtml(next.__displayName)}</strong></a>` : "<span></span>"}</nav>`;
    const file = modelFile.get(model.id);
    writeTextFile(join(modelsDir, file), shell({ title: model.__displayName, description: model.core_definition.slice(0, 150), pathname: `/models/${file}`, depth: 1, active: "models", body: modelBody, pageClass: "model-page has-chapter-theme", chapterId: chapter.id, themeKey: chapterPresentation.theme.theme_key }));
  }

  writeTextFile(join(output, "router.html"), renderRouterPage({ buildView, modelFile }));

  const notFoundBody = `<section class="not-found section-shell"><p class="kicker">ERROR 404</p><strong>404</strong><h1>这条推理路径不存在</h1><p>页面可能已移动，或链接指向了旧版单页结构。</p><div><a class="button button-primary" href="index.html">返回首页</a><a class="button button-secondary" href="models/index.html">浏览模型库</a></div></section>`;
  writeTextFile(join(output, "404.html"), shell({ title: "页面未找到", description: `请求的${PRODUCT_NAME}页面不存在。`, pathname: "/404.html", body: notFoundBody, pageClass: "error-page" }));
  writeTextFile(join(output, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);

  const urls = ["/", "/models/", "/router.html", ...chapters.map((chapter) => `/chapters/ch${chapter.id}-${chapter.slug}.html`), ...models.map((model) => `/models/${modelFile.get(model.id)}`)];
  writeTextFile(join(output, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${canonical(url)}</loc></url>`).join("\n")}\n</urlset>\n`);

  const expected = 2 + chapters.length + models.length + 3 + 3;
  const actual = readdirSync(output).length + readdirSync(chaptersDir).length + readdirSync(modelsDir).length + readdirSync(assetsDir).length - 3;
  if (actual < expected) throw new Error(`站点文件数量异常: expected>=${expected}, actual=${actual}`);

  replaceDirectory(output, SITE_DIR);
  const docsCandidate = join(tempRoot, "docs");
  cpSync(SITE_DIR, docsCandidate, { recursive: true });
  replaceDirectory(docsCandidate, DOCS_DIR);
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(`✅ 多页站构建完成：${models.length} 模型 · ${chapters.length} 章节 · site/ 与 docs/ 已同步`);
}

if (import.meta.main) await buildSite();
