'use strict';

const { getConfig } = require('./config');

// ── Build HTTP request ────────────────────────────────────────
function buildReq(cfg, messages, system) {
  const { provider, model, apiKey } = cfg;

  const sys = system || 'Kamu adalah Bima, asisten AI cerdas berbahasa Indonesia. Jawab santai dan to the point.';

  if (provider === 'openai' || provider === 'openrouter') {
    return {
      url: provider === 'openrouter'
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://bima-agent.id' } : {}),
      },
      body: { model, messages: [{ role: 'system', content: sys }, ...messages], max_tokens: 2000 },
    };
  }

  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: { model, system: sys, messages, max_tokens: 2000 },
    };
  }

  throw new Error(`Provider tidak dikenal: ${provider}`);
}

// ── Build image content block (provider-aware) ────────────────
function buildImageContent(provider, base64Data, mimeType, textCaption) {
  if (provider === 'anthropic') {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
    ];
    if (textCaption) blocks.push({ type: 'text', text: textCaption });
    return blocks;
  }
  // OpenAI / OpenRouter
  const parts = [
    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
  ];
  if (textCaption) parts.push({ type: 'text', text: textCaption });
  return parts;
}

function parseReply(provider, data) {
  if (provider === 'anthropic') return data?.content?.[0]?.text || null;
  return data?.choices?.[0]?.message?.content || null;
}

// ── Core call ─────────────────────────────────────────────────
async function callAI(messages, system, cfgOverride) {
  const cfg = cfgOverride || getConfig();
  if (!cfg.provider || !cfg.apiKey) throw new Error('AI belum dikonfigurasi. Ketik /model');

  const req = buildReq(cfg, messages, system);
  const res = await fetch(req.url, {
    method:  'POST',
    headers: req.headers,
    body:    JSON.stringify(req.body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);

  const reply = parseReply(cfg.provider, data);
  if (!reply) throw new Error('Respons AI kosong');
  return reply;
}

// ── Test connection ────────────────────────────────────────────
async function testAI(cfg) {
  try {
    await callAI([{ role: 'user', content: 'Balas hanya: OK' }], 'Balas singkat: OK', cfg);
    return true;
  } catch { return false; }
}

// ── Answer from knowledge context ────────────────────────────
async function answerQuestion(question, context, cfgOverride) {
  const sys = `Kamu adalah Bima, asisten AI WhatsApp cerdas dari Indonesia.
Gunakan konteks data yang diberikan untuk menjawab pertanyaan.
Jawab dengan bahasa Indonesia yang santai dan informatif.

ATURAN FORMAT (WAJIB — ini pesan WhatsApp, bukan web):
- DILARANG KERAS pakai tabel markdown (|---|---|). WhatsApp tidak render tabel, jadi berantakan.
- Format data sebagai list bernomor atau bullet. Contoh:
  1. *Nama:* Fajri B → Burung | Plastik Merah | 5kg | Rp25.000 LUNAS
  2. *Nama:* Jeslin J → Burung | Plastik Hitam | 6kg | Rp45.000 LUNAS
- Pisahkan tiap item dengan baris baru.
- Pakai *teks tebal* untuk label penting.
- Jika pertanyaan SPESIFIK (misal "siapa penerima tanggal 16"), tampilkan HANYA data relevan, bukan semua.
- Jika user minta "data lengkap" atau "semua data", baru tampilkan seluruh isi.
- Jika tidak ada info relevan, bilang jujur tapi tetap bantu sebisamu.`;

  const content = context
    ? `Konteks data:\n${context}\n\nPertanyaan: ${question}`
    : question;

  return callAI([{ role: 'user', content }], sys, cfgOverride);
}

// ── Structure file text into JSON ────────────────────────────
async function structureText(rawText) {
  const prompt = `Kamu menerima teks hasil ekstraksi dari file Excel/PDF yang mungkin berantakan.
Tugasmu: bersihkan, rapikan, dan strukturkan menjadi JSON.

Aturan:
- Identifikasi header/kolom dari tabel secara otomatis
- Setiap baris data jadi satu object dalam array "data"
- Bersihkan spasi berlebih, karakter aneh, baris kosong
- Pertahankan semua nilai angka, nama, tanggal secara akurat
- Tambahkan field "meta" berisi judul dokumen, tanggal, dan info header jika ada
- Balas HANYA dengan JSON valid, tanpa teks lain

Teks:
${rawText.slice(0, 3000)}`;

  const reply = await callAI([{ role: 'user', content: prompt }], 'Kamu adalah ekstraktor dan pembersih data JSON yang teliti.');
  try {
    return JSON.parse(reply.replace(/```json|```/gi, '').trim());
  } catch {
    return { raw_excerpt: rawText.slice(0, 300) };
  }
}

// ── Compact/summarize for context compression ────────────────
async function compactContext(rawText, filename, cfgOverride) {
  const sys = `Kamu adalah sistem kompresi konteks data.
Tugasmu: ringkas teks menjadi bentuk padat TANPA kehilangan fakta penting.

WAJIB pertahankan:
- Semua nama orang, perusahaan, lokasi
- Semua angka, jumlah, harga, berat
- Semua tanggal dan waktu
- Semua status (lunas, belum, pending, dll)
- Struktur tabel/list (konversi ke format ringkas)

Output: ringkasan terstruktur bahasa Indonesia. Jangan buang data apapun.`;

  const prompt = `File: ${filename}\n\nTeks asli (${rawText.length} karakter):\n${rawText.slice(0, 6000)}\n\nBuat ringkasan padat yang mempertahankan SEMUA data penting.`;
  return callAI([{ role: 'user', content: prompt }], sys, cfgOverride);
}

// ── Analyze image with vision ─────────────────────────────────
async function analyzeImage(imageBuffer, mimeType, caption, cfgOverride) {
  const cfg = cfgOverride || getConfig();
  if (!cfg.provider || !cfg.apiKey) throw new Error('AI belum dikonfigurasi.');

  const base64 = imageBuffer.toString('base64');
  const prompt  = caption || 'Jelaskan isi gambar ini secara detail dalam Bahasa Indonesia.';

  const contentBlocks = buildImageContent(cfg.provider, base64, mimeType || 'image/jpeg', prompt);

  const sys = `Kamu adalah Bima, asisten AI WhatsApp dari Indonesia.
Analisis gambar dan jawab dengan bahasa Indonesia yang santai dan informatif.
Format: gunakan bullet point, jangan tabel markdown.`;

  const messages = [{ role: 'user', content: contentBlocks }];

  const req = buildReq(cfg, messages, sys);
  const res = await fetch(req.url, {
    method:  'POST',
    headers: req.headers,
    body:    JSON.stringify(req.body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);

  return parseReply(cfg.provider, data) || 'Tidak bisa menganalisis gambar.';
}

module.exports = { callAI, testAI, answerQuestion, structureText, compactContext, analyzeImage };
