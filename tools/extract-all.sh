#!/bin/bash
# extract-all.sh — 全格式批量提取 (EPUB/PDF/MOBI/PPTX/XLSX)
set -e
REF="ref"
OUT="ref-extracted"
mkdir -p "$OUT"

echo "📚 批量文本提取"
echo "---"
for f in "$REF"/*; do
  ext="${f##*.}"
  base=$(basename "$f" | sed 's/\.[^.]*$/.txt/' | sed 's/[\/:*?"<>|]/_/g')
  out="$OUT/$base"
  
  case "$ext" in
    epub)  python3 tools/extract_text.py "$f" > "$out" 2>/dev/null ;;
    pdf)   pdftotext -layout "$f" "$out" 2>/dev/null ;;
    mobi)  python3 -c "
import re, os
data = open('$f','rb').read()
text = data.decode('latin-1','ignore')
parts = re.findall(r'<html.*?</html>', text, re.DOTALL|re.I)
if not parts: parts = re.findall(r'[\u4e00-\u9fff\u3000-\u303f\w\s]{50,}', text)
open('$out','w',encoding='utf-8').write('\n'.join(parts[:100]))" 2>/dev/null ;;
    pptx|xlsx) python3 tools/extract_text.py "$f" > "$out" 2>/dev/null ;;
  esac
  
  size=$(wc -c < "$out" 2>/dev/null || echo 0)
  if [ "$size" -gt 500 ]; then
    echo "  ✅ ${base:0:55} → $(($size/1024))KB"
  else
    echo "  ⚠️ ${base:0:55} → ${size}B"
  fi
done

total=$(cat "$OUT"/*.txt 2>/dev/null | wc -c)
echo "---"
echo "总计: $(($total/1024/1024))MB 文本"
