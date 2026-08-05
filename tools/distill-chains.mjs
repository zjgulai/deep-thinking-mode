#!/usr/bin/env node
/**
 * distill-chains.mjs — 模型链 → 可执行 Chain Protocol
 * 
 * 读取 model-chains.json，聚类去重，生成 V2-Chain 复合协议
 * 输出: chain-protocols/*.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHAINS_IN = join(ROOT, "model-chains.json");
const MODELS_DIR = join(ROOT, "knowledge", "models-v2");
const OUT = join(ROOT, "chain-protocols");

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const chainData = JSON.parse(readFileSync(CHAINS_IN, "utf8"));

// 问题类型→链模式映射(人工定义核心场景)
const PROBLEM_TYPES = {
  "问题分析与根因": {
    keywords: ["根因","原因","问题分析","拆解","归因","为什么","剖析","溯源","诊断"],
    commonHeads: ["5 Whys","第一性原理","鱼骨图","冰山模型","系统思维","结构化思维"],
    chains: []
  },
  "决策与选择": {
    keywords: ["决策","选择","判断","取舍","两难","比较","权衡","优先级"],
    commonHeads: ["决策矩阵","决策树","10-10-10法则","SWOT分析","事前验尸","成本效益分析"],
    chains: []
  },
  "创意与创新": {
    keywords: ["创新","创意","头脑风暴","灵感","突破","设计思维","逆向"],
    commonHeads: ["头脑风暴","逆向思维","SCAMPER","六顶思考帽","设计思维","TRIZ"],
    chains: []
  },
  "沟通与表达": {
    keywords: ["沟通","表达","汇报","演讲","写作","说服","谈判","反馈"],
    commonHeads: ["金字塔原理","STAR法则","PREP模型","非暴力沟通","SCQA","故事思维"],
    chains: []
  },
  "目标与执行": {
    keywords: ["目标","执行","行动","习惯","拖延","计划","落地","坚持","推进"],
    commonHeads: ["WOOP","SMART原则","GTD","番茄工作法","福格行为模型","执行意图"],
    chains: []
  },
  "情绪与内耗": {
    keywords: ["情绪","内耗","焦虑","压力","反刍","崩溃","失控","疲惫","耗竭"],
    commonHeads: ["内耗管理","认知解离","情绪调节","DMN","前额叶皮层","杏仁核劫持"],
    chains: []
  },
  "学习与成长": {
    keywords: ["学习","成长","知识","技能","精进","进步","提升","记忆","掌握"],
    commonHeads: ["刻意练习","心流","成长型思维","费曼技巧","元认知","学习金字塔"],
    chains: []
  },
  "战略与系统": {
    keywords: ["战略","系统","全局","生态","长期","宏观","颠覆","变革"],
    commonHeads: ["系统思维","波特五力","PEST分析","BCG矩阵","蓝海战略","熵增定律"],
    chains: []
  }
};

// 收集所有链
const allChains = [];
for (const entry of chainData) {
  for (const chain of entry.chains) {
    if (chain.length >= 3) { // 只取≥3模型的有意义链
      allChains.push({ source: entry.source, chain });
    }
  }
}

// 分配到问题类型
for (const [type, config] of Object.entries(PROBLEM_TYPES)) {
  for (const c of allChains) {
    const head = c.chain[0];
    const sourceLower = c.source.toLowerCase();
    const matchesHead = config.commonHeads.some(h => head.includes(h) || h.includes(head));
    const matchesKW = config.keywords.some(kw => sourceLower.includes(kw));
    if (matchesHead || matchesKW) {
      config.chains.push(c);
    }
  }
}

// 不匹配任何类型的归入通用
const matched = new Set();
for (const config of Object.values(PROBLEM_TYPES)) {
  for (const c of config.chains) matched.add(c);
}
const unmatched = allChains.filter(c => !matched.has(c));
if (unmatched.length > 0) {
  PROBLEM_TYPES["通用思维"] = {
    keywords: [],
    commonHeads: [],
    chains: unmatched
  };
}

// 对每个问题类型，去重+生成协议
let protocolCount = 0;
for (const [type, config] of Object.entries(PROBLEM_TYPES)) {
  if (config.chains.length === 0) continue;
  
  // 去重：归一化链签名
  const seen = new Set();
  const uniqueChains = [];
  for (const c of config.chains) {
    const sig = c.chain.join('→');
    if (!seen.has(sig)) { seen.add(sig); uniqueChains.push(c); }
  }
  
  // 取 Top 5 条链
  const top = uniqueChains.slice(0, 5);
  
  // 生成复合协议
  for (let i = 0; i < Math.min(3, top.length); i++) {
    const chain = top[i].chain;
    
    // 为链中每个模型查找V2协议(如果存在)
    const modelProtocols = [];
    for (const mn of chain) {
      // 尝试在models-v2中找
      const files = existsSync(MODELS_DIR) ? 
        readdirSync(MODELS_DIR).filter(f => f.endsWith('.json')) : [];
      let found = null;
      for (const f of files) {
        try {
          const m = JSON.parse(readFileSync(join(MODELS_DIR, f), 'utf8'));
          if (m.meta?.name && (m.meta.name.includes(mn) || mn.includes(m.meta.name))) {
            found = m;
            break;
          }
        } catch {}
      }
      modelProtocols.push({ name: mn, protocol: found });
    }
    
    // 构建 handoff 序列
    const steps = chain.map((mn, idx) => ({
      step: idx + 1,
      model: mn,
      action: `激活「${mn}」思维模式，处理当前阶段的核心问题`,
      handoff_to: idx < chain.length - 1 ? chain[idx + 1] : "输出最终结论"
    }));
    
    const protocolId = `${type.replace(/\s/g,'-')}-chain-${i+1}`.toLowerCase();
    
    const protocol = {
      schema_version: "2.1-chain",
      id: protocolId,
      meta: {
        name: `${type}: ${chain.join(' → ')}`,
        problem_type: type,
        chain_length: chain.length,
        models: chain,
        source: top[i].source.slice(0, 80)
      },
      engine: {
        core_question: `解决${type}问题的完整推理链条`,
        trigger_signals: [
          `面对${type}相关的复杂问题时`,
          "单一模型分析不充分，需要多角度递进推理",
          "需要从多个层次逐步深入理解问题"
        ],
        chain_sequence: steps,
        handoff_rule: "每步完成后，根据当前步骤的产出决定是否满足进入下一步的条件"
      },
      codex: {
        system_prompt: `你现在以复合推理模式运行，解决「${type}」问题。按以下链式协议依次激活思维模型：\n\n${steps.map(s => `Step ${s.step} - 「${s.model}」: ${s.action} → ${s.handoff_to}`).join('\n\n')}\n\n约束：严格按顺序执行，上一步的产出作为下一步的输入。如果某步产出不足以支撑下一步，回溯到前一步补充分析。`,
        activation_phrase: `请用${chain.slice(0,2).join('+')}帮我分析...`,
        fallback: ""
      },
      quality: {
        reasoning_completeness: Math.min(chain.length, 5),
        chain_depth: chain.length,
        protocol_count: top.length,
        overall: chain.length >= 4 ? 5 : chain.length >= 3 ? 4 : 3
      }
    };
    
    writeFileSync(join(OUT, `${protocolId}.json`), JSON.stringify(protocol, null, 2), 'utf8');
    protocolCount++;
  }
}

console.log(`✅ 生成 ${protocolCount} 个 Chain Protocol → chain-protocols/`);
console.log(`   覆盖 ${Object.values(PROBLEM_TYPES).filter(c=>c.chains.length>0).length} 个问题类型`);
console.log(`\n=== 问题类型分布 ===`);
for (const [type, config] of Object.entries(PROBLEM_TYPES)) {
  if (config.chains.length > 0) {
    const topChain = config.chains[0]?.chain?.join(' → ') || '';
    console.log(`  ${type}: ${config.chains.length}条链 → 示例: ${topChain}`);
  }
}
