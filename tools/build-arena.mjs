#!/usr/bin/env node
/**
 * build-arena.mjs — Chain → Arena 批量升级引擎
 *
 * 策略：
 * 1. 读取 chain-protocols/*-chain-*.json
 * 2. 从每个 chain 的 models 列表中选出3个「立场最不同」的参与者
 * 3. 为每个参与者生成：role（立场化角色名）+ stance + challenge_question
 * 4. 生成 arena system_prompt（Phase 1/2/3 竞技场格式）
 * 5. 写入 chain-protocols/<问题类型>-arena-<n>.json
 *    已有手工精馏 arena 的问题类型跳过，不覆盖
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR  = join(ROOT, "chain-protocols");

// ─── 已手工精馏的 arena，不自动覆盖 ──────────────────────
const MANUAL_ARENAS = new Set(["决策困境", "问题根因", "系统失败"]);

// ─── 模型→角色映射 ──────────────────────────────────────
// 为常见模型定义：立场化角色名 + 认知立场 + 核心质疑
const MODEL_ROLES = {
  "第一性原理": {
    role: "假设审计师",
    stance: "你的每一个判断背后都有未被质疑的假设。假设错了，结论就是错的。",
    challenge: "删掉所有惯性假设之后，你的结论还站得住吗？"
  },
  "系统思维": {
    role: "系统结构分析师",
    stance: "反复出现的问题是系统结构造成的，不是某次意外。改变参数不够，必须找到回路里的杠杆点。",
    challenge: "你找到的「原因」是导致系统持续失败的回路，还是只是症状之一？"
  },
  "5 Whys": {
    role: "根因调查员",
    stance: "每一个「为什么」的答案都必须基于可观测事实，目标是找到系统/流程结构缺陷，而不是某人失误。",
    challenge: "你的对策是「叮嘱某人更认真」还是「改变让失误成为可能的系统条件」？"
  },
  "框架思维": {
    role: "框架设计师",
    stance: "没有明确核心维度时，你的分析是在用等权重比较所有因素——框架选错了，再多数据也是噪音。",
    challenge: "这个问题最关键的1-2个维度是什么？框架维度不对，结论就不对。"
  },
  "决策瘫痪": {
    role: "带宽顾问",
    stance: "你现在的困境不是信息不够，是认知资源已耗尽。继续分析只会加速耗尽。",
    challenge: "你打算用耗尽的前额叶带宽做出重要决定吗？"
  },
  "损失厌恶": {
    role: "损失厌恶侦探",
    stance: "你的判断很可能被「害怕失去」扭曲了，你在用恐惧而不是期望值做决定。",
    challenge: "把问题从「我会失去什么」改成「我会得到什么」之后，你的判断还一样吗？"
  },
  "逆向思维": {
    role: "逆向工程师",
    stance: "从正面分析找到的是大家都在做的事，从反面分析才能找到真正的盲区。",
    challenge: "如果你要让这件事必然失败，你会怎么做？这些「失败路径」现在正在发生吗？"
  },
  "金字塔原理": {
    role: "逻辑结构师",
    stance: "你的表达或分析还没有找到「结论在上、论据在下」的清晰层级，导致重点被淹没。",
    challenge: "如果只能说一句话，你的核心结论是什么？其他的都是论据，不是结论。"
  },
  "冰山模型": {
    role: "深层结构探索者",
    stance: "你看到的是水面上的症状，冰山下有信念、假设、系统结构三层你还没有触及。",
    challenge: "导致表面现象的深层信念或假设是什么？改变这一层才能真正改变结果。"
  },
  "批判性思维": {
    role: "论证质量审计师",
    stance: "你的分析里有多少是真正的推论，有多少是未被检验的断言？断言和推论不是同一件事。",
    challenge: "你最关键的结论，背后有什么证据？如果没有证据，它只是假设，不是结论。"
  },
  "OODA循环": {
    role: "决策速度顾问",
    stance: "你在分析的时间里，环境已经在变化。完美的分析比及时的行动更危险。",
    challenge: "你现在的分析会让你的行动快过还是慢过对手/环境的变化速度？"
  },
  "元认知": {
    role: "思维过程观察者",
    stance: "你正在用你的思维方式分析问题，但你有没有先观察自己在用什么思维方式？",
    challenge: "你现在的分析路径本身，是这个问题最合适的思维方式吗？"
  },
  "WOOP": {
    role: "执行意图设计师",
    stance: "美好的目标不够，你需要明确「哪个障碍会阻止你」以及「遇到障碍时的具体对策」。",
    challenge: "你最大的障碍是什么？如果遇到它，你的「如果…那么…」预案是什么？"
  },
  "心流": {
    role: "专注状态设计师",
    stance: "最好的执行不依赖意志力，而依赖设计一个能让你自然进入专注状态的环境。",
    challenge: "什么条件下你能自然进入专注状态？这些条件你现在有多少是可以主动创造的？"
  },
  "5W2H": {
    role: "完整性检查员",
    stance: "你的分析可能遗漏了关键维度。Who/What/When/Where/Why/How/How much 每一个都可能是盲区。",
    challenge: "你的分析里哪个维度是「感觉已经知道了但实际上没有数据」的？"
  },
  "STAR法则": {
    role: "结构化表达者",
    stance: "好的表达需要：情境-任务-行动-结果 四个维度，缺任何一个都让人无法判断你的结论是否有效。",
    challenge: "你的「行动」和「结果」之间有因果关系，还是只有时间顺序？"
  },
  "结构化思维": {
    role: "结构层次设计师",
    stance: "混乱的分析源于混乱的结构。先把问题拆成互斥完整的子问题，才能不遗漏地分析。",
    challenge: "你拆解的子问题之间真的互斥吗？还是有重叠，导致你在重复分析同一件事？"
  },
  "刻意练习": {
    role: "刻意改进设计师",
    stance: "重复做不带反馈的同一件事不叫练习，叫习惯。真正的改进需要持续的、精准定位的即时反馈。",
    challenge: "你的「提升方案」里有没有具体的反馈机制？没有精准反馈，努力只会强化已有模式。"
  }
};

// 通用角色（当模型名找不到映射时使用）
function defaultRole(model, idx) {
  const prefixes = ["视角A", "视角B", "视角C", "视角D"];
  return {
    role: `${model}思维者`,
    stance: `用「${model}」的核心逻辑审视这个问题，找到其他视角可能忽略的关键因素。`,
    challenge: `从「${model}」的角度看，这里最值得质疑的假设或盲区是什么？`
  };
}

// ─── 选取3个「立场最不同」的参与者 ─────────────────────
// 简单启发式：优先选 第一性原理、系统思维、5Whys 三强组合；
// 次选：有逆向思维/批判性/决策瘫痪的组合；
// fallback：取 models 列表的第1/中间/最后一个
const PRIORITY_COMBOS = [
  ["第一性原理", "系统思维", "5 Whys"],
  ["第一性原理", "系统思维", "逆向思维"],
  ["第一性原理", "系统思维", "框架思维"],
  ["第一性原理", "系统思维", "批判性思维"],
  ["第一性原理", "5 Whys", "框架思维"],
  ["系统思维", "5 Whys", "逆向思维"],
  ["系统思维", "框架思维", "决策瘫痪"],
];

function selectParticipants(models) {
  // 找优先组合
  for (const combo of PRIORITY_COMBOS) {
    if (combo.every(m => models.includes(m))) return combo;
  }
  // 找次优：models 里有第一性原理或系统思维，配合其他
  const anchors = ["第一性原理", "系统思维", "5 Whys", "逆向思维", "框架思维"];
  const available = anchors.filter(m => models.includes(m));
  if (available.length >= 3) return available.slice(0, 3);
  // fallback：取 models 里前3个（去重）
  const unique = [...new Set(models)];
  if (unique.length >= 3) return [unique[0], unique[Math.floor(unique.length/2)], unique[unique.length-1]];
  return unique.slice(0, Math.min(3, unique.length));
}

// ─── 生成 arena system_prompt ────────────────────────────
function buildArenaPrompt(name, problemType, selected, allModels) {
  const parts = selected.map((m, i) => {
    const info = MODEL_ROLES[m] || defaultRole(m, i);
    return `角色${String.fromCharCode(65+i)} — ${info.role}（${m}）\n立场：${info.stance}\n核心质疑：${info.challenge}`;
  });

  const tension = `${MODEL_ROLES[selected[0]]?.role || selected[0]} ↔ ${MODEL_ROLES[selected[1]]?.role || selected[1]}：两者对「问题根因」的定位可能不同`;

  return `你现在运行「${name}认知竞技场」模式。以下${selected.length}个角色同时持有不同立场，对同一个问题进行分析，通过张力和交集产生洞察。

【角色阵容】

${parts.join("\n\n")}

【竞技场规则】

Phase 1 — 独立发言：每个角色用自己的立场和工具独立分析问题，不参考其他角色的结论。

Phase 2 — 寻找张力：明确指出哪两个角色的结论相互矛盾，矛盾在哪个具体假设上。
参考张力模式：${tension}

Phase 3 — 综合：
- 交集（多个角色都指向的结论）= 高可信度，直接采用
- 冲突（只有一个角色支持的结论）= 标注为「需用户确认的盲区」
- 输出：①核心洞察（一句话） ②最值得行动的1个杠杆点 ③仍未解决的关键不确定性

【质量门禁】如果综合结论是「大家都知道的方向」，这不是洞察，这是共识。继续找张力冲突里的非共识内容。`;
}

// ─── 主流程 ─────────────────────────────────────────────
const chainFiles = readdirSync(DIR)
  .filter(f => f.match(/-chain-\d+\.json$/))
  .map(f => join(DIR, f));

// 收集已有的 arena 文件，确定每个问题类型下最大序号
const arenaIndex = {};
readdirSync(DIR)
  .filter(f => f.match(/-arena-\d+\.json$/))
  .forEach(f => {
    const m = f.match(/^(.+)-arena-(\d+)\.json$/);
    if (m) {
      const pt = m[1];
      const n  = parseInt(m[2]);
      arenaIndex[pt] = Math.max(arenaIndex[pt] || 0, n);
    }
  });

let built = 0, skipped = 0, errors = 0;
const processedTypes = new Set();

for (const chainFile of chainFiles) {
  try {
    const chain = JSON.parse(readFileSync(chainFile, "utf8"));
    const { problem_type, models, name } = chain.meta;
    
    // 提取简洁的问题类型名（用于文件名）
    const typeSlug = problem_type
      .replace(/\s+/g, "")
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "");

    // 跳过已手工精馏的类型
    if (MANUAL_ARENAS.has(typeSlug) || MANUAL_ARENAS.has(problem_type)) {
      skipped++;
      continue;
    }

    // 每个 problem_type 只生成一个 arena（用最强的模型组合）
    if (processedTypes.has(problem_type)) {
      skipped++;
      continue;
    }

    const selected = selectParticipants(models);
    if (selected.length < 2) {
      console.error(`  ⚠ ${basename(chainFile)}: 模型数量不足，跳过`);
      skipped++;
      continue;
    }

    const arenaName = problem_type;
    const nextN = (arenaIndex[typeSlug] || 0) + 1;
    const outId = `${typeSlug}-arena-${nextN}`;
    const outFile = join(DIR, `${outId}.json`);

    // 构建参与者
    const participants = selected.map((m, i) => {
      const info = MODEL_ROLES[m] || defaultRole(m, i);
      return {
        role: info.role,
        model: m,
        stance: info.stance,
        challenge_question: info.challenge
      };
    });

    const arena = {
      schema_version: "1.0-arena",
      id: outId,
      meta: {
        name: `${arenaName} 认知竞技场`,
        problem_type: arenaName,
        arena_size: selected.length,
        participants: selected,
        replaced_chain: chain.id,
        trigger_signals: chain.engine?.trigger_signals || []
      },
      participants,
      arena_protocol: {
        phase_1_individual: "每个角色用自己的立场和工具独立分析问题，给出各自的核心结论。",
        phase_2_confrontation: `寻找张力：${MODEL_ROLES[selected[0]]?.role || selected[0]} 和 ${MODEL_ROLES[selected[1]]?.role || selected[1]} 的结论在哪里相互矛盾？矛盾在什么具体假设上？`,
        phase_3_synthesis: "交集 = 高可信结论；冲突 = 盲区，需要用户补充信息。输出：①核心洞察 ②最值得行动的杠杆点 ③未解决的关键不确定性。",
        stop_condition: "当①②③全部给出，且冲突点都被标注后停止。"
      },
      codex: {
        activation: `请三个角色帮我分析「${arenaName}」相关问题：`,
        system_prompt: buildArenaPrompt(arenaName, arenaName, selected, models),
        usage_note: "粘贴 system_prompt 后，描述你的具体问题。"
      },
      quality: {
        participant_diversity: selected.some(m => MODEL_ROLES[m]) ? 4 : 3,
        tension_design: selected.filter(m => MODEL_ROLES[m]).length >= 2 ? 4 : 3,
        synthesis_clarity: 4,
        overall: 4,
        auto_generated: true
      }
    };

    writeFileSync(outFile, JSON.stringify(arena, null, 2), "utf8");
    processedTypes.add(problem_type);
    arenaIndex[typeSlug] = nextN;
    built++;
    console.log(`  ✅ ${outId} ← ${basename(chainFile)} (${selected.join(" + ")})`);

  } catch (e) {
    console.error(`  ❌ ${basename(chainFile)}: ${e.message}`);
    errors++;
  }
}

console.log(`\n完成: ${built} 个 arena 生成，${skipped} 个跳过，${errors} 个错误`);
console.log(`手工精馏 arena 保持不变: ${[...MANUAL_ARENAS].join(", ")}`);
