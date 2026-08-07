#!/usr/bin/env python3
"""Fix truncation in all distillation scripts: add semantic boundary slicing"""
import re

def smart_slice(text, max_len):
    if len(text) <= max_len: return text
    endings = ['。','！','？','\n','；','，','、','」']
    for i in range(max_len - 1, max_len // 2, -1):
        if text[i] in endings: return text[:i+1]
    return text[:max_len]

INSERT = '''
// ─── 语义边界截断（不在中文中间切断） ──────────────────
function smartSlice(text, maxLen) {
  if (text.length <= maxLen) return text;
  const endings = ["。","！","？","\\n","；","，","、","」"];
  for (let i = maxLen - 1; i > Math.floor(maxLen * 0.5); i--) {
    if (endings.includes(text[i])) return text.slice(0, i + 1);
  }
  return text.slice(0, maxLen);
}
'''

# Fix 1: distill-fullchain.mjs
with open('tools/distill-fullchain.mjs') as f: c = f.read()

old1 = 'return s[0]?.id || "00";\n}'
if INSERT not in c:
    c = c.replace(old1, old1 + INSERT)

old2 = 'const name = ci > 1 && ci <= 10 ? label.slice(0, ci).slice(0, 10) : label.slice(0, 10);'
new2 = 'const name = ci > 1 && ci <= 12 ? label.slice(0, ci) : smartSlice(label, 15);'
c = c.replace(old2, new2)

old3 = 'const action = ci > 1 && ci <= 10 ? label.slice(ci + 1).trim().slice(0, 100) : label.slice(0, 100);'
new3 = 'const action = ci > 1 && ci <= 12 ? smartSlice(label.slice(ci + 1).trim(), 120) : smartSlice(label, 120);'
c = c.replace(old3, new3)

with open('tools/distill-fullchain.mjs', 'w') as f: f.write(c)
print('Fixed distill-fullchain.mjs')

# Fix 2: distill-phase-c.mjs  
try:
    with open('tools/distill-phase-c.mjs') as f: c2 = f.read()
    
    if INSERT not in c2:
        pos = c2.find('function parseSteps')
        if pos > 0: c2 = c2[:pos] + INSERT + c2[pos:]
    
    c2 = c2.replace("text.slice(0, 100)", "smartSlice(text, 120)")
    c2 = c2.replace("text.slice(0, 12)", "text.length > 15 ? smartSlice(text, 15) : text")
    
    with open('tools/distill-phase-c.mjs', 'w') as f: f.write(c2)
    print('Fixed distill-phase-c.mjs')
except Exception as e: print(f'Phase-C fix: {e}')

# Fix 3: tools/distill.mjs (original v3)
try:
    with open('tools/distill.mjs') as f: c3 = f.read()
    
    if INSERT not in c3:
        pos = c3.find('function buildPrompt')
        if pos > 0: c3 = c3[:pos] + INSERT + c3[pos:]
    
    c3 = c3.replace("shortName.slice(0, 10)", "shortName.length > 15 ? smartSlice(shortName, 15) : shortName")
    c3 = c3.replace("actionText.slice(0, 120)", "smartSlice(actionText, 120)")
    
    with open('tools/distill.mjs', 'w') as f: f.write(c3)
    print('Fixed tools/distill.mjs')
except Exception as e: print(f'distill.mjs: {e}')

print('\nAll fixes applied.')
