# Nano Ecosystem Integration — Bima Agent
**Date:** 2026-05-15  
**Status:** Approved

## Overview
Integrate nano-guard, nano-memory, and nano-proxy as sidecar Python processes into Bima Agent (Node.js). All three run on the same machine, managed by Bima's lifecycle. Graceful fallback if Python/nano not available.

## Architecture

```
Bima (Node.js)
  ├── spawn → nano-proxy   (port 8765)  LLM routing + per-tenant fallback
  ├── spawn → nano-guard   (port 8768)  Input scanning + blacklist
  └── spawn → nano-memory  (port 8769)  Semantic memory (replaces memory.js)
```

**New file:** `src/nano.js`
- Check Python + nano packages available
- Spawn 3 child processes on startup
- Health-check with 5x retry + backoff
- If any service fails → log warning, Bima continues with fallback
- Graceful shutdown: kill all children on process.exit

**Config field added:** `nanoEnabled: true/false` (per tenant config)

## nano-proxy (Section 2)

Per-tenant config:
```json
{ "nanoProviders": ["anthropic", "groq", "gemini"], "nanoStrategy": "priority" }
```

- `src/ai.js` routes calls through `localhost:8765/{provider}/v1` when nano-proxy is up
- `/model` CLI adds option: "Konfigurasi via nano-proxy"
- Auto-fallback on rate-limit handled by nano-proxy transparently

## nano-memory (Section 3)

- `src/memory.js` rewritten as HTTP client to nano-memory service
- Same exported API: `addTurn()`, `getHistory()`, `clearHistory()`, `clearAll()`
- Namespace: `{tenantId}::{groupJid}::{senderJid}`
- Existing JSON history files auto-migrated on first startup
- Fallback: if nano-memory down, use in-memory Map (same as original behavior)

## nano-guard + Blacklist (Section 4)

**Flow:**
1. Every incoming group/DM message → `POST localhost:8768/scan`
2. If injection/toxic detected:
   - Reply with: "Pesan mengandung konten yang tidak diizinkan: [kategori]"
   - Add sender to blacklist (`~/.bima/blacklist.db` SQLite)
   - CLI log: `[GUARD] Blacklist: +6281234 — prompt_injection`
3. Blacklisted senders: still processed but use cheapest model (groq llama-3.1-8b)

**New file:** `src/blacklist.js` — SQLite CRUD for blacklist entries

**CLI additions:**
- `/blacklist` — list all blacklisted numbers
- `/blacklist del <nomor>` — remove from blacklist

## Files Changed

| File | Change |
|------|--------|
| `src/nano.js` | NEW — sidecar manager |
| `src/blacklist.js` | NEW — blacklist SQLite CRUD |
| `src/memory.js` | REPLACE — HTTP client to nano-memory |
| `src/ai.js` | MODIFY — route through nano-proxy when available |
| `src/whatsapp.js` | MODIFY — guard scan before handleQuery |
| `src/cli.js` | MODIFY — /blacklist command, nano-proxy model config |
| `src/config.js` | MODIFY — nanoEnabled + nanoProviders fields |
| `package.json` | MODIFY — add better-sqlite3 for blacklist |
