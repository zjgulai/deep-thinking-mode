#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODELS = join(ROOT, "knowledge", "models");
const TAX = join(ROOT, "knowledge", "taxonomy.json");
const OUT = join(ROOT, "docs");
const CH = join(OUT, "chapters");

const taxonomy = JSON.parse(readFileSync(TAX, "utf8"));
const chapters = taxonomy.chapters;

const models = readdirSync(MODELS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(MODELS, f), "utf8"))).sort((a, b) => b.quality - a.quality);
const byChapter = {};
for (const ch of chapters) byChapter[ch.id] = [];
for (const m of models) byChapter[m.chapter] ? byChapter[m.chapter].push(m) : byChapter["00"].push(m);

function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function stars(n) { return "★".repeat(n) + "☆".repeat(5-n); }

const CSS = `:root{--canvas:#faf9f5;--surface:#fff;--text:#1a1a1a;--body:#3d3d3a;--muted:#6c6a64;--accent:#905831;--hairline:#e6dfd8;--strong:#0a0a0a;--warning:#8a4b12;--good:#2d7d46;--r:12px}
@media(prefers-color-scheme:dark){:root{--canvas:#171512;--surface:#211e1a;--text:#f5f1eb;--body:#ddd6cc;--muted:#b9afa3;--accent:#d59a6f;--hairline:#39332d;--strong:#faf9f5;--warning:#f0b36d;--good:#5dc97a}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px;scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;background:var(--canvas);color:var(--body);line-height:1.75;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.skip-link{position:absolute;top:-100px;left:16px;padding:8px 16px;background:var(--strong);color:var(--canvas);border-radius:6px;z-index:100;font-size:.875rem}.skip-link:focus{top:16px}
header{position:sticky;top:0;z-index:50;background:rgba(250,249,245,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--hairline);padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between}
@media(prefers-color-scheme:dark){header{background:rgba(23,21,18,.88)}}header .logo{font-weight:700;font-size:1.05rem;color:var(--text)}header nav{display:flex;gap:20px}header nav a{font-size:.875rem;color:var(--muted);font-weight:500}header nav a:hover{color:var(--accent);text-decoration:none}
.breadcrumb{font-size:.8rem;color:var(--muted);padding:16px 24px 0;max-width:900px;margin:0 auto}.breadcrumb a{color:var(--muted)}.breadcrumb span{color:var(--accent)}
main{max-width:900px;margin:0 auto;padding:24px 24px 64px}
h1{font-size:2rem;color:var(--text);margin-bottom:8px}h2{font-size:1.3rem;color:var(--text);margin:32px 0 10px}.chapter-desc{color:var(--muted);margin-bottom:24px}
.sub-tags{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:28px}.sub-tag{padding:4px 14px;border-radius:999px;font-size:.8rem;font-weight:500;background:rgba(144,88,49,.08);color:var(--accent)}
.model-card{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--r);padding:28px;margin-bottom:16px}
.model-card h2{font-size:1.1rem;margin:0 0 4px;color:var(--text)}.model-card h2 a{color:var(--text)}.model-meta{font-size:.75rem;color:var(--muted);margin-bottom:14px}.model-label{font-size:.68rem;font-weight:700;letter-spacing:.05em;color:var(--accent);margin:14px 0 4px}.model-value{font-size:.9rem;line-height:1.8;color:var(--body)}.model-value li{margin-bottom:6px;margin-left:20px}.model-value strong{color:var(--text)}
.codex-block{background:var(--canvas);border:1px solid var(--hairline);border-radius:8px;padding:14px 18px;font-size:.82rem;color:var(--muted);line-height:1.6;margin-top:8px;font-family:SF Mono,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.tags-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.tag-chip{font-size:.65rem;padding:2px 8px;border-radius:999px;background:rgba(144,88,49,.06);color:var(--accent)}
.stars{color:var(--warning);font-size:.7rem;margin-left:6px}
.hero{text-align:center;padding:48px 24px;position:relative;overflow:hidden}.hero::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,rgba(144,88,49,.1) 0%,transparent 70%);z-index:0}.hero>*{position:relative;z-index:1}
.ch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;padding:0 24px;max-width:1100px;margin:0 auto 48px}
.ch-card{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--r);padding:22px;transition:border-color .15s,transform .15s;display:block;text-decoration:none}.ch-card:hover{border-color:var(--accent);transform:translateY(-2px);text-decoration:none}
.ch-num{font-size:.7rem;font-weight:700;color:var(--accent);letter-spacing:.06em;margin-bottom:8px}.ch-card h3{font-size:1rem;color:var(--text);margin:0 0 6px}.ch-card .desc{font-size:.8rem;color:var(--muted);line-height:1.5;margin-bottom:8px}.ch-card .cnt{font-size:.7rem;color:var(--good);font-weight:600;padding:2px 8px;background:rgba(45,125,70,.08);border-radius:999px;display:inline-block}
.nav-row{display:flex;justify-content:space-between;margin-top:48px;padding-top:24px;border-top:1px solid var(--hairline)}.nav-row a{font-weight:600}
footer{border-top:1px solid var(--hairline);padding:32px 24px;text-align:center;color:var(--muted);font-size:.8rem}footer a{font-weight:500}
@media(max-width:768px){header nav{display:none}main{padding:16px}.ch-grid{grid-template-columns:1fr;padding:0 16px}.model-card{padding:20px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media print{header,.nav-row,footer{display:none}}`;

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
if (!existsSync(CH)) mkdirSync(CH, { recursive: true });
writeFileSync(join(OUT, "style.css"), CSS, "utf8");

// ── 首页 ──
let cards = "";
for (const ch of chapters) {
  const n = (byChapter[ch.id] || []).length;
  cards += `<a href="chapters/ch${ch.id}-${ch.slug}.html" class="ch-card"><div class="ch-num">Ch.${ch.id}</div><h3>${ch.title}</h3><div class="desc">${ch.description}</div><span class="cnt">${n} 个模型</span></a>`;
}
const total = chapters.reduce((s,ch) => s + (byChapter[ch.id]||[]).length, 0);
writeFileSync(join(OUT,"index.html"),`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>系统化思维 — ${total}个思维模型</title><link rel="stylesheet" href="style.css"></head><body><a href="#main" class="skip-link">跳至正文</a><header><span class="logo"><a href="index.html" style="color:var(--text);text-decoration:none">系统化思维</a></span><nav><a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a></nav></header><main id="main"><div class="hero"><h1>把复杂问题，看成可以理解、选择与行动的系统</h1><p style="color:var(--muted);max-width:560px;margin:8px auto 0">${chapters.length}章 · ${total}个思维模型 · 每个模型含Codex共学提示词</p></div><div class="ch-grid">${cards}</div></main><footer><p><strong>系统化思维</strong> &copy; 2026 · <a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a></p></footer></body></html>`,"utf8");
console.log(`   ✓ index.html (${total} models)`);

// ── 章节页 ──
for (const ch of chapters) {
  const arts = byChapter[ch.id] || [];
  const subs = (ch.subchapters||[]).map(s=>`<span class="sub-tag">${s.title}</span>`).join("");
  let html = "";
  for (const a of arts) {
    const id = esc(a.id||"").slice(0,50);
    const sigHtml = (a.signals||[]).map(s=>`<li>${esc(s)}</li>`).join("");
    const stpHtml = (a.steps||[]).map(s=>`<li>${esc(s)}</li>`).join("");
    const tagHtml = (a.tags||[]).map(t=>`<span class="tag-chip">${esc(t)}</span>`).join("");
    html += `<article class="model-card" id="${id}"><h2><a href="#${id}">${esc(a.name||"")}</a><span class="stars">${stars(Math.min(a.quality||0,5))}</span></h2><div class="model-meta">${esc((a.source_title||"").slice(0,60))}</div>`;
    if (a.definition) html += `<div class="model-label">📌 核心定义</div><div class="model-value">${esc(a.definition)}</div>`;
    if (a.mechanism) html += `<div class="model-label">🔬 底层机制</div><div class="model-value">${esc(a.mechanism)}</div>`;
    if (sigHtml) html += `<div class="model-label">🔔 识别信号</div><div class="model-value"><ul>${sigHtml}</ul></div>`;
    if (stpHtml) html += `<div class="model-label">📋 操作步骤</div><div class="model-value"><ol>${stpHtml}</ol></div>`;
    if (a.example) html += `<div class="model-label">💡 示例</div><div class="model-value">${esc(a.example)}</div>`;
    if (a.codex_prompt) html += `<div class="model-label">🤖 与 Codex 共学</div><div class="codex-block">${esc(a.codex_prompt)}</div>`;
    if (tagHtml) html += `<div class="tags-row">${tagHtml}</div>`;
    html += `</article>`;
  }
  const idx = chapters.findIndex(c=>c.id===ch.id);
  const prev=idx>0?chapters[idx-1]:null, next=idx<chapters.length-1?chapters[idx+1]:null;
  let nav = '<div class="nav-row">';
  nav += prev?`<a href="ch${prev.id}-${prev.slug}.html">← Ch.${prev.id} ${prev.title}</a>`:"<span></span>";
  nav += next?`<a href="ch${next.id}-${next.slug}.html">Ch.${next.id} ${next.title} →</a>`:"<span></span>";
  nav += '</div>';
  writeFileSync(join(CH,`ch${ch.id}-${ch.slug}.html`),`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Ch.${ch.id} ${ch.title} — 系统化思维</title><link rel="stylesheet" href="../style.css"></head><body><a href="#main" class="skip-link">跳至正文</a><header><span class="logo"><a href="../index.html" style="color:var(--text);text-decoration:none">系统化思维</a></span><nav><a href="../index.html">章节导航</a><a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a></nav></header><div class="breadcrumb"><a href="../index.html">首页</a> / <span>Ch.${ch.id} ${ch.title}</span></div><main id="main"><h1>Ch.${ch.id} ${ch.title}</h1><p class="chapter-desc">${ch.description} · ${arts.length}个思维模型</p><div class="sub-tags">${subs}</div>${html}${nav}</main><footer><p><strong>系统化思维</strong> &copy; 2026 · <a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a></p></footer></body></html>`,"utf8");
  console.log(`   ✓ ch${ch.id} (${arts.length})`);
}
console.log("\n✅ 完成 → docs/");
