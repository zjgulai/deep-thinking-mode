#!/usr/bin/env node
/**
 * identify-models.mjs — Phase B: 从提取文本中识别+去重思维模型
 * 
 * 策略（基于 cangjie-skill Stage 1 + 1.5）:
 * 1. 章节/编号标题提取
 * 2. 已知模型库匹配
 * 3. 跨源去重（同名合并，相似名归一化）
 * 4. 与现有 models-v2/ 对比 → 标注新增/覆盖/已有
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTRACTED = join(ROOT, "ref-extracted");
const EXISTING_DIR = join(ROOT, "knowledge", "models-v2");
const OUT = join(ROOT, "model-inventory.json");

// 已知模型名库（100+个）
const KNOWN = new Set([
  "第一性原理","5 Whys","5W1H","5W2H","SWOT","SWOT分析","PEST","PEST分析","PESTEL",
  "波特五力","五力模型","BCG矩阵","波士顿矩阵","安索夫矩阵","GE矩阵","麦肯锡矩阵",
  "二八法则","帕累托法则","8020法则","长尾理论","金字塔原理","MECE","MECE原则",
  "SMART原则","SMART","PDCA","PDCA循环","戴明环","OODA","OODA循环",
  "双钻模型","设计思维","精益创业","精益画布","敏捷开发","Scrum","看板",
  "蓝海战略","颠覆性创新","跨越鸿沟","技术采纳生命周期","摩尔定律",
  "创新扩散","S曲线","第二曲线","飞轮效应","复利效应","网络效应",
  "马斯洛需求层次","需求金字塔","双因素理论","赫茨伯格","X-Y理论","情境领导力",
  "T型人才","π型人才","一万小时定律","刻意练习","心流","成长型思维","固定型思维",
  "系统思维","框架思维","结构化思维","批判性思维","逆向思维","水平思考","纵向思考",
  "六顶思考帽","头脑风暴","SCAMPER","TRIZ","事前验尸","红队演练",
  "决策矩阵","决策树","成本效益分析","盈亏平衡","ROI分析","净现值NPV",
  "GTD","时间矩阵","四象限法","艾森豪威尔矩阵","番茄工作法","要事第一",
  "WOOP","执行意图","如果-那么计划","福格行为模型","习惯回路","原子习惯",
  "非暴力沟通","STAR法则","电梯演讲","故事思维","PREP模型","金字塔表达",
  "认知失调","确认偏误","锚定效应","损失厌恶","沉没成本","框架效应",
  "从众效应","光环效应","幸存者偏差","归因错误","邓宁-克鲁格","达克效应",
  "囚徒困境","博弈论","零和博弈","马太效应","红皇后效应",
  "熵增定律","耗散结构","涌现","分形","蝴蝶效应","黑天鹅","灰犀牛",
  "RACI","RACI矩阵","OKR","KPI","平衡计分卡","BSC",
  "4P营销","4C营销","7P营销","STP营销","定位理论","品牌金字塔",
  "AARRR","海盗指标","增长黑客","A/B测试","最小可行产品","MVP",
  "冰山模型","洋葱模型","胜任力模型","能力模型","学习金字塔",
  "DISC","MBTI","九型人格","大五人格","情商模型","情绪智力",
  "力场分析","鱼骨图","石川图","因果图","五个为什么",
  "VRIO","VRIO分析","核心竞争力","价值链","价值网",
  "商业模式画布","价值主张画布","蓝海价值曲线","战略地图","商业模型画布",
  "SECI模型","知识螺旋","DIKW","DIKW模型","经验学习圈","库伯学习圈",
  "睡眠周期","昼夜节律","番茄钟","90分钟周期","深度工作","心流状态",
  "二八法则","三脑理论","三重脑","杏仁核劫持","前额叶皮层","默认模式网络",
]);

// 模型名归一化映射
const ALIASES = {
  "二八法则":"帕累托法则","8020法则":"帕累托法则","80/20":"帕累托法则",
  "swot":"SWOT分析","pest":"PEST分析","smart":"SMART原则",
  "pdca":"PDCA循环","ooda":"OODA循环",
  "mece":"MECE原则","金字塔表达":"金字塔原理",
  "5why":"5 Whys","五个为什么":"5 Whys",
  "需求金字塔":"马斯洛需求层次","冰山理论":"冰山模型",
  "四象限":"艾森豪威尔矩阵","时间四象限":"艾森豪威尔矩阵",
  "损失规避":"损失厌恶","从众心理":"从众效应",
  "一万小时":"一万小时定律","复利思维":"复利效应",
  "番茄钟":"番茄工作法","如果-那么":"WOOP",
};

// ─── 模型名归一化 ──────────────────────────────────────
function normalize(name) {
  let n = name.trim().replace(/\s+/g, '');
  n = n.replace(/[（(].*?[）)]/g, ''); // 去括号
  n = n.replace(/法[则计析]$/, '').replace(/[原公定]理$/, '').replace(/模[型式]$/, '');
  // 英文字母统一大写
  n = n.replace(/[a-z]{2,}/g, m => m.toUpperCase());
  // 别名映射
  if (ALIASES[n]) return normalize(ALIASES[n]);
  return n;
}

// ─── 提取模型候选 ───────────────────────────────────
function extractCandidates(text, sourceFile) {
  const candidates = [];
  
  // 1. 编号标题: "第X章 XXX" "一、XXX" "1. XXX" "1.1 XXX" "Step1 XXX"
  const headingPatterns = [
    /第[一二三四五六七八九十\d]+章\s*[：:\s]*([^\(\)\n，,]{3,40}?)(?:$|\n|[（(])/g,
    /(?:^|\n)[一二三四五六七八九十]+[、．]\s*([^\(\)\n，,]{3,40}?)(?:$|\n|[（(])/gm,
    /(?:^|\n)\d+[\\.、]\s*(?!\d)([^\(\)\n，,]{3,40}?)(?:$|\n|[（(])/gm,
    /(?:^|\n)\d+\.\d+[\\.、\s]*([^\(\)\n，,]{3,40}?)(?:$|\n|[（(])/gm,
    /步骤\s*\d[：:\s]*([^\(\)\n，,]{3,40}?)(?:$|\n)/g,
  ];
  for (const pat of headingPatterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const name = m[1].trim();
      if (name.length >= 3 && name.length <= 40) {
        candidates.push({ name, type: 'heading', evidence: m[0].trim().slice(0, 80) });
      }
    }
  }
  
  // 2. 粗体标记: **XXX** 
  const boldPat = /\*\*([^*]{3,40})\*\*/g;
  let bm;
  while ((bm = boldPat.exec(text)) !== null) {
    candidates.push({ name: bm[1].trim(), type: 'bold', evidence: bm[0] });
  }
  
  // 3. "XXX模型" "XXX法则" "XXX原则" "XXX定律" "XXX理论" "XXX效应" "XXX分析法"
  const suffixPats = [
    /([^。\n，,]{2,20}模型)/g,
    /([^。\n，,]{2,20}法则)/g,
    /([^。\n，,]{2,20}原则)/g,
    /([^。\n，,]{2,20}定律)/g,
    /([^。\n，,]{2,20}效应)/g,
    /([^。\n，,]{2,20}分析法)/g,
    /([^。\n，,]{2,20}理论)/g,
    /([^。\n，,]{2,20}思维)/g,
  ];
  for (const pat of suffixPats) {
    let sm;
    while ((sm = pat.exec(text)) !== null) {
      candidates.push({ name: sm[1].trim(), type: 'suffix', evidence: sm[0] });
    }
  }
  
  // 4. 已知模型名精确匹配
  for (const known of KNOWN) {
    if (text.includes(known)) {
      candidates.push({ name: known, type: 'known', evidence: known });
    }
  }
  
  return candidates;
}

// ─── 主流程 ──────────────────────────────────────────
console.log("🔍 Phase B: 模型识别+去重\n");

const files = readdirSync(EXTRACTED).filter(f => f.endsWith('.txt'));
const allRaw = [];
const sourceStats = {};

for (const f of files) {
  const path = join(EXTRACTED, f);
  const text = readFileSync(path, 'utf8');
  if (text.length < 500) continue;
  
  const candidates = extractCandidates(text, f);
  for (const c of candidates) {
    const norm = normalize(c.name);
    if (norm.length < 3 || norm.length > 50) continue;
    allRaw.push({ src: f.replace('.txt','').slice(0,50), name: c.name, norm, type: c.type });
  }
  sourceStats[f] = candidates.length;
}

console.log(`原始候选: ${allRaw.length} 条 (来自 ${Object.keys(sourceStats).length} 个文件)`);

// 去重+合并来源
const modelMap = new Map();
for (const r of allRaw) {
  if (modelMap.has(r.norm)) {
    const existing = modelMap.get(r.norm);
    if (!existing.sources.includes(r.src)) existing.sources.push(r.src);
    if (existing.displayName.length < r.name.length) existing.displayName = r.name;
    existing.frequency++;
  } else {
    modelMap.set(r.norm, {
      norm: r.norm,
      displayName: r.name,
      sources: [r.src],
      frequency: 1,
      types: [r.type]
    });
  }
}

const models = [...modelMap.values()]
  .filter(m => m.frequency >= 1)
  .sort((a, b) => b.frequency - a.frequency);

// 与现有 models-v2/ 对比
const existingNames = new Set();
if (existsSync(EXISTING_DIR)) {
  for (const ef of readdirSync(EXISTING_DIR)) {
    if (!ef.endsWith('.json')) continue;
    try {
      const em = JSON.parse(readFileSync(join(EXISTING_DIR, ef), 'utf8'));
      if (em.meta?.name) {
        existingNames.add(normalize(em.meta.name));
      }
    } catch {}
  }
}

const result = models.slice(0, 400).map(m => ({
  ...m,
  status: existingNames.has(m.norm) ? 'already_exists' : 
          [...existingNames].some(e => e.includes(m.norm) || m.norm.includes(e)) ? 'partial_match' : 
          'new'
}));

const newModels = result.filter(m => m.status === 'new');
const partial = result.filter(m => m.status === 'partial_match');
const existing = result.filter(m => m.status === 'already_exists');

writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

// 统计报告
console.log(`去重后: ${models.length} 个唯一模型`);
console.log(`  新增: ${newModels.length} 个`);
console.log(`  部分匹配(需人工确认): ${partial.length} 个`);
console.log(`  已有: ${existing.length} 个`);
console.log(`\n=== Top 30 (按出现频次) ===`);
result.slice(0, 30).forEach(m => {
  const tag = m.status === 'new' ? '🆕' : m.status === 'partial_match' ? '🔄' : '✅';
  console.log(`  ${tag} ${m.displayName} [${m.sources.length}源]`);
});

// 输出每本书的候选数
console.log(`\n=== 每本书候选模型数 ===`);
Object.entries(sourceStats)
  .sort((a,b) => b[1]-a[1])
  .slice(0, 15)
  .forEach(([f, n]) => console.log(`  ${f.slice(0,50)}... → ${n}`));
