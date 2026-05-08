# Contributing to BIMA

Thanks for your interest in contributing!

## Getting started

```bash
git clone https://github.com/ghanibot/bima-agent.git
cd bima-agent
npm install
node src/cli.js
```

## Reporting bugs

Open an issue using the **Bug Report** template. Include the exact error output and your environment details.

## Submitting changes

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes — keep PRs focused on one thing
3. Test manually: `node src/cli.js` and exercise the commands you touched
4. Open a pull request with a clear description

## Writing plugins

The fastest way to extend BIMA is a plugin — no core changes needed.
See `src/example_plugin.js` and `plugins/polymarket.js` for reference.

## What we welcome

- Bug fixes
- New plugins (drop in `plugins/`)
- Improved Indonesian language handling
- Better STT/TTS integrations
- Documentation improvements

## What to avoid

- PRs that include personal data, API keys, or WhatsApp session files
- Large refactors without prior discussion (open an issue first)
- Breaking changes to the plugin API without a migration path

## Code style

- `'use strict'` at top of every file
- 2-space indent
- No comments that explain *what* — only *why* when non-obvious
