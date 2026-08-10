#!/usr/bin/env node
/**
 * distill-models-v3.mjs — V2 schema批量蒸馏引擎
 * 输出 knowledge/models-v2/*.json (推理引擎协议格式)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizePublicModelTags } from "./lib/public-model-tags.mjs";

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
  const m = { name: "", core_question: "", trigger_signals: [], stop_conditions: [], reasoning_protocol: [], decision_points: [], example_trace: "", tags: [] };

  // 模型名 — 激进精简到15字以内
  for (let i = 0; i < 8; i++) {
    const t = lines[i]?.trim() || "";
    const h = t.match(/^#+\s*(.+)/);
    if (h) { m.name = h[1]; break; }
    if (t.length > 4 && !/^[=*-]/.test(t) && !m.name) m.name = t;
  }
  m.name = m.name
    .replace(/^.*?[·•]/g, "")           // 去系列前缀
    .replace(/[：:]\s*(?:终极|完整|高阶|实操|落地|深度|全网|超精|一套|帮你).*$/, "")  // 去冒号后修饰
    .replace(/（[^）]*速查[^）]*）/, "")
    .replace(/__.*$/, "")
    .replace(/^[\s·•：:]+/, "")
    .trim();
  // 如果还是太长，取前15字
  if (m.name.length > 15) {
    const colonPos = m.name.indexOf("：");
    m.name = colonPos > 2 ? m.name.slice(0, colonPos) : m.name.slice(0, 15);
  }

  // 正文起点
  let bs = 0;
  for (let i = 0; i < 15; i++) { if (!/^(#|原创|>|=|!\[)/.test(lines[i]?.trim()||"") && (lines[i]?.trim().length||0) > 8) { bs = i; break; } }
  const body = lines.slice(bs).join("\n");

  // ── core_question ── 修复：从文章intro提取真正的问题陈述
  const cqMatch = body.match(/(?:核心问题|解决什么|核心逻辑|本质是|一句话)[：:]*\s*(.{15,200}?)(?=\n|。)/i);
  if (cqMatch) m.core_question = cqMatch[1].trim().slice(0, 180);
  if (!m.core_question) {
    // 从开头200字提取：找包含"本质""根源""关键""不是...而是"的句子
    const intro = body.slice(0, 400);
    const essence = intro.match(/(?:本质|根源|关键|核心)是[^。]{10,120}/);
    const notBut = intro.match(/不是[^。]{5,60}而是[^。]{5,60}/);
    if (essence) m.core_question = essence[0].trim().slice(0, 180);
    else if (notBut) m.core_question = notBut[0].trim().slice(0, 180);
    else {
      // 最后fallback：从标题推导
      if (/是什么|定义/.test(intro)) m.core_question = `这件事的本质是什么？${m.name}如何定义它？`;
      else if (/为什么|原因|根源|归因/.test(intro)) m.core_question = `这个问题的根本原因是什么？${m.name}如何找到它？`;
      else if (/如何|怎么做|步骤|方法|路径/.test(intro)) m.core_question = `如何有效完成这件事？${m.name}的操作路径是什么？`;
      else m.core_question = intro.replace(/\n/g, " ").slice(0, 150);
    }
  }

  // ── trigger_signals ── 修复：更好的中文匹配
  const sigSec = body.match(/(?:适用|信号|识别|什么情况|什么时候|何时|触发|你是否有|你是否经历)[：:]*\n?([\s\S]{60,600}?)(?=\n(?:#{1,3}|[一二三四五六七八九十]、|总结|结语|示例|应用|操作|步骤|方法|如何|怎么|附|$))/i);
  if (sigSec) {
    const items = sigSec[1].match(/[-•*]\s*([^\n]{8,100})/g);
    if (items) m.trigger_signals = items.map(i => i.replace(/^[-•*]\s*/, "").trim().slice(0, 90)).filter(s => !/分钟|阶段|步骤|流程|准备|执行|后续/i.test(s)).slice(0, 5);
  }
  if (!m.trigger_signals.length) {
    const youPat = body.slice(0, 2000).match(/你[^\n]{10,80}(?:吗|？|[。，,])/g);
    if (youPat) m.trigger_signals = youPat.map(s => s.trim().slice(0, 90)).filter(s => s.length > 15 && !/分钟|阶段|流程/i.test(s)).slice(0, 5);
  }
  // 如果还是没有，从"核心价值"段落提取
  if (!m.trigger_signals.length) {
    const valueSec = body.match(/(?:核心价值|为什么|价值|作用|好处)[：:]*\n?([\s\S]{60,600}?)(?=\n(?:#{1,3}|[一二三四五六七八九十]、|总结|结语|$))/i);
    if (valueSec) {
      const items = valueSec[1].match(/[-•*]\s*([^\n]{10,100})/g);
      if (items) m.trigger_signals = items.map(i => i.replace(/^[-•*]\s*/, "").trim().slice(0, 90)).filter(s => s.length > 12).slice(0, 5);
    }
  }

  // ── stop_conditions (anti_triggers) ── 新增提取逻辑
  const stopSec = body.match(/(?:不适用|不应该用|局限|局限性|不推荐|什么情况.*不|避免|慎用|不要用|反面|缺陷|陷阱|误区|常见错误)[：:]*\n?([\s\S]{40,500}?)(?=\n(?:#{1,3}|[一二三四五六七八九十]、|总结|结语|$))/i);
  if (stopSec) {
    const stopItems = stopSec[1].match(/[-•*✗×]\s*([^\n]{8,100})/g);
    if (stopItems) {
      m.stop_conditions = stopItems
        .map(i => i.replace(/^[-•*✗×]\s*/, "").trim().slice(0, 90))
        .filter(s => s.length > 10)
        .slice(0, 3);
    }
  }
  // 备选：找"不是...而是"结构
  if (!m.stop_conditions.length) {
    const notButs = body.match(/(?:这不是|不适合|不应该|不需要)[^。\n]{10,80}/g);
    if (notButs) {
      m.stop_conditions = notButs.map(s => s.trim().slice(0, 90)).slice(0, 3);
    }
  }

  // ── decision_points (pitfalls) ── 新增提取逻辑
  const pitfallSec = body.match(/(?:常见误区|注意事项|避坑|常见错误|警惕|容易犯的|典型错误|误区|坑|陷阱)[：:]*\n?([\s\S]{40,600}?)(?=\n(?:#{1,3}|[一二三四五六七八九十]、|总结|结语|$))/i);
  if (pitfallSec) {
    const pitItems = pitfallSec[1].match(/[-•*✗×❌]\s*([^\n]{8,120})/g);
    if (pitItems) {
      m.decision_points = pitItems
        .map(i => i.replace(/^[-•*✗×❌]\s*/, "").trim())
        .filter(s => s.length > 10)
        .slice(0, 3)
        .map(s => ({ condition: s.slice(0, 100), action: "" }));
    }
  }
  // 备选：找"误区N：..."结构
  if (!m.decision_points.length) {
    const pitPats = body.match(/(?:误区|错误|陷阱)[一二三四五六七八九十\d][：:]\s*([^\n]{8,100})/g);
    if (pitPats) {
      m.decision_points = pitPats
        .map(s => ({ condition: s.replace(/^(?:误区|错误|陷阱)[一二三四五六七八九十\d][：:]\s*/, "").trim().slice(0, 100), action: "" }))
        .slice(0, 3);
    }
  }

  // ── reasoning_protocol ── 修复：去噪、去重、限制5步
  const stepBlock = body.match(/(?:步骤|流程|方法|操作|路径|阶段|执行)[：:]*\n?([\s\S]{150,1200}?)(?=\n(?:#{1,3}|[=]{2,}|总结|结语|结尾|附|$))/i);
  if (stepBlock) {
    const section = stepBlock[1];
    const steps = section.match(/(?:步骤\s*\d[：:]?|Step\s*\d[：:]?|第[一二三四五六七八九十\d]步[：:]?|[①②③④⑤⑥⑦⑧⑨⑩]|\d+[\.、)])[ \t]*([^\n]{10,160})/g);
    if (steps && steps.length >= 2) {
      m.reasoning_protocol = steps.map((s, idx) => {
        let label = s.replace(/^[\s\d\.、①②③④⑤⑥⑦⑧⑨⑩步骤Step第步\)]+/g, "").trim();
        // 取冒号前作为name（≤12字），冒号后作为action
        const colonIdx = label.indexOf("：");
        let shortName, actionText;
        if (colonIdx > 1 && colonIdx <= 10) {
          shortName = label.slice(0, colonIdx);
          actionText = label.slice(colonIdx + 1).trim();
        } else {
          shortName = label.slice(0, 10);
          actionText = label.slice(0, 140);
        }
        // 如果action以name开头（重复），去掉重复前缀
        if (actionText.startsWith(shortName)) actionText = actionText.slice(shortName.length).replace(/^[：:\s]+/, "");
        return { step: idx + 1, name: shortName, action: actionText || label.slice(0, 140), thinking_question: "", expected_output: "", pitfall: "" };
      })
      .filter(s => s.name.length >= 2 && !/训练|搭配|组合|避坑|延伸|阅读|常见|误区|注意|补充|日常|http|mmbiz/i.test(s.name))
      .filter((s, i, arr) => i === 0 || s.name !== arr[i-1].name)
      .slice(0, 5);
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
  if (tags) {
    m.tags = sanitizePublicModelTags(tags.map((tag) => tag.replace("#", ""))).slice(0, 7);
  }

  return m;
}

// ─── 生成 system_prompt ──────────────────────────────────

// ─── 语义边界截断（不在中文中间切断） ──────────────────
function smartSlice(text, maxLen) {
  if (text.length <= maxLen) return text;
  const endings = ["。","！","？","\n","；","，","、","」"];
  for (let i = maxLen - 1; i > Math.floor(maxLen * 0.5); i--) {
    if (endings.includes(text[i])) return text.slice(0, i + 1);
  }
  return text.slice(0, maxLen);
}
function buildPrompt(model) {
  if (model.reasoning_protocol.length === 0) return null;
  const steps = model.reasoning_protocol.map(s =>
    `Step ${s.step} - ${s.name}：${s.action}`
  ).join('\n\n');
  const cleanName = model.name.slice(0, 12);
  return `你现在以「${cleanName}」思维模式运行。严格遵循以下推理协议：\n\n${steps}\n\n约束：按步骤顺序推理，不跳过任何一步。每步先给出分析再进入下一步。不适用时说明原因后继续。`;
}

// ─── 质量评分 v3 ─────────────────────────────────────────
function scoreV3(model) {
  let s = 0;
  if (model.core_question && model.core_question.length > 15 && !/如何运用.*来解决问题/.test(model.core_question)) s++;
  const goodSigs = model.trigger_signals.filter(t => t.length > 10);
  if (goodSigs.length >= 2) s++;
  const cleanSteps = model.reasoning_protocol.filter(st => st.name.length <= 18);
  if (cleanSteps.length >= 3) s += 2;
  else if (cleanSteps.length >= 2) s++;
  if (model.example_trace.length > 30 && !/分钟|阶段/i.test(model.example_trace)) s++;
  const p = buildPrompt(model);
  if (p && p.length > 100 && !p.includes('这一步要回答什么核心问题')) s++;
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
    meta: { name: mdl.name, category: ch, tags: mdl.tags, source: f, sourceTitle: meta.title },
    engine: {
      core_question: mdl.core_question,
      trigger_signals: mdl.trigger_signals,
      stop_conditions: mdl.stop_conditions || [],
      reasoning_protocol: mdl.reasoning_protocol,
      decision_points: mdl.decision_points || [],
      output_format: { structure: "", example: mdl.example_trace }
    },
    codex: {
      system_prompt: prompt || `请以${mdl.name}的方式思考。`,
      activation_phrase: `请用${mdl.name.slice(0,15)}分析...`,
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
