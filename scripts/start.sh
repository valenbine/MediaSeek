#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../mediaseek_web"
python3 backend.py
