#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep (rg) is required for the repository secret scan" >&2
  exit 1
fi

PATTERN_FILE="$(mktemp)"
ALLOWLIST_FILE="$(mktemp)"
cleanup() {
  rm -f "$PATTERN_FILE" "$ALLOWLIST_FILE"
}
trap cleanup EXIT

node scripts/print-secret-scan-patterns.js > "$PATTERN_FILE"
cat > "$ALLOWLIST_FILE" <<'EOF'
^\./README\.md:[0-9]+:`codexapp\.aialra\.online` uses a private provider backed by `codex\.aialra\.online`\.
^\./README\.zh-CN\.md:[0-9]+:`codexapp\.aialra\.online` 使用的是由 `codex\.aialra\.online` 支撑的私有 provider。
EOF

if rg --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!package-lock.json' --glob '!scripts/print-secret-scan-patterns.js' -n -f "$PATTERN_FILE" . | rg -v -f "$ALLOWLIST_FILE"; then
  echo "Potential secret or environment-specific value found. Review the matches above." >&2
  exit 1
fi

echo "Secret scan passed." >&2
