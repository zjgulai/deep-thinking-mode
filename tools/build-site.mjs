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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadV3AgentData } from "./lib/v3-agent-data.mjs";
import { findPublicModelResidue } from "./lib/public-model-sanitizer.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODELS_DIR = join(ROOT, "knowledge", "models-v3");
const TAXONOMY_PATH = join(ROOT, "knowledge", "taxonomy.json");
const CURATED_PATH = join(ROOT, "knowledge", "curated-collections.json");
const ROUTER_PATH = join(ROOT, "chain-protocols", "agent-router-index.json");
const ASSETS_DIR = join(ROOT, "tools", "site-assets");
const SITE_DIR = join(ROOT, "site");
const DOCS_DIR = join(ROOT, "docs");
const ORIGIN = "https://xmind.lute-tlz-dddd.top";

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

const PROBLEM_LABELS = {
  diagnosis: "诊断根因",
  planning: "制定计划",
  decision: "辅助决策",
  creative: "探索创新",
  research: "深度研究",
  communication: "组织表达",
  reflection: "复盘反思",
  clarification: "澄清问题",
};

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

function shell({ title, description, pathname, depth = 0, active = "", body, pageClass = "" }) {
  const prefix = assetPrefix(depth);
  const pageTitle = title === "系统化思维" ? title : `${title}｜系统化思维`;
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
  <meta name="theme-color" content="#f6f2eb">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'none'; font-src 'self'">
  <link rel="canonical" href="${canonical(pathname)}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="zh_CN">
  <meta property="og:site_name" content="系统化思维">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonical(pathname)}">
  <link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${prefix}assets/site.css">
  <title>${escapeHtml(pageTitle)}</title>
</head>
<body class="${escapeHtml(pageClass)}">
  <a class="skip-link" href="#main-content">跳至正文</a>
  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="${prefix}index.html" aria-label="系统化思维首页">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span><strong>系统化思维</strong><small>Thinking Systems</small></span>
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
    <div><strong>系统化思维</strong><span>把模型变成可执行的推理协议</span></div>
    <p>本地静态运行 · 无追踪 · 内容仅作认知工具，不替代医疗、法律或财务专业意见</p>
  </footer>
  <div class="toast" role="status" aria-live="polite" aria-atomic="true" data-toast></div>
  <script src="${prefix}assets/site.js" defer></script>
</body>
</html>`;
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
  for (const name of ["site.css", "site.js", "favicon.svg"]) {
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

async function build() {
  assertRequiredAssets();
  await loadV3AgentData(ROOT);
  const taxonomy = readJson(TAXONOMY_PATH);
  const chapters = [...taxonomy.chapters].sort((a, b) => Number(a.order) - Number(b.order));
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const models = loadModels();
  const curated = existsSync(CURATED_PATH) ? readJson(CURATED_PATH) : {};
  const router = existsSync(ROUTER_PATH) ? readJson(ROUTER_PATH) : { problem_type_signals: {}, routing_table: {} };

  const byChapter = new Map(chapters.map((chapter) => [chapter.id, []]));
  for (const model of models) {
    if (!byChapter.has(model.meta.category)) throw new Error(`模型 ${model.id} 引用未知章节 ${model.meta.category}`);
    byChapter.get(model.meta.category).push(model);
  }

  const modelFile = new Map(models.map((model) => [model.id, deterministicModelFile(model)]));
  const modelBySource = new Map(models.map((model) => [model.__sourceFile, model]));
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
  for (const name of ["site.css", "site.js", "favicon.svg"]) cpSync(join(ASSETS_DIR, name), join(assetsDir, name));

  const chapterCards = chapters.map((chapter) => {
    const count = byChapter.get(chapter.id).length;
    const signals = (chapter.allowed_tags ?? []).slice(0, 3);
    return `<a class="chapter-card" href="chapters/ch${chapter.id}-${chapter.slug}.html">
      <span class="chapter-number">${chapter.id}</span>
      <div><p class="eyebrow">CHAPTER ${chapter.id}</p><h3>${escapeHtml(chapter.title)}</h3><p>${escapeHtml(chapter.description)}</p></div>
      <div class="chapter-card-footer"><span>${count} 个模型</span><span>${escapeHtml(signals.join(" · "))}</span><b aria-hidden="true">↗</b></div>
    </a>`;
  }).join("");

  const curatedCards = Object.entries(curated).map(([key, collection]) => {
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
    return `<article class="curated-card">
      <div class="curated-index">${escapeHtml(key.replace(/_/g, " "))}</div>
      <h3>${escapeHtml(collection.title)}</h3><p>${escapeHtml(collection.desc)}</p>
      <div class="curated-links">${matched.map((model) => `<a href="models/${modelFile.get(model.id)}">${escapeHtml(model.__displayName)}</a>`).join("") || "<span>内容整理中</span>"}</div>
      ${first ? `<a class="text-link" href="models/${modelFile.get(first.id)}">从首个模型开始 <span aria-hidden="true">→</span></a>` : ""}
    </article>`;
  }).join("");

  const agentCards = AGENT_FLOWS.map((flow) => {
    const count = flow.roles.reduce((sum, role) => sum + (roleCount[role] ?? 0), 0);
    return `<a class="agent-flow-card" href="router.html#flow-${flow.code}"><span>${flow.code}</span><h3>${escapeHtml(flow.name)}</h3><p>${escapeHtml(flow.description)}</p><small>${count} 个角色关联模型</small></a>`;
  }).join("");

  const homeBody = `<section class="hero section-shell">
    <div class="hero-copy"><p class="kicker"><span></span> SYSTEMATIC THINKING WORKBENCH</p>
      <h1>把复杂问题，<em>转化为可执行的推理。</em></h1>
      <p class="hero-lead">一个由 ${models.length} 个思维模型构成的本地知识工作台。先澄清问题，再选择框架，最后形成可验证的行动。</p>
      <div class="hero-actions"><a class="button button-primary" href="router.html">描述问题，匹配模型</a><a class="button button-secondary" href="models/index.html">浏览全部模型</a></div>
      <dl class="hero-metrics"><div><dt>${models.length}</dt><dd>结构化模型</dd></div><div><dt>${chapters.length}</dt><dd>认知章节</dd></div><div><dt>${Object.keys(roleCount).length}</dt><dd>Agent 角色</dd></div></dl>
    </div>
    <div class="hero-visual" aria-hidden="true"><div class="orbit orbit-a"></div><div class="orbit orbit-b"></div><div class="core-node"><span>THINK</span><strong>系统</strong></div><i class="satellite s1">定义</i><i class="satellite s2">分析</i><i class="satellite s3">决策</i><i class="satellite s4">行动</i></div>
  </section>
  <section class="section-shell value-strip" aria-label="产品原则"><div><span>01</span><strong>问题优先</strong><p>从真实问题出发，不从模型名称出发。</p></div><div><span>02</span><strong>证据边界</strong><p>显式区分事实、假设、风险与待复核内容。</p></div><div><span>03</span><strong>可执行协议</strong><p>每个模型落到步骤、检查点和 Codex 提示词。</p></div></section>
  <section class="section-shell section-block"><div class="section-intro"><p class="kicker">CURATED PATHS</p><h2>按场景，直达关键模型</h2><p>六条经过策展的起步路径，帮你避开“模型很多，却不知道先用哪个”。</p></div><div class="curated-grid">${curatedCards}</div></section>
  <section class="agent-band"><div class="section-shell"><div class="section-intro inverse"><p class="kicker">AGENT REASONING</p><h2>让模型进入完整推理流程</h2><p>从澄清、推演到执行与复盘，把零散工具组合成可持续工作的 Agent 角色。</p></div><div class="agent-flow-grid">${agentCards}</div><a class="button button-light" href="router.html">进入 Agent 路由器</a></div></section>
  <section class="section-shell section-block"><div class="section-intro"><p class="kicker">KNOWLEDGE MAP</p><h2>十三章认知地图</h2><p>每个模型只有一个主章节，同时通过标签和 Agent 角色建立跨章节连接。</p></div><div class="chapter-grid">${chapterCards}</div></section>`;
  writeTextFile(join(output, "index.html"), shell({ title: "系统化思维", description: "把复杂问题转化为可理解、可选择、可执行的推理协议。", pathname: "/", active: "home", body: homeBody, pageClass: "home-page" }));

  const allModelCards = models.map((model) => modelSummaryCard(model, modelFile.get(model.id))).join("");
  const modelsBody = `${breadcrumbs([{ href: "../index.html", label: "首页" }, { label: "模型库" }])}
    <section class="page-hero section-shell compact"><p class="kicker">MODEL LIBRARY</p><h1>模型库</h1><p>从 ${models.length} 个模型中按名称、定义、触发信号、标签与 Agent 角色筛选。</p></section>
    <section class="section-shell library-layout"><aside class="filter-panel"><label for="model-filter">搜索模型</label><div class="search-box"><span aria-hidden="true">⌕</span><input id="model-filter" type="search" placeholder="例如：根因、决策、系统…" autocomplete="off" data-filter-input></div><p><strong data-filter-count>${models.length}</strong> 个结果</p><a href="../router.html">不确定用什么？试试 Agent 路由器 →</a></aside><div><div class="model-list" data-filter-list>${allModelCards}</div><p class="empty-state" hidden data-filter-empty>没有匹配结果。尝试减少关键词，或使用 Agent 路由器描述问题。</p></div></section>`;
  writeTextFile(join(modelsDir, "index.html"), shell({ title: "模型库", description: `浏览和筛选 ${models.length} 个系统化思维模型。`, pathname: "/models/", depth: 1, active: "models", body: modelsBody, pageClass: "library-page" }));

  for (const chapter of chapters) {
    const chapterModels = byChapter.get(chapter.id);
    const chapterPath = `ch${chapter.id}-${chapter.slug}.html`;
    const cards = chapterModels.map((model) => modelSummaryCard(model, `../models/${modelFile.get(model.id)}`)).join("");
    const subchapters = (chapter.subchapters ?? []).map((item) => `<span class="topic-pill">${escapeHtml(item.title)}</span>`).join("");
    const index = chapters.findIndex((item) => item.id === chapter.id);
    const previous = chapters[index - 1];
    const next = chapters[index + 1];
    const chapterBody = `${breadcrumbs([{ href: "../index.html", label: "首页" }, { label: `Ch.${chapter.id} ${chapter.title}` }])}
      <section class="page-hero section-shell chapter-hero"><div><p class="kicker">CHAPTER ${chapter.id}</p><h1>${escapeHtml(chapter.title)}</h1><p>${escapeHtml(chapter.description)}</p></div><div class="chapter-stat"><strong>${chapterModels.length}</strong><span>个模型</span></div></section>
      <section class="section-shell chapter-topics" aria-label="本章主题">${subchapters}</section>
      <section class="section-shell chapter-library"><div class="chapter-toolbar"><div><h2>本章模型</h2><p>按质量与名称稳定排序</p></div><div class="search-box small"><span aria-hidden="true">⌕</span><label class="sr-only" for="filter-${chapter.id}">筛选本章模型</label><input id="filter-${chapter.id}" type="search" placeholder="筛选本章…" autocomplete="off" data-filter-input></div></div><div class="model-list" data-filter-list>${cards}</div><p class="empty-state" hidden data-filter-empty>本章没有匹配的模型。</p></section>
      <nav class="chapter-pager section-shell" aria-label="章节翻页">${previous ? `<a href="ch${previous.id}-${previous.slug}.html"><span>上一章</span><strong>Ch.${previous.id} ${escapeHtml(previous.title)}</strong></a>` : "<span></span>"}${next ? `<a class="next" href="ch${next.id}-${next.slug}.html"><span>下一章</span><strong>Ch.${next.id} ${escapeHtml(next.title)}</strong></a>` : "<span></span>"}</nav>`;
    writeTextFile(join(chaptersDir, chapterPath), shell({ title: `Ch.${chapter.id} ${chapter.title}`, description: chapter.description, pathname: `/chapters/${chapterPath}`, depth: 1, body: chapterBody, pageClass: "chapter-page" }));
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
    const tags = (model.meta.tags ?? []).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("");
    const modelBody = `${breadcrumbs([{ href: "../index.html", label: "首页" }, { href: `../chapters/ch${chapter.id}-${chapter.slug}.html`, label: `Ch.${chapter.id} ${chapter.title}` }, { label: model.__displayName }])}
      <article class="model-detail section-shell"><header class="model-detail-hero"><div><p class="kicker">${escapeHtml(displayName(model.meta.skill_name) || `CHAPTER ${chapter.id}`)}</p><h1>${escapeHtml(model.__displayName)}</h1><p class="definition">${escapeHtml(plainText(model.core_definition))}</p><div class="chip-row">${tags}</div>${roleChips(model.meta.agent_roles)}</div><aside><span>PROTOCOL</span><strong>${model.reasoning_steps?.length ?? 0}<small>步</small></strong><p>${escapeHtml(chapter.title)}</p></aside></header>
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
    writeTextFile(join(modelsDir, file), shell({ title: model.__displayName, description: model.core_definition.slice(0, 150), pathname: `/models/${file}`, depth: 1, active: "models", body: modelBody, pageClass: "model-page" }));
  }

  const routingCards = Object.entries(router.problem_type_signals ?? {}).map(([type, keywords], index) => {
    const entries = Object.values(router.routing_table ?? {}).filter((entry) => entry.problem_type === type);
    const roles = [...new Set(entries.flatMap((entry) => entry.recommended_roles ?? []))];
    const recommendedModels = [];
    for (const entry of entries) {
      for (const item of entry.stateful_models ?? []) {
        const model = modelBySource.get(item.file) || modelsByName.get(item.name)?.[0];
        if (model && !recommendedModels.some((candidate) => candidate.id === model.id)) recommendedModels.push(model);
      }
    }
    return `<article class="route-result" id="route-${escapeHtml(type)}" data-route-card data-keywords="${escapeHtml((keywords ?? []).join(" ").toLowerCase())}" hidden>
      <div class="route-result-number">${String(index + 1).padStart(2, "0")}</div><div><p class="eyebrow">RECOMMENDED PATH</p><h2>${escapeHtml(PROBLEM_LABELS[type] || type)}</h2><p>识别信号：${escapeHtml((keywords ?? []).slice(0, 5).join(" · "))}</p>${roleChips(roles)}<div class="route-models">${recommendedModels.slice(0, 4).map((model) => `<a href="models/${modelFile.get(model.id)}"><strong>${escapeHtml(model.__displayName)}</strong><span>${escapeHtml(excerpt(model.core_definition, 70))}</span></a>`).join("")}</div></div>
    </article>`;
  }).join("");
  const flowDetails = AGENT_FLOWS.map((flow) => `<article id="flow-${flow.code}"><span>${flow.code}</span><div><h3>${escapeHtml(flow.name)}</h3><p>${escapeHtml(flow.description)}</p><div class="chip-row">${flow.roles.map((role) => `<span class="chip chip-agent">${escapeHtml(AGENT_ROLE_LABELS[role] || role)} · ${roleCount[role] ?? 0}</span>`).join("")}</div></div></article>`).join("");
  const routerBody = `${breadcrumbs([{ href: "index.html", label: "首页" }, { label: "Agent 路由" }])}
    <section class="router-hero section-shell"><div><p class="kicker">LOCAL REASONING ROUTER</p><h1>先描述问题，<em>再选择模型。</em></h1><p>所有匹配都在浏览器本地完成。它是关键词导航，不是 AI 判断，也不会上传或保存你的输入。</p></div><form class="problem-form" data-router-form><label for="problem-input">你现在真正想解决什么？</label><textarea id="problem-input" rows="5" placeholder="例如：项目连续延期，我想判断根因并制定下一步计划……" data-router-input></textarea><div><button class="button button-primary" type="submit">匹配推理路径</button><button class="button button-ghost" type="reset">清空</button></div><p class="form-note" role="status" aria-live="polite" data-router-status>输入至少 2 个字，系统会返回一个核心路径和最多两个辅助路径。</p></form></section>
    <section class="section-shell route-results" aria-label="匹配结果"><div data-route-results>${routingCards}</div><div class="route-placeholder" data-route-placeholder><span>ROUTE</span><p>匹配结果会在这里出现</p></div></section>
    <section class="agent-system"><div class="section-shell"><div class="section-intro inverse"><p class="kicker">ROLE SYSTEM</p><h2>八段式 Agent 推理系统</h2><p>模型只是能力单元；角色与阶段决定它何时被调用、怎样交接和如何验证。</p></div><div class="flow-details">${flowDetails}</div></div></section>`;
  writeTextFile(join(output, "router.html"), shell({ title: "Agent 路由", description: "在浏览器本地描述问题，并按关键词匹配思维模型与 Agent 推理角色。", pathname: "/router.html", active: "router", body: routerBody, pageClass: "router-page" }));

  const notFoundBody = `<section class="not-found section-shell"><p class="kicker">ERROR 404</p><strong>404</strong><h1>这条推理路径不存在</h1><p>页面可能已移动，或链接指向了旧版单页结构。</p><div><a class="button button-primary" href="index.html">返回首页</a><a class="button button-secondary" href="models/index.html">浏览模型库</a></div></section>`;
  writeTextFile(join(output, "404.html"), shell({ title: "页面未找到", description: "请求的系统化思维页面不存在。", pathname: "/404.html", body: notFoundBody, pageClass: "error-page" }));
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

await build();
