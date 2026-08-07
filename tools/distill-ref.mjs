#!/usr/bin/env node
/**
 * distill-ref.mjs — ref-extracted/ 书籍内容蒸馏引擎
 *
 * 扫描 ref-extracted/ 中内容良好的文件，
 * 按章节提取独立模型，写入 knowledge/models-v2/
 *
 * 用法: node tools/distill-ref.mjs [--limit=N] [--file=文件名]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REF_DIR = join(ROOT, "ref-extracted");
const V2_DIR  = join(ROOT, "knowledge", "models-v2");
const TAX     = join(ROOT, "knowledge", "taxonomy.json");

const taxonomy = JSON.parse(readFileSync(TAX, "utf8"));
const chapters = taxonomy.chapters;

const args = process.argv.slice(2);
const LIMIT_ARG = args.find(a => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1]) : Infinity;
const FILE_ARG = args.find(a => a.startsWith("--file="));
const FILE_FILTER = FILE_ARG ? FILE_ARG.split("=")[1] : null;

// ─── 读取已有 V2 source，避免重复 ──────────────────────────
const existingSources = new Set();
for (const f of readdirSync(V2_DIR)) {
  if (!f.endsWith(".json")) continue;
  try {
    const d = JSON.parse(readFileSync(join(V2_DIR, f), "utf8"));
    const src = d.meta?.source || "";
    if (src) existingSources.add(src);
  } catch { /* skip */ }
}

// ─── 清洗文本 ───────────────────────────────────────────────
function cleanRefText(raw) {
  let t = raw;
  // 去 HTML 标签
  t = t.replace(/<[^>]+>/g, " ");
  // 去竖排文字（每字单独一行）
  t = t.replace(/^([\u4e00-\u9fa5\s]{1,2})[\r\n]/gm, "$1");
  // 去版权声明
  t = t.replace(/版权所有[^\n]*\n/g, "");
  t = t.replace(/请勿商用[^\n]*\n/g, "");
  // 合并多余空白
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

// ─── 章节分割 ───────────────────────────────────────────────
function splitIntoSections(text) {
  // 多种章节标题格式
  const SECTION_PATTERNS = [
    /^(\d{1,3})[\.、．]\s*([\u4e00-\u9fa5a-zA-Z].{2,30})\s*$/m,
    /^第[一二三四五六七八九十百\d]+[章节部分]\s*([\u4e00-\u9fa5].{2,25})/m,
    /^[\u25cb\u25cf\u2022●◆]\s*([\u4e00-\u9fa5].{3,25}(?:模型|思维|法则|原则|理论|框架|工具|方法))/m,
  ];

  // 使用数字编号分割（最常见）
  const parts = text.split(/\n(?=\d{1,3}[\.、．]\s*[\u4e00-\u9fa5])/);

  if (parts.length < 3) {
    // 尝试其他分割方式
    const parts2 = text.split(/\n(?=第[一二三四五六七八九十百\d]+[章节部分])/);
    if (parts2.length >= 3) return parts2;
    return parts;
  }
  return parts;
}

// ─── 从章节文本提取模型信息 ────────────────────────────────
function extractModelFromSection(sectionText, bookTitle) {
  const lines = sectionText.trim().split("\n").filter(l => l.trim());
  if (lines.length < 2) return null;

  // 提取模型名（第一行）
  let name = lines[0].replace(/^\d+[\.、．]\s*/, "").trim();
  name = name.replace(/[：:]\s*.+$/, "").trim(); // 去掉冒号后的说明
  name = name.slice(0, 20).trim();
  if (name.length < 2) return null;

  const body = lines.slice(1).join("\n");
  if (body.length < 30) return null;

  // core_question：找定义句
  let core_question = "";
  const defMatch = body.match(/(?:是指|指的是|定义为|是一种|是一个|可以理解为)[：:]*\s*(.{15,200}?)(?=[。！？\n])/);
  if (defMatch) core_question = defMatch[1].trim().slice(0, 150);
  if (!core_question) {
    const intro = body.slice(0, 300).replace(/\n/g, " ");
    const essence = intro.match(/(?:本质|核心|关键)[是在为了]?[：:]*(.{15,100})/);
    if (essence) core_question = essence[1].trim().slice(0, 150);
    else core_question = intro.slice(0, 120).trim();
  }

  // trigger_signals：找适用场景
  let trigger_signals = [];
  const appMatch = body.match(/(?:适用|应用|使用场景|何时用|什么情况)[：:]*\n?([\s\S]{30,400}?)(?=\n(?:[\d]|\n|总结|结语|$))/i);
  if (appMatch) {
    const items = appMatch[1].match(/[-•*·]\s*([^\n]{8,80})/g);
    if (items) trigger_signals = items.map(i => i.replace(/^[-•*·]\s*/, "").trim()).filter(s => s.length > 8).slice(0, 4);
  }
  if (!trigger_signals.length) {
    const youMatch = body.match(/(?:当[你我们][^\n]{10,60}时|如果[你我们][^\n]{10,60})/g);
    if (youMatch) trigger_signals = youMatch.map(s => s.trim()).slice(0, 3);
  }

  // stop_conditions：不适用
  let stop_conditions = [];
  const stopMatch = body.match(/(?:不适用|不应该|避免|局限|注意)[：:]*\n?([\s\S]{20,200}?)(?=\n(?:[\d]|\n|$))/i);
  if (stopMatch) {
    const items = stopMatch[1].match(/[-•*·]\s*([^\n]{8,80})/g);
    if (items) stop_conditions = items.map(i => i.replace(/^[-•*·]\s*/, "").trim()).filter(s => s.length > 8).slice(0, 2);
  }

  // reasoning_protocol：找步骤
  let reasoning_protocol = [];
  const stepMatch = body.match(/(?:步骤|流程|方法|做法|如何使用)[：:]*\n?([\s\S]{50,500}?)(?=\n(?:[\d]|\n|总结|$))/i);
  if (stepMatch) {
    const steps = stepMatch[1].match(/(?:步骤?\s*\d|第[一二三四五六七八九十\d]步|[①②③④⑤]|\d+[\.、])\s*([^\n]{8,100})/g);
    if (steps && steps.length >= 2) {
      reasoning_protocol = steps.map((s, idx) => ({
        step: idx + 1,
        name: s.replace(/^(?:步骤?\s*\d|第[一二三四五六七八九十\d]步|[①②③④⑤]|\d+[\.、])\s*/, "").trim().slice(0, 20),
        action: s.replace(/^(?:步骤?\s*\d|第[一二三四五六七八九十\d]步|[①②③④⑤]|\d+[\.、])\s*/, "").trim().slice(0, 120),
        thinking_question: "", expected_output: "", pitfall: ""
      })).filter(s => s.name.length >= 2).slice(0, 5);
    }
  }

  // example_trace
  let example_trace = "";
  const exMatch = body.match(/(?:例如|举例|案例|比如|示例)[：:]*\s*(.{20,200}?)(?=[。\n\n])/s);
  if (exMatch) example_trace = exMatch[1].replace(/\n/g, " ").trim().slice(0, 200);

  // decision_points (pitfalls)
  let decision_points = [];
  const pitMatch = body.match(/(?:常见误区|注意|陷阱|误区|错误)[：:]*\n?([\s\S]{20,200}?)(?=\n(?:[\d]|\n|$))/i);
  if (pitMatch) {
    const items = pitMatch[1].match(/[-•*·]\s*([^\n]{8,80})/g);
    if (items) decision_points = items.map(i => ({
      condition: i.replace(/^[-•*·]\s*/, "").trim().slice(0, 80),
      action: ""
    })).slice(0, 2);
  }

  return { name, core_question, trigger_signals, stop_conditions, reasoning_protocol, example_trace, decision_points };
}

// ─── 分类 ───────────────────────────────────────────────────
function classify(text, name) {
  const c = (name + " " + text.slice(0, 500)).toLowerCase();
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

// ─── 构建 system_prompt ──────────────────────────────────────
function buildPrompt(model) {
  if (model.reasoning_protocol.length === 0) return null;
  const steps = model.reasoning_protocol.map(s => `Step ${s.step} - ${s.name}：${s.action}`).join("\n\n");
  return `你现在以「${model.name.slice(0, 12)}」思维模式运行。\n\n${steps}\n\n约束：按步骤顺序推理，不跳过任何一步。`;
}

function scoreV3(model) {
  let s = 0;
  if (model.core_question && model.core_question.length > 15) s++;
  if (model.trigger_signals.filter(t => t.length > 10).length >= 2) s++;
  if (model.reasoning_protocol.length >= 3) s += 2;
  else if (model.reasoning_protocol.length >= 2) s++;
  if (model.example_trace.length > 30) s++;
  const p = buildPrompt(model);
  if (p && p.length > 80) s++;
  return Math.min(s, 5);
}

// ─── 主流程 ─────────────────────────────────────────────────
const refFiles = readdirSync(REF_DIR).filter(f => f.endsWith(".txt"));

let total = 0, skipped = 0, lowQuality = 0;
const bookStats = {};

for (const fname of refFiles) {
  if (FILE_FILTER && !fname.includes(FILE_FILTER)) continue;
  if (total >= LIMIT) break;

  const raw = readFileSync(join(REF_DIR, fname), "utf8");
  const content = cleanRefText(raw);

  // 检查中文内容
  const chineseCount = (content.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (chineseCount < 500) { skipped++; continue; }

  // 提取书名（文件名去掉 z-library 后缀）
  const bookTitle = fname.replace(/\s*\(z-library.*$/i, "").replace(".txt", "").trim().slice(0, 40);

  const sections = splitIntoSections(content);
  let bookCount = 0;

  for (const section of sections) {
    if (total >= LIMIT) break;
    if (section.trim().length < 80) continue;

    const mdl = extractModelFromSection(section, bookTitle);
    if (!mdl || !mdl.name || mdl.name.length < 2) continue;
    if (mdl.core_question.length < 15) continue;

    const sourceKey = `ref:${bookTitle}:${mdl.name}`;
    if (existingSources.has(sourceKey)) { skipped++; continue; }

    const quality = scoreV3(mdl);
    if (quality < 1) { lowQuality++; continue; }

    const prompt = buildPrompt(mdl);
    const ch = classify(section, mdl.name);

    // 生成唯一 id
    const id = `ref-${bookTitle.slice(0, 15).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "-")}-${mdl.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "-")}`.replace(/-+/g, "-").toLowerCase().slice(0, 60);

    const out = {
      schema_version: "2.0.0",
      id,
      meta: {
        name: mdl.name,
        category: ch,
        tags: [],
        source: sourceKey,
        sourceTitle: bookTitle,
        sourceType: "book"
      },
      engine: {
        core_question: mdl.core_question,
        trigger_signals: mdl.trigger_signals,
        stop_conditions: mdl.stop_conditions,
        reasoning_protocol: mdl.reasoning_protocol,
        decision_points: mdl.decision_points,
        output_format: { structure: "", example: mdl.example_trace }
      },
      codex: {
        system_prompt: prompt || `请以${mdl.name}的方式思考这个问题。`,
        activation_phrase: `请用${mdl.name.slice(0, 15)}分析...`,
        fallback: ""
      },
      quality: {
        reasoning_completeness: quality,
        example_coverage: mdl.example_trace.length > 30 ? 1 : 0,
        prompt_effectiveness: prompt ? 3 : 1,
        overall: quality
      }
    };

    writeFileSync(join(V2_DIR, `${id}.json`), JSON.stringify(out, null, 2), "utf8");
    existingSources.add(sourceKey);
    total++;
    bookCount++;
  }

  bookStats[bookTitle] = bookCount;
  if (bookCount > 0) {
    console.log(`  📖 ${bookTitle.slice(0, 45)}: ${bookCount} 个模型`);
  }
}

console.log(`\n✅ 书籍蒸馏完成: ${total} 个模型`);
console.log(`   跳过(已存在/低质): ${skipped + lowQuality}`);
console.log(`   新增 V2 模型总数: ${readdirSync(V2_DIR).filter(f => f.endsWith(".json")).length}`);
