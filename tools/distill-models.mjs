#!/usr/bin/env node
/**
 * distill-models.mjs v2 — 批量蒸馏引擎
 * 提取: 模型名/一句话定义/底层机制/识别信号/操作步骤/示例/Codex提示词
 * 输出: knowledge/models/*.json
 * 用法: node tools/distill-models.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = join(ROOT, "data");
const TAX = join(ROOT, "knowledge", "taxonomy.json");
const OUT = join(ROOT, "knowledge", "models");
const taxonomy = JSON.parse(readFileSync(TAX, "utf8"));
const chapters = taxonomy.chapters;

// ─── 清洗 ────────────────────────────────────────────────
function clean(raw) {
  let t = raw;
  // 去掉 CSS 块
  t = t.replace(/^[\s\S]*?\n(?=#{1,3}\s|[^\n]{8,}\n[=]{3,})/, "");
  // 彻底删除所有含 SVG data URI 的行
  t = t.replace(/^.*data:image\/svg\+xml.*$/gmi, "");
  t = t.replace(/^.*<svg[^>]*>.*$/gmi, "");
  t = t.replace(/^.*<\/svg>.*$/gmi, "");
  t = t.replace(/^.*<g[>\s].*$/gmi, "");
  t = t.replace(/^.*<path[>\s].*$/gmi, "");
  t = t.replace(/^.*<circle[>\s].*$/gmi, "");
  t = t.replace(/^.*<rect[>\s].*$/gmi, "");
  t = t.replace(/^.*<mask[>\s].*$/gmi, "");
  t = t.replace(/^.*<defs>.*$/gmi, "");
  t = t.replace(/^.*<\/g>.*$/gmi, "");
  // 删除页脚互动
  t = t.replace(/^.*(阅读|赞|分享|推荐|留言|喜欢|在看)\s*\d*.*$/gmi, "");
  // 删除微信图片和作者Logo
  t = t.replace(/^!\[[^\]]*\]\(https?:\/\/[^)]*mmbiz[^)]*\).*$/gm, "");
  t = t.replace(/^!\[[^\]]*\]\(http:\/\/[^)]*\).*$/gm, "");
  t = t.replace(/^图\d+\s*$/gm, "");
  t = t.replace(/^.*mmbiz\.qpic\.cn.*$/gm, "");
  // 删除原创行
  t = t.replace(/^原创\s+\S+.*$/gm, "");
  // 删除原文地址
  t = t.replace(/^>\s*原文地址.*$/gm, "");
  // 删除分隔线
  t = t.replace(/^[=]{3,}\s*$/gm, "");
  // 删除纯空白行
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

// ─── 蒸馏核心 v2 ────────────────────────────────────────
function distill(text, filename) {
  const lines = text.split("\n");
  const m = { name: "", definition: "", mechanism: "", signals: [], steps: [], example: "", tags: [] };

  // ── 模型名 ──
  for (let i = 0; i < 8; i++) {
    const t = lines[i]?.trim() || "";
    const h = t.match(/^#+\s*(.+)/);
    if (h) { m.name = h[1]; break; }
    if (t.length > 3 && !/^[=*-]/.test(t) && !m.name) m.name = t;
  }
  m.name = m.name
    .replace(/^.*?[·•]/g, "")        // 去掉所有系列前缀
    .replace(/（[^）]{0,30}速查[^）]{0,10}）/, "")
    .replace(/\s*[:-]\s*(?:终极|完整|高阶|实操|落地|深度|全网).*$/, "")
    .replace(/__.*$/, "")
    .replace(/^[\s·•]+/, "")
    .trim()
    .slice(0, 50);

  // ── 正文起点 ──
  let bs = 0;
  for (let i = 0; i < 15; i++) {
    const t = lines[i]?.trim() || "";
    if (/^(#|原创|>|=|!\[)/.test(t)) continue;
    if (t.length > 8) { bs = i; break; }
  }
  const body = lines.slice(bs).join("\n");
  const pgs = body.split(/\n\n+/).map((p) => p.replace(/\n/g, " ").trim()).filter((p) => p.length > 15);

  // ── 定义 ──
  const defPat = [/(?:核心\s*)?定义[：:]\s*(.{15,180})/, /所谓.{0,6}[，,]\s*(.{15,180})/, /(?:是指|指的是|本质是|核心是)[：:\s]*(.{15,180})/];
  for (const p of defPat) { const mx = body.match(p); if (mx) { m.definition = mx[1].trim().slice(0, 180); break; } }
  if (!m.definition) {
    for (const p of pgs.slice(0, 5)) {
      if (p.length > 25 && p.length < 180 && /[是为指].{2,}[，,。.]/.test(p) && !/^[!\d#\-]/.test(p)) { m.definition = p.slice(0, 180); break; }
    }
  }

  // ── 机制 ──
  for (const kw of ["机制", "原理", "底层", "根源", "成因", "神经", "认知机制", "心理机制", "为什么"]) {
    const re = new RegExp(`${kw}[：:]?\\s*([\\s\\S]{30,500}?)(?=\\n(?:#{1,3}|总结|结语|示例|案例|应用|操作|步骤|方法|如何|怎么|附|注意|提示|结尾|$))`);
    const mx = body.match(re);
    if (mx) { m.mechanism = mx[1].replace(/\n/g, " ").trim().slice(0, 500); break; }
  }
  if (!m.mechanism) {
    for (const p of pgs.slice(1, 8)) {
      if (p.length > 60 && p.length < 450 && /[是为因由会能可].{2,}[导引造致产形影].{2,}/.test(p)) { m.mechanism = p.slice(0, 450); break; }
    }
  }
  if (!m.mechanism && pgs.length > 2) {
    for (const p of pgs.slice(1, 5)) { if (p.length > 80 && p.length < 400) { m.mechanism = p.slice(0, 400); break; } }
  }

  // ── 信号 ──
  const sig = body.match(/(?:你是否经历过|你是否|你是否有过|识别信号|适用信号|适用场景|什么情况|什么时候用|什么时候)[：:]?\n?([\s\S]{40,600}?)(?=\n(?:#{1,3}|[一二三四五六七八九十]、|总结|结语|示例|案例|应用|操作|步骤|方法|如何|怎么|附|注意|提示|结尾|机制|原理|为什么))/);
  if (sig) { const items = sig[1].match(/[-•*]\s*([^\n]{8,100})/g); if (items) m.signals = items.map((i) => i.replace(/^[-•*]\s*/, "").trim().slice(0, 80)).slice(0, 6); }
  if (!m.signals.length) { const bl = body.match(/\n\*\s+([^\n]{8,100})/g); if (bl) m.signals = bl.map((b) => b.replace(/\n\*\s*/, "").trim().slice(0, 80)).slice(0, 6); }
  // 从正文提取 "你是否经历过" 段落的bullet
  if (!m.signals.length) {
    const exp = body.match(/你是否经历过[：:]?\n?([\s\S]{40,500}?)(?=\n(?:这|其|它|这些|[一二三四五六七八九十]、|#))/);
    if (exp) { const items = exp[1].match(/[-•*]\s*([^\n]{8,100})/g); if (items) m.signals = items.map((i) => i.replace(/^[-•*]\s*/, "").trim().slice(0, 80)).slice(0, 6); }
  }

  // ── 步骤 ──
  const stepSec = body.match(/(?:操作\s*)?步骤[：:]\s*\n?([\s\S]{80,700}?)(?=\n(?:#{1,3}|[=]{2,}|总结|结语|示例|案例|结尾|附|注意|提示|核心|关系|组合|常见|误区|风险|停止))?/);
  const methodSec = body.match(/(?:方法|做法|怎么做|如何落地|落地方法|实践|执行|行动步骤)[：:]\s*\n?([\s\S]{80,700}?)(?=\n(?:#{1,3}|[=]{2,}|总结|结语|示例|案例|结尾|附|注意|提示|核心|关系|组合|常见))?/);
  const section = stepSec?.[1] || methodSec?.[1];
  if (section) {
    const numItems = section.match(/(?:[①②③④⑤⑥⑦⑧⑨⑩]|\d+[\.、)]\s*|步骤\s*\d[：:]?|第[一二三四五六七八九十]步[：:]?)\s*[^\n]{6,120}/g);
    if (numItems && numItems.length >= 2) m.steps = numItems.map((s) => s.trim().slice(0, 120)).slice(0, 8);
    else {
      const dash = section.match(/[-•]\s*[^\n]{8,120}/g);
      if (dash && dash.length >= 3) m.steps = dash.map((s) => s.trim().slice(0, 120)).slice(0, 8);
    }
  }
  // 备选：全文中搜索编号步骤
  if (!m.steps.length) {
    const allNums = body.match(/(?:[①②③④⑤⑥⑦⑧⑨⑩]|\d+[\.、)]\s*|步骤\s*[一二三四五六七八九十\d][：:]?|第[一二三四五六七八九十]步[：:]?)\s*[^\n]{6,120}/g);
    if (allNums && allNums.length >= 3) m.steps = [...new Set(allNums)].map((s) => s.trim().slice(0, 120)).slice(0, 8);
  }

  // ── 示例 ──
  const ex = body.match(/(?:示例|案例|例如|举例|比如|场景|举个例子)[：:]*\s*(.{15,250}?)(?=\n\n|\n[#*=]|\n[一二三四五六七八九十]、|\n\d+[\.、]|$)/s);
  if (ex) m.example = ex[1].replace(/\n/g, " ").trim().slice(0, 220);

  // ── 标签 ──
  const tags = text.match(/#([^\s#]{2,14})/g);
  if (tags) m.tags = [...new Set(tags.map((t) => t.replace("#", "").trim()))].slice(0, 7);

  // ── 后处理：过滤掉包含SVG/HTML垃圾的步骤 ──
  m.steps = m.steps.filter((s) => !/<svg|<path|<circle|<rect|%3Csvg|mmbiz|qpic/.test(s));

  return m;
}

// ─── 主流程 ──────────────────────────────────────────────
console.log("🧠 蒸馏引擎 v2 启动...\n");

const files = readdirSync(DATA).filter((f) => f.endsWith(".md") && f !== "AGENTS.md");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

let total = 0, skipped = 0;
const stats = {};

for (const f of files) {
  const isFlashcard = f.includes("速查卡") || f.includes("速查");
  if (isFlashcard) { skipped++; continue; }

  const raw = readFileSync(join(DATA, f), "utf8");
  const cleanText = clean(raw);
  if (cleanText.length < 100) { skipped++; continue; }

  const meta = extractMeta(cleanText);
  const ch = classify(cleanText, f);
  const mdl = distill(cleanText, f);

  const mid = f.replace(/\.md$/, "").replace(/[^a-zA-Z0-9\u4e00-\u9fff-]/g, "-").replace(/-+/g, "-").slice(0, 55).toLowerCase();

  // 质量分 0-5
  let q = 0;
  if (mdl.definition.length > 20) q++;
  if (mdl.mechanism.length > 40) q++;
  if (mdl.signals.length >= 2) q++;
  if (mdl.steps.length >= 2) q++;
  if (mdl.example.length > 10) q++;

  const out = {
    id: mid,
    name: mdl.name,
    chapter: ch,
    quality: q,
    tags: mdl.tags,
    source_title: meta.title,
    source_url: meta.sourceUrl,
    definition: mdl.definition,
    mechanism: mdl.mechanism,
    signals: mdl.signals,
    steps: mdl.steps,
    example: mdl.example,
    codex_prompt: `我正在学习「${mdl.name}」这个思维模型。请结合这个模型的框架，帮我分析我遇到的具体问题。首先判断我的场景是否适用此模型；如果适用，请按照操作步骤逐步引导我。如果不适用，推荐更适合的模型。`,
    related_models: [],
  };

  writeFileSync(join(OUT, `${mid}.json`), JSON.stringify(out, null, 2), "utf8");
  stats[ch] = (stats[ch] || 0) + 1;
  total++;
}

console.log(`✅ ${total} 个模型 (跳过 ${skipped} 个速查卡)\n`);
for (const ch of chapters) { const n = stats[ch.id] || 0; if (n > 0) console.log(`   Ch.${ch.id} ${ch.title}: ${n}`); }
const qualities = readdirSync(OUT).map((fn) => JSON.parse(readFileSync(join(OUT, fn), "utf8")).quality);
console.log(`\n⭐ 平均质量: ${(qualities.reduce((a, b) => a + b, 0) / qualities.length).toFixed(1)}/5 | ≥4星: ${qualities.filter((q) => q >= 4).length}/${total}`);
