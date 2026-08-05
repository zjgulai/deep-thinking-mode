#!/usr/bin/env python3
"""Update build-site.mjs to render V3 schema cards"""
import re

with open('tools/build-site.mjs') as f:
    content = f.read()

# Find the model card rendering section (between "let html=" and "const idx=")
# We'll replace the loop body
old_marker = "for(const a of arts){const eng=a.engine||{};"
new_line = '''for(const a of arts){
let h='';
const q=a.quality||{};
h+=`<article class="model-card"><h2>${esc(a.meta?.name||"")}<span class="stars">${stars(Math.min(q.overall||0,5))}</span></h2>`;
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
if(ci.activation)h+=`<div class="model-label">Codex 激活词</div><div class="codex-block">${esc(ci.activation)}</div>`;
if(ci.system_prompt)h+=`<div class="model-label">Codex 系统提示词</div><div class="codex-block">${esc(ci.system_prompt.slice(0,700))}${ci.system_prompt.length>700?'...':''}</div>`;
if(a.pitfalls?.length)h+=`<div class="model-label">常见误区</div><div class="model-value"><ul>${a.pitfalls.map(p=>`<li>${esc(p)}</li>`).join("")}</ul></div>`;
if(a.meta?.tags?.length)h+=`<div class="tags-row">${a.meta.tags.map(t=>`<span class="tag-chip">${esc(t)}</span>`).join("")}</div>`;
h+=`</article>`;
html+=h;}'''

# Replace from "for(const a of arts){...}" to "html+=`</article>`;}"
start = content.find('for(const a of arts){const eng=a.engine||{};')
end = content.find('const idx=chapters.findIndex')
if start > 0 and end > start:
    content = content[:start] + new_line + content[end:]
    with open('tools/build-site.mjs', 'w') as f:
        f.write(content)
    print('V3 rendering applied successfully')
else:
    print(f'Could not find insertion point: start={start}, end={end}')
