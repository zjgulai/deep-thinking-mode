#!/usr/bin/env python3
"""P1: 速查卡独立蒸馏引擎"""
import os, json, re

data_dir = 'data/'
v2_dir   = 'knowledge/models-v2/'
v3_dir   = 'knowledge/models-v3/'
tax_path = 'knowledge/taxonomy.json'

taxonomy = json.load(open(tax_path))
chapters = taxonomy['chapters']

# 已蒸馏 V2 source 集合
v2_sources = set()
for f in os.listdir(v2_dir):
    d = json.load(open(v2_dir+f))
    src = d.get('meta',{}).get('source','')
    if src: v2_sources.add(src)

def clean_speedcard(raw):
    t = raw
    t = re.sub(r'<[^>]+>',' ',t)
    t = re.sub(r'!\[[^\]]*\]\([^)]*\)','',t)
    t = re.sub(r'https?://\S+','',t)
    t = re.sub(r'^\s*(原创|>|阅读|赞|分享|推荐|留言|在看|正方形SQUARE).*$','',t,flags=re.M)
    t = re.sub(r'图\d+\s*','',t)
    t = re.sub(r'\*\{[^}]+\}','',t)
    t = re.sub(r'\n{3,}','\n\n',t)
    return t.strip()

def extract_model(fname, text):
    m = {
        'name':'','core_question':'','trigger_signals':[],
        'stop_conditions':[],'reasoning_protocol':[],
        'decision_points':[],'example_trace':'','tags':[]
    }
    lines = text.split('\n')
    
    # 模型名
    raw_name = fname.replace('.md','')
    name = re.sub(r'速查卡|清单|速查手册|速查|_\d+步?|急救|对比|自检|快速', '', raw_name)
    name = re.sub(r'^_|_$|_{2,}','_',name).strip('_')
    if len(name) > 20:
        p = re.split(r'[_：:]', name)
        name = p[0][:20] if p else name[:20]
    m['name'] = name
    
    # 分隔线后正文
    sep_idx = next((i for i,l in enumerate(lines) if re.match(r'^={3,}',l)), len(lines)//3)
    body_lines = lines[sep_idx+1:]
    body = '\n'.join(body_lines)
    body = re.sub(r'^\s*(原创|>|阅读|赞|分享|推荐|留言|正方形SQUARE|图\d+).*$','',body,flags=re.M)
    body = re.sub(r'https?://\S+','',body)
    body = re.sub(r'\s+',' ',body).strip()
    
    # core_question
    sents = [s.strip() for s in re.split(r'[。！？\n]',body) if 12<=len(s.strip())<=150]
    if sents:
        m['core_question'] = sents[0][:150]
    
    # 步骤提取（多模式）
    steps_m3 = re.findall(r'第[一二三四五六七八九十\d]+步[：:]?\s*(.{8,80})', body)
    steps_m2 = re.findall(r'(?:[①②③④⑤⑥⑦⑧⑨⑩\d][\.、\s])(.{10,80})', body)
    steps_m1 = re.findall(r'([\u4e00-\u9fa5a-zA-Z]{2,12}(?:式|型|法|步|级|层|维|项|条|个|阶段)[^\n，。！？]{5,60})', body)
    
    all_steps = []
    seen = set()
    for s in (steps_m3 or []) + (steps_m2 or []) + (steps_m1 or []):
        s = s.strip()[:100]
        key = s[:20]
        if key not in seen and len(s)>8 and not re.search(r'http|mmbiz|qpic|font-size|margin',s):
            seen.add(key)
            all_steps.append(s)
        if len(all_steps) >= 6: break
    
    m['reasoning_protocol'] = [
        {'step':i+1,'name':s[:20],'action':s[:120],
         'thinking_question':'','expected_output':'','pitfall':''}
        for i,s in enumerate(all_steps)
    ]
    
    # triggers
    triggers = []
    for kw, trig in [('急救','遇到紧急情绪/场景，需要快速操作指引时'),
                     ('自检','需要系统检验自己的思维或行为时'),
                     ('对比','需要快速区分两个相近概念时')]:
        if kw in fname:
            triggers.append(trig)
    pats = re.findall(r'(?:遇到|面对|当你|适用于)[^\n，。]{10,60}', body)
    triggers.extend([t.strip()[:80] for t in pats[:2]])
    if not triggers:
        triggers.append('需要快速查阅「'+name[:12]+'」的核心操作步骤时')
    m['trigger_signals'] = triggers[:3]
    
    # tags
    tags_raw = re.findall(r'#([^\s#]{2,12})', text)
    m['tags'] = list(set(tags_raw))[:5]
    
    return m

def classify(text, fname):
    c = (fname + ' ' + text[:800]).lower()
    scores = []
    for ch in chapters:
        sc = sum(1 for t in ch['allowed_tags'] if t.lower() in c)
        sc += sum(3 for sub in ch.get('subchapters',[]) if sub['title'].lower() in c)
        if sc > 0: scores.append((ch['id'], sc))
    scores.sort(key=lambda x:-x[1])
    return scores[0][0] if scores else '00'

def build_prompt(mdl):
    if not mdl['reasoning_protocol']:
        return None
    steps = '\n\n'.join(
        'Step {} - {}：{}'.format(s['step'], s['name'], s['action'])
        for s in mdl['reasoning_protocol']
    )
    name = mdl['name']
    return (
        '你现在以「{}」速查模式运行。\n\n'
        '【认知模式】快速调用{}的核心操作框架，直接给出可执行的指引。\n\n'
        '【推理协议】\n{}\n\n'
        '【质量门禁】输出必须可立即执行，不输出模糊建议。\n\n'
        '【输出格式】按步骤直接给出操作指引，每步一句话，可选配简短说明。'
    ).format(name[:12], name[:15], steps)

# 执行蒸馏
speedcard_files = [f for f in os.listdir(data_dir)
                   if ('速查卡' in f or ('速查' in f and '速查手册' not in f) or '清单' in f)
                   and ' 2.' not in f and 'AGENTS' not in f]

created = 0
skipped = 0

for fname in sorted(speedcard_files):
    if fname in v2_sources:
        skipped += 1
        continue
    
    raw = open(data_dir+fname, errors='ignore').read()
    text = clean_speedcard(raw)
    if len(text) < 100:
        skipped += 1
        continue
    
    mdl = extract_model(fname, text)
    if len(mdl['reasoning_protocol']) < 2:
        skipped += 1
        continue
    
    prompt = build_prompt(mdl)
    quality = min(
        2 + (1 if len(mdl['reasoning_protocol'])>=3 else 0)
          + (1 if mdl['core_question'] else 0)
          + (1 if mdl['tags'] else 0),
        5
    )
    ch = classify(text, fname)
    
    fid = fname.replace('.md','').lower()
    fid = re.sub(r'[^a-z0-9\u4e00-\u9fa5_-]','-',fid).replace('--','-').strip('-')[:50]
    
    fallback = '请用{}速查表给出操作步骤。'.format(mdl['name'][:15])
    activation = '请用{}速查...'.format(mdl['name'][:15])
    
    out = {
        'schema_version': '2.0.0',
        'id': fid,
        'meta': {
            'name': mdl['name'],
            'category': ch,
            'tags': mdl['tags'],
            'source': fname,
            'sourceTitle': fname.replace('.md','')
        },
        'engine': {
            'core_question': mdl['core_question'],
            'trigger_signals': mdl['trigger_signals'],
            'stop_conditions': [],
            'reasoning_protocol': mdl['reasoning_protocol'],
            'decision_points': [],
            'output_format': {'structure':'','example':''}
        },
        'codex': {
            'system_prompt': prompt if prompt else fallback,
            'activation_phrase': activation,
            'fallback': ''
        },
        'quality': {
            'reasoning_completeness': quality,
            'example_coverage': 0,
            'prompt_effectiveness': 3,
            'overall': quality
        }
    }
    
    with open(os.path.join(v2_dir, fid+'.json'), 'w') as fw:
        json.dump(out, fw, ensure_ascii=False, indent=2)
    
    v2_sources.add(fname)
    created += 1

print('速查卡蒸馏完成: 创建 {} 个 V2 模型'.format(created))
print('跳过（已有/步骤不足）: {}'.format(skipped))
print('V2 总数:', len(os.listdir(v2_dir)))
