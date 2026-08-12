# “前车之鉴-思维制胜”多页知识工作台设计

## 1. 状态与适用范围

- 原始设计日期：2026-07-30；多页发布决策：2026-08-09。
- 用户已确认采用“知识工作台”方向。
- 产品名：`前车之鉴-思维制胜`。
- 产品副标题：`在对的方向上前行，效率不值一提`。
- 视觉系统：`东方纸雕纪念像`；品牌叙事为`十三卷 · 十三位历史女性导师`。
- 公开仓库：`https://github.com/zjgulai/deep-thinking-mode`。
- 生产域名：`https://xmind.lute-tlz-dddd.top/`。
- 生产环境：腾讯云轻量应用服务器上的独立静态站 Compose project。

本文冻结网站的信息架构、视觉语言、交互、响应式、无障碍、安全、测试和发布边界。
资料清理、语义策展、来源保护和公开历史仍以
`2026-07-27-brain-model-knowledge-system-design.md` 为权威；两份规格冲突时，隐私、安全和
来源证据以该总规格为准，网站结构与生产发布以本文 2026-08-09 决策为准。原来的单文件
约束已被用户明确改为完整多页静态站，不再作为验收条件。

东方纸雕、唐风品牌气象、十三位导师、章节装饰、图像提示词、史实与版权的专项权威为
[`2026-08-08-oriental-paper-sculpture-brand-and-chapter-design.md`](2026-08-08-oriental-paper-sculpture-brand-and-chapter-design.md)；
实施、迭代、本地测试、腾讯云部署和生产验收以
[`2026-08-08-oriental-paper-sculpture-site-execution-todo.md`](2026-08-08-oriental-paper-sculpture-site-execution-todo.md)
编排。专项视觉规格不得改变本文的信息架构、可访问性、安全、确定性构建和部署边界。

## 2. 设计决策

采用以下组合，而不是复制某一个品牌页面：

1. 使用 Mintlify 的三栏文档信息架构承载长期知识阅读。
2. 使用用户附件 Wandor 与 Claude 的暖米白、陶棕、暖黑和克制玻璃质感。
3. 使用 IBM Carbon 的 4px 网格、明确状态、焦点可见性和触控纪律。
4. 使用“东方纸雕纪念像”的立体剪纸、浅浮雕和纪念碑式留白承接十三章历史女性导师。

用户附件只作为视觉意图，不改变已确认的技术栈。最终站点不采用 React、TypeScript、
Vite、Tailwind、lucide-react、Google Fonts 或附件中的远程视频。

“唐风”只表示开阔、庄重、克制的品牌气象，不表示所有人物统一穿唐装。人物服饰与器物
服从各自朝代；完整人物图只出现在首页章节卡和章节 Hero，2789 个模型详情页只继承章节色、
微型签名和导师文本入口，避免错误作者归因与大规模重复资源。

选择“知识工作台”而非另外两种方向的原因：

- 全屏沉浸式系统地图会让用户多滚动一次才能进入知识，并增加循环动效、可访问性和移动端成本。
- 纯文档布局虽然效率最高，但不足以承接用户明确要求的 Wandor 风格和问题入口。
- 紧凑氛围首屏加三栏工作台能同时满足品牌感、问题导向和长期阅读。

## 3. 产品目标

网站帮助用户完成五件事：

1. 从 13 个章节理解系统化思维的整体结构。
2. 按模型、概念、问题信号、使用场景和标签搜索。
3. 描述真实问题，并由本地规则推荐一个核心模型和最多两个辅助模型。
4. 生成可复制的结构化 Codex 提问。
5. 查看模型关系、来源、复核状态、风险与证据边界。

首版不建设：

- 账户、同步、收藏、评论、在线编辑或数据库。
- 文件上传、URL 抓取入口或浏览器内语义分析。
- 在线 AI、聊天窗口、个性化推荐或行为追踪。
- PWA、service worker、客户端远程数据下载或依赖服务端 API 的路由。
- 远程字体、图片、视频、图标库或其他运行时资源。

## 4. 页面体验

### 4.1 页面与路由

```text
site/index.html                     品牌首页、精选路径、Agent 流程、13 章地图
site/models/index.html              全量模型目录与浏览器本地筛选
site/chapters/ch*.html              13 个章节索引页
site/models/<stable-slug>.html      2789 个独立模型详情页
site/router.html                    本地规则 Agent 路由器
site/404.html                       明确的错误与恢复入口
site/assets/*                       共享 CSS、JavaScript 与本地图标
site/robots.txt + sitemap.xml       搜索引擎入口
```

所有页面使用稳定、确定性的相对链接，不依赖 History API、服务端重写、CDN 或第三方运行时。
`docs/` 与 `site/` 必须由同一构建候选同步生成并逐文件一致。

### 4.2 全局顶栏

顶栏包含：

- 左侧文字标识“前车之鉴-思维制胜”。
- 桌面端章节入口。
- 全局搜索。
- 黑色主按钮“我遇到一个问题”。
- 移动端目录按钮。

顶栏使用暖米白半透明表面和细分隔线。只有浏览器支持时才增加轻微
`backdrop-filter`；不支持时使用不透明背景，不能依赖模糊保证可读性。

### 4.3 紧凑氛围首屏

首屏高度使用约 `clamp(440px, 56svh, 640px)`，不占满整页。内容包括：

- 标题：“把复杂问题，看成可以理解、选择与行动的系统”。
- 简介：说明这是可搜索、可组合、可与 Codex 共学的思维模型知识系统。
- 玻璃问题卡：展示一个简短问题输入入口。
- 主操作：“匹配思维模型”。
- 次操作：“浏览 13 章”。

背景不使用视频。它由三层内嵌视觉构成：

1. 暖米白到浅陶色的静态径向渐变。
2. 低对比度内联 SVG 关系线、节点和少量章节编号。
3. 顶部白色到透明的渐隐层，借鉴 Wandor 的可读性处理。

关系图只作氛围，不承载唯一信息，不接受点击，也不进入无障碍树。默认没有循环位移动画；
允许按钮和面板使用 150–200ms 的颜色、透明度和最多 2px 位移反馈。

### 4.4 13 章系统地图

系统地图展示 13 个有序章节，每张卡包含：

- 章节编号和名称。
- 一句章节用途。
- 已发布模型数。
- 两至四个代表问题信号。

它是二维网格，不实现自由拖拽或无限画布。桌面 3–4 列、平板 2 列、移动端 1 列。
点击卡片移动到对应章节，并把焦点放入章节标题。

### 4.5 模型详情工作台

宽屏采用：

```text
minmax(0, 1fr) / 390px
```

最大内容宽度约 1320px，栏间距 32px。

主栏按稳定顺序渲染：

1. 核心定义。
2. 底层机制。
3. 适用问题与识别信号。
4. 不适用场景。
5. 操作步骤。
6. 示例。
7. 常见误用。
8. 验证方式。
9. 前置模型、推荐组合和替代模型。
10. 停止条件。
11. 来源与证据边界。

右栏：

- 与 Codex 共学应用卡。
- 前置、组合、替代和易混淆模型。
- 来源标题、发布日期、内容作用和复核状态。
- `needs_review`、`needs_ocr`、`needs_medical_review` 等明确文字标识。

章节页只渲染模型摘要、触发信号和角色标签；完整协议进入独立模型页，避免把一个章节渲染为
数 MB 的单文档。移动端右栏移动到主栏之前，使 Codex 应用卡仍保持可达。

### 4.6 问题面板

问题面板是 Wandor 玻璃提示卡在本产品中的唯一重点映射。它可从首屏或顶栏打开，包含：

- 情境。
- 目标。
- 已知事实。
- 仍属假设的判断。
- 约束。
- 已经尝试。
- 希望得到的输出。

流程为：

```text
纯文本输入
  → 本地安全规则
  → 本地关键词与权重匹配
  → 一个核心模型 + 最多两个辅助模型
  → 选择理由与缺失信息
  → 生成并复制 Codex 提问
```

匹配器必须持续显示“本地规则导航”，不得称为 AI 判断。高风险输入先返回停止与专业升级提示，
不生成自助诊断或治疗步骤。歧义或低分结果不猜模型，只询问一个最高价值缺失事实。

## 5. 视觉系统

### 5.1 色彩

| 角色 | 色值 | 用途 |
|---|---|---|
| Canvas | `#faf9f5` | 页面主背景 |
| Surface | `#ffffff` | 正文和实色信息卡 |
| Text | `#1a1a1a` | 标题和高优先级正文 |
| Body | `#3d3d3a` | 普通正文 |
| Muted | `#6c6a64` | 辅助信息；替代附件对比不足的 `#767676` |
| Accent | `#905831` | 当前项、链接、焦点和重点状态 |
| Hairline | `#e6dfd8` | 分隔线与卡片边界 |
| Strong action | `#0a0a0a` | 唯一最高优先级按钮 |
| Warning | `#8a4b12` | 待复核与证据不足 |
| Danger | `#9f2d24` | 高风险停止 |

状态不能只靠颜色。每种状态还必须包含明确文字和稳定图形标记。

当系统偏好为深色时使用独立 token，而不是简单反转：

| 角色 | 深色色值 |
|---|---|
| Canvas | `#171512` |
| Surface | `#211e1a` |
| Text | `#f5f1eb` |
| Body | `#ddd6cc` |
| Muted | `#b9afa3` |
| Accent | `#d59a6f` |
| Hairline | `#39332d` |
| Strong action | `#faf9f5`，文字使用 `#171512` |
| Warning | `#f0b36d` |
| Danger | `#ff9b8f` |

深色模式保留暖色气质；实色正文面、玻璃 fallback、焦点、风险和链接必须分别验证对比度。

### 5.2 字体

运行时只使用系统字体：

```css
-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei",
"Segoe UI", sans-serif
```

代码、ID 和键盘提示使用系统等宽字体。`Special Elite` 不用于中文标识，Google Fonts 不进入页面。

### 5.3 形状、间距与层次

- 4px 基础网格，常用间距为 8、12、16、24、32、48、64px。
- 主 CTA 和问题入口可使用完整 pill。
- 知识卡圆角 10–14px；大型问题面板 20–28px。
- 默认卡片使用细边框而非阴影。
- 玻璃面板只用于问题入口；长文、来源和风险内容始终使用实色表面。
- 不使用装饰性多色渐变、霓虹、强投影或浮动粒子。

## 6. 响应式

| 宽度 | 布局 |
|---|---|
| `>=1180px` | 完整三栏，右栏可在视口内保持可见 |
| `900–1179px` | 左栏 + 正文；右栏内容移动到正文后方的折叠区 |
| `<900px` | 单列；目录使用抽屉；搜索在顶栏第二行铺满 |
| `<480px` | 16px 页面边距、32–40px 首屏标题、单列章节卡 |

移动端主要控件至少 44px 高。320 CSS px 宽度下页面不得整体横向滚动；只有确属二维结构的
比较表可以在自己的标记容器内横向滚动。

## 7. 无障碍与动效

- 页面提供“跳至正文”。
- 使用 `header`、`nav`、`main`、`aside` 和正确标题层级。
- 所有功能均可通过键盘完成。
- `:focus-visible` 使用 2px 陶棕 outline 和至少 2px offset。
- 抽屉和问题面板支持 Escape 关闭、焦点约束和关闭后的焦点归还。
- 搜索、匹配、复制与错误结果通过 `aria-live` 报告。
- 折叠控件维护 `aria-expanded` 和目标关联。
- `prefers-reduced-motion: reduce` 下关闭 transform、平滑滚动和非必要 transition。
- 打印模式隐藏顶栏操作、抽屉和问题面板，保留正文、来源、风险和 URL。

## 8. 数据与构建流

```text
knowledge/*.json + knowledge/**/*.md
  → 严格 schema 与交叉引用验证
  → 安全 Markdown 渲染
  → 搜索索引与问题路由编译
  → HTML-safe JSON 序列化
  → 模板 + 共享本地 CSS/client JS
  → 首页、章节、模型详情、路由、404、robots、sitemap
  → CSP 与完整内部链接闭包审计
  → Acorn 严格 AST 能力审计 + 三份公开脚本 trusted source bytes 对等
  → HTML script 引用与静态 `.mjs` import 闭包审计
  → 同文件系统候选目录验证
  → 候选目录替换 site/，再同步替换 docs/
```

构建器只消费公开安全的 `knowledge/`。它不得读取原始全文、清理全文、OCR、私密学习笔记或
Graphify 输出。相同输入必须使 `site/` 中每个路径及其 SHA-256 集合逐字节相同。

公开脚本门采用三层分工：构建期使用精确固定的 `acorn@8.18.0` 解析 `.js` 的 script grammar
和 `.mjs` 的 module grammar，AST 拒绝 storage、cookie、动态代码生成、网络、service worker 与
dynamic import；同时仅允许 `assets/site.js`、`assets/router-controller.mjs`、
`assets/router-engine.mjs`，且发布 bytes 必须与 `tools/site-assets/` trusted source 完全相同。
checker 再验证 HTML script 引用与静态 `.mjs` import 的本地文件闭包。AST policy 不是任意
JavaScript taint proof；对 computed/alias 旁路的承重保证是固定 allowlist 与 source bytes parity。
Task 8 的真实浏览器 smoke 才验证 DOM 生命周期和离线运行时行为。Acorn 只属于 build/test
devDependency；Docker 静态镜像与浏览器运行时不包含 `node_modules`。

解析器选择依据 [Acorn 官方仓库](https://github.com/acornjs/acorn) 与
[npm 官方包元数据](https://www.npmjs.com/package/acorn)。不采用仍需实验标志的 Node
`SourceTextModule` 作为发布门。

浏览器端：

- 不执行 `fetch`、XHR、WebSocket、service worker 或 analytics。
- 不写 `innerHTML`；用户输入只进入 `textContent` 或控件 `value`。
- 不把用户输入写入 URL、storage、cookie 或远程服务。
- 只读取当前 HTML 中构建时渲染的数据属性和 DOM 文本。

## 9. 异常与失败边界

构建期：

- 缺章节、重复 ID、悬空关系、无 Codex 卡、来源计数不一致或危险 Markdown 时构建失败。
- 模板 marker 缺失或重复、CSP hash 不匹配、外部资源或损坏 HTML 时构建失败。
- 候选目录未通过全部检查时，不替换上一份可用 `site/`。
- rename 后目录 fsync 失败只报告 durability 未确认，不伪称已经回滚。

客户端：

- 空搜索显示可操作提示，不显示伪结果。
- 无匹配、并列歧义和高风险均有独立状态。
- 剪贴板失败时回退为选中文本，并通过 `aria-live` 说明。
- 内部目标缺失属于构建缺陷，由发布前 checker 阻止，不在运行时静默忽略。

## 10. Graphify 边界

Graphify 仅用于代码与模块架构审计，不参与知识语义处理、网站运行或 Pages 构建。

首轮规则：

- Git 忽略 `/.codex/` 和 `/graphify-out/`。
- `.graphifyignore` 排除根层 Markdown、`.local/`、`inbox/`、`docs/`、
  `tests/fixtures/`、`.codex/` 和 `graphify-out/`。
- 禁止 `--no-gitignore`。
- 使用 `GRAPHIFY_QUERY_LOG_DISABLE=1`。
- 只执行 `graphify extract . --code-only`。
- `graphify-out/` 作为本地私有审计构件，不进入 Git 历史或 Pages artifact。

## 11. 验证与自我审计

### 11.1 自动验证

- 知识 schema、模型合同、来源和关系交叉验证。
- Markdown 安全渲染与 URL allowlist。
- 搜索排序、问题匹配、安全停止和提示词生成测试。
- HTML lexer、CSP、外部资源、内部锚点和 manifest 计数审计。
- Acorn AST、公开脚本 trusted-source bytes、脚本 allowlist 与静态 module 闭包审计。
- 原子构建失败保护与连续两次构建 SHA-256 相同。
- 最小 DOM 测试覆盖导航、搜索、匹配、复制、目录抽屉和焦点状态。
- Pages workflow 只上传 `site/`。

### 11.2 人工验证

- 桌面宽屏、平板、390px 手机和 320px reflow。
- 本地静态 HTTP 服务与相对链接导航。
- 腾讯云候选 origin 与 `https://xmind.lute-tlz-dddd.top/`。
- 键盘完整操作、可见焦点、Escape、焦点归还和打印。
- 阻断网络后搜索、匹配和提问生成仍可用。
- 首屏背景、玻璃问题卡和正文在浅色、深色系统偏好及 reduced motion 下可读。

截图与日志只保存在 `.local/reviews/site-smoke/`，不进入公开仓库。

## 12. 发布边界

主生产目标是腾讯云上的完整多页静态站，发布单元始终是经过检查的整个 `site/`，不是单个
`index.html`。首页、`assets/`、`chapters/`、`models/`、Router、404、robots 和 sitemap
必须作为同一构建候选、同一构件 hash 和同一镜像版本发布。`docs/` 是逐字节兼容镜像，
GitHub Pages 是兼容发布渠道，不能取代腾讯云 origin、共享入口和生产逐文件验收。

腾讯云实际命令、Docker context allowlist、共享 Nginx 备份/验证/切换和回滚以
[`deploy/tencent-cloud/xmind-site/RUNBOOK.md`](../deploy/tencent-cloud/xmind-site/RUNBOOK.md)
为唯一权威；视觉版本的阶段门和证据清单见
[`specs/2026-08-08-oriental-paper-sculpture-site-execution-todo.md`](2026-08-08-oriental-paper-sculpture-site-execution-todo.md)。

当前 `main` 历史包含 418 份原始 Markdown，不得直接推送。发布顺序保持：

1. 验证私有 Git bundle 和恢复能力。
2. 完成私有迁移、公开范围检查和最终多页构建。
3. 在临时 index 中生成公开安全候选 tree。
4. 用户确认候选 tree 后创建唯一无父公开 root commit。
5. 用户确认后原子激活本地 `main`。
6. 确认 GitHub 身份、公开邮箱、空仓库和 Pages 配置后绑定 `origin`。
7. 用户确认“首次 push + 自动生产部署”后推送。
8. 验证生产域名、TLS、安全头及线上全站路径/hash 身份。

GitHub Actions 使用 build/deploy 两个 job，只向 Pages 上传 `site/`，并使用
`contents: read`、`pages: write`、`id-token: write` 和 `github-pages` environment。

## 13. 验收标准

设计完成必须同时满足：

- 产品名称与网址使用 `前车之鉴-思维制胜` / `https://xmind.lute-tlz-dddd.top/`。
- 产品副标题使用“在对的方向上前行，效率不值一提”。
- 首屏体现暖色、渐隐背景和玻璃问题入口，但没有远程视频或持续环境动画。
- 十三章导师和东方纸雕装饰遵循专项视觉规格，且不改变模型作者、史实和风险边界。
- 13 章地图、三栏工作台、搜索、问题匹配、Codex 提问、关系与来源均可用。
- 每个 ready 模型有完整应用卡；风险、待复核和证据边界可见。
- `site/` 是链接闭合的多页静态目录，可由任意静态 HTTP 服务器托管。
- 运行时网络请求为零，危险 HTML、外部资源和断裂锚点为零。
- 键盘、reduced motion、320px reflow 和打印通过。
- 两次相同构建的路径集合与全部 hash 一致；失败构建不覆盖上一份可用站点。
- 公开 Git 历史和 Pages artifact 不含原始全文、清理全文、OCR、私人记录、bundle、
  Graphify skill 配置或 Graphify 输出。
