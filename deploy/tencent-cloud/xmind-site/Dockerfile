# syntax=docker/dockerfile:1.7

# linux/amd64 manifest for Docker Official Image nginx:1.29.8-alpine.
FROM nginx:1.29.8-alpine@sha256:3bcf852aed06467cf075c6105892e4d5a6ebbbafa0ce22d35062db9e90ddef4c

ARG ARTIFACT_SHA256=unknown

LABEL org.opencontainers.image.title="前车之鉴-思维制胜" \
      org.opencontainers.image.description="东方纸雕多页思维模型知识站" \
      org.opencontainers.image.version="${ARTIFACT_SHA256}" \
      com.lute.artifact.sha256="${ARTIFACT_SHA256}" \
      org.opencontainers.image.source="https://github.com/zjgulai/deep-thinking-mode"

RUN find /usr/share/nginx/html -mindepth 1 -maxdepth 1 -exec rm -rf {} +

COPY --chown=101:101 nginx/nginx.conf /etc/nginx/nginx.conf
COPY --chown=101:101 context/site/ /usr/share/nginx/html/

USER 101:101
EXPOSE 8080
STOPSIGNAL SIGQUIT

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz | grep -qx 'ok'

ENTRYPOINT ["/usr/sbin/nginx"]
CMD ["-g", "daemon off;"]
