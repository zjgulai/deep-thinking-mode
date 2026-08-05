#!/usr/bin/env python3
"""Add sidebar navigation and anchor links to build-site.mjs"""
import re

with open('tools/build-site.mjs') as f:
    c = f.read()

# 1. Add sidebar CSS
sidebar_css = '''
.sidebar{position:fixed;left:0;top:56px;width:260px;height:calc(100vh - 56px);overflow-y:auto;background:var(--s);border-right:1px solid var(--h);padding:16px;z-index:40;font-size:.82rem;line-height:1.8}
.sidebar h3{font-size:.75rem;color:var(--a);margin-bottom:8px;letter-spacing:.05em;font-weight:700}
.sidebar a{display:block;color:var(--b);padding:3px 8px;border-radius:4px;text-decoration:none;transition:background .1s}
.sidebar a:hover{background:var(--h);text-decoration:none}
@media(max-width:1100px){.sidebar{display:none}}
main.with-sidebar{margin-left:280px;max-width:860px}
'''
css_end = c.find('}@media(max-width:768px)')
c = c[:css_end+1] + sidebar_css + c[css_end+1:]

# 2. Generate sidebar HTML in the chapter loop
old_line_tpl = "for(const ch of chapters){const arts=byCh[ch.id]||[];const subs=(ch.subchapters||[]).map(s=>`"
# Actually, let's just find and replace at the right spot
# Find "let html=\\\"" right after the chapter loop starts
idx = c.find('let html="";')
if idx > 0:
    sidebar_code = 'let sb="<div class=\\"sidebar\\"><h3>本章模型</h3>";for(const a of arts){const aid="m-"+(a.id||(a.meta?.name||"").replace(/[\\s/\\\\:：]/g,"-").slice(0,30));sb+="<a href=\\"#"+aid+"\\">"+esc((a.meta?.name||"").slice(0,22))+"</a>";}sb+="</div>";html+=sb;'
    c = c[:idx] + sidebar_code + c[idx:]

# 3. Add anchor IDs to model cards
c = c.replace('<article class="model-card">', '<article class="model-card" id="${"m-"+a.id||""}">')

# 4. main gets with-sidebar class
c = c.replace('<main id="main">', '<main id="main" class="with-sidebar">')

with open('tools/build-site.mjs', 'w') as f:
    f.write(c)

print('Sidebar + anchors applied')
