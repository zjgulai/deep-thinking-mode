#!/usr/bin/env node
/**
 * batch-refine.mjs — 从 data/ 原始 Markdown 重新提取推理步骤，修复「伪步骤」模型
 *
 * 策略：
 * 1. 扫描 V3 模型中「推理协议是通用兜底模板」的模型（265个）
 * 2. 在 data/ 中找对应源文（fuzzy match）
 * 3. 从源文中提取：步骤/操作/清单（含编号/步骤/Step关键词的内容）
 * 4. 重建 system_prompt 的【推理协议】层，注入真实步骤
 * 5. 写回 V3 JSON（同时写入 V2 codex.system_prompt，防止下次 upgrade 覆盖）
 *
 * 用法：node tools/batch-refine.mjs [--dry-run] [--limit=N]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT    = fileURLToPath(new URL("..", import.meta.url));
const V3_DIR  = join(ROOT, "knowledge", "models-v3");
const V2_DIR  = join(ROOT, "knowledge", "models-v2");
const DATA_DIR = join(ROOT, "data");

const DRY_RUN  = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.find(a => a.startsWith("--limit="));
const LIMIT    = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1]) : Infinity;

// ─── 伪步骤检测 ──────────────────────────────────────────
function isPseudoProtocol(sp) {
  if (!sp) return true;
  const protoMatch = sp.match(/推理协议】([\s\S]*?)(?:【|$)/);
  if (!protoMatch) return true;
  const proto = protoMatch[1];
  // 通用模板特征：所有步骤都在说「识别/按照/输出」同一件事
  const isGeneric = proto.includes("识别当前问题是否匹配") &&
                    proto.includes("按照") && proto.includes("核心逻辑逐步拆解");
  return isGeneric;
}

// ─── 从 data/ Markdown 提取推理步骤 ─────────────────────
function extractStepsFromMarkdown(text) {
  // 清洗 HTML/CSS/图片
  let t = text
    .replace(/^[\s\S]*?\n(?=#{1,3}\s|[^\n]{8,}\n[=]{3,})/m, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{4,}/g, "\n\n")
    .trim();

  const steps = [];

  // 策略1：找编号步骤（1. / 步骤1 / Step 1）
  const numberedPattern = /^(?:步骤\s*[\d一二三四五六七八九十]+[:：]?|Step\s*\d+[\-–—]?|[\d一二三四五六七八九十]+[\.、\s]\s*)(.{10,120}?)(?=\n|$)/gm;
  const matches1 = [...t.matchAll(numberedPattern)];
  if (matches1.length >= 2) {
    for (const m of matches1.slice(0, 6)) {
      const step = m[1].trim().replace(/\*+/g, "").replace(/^[\s*·-]+/, "").trim();
      if (step.length > 8 && !steps.some(s => s.includes(step.slice(0, 15)))) {
        steps.push(step.slice(0, 120));
      }
    }
  }

  // 策略2：找「：操作」格式的小标题（如「质疑拆解：xxx」）
  if (steps.length < 3) {
    const colonPattern = /^(?:#{2,4}\s*)?(.{4,20}[：:]\s*.{10,100})$/gm;
    const matches2 = [...t.matchAll(colonPattern)];
    for (const m of matches2.slice(0, 5)) {
      const step = m[1].trim().replace(/\*+/g, "").replace(/^#+\s*/, "");
      if (step.length > 8 && !steps.some(s => s.includes(step.slice(0, 15)))) {
        steps.push(step.slice(0, 120));
      }
    }
  }

  // 策略3：适用场景 + 核心操作的 bullet points
  if (steps.length < 2) {
    const bulletPattern = /^\s*[*•·\-]\s+(.{15,120})$/gm;
    const matches3 = [...t.matchAll(bulletPattern)];
    // 只取有动词的 bullet（是操作而非描述）
    const actionVerbs = /拆|问|列|找|识别|判断|追问|标注|分析|检验|验证|对比|排除|寻找|定位/;
    for (const m of matches3.slice(0, 10)) {
      if (actionVerbs.test(m[1]) && !steps.some(s => s.includes(m[1].slice(0, 15)))) {
        steps.push(m[1].trim().slice(0, 120));
        if (steps.length >= 5) break;
      }
    }
  }

  // 过滤步骤质量：去掉 URL、原文地址、纯标题、过短、重复
  const clean = steps
    .filter(s => !s.includes("http") && !s.includes("原文地址") && !s.includes("mp.weixin"))
    .filter(s => s.length >= 12)
    .filter(s => !/^[>\s*#]+$/.test(s))
    .map(s => s.replace(/^\s*[#*>\-]\s+/, "").trim())
    .filter((s, i, arr) => arr.indexOf(s) === i); // 去重

  return clean.slice(0, 6);
}

// ─── 重建 system_prompt 中的推理协议层 ───────────────────
function rebuildSystemPrompt(existingSP, steps, modelName) {
  if (steps.length < 2) return null; // 步骤不足，不修改

  const stepsText = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

  // 替换或注入推理协议层
  if (existingSP.includes("【推理协议】")) {
    // 替换现有协议内容
    return existingSP.replace(
      /【推理协议】[\s\S]*?(?=【|$)/,
      `【推理协议】\n${stepsText}\n\n`
    );
  } else {
    // 在认知模式后插入
    return existingSP.replace(
      /(【认知模式】[\s\S]*?\n\n)/,
      `$1【推理协议】\n${stepsText}\n\n`
    );
  }
}

// ─── Fuzzy 匹配 data/ 文件 ──────────────────────────────
const dataFiles = readdirSync(DATA_DIR).filter(f => f.endsWith(".md") && !f.includes(" 2."));

function findDataFile(modelName, modelId) {
  // 提取有意义的中文关键词（长度>2，去掉常见虚词）
  const stopWords = new Set(["思维","框架","分析","方法","工具","指南","模型","理论","原则","法则","系统"]);
  const keywords = (modelName + " " + modelId)
    .replace(/[_\-#*\[\]（）()]/g, " ")
    .split(/\s+/)
    .map(w => w.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ""))
    .filter(w => w.length > 2 && !/^[a-zA-Z]$/.test(w) && !stopWords.has(w));

  if (keywords.length === 0) return null;

  // 找包含最多关键词的文件
  let best = null, bestScore = 0;
  for (const df of dataFiles) {
    const score = keywords.filter(kw => df.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      best = df;
    }
  }
  return bestScore >= 1 ? best : null;
}

// ─── 主流程 ─────────────────────────────────────────────
const v3Files = readdirSync(V3_DIR).filter(f => f.endsWith(".json"));
let processed = 0, improved = 0, noData = 0, noSteps = 0, skipped = 0;

for (const f of v3Files) {
  if (processed >= LIMIT) break;

  try {
    const v3Path = join(V3_DIR, f);
    const v3 = JSON.parse(readFileSync(v3Path, "utf8"));
    const sp = v3.codex_integration?.system_prompt || "";

    // 跳过非伪步骤的模型（已有实质性内容）
    if (!isPseudoProtocol(sp)) {
      skipped++;
      continue;
    }

    const name = v3.meta?.name || "";
    const id   = v3.id || "";

    // 找 data/ 源文
    const dataFile = findDataFile(name, id);
    if (!dataFile) {
      noData++;
      continue;
    }

    // 提取步骤
    const rawText = readFileSync(join(DATA_DIR, dataFile), "utf8");
    const steps = extractStepsFromMarkdown(rawText);

    if (steps.length < 2) {
      noSteps++;
      continue;
    }

    // 重建 system_prompt
    const newSP = rebuildSystemPrompt(sp, steps, name);
    if (!newSP || newSP === sp) {
      noSteps++;
      continue;
    }

    processed++;
    improved++;

    if (!DRY_RUN) {
      // 写 V3
      v3.codex_integration.system_prompt = newSP;
      writeFileSync(v3Path, JSON.stringify(v3, null, 2), "utf8");

      // 同步写 V2（防止下次 upgrade 覆盖）
      const v2Path = join(V2_DIR, f);
      if (existsSync(v2Path)) {
        const v2 = JSON.parse(readFileSync(v2Path, "utf8"));
        if (!v2.codex) v2.codex = {};
        v2.codex.system_prompt = newSP;
        writeFileSync(v2Path, JSON.stringify(v2, null, 2), "utf8");
      }
    }

    const preview = steps.slice(0, 2).map(s => s.slice(0, 40)).join(" | ");
    console.log(`✅ ${name.slice(0, 28).padEnd(28)} (${steps.length}步) ← ${dataFile.slice(0, 35)}`);
    if (DRY_RUN) console.log(`   步骤预览: ${preview}`);

  } catch (e) {
    console.error(`❌ ${f}: ${e.message}`);
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`处理结果:`);
console.log(`  ✅ 升级成功: ${improved} 个`);
console.log(`  ⏭  已有实质内容（跳过）: ${skipped} 个`);
console.log(`  📂 data/ 无匹配源文: ${noData} 个`);
console.log(`  📄 源文步骤不足: ${noSteps} 个`);
if (DRY_RUN) console.log(`\n（干跑模式，未写入任何文件）`);
