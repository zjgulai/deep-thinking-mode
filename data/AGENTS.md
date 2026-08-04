# 项目协作指引

在修改资料处理流程、知识目录、模型内容、Codex 应用卡或发布页面前，必须先阅读：

- `docs/superpowers/specs/2026-07-27-brain-model-knowledge-system-design.md`
- `docs/superpowers/specs/2026-07-30-systematic-thinking-site-design.md`（修改网站信息架构、视觉、交互或发布页面时）

网站产品合同以 `2026-07-30-systematic-thinking-site-design.md` 为准：产品名为「系统化思维」，公开仓库为 `https://github.com/zjgulai/deep-thinking-mode`，GitHub Pages 子路径为 `/deep-thinking-mode/`。资料隐私、安全、来源证据和单文件离线约束仍以知识系统总规格为准；网站的信息架构、视觉、交互、响应式和发布页面表现以网站设计规格为准。

长期约束：

- 原始 Markdown、清理全文、OCR 结果和私人共学记录只保留本地，不得进入公开 Git 历史或 GitHub Pages 构件。
- 公开仓库只包含综合知识、来源索引、构建与检查工具、说明文档和 `site/` 发布产物。
- 每份资料只归入一个主章节；跨主题关系使用标签和模型关联表达。
- 不凭标题补写图片型或抓取不完整资料；使用 `needs_ocr`、`needs_review` 或 `fetch_failed` 明确记录状态。
- 每个去重后的知识模型或方法必须包含「与 Codex 共学应用卡」。
- 新增资料后必须更新来源索引、对应模型、章节关系、问题匹配规则和完整 HTML，并通过设计规格中的验收检查。
- 未经用户明确确认，不得 commit、push 或发布。
