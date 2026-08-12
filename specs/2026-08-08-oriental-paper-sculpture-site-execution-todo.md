# “前车之鉴-思维制胜”东方彩绘导师视觉重制、部署与验收 TODO

## 1. 目标、状态与适用范围

- 计划日期：2026-08-08。
- 当前状态：V1 技术发布已完成，但人物视觉验收已被用户撤回；V2 首轮偏暗、偏工作照的母版
  已被用户否决，不再作为视觉方向。V3 六张 A/B 方向稿用于发现问题，不进入生产。V4 已按
  `东方华彩人物志 × 纸上山河` 新合同完成十三位导师的史实 Brief、Prompt Contract、防撞矩阵、
  分批生成、定向修正、原尺寸与卡片裁切评审。用户于 2026-08-09 对十三张最终图明确“全部通过”。
  已从批准原图确定性派生 52 个版本化 AVIF/WebP 资产，接入公开映射、构建多页站并完成本地
  自动测试、桌面/移动 E2E 与设计 QA。V4 已作为不可变镜像部署到腾讯云，并完成逐文件生产校验、
  13 章浏览器 E2E、320/390px 移动验收与同机 32 个既有域名无回归核验。核心发布提交已推送
  `origin/main`，GitHub Pages 镜像也已完成逐文件验收。
- 目标：以“彩绘人物 × 立体纸艺知识剧场”重制十三位导师，在不改知识内容与站点能力的前提下，
  完成史实资料、角色圣经、图片生成、前端接入、本地测试、用户视觉签字、腾讯云部署、生产 E2E
  和最终验收。
- 产品名：`前车之鉴-思维制胜`。
- 产品副标题：`在对的方向上前行，效率不值一提`。
- 生产域名：`https://xmind.lute-tlz-dddd.top/`。

视觉权威为
[`2026-08-08-oriental-paper-sculpture-brand-and-chapter-design.md`](2026-08-08-oriental-paper-sculpture-brand-and-chapter-design.md)；
网站架构以
[`2026-07-30-systematic-thinking-site-design.md`](2026-07-30-systematic-thinking-site-design.md)
为准；隐私、来源和公开历史以
[`2026-07-27-brain-model-knowledge-system-design.md`](2026-07-27-brain-model-knowledge-system-design.md)
为准；腾讯云命令以
[`../deploy/tencent-cloud/xmind-site/RUNBOOK.md`](../deploy/tencent-cloud/xmind-site/RUNBOOK.md)
为唯一部署 Runbook。

用户曾明确授权 V1 部署到既有 `xmind_site` 隔离环境。V2 不得沿用该授权跳过新的视觉签字门；
现有专属证书和共享 Nginx 保持不动，未来获准部署时也只允许替换 `xmind_site` 不可变镜像，
不得改证书、共享入口或其他应用。本文仍不授权自动 commit 或 push。

### V1 2026-08-09 技术执行记录

- [x] G0：完成 main/脏工作区、Graphify、三份规格、构建与服务器基线审计。
- [x] G1-G2：锁定 13 位导师与互斥的“空间—器物—纹样”矩阵，生成并固定 13 组 AVIF/WebP 生产资产。
- [x] G3：2789 模型、13 章节确定性构建；两次完整构件 hash 均为 `f6651fde2cff5571ae3009f572cda75e83722bfe97127c592095e6a9df34db01`。
- [x] G4：浏览器覆盖 320/390/1024/1440 视口、首页、搜索、模型详情与全部 13 章；无横向溢出，图片尺寸与声明一致。
- [x] 自动测试：`1062/1062`；同时修复 OCR 资产注册中“并行 mkdir 与 write”导致的全量测试竞态。
- [x] 公开产物检查：`2838` 文件，多页资源、链接、锚点与路径边界通过。
- [x] G5：Docker allowlist、精确镜像文件清单、镜像冒烟与归档校验。
- [x] G6-G8：腾讯云镜像替换、origin、公网逐文件与生产浏览器 E2E。
- [x] G9：记录最终线上版本、审计目录、回滚点与验收结果。

### 最终发布与验收记录

| 项目 | 已验收结果 |
|---|---|
| 生产地址 | `https://xmind.lute-tlz-dddd.top/`，严格 TLS 200 |
| 构件 | `f6651fde2cff5571ae3009f572cda75e83722bfe97127c592095e6a9df34db01`，2838 文件 |
| 生产镜像 | `xmind-site:f6651fde2cff` / `sha256:35b458de4a7205d6180fae3cf17afce6b89f09e8b7bd47b46923e0af19d7369a` |
| 容器 | `xmind_site-web-1` healthy；只读根文件系统、非 privileged、`cap_drop=ALL` |
| 资源隔离 | 仅 `xmind_site` project、`xmind_site_internal` 网络与 `172.20.0.1:18888`；未加入其他应用网络 |
| 镜像内容 | 2838/2838 文件 SHA-256 与构建上下文一致；`.gitignore`、`.DS_Store`、私钥和私有目录为 0 |
| 生产一致性 | `tools/verify-production.mjs` 对 2838 文件逐字节通过；生产 `/.gitignore` 返回 404 |
| 自动测试 | `1062/1062`；公开构件、数据清洗、manifest 与 `git diff --check` 通过 |
| 浏览器 E2E | 320/390/1024/1440；首页、手机导航、模型检索、模型详情、13 章及 13 张 960×1200 导师图通过 |
| 可访问性 | 首个键盘焦点为“跳至正文”；全部导师图有中文 alt；全部艺术图标注“AI 艺术化演绎，非真实肖像” |
| 证书 | 既有 ECDSA 专属证书仍有效至 2026-11-07；本轮未签发、续期或修改 |
| 共享入口 | Nginx 配置 SHA-256 前后均为 `6101f9cdf53e71a8b11fb6b90711a841ea5a135f7bee835264911a7c30641869`；未 reload/restart |
| 邻接回归 | 32 个既有域名的 TLS、状态码、remote IP 前后完全一致；非 xmind 容器、网络、卷和监听地址未变化 |
| 审计证据 | `/opt/xmind-site/audit/20260809T070659Z-f6651fde2cff/` |
| 回滚点 | `/opt/xmind-site/rollback/20260809T070659Z-f6651fde2cff/`，旧镜像 `xmind-site:c3bac9b1a282` 保留 |
| 服务器余量 | 根盘仍为 85%，可用 47G；未执行任何 prune |

生产 Chrome 中曾出现 `meta.json` 的 JSON 解析错误。CDP 捕获证明该请求由用户浏览器中的
`chrome-extension://.../static/js/shopify.js` 注入，并非站点脚本；站点 `site.js` 没有 `fetch`、
`JSON.parse` 或远程请求。该扩展噪声不计入产品缺陷，也没有为迎合扩展而新增公开端点。

本轮没有 commit、push 或发布 GitHub Pages；未跟踪的项目根 `AGENTS.md` 仍按用户要求保留。

### V2 2026-08-09 视觉重制检查点

- [x] 审计 13/13 现有导师图：确认同脸、同髻、同姿态、暖白石膏化来自生成规格与数据合同，
  不是构建复制或 CSS 滤镜。
- [x] 研究三条 X 参考、`awesome-gpt-image-2` Prompt as Code 方法和 OpenAI 官方 GPT Image 2
  提示指南；只萃取方法，不复制原图、完整提示词或独特表达。
- [x] 冻结 V2 材质边界：人物使用自然肤色、深色发丝、可辨识衣料；纸雕、剪纸和浅浮雕只
  用于环境、框景与知识隐喻。
- [x] 完成两套候选方向、十三位差异矩阵、结构化提示协议、硬性否决项与百分制评审。
- [x] V2-G0：为班昭、武则天、秦良玉完成史实资料板和三份角色圣经。
- [x] V2-G1：使用内置 ImageGen 生成三人各 A/B 两张母版，共六张候选；工具未暴露可验证的
  后端快照，因此不虚构具体 GPT Image 版本。
- [x] V2-G2：用户选择视觉家族并逐人签字（2026-08-09 用户明确授权，13 位导师全部通过）。
- [x] V2-G3：生成 13 位导师并完成接入；`chapter-mentors.json` + `chapter-themes.json` + 13 组 AVIF/WebP 资产。
- [x] V2-G4：首页卡片、章节 Hero 均接入版本化资产与数据合同；`chapter-presentation` 测试 11/11 通过。
- [x] V2-G5：全量测试 `1062/1062`；确定性双构建 hash 一致；check:public 通过；1440/1024/390/320 E2E 全绿。
  - 本地构件 `ce773a9102fd48c1f2ba33073cdae0e63dc638ec89d98c51a5a736be77bcc549`，2838 文件
  - 额外完成全页面视觉精修（site.css + build-site.mjs）：章节卡片 4:5 比例、移除 emoji、精修间距/字级/装饰
- [x] V2-G6：用户批准最终 13 人与网站截图，并明确确认执行不可变镜像部署。
- [x] V2-G7：腾讯云只替换 `xmind_site` 镜像，逐文件生产验证、浏览器 E2E 和回滚证据均完成。

### V4 2026-08-10 UTC 生产发布与验收记录

| 项目 | 已验收结果 |
|---|---|
| 生产地址 | `https://xmind.lute-tlz-dddd.top/`；HTTP 精确跳转 HTTPS，严格 TLS 200，`ssl_verify_result=0` |
| 用户签字 | 十三位最终导师图“全部通过”；随后明确同意按既定方案执行下一批部署 TODO |
| 本地发布门 | `npm run release:check` 通过；`1063/1063` 测试通过；2789 模型、13 章、公开构件检查通过 |
| 不可变构件 | `33b3237b0031c2badd3e1722e3d119669ecc034acf6cf80f5684bc16f780e353`，2864 文件 |
| 生产镜像 | `xmind-site:33b3237b0031` / `sha256:e80ebcd29ba22d0ae7daea8dc1df642c2572c1c3abadc220016be9b853997bf8`，`linux/amd64`，镜像标签记录完整构件 hash |
| 容器隔离 | `xmind_site-web-1` healthy、restart 0、只读根文件系统、非 privileged、`101:101`、`cap_drop=ALL`；仅 `xmind_site_internal`，0 mounts，绑定 `172.20.0.1:18888` |
| 镜像内容 | 2864 文件；`.git`、`.gitignore`、`DDDD.pem`、`*.pem`、`*.key` 和私有 `data` 路径为 0 |
| 生产一致性 | `tools/verify-production.mjs` 对 2864 个文件逐字节通过；线上首页 SHA-256 与本地一致；生产 `/.gitignore` 返回 404 |
| 生产浏览器 E2E | 首页 14 张 V4 AVIF 全部加载；13/13 章节 Hero 均为 960×1200、alt 完整、无横向溢出；章节筛选、模型详情、Router 3 路匹配通过；390/320px 导航与布局通过；控制台 0 warning/error |
| 证书 | 既有 xmind 专属 ECDSA 证书保持不动，有效期至 2026-11-07；本轮未签发、续期或修改 |
| 共享入口 | `ai_video_nginx` 容器 ID、镜像、启动时间、restart 0 与 healthy 状态前后不变；Nginx 配置 SHA-256 前后均为 `18ea36dfeb7940163486dc40cf5a77689845b03183ec7b763e8dd6092d8145cf`，未 reload/restart |
| 邻接回归 | 32/32 既有域名的严格 TLS、状态码、remote IP 与最终 URL 前后 TSV 逐字节一致；68 个非 xmind 容器 ID、33 个网络 ID、28 个卷名均未变化 |
| 资源变化 | 只新增本次镜像；未删除任何镜像、网络、卷或容器；根盘仍为 87%，部署观测窗口用量增加 83,206,144 bytes，未 prune |
| 审计证据 | `/opt/xmind-site/audit/20260810T035544Z-33b3237b0031/`；本地镜像 tar SHA-256 为 `7df57b2b35dcdfaefc154de08a9ce1c36d4c01f785cd4f7b7573a8832fdbf7fc` |
| 回滚点 | `/opt/xmind-site/rollback/20260810T035544Z-33b3237b0031/`；上一版 `xmind-site:f6651fde2cff` 与更早 `xmind-site:c3bac9b1a282` 均保留 |
| Git 状态 | 未 commit、未 push；保留用户既有脏工作区与未跟踪文件 |

### 2026-08-10 生产安全响应头收口记录

| 项目 | 已验收结果 |
|---|---|
| 用户补签 | 用户明确签字确认真实物理键盘 Tab 顺序，原唯一人工未验证项闭环 |
| 发布基线 | 从 `main@ad9312ae9101fe3193a01d089628cb961e00493b` 生成发布提交 `d929e32f4bba1fe35ab4173870c60aae338a984a` 并推送到 `origin/main` |
| 自动门 | `npm run check`、公开构件门、11975 路径 manifest 与全量测试 `1072/1072` 通过 |
| 不可变构件 | `8acae8761f368c441b5f596c201bad139cbd8427faba9402dbc3b8e2655c43d0`，2864 文件 |
| 生产镜像 | `xmind-site:8acae8761f36`；服务器 image ID `sha256:e862c7cfa2fb91f442c76017b99961a0df948b91bc76f2e3c08a6867f1c8d6dc` |
| CSP | HTML meta 只保留可在 meta 生效的指令；origin HTTP 头补充 `frame-ancestors 'none'` |
| 响应头 | CSP、HSTS、`nosniff`、`DENY`、Referrer Policy、Permissions Policy 各精确出现一次；无 origin/edge 重复 |
| 生产一致性 | `verify-production` 对 2864/2864 文件逐字节通过；真实 404 与严格 TLS 通过 |
| 浏览器 | 首页、13 卡、Router 三路匹配、Ch.12 960×1200 AVIF 与控制台零 warning/error 通过 |
| 邻接安全 | 32/32 域名 pre/post 完全一致；70 个非 xmind 容器 ID/镜像、网络、卷和监听端口零变化 |
| 共享入口 | Nginx hash 前后均为 `5a0fb8af2dff1fa2655898f9163b07b88133136e0bf655ee511f7fa25b0c0724`，未 reload/restart |
| 审计与回滚 | `/opt/xmind-site/audit/20260810T101438Z/`；上一镜像 `xmind-site:40c6b7aafdc7` 与配置备份保留 |
| GitHub Pages | Actions run `31385218882` 的 build/deploy 全绿；`https://zjgulai.github.io/deep-thinking-mode/` 2864/2864 文件逐字节通过，真实 404、严格 TLS 通过 |

### 2026-08-12 Router 2.0 MIME 修复发布与生产 E2E

| 项目 | 已验收结果 |
|---|---|
| 发现方式 | 真实生产浏览器 E2E 发现 Router 表单触发原生跳转，证明控制器没有执行；字节一致和 HTTP 200 不能代替模块执行验证 |
| 根因 | origin Nginx 未把 `.mjs` 映射为 JavaScript MIME，在 `nosniff` 下返回 `application/octet-stream`，浏览器严格拒绝 module script |
| 修复 | origin Nginx 显式映射 `application/javascript mjs`；生产 verifier 回归锁定 executable module 必须拒绝 `application/octet-stream`；升级比较器以构件标签与当前 image tag 共同锁定候选 image，允许站点 bytes 不变时重发 origin 配置并保留旧 image ID |
| 构件 | `7c85af5d6e2c877216789e73241c7dbba07e2004f126b8531dd8637195418b6c`，2872 文件，逐字节生产验证通过 |
| 生产镜像 | `xmind-site:7c85af5d6e2c` / `sha256:4923b8d7c02299892efd840e5b47b7c219cb5e07838945fdb784176db20f4ea6`，`linux/amd64`；tar SHA-256 `a1f3f86527b0ace167fab29db2388c5a3ff48e12986e8dd7ea583fbcf4e8da72` |
| Router E2E | 正常匹配 `planning::planning`；清空复位；歧义问题追问后匹配 `diagnosis::intent` + `planning::intent`；紧急人身危险进入 `safety_stop`，0 路由、0 复制提示 |
| 页面 E2E | 13 章、6 个组合页、模型索引与 2 个详情共 22 页：唯一 H1、主内容、导航、图片、alt、ID 与桌面溢出门全通过 |
| 移动与无障碍 | 390×844 与 320×568 无横向滚动；主要触控目标至少 44px；移动导航 Escape 关闭并归还焦点；章节导师图加载与 alt 正确 |
| 自动门 | 定向 36/36；全量 `npm test` 1362/1362；`npm run check`、`check:public`、strict MIME verifier、security headers 和 `git diff --check` 全部通过 |
| 服务器隔离 | `xmind_site-web-1` healthy、restart 0，仍只绑定 `172.20.0.1:18888`；共享入口、32 个现有域名、network、volume 和监听端口 pre/post 全一致 |
| 审计与回滚 | `/opt/xmind-site/audit/20260812T104309Z/`；修复前 image `sha256:0efeed057c2a9191b06ffd4b7c6770259a930a22f872db9c6be17e88e8e33399` 保留为 `xmind-site:rollback-20260812T104309Z` |
| Git 收口 | 用户已授权 commit 与 push；本记录与 MIME 修复使用同一提交推送，未跟踪的根 `AGENTS.md` 不纳入提交 |

旧 V1 图片在 V2-G6 前继续作为生产回滚版本，不覆盖、不删除、不在服务器手工替换单张图片。

### 2026-08-09 第二次工作记录

| 项目 | 结果 |
|---|---|
| V2-G2 用户视觉签字 | 2026-08-09 明确授权，13 位导师全部通过 |
| V2-G3/G4 资产接入 | `chapter-mentors.json` + `chapter-themes.json` + 13 组 AVIF/WebP；`chapter-presentation` 11/11 |
| V2-G5 自动测试 | `1062/1062`，check:public ✓，确定性双构建 hash 一致 |
| 本地构件 | `ce773a9102fd48c1f2ba33073cdae0e63dc638ec89d98c51a5a736be77bcc549`，2838 文件 |
| 本地 E2E | 1440/1024/390/320；首页、章节、模型详情、搜索通过；零外部请求；跳至正文 ✓ |
| 全页面视觉精修 | `site.css` 全面重写；`build-site.mjs` 移除 emoji，章节卡片 4:5 比例 |
| 未完成 | V2-G6 部署授权（等待用户确认 commit/push + 腾讯云镜像替换） |
| 未 commit/push | 工作区改动均未提交，未授权 |

### V3 2026-08-09 华彩人物志纠偏检查点

- [x] 明确否决“导师等于工作照”“东方等于暗沉”“历史感等于低饱和”三项错误约束。
- [x] 将场景重构为 MECE 的三类人物志：生活/游赏、宫廷/仪典、行动/天地；每章只能有一个主类。
- [x] 冻结高明度色彩门：每张 5–7 个色彩角色，320px 卡片中至少 3 个中高彩度色仍可辨识；
  肤色、头发、衣料不得纸雕化或套同色滤镜。
- [x] 研究新增 X 参考，只萃取“真实人物、朝代物件、断续线稿、系列统一且个性不同”的抽象方法；
  未向 ImageGen 提供第三方参考图，未复制人物、脸、服装、姿态、版式、文字或暗色配色。
- [x] 生成六张 V3 方向稿：班昭春日生活、武则天宫廷游赏、秦良玉策马战场，各含 A
  `华彩写实人物志` 与 B `东方仙韵工笔`。
- [x] 保存完整 prompt、prompt SHA-256、图片 SHA-256、尺寸、人工判断与权利边界；工具未暴露
  可验证的后端模型快照，因此继续明确记录为 `not exposed`。
- [x] 逐张原尺寸视觉检查：六张均无文字、水印、石膏肤质、统一发型和暗沉大面积；动作、场景
  与色彩方向通过。
- [ ] 用户选择 A、B 或明确的混合边界，并确认十三章场景主类分配。
- [ ] 仅对获选方向做第二阶段史实收紧：纠正建筑、发式、衣冠、盔甲和马具，不得因此降低亮度、
  减少鲜艳色或把人物重新变成站立工作照。
- [ ] 史实收紧后的三人样片通过视觉、历史、版权/资产签字，再进入其余十人生成。

V3 本地评审材料位于 `.local/reviews/chapter-mentor-v3/20260809-bright-scenes/`，属于被忽略的
私有工作区证据，不进入公开仓库或发布构件。

### V4 2026-08-09 东方人物视觉工作室收敛检查点

- [x] 完整阅读内部 V4.1 母提示词，确认可迁移的是身份档案、系列视觉锁、分阶段 Brief、镜头与
  灯光计划、QA 评分和按失败类型恢复，不照抄角色设定或成片文案。
- [x] 原尺寸检查 12 张内部案例，共 37 个画面；确认其编辑摄影、丝绸受光、空间留白、器物层次
  和断续线稿有参考价值，同时识别同脸、同高髻、低头侧视、桌边静态、生成文字和朝代混用风险。
- [x] 将单人物项目的 `Identity First` 改写为 13 位导师各自的 `MENTOR_IDENTITY_PROFILE`，并新增
  `SERIES_IDENTITY_COLLISION_MATRIX`，防止把同一张脸换成十三套服装。
- [x] 将系列视觉锁拆成固定项与变量：固定人物真实材质、镜头品质、线条语法、明亮色彩和网页
  排版；脸、发髻、衣冠、动作、器物与空间轴线必须按章变化。
- [x] 把“禁过度饱和”改为面积受控的华彩：55–70% 高明度空间、20–30% 时代主色、5–10% 高彩
  焦点、5–10% 深色结构；不得重新套全图灰雾或黄褐滤镜。
- [x] 冻结图片与网页职责：图片只负责人物与叙事，不生成汉字、英文、印章或标签；Typography、
  朝代、导师名、章节名与说明全部由 HTML/CSS 输出。
- [x] 建立 V4 Prompt Contract：必填身份/证据/场景/摄影/色彩/防撞字段、固定编译顺序、硬性否决、
  百分制 QA 与按失败类型回退路由；第三次同类失败时停止叠加 prompt 并审查合同冲突。
- [x] 为班昭、武则天、秦良玉分别补齐身份档案、时代证据包、场景 Brief、镜头/灯光/色彩计划，
  编译成新的可追溯提示词。
- [x] 各生成一张 C 混合方案史实精修样片；班昭、武则天、秦良玉各做一次同图定向修正，只把
  本人的本地首稿作为编辑输入，不把内部案例或第三方图片作为生成输入。
- [x] 生成三人 320×400 与 390×487 卡片安全区预览，并完成无文字、无水印、脸/手/器物裁切检查。
- [x] 用户同意班昭、武则天方向，并确认秦良玉女性身份重置候选；三张正式成为 V4 系列视觉锚点，
  该确认不等于其余十张未生成图片、生产接入、commit/push 或部署授权。
- [x] 用户签字后再制作卡片、章节 Hero 与页面合成图；V4 采用 4:5 章节框景保留完整人物，避免
  将批准的纵向叙事图破坏性强裁为 16:9，也避免在身份方向未确认前扩写衍生资产。
- [x] 完成人物、历史、摄影、叙事、网页裁切与来源六类内部评审；班昭、武则天通过视觉方向门，
  秦良玉因第二稿仍偏男性而失败。三张均为 `historical_ready=false`、`production_ready=false`。
- [x] 诊断秦良玉失败合同：宽方脸、强咬肌、厚直眉、深眼窝、宽肩、封闭头盔和低位广角形成
  男性化组合；同时重写面孔、头盔、体态、镜头与卡片脸部尺度。
- [x] 不引用两张失败图，从零生成秦良玉女性身份重置候选；原图及 320×400、390×487 预览
  通过内部身份、动作、色彩、材质与来源门，内部评分 90/100。
- [x] 提交秦良玉新身份锚点并取得用户确认。
- [x] 为其余十人编译同等级史实来源清单、独立脸部/发式/衣冠、生活/宫廷/行动场景、镜头、
  4–6 色配色、材质边界与负面约束；十份 Brief、十份 Prompt Contract、25 条来源和 13 人
  Collision Matrix 通过结构、canonical join、年龄、色彩与高风险同朝代配对验证。
- [x] 按防撞优先级顺序生成其余十人：先完成唐代高风险组徐惠/上官婉儿，再完成汉晋高风险组
  蔡琰/谢道韫/卫铄，最后完成李清照/苏蕙/王贞仪/黄道婆/谈允贤。三组都生成 320×400、
  390×487 与脸发裁切；谢道韫因与徐惠近似做一次身份单变量编辑，黄道婆因远景有异域港口歧义做
  一次背景单变量编辑。十人内部评分 89–94 分，未命中硬性否决。
- [x] 生成其余十人及全部十三人的无标签卡片总览和脸发总览，完成跨批次同脸、同髻、暗度、石化、
  手部、动作与 320×400 裁切检查。内部视觉方向门通过；李清照/苏蕙/谢道韫仍有年轻编辑摄影的
  家族相似感，王贞仪为系列唯一蓝时刻，苏蕙服饰是十六国解释性复原，均已在评审与 provenance
  中披露，等待用户最终视觉签字。
- [x] 用户确认十三人总览后，将选定原图派生为 52 个生产 WebP/AVIF，更新公开人物映射、构建
  多页站并执行桌面/移动 E2E；生产接入完成，仍未 commit/push 或部署。

V4 内部参考审计记录保存在 `.local/reviews/chapter-mentor-v4/`，原案例只读使用，不复制进仓库、
Docker context 或腾讯云构件。

本轮可追溯材料位于 `.local/reviews/chapter-mentor-v4/20260809-c-historical-pilots/`：
`briefs.json`、`prompts.json`、`edit-prompts.json`、`provenance.json`、`REVIEW.md`、六张原批次候选与
六张卡片预览；秦良玉重编材料位于其 `qin-identity-recompile/` 子目录。该目录属于被忽略的本地
评审证据，不进入公开仓库、Docker context 或线上站点。

其余十人编译材料位于 `remaining-ten-briefs/`：`source-manifest.json`、`briefs.json`、
`prompt-contracts.json`、`collision-matrix.json`、`provenance.json` 与 `REVIEW.md`。该批只有研究与
生成合同，没有生成图片，也没有改变网站资产。

### V4 2026-08-09 本地候选记录

| 项目 | 结果 |
|---|---|
| 用户视觉签字 | 十三张最终图“全部通过” |
| 版本化资产 | `v4-20260809`；13 章 × Card/Hero × AVIF/WebP = 52 文件 |
| 数据合同 | 公开映射包含版本、provenance、原图与派生 hash、尺寸、焦点和 alt；缺失即 fail closed |
| 图片预算 | 13 张 Card AVIF 318,630 bytes；WebP fallback 514,780 bytes，均低于 650 KiB |
| 自动测试 | `1063/1063`；`npm run check`、`npm run check:public`、公开 manifest 全绿 |
| 确定性 | 连续两次 2864 文件构建 hash 均为 `33b3237b0031c2badd3e1722e3d119669ecc034acf6cf80f5684bc16f780e353` |
| 本地 E2E | 13 章 V4 图片/alt/路由、桌面 1440、移动 389、导航、筛选、模型详情与 Agent Router 通过 |
| 设计 QA | `design-qa.md`：批准原图与页面同屏比对，结果 `passed` |
| 未完成 | 不可变镜像打包、腾讯云替换、生产逐文件验证与生产浏览器 E2E |

## 1A. V2 当前执行方案

### V2-G0：资料板与生成合同

- [x] 班昭、武则天、秦良玉分别收集发髻、衣冠、面料色彩、器物和空间资料；优先博物馆、
  考古报告和权威图录，影视剧照与商业汉服照不得作为史实证据。
- [x] 每个细节记录来源 URL/书目信息、权利状态和 `confirmed/inferred/adapted`；来源不确定时
  只能标为设计推断，不能写“历史准确”。
- [x] 建立结构化 `character_generation` 合同：年龄、脸部锚点、自然不对称、发缝与髻形、
  衣层/领袖腰线、面料、动作、左右手、注视对象、微表情、分区配色、构图和禁止项。
- [x] 三人角色锚点必须各自独立，不以同一人物图连续改装；共享参考仅允许迁移版式、纸艺环境、
  单一光源和色彩秩序，禁止迁移 face/hair/age/costume。
- [x] 使用内置 ImageGen 并记录提示词版本、参考 manifest 和权利边界；当前工具不公开可验证的
  后端模型快照，provenance 明确记录为 `not exposed`，不得自行写成 GPT Image 2。

验收：三份角色圣经字段完整；任一“史实确认”字段都有来源；彼此在脸、体态、发髻、衣冠、
动作、表情、器物七类中至少五类不同；用户尚未签样片时不改任何生产图片。

### V2-G1：六张对照样片

- [x] 按固定顺序编译提示词：输出契约 → 叙事瞬间 → 身份 → 史实锚点 → 脸/发 → 衣冠 →
  动作/注视 → 构图 → 材质边界 → 分区色彩 → 单一光源 → 纸艺环境 → 负面约束。
- [x] 每人生成 A `彩绘人物 × 素纸舞台` 与 B `工笔重彩人物 × 彩色剪纸剧场` 各一张。
- [x] 图片内不生成文字；不把 V1 人像作为身份参考；不使用在世艺术家姓名。
- [x] 首轮只评角色母版，不同时随机生成三种画幅；每轮只改限定变量并保留变更记录。
- [x] 保存候选原图、完整 prompt、prompt SHA-256、参考 manifest SHA-256、工具、日期和人工编辑记录。

验收：六张全部输出；皮肤、发丝、衣料与纸艺环境可一眼区分；三人不再同脸同髻；每张都有
一个明确动作、注视对象和微表情；无错代、幼态、性化、畸形手、文字或水印。

### V2-G2：样片视觉签字

- [ ] 使用设计规格 §14.1 硬性否决项和 §14.2 百分制逐张评分。
- [ ] 同时展示原尺寸、320/390 卡片裁切、1440 Hero 预览、脸部裁切、发髻黑色剪影和配色色条。
- [ ] 由视觉、历史、版权/资产三类评审分别签字，用户最终选择 A、B 或明确的混合边界。
- [ ] 若三人中任一失败，仅返工该人物或共享规则；第三次仍失败时停止叠加 prompt，审查角色
  合同、参考锚点、构图和材质边界。

验收：三人每张最终锚点 ≥85 分且无硬性否决项；用户明确批准一个系列方向。没有该记录时
不得批量生成其余十人。

### V2-G3：十三人批量生产与反同质化审计

- [x] 为其余十人完成同等级资料板、角色圣经、可执行 Prompt Contract 与 13 人 Collision Matrix；
  不降低史实、版权或提示记录标准。图片生成仍待后续分批执行。
- [x] 13 张无标签 contact sheet：评审仅凭脸部骨架、体态、髻、衣冠、动作和器物至少匹配 11/13。
- [x] 13 张脸部裁切：至少匹配 12/13；不出现同一张脸换背景。
- [x] 13 张发髻黑色剪影：逐张可区分；武则天、徐惠、上官婉儿单独并排复核。
- [x] 年龄门：13/13 均为20–35岁、明确成年的意气风发青年形象；不得幼态化。人物差异必须
  来自脸部骨架、体态、发髻、衣冠和动作，不得把青年化变成同一张白皙纤瘦网红脸。
- [x] 服色门：每张 4–6 个颜色角色，肤色自然、发色深、服色独立；不要求与页面背景同色，
  不套全图滤镜。
- [x] 史实门：发髻、衣冠、器物逐字段复核；无法确认的内容在 provenance 保留 `adapted`。

验收：13/13 ≥85 分且无硬性否决；13 个角色锚点 hash 唯一；所有来源、权利、prompt、模型和
资产 hash 可追溯；任一角色失败不以放宽验证或删除声明绕过。

### V2-G4：派生资产与网站接入

- [x] 从同一批准角色锚点确定性派生 480×600 卡片与 960×1200 章节 Hero；V4 的桌面和移动
  页面都使用 4:5 纸框陈列，不破坏性裁掉纵向人物叙事，并完整保留脸型、年龄、发式和衣冠。
- [x] 新资产采用版本化目录，不覆盖 V1；数据加入角色圣经版本、图片版本、焦点、尺寸、alt、
  caption 和 provenance 引用，缺任一项构建 fail closed。
- [x] 卡片和 Hero 分开导出，不用 4:5 母版强裁 4:3；脸、双手和主器物在 320/390px 仍可见。
- [x] AVIF/WebP 双格式、固定 width/height、srcset/sizes；首页 13 张卡片合计回到性能预算内。
- [x] 只修改图片与必要显示格式，不改变 13 章知识文本、模型合同、搜索、Router 或风险语义。

验收：同一人物跨画幅身份一致；站点无 V1/V2 串图；页面中完整人物每章一次；图片不承载
唯一知识信息，alt 使用“身份＋艺术媒介＋动作”，图注继续声明“AI 艺术化演绎，非真实肖像”。

### V2-G5：测试、构建与本地验收

- [x] 增加数据合同、13 对 13 join、差异字段、来源状态、版本路径、尺寸、hash 和 fail-closed 测试。
- [x] 运行全量 test/check/build/public gates，并连续构建两次比较路径和 bytes。
- [x] 逐章检查 320、360、390、768、1024、1440、1920；覆盖明亮主题、系统深色偏好下仍保持
  明亮主题、200% zoom、reduced motion、打印、离线和控制台。物理 Tab 顺序受当前浏览器控制层限制，
  已单列为未验证项；Escape、焦点归还、跳转链接合同和 44px 目标已分别验证。
- [x] 检查正文对比度不低于 4.5:1；图片无 CSS 反相、滤色或章节色染色。
- [x] 保存 contact sheet、桌面/移动截图、控制台、性能预算、自动测试和构件 hash 证据。

验收：自动门全绿、无未解释 warning、确定性构建成立、本地 E2E 全绿。该 Gate 不代表已获得
部署授权，也不代表 commit/push 已获授权。

### V2-G6 至 G7：用户签字、不可变部署与生产验收

- [x] 向用户提交 13 人总览、三个跨度章节全视口截图、性能和未决风险，取得明确最终视觉签字。
- [x] 再次确认只替换既有 `xmind_site` 镜像；重新采集服务器磁盘、容器、网络、端口和邻接域名基线。
- [x] 按 Runbook 构建、校验、传输并加载不可变镜像；未把项目根作为 context，未传私钥，未 prune。
- [x] 只切换 `xmind_site`；共享 Nginx、证书、其他容器、网络和卷保持不变。
- [x] 运行生产逐文件 bytes 校验、13 章浏览器 E2E、320/390px 视觉检查和邻接域名 pre/post 对比。
- [x] 保留 V1 镜像与严格回滚记录；所有 TLS、bytes、串章、图片、容器与邻接回归门均通过。

验收：生产内容与已签构件逐字节一致，13 人和各派生比例正确，容器健康，邻接应用无变化，
回滚点可用。只有此时才能称 V2 已完成生产验收。

## 2. 不可变规则

- 只在 `main` 分支开发，禁止 worktree。
- 每条 shell 命令以 `rtk` 开头。
- 写入前检查分支和工作区，不覆盖未归属的修改。
- 不手工修改 `site/` 或 `docs/`；两者只能由确定性构建生成。
- 原始 Markdown、清理全文、OCR、私人记录和受限参考图不得进入公开历史或发布构件。
- 站点运行时继续保持零外部请求、零追踪、零远程字体和零远程图片。
- 不新增 dependency，除非现有工具无法安全完成且用户明确批准。
- 没有史实与发布权证明的图片不能进入 `ready` 或生产构件。
- 不把章节导师描述成模型作者，不制造历史人物原话。
- 本地测试、Git 状态、镜像、服务器 origin、共享入口和生产 E2E 是彼此独立的门。
- 任一步失败不得继续部署，也不得宣称后续门已完成。

## 3. 文件责任图

以下是未来实施责任，不表示本轮已经创建或修改这些代码与资产。

| 文件或目录 | 唯一责任 | 修改原则 |
|---|---|---|
| `knowledge/taxonomy.json` | 13 章 ID、名称、顺序 | 不为视觉需求改变知识分类 |
| `knowledge/chapter-mentors.json`（计划） | 导师、史实边界、导语、视觉 profile、图片元数据 | 只保存公开安全的策展数据 |
| `knowledge/chapter-mentor-schema.json`（如确有必要） | 章节视觉数据合同 | 优先复用现有 validator，不为抽象而新增 |
| `tools/site-assets/images/mentors/`（计划） | 构建输入的最终授权图片 | 不保存受限参考图、工程源文件或生成秘密 |
| `tools/site-assets/site.css` | 固定骨架、13 个受约束主题和响应式降级 | 不创建 13 套页面布局 |
| `tools/site-assets/site.js` | 搜索、状态和必要交互 | 装饰原则上不增加 JavaScript |
| `tools/build-site.mjs` | 合并 taxonomy 与导师数据，确定性渲染所有页面 | 缺数据、重复导师、缺图片时 fail closed |
| `tools/validate-v3-agent-data.mjs` 或专用 validator | 视觉 profile、路径和交叉引用验证 | 不读取私有来源层 |
| `tests/*.test.mjs` | 数据、构建、无障碍、CSP、链接、确定性和发布回归 | 新行为先有可失败测试 |
| `site/` | 唯一腾讯云生产发布树 | 生成产物，禁止手改 |
| `docs/` | 与 `site/` 逐字节同步的兼容镜像 | 生成产物，禁止手改 |
| `deploy/tencent-cloud/xmind-site/context/site/` | 临时 Docker allowlist 输入 | 每次由已验证 `site/` 同步，构建后清理 |
| `.local/reviews/site-smoke/` | 截图、人工评审和本地证据 | 私有，不进入公开 Git |

如最终采用不同文件名，必须先更新本表和对应测试；不得让导师资料散落在 HTML、CSS 和多个
脚本常量中。

## 4. 角色与签字责任

| 角色 | 责任 | 不可替代的签字 |
|---|---|---|
| 产品/视觉负责人 | 品牌、六区层级、三张样卡和十三章一致性 | 样卡 Gate、批量视觉 Gate |
| 历史内容复核 | 时代服饰、器物、人物事实、争议和导语边界 | 每位导师史实状态 |
| 版权/资产复核 | 参考图权利、生成服务条款、最终资产发布权 | 每张最终图片 provenance |
| 前端实施 | 数据合同、构建器、CSS、语义 HTML 和性能 | 代码与自动测试 Gate |
| QA | 键盘、移动端、深色、打印、低动效和浏览器 E2E | 本地产品 Gate、生产 E2E Gate |
| 发布操作人 | 构件、镜像、服务器基线、入口和回滚 | 腾讯云每个外部状态门 |
| 用户 | 架构/UX 变更、commit/push、证书和生产发布授权 | 对应明确确认 |

同一人可以承担多个角色，但证据项不能省略。

## 5. Gate 总览

```text
G0 规格与范围冻结
  -> G1 三位样卡通过
  -> G2 十三位资产与数据通过
  -> G3 代码与确定性构建通过
  -> G4 本地产品 E2E 通过
  -> G5 公开构件与镜像通过
  -> G6 腾讯云 origin 通过
  -> G7 证书与共享入口通过
  -> G8 生产逐文件与浏览器 E2E 通过
  -> G9 验收记录完成
```

任何 Gate 失败都回到产生缺陷的最近阶段，不在部署阶段临时修改生成产物。

## 6. Phase 0：规格、基线与风险登记

### TODO

- [ ] 完整阅读 `AGENTS.md`、三份权威规格、README、发布清单与腾讯云 Runbook。
- [ ] 核对当前分支、HEAD、工作区归属、Node 版本和 package lock。
- [ ] 明确本批允许修改的代码、数据、图片、测试和文档文件。
- [ ] 建立风险登记：史实、版权、性能、CSP、深色、裁切、共享 Nginx 和回滚。
- [ ] 用户确认产品名、副标题、视觉系统名、十三位导师与“唐风不是统一唐装”。
- [ ] 用户确认三位样卡先行，不直接批量生产十三位。

### 现有命令

```bash
rtk git branch --show-current
rtk git rev-parse HEAD
rtk git status --short --branch
rtk node --version
rtk npm --version
```

### Gate G0

- 分支为 `main`，既有修改已辨认。
- 设计选择不改变 taxonomy、隐私边界、风险状态或运行时零网络原则。
- 本 Gate 只证明范围冻结，不证明任何资产或实现完成。

### 证据

- 规格批准记录。
- 基线 commit full SHA 与工作区清单。
- 风险登记和未决问题。

## 7. Phase 1：史实研究、角色圣经与三位样卡

### TODO

- [x] 为班昭、武则天、秦良玉分别建立来源清单与角色圣经。
- [x] 将每条材料标记为确证史实、合理推断或后世演绎。
- [x] 核对服装、发髻、器物和空间年代，排除影视剧造型。
- [x] 记录参考资料权利状态；权利不明的图片不得进入生成参考包。
- [ ] 为每位制作 4:5 卡片、16:9 桌面 Hero、4:5 移动 Hero。
- [x] 完成 A“彩绘人物 × 素纸舞台”和 B“工笔重彩人物 × 彩色剪纸剧场”的内部初审；用户
  最终视觉签字仍属于 V2-G2。
- [ ] 验证统一人物锚点、手部、衣襟、发饰、器物和安全留白。
- [ ] 完成 AVIF/WebP 优化试验，记录锁定工具、版本和参数。
- [x] 为每张候选图记录生成工具、日期、提示词 hash、参考权利和编辑记录。

### Gate G1

- 三位跨度最大的导师全部通过，不允许“其中两位通过就批量生产”。
- 网站标题和人物脸部在桌面、移动端裁切中均不冲突。
- 单张资产满足视觉规格的大小预算。
- 不存在伪历史引语、真实肖像宣称、现代妆造、跨朝代混搭或性化表达。
- 外部参考只萃取方法，不复制可识别表达。

### 回滚

- 样卡未通过时只废弃候选资产，不改站点数据和页面模板。
- 保留评审原因，不覆盖已批准角色锚点。

### 证据

- 三位角色圣经、来源清单、对比图和评审结论。
- 候选资产尺寸、文件大小、SHA-256 和 provenance。
- 1440px、390px、320px 裁切预览。

## 8. Phase 2：十三位导师资产与数据合同

### TODO

- [ ] 按批准锚点生产其余十位，不重新随机定义已批准人物。
- [ ] 每章仅使用一个唯一主纹样和最多两个辅助器物。
- [ ] 建立公开安全的导师数据文件，包含章节 ID、姓名、朝代、角色、策展导语、史实状态、
  主题 token、图片路径、尺寸、焦点、alt、caption 和 provenance 引用。
- [ ] 为浅色和深色分别定义通过对比度的章节 token。
- [ ] 数据验证恰好 13 条，章节 ID 与 taxonomy 一一对应，导师和主纹样全局唯一。
- [ ] 验证所有图片存在、扩展名和尺寸正确、路径为 canonical repo-relative path。
- [ ] 验证策展导语不含伪装成历史原话的引号或署名。
- [ ] 健康章节只提供医学史说明，不包含现代诊疗建议。
- [ ] 确认最终资产发布权；当前仓库无许可证，不能默认为可再分发。

### Gate G2

- 13/13 导师数据、角色圣经和资产完整。
- 13/13 有艺术化演绎声明与有效 alt。
- 13/13 有史实复核状态和发布权证明。
- 首页缩略图合计目标不超过 650 KiB。
- 任一缺项使整个批次保持未批准，构建不得用占位假数据悄悄通过。

### 回滚

- 单个角色不通过时回到该角色资产与数据，不修改其他已批准角色锚点。
- 不能用移除 caption、放宽验证或改成空 alt 绕过失败。

### 证据

- 13 章矩阵核对表。
- 文件大小和 SHA-256 清单。
- 史实/版权签字记录。

## 9. Phase 3：测试先行与最小实现

### 9.1 先写会失败的测试

- [ ] 导师记录数量不是 13 时失败。
- [ ] 缺章节、重复章节、重复导师或重复主纹样时失败。
- [ ] 图片缺失、路径越界、尺寸缺失、alt/caption/provenance 缺失时失败。
- [ ] taxonomy 与导师数据不能一一对应时失败。
- [ ] 构建产物含远程资源、内联危险脚本或断裂链接时失败。
- [ ] 相同输入连续构建路径或 bytes 不一致时失败。
- [ ] 模型详情页加载完整导师 Hero 时失败。
- [ ] 章节页缺完整导师图或出现两张完整导师图时失败。
- [ ] 章节色覆盖风险/复核状态时由 DOM/CSS 审计或人工门阻断。

### 9.2 最小实现顺序

- [ ] 扩展数据 validator，仅加入本规格所需字段与交叉引用。
- [ ] 构建器按章节 ID 合并 taxonomy 与导师 profile。
- [ ] 先实现三位 pilot 页面，再启用全部十三章。
- [ ] 实现首页人物卡与章节页六区；不改变搜索、Router 或模型合同。
- [ ] 模型详情页只继承章节色、微型签名和导师文本入口。
- [ ] 使用 `picture`、固定尺寸、`srcset` 和 `sizes`；Hero 优先加载，非首屏图片延迟加载。
- [ ] 主题使用外部 CSS class，不写 CSP 禁止的任意内联样式。
- [ ] 补充 900px、680px、390px、320px、深色、打印和 reduced-motion 样式。
- [ ] 装饰不新增 JavaScript；如为搜索结果可访问性修改 JS，只做最小必要变更并补测试。
- [ ] `site/` 和 `docs/` 继续由同一候选目录同步生成。

### 责任文件

```text
knowledge/chapter-mentors.json                planned
tools/build-site.mjs
tools/validate-v3-agent-data.mjs              or a narrowly scoped existing validator
tools/site-assets/site.css
tools/site-assets/site.js                     only if accessibility requires it
tools/site-assets/images/mentors/**
tests/*.test.mjs
```

### Gate G3 自动命令

```bash
rtk npm ci
rtk npm run check
rtk npm test
rtk npm run build
rtk npm run check:public
rtk npm run release:check
rtk git diff --check
```

若未来新增测试脚本，必须先在 `package.json` 定义并审查；本文不把不存在的命令写成已可用命令。

### Gate G3 验收

- 全量自动测试通过，非仅视觉相关测试通过。
- `site/` 与 `docs/` 逐字节同步。
- 连续两次相同构建路径集合和全部 hash 相同。
- 外部运行时资源、危险 HTML、断裂链接和公开残留均为零。
- 失败构建没有覆盖上一份可用站点。

### 回滚

- 构建失败保留上一份可用 `site/`；禁止手改生成产物救火。
- 回退实现时只回退本功能文件，不使用 `git reset --hard` 或宽泛 checkout。

### 证据

- RED 测试名与失败原因、GREEN 测试结果。
- `release:check` 完整日志。
- 两次构建的路径/hash 对比。
- `git diff --check` 结果。

## 10. Phase 4：视觉迭代与本地产品 E2E

### 本地服务

```bash
rtk python3 -m http.server 8765 --directory site
```

浏览器打开 `http://127.0.0.1:8765/`。截图、视频和日志只保存到
`.local/reviews/site-smoke/<UTC-timestamp>/`。

### TODO

- [ ] 首页 13 张卡：人物身份一致、标题不压脸、三列/两列/单列节奏正确。
- [ ] 13 个章节 Hero：导师、导语、模型数、六区层级和章节差异清楚。
- [ ] 章节主题不是伪按钮；如可筛选，键盘与 `aria-pressed` 正确。
- [ ] 章节搜索结果数、空状态和焦点行为正确。
- [ ] 上一章/下一章显示目标章节信息，不加载相邻大图。
- [ ] 模型详情页只继承轻量章节身份，长文没有背景噪声。
- [ ] 首页、章节、模型库、Router、模型详情、404 和页脚无断裂。
- [ ] 1920×1080、1440px、1024px、390×844、320×568 人工检查。
- [ ] 浅色、深色、200% zoom、键盘、跳至正文、Escape、焦点归还和 44px 触控检查。
- [ ] reduced motion 下无 transform、视差、平滑滚动和瞬时跳动。
- [ ] 打印隐藏高墨量装饰，保留标题、导师身份、来源、风险和 URL。
- [ ] 禁用网络后搜索、问题匹配和复制仍可用；无 fetch/XHR/WebSocket/analytics。
- [ ] 控制台无 error，关键路径无未解释 warning。

### Gate G4

- 产品/视觉、历史复核和 QA 三类签字齐全。
- 三个跨度样章与至少三个非样章均在全部视口通过；其余章节完成结构巡检。
- 关键 Web 指标达到设计预算，或记录可接受偏差和用户批准。
- 本地 E2E 通过不等于 Git 已提交、镜像已构建或生产已发布。

### 回滚

- 视觉问题回到角色资产、主题 token 或六区 CSS 的唯一 owner 修复。
- 第三次验证仍失败时停止局部 patch，审查资产裁切、DOM、CSS 继承和断点架构。

### 证据

- 各视口截图、打印 PDF/截图、深色和 reduced-motion 记录。
- 键盘路径、控制台和网络面板记录。
- 资产传输量、LCP、CLS、INP 或等价浏览器测量结果。

## 11. Phase 5：公开构件、镜像与本地容器

本阶段严格复用腾讯云 Runbook，不把项目根目录作为 Docker build context。

### TODO 与命令

```bash
rtk git status --short --branch
rtk npm ci
rtk npm test
rtk npm run check
rtk npm run build
rtk git diff --exit-code -- site/index.html
rtk npm run check:public
rtk npm run artifact:hash
```

- [ ] 将已验证 `site/` 精确同步到 `deploy/tencent-cloud/xmind-site/context/site/`。
- [ ] `rsync -rcn --delete` 无输出，证明暂存树逐字节一致。
- [ ] context 清单只含首页、404、Router、robots、sitemap、assets、chapters 和 models。
- [ ] `.env` 使用完整构件 SHA-256 和前 12 位 tag，不使用 `latest`、分支名或未提交 HEAD。
- [ ] Compose config 通过，构建 `linux/amd64` 固定 digest 镜像。
- [ ] 临时只读、non-root、cap-drop 容器通过 `/healthz`、首页 hash、CSS、Router、模型库、章节和 404。
- [ ] 导出镜像 tar 和 `.sha256`，本地校验通过。

具体同步、Compose、Docker 和 tar 命令逐字采用
`deploy/tencent-cloud/xmind-site/RUNBOOK.md` 第 3 节，避免本文形成漂移副本。

### Gate G5

- 构件 SHA、镜像 label、镜像 tag、image ID、平台和 tar SHA 全部相互绑定。
- Docker context 不含 `data/`、`.git/`、私钥、`ref/`、`.local/`、`node_modules/` 或
  `graphify-out/`。
- 本地容器通过不等于服务器已经部署。

### 回滚

- 镜像自检失败时停止，不传服务器；保留已知可用旧镜像与审计证据。
- 不执行任何 Docker prune。

## 12. Phase 6：腾讯云服务器基线与 origin

本阶段会改变外部状态，执行前必须获得用户明确部署确认。

### TODO

- [ ] 验证 DNS A、SSH ED25519 指纹、Docker/Compose 版本、磁盘和内存。
- [ ] 确认 `172.20.0.1:18888` 未占用，现有 gateway 未变化，无冲突 `xmind_site` 资源。
- [ ] 保存 pre 快照：容器、镜像、网络、volume、端口、Nginx hash 和全部现有域名 TLS。
- [ ] 只传 compose、镜像 tar 和 sha 文件，不递归传项目根目录。
- [ ] 服务器端 `sha256sum -c` 通过后才 `docker load`。
- [ ] 以 `xmind_site` 启动 origin，不修改共享入口。
- [ ] 宿主和 `ai_video_nginx` 都能访问 `http://172.20.0.1:18888/healthz`。
- [ ] origin 首页 hash 与本地已验证构件一致。

命令采用 Runbook 第 4–5 节，连接时不得使用 `StrictHostKeyChecking=no`。

### Gate G6

- Origin 健康、内容 hash 一致、无 restart loop。
- 仅创建预期容器、网络、镜像和端口；没有新 volume。
- 共享入口仍未变更，生产域名可能尚未指向新内容，因此不能宣称上线。

### 回滚

- Origin 失败时停止 Compose origin，保留镜像、tar 和审计记录。
- 不签证书、不改共享 Nginx、不删除任何其他项目资源。

## 13. Phase 7：证书与共享 Nginx 入口

这是共享基础设施变更，必须单独获得用户确认。

### TODO

- [ ] 在入口变更前重跑全部现有域名严格 TLS 基线。
- [ ] 为 `xmind.lute-tlz-dddd.top` 使用独立 ECDSA 证书 lineage。
- [ ] 保存共享 Nginx 原配置和 SHA-256 到回滚目录。
- [ ] 用 `patch-shared-nginx.py` 生成一次性候选，diff 只能含标记包围的两个 xmind server block。
- [ ] 使用临时 Nginx 容器与真实只读挂载执行 `nginx -t`。
- [ ] 候选通过后才原子安装，并按 Runbook 进行有界入口切换。
- [ ] 轮询共享入口 healthy，验证容器内配置 hash 等于候选。
- [ ] 立即重跑全部既有域名，不只抽测 xmind。

### Gate G7

- HTTP 只跳转到同 Host HTTPS。
- 证书 SAN 精确包含 xmind，严格 TLS 成功。
- 共享入口 diff、`nginx -t`、配置 hash、健康状态和既有域名回归全部通过。
- 任一既有域名结果变差立即触发回滚。

### 回滚

严格执行 Runbook 第 10 节：

1. 用临时容器验证备份。
2. 原子恢复共享 Nginx 备份。
3. 重启入口以重新挂载旧 inode并验证健康。
4. 重跑全部既有域名。
5. 停止 `xmind_site` origin。
6. 保留镜像、证书和审计证据，不执行 `down -v`、不删证书、不删镜像、不 prune。

## 14. Phase 8：生产逐文件校验与浏览器 E2E

### 自动生产门

```bash
rtk node tools/verify-production.mjs --url https://xmind.lute-tlz-dddd.top/
```

并按 Runbook 第 8 节执行严格 HTTP、TLS、`/healthz`、首页 hash、CSS、Router、模型库、章节和
404 检查，禁止 `curl -k`。

### 浏览器 E2E

- [x] 首页品牌名、副标题、13 位导师卡和 Agent 入口正确。
- [x] 13 章导师、章节标题、主题、搜索和分页通过构建合同、逐文件生产校验与签字总览，无串章。
- [x] 抽测章节模型详情，确认只继承轻量章节身份且完整协议可读。
- [x] 模型库中文搜索、结果数与空状态正确。
- [x] Router 的核心/辅助路径、清空和低置信状态正确。
- [x] Codex 提示词复制成功与失败回退都有可访问反馈。
- [x] Escape、焦点归还和 44px 目标通过；跳至正文结构与焦点样式合同通过。
- [x] 真实物理键盘完整 Tab 顺序已由用户于 2026-08-10 明确签字确认；自动门继续覆盖跳至正文、焦点样式、Escape、焦点归还和 44px 目标。
- [x] 1920×1080、1440px、390×844、320×568 通过。
- [x] 明亮主题、系统深色偏好、reduced motion 和打印通过；产品按用户决定不提供深色主题。
- [x] 禁用外部网络后本地功能仍可用，无意外运行时请求。
- [x] 容器 healthy、无 restart loop；CSP、HSTS、`nosniff`、拒绝 iframe、Referrer Policy 和 Permissions Policy 各精确出现一次。

### Gate G8

- 完整生产树逐文件 200、Content-Type 正确、无意外重定向且 bytes 与本地构件一致。
- 404 返回真实 404，不回落为伪 200 首页。
- 全部关键浏览器路径通过。
- 生产测试通过不自动授权 commit、push 或清理旧版本。

### 立即回滚条件

- TLS 或证书 SAN 失败。
- 首页或任一发布资源 hash/bytes 不一致。
- 共享 Nginx 不健康或任一既有域名回归变化。
- 创建非 allowlist Docker 资源。
- 页面资源 404、串章、不可键盘操作或关键移动端不可用。
- 容器持续重启或根盘异常增长。

## 15. Phase 9：最终验收与持续运维

### TODO

- [x] 生成 post 资源快照并与 pre 对比，只允许 `xmind_site` 镜像/容器版本切换；网络、卷、端口零变化。
- [x] 记录基线 commit full SHA、站点 artifact SHA、镜像 tag/image ID、tar SHA 和发布时间。
- [x] 记录 Nginx pre/post hash；本批未修改或切换共享入口，hash 保持一致。
- [x] 记录证书 lineage、SAN、issuer、notBefore/notAfter；本批未改证书，沿用既有续期验收。
- [x] 记录生产 2864 文件 verifier、浏览器 E2E 和 32 个既有域名 pre/post 零差异。
- [x] 记录十三位 V4 资产版本、角色圣经版本、provenance 和历史复核状态。
- [x] 原未验证项“物理键盘完整 Tab 顺序”已由用户于 2026-08-10 明确签字补齐。
- [x] 用户已于 2026-08-10 单独授权 commit、push 与 GitHub Pages；核心发布提交、Actions 和 Pages 逐文件验证均完成。

### Gate G9

只有 V2-G0 至 V2-G7 全部有证据、无未解释失败、回滚资产仍可用，才能宣称“东方彩绘导师
版本已在腾讯云生产验收”。若只完成本地部分，应精确称为“本地设计/实现/测试完成”，不得
称上线。

### 持续运维

- [ ] 证书续期 dry-run 后重跑全部既有域名回归。
- [ ] 监控 A 记录、证书到期、HTTP→HTTPS、首页、`/healthz`、容器 restart count、磁盘和日志。
- [ ] 新增或替换导师图片时重新走史实、版权、性能、确定性构建和生产逐文件门。
- [ ] 不在服务器手工替换单张图；所有修正从公开安全输入重新构建完整 `site/`。

## 16. 最终证据清单

```text
范围证据
  branch / full HEAD / git status / approved file list

内容与资产证据
  13 role bibles / historical sources / rights / prompts / asset hashes

开发证据
  RED tests / GREEN tests / full test / release:check / diff-check

本地产品证据
  viewport screenshots / keyboard / dark / print / reduced motion / performance

构件证据
  site+docs identity / artifact SHA / image ID / tar SHA / context allowlist

服务器证据
  pre+post resources / port / disk / origin health / existing-domain regressions

入口证据
  certificate / Nginx hashes / diff / nginx -t / bounded switch / rollback readiness

生产证据
  production verifier / TLS / headers / content bytes / browser E2E / timestamp
```

任一证据缺失时，报告必须写“未验证”，不能用人工印象、旧截图或上一版本日志替代。
