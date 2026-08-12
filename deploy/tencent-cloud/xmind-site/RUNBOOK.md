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
context/site/combinations/**
context/site/models/**
```

`Dockerfile` 中也只有两个精确 `COPY`：容器 Nginx 配置和经过 allowlist 的站点暂存目录。`context/site/` 的发布产物被 Git 忽略，只在每次构建前暂存，镜像完成后删除。

`site/` 是多页静态站，首页还依赖 `assets/`（包括 `router-engine.mjs` 和 `router-controller.mjs`）、`chapters/`、`combinations/`、`models/`、`router.html`、`404.html`、`robots.txt` 和 `sitemap.xml`。缺少任一类都不是可发布镜像。`.dockerignore` 仍采用默认拒绝，只放行上述路径；即使误把其他项目文件放进暂存目录，也不会进入 Docker build context。

项目根不是 build context；因此项目根的 `.git/`、`data/`、`.local/` 和 `DDDD.pem` 从路径上就不可见。若同名文件被误复制到本 context，最外层 `**` 仍会拒绝；不得为了省略暂存步骤而扩大 context。

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
rtk test -f deploy/tencent-cloud/xmind-site/context/site/combinations/index.html
rtk test -f deploy/tencent-cloud/xmind-site/context/site/combinations/cot-critic-chain.html
rtk test -f deploy/tencent-cloud/xmind-site/context/site/combinations/deep-research-chain.html
rtk test -f deploy/tencent-cloud/xmind-site/context/site/combinations/plan-execute-reflect-chain.html
rtk test -f deploy/tencent-cloud/xmind-site/context/site/combinations/react-agent-chain.html
rtk test -f deploy/tencent-cloud/xmind-site/context/site/combinations/tot-tree-of-thought-chain.html
rtk test -f deploy/tencent-cloud/xmind-site/context/site/assets/router-engine.mjs
rtk test -f deploy/tencent-cloud/xmind-site/context/site/assets/router-controller.mjs
rtk node tools/hash-public-artifact.mjs site
rtk node tools/hash-public-artifact.mjs deploy/tencent-cloud/xmind-site/context/site
```

第二条 `rsync` 必须无输出，证明源发布树与暂存树逐字节一致。清单中的相对路径必须只属于 `index.html`、`404.html`、`router.html`、`robots.txt`、`sitemap.xml`、`assets/`、`chapters/`、`combinations/` 或 `models/`。两条 `hash-public-artifact` 输出的完整 SHA-256 与文件数必须一致。再创建本地环境文件，并把完整值及其前 12 位分别写入 `.env`：

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
rtk curl -fsS http://127.0.0.1:18889/assets/router-engine.mjs -o /tmp/xmind-site-router-engine.mjs
rtk curl -fsS http://127.0.0.1:18889/assets/router-controller.mjs -o /tmp/xmind-site-router-controller.mjs
rtk curl -fsS http://127.0.0.1:18889/combinations/index.html -o /tmp/xmind-site-combinations.html
rtk curl -fsS http://127.0.0.1:18889/combinations/plan-execute-reflect-chain.html -o /tmp/xmind-site-combination-detail.html
rtk curl -fsS http://127.0.0.1:18889/models/index.html -o /tmp/xmind-site-models.html
rtk curl -fsS http://127.0.0.1:18889/chapters/ch00-overview-and-toolbox.html -o /tmp/xmind-site-chapter.html
rtk curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18889/definitely-missing.html
```

首条命令会占用当前终端；用第二个终端完成检查后用 `Ctrl-C` 退出。两个首页 HTML hash 必须一致，CSS、Router、两个 `.mjs`、组合总览/详情、模型目录与章节必须返回 200，不存在的路径必须返回 404。

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
- 首次安装时，`172.20.0.1:18888` 无监听且没有同名 `xmind_site` 资源；升级时必须恰好存在一个由 Compose labels 定位的 `xmind_site/web` 容器，不能用名称猜测或把正常旧服务误判为冲突。
- 根盘剩余空间足以同时保留新镜像和至少一个回滚版本。

部署前后只允许调用同一版本化脚本 `snapshot-host.sh` 采集。它会在 `/opt/xmind-site/audit/<release-id>/<pre|post>/` 生成并自校验：

```text
containers.json
images.json
networks.json
volumes.json
listening-ports.tsv
gateway-contract.json
gateway-nginx-host.sha256
gateway-nginx-container.sha256
cert-lineages.tsv
server-markers.tsv
existing-domains.sha256
existing-domains.tsv
snapshot-files.sha256
```

资源清单使用 `docker inspect` 与 `jq -S` 稳定排序；证书快照只读取 renewal 配置、公钥证书、symlink 目标、fingerprint、serial、SAN、issuer 和有效期，绝不读取私钥。域名清单必须保持固定 SHA、固定顺序、恰好 32 个非空唯一域名；每个域名记录严格 TLS 的 curl exit code、HTTP code、remote IP 和 `ssl_verify_result`，任一 TLS 失败都使快照失败。

在任何 snapshot 写入前，先只创建本项目专属目录并把子目录交给 `ubuntu`；这一 bootstrap 对首次安装和升级都幂等，不修改其他项目：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo install -d -m 0755 /opt/xmind-site && sudo install -d -o ubuntu -g ubuntu -m 0755 /opt/xmind-site/current /opt/xmind-site/audit /opt/xmind-site/rollback'
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/snapshot-host.sh deploy/tencent-cloud/xmind-site/compare-snapshots.sh deploy/tencent-cloud/xmind-site/existing-domains.txt ubuntu@101.34.52.232:/opt/xmind-site/current/
rtk shasum -a 256 deploy/tencent-cloud/xmind-site/snapshot-host.sh deploy/tencent-cloud/xmind-site/compare-snapshots.sh deploy/tencent-cloud/xmind-site/existing-domains.txt
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sha256sum /opt/xmind-site/current/snapshot-host.sh /opt/xmind-site/current/compare-snapshots.sh /opt/xmind-site/current/existing-domains.txt'
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'sudo bash /opt/xmind-site/current/snapshot-host.sh <release-id> pre'
```

本地与远端三个 SHA 必须逐项一致。`pre` 必须早于 `docker load`、旧镜像 hold tag、`compose up`、Certbot、Nginx patch/restart；脚本拒绝覆盖同 phase，避免重试掩盖真实变化。两个发布脚本没有被 `.dockerignore` 放行，不进入静态镜像。

### 4.1 覆盖 current 前冻结旧 origin

每次发布都先生成唯一 UTC `<release-id>`。下列命令必须在覆盖 `/opt/xmind-site/current/compose.yaml` 或 `.env` 之前执行；把输出的 `PRE_RELEASE_ID` 写入发布记录，后续回滚必须显式使用同一个值，不使用“latest”软指针。它同时保存旧 Compose 输入、容器/image inspect、不可变 image ID、保留 tag、旧完整站点树、逐文件 hash 与文件数：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
umask 077

release_id='<release-id>'
current=/opt/xmind-site/current
pre="/opt/xmind-site/audit/${release_id}/pre"
test "$(cat "$pre/release-id.txt")" = "$release_id"
test "$(cat "$pre/phase.txt")" = pre
(cd "$pre" && sha256sum -c snapshot-files.sha256)

mapfile -t containers < <(
  docker ps -aq \
    --filter label=com.docker.compose.project=xmind_site \
    --filter label=com.docker.compose.service=web
)

if ((${#containers[@]} == 0)); then
  if [ -e "$current/.env" ] || [ -e "$current/compose.yaml" ]; then
    echo 'refusing: deployment metadata exists but xmind_site/web is absent' >&2
    exit 1
  fi
  : > "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
  printf '%s\n' first_install > "$pre/deploy-mode.txt"
  printf 'PRE_RELEASE_ID=%s\n' "$release_id"
  exit 0
fi

if ((${#containers[@]} != 1)); then
  echo 'refusing: expected exactly one xmind_site/web container' >&2
  exit 1
fi
test -f "$current/.env"
test -f "$current/compose.yaml"

container_id="${containers[0]}"
image_ref="$(docker container inspect --format '{{.Config.Image}}' "$container_id")"
image_id="$(docker container inspect --format '{{.Image}}' "$container_id")"
test "$(docker image inspect --format '{{.Id}}' "$image_ref")" = "$image_id"
artifact_sha="$(docker image inspect --format '{{index .Config.Labels "com.lute.artifact.sha256"}}' "$image_id")"
[[ "$artifact_sha" =~ ^[0-9a-f]{64}$ ]]

install -m 0600 "$current/.env" "$pre/previous.env"
install -m 0644 "$current/compose.yaml" "$pre/previous-compose.yaml"
printf '%s\n' "$container_id" > "$pre/previous-container-id.txt"
printf '%s\n' "$image_ref" > "$pre/previous-image-ref.txt"
printf '%s\n' "$image_id" > "$pre/previous-image-id.txt"
printf '%s\n' "$artifact_sha" > "$pre/previous-artifact.sha256"
docker container inspect "$container_id" > "$pre/previous-container-inspect.json"
docker image inspect "$image_id" > "$pre/previous-image-inspect.json"

hold_ref="xmind-site:rollback-${release_id}"
if docker image inspect "$hold_ref" >/dev/null 2>&1; then
  echo "refusing: rollback hold tag already exists: $hold_ref" >&2
  exit 1
fi
docker image tag "$image_id" "$hold_ref"
printf '%s\n' "$hold_ref" > "$pre/previous-image-hold-ref.txt"

install -d -m 0700 "$pre/previous-site"
docker container cp "$container_id":/usr/share/nginx/html/. "$pre/previous-site/"
test -n "$(find "$pre/previous-site" -type f -print -quit)"
test -z "$(find "$pre/previous-site" -type l -print -quit)"
(
  cd "$pre/previous-site"
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
) > "$pre/previous-site.files.sha256"
find "$pre/previous-site" -type f | wc -l > "$pre/previous-site.file-count.txt"
printf '%s\n' upgrade > "$pre/deploy-mode.txt"
(
  cd "$pre"
  sha256sum previous.env previous-compose.yaml \
    previous-container-inspect.json previous-image-inspect.json \
    previous-image-ref.txt previous-image-id.txt \
    previous-image-hold-ref.txt previous-artifact.sha256 \
    previous-site.files.sha256 previous-site.file-count.txt deploy-mode.txt \
    snapshot-files.sha256 \
    > snapshot-metadata.sha256
)
printf 'PRE_RELEASE_ID=%s\n' "$release_id"
REMOTE
```

若存在旧 origin，`previous-image-ref.txt` 与 hold ref 必须同时解析到 `previous-image-id.txt`；任一不一致立即停止。hold tag、旧容器证据和旧站点树必须保留到新版本验收及回滚窗口结束；期间禁止任何 `docker system prune` 或 `docker image prune`。首次安装只允许生成 `FIRST_INSTALL_NO_PREVIOUS_ORIGIN`，不能伪造“旧版本可恢复”证据。后续每个独立 SSH 阶段都必须显式传入同一 `<release-id>`、校验 `release-id.txt`，并从 marker 与 `deploy-mode.txt` fail closed 地确定模式；不得在候选 origin 启动后再用端口状态猜测。

## 5. 传输与启动 origin

只传输精确文件，禁止对项目根目录使用 `scp -r`、`rsync` 或 tar：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
release_id='<release-id>'
pre="/opt/xmind-site/audit/$release_id/pre"
test "$(cat "$pre/release-id.txt")" = "$release_id"
mode="$(cat "$pre/deploy-mode.txt")"
if [ "$mode" = first_install ]; then
  test -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
elif [ "$mode" = upgrade ]; then
  test ! -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
  (cd "$pre" && sha256sum -c snapshot-metadata.sha256)
else
  echo 'refusing: incomplete or ambiguous release snapshot' >&2
  exit 1
fi
printf 'DEPLOY_MODE=%s\n' "$mode"
REMOTE
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/compose.yaml ubuntu@101.34.52.232:/opt/xmind-site/current/compose.yaml
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/dist/xmind-site-<12-char-artifact-sha>-linux-amd64.tar ubuntu@101.34.52.232:/opt/xmind-site/current/
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/dist/xmind-site-<12-char-artifact-sha>-linux-amd64.tar.sha256 ubuntu@101.34.52.232:/opt/xmind-site/current/
```

在服务器端校验、加载并启动：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
umask 077
release_id='<release-id>'
artifact_sha='<64-char-artifact-sha>'
image_tag='<12-char-artifact-sha>'
pre="/opt/xmind-site/audit/$release_id/pre"
current=/opt/xmind-site/current
test "$(cat "$pre/release-id.txt")" = "$release_id"
mode="$(cat "$pre/deploy-mode.txt")"
if [ "$mode" = first_install ]; then
  test -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
elif [ "$mode" = upgrade ]; then
  test ! -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
  (cd "$pre" && sha256sum -c snapshot-metadata.sha256)
else
  echo 'refusing: incomplete or ambiguous release snapshot' >&2
  exit 1
fi
[[ "$artifact_sha" =~ ^[0-9a-f]{64}$ ]]
[[ "$image_tag" =~ ^[0-9a-f]{12}$ ]]
test "${artifact_sha:0:12}" = "$image_tag"
cd "$current"
sha256sum -c "xmind-site-${image_tag}-linux-amd64.tar.sha256"
docker load -i "xmind-site-${image_tag}-linux-amd64.tar"
install -m 0600 /dev/null "$current/.env"
printf '%s\n' \
  "XMIND_ARTIFACT_SHA256=$artifact_sha" \
  "XMIND_IMAGE_TAG=$image_tag" \
  > "$current/.env"
docker compose --project-name xmind_site config --quiet
docker compose --project-name xmind_site \
  up -d --no-build --pull never --force-recreate --wait --wait-timeout 90
docker compose --project-name xmind_site ps
curl -fsS http://172.20.0.1:18888/healthz
docker exec ai_video_nginx wget -q -O - http://172.20.0.1:18888/healthz
curl -fsS http://172.20.0.1:18888/ -o "/tmp/xmind-origin-${release_id}.html"
sha256sum "/tmp/xmind-origin-${release_id}.html"
REMOTE
```

如 origin 不健康、内容 hash 不一致或共享入口容器无法访问 `172.20.0.1:18888`，到此停止，不签证书，不改入口。

## 6. xmind 专属证书

现有 HTTP default server 已将 `/.well-known/acme-challenge/` 映射到 `/var/www/certbot`，`/etc/letsencrypt` 也已只读挂载到 `ai_video_nginx`。不扩容现有巨型多 SAN 证书。首次安装才允许签发独立 ECDSA 证书；lineage 已存在则停止并人工确认是失败重试还是残留状态：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
release_id='<release-id>'
pre="/opt/xmind-site/audit/$release_id/pre"
test "$(cat "$pre/release-id.txt")" = "$release_id"
test "$(cat "$pre/deploy-mode.txt")" = first_install
test -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
sudo test ! -e /etc/letsencrypt/live/xmind.lute-tlz-dddd.top
sudo certbot certonly --webroot -w /var/www/certbot \
  --cert-name xmind.lute-tlz-dddd.top \
  -d xmind.lute-tlz-dddd.top --key-type ecdsa
sudo certbot certificates --cert-name xmind.lute-tlz-dddd.top
sudo test -s /etc/letsencrypt/live/xmind.lute-tlz-dddd.top/fullchain.pem
sudo test -s /etc/letsencrypt/live/xmind.lute-tlz-dddd.top/privkey.pem
REMOTE
```

现有 Certbot deploy hook 会在签发后 reload `ai_video_nginx`；签发前保存现有域名基线，签发后立即重跑。

升级只读验证现有证书，不运行任何 Certbot 写操作、不续期、不触发 deploy hook：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
release_id='<release-id>'
pre="/opt/xmind-site/audit/$release_id/pre"
test "$(cat "$pre/release-id.txt")" = "$release_id"
test "$(cat "$pre/deploy-mode.txt")" = upgrade
test ! -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
(cd "$pre" && sha256sum -c snapshot-metadata.sha256)
sudo test -s /etc/letsencrypt/live/xmind.lute-tlz-dddd.top/fullchain.pem
sudo test -s /etc/letsencrypt/live/xmind.lute-tlz-dddd.top/privkey.pem
sudo openssl x509 -in /etc/letsencrypt/live/xmind.lute-tlz-dddd.top/fullchain.pem \
  -noout -checkend 604800
certificate=/etc/letsencrypt/live/xmind.lute-tlz-dddd.top/fullchain.pem
sudo openssl x509 -in "$certificate" -noout -subject -issuer -dates
san="$(sudo openssl x509 -in "$certificate" -noout -ext subjectAltName \
  | grep -o 'DNS:[^,[:space:]]*' | LC_ALL=C sort -u)"
test "$san" = 'DNS:xmind.lute-tlz-dddd.top'
REMOTE
```

上述命令同时要求证书至少还有 7 天有效期，且 SAN 精确只有 `DNS:xmind.lute-tlz-dddd.top`。

## 7. 共享入口变更

共享主配置不 include `conf.d/*.conf`。只有首次安装才把两个 xmind server block 插入现有 `http { ... }` 并重启共享入口；内容升级必须跳过全部 patch/reload/restart。

### 7.1 首次安装 cutover

传输精确工具文件后，以本次 release 的 `pre/` 保存旧配置，不使用可被重试覆盖的全局“latest backup”：

```bash
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/nginx/xmind-edge-server-blocks.conf.template ubuntu@101.34.52.232:/opt/xmind-site/current/
rtk scp -i DDDD.pem deploy/tencent-cloud/xmind-site/patch-shared-nginx.py ubuntu@101.34.52.232:/opt/xmind-site/current/
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
release_id='<release-id>'
pre="/opt/xmind-site/audit/$release_id/pre"
current=/opt/xmind-site/current
config=/opt/ai-video/deploy/lighthouse/nginx.conf
test "$(cat "$pre/release-id.txt")" = "$release_id"
test "$(cat "$pre/deploy-mode.txt")" = first_install
test -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
test ! -e "$pre/shared-nginx.conf.pre-xmind"
sudo install -m 0644 "$config" "$pre/shared-nginx.conf.pre-xmind"
sudo chown ubuntu:ubuntu "$pre/shared-nginx.conf.pre-xmind"
(cd "$pre" && sha256sum shared-nginx.conf.pre-xmind > shared-nginx.pre.sha256)
cd "$current"
python3 patch-shared-nginx.py --base "$config" \
  --snippet xmind-edge-server-blocks.conf.template \
  --output nginx.conf.candidate
diff -u "$pre/shared-nginx.conf.pre-xmind" nginx.conf.candidate || [ "$?" -eq 1 ]
REMOTE
```

`diff` 必须只包含标记包围的 xmind HTTP/HTTPS server block。现有入口把主配置作为单文件只读 bind mount；原子替换宿主文件后，运行中的容器仍固定在旧 inode。不能用容器内原配置的 `nginx -t` 或 HUP reload 证明候选有效。

先用临时容器复用现有入口的全部只读挂载和同一网络，对候选配置做真实语法与依赖解析检查：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
release_id='<release-id>'
pre="/opt/xmind-site/audit/$release_id/pre"
test "$(cat "$pre/release-id.txt")" = "$release_id"
test "$(cat "$pre/deploy-mode.txt")" = first_install
test -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
docker run --rm --name xmind_nginx_config_test \
  --pull=never \
  --network lighthouse_ai_video_net --volumes-from ai_video_nginx:ro \
  -v /opt/xmind-site/current/nginx.conf.candidate:/etc/nginx/nginx.conf:ro \
  "$(docker inspect ai_video_nginx --format '{{.Image}}')" nginx -t
REMOTE
```

重跑 32 域名 pre 基线后，先写入 attempted marker，再在同一文件系统用临时文件 + `mv` 原子替换。有界重启后必须同时校验 health 与宿主/容器配置 hash：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
release_id='<release-id>'
pre="/opt/xmind-site/audit/$release_id/pre"
current=/opt/xmind-site/current
config=/opt/ai-video/deploy/lighthouse/nginx.conf
candidate="$current/nginx.conf.candidate"
test "$(cat "$pre/release-id.txt")" = "$release_id"
test "$(cat "$pre/deploy-mode.txt")" = first_install
test -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
(cd "$pre" && sha256sum -c shared-nginx.pre.sha256)
test -f "$candidate"
: > "$pre/SHARED_NGINX_CUTOVER_ATTEMPTED"
candidate_sha="$(sha256sum "$candidate" | cut -d ' ' -f 1)"
tmp="${config}.xmind-${release_id}"
sudo install -m 0644 "$candidate" "$tmp"
sudo mv "$tmp" "$config"
docker restart --time 30 ai_video_nginx
healthy=false
for attempt in $(seq 1 45); do
  if [ "$(docker inspect ai_video_nginx --format '{{.State.Health.Status}}')" = healthy ]; then
    healthy=true
    break
  fi
  sleep 2
done
test "$healthy" = true
docker exec ai_video_nginx nginx -t
test "$(sudo sha256sum "$config" | cut -d ' ' -f 1)" = "$candidate_sha"
test "$(docker exec ai_video_nginx sha256sum /etc/nginx/nginx.conf | cut -d ' ' -f 1)" = "$candidate_sha"
: > "$pre/SHARED_NGINX_CUTOVER_SUCCEEDED"
REMOTE
```

重启后立即重跑 32 域名 post 基线。任一步失败走 10.1 的本 release 备份回滚。这里无法做到入口零耦合；若不能接受秒级共享入口切换，必须改用独立 VM/IP。

### 7.2 升级只读验证

升级不传输 patch 工具、不备份或覆盖 Nginx 配置、不 reload/restart `ai_video_nginx`。只读验证标记、server blocks、origin 连通性及 gateway 身份：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
release_id='<release-id>'
pre="/opt/xmind-site/audit/$release_id/pre"
config=/opt/ai-video/deploy/lighthouse/nginx.conf
test "$(cat "$pre/release-id.txt")" = "$release_id"
test "$(cat "$pre/deploy-mode.txt")" = upgrade
test ! -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
(cd "$pre" && sha256sum -c snapshot-metadata.sha256)
test "$(sudo grep -Fc '# BEGIN xmind.lute-tlz-dddd.top' "$config")" -eq 1
test "$(sudo grep -Fc '# END xmind.lute-tlz-dddd.top' "$config")" -eq 1
test "$(sudo grep -Ec '^[[:space:]]*server_name[[:space:]]+xmind[.]lute-tlz-dddd[.]top;' "$config")" -eq 2
test "$(sudo grep -Fc 'proxy_pass http://172.20.0.1:18888;' "$config")" -eq 1
docker exec ai_video_nginx nginx -t
expected_gateway="$(jq -r '[.Id,.StartedAt,(.RestartCount|tostring),.Health] | join(" ")' "$pre/gateway-contract.json")"
test "$(docker inspect ai_video_nginx --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}')" = "$expected_gateway"
test "$(sudo sha256sum "$config" | cut -d ' ' -f 1)" = "$(cat "$pre/gateway-nginx-host.sha256")"
test "$(docker exec ai_video_nginx sha256sum /etc/nginx/nginx.conf | cut -d ' ' -f 1)" = "$(cat "$pre/gateway-nginx-container.sha256")"
curl -fsS http://172.20.0.1:18888/healthz
docker exec ai_video_nginx wget -q -O - http://172.20.0.1:18888/healthz
REMOTE
```

上述命令完成候选前置只读验证；第 9 节还会用机器比较器精确检查 gateway 的 image、mount、network、port bindings、container config、ID、StartedAt、RestartCount 与配置 hash 均未变化。

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
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/assets/router-engine.mjs
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/assets/router-controller.mjs
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/combinations/index.html
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/combinations/plan-execute-reflect-chain.html
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/models/index.html
rtk curl -fsSI https://xmind.lute-tlz-dddd.top/chapters/ch00-overview-and-toolbox.html
rtk curl -sS -o /dev/null -w '%{http_code}\n' https://xmind.lute-tlz-dddd.top/definitely-missing.html
rtk node tools/verify-production.mjs --url https://xmind.lute-tlz-dddd.top/ --site-dir site
rtk npm run verify:security
```

必须满足：

- HTTP 仅 301 到同 Host HTTPS。
- TLS 严格校验成功，SAN 精确包含 xmind。
- `/healthz` 是 `ok`。
- `/` 为 200，且 bytes hash 与已验证本地 `site/index.html` 相同。
- CSS、Router、两个 `.mjs`、组合总览/详情、模型目录和章节为 200；不存在的路径为 404，不能回落成伪 200 首页。
- `verify-production.mjs` 必须对当次本地 `site/` 的完整文件数逐一返回 200、正确 Content-Type、无转向且 bytes 一致；组合页或 `.mjs` 任一 404、类型错误、意外转向或 byte mismatch 都必须 exit 1。
- 页面 title 为系统化思维，不再是 `Short Video Factory`。
- CSP、HSTS、`nosniff`、拒绝 iframe、Referrer Policy 和 Permissions Policy 各出现一次且值精确匹配；不得因 origin 与共享入口叠加而重复。
- 容器稳定为 healthy，无 restart loop。

浏览器 E2E 至少覆盖：

- 首页、13 章导航、搜索、问题匹配、Codex 提问复制。
- Router 的一次澄清、核心/辅助路由、唯一核心 Chain，以及组合工坊总览、五个详情与模型/章节反向入口。
- 模型 hash anchor 直达与刷新。
- 键盘、可见焦点、Escape、焦点归还、reduced motion。
- 1440px、390px、320px，浅色/深色，打印。
- 禁用网络后搜索和问题匹配仍可用，没有 fetch/XHR/WebSocket/analytics。

## 9. 前后资源差异与现有应用回归

完成第 8 节逐文件验收后，用第 4 节同一份、同 SHA 脚本生成 `post/`，再由版本化比较器 fail closed 判定。`mode` 必须来自本 release 的 `deploy-mode.txt`，不得手输另一个分支：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
release_id='<release-id>'
artifact_sha='<64-char-artifact-sha>'
pre="/opt/xmind-site/audit/$release_id/pre"
test "$(cat "$pre/release-id.txt")" = "$release_id"
mode="$(cat "$pre/deploy-mode.txt")"
[[ "$mode" = first_install || "$mode" = upgrade ]]
sudo bash /opt/xmind-site/current/snapshot-host.sh "$release_id" post
sudo bash /opt/xmind-site/current/compare-snapshots.sh "$release_id" "$mode" "$artifact_sha"
REMOTE
```

`snapshot-files.sha256` 先阻止审计证据被修改；比较器随后检查完整 containers/images/networks/volumes/ports、gateway contract、宿主与容器 Nginx hash、certificate lineage、server markers 与 32 域名严格 TLS 结果。

首次安装只允许：

- 新增 Compose project `xmind_site`。
- 新增一个 `xmind_site-web-1` 容器。
- 新增一个 `xmind_site_internal` bridge network。
- 新增一个 `xmind-site:<12-char-artifact-sha>` 镜像。
- 新增 `172.20.0.1:18888` 监听。
- 新增 xmind 专属证书和两个 Nginx server block。

升级只允许 `xmind_site/web` 容器 ID 和 image ID/tag 按候选版本变化；network、port、certificate lineage、server blocks 与共享 Nginx config 不新增、不变更，旧 image 及 rollback hold tag 仍存在。`ai_video_nginx` 的 ID、StartedAt、RestartCount、mount、network 和配置 hash 必须与 pre 完全相同。

不允许：

- 任何新 volume。
- 首次安装除已记录的 `ai_video_nginx` 单次 cutover 重启外，任何现有容器被 recreate/restart，或其 image/network/mount/port 变化；升级则不允许 `ai_video_nginx` 有任何 reload/restart/recreate。
- 现有域名 code、remote IP、TLS 严格校验结果变差。
- 根盘突然增长超过镜像+审计文件的合理体积。

现有域名回归不得只抽测 xmind。使用 `existing-domains.txt` 中同一顺序的全部域名重跑严格 HTTPS 检查并比对 pre/post。

## 10. 回滚

任一条件触发回滚：TLS 失败、xmind 错误页、内容 hash 不符、共享 Nginx 不健康、现有域名回归变差、不在 allowlist 的 Docker 资源变化。必须先以同一 `<release-id>` 重建 mode：首次安装走 10.1，升级任何候选 origin/内容/验收失败都走 10.2，不能把升级导向“移除 xmind 入口”。

### 10.1 首次安装失败

若 origin 或证书阶段在 cutover 前失败，共享入口未改，只停止新 origin。只有存在本 release 的 `SHARED_NGINX_CUTOVER_ATTEMPTED` 时才验证并原子恢复本 release 备份，再有界重启共享入口：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
release_id='<release-id>'
pre="/opt/xmind-site/audit/$release_id/pre"
config=/opt/ai-video/deploy/lighthouse/nginx.conf
test "$(cat "$pre/release-id.txt")" = "$release_id"
test "$(cat "$pre/deploy-mode.txt")" = first_install
test -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
if [ -e "$pre/SHARED_NGINX_CUTOVER_ATTEMPTED" ]; then
  test -f "$pre/shared-nginx.conf.pre-xmind"
  (cd "$pre" && sha256sum -c shared-nginx.pre.sha256)
  docker run --rm --name xmind_nginx_rollback_test \
    --pull=never \
    --network lighthouse_ai_video_net --volumes-from ai_video_nginx:ro \
    -v "$pre/shared-nginx.conf.pre-xmind":/etc/nginx/nginx.conf:ro \
    "$(docker inspect ai_video_nginx --format '{{.Image}}')" nginx -t
  tmp="${config}.rollback-${release_id}"
  sudo install -m 0644 "$pre/shared-nginx.conf.pre-xmind" "$tmp"
  sudo mv "$tmp" "$config"
  docker restart --time 30 ai_video_nginx
  healthy=false
  for attempt in $(seq 1 45); do
    if [ "$(docker inspect ai_video_nginx --format '{{.State.Health.Status}}')" = healthy ]; then
      healthy=true
      break
    fi
    sleep 2
  done
  test "$healthy" = true
  docker exec ai_video_nginx nginx -t
  expected="$(cut -d ' ' -f 1 "$pre/shared-nginx.pre.sha256")"
  test "$(sudo sha256sum "$config" | cut -d ' ' -f 1)" = "$expected"
  test "$(docker exec ai_video_nginx sha256sum /etc/nginx/nginx.conf | cut -d ' ' -f 1)" = "$expected"
fi
cd /opt/xmind-site/current
docker compose --project-name xmind_site stop
REMOTE
```

重跑全部现有域名回归。不立即删镜像、证书或审计证据。首次安装没有旧 xmind origin，因此只能证明共享入口和既有域名回到发布前状态，不能宣称旧 xmind 逐文件生产验证通过。

### 10.2 已有 origin 的内容升级失败

如果共享入口未改或仍健康，使用第 4.1 节记录的显式 `<release-id>` 恢复旧 Compose 输入和旧 image ID。下列命令先校验快照、旧树和两个 image ref，再恢复 `.env` / `compose.yaml`，并用 `up -d --force-recreate` 真实替换容器；不得改用 `latest`、当前候选树或临时修页：

```bash
rtk ssh -i DDDD.pem ubuntu@101.34.52.232 'bash -se' <<'REMOTE'
set -Eeuo pipefail
umask 077

release_id='<release-id>'
root=/opt/xmind-site
current="$root/current"
pre="$root/audit/$release_id/pre"
rollback="$root/audit/$release_id/rollback"
test "$(cat "$pre/release-id.txt")" = "$release_id"
test "$(cat "$pre/deploy-mode.txt")" = upgrade
test ! -e "$pre/FIRST_INSTALL_NO_PREVIOUS_ORIGIN"
install -d -m 0700 "$rollback"

(cd "$pre" && sha256sum -c snapshot-metadata.sha256)
(cd "$pre/previous-site" && sha256sum -c ../previous-site.files.sha256)

old_ref="$(cat "$pre/previous-image-ref.txt")"
old_id="$(cat "$pre/previous-image-id.txt")"
hold_ref="$(cat "$pre/previous-image-hold-ref.txt")"
test "$(docker image inspect --format '{{.Id}}' "$old_ref")" = "$old_id"
test "$(docker image inspect --format '{{.Id}}' "$hold_ref")" = "$old_id"

install -m 0644 "$pre/previous-compose.yaml" "$current/compose.yaml"
install -m 0600 "$pre/previous.env" "$current/.env"
compose_image="$(
  docker compose --project-name xmind_site \
    --project-directory "$current" \
    --env-file "$current/.env" \
    -f "$current/compose.yaml" config --images
)"
test "$compose_image" = "$old_ref"

docker compose --project-name xmind_site \
  --project-directory "$current" \
  --env-file "$current/.env" \
  -f "$current/compose.yaml" \
  up -d --no-build --pull never --force-recreate --wait --wait-timeout 90

restored_container="$(
  docker compose --project-name xmind_site \
    --project-directory "$current" \
    --env-file "$current/.env" \
    -f "$current/compose.yaml" ps -q web
)"
test -n "$restored_container"
test "$(docker container inspect --format '{{.Image}}' "$restored_container")" = "$old_id"
docker container inspect "$restored_container" \
  > "$rollback/restored-container-inspect.json"
curl -fsS http://172.20.0.1:18888/healthz
curl -fsS http://172.20.0.1:18888/ \
  -o "$rollback/restored-origin-index.html"
cmp -s "$pre/previous-site/index.html" "$rollback/restored-origin-index.html"
REMOTE
```

容器恢复只是第一层证据。把同一 `<release-id>` 的旧完整树复制到本地独立临时目录，先复核逐文件清单和 artifact SHA，再用旧树执行生产逐文件 bytes 验证：

```bash
rtk install -d -m 0700 /tmp/xmind-rollback-<release-id>/site
rtk rsync -a --delete -e 'ssh -i DDDD.pem' ubuntu@101.34.52.232:/opt/xmind-site/audit/<release-id>/pre/previous-site/ /tmp/xmind-rollback-<release-id>/site/
rtk scp -i DDDD.pem ubuntu@101.34.52.232:/opt/xmind-site/audit/<release-id>/pre/previous-site.files.sha256 /tmp/xmind-rollback-<release-id>/
rtk scp -i DDDD.pem ubuntu@101.34.52.232:/opt/xmind-site/audit/<release-id>/pre/previous-site.file-count.txt /tmp/xmind-rollback-<release-id>/
rtk scp -i DDDD.pem ubuntu@101.34.52.232:/opt/xmind-site/audit/<release-id>/pre/previous-artifact.sha256 /tmp/xmind-rollback-<release-id>/
rtk zsh -lc 'cd /tmp/xmind-rollback-<release-id>/site && shasum -a 256 -c ../previous-site.files.sha256'
rtk zsh -lc 'expected=$(tr -d "[:space:]" < /tmp/xmind-rollback-<release-id>/previous-site.file-count.txt); actual=$(find /tmp/xmind-rollback-<release-id>/site -type f | wc -l | tr -d "[:space:]"); test "$actual" = "$expected"'
rtk zsh -lc 'expected=$(tr -d "\n" < /tmp/xmind-rollback-<release-id>/previous-artifact.sha256); actual=$(node tools/hash-public-artifact.mjs /tmp/xmind-rollback-<release-id>/site | cut -d " " -f 1); test "$actual" = "$expected"'
rtk zsh -o pipefail -lc 'expected=$(tr -d "[:space:]" < /tmp/xmind-rollback-<release-id>/previous-site.file-count.txt); node tools/verify-production.mjs --url https://xmind.lute-tlz-dddd.top/ --site-dir /tmp/xmind-rollback-<release-id>/site | tee /tmp/xmind-rollback-<release-id>/production-verifier.txt; rg -F "for ${expected} files." /tmp/xmind-rollback-<release-id>/production-verifier.txt'
```

`verify-production.mjs` 必须 exit 0，且 checked-files 等于保存的 `previous-site.file-count.txt`。不能拿本次候选 `site/` 验证旧镜像，也不能只比首页。

对已含 Router 2.0/组合工坊的回滚目标，逐文件验证必须包含 `combinations/**` 与 `assets/router-engine.mjs`、`assets/router-controller.mjs`。若本次回滚目标是不含该功能的 V4 历史基线，则这些新路径必须恢复为该旧树声明的 404，同时旧树的全部已有文件逐字节通过。记录 checked-files、旧 artifact SHA、旧 image ID 和这些路径的预期状态。

旧树确认为不含 Router 2.0/组合工坊时，额外执行并要求八个路径全部精确返回 404：

```bash
rtk zsh -lc 'for relative in assets/router-engine.mjs assets/router-controller.mjs combinations/index.html combinations/cot-critic-chain.html combinations/deep-research-chain.html combinations/plan-execute-reflect-chain.html combinations/react-agent-chain.html combinations/tot-tree-of-thought-chain.html; do code=$(curl -sS -o /dev/null -w "%{http_code}" "https://xmind.lute-tlz-dddd.top/$relative"); test "$code" = 404 || { echo "$relative -> $code" >&2; exit 1; }; done'
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
- `combinations/**` 与两个 Router `.mjs` 在暂存树、镜像烟测、生产逐文件和回滚目标中的精确路径/状态/bytes 证据。
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
- Docker Compose `config` 变量解析与最终模型：<https://docs.docker.com/reference/cli/docker/compose/config/>
- Docker Compose `up --force-recreate --wait`：<https://docs.docker.com/reference/cli/docker/compose/up/>
- Docker container/image inspect：<https://docs.docker.com/reference/cli/docker/container/inspect/>、<https://docs.docker.com/reference/cli/docker/image/inspect/>
- Docker 从运行中或停止的容器复制旧站点树：<https://docs.docker.com/reference/cli/docker/container/cp/>
- Docker Official Image nginx：<https://hub.docker.com/_/nginx/>
- Node.js ESM specifier、静态 `import` / `export from` 与动态 `import()`：<https://nodejs.org/api/esm.html>
- ECMAScript lexical grammar（comment、string、regular expression、template literal 与 `${...}`）：<https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html>
- Nginx 信号与优雅 reload：<https://nginx.org/en/docs/control.html>
- Certbot 稳定文档：<https://eff-certbot.readthedocs.io/en/stable/>
