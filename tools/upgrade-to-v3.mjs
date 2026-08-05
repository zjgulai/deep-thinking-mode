#!/usr/bin/env node
/**
 * upgrade-to-v3.mjs — V2 → V3 批量迁移
 * 将 knowledge/models-v2/*.json 转换为 V3 Schema 并保存到 knowledge/models-v3/
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC  = join(ROOT, "knowledge", "models-v2");
const OUT  = join(ROOT, "knowledge", "models-v3");
const DATA = join(ROOT, "data");

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// ─── 从 data/ 原文补充字段（当V2字段为空时） ──────────────
function loadSourceText(sourceFile) {
  if (!sourceFile) return null;
  
  // 书籍来源：ref:书名:模型名 格式，从 ref-extracted/ 查找
  if (sourceFile.startsWith("ref:")) {
    const parts = sourceFile.split(":");
    const bookTitle = parts[1] || "";
    const refDir = join(ROOT, "ref-extracted");
    if (existsSync(refDir)) {
      const refFiles = readdirSync(refDir);
      const match = refFiles.find(f => f.includes(bookTitle.slice(0, 20)));
      if (match) {
        try { return readFileSync(join(refDir, match), "utf8"); } catch { return null; }
      }
    }
    return null;
  }
  
  // data/ 文件
  const candidates = [
    join(DATA, sourceFile),
    join(DATA, sourceFile.endsWith('.md') ? sourceFile : sourceFile + '.md'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return readFileSync(p, "utf8"); } catch { return null; }
    }
  }
  return null;
}

function extractAntiTriggers(text) {
  if (!text) return [];
  const stopSec = text.match(/(?:不适用|不应该用|局限|局限性|不推荐|什么情况.*不|避免|慎用|不要用|反面|缺陷|陷阱|误区|常见错误)[：:]*\n?([\s\S]{40,500}?)(?=\n(?:#{1,3}|[一二三四五六七八九十]、|总结|结语|$))/i);
  if (stopSec) {
    const items = stopSec[1].match(/[-•*✗×]\s*([^\n]{8,100})/g);
    if (items) return items.map(i => i.replace(/^[-•*✗×]\s*/, "").trim().slice(0, 90)).filter(s => s.length > 10).slice(0, 3);
  }
  const notButs = text.match(/(?:这不是|不适合|不应该用|不需要|不适合用)[^。\n]{10,80}/g);
  if (notButs) return notButs.map(s => s.trim().slice(0, 90)).filter(s => s.length > 10).slice(0, 3);
  return [];
}

function extractPitfalls(text) {
  if (!text) return [];
  const pitfallSec = text.match(/(?:常见误区|注意事项|避坑|常见错误|警惕|容易犯的|典型错误|误区|坑)[：:]*\n?([\s\S]{40,600}?)(?=\n(?:#{1,3}|[一二三四五六七八九十]、|总结|结语|$))/i);
  if (pitfallSec) {
    const items = pitfallSec[1].match(/[-•*✗×❌]\s*([^\n]{8,120})/g);
    if (items) return items.map(i => i.replace(/^[-•*✗×❌]\s*/, "").trim()).filter(s => s.length > 10).slice(0, 3);
  }
  const pitPats = text.match(/(?:误区|错误|陷阱)[一二三四五六七八九十\d][：:]\s*([^\n]{8,100})/g);
  if (pitPats) return pitPats.map(s => s.replace(/^(?:误区|错误|陷阱)[一二三四五六七八九十\d][：:]\s*/, "").trim().slice(0, 100)).slice(0, 3);
  return [];
}

function extractRealTriggers(text) {
  if (!text) return [];
  const sigSec = text.match(/(?:适用|信号|识别|什么情况|什么时候|何时|触发|你是否有|你是否经历)[：:]*\n?([\s\S]{60,600}?)(?=\n(?:#{1,3}|[一二三四五六七八九十]、|总结|结语|示例|应用|操作|步骤|方法|如何|怎么|附|$))/i);
  if (sigSec) {
    const items = sigSec[1].match(/[-•*]\s*([^\n]{8,100})/g);
    if (items) return items.map(i => i.replace(/^[-•*]\s*/, "").trim().slice(0, 90)).filter(s => s.length > 12 && !/分钟|阶段|步骤|流程|准备|执行|后续/i.test(s)).slice(0, 5);
  }
  const youPat = text.slice(0, 2000).match(/你[^\n]{10,80}(?:吗|？|[。，,])/g);
  if (youPat) return youPat.map(s => s.trim().slice(0, 90)).filter(s => s.length > 15 && !/分钟|阶段|流程/i.test(s)).slice(0, 5);
  return [];
}

// 场景领域模板（自动填充占位）
const DOMAINS = ["企业管理", "产品设计", "分析洞察", "决策思维", "任务管理"];

function generateScenario(name, definition, domain) {
  const shortDef = smartSlice(definition, 80);
  const templates = {
    "企业管理": {
      situation: `在企业管理场景中需要运用${name}来解决组织层面的关键决策问题`,
      application: `${name}在此场景中的核心价值：帮助企业管理者从凭直觉决策转向基于系统分析的判断。例如零售企业在决定是否进入新市场时，用${name}替代单纯的财务估算，避免因信息不全导致的战略误判`
    },
    "产品设计": {
      situation: `在产品设计中遇到需要权衡功能优先级或用户体验方向的问题时`,
      application: `${name}在产品设计中的应用：用于替代经验驱动的设计决策。例如社交App决定新功能上线顺序时用${name}替代产品经理的个人偏好，使上线决策有据可依`
    },
    "分析洞察": {
      situation: `面对复杂数据或模糊现象，需要找出背后的规律或根因时`,
      application: `${name}在分析场景中的实践：用于结构化地拆解表面现象并定位关键变量。例如电商平台发现某品类销售额突然下滑时用${name}替代竞品抢走市场的表面归因，逐层拆解到用户行为变化的根因`
    },
    "决策思维": {
      situation: `面对多个选项且伴随不确定性，需要做出有逻辑支撑的选择时`,
      application: `${name}在决策场景中的价值：用于替代直觉驱动的判断。例如投资人在评估多个项目时用${name}建立统一评估框架，避免被创始人的个人魅力或单一数据锚定`
    },
    "任务管理": {
      situation: `在日常执行中需要分配有限的精力和时间资源时`,
      application: `${name}在任务管理中的用法：用于建立基于价值的优先级排序。例如技术团队面对多个并发需求时用${name}替代谁催得急先做谁的被动响应，建立主动排期机制`
    }
  };
  const t = templates[domain] || templates["企业管理"];
  return { situation: t.situation, application: t.application };
}

/**
 * 判断 system_prompt 是否为空壳（同义反复型/功能描述型/不足100字）
 * 合格标准: 来自 specs/system-prompt-quality-standard.md
 */
function isShellPrompt(prompt, name) {
  if (!prompt || prompt.length < 100) return true;
  // 同义反复：提示词主体内容就是模型名字
  const stripped = prompt.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim();
  if (stripped.length < 40) return true;
  // 缺乏推理协议特征词
  const hasProtocol = /步骤|step|协议|追问|拆解|列出|标注|自问|验证/i.test(prompt);
  if (!hasProtocol) return true;
  return false;
}

/**
 * 从 V2 模型数据中生成符合四层标准的 system_prompt
 * 层1: 认知模式声明  层2: 推理协议  层3: 质量门禁  层4: 输出格式
 */
function buildSystemPrompt(name, definition, steps, triggers, outputFormat) {
  const shortDef = smartSlice(definition, 100);

  // ── 层1: 认知模式声明 ──────────────────────────────
  const mode = `【认知模式】你现在以「${name}」思维框架运行。核心立场：${shortDef}`;

  // ── 层2: 推理协议（从 reasoning_steps 生成） ──────
  let protocol = "【推理协议】";
  if (steps.length >= 2) {
    protocol += "\n" + steps
      .slice(0, 5)
      .map((s, i) => `${i + 1}. ${s.action}`)
      .join("\n");
  } else {
    // 兜底：基于触发场景生成最小协议
    protocol += `\n1. 识别当前问题是否匹配「${name}」的适用场景\n2. 按照${name}的核心逻辑逐步拆解问题\n3. 输出可执行结论，并标注关键假设`;
  }

  // ── 层3: 质量门禁（从 checkpoints 或触发场景反推） ──
  const checkpoints = steps
    .map(s => s.checkpoint)
    .filter(c => c && c.length > 10 && !c.includes("确认此步骤") && !c.includes("确认理解了模型"));
  
  let gate;
  if (checkpoints.length > 0) {
    gate = `【质量门禁】每完成一步，自问：${checkpoints[0]}`;
  } else {
    gate = `【质量门禁】每完成一步推理后，自问：这个结论是基于「${name}」的核心逻辑得出的，还是在用普通直觉回答？如果是后者，回到推理协议重新推导。`;
  }

  // ── 层4: 输出格式 ──────────────────────────────────
  const fmt = (outputFormat && typeof outputFormat === 'string' && outputFormat.length > 5)
    ? `【输出格式】${outputFormat}`
    : `【输出格式】先列「分析过程」（按推理协议逐步展示），再给「结论」，最后标注「关键假设与局限」。`;

  return [mode, protocol, gate, fmt].join("\n\n");
}

function upgradeV2toV3(v2) {
  // 清洁模型名：去掉文件名截断的尾巴和特殊字符
  const rawName = v2.meta?.name || "";
  const name = rawName
    .replace(/_+$/, "")           // 去末尾下划线
    .replace(/_{2,}/g, "_")       // 多个下划线合并
    .replace(/（[^）]*$/, "")     // 去不完整括号
    .replace(/\([^)]*$/, "")      // 去不完整英文括号
    .trim() || rawName;
  const eng = v2.engine || {};
  const codex = v2.codex || {};
  
  // 核心定义：从 core_question 或 meta.source 提取
  const definition = eng.core_question || `如何运用${name}来解决问题`;
  
  // 触发信号：V2有则用，否则从源文提取
  let triggers = (eng.trigger_signals || []).filter(s => s && s.length > 8 && !/^当你需要运用/.test(s)).slice(0, 5);
  if (triggers.length < 2) {
    const srcText = loadSourceText(v2.meta?.source);
    const fromSrc = extractRealTriggers(srcText);
    triggers = fromSrc.length >= 2 ? fromSrc : triggers;
  }
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
    scenarios[domain] = generateScenario(name, definition, domain);
  }
  
  // Codex 集成：空壳 prompt 替换为四层结构，合格 prompt 保留
  const existingPrompt = codex.system_prompt || "";
  const prompt = isShellPrompt(existingPrompt, name)
    ? buildSystemPrompt(name, definition, steps, triggers, eng.output_format || "")
    : existingPrompt;

  // before_after：从触发信号和定义推导，避免纯模板
  const withoutModel = triggers.length >= 2
    ? `没有${name}时，面对「${triggers[0].replace(/^当你|^遇到|^在/, '')}」这类问题，通常依赖直觉或经验处理，容易在表面症状上循环，无法触及根因或全局结构。`
    : `在掌握${name}之前，面对复杂问题容易依赖直觉和经验，缺乏系统化的推理框架，结论难以被验证。`;
  const withModel = `运用${name}后，能够按照结构化的推理协议逐步分析问题：${smartSlice(definition, 60)}，从而得出有依据的结论，而不是可替换的猜测。`;

  const activation = codex.activation_phrase || `请用${name}帮我分析：`;
   
  return {
    schema_version: "3.0.0",
    id: (v2.id || name).toLowerCase().replace(/[\s\/\\:：]/g, "-").slice(0, 50),
     meta: {
      name,
      category: v2.meta?.category || "00",
      tags: v2.meta?.tags || [],
      skill_name: name.toLowerCase().replace(/[\s\/\\:：]/g, "-").slice(0, 40),
      ...(v2.meta?.source ? { source: v2.meta.source } : {}),
      ...(v2.meta?.sourceType ? { sourceType: v2.meta.sourceType } : {}),
      ...(v2.meta?.sourceTitle ? { sourceTitle: v2.meta.sourceTitle } : {})
    },
    core_definition: smartSlice(definition, 150),
    when_to_use: {
      triggers,
      anti_triggers: (() => {
        // V2 stop_conditions 优先，否则从源文提取
        const fromV2 = (eng.stop_conditions || []).filter(s => s && s.length > 8);
        if (fromV2.length > 0) return fromV2.slice(0, 3);
        const srcText = loadSourceText(v2.meta?.source);
        return extractAntiTriggers(srcText);
      })()
    },
    before_after: {
      without_model: withoutModel,
      with_model: withModel
    },
    reasoning_steps: steps,
    scenarios,
    codex_integration: {
      activation,
      system_prompt: prompt,
      skill_hint: `可转为Skill: ${name.toLowerCase().replace(/[\s\/\\:：]/g, "-").slice(0, 30)}`
    },
    pitfalls: (() => {
      // V2 decision_points 优先，否则从源文提取
      const fromV2 = (eng.decision_points || []).slice(0, 3).map(d => d.condition || "").filter(Boolean);
      if (fromV2.length > 0) return fromV2;
      const srcText = loadSourceText(v2.meta?.source);
      return extractPitfalls(srcText);
    })(),
    quality: {
      definition_clarity: Math.min(v2.quality?.overall || 3, 5),
      trigger_precision: triggers.length >= 3 ? 4 : 2,
      step_completeness: steps.length >= 3 ? 4 : steps.length >= 1 ? 3 : 2,
      scenario_coverage: 2,
      prompt_effectiveness: isShellPrompt(codex.system_prompt || "", name) ? 3 : 4,
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
