'use strict';

const { getConfig, saveConfig } = require('./config');
const { testAI }                = require('./ai');

// Returns true if setup is complete for the default tenant
function isSetupDone() {
  const cfg = getConfig('default');
  return !!(cfg.provider && cfg.apiKey);
}

// Interactive first-run wizard
async function runWizard(ask, println) {
  println(
    '\n' +
    '  ┌─────────────────────────────────────────────┐\n' +
    '  │   Selamat datang di BIMA Agent! 🎉           │\n' +
    '  │   Ayo setup dulu sebelum mulai...            │\n' +
    '  └─────────────────────────────────────────────┘\n'
  );

  // Step 1: AI Provider
  println(
    'LANGKAH 1 — Pilih AI Provider\n' +
    '  1. OpenAI         (gpt-4o-mini, gpt-4o)\n' +
    '  2. Anthropic      (claude-3-haiku, claude-3-5-sonnet)\n' +
    '  3. OpenRouter     (100+ model gratis & berbayar)\n' +
    '  4. Ollama         (local, gratis, butuh Ollama running)\n'
  );

  const provMap = {
    '1': { id: 'openai',     ex: 'gpt-4o-mini',                          url: 'https://platform.openai.com/api-keys' },
    '2': { id: 'anthropic',  ex: 'claude-3-haiku-20240307',              url: 'https://console.anthropic.com/keys' },
    '3': { id: 'openrouter', ex: 'meta-llama/llama-3.1-8b-instruct:free', url: 'https://openrouter.ai/keys' },
    '4': { id: 'ollama',     ex: 'llama3',                               url: 'http://localhost:11434' },
  };

  let choice = (await ask('  Pilih (1-4): ')).trim();
  const prov = provMap[choice] || provMap['1'];

  println(`\n  ✓ Provider: ${prov.id}`);

  // Step 2: Model
  const modelInput = (await ask(`  Nama model (Enter = ${prov.ex}): `)).trim();
  const model      = modelInput || prov.ex;

  // Step 3: API Key (skip for Ollama)
  let apiKey = '';
  if (prov.id !== 'ollama') {
    println(`\n  Dapatkan API key di: ${prov.url}`);
    apiKey = (await ask('  API Key: ')).trim();
    if (!apiKey) {
      println('  ✗ API Key kosong. Setup dibatalkan — ketik /model untuk coba lagi.');
      return false;
    }

    // Test
    println('\n  ⏳ Menguji koneksi AI...');
    const ok = await testAI({ provider: prov.id, model, apiKey });
    if (!ok) {
      println('  ✗ API Key atau model tidak valid. Ketik /model untuk coba lagi.');
      return false;
    }
    println('  ✓ Koneksi AI berhasil!');
  }

  saveConfig({ provider: prov.id, model, apiKey }, 'default');

  // Step 4: WhatsApp
  println(
    '\nLANGKAH 2 — WhatsApp\n' +
    '  Bima membutuhkan koneksi WhatsApp untuk menerima & mengirim pesan.\n'
  );

  const waAns = (await ask('  Hubungkan WhatsApp sekarang? (Y/n): ')).trim().toLowerCase();
  const doWA  = !waAns || waAns === 'y' || waAns === 'ya';

  println(
    '\n  ✓ Setup selesai!\n' +
    (doWA
      ? '  Memulai koneksi WA — scan QR yang muncul...\n'
      : '  Ketik /wa kapanpun untuk hubungkan WhatsApp.\n') +
    '  Ketik /help untuk lihat semua perintah.\n'
  );

  return { connectWA: doWA };
}

module.exports = { isSetupDone, runWizard };
