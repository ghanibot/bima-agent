'use strict';

const { getConfig } = require('./config');

// ── Provider registry ─────────────────────────────────────────
// All OpenAI-compatible providers share the same request format
const OAI_COMPAT = {
  openai:     cfg => `https://api.openai.com/v1`,
  openrouter: cfg => `https://openrouter.ai/api/v1`,
  groq:       cfg => `https://api.groq.com/openai/v1`,
  mistral:    cfg => `https://api.mistral.ai/v1`,
  together:   cfg => `https://api.together.xyz/v1`,
  deepseek:   cfg => `https://api.deepseek.com/v1`,
  fireworks:  cfg => `https://api.fireworks.ai/inference/v1`,
  ollama:     cfg => `${(cfg.baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/v1`,
  lmstudio:   cfg => `${(cfg.baseUrl || 'http://localhost:1234').replace(/\/$/, '')}/v1`,
  compat:     cfg => `${(cfg.baseUrl || '').replace(/\/$/, '')}/v1`,
};

// Provider yang ditampilkan pertama saat setup /model
const PRIMARY_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'ollama'];

const PROVIDER_NAMES = {
  // ── 6 Provider Utama ─────────────────────────────────────────
  anthropic:  'Claude (Anthropic)',
  openai:     'OpenAI (GPT)',
  gemini:     'Google Gemini',
  openrouter: 'OpenRouter (100+ model)',
  groq:       'Groq (cepat & gratis)',
  ollama:     'Ollama (lokal/cloud)',
  // ── Provider Tambahan ────────────────────────────────────────
  mistral:    'Mistral AI',
  together:   'Together AI',
  deepseek:   'DeepSeek',
  fireworks:  'Fireworks AI',
  lmstudio:   'LM Studio (lokal)',
  compat:     'OpenAI-compatible (custom URL)',
};

// Providers that don't need an API key
const NO_KEY_PROVIDERS = new Set(['ollama', 'lmstudio']);

// ── nano-proxy URL resolver ────────────────────────────────────
// Maps provider → nano-proxy path prefix
const PROXY_PATHS = {
  anthropic:  'anthropic',
  openai:     'openai',
  groq:       'groq',
  gemini:     'gemini',
  mistral:    'mistral',
  ollama:     'ollama',
};

function _proxyBaseUrl(provider) {
  try {
    const { nanoProxy } = require('./nano');
    if (nanoProxy.isAvailable() && PROXY_PATHS[provider]) {
      return `http://127.0.0.1:${nanoProxy.getPort()}/${PROXY_PATHS[provider]}`;
    }
  } catch {}
  return null;
}

// ── Build HTTP request ─────────────────────────────────────────
function buildReq(cfg, messages, system) {
  const { provider, model, apiKey, baseUrl } = cfg;
  const sys = system || 'Kamu adalah Bima, asisten AI cerdas. Jawab to the point.';
  const proxyBase = _proxyBaseUrl(provider);

  // Anthropic — different format
  if (provider === 'anthropic') {
    const url = proxyBase ? `${proxyBase}/v1/messages` : 'https://api.anthropic.com/v1/messages';
    return {
      url,
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: { model, system: sys, messages, max_tokens: 2000 },
      _provider: 'anthropic',
    };
  }

  // Google Gemini — different format (no proxy support yet)
  if (provider === 'gemini') {
    const geminiMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: Array.isArray(m.content)
        ? m.content
        : [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: sys }] },
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: 2000 },
      },
      _provider: 'gemini',
    };
  }

  // OpenAI-compatible providers
  const baseUrlFn = OAI_COMPAT[provider];
  if (!baseUrlFn) throw new Error(`Provider tidak dikenal: ${provider}`);

  // Use nano-proxy if available, else direct API
  const base = proxyBase ? `${proxyBase}/v1` : baseUrlFn(cfg);
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${apiKey || 'ollama'}`,
    ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/ghanibot/bima-agent' } : {}),
  };

  return {
    url: `${base}/chat/completions`,
    headers,
    body: { model, messages: [{ role: 'system', content: sys }, ...messages], max_tokens: 2000 },
    _provider: 'openai-compat',
  };
}

// ── Image content blocks ───────────────────────────────────────
function buildImageContent(provider, base64Data, mimeType, textCaption) {
  if (provider === 'anthropic') {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
    ];
    if (textCaption) blocks.push({ type: 'text', text: textCaption });
    return blocks;
  }
  if (provider === 'gemini') {
    const parts = [{ inline_data: { mime_type: mimeType, data: base64Data } }];
    if (textCaption) parts.push({ text: textCaption });
    return parts;
  }
  // OpenAI-compatible
  const parts = [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } }];
  if (textCaption) parts.push({ type: 'text', text: textCaption });
  return parts;
}

function parseReply(req, data) {
  if (req._provider === 'anthropic') return data?.content?.[0]?.text || null;
  if (req._provider === 'gemini')    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  return data?.choices?.[0]?.message?.content || null;
}

// ── Core call (single provider) ───────────────────────────────
async function _callOnce(cfg, messages, system) {
  const req = buildReq(cfg, messages, system);
  const res = await fetch(req.url, {
    method:  'POST',
    headers: req.headers,
    body:    JSON.stringify(req.body),
    signal:  AbortSignal.timeout(30000),
  });

  const data = await res.json();
  if (!res.ok) {
    const errMsg = data?.error?.message || data?.message || JSON.stringify(data).slice(0, 200);
    const err = new Error(`API ${res.status}: ${errMsg}`);
    err.status = res.status;
    throw err;
  }

  const reply = parseReply(req, data);
  if (!reply) throw new Error('Respons AI kosong');
  return reply;
}

// ── callAI: with per-tenant fallback support ──────────────────
async function callAI(messages, system, cfgOverride) {
  const cfg = cfgOverride || getConfig();
  if (!cfg.provider) throw new Error('AI belum dikonfigurasi. Ketik /model');
  if (!cfg.apiKey && !NO_KEY_PROVIDERS.has(cfg.provider)) throw new Error('API key belum diset. Ketik /model');

  // Try primary provider
  try {
    return await _callOnce(cfg, messages, system);
  } catch (primaryErr) {
    // Try fallback if configured and primary was rate-limited or server error
    const isRetryable = primaryErr.status === 429 || primaryErr.status >= 500;
    if (isRetryable && cfg.fallbackProvider && (cfg.fallbackApiKey || NO_KEY_PROVIDERS.has(cfg.fallbackProvider))) {
      const fallbackCfg = {
        ...cfg,
        provider: cfg.fallbackProvider,
        apiKey:   cfg.fallbackApiKey || '',
        model:    cfg.fallbackModel || cfg.model,
      };
      try {
        return await _callOnce(fallbackCfg, messages, system);
      } catch {}
    }
    throw primaryErr;
  }
}

// ── Test connection ────────────────────────────────────────────
async function testAI(cfg) {
  try {
    await callAI([{ role: 'user', content: 'Reply only: OK' }], 'Reply: OK', cfg);
    return true;
  } catch { return false; }
}

// ── Answer from knowledge context ─────────────────────────────
async function answerQuestion(question, context, cfgOverride) {
  const sys = `Kamu adalah Bima, asisten AI WhatsApp dari Indonesia.
Gunakan konteks data untuk menjawab. Jawab santai dan informatif.

FORMAT (pesan WhatsApp — bukan web):
- DILARANG tabel markdown. Gunakan list bernomor/bullet.
- Pakai *teks tebal* untuk label penting.
- Jika tidak ada info relevan, bilang jujur.`;

  const content = context
    ? `Konteks data:\n${context}\n\nPertanyaan: ${question}`
    : question;

  return callAI([{ role: 'user', content }], sys, cfgOverride);
}

// ── Structure file text into JSON ─────────────────────────────
async function structureText(rawText) {
  const prompt = `Bersihkan dan strukturkan teks ini menjadi JSON valid.
Aturan: identifikasi header/kolom, setiap baris jadi object dalam array "data", tambahkan "meta".
Balas HANYA JSON valid.\n\nTeks:\n${rawText.slice(0, 3000)}`;

  const reply = await callAI([{ role: 'user', content: prompt }], 'Kamu ekstraktor data JSON yang teliti.');
  try {
    return JSON.parse(reply.replace(/```json|```/gi, '').trim());
  } catch {
    return { raw_excerpt: rawText.slice(0, 300) };
  }
}

// ── Compact/summarize for context compression ─────────────────
async function compactContext(rawText, filename, cfgOverride) {
  const sys = `Ringkas teks menjadi bentuk padat TANPA kehilangan fakta penting.
Pertahankan: semua nama, angka, harga, tanggal, status. Output bahasa Indonesia.`;
  const prompt = `File: ${filename}\n\nTeks:\n${rawText.slice(0, 6000)}\n\nBuat ringkasan padat.`;
  return callAI([{ role: 'user', content: prompt }], sys, cfgOverride);
}

// ── Analyze image with vision ──────────────────────────────────
async function analyzeImage(imageBuffer, mimeType, caption, cfgOverride) {
  const cfg = cfgOverride || getConfig();
  if (!cfg.provider) throw new Error('AI belum dikonfigurasi.');

  const base64 = imageBuffer.toString('base64');
  const prompt  = caption || 'Jelaskan isi gambar ini secara detail.';
  const sys     = 'Kamu Bima, asisten AI WhatsApp Indonesia. Analisis gambar, jawab santai. Jangan pakai tabel markdown.';

  const contentBlocks = buildImageContent(cfg.provider, base64, mimeType || 'image/jpeg', prompt);
  const messages = [{ role: 'user', content: contentBlocks }];

  const req = buildReq(cfg, messages, sys);
  const res = await fetch(req.url, {
    method:  'POST',
    headers: req.headers,
    body:    JSON.stringify(req.body),
    signal:  AbortSignal.timeout(30000),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`);
  return parseReply(req, data) || 'Tidak bisa menganalisis gambar.';
}

module.exports = {
  callAI, testAI, answerQuestion, structureText, compactContext, analyzeImage,
  PROVIDER_NAMES, PRIMARY_PROVIDERS, NO_KEY_PROVIDERS, OAI_COMPAT,
};
