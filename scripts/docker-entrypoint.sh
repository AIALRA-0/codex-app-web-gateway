#!/usr/bin/env bash
set -euo pipefail

: "${CODEXAPP_USERNAME:?CODEXAPP_USERNAME is required}"
: "${CODEXAPP_PASSWORD:?CODEXAPP_PASSWORD is required}"
: "${CODEXAPP_SESSION_SECRET:?CODEXAPP_SESSION_SECRET is required}"

export CODEX_HOME="${CODEX_HOME:-/data/codex-home}"
export CODEXAPP_STATE_DIR="${CODEXAPP_STATE_DIR:-/data/state}"
export CODEXAPP_WEBVIEW_DIR="${CODEXAPP_WEBVIEW_DIR:-/opt/codex-app-web-gateway/webview}"
export CODEXAPP_WEB_HOST="${CODEXAPP_WEB_HOST:-127.0.0.1}"
export CODEXAPP_WEB_PORT="${CODEXAPP_WEB_PORT:-12910}"
export CODEXAPP_HOST="${CODEXAPP_HOST:-0.0.0.0}"
export CODEXAPP_PORT="${CODEXAPP_PORT:-8080}"
export CODEXAPP_UPSTREAM="${CODEXAPP_UPSTREAM:-http://127.0.0.1:${CODEXAPP_WEB_PORT}}"
export CODEXAPP_CODEX_CLI="${CODEXAPP_CODEX_CLI:-codex}"

mkdir -p "$CODEX_HOME" "$CODEXAPP_STATE_DIR"

node /app/src/web-server.js &
WEB_PID=$!

node /app/src/login-proxy.js &
LOGIN_PID=$!

shutdown() {
  kill "$LOGIN_PID" "$WEB_PID" 2>/dev/null || true
  wait "$LOGIN_PID" "$WEB_PID" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

while true; do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    wait "$WEB_PID"
    exit $?
  fi
  if ! kill -0 "$LOGIN_PID" 2>/dev/null; then
    wait "$LOGIN_PID"
    exit $?
  fi
  sleep 1
done
