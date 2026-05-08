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

- 🤖 **AI-powered replies** — supports OpenAI, Anthropic, and OpenRouter (100+ models via a single API key)
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
- 📊 **Prediction markets** — Polymarket plugin for real-time event probabilities

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

## Commands

| Command | Description |
|---|---|
| `/help` | Show this command list |
| `/wa` | Connect WhatsApp (scan QR code) |
| `/status` | Show connection & configuration status |
| `/model` | Set AI provider, model, and API key |
| `/input` | Select WhatsApp group(s) as agent input |
| `/output` | Select WhatsApp group as agent output |
| `/knowledge` | List indexed documents |
| `/compact` | Compress document context (saves tokens) |
| `/stt` | Configure Speech-to-Text for voice notes |
| `/tts` | Configure Text-to-Speech voice (slow/normal) |
| `/reminder` | View active reminders |
| `/memory` | Reset conversation memory for all users |
| `/ltm` | View / delete long-term memory entries |
| `/search` | Search the web from the terminal |
| `/tenant` | Manage tenants (list / add / switch / del / groups) |
| `/skill` | Manage plugins (list / add / info) |
| `/logout` | Log out of WhatsApp and delete session |
| `/clear` | Clear the screen |
| `/exit` | Exit BIMA |

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

| Provider | Example models |
|---|---|
| **OpenAI** | `gpt-4o-mini`, `gpt-4o` |
| **Anthropic** | `claude-3-haiku-20240307`, `claude-3-5-sonnet-20241022` |
| **OpenRouter** | `meta-llama/llama-3-8b-instruct`, `google/gemini-flash-1.5`, and 100+ more |

Run `/model` inside BIMA to switch provider at any time. The new model takes effect immediately — no restart required.

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
