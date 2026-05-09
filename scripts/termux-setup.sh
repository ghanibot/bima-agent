#!/data/data/com.termux/files/usr/bin/bash
# BIMA setup for Termux (Android)
# Run: bash termux-setup.sh

set -e

echo "=== BIMA Termux Setup ==="

# Update & install system deps
pkg update -y
pkg install -y nodejs ffmpeg

# Install BIMA (--ignore-optional skips @xenova/transformers ONNX if it fails)
npm install -g bima-agent

echo ""
echo "=== BIMA installed! ==="
echo "Note: Semantic search (embeddings) dan local Whisper STT tidak tersedia"
echo "      di Termux. Semua fitur lain berjalan normal."
echo ""
echo "Untuk STT voice note, gunakan /stt dan pilih: openai, groq, atau hf"
echo ""
echo "Jalankan: bima"
