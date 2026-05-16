#!/bin/bash
# Stop Bima daemon (Linux / macOS)
cd "$(dirname "$0")/.."
echo ""
echo "  Menghentikan Bima daemon..."
echo ""
node src/cli.js daemon stop
