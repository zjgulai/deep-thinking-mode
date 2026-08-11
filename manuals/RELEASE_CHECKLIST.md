# 产品发布与验收清单

本清单把本地成功、Git 成功、服务器部署和生产验收分成独立门。任何一门失败都不得宣称“已发布”。

## Gate 0：范围与回滚

- [ ] 当前分支为 `main`，工作区中的既有改动已辨认且未被覆盖。
- [ ] 私钥只用于 SSH，权限为 `0600`，被 `.gitignore` 和 Docker context 排除。
- [ ] 明确本次允许创建的容器、网络、镜像、目录、证书和入口配置增量。
- [ ] 已保存共享 Nginx 原配置与 hash，回滚命令经过复核。
- [ ] 禁止运行任何全局 Docker prune 或删除其他应用资源。

## Gate 1：数据与产品构件

```bash
rtk npm ci
rtk npm run check
rtk node --test tests/router-engine.test.mjs tests/router-controller.test.mjs tests/router-page.test.mjs tests/combination-workshop.test.mjs
rtk node --test tests/public-artifact.test.mjs tests/production-verifier.test.mjs
rtk npm test
rtk npm run build
rtk npm run check:public
rtk diff -qr site docs
rtk git diff --check
```

验收：

- [ ] 2789 个 V3 模型 schema、ID、taxonomy 和 Agent 路由契约通过。
- [ ] Router loader 输出 8 类问题、8 个 Agent 阶段、23 条稀疏路由、5 条 Chain 与 24 个 phase，所有稳定 ID 交叉引用成立。
- [ ] 冻结的 96 条 Router 语料全部通过；期望分布为 80 `matched`、8 `clarify`、8 `safety_stop`，7 条生产复现句无 `unavailable`。这是回归门，不是 holdout 准确率。
- [ ] `idle`、`needs_input`、`matched`、`clarify`、`safety_stop` 五状态互斥；澄清最多一轮，安全停止不显示自助解决链。
- [ ] Router compact payload 不超过 96 KiB；当前期望证据为 7,460 UTF-8 bytes、23/23 route card 与 `route_keys` 一一对应，两个 `.mjs` 与源资产逐字节相同。
- [ ] 公开模型残留为 0。
- [ ] `site/` 和 `docs/` 完整同步。
- [ ] 构建连续执行两次结果相同。
- [ ] 首页、模型库、章节、详情、Router、组合工坊总览、5 个组合详情、404、robots 和 sitemap 均存在。
- [ ] 首页和 Router 可进入组合；每个被 Chain 引用的模型详情与章节页的反向入口数精确等于 validated build view，无引用时不输出空区块。
- [ ] 全量测试包含 public artifact 和 production verifier 的对抗用例。

双构建证据不能只记录“命令通过”：

```bash
rtk npm run build
rtk node tools/hash-public-artifact.mjs site
rtk diff -qr site docs
rtk npm run build
rtk node tools/hash-public-artifact.mjs site
rtk diff -qr site docs
```

两次必须输出相同的完整 artifact SHA-256 和文件数，两次 `diff -qr` 均无输出。

## Gate 2：产品 E2E

桌面至少验证 1920×1080，移动端至少验证 390×844 和 320×568：

- [ ] 首页 Hero、导航、策展、Agent 流程和十三章无溢出、截断或错位。
- [ ] 模型库按中文关键词筛选，结果数和空状态正确。
- [ ] 章节筛选、章节翻页和模型翻页正确。
- [ ] Router 对诊断+计划复合问题返回核心与辅助路径，清空状态正确。
- [ ] 歧义输入只追问一次；选择澄清答案后核心/辅助路由正确，且最多只激活一条核心 Chain。
- [ ] 组合工坊 5 个详情页的输入、阶段、交接、检查点、停止/回环和复合 Prompt 可阅读、可键盘到达。
- [ ] 模型详情可复制提示词并产生可访问的状态反馈。
- [ ] 键盘导航、Escape 关闭菜单、跳至正文和 44px 触控目标可用。
- [ ] 控制台无 error，关键页面无 warning。
- [ ] `prefers-reduced-motion`、深色偏好和打印布局无致命问题。

## Gate 3：镜像

- [ ] 构建输入仅来自已验证 `site/`，暂存目录与源逐字节一致。
- [ ] Docker context 仍精确为 `deploy/tencent-cloud/xmind-site/`；deny-all allowlist 放行 `combinations/**` 与 `assets/**`，不扩大到项目根。
- [ ] 暂存树包含 `combinations/index.html`、5 个组合详情与 `assets/router-engine.mjs`、`assets/router-controller.mjs`；暂存树和源 `site/` 的 artifact SHA-256 及文件数一致。
- [ ] `.git/`、`data/`、`.local/`、`DDDD.pem` 均在 context 外；即使同名文件误放入 context，deny-all 也不允许其进入 daemon。
- [ ] 镜像 tag 使用可追溯版本或构件 hash，不使用 `latest`。
- [ ] 基础镜像 digest、目标架构 `linux/amd64` 和 OCI revision 标签正确。
- [ ] 临时容器 `/healthz`、首页、CSS、Router、两个 `.mjs`、组合总览/详情、模型库、章节、404 全部通过。
- [ ] 镜像 tar 生成 SHA-256，并在传输前后各校验一次。

## Gate 4：服务器基线

- [ ] DNS A 记录仍指向目标主机，SSH ED25519 指纹与已确认值一致。
- [ ] 根盘剩余空间足以保留新镜像和一个回滚版本；不执行 prune。
- [ ] `172.20.0.1:18888` 未占用，现有 Docker gateway 未变化。
- [ ] 保存容器、镜像、网络、volume、端口、Nginx hash 和现有域名 TLS 基线。
- [ ] 服务器上不存在冲突的 `xmind_site` 资源。

## Gate 5：Origin、证书与入口

- [ ] `xmind_site` 仅创建预期容器和独立内部网络。
- [ ] 宿主和共享入口容器均能访问 origin `/healthz`。
- [ ] 专属证书只包含 `xmind.lute-tlz-dddd.top`，严格 TLS 校验通过。
- [ ] 共享 Nginx diff 只增加 xmind 的两个 server block。
- [ ] `nginx -t` 成功后才 graceful reload。
- [ ] 现有域名发布前后结果一致。

## Gate 6：生产验收

```bash
rtk node tools/verify-production.mjs --url https://xmind.lute-tlz-dddd.top/ --site-dir site
```

- [ ] 该命令只在候选镜像实际切换后执行；完整生产树逐文件返回 200、正确 Content-Type、无意外重定向且 bytes 一致。验证日志的 checked-files 必须等于当次本地 artifact 文件数。
- [ ] `combinations/index.html`、5 个组合详情、`assets/router-engine.mjs` 和 `assets/router-controller.mjs` 全部包含在逐文件记录中；任一 404、Content-Type 错误、转向或 byte mismatch 都必须 exit 1。
- [ ] HTTP 301 到正确 HTTPS 域名，证书 SAN 正确，404 返回 404。
- [ ] 生产浏览器重跑首页、搜索、路由、复制和移动端关键路径。
- [ ] 容器健康、重启策略、资源限制、只读和 non-root 配置符合预期。
- [ ] 保存生产截图、验证日志、镜像 digest、构件 hash 与发布时间。

> 当前 Router 2.0/组合工坊候选尚未部署；Gate 6 在实际镜像切换和逐文件验证前必须保持未勾选。

## 立即回滚条件

出现以下任一情况立即停止或回滚：共享 Nginx `-t` 失败；既有域名回归变化；证书不匹配；origin hash 不符；生产有资源 404；创建了非预期 Docker 资源；根盘异常增长；容器无法在限制条件下稳定运行。

回滚顺序：恢复共享 Nginx 备份并验证/reload → 停止 `xmind_site` Compose → 保留审计日志和镜像 tar → 重新验证既有域名。不得在故障排查中清理其他项目资源。
