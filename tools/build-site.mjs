#!/usr/bin/env node
/**
 * build-site.mjs — 一键构建「系统化思维」多页知识网站
 *
 * 输入: data/*.md (419篇原始文章) + knowledge/taxonomy.json (13章分类)
 * 输出: site-content/ (index.html + 13个章节页 + 共享CSS)
 *
 * 用法: node tools/build-site.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR = join(ROOT, "data");
const TAXONOMY_PATH = join(ROOT, "knowledge", "taxonomy.json");
const OUT_DIR = join(ROOT, "site-content");
const CHAPTERS_DIR = join(OUT_DIR, "chapters");

// ─── 1. 读取分类体系 ──────────────────────────────────────
const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, "utf8"));
const chapters = taxonomy.chapters;
const chapterById = Object.fromEntries(chapters.map((c) => [c.id, c]));

// 构建标签 → 章节ID 的映射
const tagToChapter = {};
for (const ch of chapters) {
  for (const tag of ch.allowed_tags) {
    const lower = tag.toLowerCase();
    if (!tagToChapter[lower]) tagToChapter[lower] = ch.id;
  }
}

// ─── 2. 辅助函数：清洗微信导出格式 ─────────────────────────
function cleanWechatMd(raw) {
  // 找到第一个 Markdown 标题行（# 开头），去掉之前所有的 CSS 垃圾
  const lines = raw.split("\n");
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // 微信文章的真实标题形式多样：以 # 或 分隔线后的文字
    if (trimmed.startsWith("# ") || trimmed.startsWith("#")) {
      startIdx = i;
      break;
    }
    // 有些文章没有 # 标题，需要找分隔线后的内容
    if (trimmed.match(/^=+$/) && i > 0 && lines[i - 1].trim().length > 5) {
      startIdx = i - 1;
      break;
    }
  }
  return lines.slice(startIdx).join("\n").trim();
}

function extractMetadata(cleaned) {
  const lines = cleaned.split("\n");
  const meta = { title: "", author: "", sourceUrl: "", isCard: false };

  // 提取标题（第一个非空行）
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("# ")) {
      meta.title = t.replace(/^#+\s*/, "");
      break;
    }
    if (t.length > 5 && !t.startsWith("=") && !t.startsWith("原创")) {
      meta.title = t;
      break;
    }
  }

  // 提取来源 URL
  for (const line of lines) {
    const m = line.match(/原文地址.*?(https?:\/\/[^\s\])]+)/);
    if (m) {
      meta.sourceUrl = m[1];
      break;
    }
    const m2 = line.match(/https?:\/\/mp\.weixin\.qq\.com[^\s\])]+/);
    if (m2) {
      meta.sourceUrl = m2[0];
      break;
    }
  }

  // 提取作者
  for (const line of lines) {
    const m = line.match(/原创\s+(\S+)/);
    if (m) {
      meta.author = m[1];
      break;
    }
  }

  return meta;
}

// ─── 3. 按标题关键词 + taxonomy tags 分类 ──────────────────
function classifyArticle(filename, title, content) {
  const combined = (filename + " " + title + " " + content.slice(0, 500)).toLowerCase();

  // 统计每个章节的标签命中数
  const scores = [];
  for (const ch of chapters) {
    let score = 0;
    for (const tag of ch.allowed_tags) {
      if (combined.includes(tag.toLowerCase())) score += 1;
    }
    // 子章节 slug 也参与匹配
    for (const sub of ch.subchapters || []) {
      if (combined.includes(sub.slug.replace(/-/g, " "))) score += 2;
    }
    if (score > 0) scores.push({ id: ch.id, score, title: ch.title });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.length > 0 ? scores[0].id : "00"; // 默认归入综合索引
}

// ─── 4. 识别速查卡与主文章 ─────────────────────────────────
function isSpeedCard(filename) {
  return filename.includes("速查卡") || filename.includes("速查");
}

// ─── 5. 主流程：读取、清洗、分类 ──────────────────────────
console.log("📖 读取原始文章...");

// 读取 data 目录
import { readdirSync } from "node:fs";
const allFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith(".md") && f !== "AGENTS.md");
console.log(`   找到 ${allFiles.length} 篇原始文章`);

const articlesByChapter = {};
for (const ch of chapters) {
  articlesByChapter[ch.id] = { main: [], cards: [] };
}

console.log("🧹 清洗 & 分类...");
let cleanedCount = 0;
for (const filename of allFiles) {
  const raw = readFileSync(join(DATA_DIR, filename), "utf8");
  const cleaned = cleanWechatMd(raw);
  const meta = extractMetadata(cleaned);
  const chapterId = classifyArticle(filename, meta.title, cleaned);

  // 去除标题行后的正文
  let body = cleaned;
  const bodyLines = body.split("\n");
  // 跳过标题和分隔线
  let bodyStart = 0;
  for (let i = 0; i < bodyLines.length; i++) {
    const t = bodyLines[i].trim();
    if ((t.startsWith("#") || t.match(/^=+$/)) && i < 5) continue;
    bodyStart = i;
    break;
  }
  body = bodyLines.slice(bodyStart).join("\n").trim();

  // 清理正文中的微信格式残留
  body = body
    .replace(/\\\*/g, "*")
    .replace(/\\_/g, "_")
    .replace(/\n{4,}/g, "\n\n\n");

  const article = {
    filename,
    title: meta.title || filename.replace(/\.md$/, ""),
    author: meta.author,
    sourceUrl: meta.sourceUrl,
    chapterId,
    chapterTitle: chapterById[chapterId]?.title || "未分类",
    body,
    wordCount: body.length,
    isCard: isSpeedCard(filename),
  };

  if (article.isCard) {
    articlesByChapter[chapterId].cards.push(article);
  } else {
    articlesByChapter[chapterId].main.push(article);
  }
  cleanedCount++;
  if (cleanedCount % 50 === 0) console.log(`   已处理 ${cleanedCount}/${allFiles.length}...`);
}
console.log(`   完成！共清洗 ${cleanedCount} 篇`);

// ─── 6. 统计输出 ──────────────────────────────────────────
console.log("\n📊 分类统计:");
for (const ch of chapters) {
  const { main, cards } = articlesByChapter[ch.id];
  console.log(`   Ch.${ch.id} ${ch.title}: ${main.length} 篇正文 + ${cards.length} 篇速查卡`);
}

// ─── 7. 生成 HTML 页面 ─────────────────────────────────────
console.log("\n🔨 生成网站页面...");

// 确保输出目录存在
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
if (!existsSync(CHAPTERS_DIR)) mkdirSync(CHAPTERS_DIR, { recursive: true });

// ── 7a. 共享 CSS ─────────────────────────────────────────
const SHARED_CSS = `/* 系统化思维 — 共享样式 */
:root {
  --canvas: #faf9f5; --surface: #ffffff; --text: #1a1a1a; --body: #3d3d3a;
  --muted: #6c6a64; --accent: #905831; --hairline: #e6dfd8; --strong: #0a0a0a;
  --warning: #8a4b12; --danger: #9f2d24; --radius-sm: 10px; --radius-lg: 24px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #171512; --surface: #211e1a; --text: #f5f1eb; --body: #ddd6cc;
    --muted: #b9afa3; --accent: #d59a6f; --hairline: #39332d; --strong: #faf9f5;
    --warning: #f0b36d; --danger: #ff9b8f;
  }
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px;scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;background:var(--canvas);color:var(--body);line-height:1.75;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none;transition:color .18s}
a:hover{text-decoration:underline}
.skip-link{position:absolute;top:-100px;left:16px;padding:8px 16px;background:var(--strong);color:var(--canvas);border-radius:6px;z-index:100;font-size:.875rem}
.skip-link:focus{top:16px}
header{position:sticky;top:0;z-index:50;background:rgba(250,249,245,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--hairline);padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between}
@media(prefers-color-scheme:dark){header{background:rgba(23,21,18,.88)}}
header .logo{font-weight:700;font-size:1.05rem;color:var(--text);letter-spacing:-.01em}
header nav{display:flex;gap:20px;align-items:center}
header nav a{font-size:.875rem;color:var(--muted);font-weight:500}
header nav a:hover{color:var(--accent);text-decoration:none}
.breadcrumb{font-size:.8rem;color:var(--muted);padding:16px 24px 0;max-width:900px;margin:0 auto}
.breadcrumb a{color:var(--muted)}
.breadcrumb span{color:var(--accent)}
main{max-width:900px;margin:0 auto;padding:24px 24px 64px}
h1{font-size:2rem;color:var(--text);letter-spacing:-.01em;margin-bottom:8px}
h2{font-size:1.4rem;color:var(--text);margin:32px 0 12px;padding-top:16px;border-top:1px solid var(--hairline)}
h3{font-size:1.15rem;color:var(--text);margin:24px 0 8px}
.chapter-desc{color:var(--muted);font-size:1rem;margin-bottom:24px}
.sub-chapters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:32px}
.sub-chapter-tag{padding:4px 14px;border-radius:999px;font-size:.8rem;font-weight:500;background:rgba(144,88,49,.08);color:var(--accent)}
.article-card{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius-sm);padding:28px;margin-bottom:20px}
.article-card h2{font-size:1.25rem;margin:0 0 8px;padding:0;border:none;color:var(--text)}
.article-card h2 a{color:var(--text)}
.article-card h2 a:hover{color:var(--accent);text-decoration:none}
.article-meta{font-size:.8rem;color:var(--muted);margin-bottom:16px;display:flex;gap:16px;flex-wrap:wrap}
.article-body{font-size:.95rem;line-height:1.85;color:var(--body)}
.article-body p{margin-bottom:14px}
.article-body h3{font-size:1.05rem;margin:24px 0 10px}
.article-body ul,.article-body ol{padding-left:20px;margin-bottom:14px}
.article-body li{margin-bottom:6px}
.article-body blockquote{border-left:3px solid var(--accent);padding:8px 16px;margin:16px 0;color:var(--muted);background:rgba(144,88,49,.04);border-radius:0 6px 6px 0}
.article-body strong{color:var(--text)}
.article-body code{font-size:.85em;background:rgba(0,0,0,.06);padding:2px 6px;border-radius:4px}
.article-body hr{border:none;border-top:1px solid var(--hairline);margin:24px 0}
.card-badge{display:inline-block;padding:2px 10px;font-size:.7rem;font-weight:700;background:var(--warning);color:#fff;border-radius:999px;vertical-align:middle;margin-left:8px}
.chapter-nav{display:flex;justify-content:space-between;margin-top:48px;padding-top:24px;border-top:1px solid var(--hairline)}
.chapter-nav a{font-weight:600}
.hero-section{text-align:center;padding:48px 24px;position:relative;overflow:hidden}
.hero-section::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,rgba(144,88,49,.1) 0%,transparent 70%);z-index:0}
.hero-section>*{position:relative;z-index:1}
.chapter-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;padding:0 24px;max-width:1100px;margin:0 auto 48px}
.chapter-card{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius-sm);padding:22px;transition:border-color .18s,transform .18s;cursor:pointer;display:block;text-decoration:none}
.chapter-card:hover{border-color:var(--accent);transform:translateY(-2px);text-decoration:none}
.chapter-num{font-size:.7rem;font-weight:700;color:var(--accent);letter-spacing:.06em;margin-bottom:8px}
.chapter-card h3{font-size:1rem;color:var(--text);margin:0 0 6px}
.chapter-card .desc{font-size:.8rem;color:var(--muted);line-height:1.5;margin-bottom:8px}
.chapter-card .count{font-size:.7rem;color:var(--warning);font-weight:600;padding:2px 8px;background:rgba(138,75,18,.08);border-radius:999px;display:inline-block}
footer{border-top:1px solid var(--hairline);padding:32px 24px;text-align:center;color:var(--muted);font-size:.8rem}
footer a{font-weight:500}
@media(max-width:768px){header nav{display:none}main{padding:16px}.chapter-grid{grid-template-columns:1fr;padding:0 16px}.article-card{padding:20px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media print{header,.chapter-nav,footer{display:none}}`;

writeFileSync(join(OUT_DIR, "style.css"), SHARED_CSS, "utf8");

// ── 7b. 生成首页 ─────────────────────────────────────────
function buildIndexHtml(articlesByChapter) {
  let cards = "";
  for (const ch of chapters) {
    const { main, cards: chCards } = articlesByChapter[ch.id];
    const total = main.length + chCards.length;
    cards += `
    <a href="chapters/ch${ch.id}-${ch.slug}.html" class="chapter-card">
      <div class="chapter-num">Ch.${ch.id}</div>
      <h3>${ch.title}</h3>
      <div class="desc">${ch.description}</div>
      <span class="count">${total} 篇</span>
    </a>`;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>系统化思维 — 思维模型知识系统</title>
<meta name="description" content="把复杂问题，看成可以理解、选择与行动的系统。13章、${allFiles.length}篇结构化认知方法论。">
<link rel="stylesheet" href="style.css">
</head>
<body>
<a href="#main-content" class="skip-link">跳至正文</a>
<header>
  <span class="logo"><a href="index.html" style="color:var(--text);text-decoration:none">系统化思维</a></span>
  <nav>
    <a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a>
  </nav>
</header>
<main id="main-content">
  <div class="hero-section">
    <h1>把复杂问题，看成可以理解、选择与行动的系统</h1>
    <p style="color:var(--muted);max-width:560px;margin:8px auto 0">
      ${chapters.length} 个章节 · ${allFiles.length} 篇结构化文章 · 可搜索、可组合、可与 AI 深度共学
    </p>
  </div>
  <div class="chapter-grid">${cards}</div>
</main>
<footer>
  <p><strong>系统化思维</strong> &copy; 2026 ·
  <a href="https://github.com/zjgulai/deep-thinking-mode">zjgulai/deep-thinking-mode</a></p>
</footer>
</body>
</html>`;
}

writeFileSync(join(OUT_DIR, "index.html"), buildIndexHtml(articlesByChapter), "utf8");
console.log("   ✓ index.html");

// ── 7c. 生成每个章节页 ───────────────────────────────────
function buildChapterHtml(ch, articles) {
  const { main, cards } = articles;
  const allArticles = [...main, ...cards];

  // 子章节标签
  const subTags = (ch.subchapters || [])
    .map((s) => `<span class="sub-chapter-tag">${s.title}</span>`)
    .join("");

  // 文章卡片
  let articleCards = "";
  for (const art of allArticles) {
    // 为每篇文章生成一个ID锚点（基于文件名）
    const slug = art.filename.replace(/\.md$/, "").replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "-").slice(0, 60);

    // 安全的正文渲染（基础Markdown→HTML）
    let bodyHtml = art.body
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // 标题
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      // 粗体
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      // 引用
      .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
      // 分隔线
      .replace(/^---$/gm, "<hr>")
      // 列表
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/^(\d+)\. (.+)$/gm, "<li>$2</li>")
      // 段落
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");

    bodyHtml = "<p>" + bodyHtml + "</p>";
    // 修复列表包装
    bodyHtml = bodyHtml.replace(/<p><li>/g, "<ul><li>").replace(/<\/li><\/p>/g, "</li></ul>");
    bodyHtml = bodyHtml.replace(/<\/ul>\s*<ul>/g, "");

    articleCards += `
    <article class="article-card" id="${slug}">
      <h2><a href="#${slug}">${art.title}</a>${art.isCard ? '<span class="card-badge">速查卡</span>' : ""}</h2>
      <div class="article-meta">
        ${art.author ? `<span>✍ ${art.author}</span>` : ""}
        ${art.wordCount ? `<span>📝 ${Math.round(art.wordCount / 1000)}k 字</span>` : ""}
        ${art.sourceUrl ? `<a href="${art.sourceUrl}" target="_blank" rel="noopener">📎 原文</a>` : ""}
      </div>
      <div class="article-body">${bodyHtml}</div>
    </article>`;
  }

  // 前一章/后一章
  const idx = chapters.findIndex((c) => c.id === ch.id);
  const prevCh = idx > 0 ? chapters[idx - 1] : null;
  const nextCh = idx < chapters.length - 1 ? chapters[idx + 1] : null;

  let navHtml = '<div class="chapter-nav">';
  if (prevCh) {
    navHtml += `<a href="ch${prevCh.id}-${prevCh.slug}.html">← Ch.${prevCh.id} ${prevCh.title}</a>`;
  } else {
    navHtml += "<span></span>";
  }
  if (nextCh) {
    navHtml += `<a href="ch${nextCh.id}-${nextCh.slug}.html">Ch.${nextCh.id} ${nextCh.title} →</a>`;
  } else {
    navHtml += "<span></span>";
  }
  navHtml += "</div>";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ch.${ch.id} ${ch.title} — 系统化思维</title>
<meta name="description" content="${ch.description}。${allArticles.length}篇深度文章。">
<link rel="stylesheet" href="../style.css">
</head>
<body>
<a href="#main-content" class="skip-link">跳至正文</a>
<header>
  <span class="logo"><a href="../index.html" style="color:var(--text);text-decoration:none">系统化思维</a></span>
  <nav>
    <a href="../index.html">章节导航</a>
    <a href="https://github.com/zjgulai/deep-thinking-mode">GitHub</a>
  </nav>
</header>
<div class="breadcrumb">
  <a href="../index.html">首页</a> &nbsp;/&nbsp; <span>Ch.${ch.id} ${ch.title}</span>
</div>
<main id="main-content">
  <h1>Ch.${ch.id} ${ch.title}</h1>
  <p class="chapter-desc">${ch.description}</p>
  <div class="sub-chapters">${subTags}</div>
  ${articleCards}
  ${navHtml}
</main>
<footer>
  <p><strong>系统化思维</strong> &copy; 2026 ·
  <a href="https://github.com/zjgulai/deep-thinking-mode">zjgulai/deep-thinking-mode</a></p>
</footer>
</body>
</html>`;
}

for (const ch of chapters) {
  const html = buildChapterHtml(ch, articlesByChapter[ch.id]);
  writeFileSync(join(CHAPTERS_DIR, `ch${ch.id}-${ch.slug}.html`), html, "utf8");
  console.log(`   ✓ chapters/ch${ch.id}-${ch.slug}.html`);
}

// ─── 8. 完成 ──────────────────────────────────────────────
console.log("\n✅ 网站构建完成！");
console.log(`   📂 输出目录: ${OUT_DIR}`);
console.log(`   🌐 首页: ${join(OUT_DIR, "index.html")}`);
console.log(`   📑 章节页: ${CHAPTERS_DIR}/ (13 个文件)`);
console.log("\n💡 本地预览: open site-content/index.html");
