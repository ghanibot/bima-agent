```
  ██████╗ ██╗███╗   ███╗ █████╗
  ██╔══██╗██║████╗ ████║██╔══██╗
  ██████╔╝██║██╔████╔██║███████║
  ██╔══██╗██║██║╚██╔╝██║██╔══██║
  ██████╔╝██║██║ ╚═╝ ██║██║  ██║
  ╚═════╝ ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝
```

# BIMA — WhatsApp AI Agent for Indonesia

> Run a full AI-powered WhatsApp assistant straight from your terminal — multi-tenant, extensible via plugins, and wired to 100+ language models.

![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)
![License MIT](https://img.shields.io/badge/license-MIT-blue)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

---

## Features

- 🤖 **AI-powered replies** — 11 provider support: OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, Together AI, OpenRouter, Ollama, LM Studio, and any OpenAI-compatible endpoint
- 🖥️ **Interactive TUI** — arrow-key menus, number hotkeys, ESC cancel throughout all setup flows (`/model`, `/wa`, `/input`, `/output`, `/stt`, first-run wizard)
- 👥 **Multi-tenant** — manage multiple WhatsApp accounts or personas from one installation
- 🧩 **Plugin system** — drop a `.js` file into `~/.bima/plugins/` to add new CLI commands and agent tools
- 📚 **Knowledge base** — index PDFs, Word docs, and spreadsheets; the agent retrieves context automatically
- 🔍 **Semantic search** — local vector embeddings via `@xenova/transformers`, no cloud required
- 🎙️ **Voice note STT** — automatically transcribes incoming audio using Whisper (ffmpeg-powered)
- 💬 **Group awareness** — choose which WhatsApp groups to listen to and which to reply in
- 🧠 **Long-term memory** — remembers user preferences and important facts across conversations
- ⏰ **Reminders** — schedule messages to be sent at a future time
- 🌐 **Web search** — DuckDuckGo + Brave Search, auto-browses result pages for fresh data
- 💸 **Realtime prices** — crypto (CoinGecko) and stocks (Yahoo Finance) via `get_price`
- 🔬 **Deep research** — multi-source web research with AI-generated sub-queries
- 🔊 **Voice notes (TTS)** — reply any message with `/voice` to receive it as a voice note
- 📊 **Prediction markets** — search Polymarket for real-time event probabilities via `/polymarket`
- 👁️ **Topic watcher** — `/watch` monitors topics and sends alerts to a group when content changes
- 👤 **Member profiles** — tracks interaction history of WhatsApp group members via `/profiles`
- 👁‍🗨 **Vision AI** — send a photo to WhatsApp or Telegram and BIMA analyzes it (works with all vision-capable providers: GPT-4o, Claude, Gemini)
- 💬 **Telegram support** — run BIMA on Telegram alongside WhatsApp; same agent, same KB, same memory

---

## Quick Start

**3 steps to run BIMA:**

```bash
# 1. Install globally
npm install -g bima-agent

# 2. Launch the CLI
bima

# 3. Follow the setup wizard
#    → /model  — pick your AI provider & paste your API key
#    → /wa     — scan the QR code with WhatsApp to connect
#    → /input  — choose which group(s) to monitor
#    → /output — choose where the agent replies
```

Data (auth session, knowledge base, plugins) is stored in `~/.bima/` by default.
Override with the `BIMA_DATA` environment variable.

---

## Docker

The easiest way to run BIMA in a persistent, headless environment:

```bash
# Start (interactive terminal required for QR scan on first run)
docker-compose up

# Re-attach after first-run QR scan
docker-compose up -d
```

WhatsApp session and all data are persisted in `./bima-data/` on the host.
The container auto-restarts unless explicitly stopped.

### Manual Docker run

```bash
docker build -t bima-agent .
docker run -it --rm \
  -v "$(pwd)/bima-data:/data" \
  -e BIMA_DATA=/data \
  bima-agent
```

---

## Telegram

Run BIMA on Telegram alongside (or instead of) WhatsApp — same AI, same knowledge base, same long-term memory.

**Setup in 2 steps:**

```bash
# 1. Get a bot token from @BotFather on Telegram
#    → /newbot → choose a name → copy the token

# 2. In BIMA terminal:
/tg token 123456789:ABCdefGHI...   # save token
/tg start                           # activate bot
```

Once active, your bot accepts:
- **Text** — routed through the full agent loop (web search, KB, LTM, tools)
- **Photos** — analyzed by vision AI (GPT-4o / Claude / Gemini)
- **Voice notes** — transcribed via STT then answered
- **Files** (PDF/Excel/Word) — added to the shared knowledge base

The bot auto-starts on every BIMA launch when a token is saved. Status shows in the terminal status bar as `TG:@botname`.

---

## Commands

| Command | Description |
|---|---|
| `/help` | Show this command list |
| `/wa` | Connect WhatsApp (scan QR code) |
| `/status` | Show connection & configuration status |
| `/model` | Set AI provider, model, and API key (interactive menu) |
| `/input` | Select WhatsApp group(s) as agent input |
| `/output` | Select WhatsApp group as agent output |
| `/knowledge` | List indexed documents |
| `/compact` | Compress document context (saves tokens) |
| `/stt` | Configure Speech-to-Text for voice notes |
| `/tts` | Configure Text-to-Speech voice (slow/normal) |
| `/reminder` | View active reminders |
| `/memory` | Reset conversation memory for all users |
| `/ltm` | View / delete long-term memory entries |
| `/search <query>` | Search the web from the terminal |
| `/polymarket [query]` | Search Polymarket prediction markets (omit query for trending) |
| `/tg` | Manage Telegram bot (token / start / stop / status) |
| `/watch` | Monitor a topic and alert a group when it changes |
| `/profiles` | View interaction profiles of WhatsApp group members |
| `/tenant` | Manage tenants (list / add / switch / del / groups) |
| `/skill` | Manage plugins (list / add / info) |
| `/logout` | Log out of WhatsApp and delete session |
| `/clear` | Clear the screen |
| `/exit` | Exit BIMA |

All menus use arrow-key navigation with number hotkeys (1–9) and ESC to cancel.

You can also type any question directly — BIMA will answer using the configured AI model and your knowledge base.

### Voice Note Reply

Reply any message in the group with `/voice` and BIMA will convert the quoted text to a voice note using Google TTS and send it back as audio.

Attach a local file to your message with `@path/to/file.pdf`.

---

## Configuration

BIMA stores all state in `~/.bima/` (or `$BIMA_DATA`):

```
~/.bima/
├── auth/           # Baileys WhatsApp session (auto-created on /wa)
├── plugins/        # Custom plugins (drop .js files here)
├── config.json     # Provider, model, API key, group selections
├── db.json         # Knowledge base index
└── ltm.json        # Long-term memory store
```

---

## Plugin Development

Drop a `.js` file into `~/.bima/plugins/` and BIMA loads it automatically on next start (or `/skill add`).

```js
// ~/.bima/plugins/my-plugin.js
module.exports = {
  name: 'my-plugin',
  description: 'Contoh plugin custom',

  // New CLI commands
  commands: {
    '/greet': async (args, ctx) => {
      ctx.log('INFO', `Halo, ${args || 'dunia'}!`);
    },
  },

  // New tools available to the AI agent
  tools: [
    {
      name: 'get_weather',
      description: 'Ambil cuaca saat ini untuk sebuah kota',
      async execute(input, tenantId) {
        // input = string from the agent, tenantId = active tenant
        return `Cuaca di ${input}: cerah 32°C`;
      },
    },
  ],
};
```

The `ctx` object passed to commands exposes:
- `ctx.log(type, message)` — write to the BIMA log panel
- `ctx.config` — current tenant configuration

---

## AI Providers

BIMA supports 11 providers — switch anytime with `/model`, no restart required.

| Provider | Example models | API key required |
|---|---|---|
| **OpenRouter** | `meta-llama/llama-3.1-8b-instruct:free`, `google/gemini-flash-1.5`, 100+ more | Yes — [openrouter.ai/keys](https://openrouter.ai/keys) |
| **OpenAI** | `gpt-4o-mini`, `gpt-4o` | Yes — [platform.openai.com](https://platform.openai.com/api-keys) |
| **Anthropic** | `claude-3-haiku-20240307`, `claude-3-5-sonnet-20241022` | Yes — [console.anthropic.com](https://console.anthropic.com/keys) |
| **Google Gemini** | `gemini-1.5-flash`, `gemini-1.5-pro` | Yes — [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **Groq** | `llama-3.1-8b-instant`, `mixtral-8x7b-32768` | Yes — [console.groq.com](https://console.groq.com/keys) |
| **Mistral AI** | `mistral-small-latest`, `mixtral-8x7b` | Yes — [console.mistral.ai](https://console.mistral.ai/api-keys) |
| **DeepSeek** | `deepseek-chat`, `deepseek-coder` | Yes — [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| **Together AI** | `meta-llama/Llama-3-8b-chat-hf` | Yes — [api.together.xyz](https://api.together.xyz/settings/api-keys) |
| **Ollama** (local) | `llama3`, `mistral`, any Ollama model | No — needs Ollama running locally |
| **LM Studio** (local) | any loaded model | No — needs LM Studio server running |
| **OpenAI-compatible** | any model | Optional — custom endpoint (vLLM, llama.cpp, etc.) |

> **Free options:** OpenRouter has many free-tier models. Groq is free with rate limits. Ollama and LM Studio run entirely on your machine — no API key, no cost, full privacy.

---

## Contributing

Contributions are welcome!

1. Fork the repo and create a feature branch
2. Make your changes — please keep pull requests focused
3. Run a quick smoke test: `node src/cli.js` and verify the commands you touched still work
4. Open a pull request describing what you changed and why

For bugs, please open an issue with the Node.js version, OS, and the exact error output.

---

## License

MIT © 2026 BIMA Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
