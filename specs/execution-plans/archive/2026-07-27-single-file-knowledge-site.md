# Single-file Knowledge Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已经批准的 13 章、模型、Codex 共学卡、来源和问题路由构建为一个可离线打开、可在 GitHub Pages 子路径运行、无外部运行依赖的 `site/index.html`。

**Architecture:** 构建器读取并验证 `knowledge/`，用受限配置的 `markdown-it` 将章节和模型渲染为安全 HTML，生成稳定搜索索引，将 CSS、客户端 JavaScript 和 JSON Unicode 转义后的知识数据全部内嵌进单一模板。构建期使用受控 HTML lexer 审计真实 tag/attribute/CSS/脚本，不对整份正文做禁词匹配；客户端只做本地导航、搜索、规则匹配和提示词生成。

**Tech Stack:** Node.js 24.18.0 LTS、`markdown-it@14.3.0`、原生 ESM、`node:test`、原生 HTML/CSS/JavaScript、Node `vm`、受控最小 DOM harness；不新增 DOM parser 或浏览器 runtime dependency。

## Global Constraints

- 先通过语义策展计划的完整验证。
- 只在 `main` 工作，禁止 worktree。
- shell 命令遵守总计划 Gate 0。
- 不自动 commit、改历史、push 或部署。
- 发布产物只有 `site/index.html`；不生成外部 CSS、JS、JSON、字体或图片文件。
- 不使用 CDN、外部字体、网络 API、analytics、service worker、WebSocket、XHR 或客户端 `fetch`。
- 来源 URL 只作为可点击 anchor，不作为运行时资源。
- Markdown 原始 HTML 关闭，不渲染 `script`、事件属性、iframe 或 form。
- Markdown 图片语法不生成 `<img>`；只保留经过 HTML 转义的 alt 文本和“图片未收录”说明。
- 页面 anchor 只允许 `#fragment`、`http:` 和 `https:`；拒绝协议相对 URL、`data:`、`file:`、`mailto:`、`javascript:` 和其他 scheme。
- 用户输入只写入 `textContent` 或表单控件的 `value`，不写入 `innerHTML`。
- 问题匹配器必须显示“本地关键词导航”，不能称为 AI 判断。
- 构建先在内存完成并验证，最后原子替换 `site/index.html`。
- 禁止用整页 substring/regex 代替 HTML 结构检查；受控 lexer 必须区分元素、属性、注释、raw-text `script/style` 和普通文本。
- CSP 必须使用构建期计算的 inline CSS/JavaScript SHA-256 hash，不使用 `'unsafe-inline'`。

---

## File Map

```text
tools/build-site.mjs
tools/check-site.mjs
tools/lib/load-knowledge.mjs
tools/lib/validate-knowledge.mjs
tools/lib/render-markdown.mjs
tools/lib/build-search-index.mjs
tools/lib/serialize-for-html.mjs
tools/lib/scan-html.mjs
tools/lib/render-site.mjs
tools/lib/atomic-write.mjs
tools/lib/html-audit.mjs
tools/site/template.html
tools/site/styles.css
tools/site/client.js
tests/load-knowledge.test.mjs
tests/markdown-rendering.test.mjs
tests/search.test.mjs
tests/problem-matcher.test.mjs
tests/prompt-generator.test.mjs
tests/client-init.test.mjs
tests/site-build.test.mjs
tests/atomic-build.test.mjs
tests/site-security.test.mjs
tests/dom-smoke.test.mjs
tests/helpers/load-client.mjs
tests/helpers/minimal-dom.mjs
tests/helpers/minimal-dom.mjs
tests/helpers/static-subpath-server.mjs
tests/fixtures/site/knowledge-valid/
tests/fixtures/site/markdown-dangerous.md
tests/fixtures/site/markdown-hard-breaks.md
site/index.html
```

`tests/fixtures/site/knowledge-valid/` 是人工合成的最小完整知识库，包含：

```text
13 个章节记录和 13 个最小章节 Markdown
3 个模型：问题重构、5 Whys、情绪调节
3 条来源
2 条问题路由
每个模型完整 14 个 H2 和 Codex 卡 10 个 H3
```

## Module Contracts

```js
loadKnowledge(rootDir) -> Promise<KnowledgeSnapshot>

validateKnowledge(snapshot) -> {
  ok: boolean,
  errors: Array<{ code: string, path: string, message: string }>,
  warnings: Array<{ code: string, path: string, message: string }>
}

renderMarkdown(markdown, { sourcePath, anchorPrefix }) -> {
  html: string,
  headings: Array<{ level: number, id: string, text: string }>,
  plainText: string,
  sections: Record<string, string>
}

buildSearchIndex(snapshot) -> SearchDocument[]

compareCodePoints(left, right) -> -1 | 0 | 1

serializeForHtml(value) -> string

lexHtml(html) -> HtmlToken[]

auditHtml({ html, expectedManifest, expectedCss, expectedClientJs }) -> {
  ok: boolean,
  errors: Array<{ code: string, offset: number, message: string }>
}

renderSite({ snapshot, searchIndex, template, css, clientJs }) -> {
  html: string,
  cssSha256Base64: string,
  clientSha256Base64: string
}

atomicWriteFile(targetPath, content, validateCandidate) -> Promise<{
  targetPath: string,
  sha256: string,
  bytes: number,
  directorySynced: true
}>
```

`validateCandidate({ path, bytes })` 只验证候选文件的 bytes、HTML 结构和安全合同；“`site/` 最终恰好一个文件”在 rename 成功且临时文件已清理后由 `check-site.mjs` 独立验证，不能在临时文件仍存在时混用两个检查。

`KnowledgeSnapshot`：

```js
{
  taxonomy: object,
  sources: object,
  routes: object,
  manifest: object,
  chapters: Array<{
    chapter_id: string,
    title: string,
    source_path: string,
    markdown: string,
    rendered: object
  }>,
  models: Array<{
    model_id: string,
    title: string,
    meta: object,
    card_meta: object,
    source_path: string,
    markdown: string,
    renderable_markdown: string,
    rendered: object,
    card_sections: object
  }>
}
```

浏览器端固定暴露：

```js
globalThis.BrainModelApp = Object.freeze({
  normalizeText,
  tokenize,
  searchKnowledge,
  matchProblem,
  generateCodexPrompt,
  init
});
```

输入和输出：

```js
PromptInput = {
  situation: string,
  goal: string,
  facts: string,
  assumptions: string,
  constraints: string,
  attempted: string,
  desired_output: string
}
```

```js
MatchResult = {
  matched: boolean,
  route_id: string | null,
  core_model_id: string | null,
  auxiliary_model_ids: string[],
  score: number,
  reasons: string[],
  missing_fields: string[],
  risk_flags: string[],
  clarifying_question: string | null
}
```

## Task 1: Load and Cross-validate Knowledge

**Files:**

- Create: `tools/lib/load-knowledge.mjs`
- Create: `tools/lib/validate-knowledge.mjs`
- Create: `tests/load-knowledge.test.mjs`
- Create: synthetic valid fixture tree

- [ ] 写失败测试，验证缺章节文件、重复模型 ID、悬空来源、悬空关系、无 Codex 卡、route 超过两个辅助模型、manifest 计数不一致均失败。
- [ ] 写通过测试，验证 13 章、3 模型、3 来源、2 路由的 fixture。
- [ ] 写测试确认 model-meta 与 card-meta 已由模型 parser 提取并从 `renderable_markdown` 移除，最终页面不显示这两类注释字样。
- [ ] `loadKnowledge()` 直接 import 语义计划的 `tools/lib/model-markdown.mjs`，不得复制第二套 model/card parser；站点与语义测试共用同一合法模型 fixture。
- [ ] 实现读取顺序：

```text
taxonomy.json
sources.json
problem-routes.json
manifest.json
13 chapter Markdown
按 model_id 升序的 model Markdown
```

- [ ] 所有错误按 `path + code` 稳定排序，一次报告全部错误。
- [ ] 运行：

```sh
rtk node --test tests/load-knowledge.test.mjs
```

预期：

```text
exit=0
fail 0
```

## Task 2: Safe Markdown Rendering

**Files:**

- Create: `tools/lib/render-markdown.mjs`
- Create: `tests/markdown-rendering.test.mjs`
- Create: `tests/fixtures/site/markdown-dangerous.md`
- Create: `tests/fixtures/site/markdown-hard-breaks.md`

- [ ] 写失败测试，要求配置精确为：

```js
new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false
})
```

- [ ] 写失败测试，验证双空格 hard break 生成 `<br>`，普通换行不强制生成 `<br>`。
- [ ] 写失败测试，验证原始 `script`、iframe、form、事件属性以文本显示；链接只允许 `#`、`http:`、`https:`，拒绝协议相对 URL、`data:`、`file:`、`mailto:`、`javascript:` 及其他 scheme。
- [ ] 自定义 link renderer 必须先调用 `markdown-it.validateLink`，再应用更窄的 allowlist，不得绕过内置危险 URL 检查。
- [ ] 为 `http:` 和 `https:` 外链添加：

```html
target="_blank" rel="noopener noreferrer"
```

- [ ] `markdown-it` 链接合同只允许 `#fragment`、`http:`、`https:`；覆盖 `validateLink` 与 `link_open` 时必须保留默认 URL normalize/escape。`javascript:`、`data:`、`file:`、`mailto:`、自定义 scheme 和 `//example.test/x` 均不得生成可点击链接。
- [ ] 通过校验的 `http:`、`https:` 外链统一带 `target="_blank" rel="noopener noreferrer"`；内部 fragment 不新开窗口。
- [ ] 禁用默认 image 输出：HTTP、协议相对和 `data:image` 图片都不得生成 `<img>`，只输出 HTML 转义后的 alt 加固定“图片未收录”说明。
- [ ] 写失败测试覆盖 alt 中的 `<script>`、链接 title 引号、大小写混合 `</ScRiPt>`、所有 `on*` 事件名和协议相对 URL。
- [ ] 自定义 heading renderer：锚点由 `anchorPrefix + "-" + stableSlug(text)` 生成，重复标题追加 `-2`、`-3`，不依赖数组下标之外的随机值。
- [ ] 禁用 Markdown image rule；模型或章节中的图片语法只输出带 alt 的纯文本来源说明，不生成 `<img>`，确保离线站点没有远程图片依赖。
- [ ] 运行：

```sh
rtk node --test tests/markdown-rendering.test.mjs
```

预期：

```text
exit=0
fail 0
```

## Task 3: Stable Search Index

**Files:**

- Create: `tools/lib/build-search-index.mjs`
- Create: `tests/search.test.mjs`

`SearchDocument`：

```js
{
  id: string,
  kind: "chapter" | "model",
  title: string,
  aliases: string[],
  chapter_id: string,
  tags: string[],
  problem_signals: string[],
  use_when: string[],
  plain_text: string,
  anchor: string
}
```

- [ ] 写失败测试，规范化规则固定为 Unicode NFKC、英文小写、连续空白合一、中文标点转空格。
- [ ] token 规则固定为：完整规范化查询、英文单词、连续中文词段和长度至少 2 的中文双字片段。
- [ ] 固定字段权重：

```text
title=12
aliases=10
problemSignals=8
useWhen=7
tags=6
chapterTitle=4
plainText=1
```

- [ ] 排序固定为 score 降序、规范化 title 的 Unicode code point 升序、id 升序；实现自有 `compareCodePoints()`，不使用依赖宿主 locale/ICU 的 `localeCompare`。
- [ ] 测试中文、英文、全角字符和 supplementary code point 在 macOS 与 Linux 预期顺序一致。
- [ ] 排序比较器只允许 `compareCodePoints`：先 score 降序，再逐 Unicode code point 比较 title，最后逐 code point 比较 id；禁止 `localeCompare`、`Intl.Collator` 和宿主 locale。
- [ ] 空查询返回空数组；低于 1 分不返回；默认最多 20 条。
- [ ] 运行：

```sh
rtk node --test tests/search.test.mjs
```

预期：

```text
exit=0
fail 0
```

## Task 4: Client Problem Matcher

**Files:**

- Create: `tools/site/client.js`
- Create: `tests/helpers/load-client.mjs`
- Create: `tests/problem-matcher.test.mjs`

- [ ] 使用 Node `vm` 加载 `client.js` 并取得 `BrainModelApp`，避免引入 DOM 测试依赖。
- [ ] `client.js` 顶层只能定义纯函数和冻结 `BrainModelApp`，不得在加载时读取 `document`、`window.location`、`navigator` 或自动调用 `init`；模板中的独立 bootstrap 只在 `DOMContentLoaded` 后显式调用一次 `init`。
- [ ] `client.js` 加载时不自动访问 `document`；`init({ document, navigator })` 显式接收浏览器能力。用窄接口 fake DOM 测试所有固定元素 ID、事件绑定、搜索结果更新、问题面板打开和复制回退。
- [ ] 写失败测试，固定算法与 `knowledge/problem-routes.json` 一致：

```text
NFKC 规范化
safety_rules 优先；命中立即 safety_stop
exclude term 优先排除
trigger term 累加 weight
低于 minimum score 不匹配
score 降序、priority 降序
最高并列但主模型不同则不匹配
最高并列且主模型相同时按 route ID 升序
一个主模型、最多两个辅助模型
```

- [ ] 写失败测试：低分、歧义、高风险排除、缺目标和事实、三个辅助模型均得到安全结果。
- [ ] 高风险排除必须返回 `matched:false` 和对应 risk flag，不返回自助治疗步骤。
- [ ] 从每条真实 route 的 `test_cases` 读取至少 3 个正例和 2 个反例；从 safety rules 读取安全停止例。fixture 先覆盖两条 route。
- [ ] 运行：

```sh
rtk node --test tests/problem-matcher.test.mjs
rtk node --test tests/client-init.test.mjs
```

预期：

```text
exit=0
fail 0
```

## Task 5: Codex Prompt Generator

**Files:**

- Update: `tools/site/client.js`
- Create: `tests/prompt-generator.test.mjs`

- [ ] 写失败测试，七项输入始终按固定顺序输出：

```text
情境
目标
已知事实
仍属假设的判断
约束
已经尝试
希望得到的输出
```

- [ ] 当匹配成功时，提示词包含一个核心模型、最多两个辅助模型、选择理由、期望五段输出、验证问题和停止条件。
- [ ] 当匹配失败时，不猜模型；提示 Codex 先完成问题重述并询问一个最高价值缺失事实。
- [ ] 所有用户输入按纯文本处理；保留换行，不插入 HTML。
- [ ] 运行：

```sh
rtk node --test tests/prompt-generator.test.mjs
```

预期：

```text
exit=0
fail 0
```

## Task 6: HTML Data Serialization

**Files:**

- Create: `tools/lib/serialize-for-html.mjs`
- Create: `tests/site-security.test.mjs`

- [ ] 写失败测试，序列化必须转义：

```text
<
>
&
U+2028
U+2029
</script
```

- [ ] 转义使用 JSON Unicode escape：`<` → `\u003c`、`>` → `\u003e`、`&` → `\u0026`、U+2028 → `\u2028`、U+2029 → `\u2029`；不得用 HTML entity 改写 JSON raw text。
- [ ] 数据只插入：

```html
<script id="knowledge-data" type="application/json">SAFE_JSON</script>
```

这里的 `SAFE_JSON` 是模板构建标记，构建完成的 `site/index.html` 中不得残留该字面量。

- [ ] “转义”必须发生在 `JSON.stringify` 之后并使用 JSON Unicode escape：`< -> \u003c`、`> -> \u003e`、`& -> \u0026`、U+2028 -> `\u2028`、U+2029 -> `\u2029`；禁止使用 `&lt;`、`&gt;`、`&amp;` HTML entity。
- [ ] 客户端使用 `textContent` 读取 JSON，再调用 `JSON.parse`。
- [ ] 写 round-trip 测试：把序列化结果放进真实 `<script type="application/json">` raw-text 片段，由受控 lexer 取得该元素的 `textContent`，`JSON.parse` 后必须与原对象 `deepStrictEqual`；同时覆盖大小写混合 `</ScRiPt>`。
- [ ] 在最小真实 DOM/浏览器中读取该 script 的 `textContent` 并 `JSON.parse`，结果必须与序列化前对象 deep equal。
- [ ] 运行：

```sh
rtk node --test tests/site-security.test.mjs
```

预期：

```text
exit=0
fail 0
```

## Task 7: Page Structure and Responsive Styling

**设计权威：** `2026-07-30-systematic-thinking-site-design.md` 是本站点信息架构、视觉、交互、响应式和发布页面表现的权威；资料隐私、安全、来源证据和单文件离线约束仍以 `2026-07-27-brain-model-knowledge-system-design.md` 为准。产品名为「系统化思维」，站点必须在 `/deep-thinking-mode/` 子路径运行。

**Files:**

- Create: `tools/site/template.html`
- Create: `tools/site/styles.css`
- Update: `tools/site/client.js`

- [ ] 模板包含精确结构：

```html
<header id="app-header">
  <button id="nav-toggle" type="button" aria-expanded="false">目录</button>
  <label for="global-search">搜索知识模型</label>
  <input id="global-search" type="search" autocomplete="off">
  <button id="problem-entry" type="button">我遇到一个问题</button>
</header>
<div id="app-shell">
  <nav id="chapter-nav" aria-label="知识目录"></nav>
  <main id="knowledge-content" tabindex="-1"></main>
  <aside id="model-inspector" aria-label="Codex 共学应用卡"></aside>
</div>
<section id="problem-panel" hidden></section>
<div id="live-region" aria-live="polite"></div>
```

- [ ] 桌面三栏：左导航固定宽度、中间弹性正文、右卡片；移动端小于 900px 改为单列和目录抽屉。
- [ ] 首屏使用已批准的暖色 hero：暖米白至浅陶色静态渐变、低对比度内联 SVG 关系线和玻璃问题入口；不得使用远程视频、图片或持续环境动画。
- [ ] 渲染可导航的 13 章地图；每章包含编号、名称、用途、已发布模型数和代表问题信号，桌面 3–4 列、平板 2 列、移动端 1 列，点击后把焦点移入对应章节标题。
- [ ] 宽屏知识工作台精确采用 `240px / minmax(0, 720px) / 280px` 三栏；右栏包含与 Codex 共学应用卡、模型关系、来源、复核状态和风险。900–1179px 时右栏内容移到正文后的折叠区，低于 900px 时改为目录抽屉单列。
- [ ] 问题面板从首屏或顶栏打开，展示统一输入框架、仅本地规则的匹配结果、一个核心模型和最多两个辅助模型、缺失信息以及可复制 Codex 提问；高风险、歧义或低分结果遵从设计规格的停止与追问边界。
- [ ] 支持深浅色系统偏好及已批准的暗色 token、键盘 focus、跳至正文、打印隐藏交互控件；`prefers-reduced-motion: reduce` 下关闭 transform、平滑滚动和非必要 transition。
- [ ] 验收覆盖暖色 hero、13 章地图、三栏尺寸、右侧问题面板、暗色 token、桌面/平板/390px/320px 响应式、键盘操作和 reduced motion。
- [ ] 不加载图片、字体或外部样式资源。
- [ ] CSS 和 executable client script 各自以准确 UTF-8 bytes 计算 SHA-256 base64；模板 CSP 只允许对应的 `'sha256-...'`，不允许 `'unsafe-inline'`。CSP meta 必须位于第一个 style/script 之前，且页面禁止 inline `style` attribute 和所有 `on*` attribute。
- [ ] 运行时渲染知识、搜索结果、匹配理由、风险提示和用户输入时，只能写 `textContent`/`value` 或切换预先存在的安全节点；测试 harness 的 `innerHTML` setter 必须直接抛错。
- [ ] 按钮覆盖搜索、复制提示词、章节折叠、返回顶部和移动目录。
- [ ] clipboard 失败时使用选中 textarea 的同步复制回退，并向 `aria-live` 报告结果。

## Task 8: Render and Atomic Build

**Files:**

- Create: `tools/lib/render-site.mjs`
- Create: `tools/lib/atomic-write.mjs`
- Create: `tools/build-site.mjs`
- Create: `tests/site-build.test.mjs`
- Create: `tests/atomic-build.test.mjs`

- [ ] 写失败测试：模板任一构建标记缺失或重复、知识验证失败、输出含外部运行资源时不写目标。
- [ ] 分别注入 knowledge validator 失败、候选 HTML validator 失败和 rename 失败；目标已有 `OLD_GOOD_SITE` 时 bytes 保持不变，临时文件在 `finally` 清理。
- [ ] 候选 bytes 在内存和临时文件上验证；“site 目录恰好一个发布文件”只在 rename 完成并清理临时文件后检查，避免把 staging 文件误判为发布文件。
- [ ] 写通过测试：成功时在 `site/` 同目录写临时文件、fsync 文件、验证、rename，再 fsync 父目录，结束后无临时文件。
- [ ] HTML 不写当前时间、绝对路径或随机 ID；版本只取 `knowledge/manifest.json`。
- [ ] 分别注入知识验证失败、候选 HTML 审计失败、临时文件 write/fsync 失败、`validateCandidate` 抛错和 rename 失败；每种 rename 前失败都必须保留 `OLD_GOOD_SITE` 原 bytes，并在 `finally` 清理临时文件。
- [ ] 成功路径必须在 `site/` 同目录以 `wx` 创建唯一临时文件，完整 write 后 fsync 文件并 close；重新读取临时文件 bytes 调用 `validateCandidate`；通过后 rename 覆盖目标，再打开父目录执行 fsync，最后确认无临时文件。
- [ ] rename 是唯一替换点；父目录 fsync 发生在 rename 后，只证明目录项耐久。若目录 fsync 异常，报告 `durability_unconfirmed` 且不得伪称旧文件仍在，也不得自动回滚或删除新目标。
- [ ] 连续构建两次，SHA-256 完全相同。
- [ ] 运行：

```sh
rtk node --test tests/site-build.test.mjs tests/atomic-build.test.mjs
```

预期：

```text
exit=0
fail 0
```

## Task 9: Static Site Safety Checker

**Files:**

- Create: `tools/check-site.mjs`
- Create: `tools/lib/html-audit.mjs`
- Update: `tests/site-security.test.mjs`

- [ ] 检查 `site/` 中恰有 `index.html` 一个文件。
- [ ] 实现单遍受控 lexer；只识别本项目生成器需要的 HTML5 子集，输出 `startTag/endTag/text/comment/rawText` token、lowercase tag/attribute name、原始 offset 和已解码 attribute value。`script/style` 内容作为 raw-text token，注释和普通文本不得被重新解释成标签。遇到未闭合 quote/tag、重复 attribute、NUL、bogus comment 或 lexer 不认识的结构立即失败。
- [ ] `auditHtml` 对真实元素和属性执行结构规则，不能在整页文本上搜索禁词：

```text
拒绝任何 script[src]、link、img、iframe、frame、form、object、embed、base
拒绝任何 attribute name /^on/i、style attribute、srcset、http-equiv=refresh
只允许一个 executable inline script、一个 application/json data script、一个 inline style
CSS 拒绝 @import 和所有 url(...)
clientJs 源码单独拒绝 fetch、XMLHttpRequest、WebSocket、serviceWorker、sendBeacon
普通正文即使包含 form、iframe、analytics、fetch( 字样也允许
```

- [ ] anchor 的 `href` 只允许存在的 `#id` 或规范化后的 `http:`/`https:`；协议相对 URL 和其他 scheme 失败。每个外链必须精确带 `target="_blank"`，且 `rel` token 同时包含 `noopener`、`noreferrer`。
- [ ] CSP 由 `renderSite` 根据准确 CSS/client bytes 生成，checker 必须复算 hash，并要求 `default-src 'none'`、`img-src 'none'`、对应的 `style-src`/`script-src 'sha256-…'`、`connect-src 'none'`、`font-src 'none'`、`media-src 'none'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`，不得出现 `'unsafe-inline'`。
- [ ] 写 lexer/security 回归测试：正文含禁词、转义后的 `<iframe>` 和 `<form>` 必须通过；真实 `<form>`、`onload`、大小写混合 tag/attribute、无引号属性、重复属性、`src="//example.test"`、CSS `@import/url()` 和损坏 HTML 必须失败。
- [ ] 检查所有 `href="#..."` 对应唯一 DOM id。
- [ ] 检查页面内嵌计数与 manifest 一致。
- [ ] 运行：

```sh
rtk node tools/check-site.mjs site/index.html
```

预期：

```text
site_files=1
external_runtime_resources=0
broken_internal_anchors=0
manifest_mismatches=0
```

## Task 10: Local Offline and Subpath Verification

**Files:**

- Create: `tests/helpers/static-subpath-server.mjs`
- Create: `tests/helpers/minimal-dom.mjs`
- Create: `tests/dom-smoke.test.mjs`
- Update: `package.json`
- Update: `README.md`

- [ ] `minimal-dom.mjs` 只实现 `init` 实际使用的 DOM/event API；所有节点记录 `textContent`、`value`、attribute 和 listener，`innerHTML` setter 直接抛错，未知 selector 或未声明 API 也抛错。
- [ ] 用 Node `vm` 加载 `client.js` 时先证明没有 DOM 也能取得纯函数；再注入最小 DOM，显式调用一次 `init`，触发搜索输入、问题匹配、提示词生成、复制回退、章节导航和移动目录事件，断言可见状态、ARIA 和输出文本。
- [ ] 将 `tests/dom-smoke.test.mjs` 纳入 `npm test` 和 Pages build gate；真实浏览器烟测保留为第二层验收，不得用它替代可重复的 DOM wiring 测试。
- [ ] 在 Phase A 的 scripts 基础上增加 `"build": "node tools/build-site.mjs"` 与 `"check": "node tools/validate-knowledge.mjs --all"`；保留 `"corpus": "node tools/corpus.mjs"` 和 `"test": "node --test"`，不复制另一套测试清单到 package script。
- [ ] 构建真实站点：

```sh
rtk npm run build
```

- [ ] 使用浏览器控制技能打开本地 `site/index.html`，验证：

```text
13 章导航
搜索
问题匹配
Codex 提示词生成
复制回退
来源链接
键盘导航
移动目录
打印布局
```

- [ ] 启动只把 `site/` 映射到 `/deep-thinking-mode/` 的临时本地服务器：

```sh
rtk node tests/helpers/static-subpath-server.mjs --root site --mount /deep-thinking-mode/ --port 4173
```

- [ ] 打开 `http://127.0.0.1:4173/deep-thinking-mode/` 重复核心烟测，确认没有根绝对路径请求。
- [ ] 断网或阻止网络请求后再次验证正文、搜索、匹配和提示词生成。
- [ ] 运行全量站点验证：

```sh
rtk node --test tests/load-knowledge.test.mjs tests/markdown-rendering.test.mjs tests/search.test.mjs tests/problem-matcher.test.mjs tests/prompt-generator.test.mjs tests/client-init.test.mjs tests/dom-smoke.test.mjs tests/site-build.test.mjs tests/atomic-build.test.mjs tests/site-security.test.mjs
rtk node tools/check-site.mjs site/index.html
rtk npm run corpus -- verify-public --scope worktree --root . --raw-manifest .local/state/raw-baseline.json --current-pointer .local/state/current-cleaning.json
rtk npm run corpus -- verify-public --scope artifact --artifact-dir site
rtk git diff --check
```

- [ ] 将人工烟测截图和日志留在 `.local/reviews/site-smoke/`，不进入公开仓库。
- [ ] 停止并请用户复核本地 HTML，不自动 commit、push 或发布。
