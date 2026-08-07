#!/usr/bin/env node
/**
 * distill-fullchain.mjs — 全量蒸馏 + 模型链发现 + 补齐78篇缺口
 * 
 * 1. 对 data/ 全部509篇非速查文章重新蒸馏（包括之前遗漏的78篇）
 * 2. 同时扫描每篇文章中的模型引用链
 * 3. 产出: models-v2/*.json (单模型) + model-chains.json (复合链)
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = join(ROOT, "data");
const TAX = join(ROOT, "knowledge", "taxonomy.json");
const OUT = join(ROOT, "knowledge", "models-v2");
const CHAINS_OUT = join(ROOT, "model-chains.json");

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const taxonomy = JSON.parse(readFileSync(TAX, "utf8"));
const chapters = taxonomy.chapters;

// ─── 模型名库（包含大脑/情绪/身体领域） ──────────────────
const ALL_MODEL_NAMES = new Set([
  "第一性原理","5 Whys","SWOT分析","PEST分析","波特五力","BCG矩阵","安索夫矩阵",
  "二八法则","金字塔原理","MECE原则","SMART原则","PDCA循环","OODA循环",
  "系统思维","框架思维","结构化思维","批判性思维","逆向思维","水平思考",
  "六顶思考帽","头脑风暴","SCAMPER","TRIZ","事前验尸","红队演练",
  "决策矩阵","决策树","成本效益分析","盈亏平衡分析","净现值",
  "GTD","时间矩阵","番茄工作法","WOOP","执行意图","福格行为模型",
  "非暴力沟通","STAR法则","PREP模型","金字塔原理",
  "认知失调","确认偏误","锚定效应","损失厌恶","沉没成本","框架效应",
  "从众效应","幸存者偏差","归因错误","邓宁-克鲁格效应",
  "复利效应","飞轮效应","网络效应","马太效应","红皇后效应",
  "熵增定律","涌现","蝴蝶效应","黑天鹅","灰犀牛",
  "马斯洛需求层次","刻意练习","心流","成长型思维",
  "10-10-10法则","3C战略三角","5W1H","5W2H","7S模型","AARRR",
  "RACI矩阵","OKR","KPI","平衡计分卡","商业模式画布","价值主张画布",
  "波特价值链","鱼骨图","冰山模型","黄金圈法则","创新扩散",
  "设计思维","精益创业","敏捷开发","双钻模型",
  "大脑默认模式网络","DMN","杏仁核劫持","前额叶皮层","多巴胺机制",
  "血清素","内啡肽","交感神经","副交感神经","横膈膜呼吸",
  "情绪调节","情感标记","情绪劫持","认知解离","认知融合",
  "内耗管理","反刍思维","决策瘫痪","决策困难","焦虑预支",
  "意志力消耗","自我效能感","习惯回路","蔡加尼克效应","门口效应",
  "元认知","认知边界","框架缩放","隐喻转换","知识复利",
  "SCQA","PREP","STAR","电梯演讲","故事思维",
  "蓝海战略","颠覆性创新","跨越鸿沟","长尾理论","S曲线",
]);

// ─── 文章清洗 ─────────────────────────────────────────
function clean(raw) {
  let t = raw;
  t = t.replace(/^[\s\S]*?\n(?=#{1,3}\s|[^\n]{8,}\n[=]{3,})/, "");
  ["data:image/svg+xml", "<svg", "</svg>", "<g ", "<path ", "<circle ", "<rect ", "<mask ", "<defs>", "</g>"].forEach(p => { t = t.replace(new RegExp(`^.*${p.replace(/[<>/]/g,'\\$&')}.*$`,'gmi'), ""); });
  t = t.replace(/^.*(阅读|赞|分享|推荐|留言|喜欢|在看)\s*\d*.*$/gmi, "");
  t = t.replace(/^!\[[^\]]*\]\(https?:\/\/[^)]*(?:mmbiz|qpic)[^)]*\).*$/gm, "");
  t = t.replace(/^图\d+\s*$/gm, "").replace(/^原创\s+\S+.*$/gm, "");
  t = t.replace(/^>.*原文地址.*$/gm, "").replace(/^[=]{3,}\s*$/gm, "");
  t = t.replace(/\n{4,}/g, "\n\n\n");
  return t.trim();
}

function classify(text, fname) {
  const c = (fname + " " + text.slice(0, 800)).toLowerCase();
  const s = [];
  for (const ch of chapters) {
    let sc = 0;
    for (const tag of ch.allowed_tags || []) if (c.includes(tag.toLowerCase())) sc++;
    for (const sub of ch.subchapters || []) if (c.includes(sub.title.toLowerCase())) sc += 3;
    if (sc > 0) s.push({ id: ch.id, score: sc });
  }
  s.sort((a, b) => b.score - a.score);
  return s[0]?.id || "00";
}
// ─── 语义边界截断（不在中文中间切断） ──────────────────
function smartSlice(text, maxLen) {
  if (text.length <= maxLen) return text;
  const endings = ["。","！","？","\n","；","，","、","」"];
  for (let i = maxLen - 1; i > Math.floor(maxLen * 0.5); i--) {
    if (endings.includes(text[i])) return text.slice(0, i + 1);
  }
  return text.slice(0, maxLen);
}


// ─── 单模型蒸馏 ─────────────────────────────────────
function distillModel(text, name) {
  const body = text;
  
  // core_question
  let cq = "";
  const cqMatch = body.match(/(?:核心问题|解决什么|核心逻辑|本质是|一句话)[：:]*\s*(.{15,200}?)(?=\n|。)/i);
  if (cqMatch) cq = cqMatch[1].trim().slice(0, 180);
  if (!cq) {
    const intro = body.slice(0, 400);
    const essence = intro.match(/(?:本质|根源|关键|核心)是[^。]{10,120}/);
    if (essence) cq = essence[0].trim().slice(0, 180);
    else cq = intro.replace(/\n/g, " ").slice(0, 150);
  }
  
  // trigger_signals  
  const signals = [];
  const sigSec = body.match(/(?:适用|信号|什么情况|何时|触发|你是否)[：:]*\n?([\s\S]{60,600}?)(?=\n(?:#{1,3}|[一二三四五]、|$))/i);
  if (sigSec) {
    const items = sigSec[1].match(/[-•*]\s*([^\n]{8,100})/g);
    if (items) signals.push(...items.map(i => i.replace(/^[-•*]\s*/, "").trim()).filter(s => !/分钟|阶段|步骤/i.test(s)).slice(0, 5));
  }
  
  // reasoning_protocol
  const proto = [];
  const stepBlock = body.match(/(?:步骤|流程|方法|操作|路径)[：:]*\n?([\s\S]{100,1200}?)(?=\n(?:#{1,3}|[=]{2,}|总结|结语|$))/i);
  if (stepBlock) {
    const steps = stepBlock[1].match(/(?:步骤\s*\d|第[一二三四五六七八九十\d]步|[①②③④⑤]|\d+[\.、)])[ \t]*([^\n]{10,120})/g);
    if (steps) {
      steps.slice(0, 5).forEach((s, idx) => {
        const label = s.replace(/^[\s\d\.、①②③④⑤步骤Step第步\)]+/g, "").trim();
        const ci = label.indexOf("：");
        const name = ci > 1 && ci <= 12 ? label.slice(0, ci) : smartSlice(label, 15);
        const action = ci > 1 && ci <= 12 ? smartSlice(label.slice(ci + 1).trim(), 120) : smartSlice(label, 120);
        proto.push({ step: idx + 1, name, action, thinking_question: "", expected_output: "", pitfall: "" });
      });
    }
  }
  
  const prompt = proto.length > 0
    ? `你现在以「${name.slice(0,12)}」思维模式运行。\n\n${proto.map(s => `Step ${s.step} - ${s.name}：${s.action}`).join('\n\n')}\n\n约束：按步骤顺序推理，不跳过任何一步。`
    : `请以${name}的方式思考。`;
  
  return { cq, signals, proto, prompt };
}

// ─── 模型链发现 ─────────────────────────────────────
function discoverChains(text, sourceName) {
  // 在文章中找到所有出现的已知模型名
  const found = [];
  for (const mn of ALL_MODEL_NAMES) {
    let idx = text.indexOf(mn);
    while (idx >= 0) {
      found.push({ name: mn, position: idx });
      idx = text.indexOf(mn, idx + 1);
    }
  }
  
  if (found.length < 2) return null;
  
  // 按位置排序，找相近出现的模型对/链
  found.sort((a, b) => a.position - b.position);
  const chains = [];
  let current = [found[0]];
  
  for (let i = 1; i < found.length; i++) {
    const dist = found[i].position - found[i-1].position;
    if (dist < 3000 && found[i].name !== found[i-1].name) {
      current.push(found[i]);
    } else {
      if (current.length >= 2) chains.push([...new Set(current.map(c => c.name))]);
      current = [found[i]];
    }
  }
  if (current.length >= 2) chains.push([...new Set(current.map(c => c.name))]);
  
  // 去重链
  const unique = chains.filter(c => c.length >= 2 && c.length <= 6);
  return unique.length > 0 ? { source: sourceName, chains: unique } : null;
}

// ─── 主流程 ──────────────────────────────────────────
console.log("🧩 全量蒸馏 + 模型链发现\n");

const files = readdirSync(DATA).filter(f => f.endsWith(".md") && f !== "AGENTS.md" && !f.includes("速查"));
// 去重：同名文件去版本号
const deduped = new Map();
for (const f of files) {
  const base = f.replace(/ \d\.md$/, '.md').replace(/ \d\.md$/, '.md');
  if (!deduped.has(base)) deduped.set(base, []);
  deduped.get(base).push(f);
}

console.log(`非速查文章: ${files.length} 篇 → 去重后: ${deduped.size} 篇\n`);

let newModels = 0, updatedModels = 0, chainArticles = 0;
const allChains = [];
const stats = {};

for (const [base, versions] of deduped) {
  // 取最新版本
  const f = versions.sort().pop();
  const raw = readFileSync(join(DATA, f), "utf8");
  const cleanText = clean(raw);
  if (cleanText.length < 120) continue;
  
  const rawName = f.replace(/\.md$/, "").replace(/ \d$/, "");
  
  // 提取模型名
  let modelName = rawName;
  const h1 = cleanText.match(/^#+\s*(.+)/m);
  if (h1) modelName = h1[1].trim();
  modelName = modelName.replace(/^.*?[·•]/g, "").replace(/[：:]\s*(?:终极|完整|高阶|实操|落地|深度|全网|一套|帮你).*$/, "").trim();
  if (modelName.length > 18) {
    const cp = modelName.indexOf("：");
    modelName = cp > 2 ? modelName.slice(0, cp) : modelName.slice(0, 18);
  }
  
  const cat = classify(cleanText, f);
  const { cq, signals, proto, prompt } = distillModel(cleanText, modelName);
  
  // 生成ID
  const id = modelName.toLowerCase().replace(/[\s\/\\:：]/g, "-").replace(/-+/g, "-").replace(/[()（）]/g, "").slice(0, 50);
  const outPath = join(OUT, `${id}.json`);
  
  // 检查是否已存在
  const isNew = !existsSync(outPath);
  
  const model = {
    schema_version: "2.0.0",
    id,
    meta: { name: modelName, category: cat, tags: [], source: f },
    engine: {
      core_question: cq,
      trigger_signals: signals,
      stop_conditions: [],
      reasoning_protocol: proto,
      decision_points: [],
      output_format: { structure: "", example: "" }
    },
    codex: {
      system_prompt: prompt,
      activation_phrase: `请用${modelName.slice(0,15)}分析...`,
      fallback: ""
    },
    quality: {
      reasoning_completeness: proto.length >= 3 ? 4 : proto.length >= 2 ? 3 : proto.length >= 1 ? 2 : 1,
      example_coverage: 0,
      prompt_effectiveness: proto.length >= 2 ? 3 : 2,
      overall: proto.length >= 3 ? 4 : proto.length >= 1 ? 3 : 2
    }
  };
  
  writeFileSync(outPath, JSON.stringify(model, null, 2), "utf8");
  
  if (isNew) newModels++;
  else updatedModels++;
  
  stats[cat] = (stats[cat] || 0) + 1;
  
  // 模型链发现
  const chainResult = discoverChains(cleanText, modelName);
  if (chainResult) {
    allChains.push(chainResult);
    chainArticles++;
  }
  
  if (isNew && newModels % 20 === 0) console.log(`  进度: ${newModels} 新增 / ${chainArticles} 链`);
}

// 写入模型链
writeFileSync(CHAINS_OUT, JSON.stringify(allChains, null, 2), "utf8");

// 统计
console.log(`\n=== 蒸馏完成 ===`);
console.log(`新增模型: ${newModels} | 更新: ${updatedModels}`);
console.log(`含链文章: ${chainArticles}`);
console.log(`总模型: ${readdirSync(OUT).filter(f=>f.endsWith('.json')).length}`);

// 按章节统计
console.log(`\n=== 章节分布 ===`);
for (const ch of chapters) {
  const n = stats[ch.id] || 0;
  if (n > 0) console.log(`  Ch.${ch.id} ${ch.title}: ${n}`);
}

// Top 模型链
console.log(`\n=== Top 模型链 (按长度) ===`);
const sortedChains = allChains.sort((a, b) => b.chains.reduce((m, c) => Math.max(m, c.length), 0) - a.chains.reduce((m, c) => Math.max(m, c.length), 0));
sortedChains.slice(0, 15).forEach(c => {
  c.chains.forEach(chain => {
    if (chain.length >= 3) console.log(`  🔗 ${c.source.slice(0,30)}: ${chain.join(' → ')}`);
  });
});
