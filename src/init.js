'use strict';

const { getConfig, saveConfig } = require('./config');
const { testAI, PROVIDER_NAMES, NO_KEY_PROVIDERS } = require('./ai');
const { LANGUAGES } = require('./languages');
const { addTenant } = require('./tenant');

// Returns true if setup is complete
function isSetupDone() {
  const cfg = getConfig('default');
  return !!(cfg.provider && (cfg.apiKey || NO_KEY_PROVIDERS.has(cfg.provider)));
}

// ── Provider menu ─────────────────────────────────────────────
const PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter',          hint: '100+ model gratis & berbayar',   url: 'https://openrouter.ai/keys',               ex: 'meta-llama/llama-3.1-8b-instruct:free', needKey: true,  needUrl: false },
  { id: 'openai',     label: 'OpenAI',              hint: 'gpt-4o-mini, gpt-4o',             url: 'https://platform.openai.com/api-keys',     ex: 'gpt-4o-mini',                           needKey: true,  needUrl: false },
  { id: 'anthropic',  label: 'Anthropic',           hint: 'claude-3-haiku, claude-3-5-sonnet', url: 'https://console.anthropic.com/keys',     ex: 'claude-3-haiku-20240307',               needKey: true,  needUrl: false },
  { id: 'gemini',     label: 'Google Gemini',       hint: 'gemini-1.5-flash, gemini-1.5-pro', url: 'https://aistudio.google.com/app/apikey', ex: 'gemini-1.5-flash',                      needKey: true,  needUrl: false },
  { id: 'groq',       label: 'Groq',                hint: 'cepat & gratis (llama, mixtral)',  url: 'https://console.groq.com/keys',            ex: 'llama-3.1-8b-instant',                  needKey: true,  needUrl: false },
  { id: 'mistral',    label: 'Mistral AI',          hint: 'mistral-small, mixtral-8x7b',     url: 'https://console.mistral.ai/api-keys',      ex: 'mistral-small-latest',                  needKey: true,  needUrl: false },
  { id: 'deepseek',   label: 'DeepSeek',            hint: 'deepseek-chat, deepseek-coder',   url: 'https://platform.deepseek.com/api_keys',   ex: 'deepseek-chat',                         needKey: true,  needUrl: false },
  { id: 'together',   label: 'Together AI',         hint: 'llama, mistral, qwen via API',    url: 'https://api.together.xyz/settings/api-keys', ex: 'meta-llama/Llama-3-8b-chat-hf',      needKey: true,  needUrl: false },
  { id: 'ollama',     label: 'Ollama (lokal)',       hint: 'tanpa API key, butuh Ollama',     url: 'https://ollama.com',                       ex: 'llama3',                                needKey: false, needUrl: true  },
  { id: 'lmstudio',   label: 'LM Studio (lokal)',   hint: 'tanpa API key, butuh LM Studio',  url: 'https://lmstudio.ai',                      ex: 'local-model',                           needKey: false, needUrl: true  },
  { id: 'compat',     label: 'OpenAI-compatible',   hint: 'endpoint custom (vLLM, dll)',      url: '',                                         ex: 'my-model',                              needKey: false, needUrl: true  },
];

// ── First-run wizard ──────────────────────────────────────────
async function runWizard(ask, println) {
  println(
    '\n  ┌─────────────────────────────────────────────────┐\n' +
    '  │   Selamat datang di BIMA Agent!                 │\n' +
    '  │   Mari setup sebentar sebelum mulai...          │\n' +
    '  └─────────────────────────────────────────────────┘\n'
  );

  // ── Step 1: Provider ─────────────────────────────────────────
  println('LANGKAH 1/4 — Pilih AI Provider (Enter untuk skip, pakai nanti)\n');
  PROVIDERS.forEach((p, i) => {
    println(`  ${String(i + 1).padStart(2)}. ${p.label.padEnd(20)} ${p.hint}`);
  });
  println('');

  const provChoice = (await ask('  Pilih provider (1-11, Enter=skip): ')).trim();
  let provConfig = null;

  if (provChoice && !isNaN(provChoice)) {
    const prov = PROVIDERS[parseInt(provChoice) - 1];
    if (prov) {
      println(`\n  ✓ Provider: ${prov.label}`);

      // Model
      const modelInput = (await ask(`  Nama model (Enter = ${prov.ex}): `)).trim();
      const model = modelInput || prov.ex;

      // Base URL for local providers
      let baseUrl = '';
      if (prov.needUrl) {
        const defaultUrl = prov.id === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234';
        const urlInput = (await ask(`  Base URL (Enter = ${defaultUrl}): `)).trim();
        baseUrl = urlInput || defaultUrl;
      }

      // API Key
      let apiKey = '';
      if (prov.needKey) {
        if (prov.url) println(`  Dapatkan API key: ${prov.url}`);
        const keyInput = (await ask('  API Key (Enter=skip): ')).trim();
        if (keyInput) {
          apiKey = keyInput;
          println('\n  ⏳ Menguji koneksi...');
          const cfg = { provider: prov.id, model, apiKey, baseUrl };
          const ok = await testAI(cfg);
          if (ok) {
            println('  ✓ Koneksi berhasil!');
          } else {
            println('  ⚠ Koneksi gagal — disimpan tetapi mungkin perlu dicek ulang via /model.');
          }
        }
      } else {
        // Local provider — test connection
        println('\n  ⏳ Menguji koneksi lokal...');
        const cfg = { provider: prov.id, model, apiKey: '', baseUrl };
        const ok = await testAI(cfg);
        println(ok ? '  ✓ Koneksi berhasil!' : `  ⚠ Tidak bisa konek ke ${baseUrl} — pastikan ${prov.label} sudah running.`);
      }

      provConfig = { provider: prov.id, model, apiKey, ...(baseUrl ? { baseUrl } : {}) };
    }
  }

  if (!provConfig) {
    println('  ⏭ Provider dilewati — ketik /model untuk setup nanti.\n');
  }

  // ── Step 2: Language ─────────────────────────────────────────
  println('\nLANGKAH 2/4 — Pilih Bahasa Respons\n');

  // Show languages in 3 columns
  const colW = 25;
  for (let i = 0; i < LANGUAGES.length; i += 3) {
    const a = LANGUAGES[i];
    const b = LANGUAGES[i + 1];
    const c = LANGUAGES[i + 2];
    const fmtLang = (l, idx) => l ? `${String(idx + 1).padStart(3)}. ${l.native.slice(0, 14).padEnd(14)}` : '';
    println(`  ${fmtLang(a, i)}  ${fmtLang(b, i + 1)}  ${fmtLang(c, i + 2)}`);
  }
  println('');

  const langChoice = (await ask('  Pilih bahasa (1-50, Enter=1 Indonesia): ')).trim();
  const langIdx  = langChoice ? (parseInt(langChoice) - 1) : 0;
  const lang     = LANGUAGES[Math.max(0, Math.min(49, langIdx || 0))];
  println(`  ✓ Bahasa: ${lang.native} (${lang.name})\n`);

  // ── Step 3: Tenant name ──────────────────────────────────────
  println('LANGKAH 3/4 — Nama Tenant\n');
  println('  Tenant = identitas/profil Bima (bisa punya banyak tenant untuk klien berbeda)\n');
  const tenantName = (await ask('  Nama tenant pertama (Enter = "default"): ')).trim() || 'default';
  println(`  ✓ Tenant: ${tenantName}\n`);

  // ── Step 4: WhatsApp ─────────────────────────────────────────
  println('LANGKAH 4/4 — WhatsApp\n');
  const waAns = (await ask('  Hubungkan WhatsApp sekarang? (Y/n): ')).trim().toLowerCase();
  const doWA  = !waAns || waAns === 'y' || waAns === 'ya';

  // Save everything
  const finalCfg = {
    ...(provConfig || {}),
    language:   lang.code,
    tenantName,
  };
  saveConfig(finalCfg, 'default');

  // Create named tenant if different from default
  if (tenantName && tenantName !== 'default') {
    try { addTenant({ id: tenantName.toLowerCase().replace(/\s+/g, '_'), name: tenantName }); } catch {}
  }

  println(
    '\n  ✓ Setup selesai!\n' +
    `  Bahasa    : ${lang.native}\n` +
    `  Tenant    : ${tenantName}\n` +
    (provConfig ? `  Provider  : ${provConfig.provider} / ${provConfig.model}\n` : '') +
    (doWA ? '  Memulai koneksi WA — scan QR yang muncul...\n' : '  Ketik /wa kapanpun untuk hubungkan WhatsApp.\n') +
    '  Ketik /help untuk semua perintah.\n'
  );

  return { connectWA: doWA };
}

module.exports = { isSetupDone, runWizard };
