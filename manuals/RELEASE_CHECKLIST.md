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
rtk npm test
rtk npm run build
rtk npm run check:public
rtk git diff --check
```

验收：

- [ ] 2789 个 V3 模型 schema、ID、taxonomy 和 Agent 路由契约通过。
- [ ] 公开模型残留为 0。
- [ ] `site/` 和 `docs/` 完整同步。
- [ ] 构建连续执行两次结果相同。
- [ ] 首页、模型库、章节、详情、Router、404、robots 和 sitemap 均存在。
- [ ] 全量测试包含 public artifact 和 production verifier 的对抗用例。

## Gate 2：产品 E2E

桌面至少验证 1920×1080，移动端至少验证 390×844 和 320×568：

- [ ] 首页 Hero、导航、策展、Agent 流程和十三章无溢出、截断或错位。
- [ ] 模型库按中文关键词筛选，结果数和空状态正确。
- [ ] 章节筛选、章节翻页和模型翻页正确。
- [ ] Router 对诊断+计划复合问题返回核心与辅助路径，清空状态正确。
- [ ] 模型详情可复制提示词并产生可访问的状态反馈。
- [ ] 键盘导航、Escape 关闭菜单、跳至正文和 44px 触控目标可用。
- [ ] 控制台无 error，关键页面无 warning。
- [ ] `prefers-reduced-motion`、深色偏好和打印布局无致命问题。

## Gate 3：镜像

- [ ] 构建输入仅来自已验证 `site/`，暂存目录与源逐字节一致。
- [ ] 镜像 tag 使用可追溯版本或构件 hash，不使用 `latest`。
- [ ] 基础镜像 digest、目标架构 `linux/amd64` 和 OCI revision 标签正确。
- [ ] 临时容器 `/healthz`、首页、CSS、Router、模型库、章节、404 全部通过。
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
rtk node tools/verify-production.mjs --url https://xmind.lute-tlz-dddd.top/
```

- [ ] 完整生产树逐文件返回 200、正确 Content-Type、无意外重定向且字节一致。
- [ ] HTTP 301 到正确 HTTPS 域名，证书 SAN 正确，404 返回 404。
- [ ] 生产浏览器重跑首页、搜索、路由、复制和移动端关键路径。
- [ ] 容器健康、重启策略、资源限制、只读和 non-root 配置符合预期。
- [ ] 保存生产截图、验证日志、镜像 digest、构件 hash 与发布时间。

## 立即回滚条件

出现以下任一情况立即停止或回滚：共享 Nginx `-t` 失败；既有域名回归变化；证书不匹配；origin hash 不符；生产有资源 404；创建了非预期 Docker 资源；根盘异常增长；容器无法在限制条件下稳定运行。

回滚顺序：恢复共享 Nginx 备份并验证/reload → 停止 `xmind_site` Compose → 保留审计日志和镜像 tar → 重新验证既有域名。不得在故障排查中清理其他项目资源。
