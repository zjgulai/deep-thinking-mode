# xmind 腾讯云隔离部署 Runbook

适用目标：

- 主机：`101.34.52.232` / `VM-0-16-ubuntu`
- 用户：`ubuntu`
- 域名：`xmind.lute-tlz-dddd.top`
- 公网入口：现有 `ai_video_nginx`
- 新 Compose project：`xmind_site`
- 新专属 bridge 网络：`xmind_site_internal`
- 唯一宿主暴露：`172.20.0.1:18888 -> web:8080`

本方案是同一 rootful Docker daemon 内的 Compose 软隔离。它隔离容器、网络、名称、日志、资源和构建上下文，但公网 80/443 仍必须通过现有共享入口。服务器当前的 Docker 26.1 不会为 `internal: true` bridge 创建已声明的宿主端口映射，因此专属网络不能标记为 internal；静态 Nginx 理论上拥有出站网络，但不会加入任何现有应用网络。如果要求 daemon、内核、网络出口、入口也完全隔离，必须改用独立 VM/公网 IP。

## 1. 不可变安全边界

- 不得把项目根目录作为 Docker build context。
- 不得使用 `COPY .` 或 `ADD .`。
- 只允许把已通过公开产物检查的 `site/` 发布树显式同步到 `context/site/`。
- `DDDD.pem`、`data/`、`.git/`、`ref/`、`ref-extracted/`、`node_modules/`、`.local/`、`graphify-out/` 绝不得进入构建上下文、镜像、传输包或服务器发布目录。
- 禁止空闲期顺手执行 `docker system prune`、`docker image prune`、`docker volume prune` 或删除任何非 `xmind_site` 资源。
- 不把新容器加入 `lighthouse_ai_video_net`。入口只经宿主 bridge gateway 的候选端口转发。
- 不修改 Docker daemon、UFW/nftables、其他 Compose project 或其容器。
- 不删除旧镜像、旧证书或 Nginx 备份；先完成验收与回滚演练。

## 2. 构建上下文 allowlist

Docker build context 固定为本目录：

```text
deploy/tencent-cloud/xmind-site/
```

`.dockerignore` 先用 `**` 拒绝全部路径，再只放行：

```text
.dockerignore
Dockerfile
nginx/nginx.conf
context/site/index.html
context/site/404.html
context/site/router.html
context/site/robots.txt
context/site/sitemap.xml
context/site/assets/**
context/site/chapters/**
context/site/models/**
```

`Dockerfile` 中也只有两个精确 `COPY`：容器 Nginx 配置和经过 allowlist 的站点暂存目录。`context/site/` 的发布产物被 Git 忽略，只在每次构建前暂存，镜像完成后删除。

`site/` 是多页静态站，首页还依赖 `assets/`、`chapters/`、`models/`、`router.html`、`404.html`、`robots.txt` 和 `sitemap.xml`。缺少任一类都不是可发布镜像。`.dockerignore` 仍采用默认拒绝，只放行上述路径；即使误把其他项目文件放进暂存目录，也不会进入 Docker build context。

## 3. 发布门与本地构建

先在项目根目录完成站点发布检查。任一步失败都不得继续：

```bash
rtk git status --short --branch
rtk npm ci
rtk npm test
rtk npm run check
rtk npm run build
rtk git diff --exit-code -- site/index.html
rtk npm run check:public
```

从已验证产物创建唯一的临时 build context 输入：

```bash
rtk install -d -m 0755 deploy/tencent-cloud/xmind-site/context/site
rtk rsync -a --delete --exclude='.gitignore' --exclude='.DS_Store' site/ deploy/tencent-cloud/xmind-site/context/site/
rtk rsync -rcn --delete --exclude='.gitignore' --exclude='.DS_Store' site/ deploy/tencent-cloud/xmind-site/context/site/
rtk zsh -lc 'find deploy/tencent-cloud/xmind-site/context/site -type f ! -name .gitignore -print | LC_ALL=C sort > /tmp/xmind-site-context-files.txt && wc -l /tmp/xmind-site-context-files.txt'
```

第二条 `rsync` 必须无输出，证明源发布树与暂存树逐字节一致。清单中的相对路径必须只属于 `index.html`、`404.html`、`router.html`、`robots.txt`、`sitemap.xml`、`assets/`、`chapters/` 或 `models/`。再生成完整构件 hash，创建本地环境文件，并把完整值及其前 12 位分别写入 `.env`：

```bash
rtk cp deploy/tencent-cloud/xmind-site/.env.example deploy/tencent-cloud/xmind-site/.env
rtk npm run artifact:hash
```

使用编辑器修改 `.env`，不得使用 `local`、`latest`、分支名或未提交的 Git HEAD 作为生产 tag。工作区发布以完整构件 SHA-256 为权威版本标识。

验证 Compose，再构建固定的 `linux/amd64` 镜像：

```bash
rtk docker compose --project-directory deploy/tencent-cloud/xmind-site --env-file deploy/tencent-cloud/xmind-site/.env config --quiet
rtk docker compose --project-directory deploy/tencent-cloud/xmind-site --env-file deploy/tencent-cloud/xmind-site/.env build --pull
rtk docker image inspect xmind-site:<12-char-artifact-sha> --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "com.lute.artifact.sha256"}}'
```

预期为 `linux/amd64 <64-char-artifact-sha>`。基础镜像已固定为 Docker Official Image `nginx:1.29.8-alpine` 的 linux/amd64 manifest digest，不使用浮动 tag。

临时运行镜像自检，不得复用生产端口：

```bash
rtk docker run --rm --platform linux/amd64 --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m -p 127.0.0.1:18889:8080 xmind-site:<12-char-artifact-sha>
rtk curl -fsS http://127.0.0.1:18889/healthz
rtk curl -fsS http://127.0.0.1:18889/ -o /tmp/xmind-site-index.html
rtk shasum -a 256 site/index.html /tmp/xmind-site-index.html
rtk curl -fsS http://127.0.0.1:18889/assets/site.css -o /tmp/xmind-site.css
rtk curl -fsS http://127.0.0.1:18889/router.html -o /tmp/xmind-site-router.html
rtk curl -fsS http://127.0.0.1:18889/models/index.html -o /tmp/xmind-site-models.html
rtk curl -fsS http://127.0.0.1:18889/chapters/ch00-overview-and-toolbox.html -o /tmp/xmind-site-chapter.html
rtk curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18889/definitely-missing.html
```

首条命令会占用当前终端；用第二个终端完成检查后用 `Ctrl-C` 退出。两个首页 HTML hash 必须一致，CSS、路由器、模型目录与章节必须返回 200，不存在的路径必须返回 404。

导出不可变镜像包：

```bash
rtk install -d -m 0755 deploy/tencent-cloud/xmind-site/dist
rtk docker image save -o deploy/tencent-cloud/xmind-site/dist/xmind-site-<12-char-artifact-sha>-linux-amd64.tar xmind-site:<12-char-artifact-sha>
rtk zsh -lc 'cd deploy/tencent-cloud/xmind-site/dist && shasum -a 256 xmind-site-<12-char-artifact-sha>-linux-amd64.tar > xmind-site-<12-char-artifact-sha>-linux-amd64.tar.sha256'
rtk zsh -lc 'cd deploy/tencent-cloud/xmind-site/dist && shasum -a 256 -c xmind-site-<12-char-artifact-sha>-linux-amd64.tar.sha256'
```

`.sha256` 使用镜像包的 basename，可被服务器端 `sha256sum -c` 直接解析；服务器上 `docker load` 前必须再比对。

## 4. 服务器发布前基线

下列命令均为发布阶段，不在准备本 Runbook 时执行。连接时应使用已人工确认的 ED25519 指纹，不再使用 `StrictHostKeyChecking=no`。

上线前重新确认：

```bash
rtk dig +short A xmind.lute-tlz-dddd.top
rtk ssh-keygen -lf <(rtk ssh-keyscan -T 5 -t ed25519 101.34.52.232 2>/dev/null)
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'uname -a; docker version; docker compose version; df -h /; free -h'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker network inspect lighthouse_ai_video_net --format "{{(index .IPAM.Config 0).Subnet}} {{(index .IPAM.Config 0).Gateway}}"'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'ss -ltn "( sport = :18888 )"; docker ps --filter publish=18888'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker ps -a --filter name=xmind; docker network ls --filter name=xmind; docker volume ls --filter name=xmind; docker images --filter reference="xmind-site:*"'
```

必须同时满足：

- A 记录仍是 `101.34.52.232`。
- SSH 指纹仍是经用户确认的值。
- `lighthouse_ai_video_net` 仍是 `172.20.0.0/16`，gateway 仍是 `172.20.0.1`。
- `172.20.0.1:18888` 无监听、无已发布容器。
- 没有同名 `xmind_site` 资源。
- 根盘剩余空间足以同时保留新镜像和至少一个回滚版本。

先保存部署前资源清单和现有域名烟测结果。建议审计目录为 `/opt/xmind-site/audit/<UTC-timestamp>/pre/`，至少包含：

```text
docker-ps.txt
docker-images.txt
docker-networks.txt
docker-volumes.txt
listening-ports.txt
nginx-config.sha256
existing-domains.tsv
```

资源清单必须使用稳定排序格式。现有域名列表位于 `existing-domains.txt`；对每个域名记录严格 TLS 校验的 HTTP code、remote IP 和证书校验结果。发布后用同一脚本和列表重跑，只允许 xmind 新增变化。

## 5. 传输与启动 origin

只传输精确文件，禁止对项目根目录使用 `scp -r`、`rsync` 或 tar：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo install -d -o ubuntu -g ubuntu -m 0755 /opt/xmind-site/current /opt/xmind-site/audit /opt/xmind-site/rollback'
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/compose.yaml ubuntu@101.34.52.232:/opt/xmind-site/current/compose.yaml
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/dist/xmind-site-<12-char-artifact-sha>-linux-amd64.tar ubuntu@101.34.52.232:/opt/xmind-site/current/
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/dist/xmind-site-<12-char-artifact-sha>-linux-amd64.tar.sha256 ubuntu@101.34.52.232:/opt/xmind-site/current/
```

在服务器端校验、加载并启动：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'cd /opt/xmind-site/current && sha256sum -c xmind-site-<12-char-artifact-sha>-linux-amd64.tar.sha256'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker load -i /opt/xmind-site/current/xmind-site-<12-char-artifact-sha>-linux-amd64.tar'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'printf "%s\n" "XMIND_ARTIFACT_SHA256=<64-char-artifact-sha>" "XMIND_IMAGE_TAG=<12-char-artifact-sha>" > /opt/xmind-site/current/.env'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'cd /opt/xmind-site/current && docker compose --project-name xmind_site config --quiet'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'cd /opt/xmind-site/current && docker compose --project-name xmind_site up -d --no-build --pull never --wait'
```

只验证 origin，暂不修改共享 Nginx：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker compose -p xmind_site -f /opt/xmind-site/current/compose.yaml ps'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'curl -fsS http://172.20.0.1:18888/healthz'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker exec ai_video_nginx wget -q -O - http://172.20.0.1:18888/healthz'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'curl -fsS http://172.20.0.1:18888/ -o /tmp/xmind-origin.html && sha256sum /tmp/xmind-origin.html'
```

如 origin 不健康、内容 hash 不一致或共享入口容器无法访问 `172.20.0.1:18888`，到此停止，不签证书，不改入口。

## 6. xmind 专属证书

现有 HTTP default server 已将 `/.well-known/acme-challenge/` 映射到 `/var/www/certbot`，`/etc/letsencrypt` 也已只读挂载到 `ai_video_nginx`。不扩容现有巨型多 SAN 证书，为 xmind 创建独立 ECDSA 证书：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo certbot certonly --webroot -w /var/www/certbot --cert-name xmind.lute-tlz-dddd.top -d xmind.lute-tlz-dddd.top --key-type ecdsa'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo certbot certificates --cert-name xmind.lute-tlz-dddd.top'
```

证书必须存在于：

```text
/etc/letsencrypt/live/xmind.lute-tlz-dddd.top/fullchain.pem
/etc/letsencrypt/live/xmind.lute-tlz-dddd.top/privkey.pem
```

现有 Certbot deploy hook 会在任何证书签发/续期后 reload `ai_video_nginx`。这是已存在的全局耦合；签发前必须先保存现有域名基线，签发后立即重跑。

## 7. 共享入口变更

共享主配置不 include `conf.d/*.conf`，因此不能直接部署独立文件。必须把 `nginx/xmind-edge-server-blocks.conf.template` 内的两个 server block 精确插入现有 `http { ... }`。

先备份并记录原始 hash：

```bash
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/nginx/xmind-edge-server-blocks.conf.template ubuntu@101.34.52.232:/opt/xmind-site/current/
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo sha256sum /opt/ai-video/deploy/lighthouse/nginx.conf'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo install -m 0644 /opt/ai-video/deploy/lighthouse/nginx.conf /opt/xmind-site/rollback/nginx.conf.pre-xmind'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo sha256sum /opt/xmind-site/rollback/nginx.conf.pre-xmind /opt/ai-video/deploy/lighthouse/nginx.conf'
```

使用 `patch-shared-nginx.py` 对唯一的顶层 `http {}` 做一次有标记、拒绝重复的插入，不手工编辑或全局替换。先生成独立候选并验证 diff：

```bash
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/patch-shared-nginx.py ubuntu@101.34.52.232:/opt/xmind-site/current/
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'cd /opt/xmind-site/current && python3 patch-shared-nginx.py --base /opt/ai-video/deploy/lighthouse/nginx.conf --snippet xmind-edge-server-blocks.conf.template --output nginx.conf.candidate'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo diff -u /opt/xmind-site/rollback/nginx.conf.pre-xmind /opt/xmind-site/current/nginx.conf.candidate'
```

`diff` 必须只包含标记包围的 xmind HTTP/HTTPS server block。现有入口把主配置作为单文件只读 bind mount；原子替换宿主文件后，运行中的容器仍固定在旧 inode。不能用容器内原配置的 `nginx -t` 或 HUP reload 证明候选有效。

先用临时容器复用现有入口的全部只读挂载和同一网络，对候选配置做真实语法与依赖解析检查：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker run --rm --name xmind_nginx_config_test --network lighthouse_ai_video_net --volumes-from ai_video_nginx:ro -v /opt/xmind-site/current/nginx.conf.candidate:/etc/nginx/nginx.conf:ro nginx:alpine nginx -t'
```

成功后原子安装候选，并对共享入口执行一次有界重启，使 bind mount 指向新 inode。必须轮询到 healthy，再确认容器内配置 hash 等于候选；任一步失败都立刻原子恢复备份并再次启动旧入口。重启前后都必须执行 32 域名严格 TLS 基线。这里无法做到入口零耦合；若不能接受秒级共享入口切换，必须改用独立 VM/IP。

## 8. E2E 和产品验收

从公网严格检查，禁止 `curl -k`：

```bash
rtk curl -sSI http://xmind.lute-tlz-dddd.top
rtk curl -fsSIL https://xmind.lute-tlz-dddd.top
rtk openssl s_client -connect xmind.lute-tlz-dddd.top:443 -servername xmind.lute-tlz-dddd.top </dev/null 2>/dev/null | rtk openssl x509 -noout -subject -issuer -dates -ext subjectAltName
rtk curl -fsS https://xmind.lute-tlz-dddd.top/healthz
rtk curl -fsS https://xmind.lute-tlz-dddd.top/ -o /tmp/xmind-production.html
rtk shasum -a 256 site/index.html /tmp/xmind-production.html
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/assets/site.css
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/router.html
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/models/index.html
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/chapters/ch00-overview-and-toolbox.html
rtk curl -sS -o /dev/null -w '%{http_code}\n' https://xmind.lute-tlz-dddd.top/definitely-missing.html
rtk npm run verify:security
```

必须满足：

- HTTP 仅 301 到同 Host HTTPS。
- TLS 严格校验成功，SAN 精确包含 xmind。
- `/healthz` 是 `ok`。
- `/` 为 200，且 bytes hash 与已验证本地 `site/index.html` 相同。
- CSS、路由器、模型目录和章节为 200；不存在的路径为 404，不能回落成伪 200 首页。
- 页面 title 为系统化思维，不再是 `Short Video Factory`。
- CSP、HSTS、`nosniff`、拒绝 iframe、Referrer Policy 和 Permissions Policy 各出现一次且值精确匹配；不得因 origin 与共享入口叠加而重复。
- 容器稳定为 healthy，无 restart loop。

浏览器 E2E 至少覆盖：

- 首页、13 章导航、搜索、问题匹配、Codex 提问复制。
- 模型 hash anchor 直达与刷新。
- 键盘、可见焦点、Escape、焦点归还、reduced motion。
- 1440px、390px、320px，浅色/深色，打印。
- 禁用网络后搜索和问题匹配仍可用，没有 fetch/XHR/WebSocket/analytics。

## 9. 前后资源差异与现有应用回归

用第 4 节的完全相同命令生成 `post/` 快照，并与 `pre/` 比较。只允许：

- 新增 Compose project `xmind_site`。
- 新增一个 `xmind_site-web-1` 容器。
- 新增一个 `xmind_site_internal` bridge network。
- 新增一个 `xmind-site:<12-char-artifact-sha>` 镜像。
- 新增 `172.20.0.1:18888` 监听。
- 新增 xmind 专属证书和两个 Nginx server block。

不允许：

- 任何新 volume。
- 除已记录的 `ai_video_nginx` 单次配置切换重启外，任何现有容器被 recreate/restart，或其 image/network/mount/port 变化。
- 现有域名 code、remote IP、TLS 严格校验结果变差。
- 根盘突然增长超过镜像+审计文件的合理体积。

现有域名回归不得只抽测 xmind。使用 `existing-domains.txt` 中同一顺序的全部域名重跑严格 HTTPS 检查并比对 pre/post。

## 10. 回滚

任一条件触发回滚：TLS 失败、xmind 错误页、内容 hash 不符、共享 Nginx 不健康、现有域名回归变差、不在 allowlist 的 Docker 资源变化。

先用第 7 节的临时容器方式验证备份，再恢复共享入口。由于主配置是单文件 bind mount，原子恢复后也必须重启一次才能重新挂载旧 inode：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo install -m 0644 /opt/xmind-site/rollback/nginx.conf.pre-xmind /opt/ai-video/deploy/lighthouse/nginx.conf'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker restart --time 30 ai_video_nginx'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'docker exec ai_video_nginx nginx -t && docker inspect ai_video_nginx --format "{{.State.Status}} {{.State.Health.Status}}"'
```

重跑全部现有域名回归。共享入口完全恢复后，停止 xmind origin，但不立即删镜像、证书或审计证据：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'cd /opt/xmind-site/current && docker compose --project-name xmind_site stop'
```

回滚时不执行 `down -v`、不删证书、不删镜像、不执行任何 prune。只有在故障复盘完成并获得单独确认后，才可精确清理 `xmind_site` 自身资源。

## 11. 证书续期与持续验证

首次上线后验证 xmind 独立 renewal lineage：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo certbot renew --cert-name xmind.lute-tlz-dddd.top --dry-run'
rtk curl -fsSIL https://xmind.lute-tlz-dddd.top
```

因现有 deploy hook 会 reload 共享 Nginx，dry-run 后再次执行全域名回归。长期监控至少覆盖：

- 域名 A 记录漂移。
- 证书 SAN/到期时间。
- HTTP -> HTTPS 跳转。
- 严格 TLS 下首页和 `/healthz`。
- xmind 容器 health/restart count。
- 根盘空间和 Docker `json-file` 日志体积。
- 全部现有关键域名的严格 HTTPS 烟测。

## 12. 验收记录

验收报告必须记录：

- 本地 commit full SHA、`site/index.html` SHA-256、镜像 tag/image ID/archive SHA-256。
- 服务器上加载后 image ID 与 image platform。
- pre/post Docker 资源差异、端口差异、根盘差异。
- Nginx 原配置 hash、备份 hash、新配置 hash、临时容器 `nginx -t`、入口重启与健康恢复结果。
- 证书 lineage、SAN、issuer、notBefore/notAfter 与 renewal dry-run。
- xmind HTTP/TLS/内容 hash/E2E 结果。
- `npm run verify:security` 的 CSP 与单一安全头结果。
- 全部现有域名 pre/post 回归差异。
- 未验证项、原因和责任人。

只有上述全部门通过，才能宣称腾讯云部署已验收。

## 13. 官方依据

- Docker build context 与 `.dockerignore`：<https://docs.docker.com/build/concepts/context/>
- Docker Compose services（`read_only`、`cap_drop`、`security_opt`、资源限额、healthcheck）：<https://docs.docker.com/reference/compose-file/services/>
- Docker user-defined bridge 与端口发布：<https://docs.docker.com/engine/network/drivers/bridge/>
- Docker `json-file` 日志轮转：<https://docs.docker.com/engine/logging/drivers/json-file/>
- Docker multi-platform build：<https://docs.docker.com/build/building/multi-platform/>
- Docker Official Image nginx：<https://hub.docker.com/_/nginx/>
- Nginx 信号与优雅 reload：<https://nginx.org/en/docs/control.html>
- Certbot 稳定文档：<https://eff-certbot.readthedocs.io/en/stable/>
