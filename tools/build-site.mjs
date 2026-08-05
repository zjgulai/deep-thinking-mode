#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODELS = join(ROOT, "knowledge", "models-v3");
const TAX = join(ROOT, "knowledge", "taxonomy.json");
const OUT = join(ROOT, "docs");
const CH = join(OUT, "chapters");

const taxonomy = JSON.parse(readFileSync(TAX, "utf8"));
const chapters = taxonomy.chapters;
const models = readdirSync(MODELS).filter(f=>f.endsWith(".json")).map(f=>JSON.parse(readFileSync(join(MODELS,f),"utf8"))).sort((a,b)=>(b.quality?.overall||0)-(a.quality?.overall||0));
const byCh = {}; for (const ch of chapters) byCh[ch.id]=[]; for (const m of models) byCh[m.meta?.category]?byCh[m.meta.category].push(m):byCh["00"].push(m);

function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function stars(n){return "★".repeat(n)+"☆".repeat(5-n);}

const CSS = `:root{--c:#faf9f5;--s:#fff;--t:#1a1a1a;--b:#3d3d3a;--m:#6c6a64;--a:#905831;--h:#e6dfd8;--st:#0a0a0a;--w:#8a4b12;--g:#2d7d46;--r:12px}
@media(prefers-color-scheme:dark){:root{--c:#171512;--s:#211e1a;--t:#f5f1eb;--b:#ddd6cc;--m:#b9afa3;--a:#d59a6f;--h:#39332d;--st:#faf9f5;--w:#f0b36d;--g:#5dc97a}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}html{font-size:16px;scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;background:var(--c);color:var(--b);line-height:1.75}
a{color:var(--a);text-decoration:none}a:hover{text-decoration:underline}
.skip-link{position:absolute;top:-100px;left:16px;padding:8px 16px;background:var(--st);color:var(--c);border-radius:6px;z-index:100;font-size:.875rem}.skip-link:focus{top:16px}
header{position:sticky;top:0;z-index:50;background:rgba(250,249,245,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--h);padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between}
@media(prefers-color-scheme:dark){header{background:rgba(23,21,18,.88)}}header .logo{font-weight:700;font-size:1.05rem;color:var(--t)}header nav{display:flex;gap:20px}header nav a{font-size:.875rem;color:var(--m);font-weight:500}header nav a:hover{color:var(--a)}
.breadcrumb{font-size:.8rem;color:var(--m);padding:16px 24px 0;max-width:900px;margin:0 auto}.breadcrumb a{color:var(--m)}.breadcrumb span{color:var(--a)}
main{max-width:900px;margin:0 auto;padding:24px 24px 64px}h1{font-size:2rem;color:var(--t);margin-bottom:8px}.chapter-desc{color:var(--m);margin-bottom:24px}
.sub-tags{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:28px}.sub-tag{padding:4px 14px;border-radius:999px;font-size:.8rem;font-weight:500;background:rgba(144,88,49,.08);color:var(--a)}
.model-card{background:var(--s);border:1px solid var(--h);border-radius:var(--r);padding:28px;margin-bottom:20px}
.model-card h2{font-size:1.15rem;margin:0 0 4px;color:var(--t)}.model-meta{font-size:.75rem;color:var(--m);margin-bottom:14px}
.model-label{font-size:.68rem;font-weight:700;letter-spacing:.05em;color:var(--a);margin:16px 0 6px;text-transform:uppercase}
.model-value{font-size:.9rem;line-height:1.8;color:var(--b)}.model-value li{margin-bottom:6px;margin-left:20px}
.protocol-step{background:var(--c);border:1px solid var(--h);border-radius:8px;padding:12px 16px;margin-bottom:8px}
.protocol-step .step-num{font-size:.7rem;font-weight:700;color:var(--a);margin-bottom:2px}
.protocol-step .step-act{font-size:.85rem;color:var(--b);line-height:1.6}
.codex-block{background:var(--c);border:1px solid var(--h);border-radius:8px;padding:14px 18px;font-size:.82rem;color:var(--m);line-height:1.6;margin-top:8px;font-family:SF Mono,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.codex-card{background:var(--c);border:1px solid var(--a);border-radius:10px;padding:0;margin-top:8px;overflow:hidden}
.codex-card-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--h);gap:8px}
.codex-card-title{font-size:.72rem;font-weight:700;letter-spacing:.06em;color:var(--a);text-transform:uppercase;flex:1}
.codex-copy-btn{font-size:.72rem;font-weight:600;padding:4px 12px;border-radius:6px;border:1px solid var(--a);background:transparent;color:var(--a);cursor:pointer;transition:background .12s,color .12s;white-space:nowrap;min-width:64px;text-align:center}
.codex-copy-btn:hover{background:var(--a);color:var(--s)}
.codex-copy-btn.copied{background:var(--g);border-color:var(--g);color:#fff}
.codex-activation{padding:8px 14px;font-size:.8rem;color:var(--b);border-bottom:1px solid var(--h);line-height:1.5}
.codex-activation strong{color:var(--m);font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;margin-right:6px}
.codex-sp{padding:12px 14px;font-size:.78rem;color:var(--m);line-height:1.65;font-family:SF Mono,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:hidden;position:relative;transition:max-height .2s ease}
.codex-sp.expanded{max-height:2000px}
.codex-sp::after{content:'';position:absolute;bottom:0;left:0;right:0;height:40px;background:linear-gradient(transparent,var(--c));pointer-events:none;transition:opacity .2s}
.codex-sp.expanded::after{opacity:0}
.codex-toggle{width:100%;padding:7px;font-size:.72rem;color:var(--m);background:transparent;border:none;border-top:1px solid var(--h);cursor:pointer;text-align:center;transition:color .1s}
.codex-toggle:hover{color:var(--a)}
.stars{color:var(--w);font-size:.7rem;margin-left:6px}.tags-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.tag-chip{font-size:.65rem;padding:2px 8px;border-radius:999px;background:rgba(144,88,49,.06);color:var(--a)}
.hero{text-align:center;padding:48px 24px;position:relative;overflow:hidden}.hero::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,rgba(144,88,49,.1) 0%,transparent 70%);z-index:0}.hero>*{position:relative;z-index:1}
.ch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;padding:0 24px;max-width:1100px;margin:0 auto 48px}.ch-card{background:var(--s);border:1px solid var(--h);border-radius:var(--r);padding:22px;transition:border-color .15s,transform .15s;display:block;text-decoration:none}.ch-card:hover{border-color:var(--a);transform:translateY(-2px);text-decoration:none}.ch-num{font-size:.7rem;font-weight:700;color:var(--a);margin-bottom:8px}.ch-card h3{font-size:1rem;color:var(--t);margin:0 0 6px}.ch-card .desc{font-size:.8rem;color:var(--m);line-height:1.5;margin-bottom:8px}.ch-card .cnt{font-size:.7rem;color:var(--g);font-weight:600;padding:2px 8px;background:rgba(45,125,70,.08);border-radius:999px;display:inline-block}
.nav-row{display:flex;justify-content:space-between;margin-top:48px;padding-top:24px;border-top:1px solid var(--h)}.nav-row a{font-weight:600}
footer{border-top:1px solid var(--h);padding:32px 24px;text-align:center;color:var(--m);font-size:.8rem}footer a{font-weight:500}
.sidebar{position:fixed;left:0;top:56px;width:260px;height:calc(100vh - 56px);overflow-y:auto;background:var(--s);border-right:1px solid var(--h);padding:16px;z-index:40;font-size:.82rem;line-height:1.8}.sidebar h3{font-size:.75rem;color:var(--a);margin-bottom:8px;letter-spacing:.05em;font-weight:700}.sidebar a{display:block;color:var(--b);padding:3px 8px;border-radius:4px;text-decoration:none;transition:background .1s}.sidebar a:hover{background:var(--h);text-decoration:none}@media(max-width:1100px){.sidebar{display:none}}main.with-sidebar{margin-left:280px;max-width:860px}@media(max-width:768px){header nav{display:none}main{padding:16px}.ch-grid{grid-template-columns:1fr}.model-card{padding:20px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}@media print{header,.nav-row,footer{display:none}}`;

if (!existsSync(OUT)) mkdirSync(OUT,{recursive:true});
if (!existsSync(CH)) mkdirSync(CH,{recursive:true});
writeFileSync(join(OUT,"style.css"),CSS,"utf8");

// Index
let cards="";for(const ch of chapters){const n=(byCh[ch.id]||[]).length;cards+=`<a href="chapters/ch${ch.id}-${ch.slug}.html" class="ch-card"><div class="ch-num">Ch.${ch.id}</div><h3>${ch.title}</h3><div class="desc">${ch.description}</div><span class="cnt">${n}个</span></a>`;}
const total=chapters.reduce((s,ch)=>s+(byCh[ch.id]||[]).length,0);
writeFileSync(join(OUT,"index.html"),`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>系统化思维 — ${total}个模型</title><link rel="stylesheet" href="style.css"></head><body><a href="#main" class="skip-link">跳至正文</a><header><span class="logo"><a href="index.html" style="color:var(--t);text-decoration:none">系统化思维</a></span><nav><a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a></nav></header><main id="main" class="with-sidebar"><div class="hero"><h1>把复杂问题，看成可以理解、选择与行动的系统</h1><p style="color:var(--m);max-width:560px;margin:8px auto 0">${chapters.length}章 · ${total}个推理引擎 · 每个含Codex可执行协议</p></div><div class="ch-grid">${cards}</div></main><footer><p><strong>系统化思维</strong> &copy; 2026 · <a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a></p></footer></body></html>`,"utf8");
console.log(`✓ index.html`);

// Chapters
for(const ch of chapters){const arts=byCh[ch.id]||[];const subs=(ch.subchapters||[]).map(s=>`<span class="sub-tag">${s.title}</span>`).join("");let html="";let sb="<div class=sidebar><h3>本章模型</h3>";for(const a of arts){const aid="m-"+(a.id||(a.meta?.name||"").replace(/[\s/\\:：]/g,"-").slice(0,30));sb+="<a href=#"+aid+">"+esc((a.meta?.name||"").slice(0,22))+"</a>";}sb+="</div>";html+=sb;
for(const a of arts){
let h='';
const q=a.quality||{};
h+=`<article class="model-card" id="${"m-"+a.id||""}"><h2>${esc(a.meta?.name||"")}<span class="stars">${stars(Math.min(q.overall||0,5))}</span></h2>`;
if(a.core_definition)h+=`<div class="v3-def">${esc(a.core_definition)}</div>`;
const wtu=a.when_to_use||{};
if(wtu.triggers?.length)h+=`<div class="model-label">触发信号</div><div class="model-value"><ul>${wtu.triggers.map(s=>`<li>${esc(s)}</li>`).join("")}</ul></div>`;
if(wtu.anti_triggers?.length)h+=`<div class="model-label">不应使用</div><div class="model-value"><ul>${wtu.anti_triggers.map(s=>`<li>${esc(s)}</li>`).join("")}</ul></div>`;
const ba=a.before_after||{};
if(ba.without_model)h+=`<div class="model-label">没这个模型之前</div><div class="model-value"><p>${esc(ba.without_model)}</p></div>`;
if(ba.with_model)h+=`<div class="model-label">用了这个模型之后</div><div class="model-value"><p>${esc(ba.with_model)}</p></div>`;
const steps=a.reasoning_steps||[];
if(steps.length){h+=`<div class="model-label">推理步骤</div>`;
for(const s of steps){h+=`<div class="protocol-step"><div class="step-num">Step ${s.step}</div><div class="step-act">${esc(s.action||"")}</div>${s.checkpoint?`<div class="step-ck">检查点: ${esc(s.checkpoint)}</div>`:''}</div>`;}}
const sc=a.scenarios||{};
const domains=Object.keys(sc);
if(domains.length){h+=`<div class="model-label">场景示例</div>`;
for(const d of domains){const s=sc[d];h+=`<div class="scenario-item"><strong>${esc(d)}</strong>: ${esc(s.situation||"")}<br><span class="sc-app">${esc(s.application||"")}</span></div>`;}}
const ci=a.codex_integration||{};
if(ci.activation||ci.system_prompt){
  const spId="sp-"+Math.random().toString(36).slice(2,8);
  let cc=`<div class="model-label">Codex 应用卡</div><div class="codex-card">`;
  cc+=`<div class="codex-card-head"><span class="codex-card-title">可直接粘贴到 Codex 对话</span>`;
  if(ci.system_prompt)cc+=`<button class="codex-copy-btn" data-copy="${esc(ci.system_prompt)}" onclick="doCopy(this)" aria-label="复制系统提示词">复制</button>`;
  cc+=`</div>`;
  if(ci.activation)cc+=`<div class="codex-activation"><strong>激活词</strong>${esc(ci.activation)}</div>`;
  if(ci.system_prompt){
    cc+=`<div class="codex-sp" id="${spId}">${esc(ci.system_prompt)}</div>`;
    cc+=`<button class="codex-toggle" onclick="toggleSp('${spId}',this)">展开完整提示词 ▾</button>`;
  }
  cc+=`</div>`;
  h+=cc;
}
if(a.pitfalls?.length)h+=`<div class="model-label">常见误区</div><div class="model-value"><ul>${a.pitfalls.map(p=>`<li>${esc(p)}</li>`).join("")}</ul></div>`;
if(a.meta?.tags?.length)h+=`<div class="tags-row">${a.meta.tags.map(t=>`<span class="tag-chip">${esc(t)}</span>`).join("")}</div>`;
h+=`</article>`;
html+=h;}const idx=chapters.findIndex(c=>c.id===ch.id);const prev=idx>0?chapters[idx-1]:null,next=idx<chapters.length-1?chapters[idx+1]:null;let nav='<div class="nav-row">';nav+=prev?`<a href="ch${prev.id}-${prev.slug}.html">← Ch.${prev.id} ${prev.title}</a>`:"<span></span>";nav+=next?`<a href="ch${next.id}-${next.slug}.html">Ch.${next.id} ${next.title} →</a>`:"<span></span>";nav+='</div>';
const COPY_JS = `<script>
function doCopy(btn){
  const txt = btn.getAttribute('data-copy');
  if(!txt) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(()=>flash(btn)).catch(()=>fallback(btn,txt));
  } else { fallback(btn,txt); }
}
function fallback(btn,txt){
  const ta=document.createElement('textarea');
  ta.value=txt; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); flash(btn); } catch(e){}
  document.body.removeChild(ta);
}
function flash(btn){
  btn.textContent='已复制'; btn.classList.add('copied');
  setTimeout(()=>{ btn.textContent='复制'; btn.classList.remove('copied'); }, 2000);
}
function toggleSp(id,btn){
  const el=document.getElementById(id);
  if(!el) return;
  const exp=el.classList.toggle('expanded');
  btn.textContent=exp?'收起 ▴':'展开完整提示词 ▾';
}
</script>`;

writeFileSync(join(CH,`ch${ch.id}-${ch.slug}.html`),`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Ch.${ch.id} ${ch.title}</title><link rel="stylesheet" href="../style.css"></head><body><a href="#main" class="skip-link">跳至正文</a><header><span class="logo"><a href="../index.html" style="color:var(--t);text-decoration:none">系统化思维</a></span><nav><a href="../index.html">章节</a><a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a></nav></header><div class="breadcrumb"><a href="../index.html">首页</a> / <span>Ch.${ch.id} ${ch.title}</span></div><main id="main"><h1>Ch.${ch.id} ${ch.title}</h1><p class="chapter-desc">${ch.description} · ${arts.length}个模型</p><div class="sub-tags">${subs}</div>${html}${nav}</main><footer><p><strong>系统化思维</strong> &copy; 2026 · <a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a></p></footer>${COPY_JS}</body></html>`,"utf8");console.log(`✓ ch${ch.id} (${arts.length})`);}

// Write site/index.html (single-file release artifact, mirrors docs/index.html)
const SITE = join(ROOT, "site");
if (!existsSync(SITE)) mkdirSync(SITE, {recursive:true});
const docsIndex = readFileSync(join(OUT,"index.html"),"utf8");
writeFileSync(join(SITE,"index.html"), docsIndex, "utf8");
console.log("\n✅ 完成 → docs/ + site/index.html");
