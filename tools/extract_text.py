#!/usr/bin/env python3
"""extract_text.py — 从EPUB/PPTX/XLSX中提取纯文本（仅用内置zipfile）"""
import zipfile, re, sys, os

def extract_epub(path):
    z = zipfile.ZipFile(path)
    chapters = []
    for name in sorted(z.namelist()):
        if name.endswith(('.xhtml', '.html', '.htm')):
            content = z.read(name).decode('utf-8', 'ignore')
            content = re.sub(r'<style[^>]*>[\s\S]*?</style>', '', content)
            content = re.sub(r'<script[^>]*>[\s\S]*?</script>', '', content)
            content = re.sub(r'<[^>]+>', ' ', content)
            content = re.sub(r'\s+', ' ', content).strip()
            if len(content) > 100:
                chapters.append(content)
    return '\n---\n'.join(chapters)

def extract_pptx(path):
    z = zipfile.ZipFile(path)
    lines = []
    for name in sorted(z.namelist()):
        if 'slide' in name and name.endswith('.xml'):
            content = z.read(name).decode('utf-8', 'ignore')
            parts = re.findall(r'<a:t[^>]*>([^<]+)</a:t>', content)
            if parts:
                lines.append(' '.join(parts))
    return '\n'.join(lines)

def extract_xlsx(path):
    z = zipfile.ZipFile(path)
    # Parse shared strings
    strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        content = z.read('xl/sharedStrings.xml').decode('utf-8', 'ignore')
        strings = re.findall(r'<t[^>]*>([^<]*)</t>', content)
    
    rows = []
    for name in sorted(z.namelist()):
        if 'sheet' in name and name.endswith('.xml'):
            content = z.read(name).decode('utf-8', 'ignore')
            # Find rows
            row_pattern = re.findall(r'<row[^>]*>(.*?)</row>', content, re.DOTALL)
            for rp in row_pattern:
                cells = re.findall(r'<c[^>]*>.*?<v>(\d+)</v>.*?</c>', rp)
                row_text = ' | '.join([strings[int(c)] if int(c) < len(strings) else c for c in cells])
                if row_text.strip():
                    rows.append(row_text)
    return '\n'.join(rows)

if __name__ == '__main__':
    path = sys.argv[1]
    ext = os.path.splitext(path)[1].lower()
    
    if ext == '.epub':
        print(extract_epub(path))
    elif ext == '.pptx':
        print(extract_pptx(path))
    elif ext == '.xlsx':
        print(extract_xlsx(path))
    else:
        print(f'[不支持格式: {ext}]')
