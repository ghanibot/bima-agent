```
  ██████╗ ██╗███╗   ███╗ █████╗
  ██╔══██╗██║████╗ ████║██╔══██╗
  ██████╔╝██║██╔████╔██║███████║
  ██╔══██╗██║██║╚██╔╝██║██╔══██║
  ██████╔╝██║██║ ╚═╝ ██║██║  ██║
  ╚═════╝ ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝
```

# BIMA — WhatsApp AI Agent for Indonesia

> AI assistant berbahasa Indonesia yang berjalan di terminal — multi-tenant, plugin system, REST API, Web Admin, Telegram, dan support 100+ model AI.

![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)
![License MIT](https://img.shields.io/badge/license-MIT-blue)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

---

## Fitur

- 🤖 **AI-powered replies** — 11 provider: OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, Together AI, OpenRouter, Ollama, LM Studio, dan OpenAI-compatible endpoint
- 🖥️ **Interactive TUI** — arrow-key menus, number hotkeys, ESC cancel
- 👥 **Multi-tenant** — kelola banyak akun WhatsApp dari satu instalasi
- 🧩 **Plugin system** — drop `.js` ke `~/.bima/plugins/` untuk tambah command dan tool AI
- 📚 **Knowledge base** — index PDF, Word, Excel; agent ambil konteks otomatis
- 🔍 **Semantic search** — local vector embeddings via `@xenova/transformers`
- 🎙️ **Voice note STT** — transkripsi audio masuk via Whisper (ffmpeg-powered)
- 💬 **Group awareness** — pilih grup mana yang didengar dan dibalas
- 🧠 **Long-term memory** — ingat preferensi user antar sesi
- ⏰ **Reminders** — jadwal pesan dikirim di waktu tertentu
- 🌐 **Web search** — DuckDuckGo + Brave Search, auto-browse hasil
- 💸 **Realtime prices** — crypto (CoinGecko) dan saham (Yahoo Finance)
- 🔬 **Deep research** — multi-source web research dengan AI sub-queries
- 🔊 **Voice notes (TTS)** — `/voice` untuk balas pesan sebagai voice note
- 📊 **Prediction markets** — Polymarket real-time via `/polymarket`
- 👁️ **Topic watcher** — `/watch` monitor topik, kirim alert ke grup
- 👤 **Member profiles** — lacak history interaksi member grup via `/profiles`
- 👁‍🗨 **Vision AI** — kirim foto ke WhatsApp/Telegram, BIMA analisis (GPT-4o, Claude, Gemini)
- 💬 **Telegram support** — jalankan BIMA di Telegram sekaligus WhatsApp
- 📣 **Cross-group mention tracking** — lacak siapa di-tag dari semua grup, query via DM
- 🌐 **REST API** — HTTP endpoint untuk kirim pesan, query agent, kelola KB dari luar
- 🖥️ **Web Admin Panel** — browser UI untuk send pesan, lihat log, kelola KB
- 📱 **Termux (Android)** — jalan di HP Android via Termux

---

## Quick Start

```bash
# 1. Install global
npm install -g bima-agent

# 2. Jalankan
bima

# 3. Setup wizard
#    → /model  — pilih AI provider & masukkan API key
#    → /wa     — scan QR code dengan WhatsApp
#    → /input  — pilih grup yang didengar
#    → /output — pilih grup tempat Bima membalas
```

Data (auth session, knowledge base, plugins) disimpan di `~/.bima/`.
Override dengan env var `BIMA_DATA`.

---

## Platform Support

| Platform | Status | Catatan |
|---|---|---|
| Linux / Debian / Ubuntu | ✅ Full | `npm install -g bima-agent` |
| macOS | ✅ Full | `npm install -g bima-agent` |
| Windows | ✅ Full | `npm install -g bima-agent` |
| Docker | ✅ Full | `docker-compose up` |
| Termux (Android) | ✅ Partial | Lihat bagian Termux di bawah |
| Railway / Render / Fly.io | ✅ Full | Deploy via Docker image |

### Linux / Debian

```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

npm install -g bima-agent
bima
```

### Termux (Android)

```bash
pkg update && pkg install nodejs ffmpeg
npm install -g bima-agent
bima
```

> **Catatan Termux:** Semantic search (vector embeddings) dan local Whisper STT membutuhkan ONNX Runtime yang mungkin tidak tersedia di semua perangkat ARM. Semua fitur lain — WhatsApp, Telegram, AI replies, voice note via cloud STT, knowledge base (keyword search), web search — berjalan normal. Untuk STT gunakan `/stt` dan pilih `openai`, `groq`, atau `hf`.

---

## Docker

```bash
# Start (butuh terminal interaktif untuk QR scan pertama kali)
docker-compose up

# Setelah scan QR, jalankan headless
docker-compose up -d
```

Session dan data disimpan di `./bima-data/` di host. Container auto-restart kecuali dihentikan manual.

### Manual Docker

```bash
docker build -t bima-agent .
docker run -it --rm \
  -v "$(pwd)/bima-data:/data" \
  -e BIMA_DATA=/data \
  bima-agent
```

---

## Telegram

Jalankan BIMA di Telegram sekaligus (atau sebagai pengganti) WhatsApp — AI, KB, dan memory yang sama.

```bash
# 1. Dapatkan token dari @BotFather di Telegram
#    → /newbot → pilih nama → copy token

# 2. Di terminal BIMA:
/tg token 123456789:ABCdefGHI...   # simpan token
/tg start                           # aktifkan bot
```

Bot menerima: teks, foto (vision AI), voice note (STT), file (PDF/Excel/Word → KB).

---

## REST API

BIMA menyediakan REST API HTTP untuk integrasi eksternal (n8n, Zapier, custom app).

```bash
# Aktifkan API (simpan otomatis, auto-start sesi berikutnya)
/api start 3000

# Set API key (opsional, untuk keamanan)
/api key rahasia123

# Status
/api status

# Hentikan
/api stop
```

### Endpoints

| Method | Route | Deskripsi |
|---|---|---|
| `GET` | `/` | Web Admin Panel |
| `GET` | `/api/status` | Status WA, TG, model, tenant |
| `GET` | `/api/groups` | Daftar grup dikonfigurasi |
| `POST` | `/api/send` | Kirim pesan WA `{"jid":"...","text":"..."}` |
| `POST` | `/api/query` | Tanya agent AI `{"question":"..."}` |
| `GET` | `/api/knowledge` | List dokumen KB |
| `DELETE` | `/api/knowledge/:hash` | Hapus dokumen KB |
| `GET` | `/api/log?groupJid=xxx&hours=24` | Log percakapan grup |
| `GET` | `/api/ltm` | Long-term memory entries |

Auth via header `X-API-Key: <key>` atau query `?key=<key>`.

### Contoh

```bash
# Kirim pesan
curl -X POST http://localhost:3000/api/send \
  -H "X-API-Key: rahasia123" \
  -H "Content-Type: application/json" \
  -d '{"jid":"6281234567890@s.whatsapp.net","text":"Halo dari API!"}'

# Kirim ke nomor HP
curl -X POST http://localhost:3000/api/send \
  -H "X-API-Key: rahasia123" \
  -d '{"phone":"081234567890","text":"Halo!"}'

# Tanya agent
curl -X POST http://localhost:3000/api/query \
  -H "X-API-Key: rahasia123" \
  -d '{"question":"Siapa yang tag saya hari ini?"}'
```

---

## Web Admin Panel

Buka browser ke `http://localhost:3000/` setelah `/api start`.

- **Dashboard** — status WA, TG, model, tenant, daftar grup
- **Send** — kirim pesan ke grup atau nomor HP, tanya AI agent
- **Knowledge Base** — lihat dan hapus dokumen
- **Log** — lihat percakapan grup per periode

API key bisa diinput langsung di panel, disimpan di localStorage browser.

---

## Commands

| Command | Deskripsi |
|---|---|
| `/help` | Tampilkan daftar perintah |
| `/wa` | Hubungkan WhatsApp (scan QR) |
| `/status` | Status koneksi & konfigurasi |
| `/model` | Set AI provider, model, dan API key |
| `/input` | Pilih grup WhatsApp sebagai input |
| `/output` | Pilih grup WhatsApp sebagai output |
| `/api` | REST API + Web Admin (start/stop/key/status) |
| `/knowledge` | Lihat dokumen tersimpan |
| `/compact` | Kompres konteks dokumen (hemat token) |
| `/stt` | Konfigurasi Speech-to-Text |
| `/tts` | Konfigurasi Text-to-Speech |
| `/reminder` | Lihat pengingat aktif |
| `/memory` | Reset memori percakapan semua user |
| `/ltm` | Lihat / hapus long-term memory |
| `/search <query>` | Cari di web dari terminal |
| `/polymarket [query]` | Cari Polymarket prediction markets |
| `/tg` | Kelola Telegram bot (token/start/stop/status) |
| `/watch` | Monitor topik, kirim notif ke grup |
| `/profiles` | Lihat profil member grup |
| `/tenant` | Kelola tenant (list/add/switch/del) |
| `/skill` | Kelola plugin (list/add/remove/info) |
| `/logout` | Logout WhatsApp & hapus session |
| `/clear` | Bersihkan layar |
| `/exit` | Keluar dari BIMA |

---

## Configuration

```
~/.bima/
├── auth/           # Baileys WhatsApp session
├── plugins/        # Custom plugins (.js files)
├── config.json     # Provider, model, API key, grup, apiPort
├── db.json         # Knowledge base index
└── ltm.json        # Long-term memory
```

---

## Plugin Development

Drop file `.js` ke `~/.bima/plugins/`:

```js
// ~/.bima/plugins/my-plugin.js
module.exports = {
  name: 'my-plugin',
  description: 'Contoh plugin custom',

  commands: {
    '/greet': async (args, ctx) => {
      ctx.log('INFO', `Halo, ${args || 'dunia'}!`);
    },
  },

  tools: [
    {
      name: 'get_weather',
      description: 'Ambil cuaca saat ini untuk sebuah kota',
      async execute(input, tenantId) {
        return `Cuaca di ${input}: cerah 32°C`;
      },
    },
  ],
};
```

`ctx` exposes: `ctx.log(type, msg)`, `ctx.config`.

---

## AI Providers

| Provider | Contoh Model | API Key |
|---|---|---|
| **OpenRouter** | `meta-llama/llama-3.1-8b-instruct:free`, 100+ model | Ya — [openrouter.ai/keys](https://openrouter.ai/keys) |
| **OpenAI** | `gpt-4o-mini`, `gpt-4o` | Ya |
| **Anthropic** | `claude-3-haiku-20240307`, `claude-3-5-sonnet-20241022` | Ya |
| **Google Gemini** | `gemini-1.5-flash`, `gemini-1.5-pro` | Ya |
| **Groq** | `llama-3.1-8b-instant`, `mixtral-8x7b-32768` | Ya (free tier ada) |
| **Mistral AI** | `mistral-small-latest` | Ya |
| **DeepSeek** | `deepseek-chat`, `deepseek-coder` | Ya |
| **Together AI** | `meta-llama/Llama-3-8b-chat-hf` | Ya |
| **Ollama** (lokal) | `llama3`, `mistral`, dll | Tidak |
| **LM Studio** (lokal) | model apapun yang di-load | Tidak |
| **OpenAI-compatible** | custom endpoint | Opsional |

> **Gratis:** OpenRouter banyak model free-tier. Groq gratis dengan rate limit. Ollama dan LM Studio jalan sepenuhnya di mesin lokal.

---

## Contributing

1. Fork repo dan buat feature branch
2. Buat perubahan — PR fokus pada satu fitur
3. Smoke test: `node src/cli.js` dan verifikasi command yang diubah
4. Buka pull request dengan deskripsi perubahan

Bug report: sertakan versi Node.js, OS, dan output error lengkap.

---

## License

MIT © 2026 BIMA Contributors
