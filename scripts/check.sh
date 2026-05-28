#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

python3 -m py_compile "$ROOT_DIR/mediaseek_web/backend.py"
node --check "$ROOT_DIR/mediaseek_web/src/main.js"
