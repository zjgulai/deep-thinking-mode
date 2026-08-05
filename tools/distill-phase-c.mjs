#!/usr/bin/env node
/**
 * distill-phase-c.mjs — Phase C: RIA++ 批量蒸馏 164 个模型 → V2 Schema
 * 
 * 对 model-inventory-final.json 中每个模型:
 * 1. 从 ref-extracted/ 的所有文本中定位该模型
 * 2. 提取上下文 → 定义 / 步骤 / 案例 / 触发 / 误区分
 * 3. 生成 Codex 可执行 system_prompt
 * 4. 输出 ref-models/*.json (V2 Schema)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTRACTED = join(ROOT, "ref-extracted");
const INVENTORY = join(ROOT, "model-inventory-final.json");
const TAX = join(ROOT, "knowledge", "taxonomy.json");
const OUT = join(ROOT, "ref-models");
const EXISTING = join(ROOT, "knowledge", "models-v2");

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const taxonomy = JSON.parse(readFileSync(TAX, "utf8"));
const chapters = taxonomy.chapters;
const inventory = JSON.parse(readFileSync(INVENTORY, "utf8"));

// Load extracted texts into memory
const texts = {};
for (const f of readdirSync(EXTRACTED)) {
  if (!f.endsWith('.txt')) continue;
  const content = readFileSync(join(EXTRACTED, f), 'utf8');
  if (content.length > 500) texts[f] = content;
}

// Check existing models to avoid duplicate work
const existingIds = new Set();
if (existsSync(EXISTING)) {
  for (const f of readdirSync(EXISTING)) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(readFileSync(join(EXISTING, f), 'utf8'));
      if (m.id) existingIds.add(m.id);
      if (m.meta?.name) existingIds.add(m.meta.name.toLowerCase().replace(/[\s\/]/g, '-'));
    } catch {}
  }
}

// ─── 上下文提取 ─────────────────────────────────────
function extractContexts(modelName) {
  const results = [];
  for (const [srcFile, text] of Object.entries(texts)) {
    const idx = text.indexOf(modelName);
    if (idx < 0) continue;
    
    // 获取前后各 1500 字上下文
    const start = Math.max(0, idx - 1500);
    const end = Math.min(text.length, idx + modelName.length + 1500);
    const ctx = text.slice(start, end);
    
    // 分割成句子
    const sentences = ctx.split(/[。！？\n]/).filter(s => s.trim().length > 10);
    
    results.push({ source: srcFile, context: ctx, sentences });
  }
  return results;
}

// ─── 从上下文中解析结构 ────────────────────────────
function parseSteps(contexts) {
  const allText = contexts.map(c => c.context).join("\n");
  const steps = [];
  
  // 找步骤模式: "第一步" "步骤1" "1." "①"
  const patterns = [
    /第[一二三四五六七八九十\d]+步[：:\s]*([^\n]{10,150})/g,
    /步骤\s*\d[：:\s]*([^\n]{10,150})/g,
    /[①②③④⑤⑥⑦⑧⑨⑩]\s*([^\n]{10,120})/g,
  ];
  
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(allText)) !== null) {
      const text = m[1].trim().slice(0, 100);
      if (!steps.find(s => s.action === text)) {
        steps.push({ step: steps.length + 1, name: text.slice(0, 12), action: text, thinking_question: "", expected_output: "", pitfall: "" });
      }
      if (steps.length >= 5) break;
    }
    if (steps.length >= 3) break;
  }
  
  return steps;
}

function parseDefinition(contexts) {
  for (const ctx of contexts) {
    for (const s of ctx.sentences) {
      // 找定义句: "XXX是..." 或 "XXX指..." 
      if (s.includes("是") && s.length < 200) return s.slice(0, 150);
      if (s.includes("指") && s.length < 150) return s.slice(0, 150);
    }
  }
  return "";
}

function parseExamples(contexts) {
  const exs = [];
  for (const ctx of contexts) {
    const matches = ctx.context.match(/(?:例如|比如|举例|案例|示例)[：:\s]*([^\n]{20,200})/g);
    if (matches) {
      for (const m of matches) {
        const text = m.replace(/^(例如|比如|举例|案例|示例)[：:\s]*/, "").trim().slice(0, 150);
        if (!exs.includes(text)) exs.push(text);
        if (exs.length >= 3) break;
      }
    }
    if (exs.length >= 2) break;
  }
  return exs;
}

function parseSignals(contexts) {
  const signals = [];
  const allText = contexts.map(c => c.context).join("\n");
  const matches = allText.match(/(?:适用|场景|当|如果|当你|假如)[^。\n]{15,100}(?:[。，]|$)/g);
  if (matches) {
    for (const m of matches) {
      const s = m.trim();
      if (s.length > 15 && !signals.includes(s)) signals.push(s.slice(0, 90));
      if (signals.length >= 5) break;
    }
  }
  return signals;
}

function parsePitfalls(contexts) {
  const pitfalls = [];
  const allText = contexts.map(c => c.context).join("\n");
  const matches = allText.match(/(?:误区|陷阱|注意|避免|不要|切忌|容易犯|常见错误)[^。\n]{15,120}/g);
  if (matches) {
    for (const m of matches) {
      pitfalls.push(m.trim().slice(0, 100));
      if (pitfalls.length >= 3) break;
    }
  }
  return pitfalls;
}

function classifyModel(name, text) {
  const c = (name + " " + text).toLowerCase().slice(0, 500);
  const scores = [];
  for (const ch of chapters) {
    let sc = 0;
    for (const tag of ch.allowed_tags || []) if (c.includes(tag.toLowerCase())) sc++;
    for (const sub of ch.subchapters || []) if (c.includes(sub.title.toLowerCase())) sc += 2;
    if (sc > 0) scores.push({ id: ch.id, score: sc });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores[0]?.id || "00";
}

// ─── 主流程 ──────────────────────────────────────────
console.log(`🧪 Phase C: RIA++ 蒸馏 ${inventory.length} 个模型\n`);

let done = 0, skipped = 0;
const toProcess = inventory.filter(m => {
  const id = m.displayName.toLowerCase().replace(/[\s\/\\]/g, '-').slice(0, 40);
  return !existingIds.has(id) && !existsSync(join(OUT, `${id}.json`));
});

console.log(`待蒸馏: ${toProcess.length} 个 (跳过 ${inventory.length - toProcess.length} 个已有)\n`);

for (const model of toProcess) {
  try {
    const contexts = extractContexts(model.displayName);
    if (contexts.length === 0) { skipped++; continue; }
    
    const allText = contexts.map(c => c.context).join("\n").slice(0, 3000);
    const definition = parseDefinition(contexts);
    const steps = parseSteps(contexts);
    const examples = parseExamples(contexts);
    const signals = parseSignals(contexts);
    const pitfalls = parsePitfalls(contexts);
    const category = classifyModel(model.displayName, allText);
    
    // Build V2 schema
    const id = model.displayName.toLowerCase().replace(/[\s\/\\]/g, '-').slice(0, 40);
    const sourceNames = model.sources.map(s => s.slice(0, 60)).join('; ');
    
    const out = {
      schema_version: "2.0.0",
      id,
      meta: {
        name: model.displayName,
        category,
        tags: [],
        source: sourceNames
      },
      engine: {
        core_question: definition || `如何运用${model.displayName}来解决问题？`,
        trigger_signals: signals,
        stop_conditions: [],
        reasoning_protocol: steps,
        decision_points: [],
        output_format: {
          structure: "",
          example: examples[0] || ""
        }
      },
      codex: {
        system_prompt: steps.length > 0
          ? `你现在以「${model.displayName}」思维模式运行。\n\n${steps.map(s => `Step ${s.step} - ${s.name}：${s.action}`).join('\n\n')}\n\n约束：按步骤推理，不跳过任何一步。${pitfalls.length > 0 ? '常见误区: ' + pitfalls.join('; ') : ''}`
          : `请以${model.displayName}的方式分析这个问题。`,
        activation_phrase: `请用${model.displayName}分析...`,
        fallback: ""
      },
      quality: {
        reasoning_completeness: steps.length >= 3 ? 4 : steps.length >= 2 ? 3 : 2,
        example_coverage: examples.length,
        prompt_effectiveness: steps.length >= 2 ? 3 : 2,
        overall: steps.length >= 3 ? 4 : steps.length >= 1 ? 3 : 2
      }
    };
    
    writeFileSync(join(OUT, `${id}.json`), JSON.stringify(out, null, 2), 'utf8');
    done++;
    if (done % 20 === 0) console.log(`  进度: ${done}/${toProcess.length}`);
  } catch (e) {
    console.error(`  ❌ ${model.displayName}: ${e.message}`);
    skipped++;
  }
}

console.log(`\nPhase C 完成: ${done} 个V2模型 → ref-models/`);
console.log(`  跳过: ${skipped} (无上下文或已有)`);
