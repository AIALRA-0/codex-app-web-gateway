FROM node:22-bookworm-slim

ARG CODEX_CLI_VERSION=0.131.0
ARG CODEXAPP_PREPARE_WEBVIEW=1
ARG CODEX_DESKTOP_APP_VERSION=26.506.31421
ARG CODEX_DESKTOP_ARCHIVE_URL=

ENV NODE_ENV=production \
    CODEX_HOME=/data/codex-home \
    CODEXAPP_STATE_DIR=/data/state \
    CODEXAPP_WEBVIEW_DIR=/opt/codex-app-web-gateway/webview \
    CODEXAPP_WEB_HOST=127.0.0.1 \
    CODEXAPP_WEB_PORT=12910 \
    CODEXAPP_HOST=0.0.0.0 \
    CODEXAPP_PORT=8080 \
    CODEXAPP_UPSTREAM=http://127.0.0.1:12910 \
    CODEXAPP_CODEX_CLI=codex \
    CODEX_DESKTOP_APP_VERSION=${CODEX_DESKTOP_APP_VERSION} \
    CODEX_DESKTOP_ARCHIVE_URL=${CODEX_DESKTOP_ARCHIVE_URL}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client ripgrep unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev \
  && npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
  && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
RUN chmod +x ./src/*.js ./scripts/*.sh ./scripts/*.js

RUN if [ "$CODEXAPP_PREPARE_WEBVIEW" = "1" ]; then \
      npm run prepare:webview; \
    else \
      mkdir -p "$CODEXAPP_WEBVIEW_DIR"; \
    fi

RUN useradd --create-home --home-dir /home/codex --shell /bin/bash codex \
  && mkdir -p /data "$CODEXAPP_STATE_DIR" "$CODEX_HOME" \
  && chown -R codex:codex /app /data /opt/codex-app-web-gateway /home/codex

USER codex

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${CODEXAPP_PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
