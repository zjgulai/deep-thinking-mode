#!/usr/bin/env python3
"""Phase B 最终版：去噪 + 变体合并 + 输出清单"""
import json, re

raw = json.load(open('model-inventory.json'))

# 更强的去噪
NOISE = {
    '概念','含义','内容','参考','书目','目录','工具','应用','实例','案例',
    '前言','序言','导论','引言','结语','后记','附录','索引','摘要','概述',
    '本书','本章','这章','这部','这篇','这个','这些','这种','一种','什么','怎样',
    '原创','收录','话题','标签','作者','编者','出版社','版权',
    '第一','第二','第三','第四','第五','首先','其次','然后','最后',
    '主要','基本','核心','常见','相关','其他','以下','以上','左右',
    '模型一','模型二','模型三','方法一','方法二','方法三',
    '是思维','个思维','种思维','的思维','思维模','mobi','epub','pdf',
    '像高手','万物皆','运营必备','收录于','老范模型','为大家提供','的30种',
    '产生','发展','系列','套装','书籍','册','本','篇','章','节',
    '（二）','（一）','（三）','（四）','（5）','（4）','（3）','（2）','（1）',
    '1.','2.','3.','4.','5.','6.','七','八','九','十',
    '思考','问题','解决','方式','途径','手段','策略','技巧','窍门',
    '定义','剖析','解读','解析','详解','全面','深入','透彻','完整',
    '理论','实践','实战','指南','手册','宝典','全书','全集','大全',
}

# 变体归并规则
MERGE = {
    'SWOT':'SWOT分析','swot':'SWOT分析','SWOT分析法':'SWOT分析',
    'SWOT模型':'SWOT分析','SWOT分析模型':'SWOT分析','SWOT 分析':'SWOT分析',
    'PEST':'PEST分析','PEST模型':'PEST分析','PEST分析法':'PEST分析',
    '波特五力':'波特五力模型','五力模型':'波特五力模型','五力分析':'波特五力模型',
    '波力五力分析':'波特五力模型','波特':'波特五力模型',
    'MECE法则':'MECE原则','MECE原则/法则':'MECE原则',
    'BCG矩阵':'波士顿矩阵','波士顿':'波士顿矩阵',
    '逻辑思维模型':'逻辑思维','水平思维模型':'水平思维',
    '金字塔表达法':'金字塔原理','金字塔结构':'金字塔原理',
    '80/20':'帕累托法则','8020':'帕累托法则','二八':'帕累托法则',
    '番茄钟':'番茄工作法','番茄时间':'番茄工作法',
    '头脑风暴法':'头脑风暴','脑力激荡':'头脑风暴',
    '福格模型':'福格行为模型','福格':'福格行为模型',
    'SMART':'SMART原则','锚定':'锚定效应',
    '确认偏见':'确认偏误','从众':'从众效应',
    '价值链':'价值链分析','价值链模型':'价值链分析',
    '蝴蝶':'蝴蝶效应','黑天鹅事件':'黑天鹅','灰犀牛事件':'灰犀牛',
}

def is_noise(name):
    if len(name) < 3 or len(name) > 30: return True
    if not re.search(r'[\u4e00-\u9fff]', name): return True
    if re.match(r'^[\d\.\s\-\(\)（）]+$', name): return True
    if re.search(r'^\d+[\.\)）]', name): return True
    for stop in NOISE:
        if stop in name: return True
    return False

def simple_norm(s):
    return s.strip().replace(' ','').replace('（','(').replace('）',')').lower()

# 过滤+归并
result = {}
for m in raw:
    name = m['displayName'].strip()
    if is_noise(name): continue
    
    # 变体映射
    norm = simple_norm(name)
    if norm in MERGE:
        name = MERGE[norm]
    
    key = simple_norm(name)
    if key in result:
        r = result[key]
        r['frequency'] += m['frequency']
        for s in m['sources']:
            if s not in r['sources']:
                r['sources'].append(s)
    else:
        result[key] = dict(m)
        result[key]['displayName'] = name

models = sorted(result.values(), key=lambda m: m['frequency'] * 2 + len(m['sources']) * 3, reverse=True)

print(f"原始 {len(raw)} → 过滤归并: {len(models)} 个\n")

new = [m for m in models if m['status'] == 'new']
part = [m for m in models if m['status'] == 'partial_match']  
exist = [m for m in models if m['status'] == 'already_exists']

print(f"🆕 新增: {len(new)} | 🔄 部分匹配: {len(part)} | ✅ 已有: {len(exist)}")
print(f"\n=== 前30 新增模型 Top30 ===")
for m in new[:30]:
    print(f"  {m['displayName']:<22s} {len(m['sources'])}源 {m['frequency']}次")

with open('model-inventory-final.json', 'w') as f:
    json.dump(models, f, ensure_ascii=False, indent=2)
print(f"\n输出: model-inventory-final.json")
