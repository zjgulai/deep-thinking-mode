#!/usr/bin/env node
/**
 * upgrade-to-v3.mjs — V2 → V3 批量迁移
 * 将 knowledge/models-v2/*.json 转换为 V3 Schema 并保存到 knowledge/models-v3/
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "knowledge", "models-v2");
const OUT = join(ROOT, "knowledge", "models-v3");
const SCHEMA_V3 = join(ROOT, "knowledge", "model-schema-v3.json");

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// 场景领域模板（自动填充占位）
const DOMAINS = ["企业管理", "产品设计", "分析洞察", "决策思维", "任务管理"];

function generateScenario(modelName, domain) {
  const templates = {
    "企业管理": `将${modelName}应用于企业管理场景中的组织决策或流程优化问题`,
    "产品设计": `将${modelName}应用于产品设计中的功能规划或用户体验问题`,
    "分析洞察": `将${modelName}应用于数据分析中的根因诊断或趋势判断问题`,
    "决策思维": `将${modelName}应用于复杂决策中的选项评估或风险预判问题`,
    "任务管理": `将${modelName}应用于任务管理中的优先级排序或执行效率问题`,
  };
  return {
    situation: `在${domain}场景中遇到需要运用${modelName}的问题`,
    application: templates[domain] || "应用此模型解决该场景的核心问题"
  };
}

function upgradeV2toV3(v2) {
  const name = v2.meta?.name || "";
  const eng = v2.engine || {};
  const codex = v2.codex || {};
  
  // 核心定义：从 core_question 或 meta.source 提取
  const definition = eng.core_question || `如何运用${name}来解决问题`;
  
  // 触发信号
  const triggers = (eng.trigger_signals || []).filter(s => s && s.length > 8).slice(0, 5);
  if (triggers.length === 0) triggers.push(`当你需要运用${name}思维时`);
  
  // 推理步骤：V2 proto → V3 steps
  const steps = (eng.reasoning_protocol || []).map(s => ({
    step: s.step,
    action: s.action || s.name || "",
    checkpoint: s.expected_output || s.thinking_question || "确认此步骤是否得出明确结论"
  })).slice(0, 6);
  
  if (steps.length === 0) {
    steps.push({
      step: 1,
      action: `运用${name}的核心方法进行思考`,
      checkpoint: "确认理解了模型的核心逻辑"
    });
  }
  
  // 场景示例
  const scenarios = {};
  for (const domain of DOMAINS) {
    scenarios[domain] = generateScenario(name, domain);
  }
  
  // Codex 集成
  const prompt = codex.system_prompt || `请以${name}的方式思考这个问题。`;
  const activation = codex.activation_phrase || `请用${name}分析...`;
  
  return {
    schema_version: "3.0.0",
    id: (v2.id || name).toLowerCase().replace(/[\s\/\\:：]/g, "-").slice(0, 50),
    meta: {
      name,
      category: v2.meta?.category || "00",
      tags: v2.meta?.tags || [],
      skill_name: name.toLowerCase().replace(/[\s\/\\:：]/g, "-").slice(0, 40)
    },
    core_definition: smartSlice(definition, 150),
    when_to_use: {
      triggers,
      anti_triggers: eng.stop_conditions || []
    },
    before_after: {
      without_model: `在掌握${name}之前，面对这类问题你可能依赖直觉、经验或他人建议，缺乏系统化的思考框架`,
      with_model: `运用${name}之后，你能够按照结构化的推理协议逐步分析问题，避免常见误区，得出更可靠的结论`
    },
    reasoning_steps: steps,
    scenarios,
    codex_integration: {
      activation,
      system_prompt: prompt,
      skill_hint: `可转为Skill: ${name.toLowerCase().replace(/[\s\/\\:：]/g, "-").slice(0, 30)}`
    },
    pitfalls: (eng.decision_points || []).slice(0, 3).map(d => d.condition || "").filter(Boolean),
    quality: {
      definition_clarity: Math.min(v2.quality?.overall || 3, 5),
      trigger_precision: triggers.length >= 3 ? 4 : 2,
      step_completeness: steps.length >= 3 ? 4 : steps.length >= 1 ? 3 : 2,
      scenario_coverage: 2,
      prompt_effectiveness: codex.system_prompt ? 4 : 2,
      overall: Math.ceil((v2.quality?.overall || 3) / 5 * 3 + 2)
    }
  };
}

function smartSlice(text, maxLen) {
  if (text.length <= maxLen) return text;
  const endings = ["。","！","？","\n","；","，","、"];
  for (let i = maxLen - 1; i > Math.floor(maxLen * 0.5); i--) {
    if (endings.includes(text[i])) return text.slice(0, i + 1);
  }
  return text.slice(0, maxLen);
}

// ─── 主流程 ──────────────────────────────────────────
const files = readdirSync(SRC).filter(f => f.endsWith('.json'));
console.log(`V2 → V3 批量迁移: ${files.length} 个模型\n`);

let count = 0, skipped = 0;
for (const f of files) {
  try {
    const v2 = JSON.parse(readFileSync(join(SRC, f), 'utf8'));
    if (v2.schema_version === "3.0.0") { skipped++; continue; }
    
    const v3 = upgradeV2toV3(v2);
    const outName = v3.id + '.json';
    writeFileSync(join(OUT, outName), JSON.stringify(v3, null, 2), 'utf8');
    count++;
    if (count % 50 === 0) console.log(`  进度: ${count}/${files.length - skipped}`);
  } catch (e) {
    console.error(`  ❌ ${f}: ${e.message}`);
    skipped++;
  }
}

console.log(`\n升级完成: ${count} 个 V3 模型 → knowledge/models-v3/`);
console.log(`跳过: ${skipped} 个（已是V3或解析失败）`);
