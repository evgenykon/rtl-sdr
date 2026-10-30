#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose up --build -d
echo
echo "Готово: http://localhost:8080"
open http://localhost:8080 2>/dev/null || true
