#!/bin/bash
# ──────────────────────────────────────────────────────────────
#  Bima Agent — One-Click Launcher (Linux / macOS)
#
#  Run:  bash bin/start-bima.sh
#  Or make executable: chmod +x bin/start-bima.sh && ./bin/start-bima.sh
#
#  Starts Bima as a background daemon and opens admin panel.
#  Close the browser anytime — Bima keeps running.
#  To stop: bash bin/stop-bima.sh
# ──────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")/.."

echo ""
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║          BIMA AGENT - One-Click Launcher             ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [ERROR] Node.js tidak terinstall."
  echo "  Download dari: https://nodejs.org/"
  exit 1
fi

node src/cli.js daemon start

echo ""
echo "  Bima berjalan di background."
echo "  Untuk stop: bash bin/stop-bima.sh"
echo ""
