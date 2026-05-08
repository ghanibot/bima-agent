#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════╗
# ║  BIMA Agent — Installer                          ║
# ║  Jalankan: bash install.sh                       ║
# ╚══════════════════════════════════════════════════╝
set -e

R='\033[0;31m' G='\033[38;5;46m' B='\033[38;5;39m'
Y='\033[0;33m' D='\033[0;90m'    W='\033[1m' N='\033[0m'

INSTALL_DIR="$HOME/bima-agent"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

clear
echo -e "${G}"
echo ' ██████╗ ██╗███╗   ███╗ █████╗ '
echo ' ██╔══██╗██║████╗ ████║██╔══██╗'
echo ' ██████╔╝██║██╔████╔██║███████║'
echo ' ██╔══██╗██║██║╚██╔╝██║██╔══██║'
echo ' ██████╔╝██║██║ ╚═╝ ██║██║  ██║'
echo ' ╚═════╝ ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝'
echo -e "${N}"
echo -e "${D} WhatsApp AI Agent — Installer v1.0.0${N}"
echo -e "${D} ──────────────────────────────────────${N}"
echo ""

step()  { echo -e "${B}[•]${N} ${W}$1${N}"; }
ok()    { echo -e "${G}[✓]${N} $1"; }
warn()  { echo -e "${Y}[!]${N} $1"; }
fail()  { echo -e "${R}[✗]${N} $1"; exit 1; }

# ── Detect env ───────────────────────────────────────────────
if [ -d "/data/data/com.termux" ] || [ -n "$TERMUX_VERSION" ]; then
  ENV="termux"
else
  ENV="linux"
fi
ok "Environment: $ENV"

# ── Install Node.js ──────────────────────────────────────────
step "Mengecek Node.js..."
if ! command -v node &>/dev/null; then
  if [ "$ENV" = "termux" ]; then
    step "Installing Node.js via pkg..."
    pkg update -y && pkg install -y nodejs git
  else
    step "Installing Node.js v20..."
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
      sudo apt-get install -y nodejs
    else
      fail "Tidak bisa auto-install Node.js. Install manual dari https://nodejs.org"
    fi
  fi
fi

NODE_VER=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
if [ "$NODE_VER" = "old" ]; then
  fail "Node.js v18+ diperlukan. Kamu punya: $(node --version)"
fi
ok "Node.js $(node --version)"

# ── Copy files ───────────────────────────────────────────────
step "Menyalin file ke $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/src" "$INSTALL_DIR/bin" "$INSTALL_DIR/data/files"

cp -f "$SRC/src/cli.js"       "$INSTALL_DIR/src/"
cp -f "$SRC/src/config.js"    "$INSTALL_DIR/src/"
cp -f "$SRC/src/ai.js"        "$INSTALL_DIR/src/"
cp -f "$SRC/src/processor.js" "$INSTALL_DIR/src/"
cp -f "$SRC/src/whatsapp.js"  "$INSTALL_DIR/src/"
cp -f "$SRC/src/db.js"        "$INSTALL_DIR/src/"
cp -f "$SRC/bin/bima"         "$INSTALL_DIR/bin/"
cp -f "$SRC/package.json"     "$INSTALL_DIR/"

chmod +x "$INSTALL_DIR/bin/bima"
ok "File disalin"

# ── npm install ──────────────────────────────────────────────
step "Menginstall npm packages..."
echo -e "${D}  (Baileys, pdf-parse, xlsx, mammoth — bisa 3-5 menit)${N}"
cd "$INSTALL_DIR"
npm install --omit=dev 2>&1 | grep -E "added|warn|error" | tail -5
ok "npm packages selesai"

# ── Register 'bima' command ──────────────────────────────────
step "Mendaftarkan command 'bima'..."

REGISTERED=false

# Termux: symlink ke $PREFIX/bin
if [ "$ENV" = "termux" ] && [ -d "$PREFIX/bin" ]; then
  ln -sf "$INSTALL_DIR/bin/bima" "$PREFIX/bin/bima"
  REGISTERED=true
  ok "Symlink dibuat di \$PREFIX/bin/bima"
fi

# Linux: ~/.local/bin
if [ "$REGISTERED" = false ] && [ -d "$HOME/.local/bin" ]; then
  ln -sf "$INSTALL_DIR/bin/bima" "$HOME/.local/bin/bima"
  REGISTERED=true
  ok "Symlink dibuat di ~/.local/bin/bima"
fi

# Linux fallback: npm link
if [ "$REGISTERED" = false ]; then
  cd "$INSTALL_DIR"
  npm link 2>/dev/null && REGISTERED=true && ok "Registered via npm link"
fi

# Last resort: alias
if [ "$REGISTERED" = false ]; then
  ALIAS="alias bima='node $INSTALL_DIR/src/cli.js'"
  for F in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
    [ -f "$F" ] && grep -q "alias bima=" "$F" || echo "$ALIAS" >> "$F"
  done
  ok "Alias ditambahkan ke shell profile"
  warn "Jalankan: source ~/.bashrc"
fi

# ── Done ─────────────────────────────────────────────────────
echo ""
echo -e "${G}╔══════════════════════════════════════════════╗${N}"
echo -e "${G}║${N}  ${G}${W}✓ BIMA berhasil diinstall!${N}                 ${G}║${N}"
echo -e "${G}╠══════════════════════════════════════════════╣${N}"
echo -e "${G}║${N}                                              ${G}║${N}"
echo -e "${G}║${N}  ${W}Jalankan:${N}  ${G}bima${N}                             ${G}║${N}"
echo -e "${G}║${N}                                              ${G}║${N}"
echo -e "${G}║${N}  ${W}Langkah pertama:${N}                              ${G}║${N}"
echo -e "${G}║${N}    1. ${G}/model${N}   — set API key AI              ${G}║${N}"
echo -e "${G}║${N}    2. ${G}/wa${N}      — scan QR WhatsApp             ${G}║${N}"
echo -e "${G}║${N}    3. ${G}/input${N}   — pilih grup input             ${G}║${N}"
echo -e "${G}║${N}    4. ${G}/output${N}  — pilih grup output            ${G}║${N}"
echo -e "${G}║${N}    5. Langsung tanya apa aja ke Bima!       ${G}║${N}"
echo -e "${G}║${N}                                              ${G}║${N}"
echo -e "${G}╚══════════════════════════════════════════════╝${N}"
echo ""
