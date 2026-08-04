#!/usr/bin/env node
/**
 * distill-models-v3.mjs — V2 schema批量蒸馏引擎
 * 输出 knowledge/models-v2/*.json (推理引擎协议格式)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = join(ROOT, "data");
const TAX = join(ROOT, "knowledge", "taxonomy.json");
const OUT = join(ROOT, "knowledge", "models-v2");
const taxonomy = JSON.parse(readFileSync(TAX, "utf8"));
const chapters = taxonomy.chapters;

// ─── 彻底清洗 ────────────────────────────────────────────
function clean(raw) {
  let t = raw;
  t = t.replace(/^[\s\S]*?\n(?=#{1,3}\s|[^\n]{8,}\n[=]{3,})/, "");
  ["data:image/svg+xml", "<svg", "</svg>", "<g ", "<path ", "<circle ", "<rect ", "<mask ", "<defs>", "</g>"].forEach(p => { t = t.replace(new RegExp(`^.*${p.replace(/[<>/]/g,'\\$&')}.*$`,'gmi'), ""); });
  t = t.replace(/^.*(阅读|赞|分享|推荐|留言|喜欢|在看)\s*\d*.*$/gmi, "");
  t = t.replace(/^!\[[^\]]*\]\(https?:\/\/[^)]*(?:mmbiz|qpic)[^)]*\).*$/gm, "");
  t = t.replace(/^!\[[^\]]*\]\(http:\/\/[^)]*\).*$/gm, "");
  t = t.replace(/^图\d+\s*$/gm, "");
  t = t.replace(/^原创\s+\S+.*$/gm, "");
  t = t.replace(/^>\s*原文地址.*$/gm, "");
  t = t.replace(/^[=]{3,}\s*$/gm, "");
  t = t.replace(/\n{4,}/g, "\n\n\n");
  return t.trim();
}

function extractMeta(text) {
  const lines = text.split("\n");
  let title = "", url = "";
  for (const l of lines.slice(0, 8)) {
    const m = l.trim().match(/^#+\s*(.+)/);
    if (m && !title) title = m[1];
    else if (!title && l.trim().length > 5 && !/^[=*-]/.test(l.trim())) title = l.trim();
  }
  const u = text.match(/https?:\/\/mp\.weixin\.qq\.com[^\s\n\])]+/);
  if (u) url = u[0];
  return { title, sourceUrl: url };
}

function classify(text, fname) {
  const c = (fname + " " + text.slice(0, 800)).toLowerCase();
  const s = [];
  for (const ch of chapters) {
    let sc = 0;
    for (const tag of ch.allowed_tags) if (c.includes(tag.toLowerCase())) sc++;
    for (const sub of ch.subchapters || []) if (c.includes(sub.title.toLowerCase())) sc += 3;
    if (sc > 0) s.push({ id: ch.id, score: sc });
  }
  s.sort((a, b) => b.score - a.score);
  return s[0]?.id || "00";
}

// ─── V2蒸馏 ──────────────────────────────────────────────
function distillV2(text) {
  const lines = text.split("\n");
  const m = { name: "", core_question: "", trigger_signals: [], stop_conditions: [], reasoning_protocol: [], example_trace: "", tags: [] };

  // 模型名
  for (let i = 0; i < 8; i++) {
    const t = lines[i]?.trim() || "";
    const h = t.match(/^#+\s*(.+)/);
    if (h) { m.name = h[1]; break; }
    if (t.length > 4 && !/^[=*-]/.test(t) && !m.name) m.name = t;
  }
  m.name = m.name.replace(/^.*?[·•]\s*/g, "").replace(/（[^）]{0,30}速查[^）]*）/, "").replace(/\s*[:-]\s*(?:终极|完整|高阶|实操|落地|深度|全网|超精).*$/, "").replace(/__.*$/, "").replace(/^[\s·•]+/, "").trim().slice(0, 50);

  // 正文起点
  let bs = 0;
  for (let i = 0; i < 15; i++) { if (!/^(#|原创|>|=|!\[)/.test(lines[i]?.trim()||"") && (lines[i]?.trim().length||0) > 8) { bs = i; break; } }
  const body = lines.slice(bs).join("\n");

  // ── core_question ──
  // 找"核心问题""解决什么"段落
  const cqMatch = body.match(/(?:核心问题|解决什么|它在问|model.*?question)[：:]*\s*(.{15,200}?)(?=\n|。)/i);
  if (cqMatch) m.core_question = cqMatch[1].trim().slice(0, 180);
  if (!m.core_question) {
    // 从标题+开头段落推导
    const intro = body.slice(0, 500);
    if (/是什么/.test(intro)) m.core_question = "这件事的本质是什么？如何定义它？";
    else if (/为什么|原因|根源/.test(intro)) m.core_question = "这个问题的根本原因是什么？";
    else if (/如何|怎么做|怎么|怎样/.test(intro)) m.core_question = "如何有效地完成这件事？";
    else if (/决策|选择|判断/.test(intro)) m.core_question = "在多个选项中，哪个是最优选择？";
    else m.core_question = `如何运用${m.name}来解决问题？`;
  }

  // ── trigger_signals ──
  const sigSec = body.match(/(?:适用|信号|识别|什么情况|什么时候|何时使用|触发)[：:]*\n?([\s\S]{60,600}?)(?=\n(?:#{1,3}|[一二三四五六七八九十]、|总结|结语|示例|应用|操作|步骤|方法|如何|怎么|附|注意|提示|结尾|$))/i);
  if (sigSec) {
    const items = sigSec[1].match(/[-•*]\s*([^\n]{8,100})/g);
    if (items) m.trigger_signals = items.map(i => i.replace(/^[-•*]\s*/, "").trim().slice(0, 90)).slice(0, 5);
  }
  if (!m.trigger_signals.length) {
    // 从正文前1/3中提取包含"你"的句式作为信号
    const youPat = body.slice(0, 2000).match(/你[^\n]{10,80}(?:吗|？|[。，,])/g);
    if (youPat) m.trigger_signals = youPat.map(s => s.trim().slice(0, 90)).slice(0, 5);
  }

  // ── reasoning_protocol ── 找到步骤列表
  const stepBlock = body.match(/(?:步骤|流程|方法|操作|路径|阶段|执行)[：:]*\n?([\s\S]{150,1200}?)(?=\n(?:#{1,3}|[=]{2,}|总结|结语|结尾|附|$))/i);
  if (stepBlock) {
    const section = stepBlock[1];
    // 匹配 "步骤1/Step1/第X步/①/1."
    const steps = section.match(/(?:步骤\s*\d[：:]?|Step\s*\d[：:]?|第[一二三四五六七八九十\d]步[：:]?|[①②③④⑤⑥⑦⑧⑨⑩]|\d+[\.、)])[ \t]*([^\n]{10,200})/g);
    if (steps && steps.length >= 2) {
      m.reasoning_protocol = steps.map((s, idx) => {
        const label = s.replace(/^[\s\d\.、①②③④⑤⑥⑦⑧⑨⑩步骤Step第步\)]+/g, "").trim().slice(0, 150);
        return {
          step: idx + 1,
          name: label.slice(0, 20),
          action: label,
          thinking_question: "这一步要回答什么核心问题？",
          expected_output: "这一步完成后应该得到什么？",
          pitfall: ""
        };
      }).slice(0, 7);
    }
  }
  // 备选：从全文中找编号步骤
  if (!m.reasoning_protocol.length) {
    const allSteps = body.match(/(?:[①②③④⑤⑥⑦⑧⑨⑩]|\d+[\.、)])[ \t]*[^\n]{15,150}/g);
    if (allSteps && allSteps.length >= 3) {
      m.reasoning_protocol = [...new Set(allSteps)].slice(0, 7).map((s, idx) => ({
        step: idx + 1,
        name: s.replace(/^[\s\d\.、①②③④⑤⑥⑦⑧⑨⑩\)]+/, "").trim().slice(0, 25),
        action: s.replace(/^[\s\d\.、①②③④⑤⑥⑦⑧⑨⑩\)]+/, "").trim().slice(0, 150),
        thinking_question: "",
        expected_output: "",
        pitfall: ""
      }));
    }
  }

  // ── example_trace ──
  const ex = body.match(/(?:示例|案例|例如|举例|比如|场景|演示|举个例子)[：:]*\s*(.{30,300}?)(?=\n\n|\n[#*=]|\n[一二三四五六七八九十]、|\n\d+[\.、]|$)/s);
  if (ex) m.example_trace = ex[1].replace(/\n/g, " ").trim().slice(0, 250);

  // ── tags ──
  const tags = text.match(/#([^\s#]{2,14})/g);
  if (tags) m.tags = [...new Set(tags.map(t => t.replace("#", "").trim()))].slice(0, 7);

  return m;
}

// ─── 生成 system_prompt ──────────────────────────────────
function buildPrompt(model) {
  if (model.reasoning_protocol.length === 0) return null;
  const steps = model.reasoning_protocol.map(s =>
    `Step ${s.step} - ${s.name}：${s.action}${s.thinking_question ? ` 追问：${s.thinking_question}` : ""}`
  ).join('\n\n');
  return `你现在以「${model.name}」思维模式运行。面对问题时的推理协议：\n\n${steps}\n\n约束：严格按照上述步骤顺序推理，不要跳过任何一步。如果某个步骤在当前问题中不适用，说明原因后继续下一步。`;
}

// ─── 质量评分 v3 ─────────────────────────────────────────
function scoreV3(model) {
  let s = 0;
  if (model.core_question && model.core_question.length > 10) s++;
  if (model.trigger_signals.length >= 2) s++;
  if (model.reasoning_protocol.length >= 2) s += 2; // 最关键的：有可执行的推理步骤
  if (model.example_trace.length > 20) s++;
  if (buildPrompt(model)) s++;
  return Math.min(s, 5);
}

// ─── 主流程 ──────────────────────────────────────────────
console.log("🧠 蒸馏引擎 v3 (V2 Schema) 启动...\n");

const files = readdirSync(DATA).filter(f => f.endsWith(".md") && f !== "AGENTS.md");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

let total = 0, skipped = 0;
const stats = {};

for (const f of files) {
  if (f.includes("速查卡") || f.includes("速查")) { skipped++; continue; }
  const raw = readFileSync(join(DATA, f), "utf8");
  const cleanText = clean(raw);
  if (cleanText.length < 120) { skipped++; continue; }

  const meta = extractMeta(cleanText);
  const ch = classify(cleanText, f);
  const mdl = distillV2(cleanText);
  const prompt = buildPrompt(mdl);
  const quality = scoreV3(mdl);

  const id = f.replace(/\.md$/, "").replace(/[^a-zA-Z0-9\u4e00-\u9fff-]/g, "-").replace(/-+/g, "-").slice(0, 50).toLowerCase();
  const out = {
    schema_version: "2.0.0",
    id,
    meta: { name: mdl.name, category: ch, tags: mdl.tags, source: meta.title },
    engine: {
      core_question: mdl.core_question,
      trigger_signals: mdl.trigger_signals,
      stop_conditions: [],
      reasoning_protocol: mdl.reasoning_protocol,
      decision_points: [],
      output_format: { structure: "", example: mdl.example_trace }
    },
    codex: {
      system_prompt: prompt || `请以${mdl.name}的方式思考这个问题。`,
      activation_phrase: `请用${mdl.name}分析...`,
      fallback: ""
    },
    quality: { reasoning_completeness: quality, example_coverage: 0, prompt_effectiveness: prompt ? 3 : 1, overall: quality }
  };

  writeFileSync(join(OUT, `${id}.json`), JSON.stringify(out, null, 2), "utf8");
  stats[ch] = (stats[ch] || 0) + 1;
  total++;
}

console.log(`✅ ${total} 模型 (跳过 ${skipped} 速查卡)\n`);
for (const ch of chapters) { const n = stats[ch.id] || 0; if (n > 0) console.log(`   Ch.${ch.id} ${ch.title}: ${n}`); }
const qs = readdirSync(OUT).map(fn => JSON.parse(readFileSync(join(OUT, fn), "utf8")).quality.overall);
console.log(`\n⭐ 推理完备性均分: ${(qs.reduce((a,b)=>a+b,0)/qs.length).toFixed(1)}/5 | ≥4: ${qs.filter(q=>q>=4).length}/${total}`);
