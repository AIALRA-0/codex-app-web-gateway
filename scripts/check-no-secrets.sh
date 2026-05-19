#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep (rg) is required for the repository secret scan" >&2
  exit 1
fi

PATTERN_FILE="$(mktemp)"
cleanup() {
  rm -f "$PATTERN_FILE"
}
trap cleanup EXIT

node scripts/print-secret-scan-patterns.js > "$PATTERN_FILE"

if rg --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!package-lock.json' --glob '!scripts/print-secret-scan-patterns.js' -n -f "$PATTERN_FILE" .; then
  echo "Potential secret or environment-specific value found. Review the matches above." >&2
  exit 1
fi

echo "Secret scan passed." >&2
