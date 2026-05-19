#!/usr/bin/env bash
set -euo pipefail

APP_VERSION="${CODEX_DESKTOP_APP_VERSION:-26.506.31421}"
ARCHIVE_URL="${CODEX_DESKTOP_ARCHIVE_URL:-https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-${APP_VERSION}.zip}"
OUTPUT_DIR="${CODEXAPP_WEBVIEW_DIR:-./webview}"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$OUTPUT_DIR"

if [ -n "${CODEX_DESKTOP_ARCHIVE_PATH:-}" ]; then
  ARCHIVE_PATH="$CODEX_DESKTOP_ARCHIVE_PATH"
else
  ARCHIVE_PATH="$WORK_DIR/codex-desktop.zip"
  echo "Downloading Codex Desktop archive: $ARCHIVE_URL" >&2
  curl -L --fail --connect-timeout 30 --max-time 900 -o "$ARCHIVE_PATH" "$ARCHIVE_URL"
fi

echo "Extracting Codex Desktop archive" >&2
unzip -q "$ARCHIVE_PATH" -d "$WORK_DIR/archive"

ASAR_PATH="$(find "$WORK_DIR/archive" -path '*/Contents/Resources/app.asar' -type f | head -n 1)"
if [ -z "$ASAR_PATH" ]; then
  echo "Could not find app.asar in archive" >&2
  exit 1
fi

echo "Extracting app.asar" >&2
npx --yes asar extract "$ASAR_PATH" "$WORK_DIR/asar"

if [ ! -d "$WORK_DIR/asar/webview" ]; then
  echo "Could not find webview directory in app.asar" >&2
  exit 1
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
cp -R "$WORK_DIR/asar/webview/." "$OUTPUT_DIR/"

echo "Webview assets written to $OUTPUT_DIR" >&2
