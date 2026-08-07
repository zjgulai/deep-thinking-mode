#!/usr/bin/env node
/**
 * eval-prompt-quality.mjs — P1 三维质量评估
 *
 * 评估维度（来自 specs/system-prompt-quality-standard.md）：
 *   A. 保真度 (Fidelity)   — 去掉模型名字后提示词是否仍有意义
 *   B. 区分度 (Differentiation) — 各模型的推理协议是否可互换
 *   C. 激活度 (Activation) — 输出对比测试问题清单（人工投 Codex 验证）
 *
 * 用法: node tools/eval-prompt-quality.mjs [--all | --ids id1,id2,...]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT   = fileURLToPath(new URL("..", import.meta.url));
const V3_DIR = join(ROOT, "knowledge", "models-v3");
const OUT    = join(ROOT, "specs", "prompt-eval-results.md");

// ─── CLI 参数 ───────────────────────────────────────────
const args   = process.argv.slice(2);
const allMode = args.includes("--all");
const idsArg  = args.find(a => a.startsWith("--ids="));
const targetIds = idsArg
  ? idsArg.replace("--ids=", "").split(",")
  : [
      "第一性原理_看透本质_高效破局的底层",
      "5_whys分析法_从表象到本质_高",
      "系统思维_看清关联_高效破局的底层认",
      "框架思维_核心功能解析与高效落地路径",
      "10个时间黑洞_多巴胺陷阱_决策瘫痪",
    ];

// ─── 加载模型 ───────────────────────────────────────────
function loadModels(ids) {
  const files = readdirSync(V3_DIR).filter(f => f.endsWith(".json"));
  const models = [];
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(V3_DIR, f), "utf8"));
    const id = d.id || f.replace(".json", "");
    if (!allMode && !ids.some(t => id.includes(t) || f.includes(t))) continue;
    models.push(d);
  }
  return models;
}

// ─── 维度 A: 保真度评分 ──────────────────────────────────
// 核心指标: 把模型名从 system_prompt 里删除后，剩余内容仍有具体操作指令
function scoreFidelity(model) {
  const name   = model.meta?.name || "";
  const sp     = model.codex_integration?.system_prompt || "";
  const score  = { value: 0, reason: "" };

  if (!sp || sp.length < 50) {
    score.reason = "❌ system_prompt 过短（<50字）";
    return score;
  }

  // 去掉所有名字变体后剩余内容
  const stripped = sp
    .replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "XXXX")
    .replace(/XXXX[^。\n]*/, "")
    .trim();

  // 必须有推理协议关键词
  const hasProtocol = /步骤|追问|拆解|列出|标注|自问|验证|诊断|识别|画出|定位/.test(stripped);
  // 质量门禁必须有具体判断标准
  const hasGate = /自问|问自己|如果.*那|继续|不是.*而是|标准|门禁/.test(stripped);
  // 不能再有模型名字作为主体
  const nameFreq = (sp.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;

  let pts = 0;
  const reasons = [];

  if (sp.length >= 150)   { pts += 2; reasons.push("✓ 长度达标（≥150字）"); }
  else if (sp.length >= 100) { pts += 1; reasons.push("△ 长度偏短（100-149字）"); }
  else                     { reasons.push("✗ 长度不足（<100字）"); }

  if (hasProtocol)         { pts += 3; reasons.push("✓ 推理协议有具体操作指令"); }
  else                     { reasons.push("✗ 推理协议缺乏具体操作（去名后无实质内容）"); }

  if (hasGate)             { pts += 2; reasons.push("✓ 质量门禁有可判断的标准"); }
  else                     { reasons.push("✗ 质量门禁缺乏判断标准"); }

  if (nameFreq <= 3)       { pts += 1; reasons.push(`✓ 模型名出现次数合理（${nameFreq}次）`); }
  else                     { reasons.push(`△ 模型名出现过频（${nameFreq}次，可能依赖名称填充内容）`); }

  // 包含全四层
  const hasAllLayers = ["认知模式","推理协议","质量门禁","输出格式"].every(k => sp.includes(k));
  if (hasAllLayers)        { pts += 2; reasons.push("✓ 完整四层结构"); }
  else                     { reasons.push("✗ 缺少部分层结构"); }

  score.value  = Math.min(Math.round(pts / 10 * 100), 100);
  score.reason = reasons.join(" | ");
  return score;
}

// ─── 维度 B: 区分度评分 ──────────────────────────────────
// 提取每个模型推理协议里的「专属动词+名词」，计算跨模型相似度
function extractSignatureTerms(sp) {
  // 提取推理协议区块
  const block = sp.match(/推理协议】([\s\S]*?)(?:【|$)/)?.[1] || "";
  // 提取动词+关键名词
  const terms = [];
  const verbPatterns = [
    /追问|拆解|删除|重建|反向验证/g,
    /列出|标注|画出|定位|预判/g,
    /诊断|节流|隔离|脚本|截止/g,
    /识别|选择|填充|检验/g,
    /假设清单|公理层|基础事实|无根假设/g,
    /因果回路|延迟节点|杠杆点|二阶效应/g,
    /带宽|前额叶|决策脚本|杏仁核/g,
    /MECE|脚手架|维度|互斥/g,
    /根因|流程缺陷|证据来源|可观测/g,
  ];
  for (const pat of verbPatterns) {
    const matches = block.match(pat) || [];
    terms.push(...matches);
  }
  return new Set(terms);
}

function scoreDifferentiation(models) {
  // 计算每对模型之间的 Jaccard 相似度
  const termSets = models.map(m => ({
    id: m.id,
    name: m.meta?.name || m.id,
    terms: extractSignatureTerms(m.codex_integration?.system_prompt || ""),
  }));

  const results = [];
  for (let i = 0; i < termSets.length; i++) {
    for (let j = i + 1; j < termSets.length; j++) {
      const a = termSets[i].terms;
      const b = termSets[j].terms;
      const intersection = [...a].filter(t => b.has(t));
      const union = new Set([...a, ...b]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;
      results.push({
        pair:         `${termSets[i].name} ↔ ${termSets[j].name}`,
        shared:       intersection,
        jaccard:      Math.round(jaccard * 100),
        canSwap:      jaccard > 0.4,
      });
    }
  }

  // 每个模型的区分度得分 = 1 - 与其他模型的平均 Jaccard
  const scores = {};
  for (let i = 0; i < termSets.length; i++) {
    const m = termSets[i];
    let totalJaccard = 0, pairCount = 0;
    for (let j = 0; j < termSets.length; j++) {
      if (i === j) continue;
      const a = m.terms, b = termSets[j].terms;
      const inter = [...a].filter(t => b.has(t));
      const union = new Set([...a, ...b]);
      totalJaccard += union.size > 0 ? inter.length / union.size : 0;
      pairCount++;
    }
    const avgJaccard = pairCount > 0 ? totalJaccard / pairCount : 0;
    scores[m.id] = {
      value: Math.max(0, Math.round((1 - avgJaccard) * 100)),
      avgSimilarity: Math.round(avgJaccard * 100),
    };
  }

  return { pairwise: results, scores };
}

// ─── 维度 C: 激活度测试题生成 ──────────────────────────────
// 为每个模型生成一道「用这个 prompt vs 无 prompt」的对比测试题
const ACTIVATION_QUESTIONS = {
  "第一性原理": "「为什么大城市的房租总是居高不下？大家都说是供需关系，但我觉得这个解释不够深。请帮我重新分析。」",
  "5whys": "「我们的客服团队每次大促后都大量离职，HR 说是工作压力太大。请帮我找到真正的根本原因。」",
  "系统思维": "「我们团队为了提升代码质量，引入了严格的 Code Review 流程，但三个月后发现交付速度反而越来越慢，团队士气也下降了。这是怎么回事？」",
  "框架思维": "「我需要评估是否要换工作。请帮我把这个决策问题结构化，我不知道从哪里开始想。」",
  "决策瘫痪": "「我已经在两个 offer 之间纠结了两个星期了，两个都有优缺点，越比越迷茫，感觉完全无法做决定。」",
};

function generateActivationTest(model) {
  const name = model.meta?.name || "";
  const sp   = model.codex_integration?.system_prompt || "";

  // 匹配预设题，找不到则生成通用题
  const matchKey = Object.keys(ACTIVATION_QUESTIONS).find(k =>
    name.includes(k) || model.id.includes(k.toLowerCase().replace(/\s/g, ""))
  );
  const question = ACTIVATION_QUESTIONS[matchKey] || `「我遇到了一个复杂问题，不知道如何下手，请帮我分析。」`;

  return {
    question,
    instruction: `
**测试方法**（激活度维度 C 验证）：

用相同的问题，分两次问 Codex：

**条件 A（无 system_prompt）**：
> ${question}

**条件 B（有 system_prompt）**：
在对话开头先粘贴以下 system_prompt，再问同样的问题：
\`\`\`
${sp}
\`\`\`
问题：${question}

**判断标准（满足 2 条以上 = 激活度合格）**：
- [ ] B 的输出主动暴露了假设清单或前提条件，A 没有
- [ ] B 的输出有可识别的步骤结构（编号/层级），A 是段落叙述
- [ ] B 的结论有反常识角度，不只是对问题的常识重包装
- [ ] B 的输出结构与 system_prompt 的「输出格式」要求吻合
- [ ] B 能识别并指出问题的「陷阱」或「错误假设」，A 直接回答表面问题
`,
  };
}

// ─── 主逻辑 ───────────────────────────────────────────────
const models = loadModels(targetIds);
if (models.length === 0) {
  console.error("未找到目标模型，请检查 --ids 参数或模型 ID");
  process.exit(1);
}

console.log(`\n评估 ${models.length} 个模型...\n`);

const fidelityResults = models.map(m => ({
  model: m,
  score: scoreFidelity(m),
}));

const diffResult = scoreDifferentiation(models);

// ─── 生成报告 ─────────────────────────────────────────────
const lines = [
  `# 三维质量评估报告`,
  ``,
  `生成时间: ${new Date().toISOString().slice(0,10)}`,
  `评估模型数: ${models.length}`,
  `评估依据: specs/system-prompt-quality-standard.md`,
  ``,
  `---`,
  ``,
  `## 维度 A：保真度评分 (Fidelity)`,
  ``,
  `> 核心问题：去掉模型名字后，system_prompt 是否仍有具体可执行的操作指令？`,
  ``,
  `| 模型 | 字数 | 保真度得分 | 详情 |`,
  `|---|---|---|---|`,
];

for (const r of fidelityResults) {
  const sp   = r.model.codex_integration?.system_prompt || "";
  lines.push(`| ${r.model.meta?.name || r.model.id} | ${sp.length} | ${r.score.value}/100 | ${r.score.reason} |`);
}

const avgFidelity = Math.round(
  fidelityResults.reduce((s, r) => s + r.score.value, 0) / fidelityResults.length
);
lines.push(``, `**平均保真度得分: ${avgFidelity}/100**`, ``);

lines.push(
  `---`,
  ``,
  `## 维度 B：区分度评分 (Differentiation)`,
  ``,
  `> 核心问题：各模型的推理协议是否可互换？Jaccard 相似度越低，区分度越高。`,
  ``,
  `### 两两相似度矩阵`,
  ``,
  `| 模型对 | 共享关键词 | Jaccard相似度 | 可互换风险 |`,
  `|---|---|---|---|`,
);

for (const p of diffResult.pairwise) {
  const sharedList = [...p.shared].slice(0, 5).join("、") || "无";
  const risk = p.canSwap ? "⚠️ 高（>40%）" : p.jaccard > 20 ? "△ 中（20-40%）" : "✓ 低（<20%）";
  lines.push(`| ${p.pair} | ${sharedList} | ${p.jaccard}% | ${risk} |`);
}

lines.push(``, `### 各模型区分度得分`, ``);
lines.push(`| 模型 | 区分度得分 | 平均与他模型相似度 |`);
lines.push(`|---|---|---|`);
for (const m of models) {
  const s = diffResult.scores[m.id];
  if (s) lines.push(`| ${m.meta?.name || m.id} | ${s.value}/100 | ${s.avgSimilarity}% |`);
}

lines.push(``, `---`, ``);
lines.push(
  `## 维度 C：激活度测试清单 (Activation)`,
  ``,
  `> 这一维度需要人工投 Codex 验证。以下是每个模型的对比测试方案。`,
  ``,
);

for (const m of models) {
  const test = generateActivationTest(m);
  lines.push(`### ${m.meta?.name || m.id}`, ``);
  lines.push(test.instruction, ``);
  lines.push(`---`, ``);
}

lines.push(
  `## 综合诊断`,
  ``,
  `| 模型 | 保真度 | 区分度 | 激活度（待验证）|`,
  `|---|---|---|---|`,
);
for (const r of fidelityResults) {
  const d = diffResult.scores[r.model.id];
  lines.push(
    `| ${r.model.meta?.name || r.model.id} | ${r.score.value}/100 | ${d?.value ?? "—"}/100 | ⬜ 待人工验证 |`
  );
}

lines.push(``, `---`, ``, `> 激活度验证完成后，请将结果填入上表，并更新 quality.prompt_effectiveness 字段。`);

const report = lines.join("\n");
writeFileSync(OUT, report, "utf8");
console.log(`\n✅ 报告已写入: specs/prompt-eval-results.md`);
console.log(`\n评分摘要:`);
for (const r of fidelityResults) {
  const d = diffResult.scores[r.model.id];
  console.log(`  ${(r.model.meta?.name || r.model.id).slice(0,20).padEnd(20)} 保真度:${String(r.score.value).padStart(3)} | 区分度:${String(d?.value ?? 0).padStart(3)}`);
}
