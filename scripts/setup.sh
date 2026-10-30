#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v brew >/dev/null 2>&1; then
  echo "Нужен Homebrew: https://brew.sh" >&2
  exit 1
fi

if ! command -v rtl_tcp >/dev/null 2>&1; then
  echo "Устанавливаю rtl-sdr (librtlsdr + rtl_tcp)..."
  brew install rtl-sdr
fi

echo
echo "Проверка устройства (подключите RTL-SDR по USB):"
rtl_test -t 2>&1 || true
