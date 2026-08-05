#!/usr/bin/env python3
"""模型变体去重：同名不同文件，保留最高质量版本"""
import json, os

d = 'knowledge/models-v2'
files = os.listdir(d)

variants = {}
for f in files:
    if not f.endswith('.json'): continue
    try:
        m = json.load(open(f'{d}/{f}'))
        name = m.get('meta',{}).get('name','')
        if not name: continue
        norm = name.lower().replace(' ','').replace('-','').replace('_','')
        variants.setdefault(norm, []).append((f, m['quality']['overall']))
    except: pass

dups = {k:v for k,v in variants.items() if len(v) > 1}
print(f'文件数: {len(files)} → 唯一模型: {len(variants)} → 有变体: {len(dups)}组')

removed = 0
for norm, versions in dups.items():
    versions.sort(key=lambda x: -x[1])
    best = versions[0][0]
    for v in versions[1:]:
        if os.path.exists(f'{d}/{v[0]}'):
            os.remove(f'{d}/{v[0]}')
            removed += 1
            if removed <= 12:
                print(f'  - {v[0][:45]} (Q{v[1]}) 保留 {best[:30]} (Q{versions[0][1]})')

print(f'\n删除: {removed} | 剩余: {len(os.listdir(d))} 个模型')
