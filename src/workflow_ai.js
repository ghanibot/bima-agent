'use strict';

// ── System prompt: teaches AI the full workflow schema ────────
let BUILDER_SYSTEM = `Kamu adalah Bima Workflow Builder — generator workflow JSON otomatis.

Tugasmu: ubah deskripsi pengguna menjadi workflow JSON yang valid dan siap dijalankan.

═══════════════════════════════════════════════
SCHEMA WORKFLOW
═══════════════════════════════════════════════
{
  "id":          string  — huruf kecil, underscore, tanpa spasi (wajib)
  "name":        string  — nama tampilan (wajib)
  "description": string  — penjelasan singkat
  "enabled":     false   — selalu false saat baru dibuat
  "trigger": {
    "type":      "manual" | "wa.message" | "schedule" | "file" | "webhook" | "wa.group_event"
    "match":     string   — keyword/regex (wa.message saja)
    "exclusive": boolean  — true = hentikan AI normal jika trigger cocok (wa.message)
    "onMedia":   "audio"|"image"|"video"|"document"|"any"  — fire only on media of this type (wa.message)
    "mediaOnly": boolean  — true = abaikan pesan teks, fire hanya jika ada media (wa.message)
    "interval":  string   — "30s"|"5m"|"1h"|"6h"|"24h" (schedule)
    "path":      string   — path folder/file (file)
    "events":    array    — ["created","modified"] (file)
    "webhookId": string   — ID unik webhook URL (webhook)
    "secret":    string   — header x-webhook-secret (webhook)
    "jid":       string   — JID grup tertentu, kosong = semua (wa.group_event)
    "actions":   array    — ["add","remove","promote","demote"] (wa.group_event)
  }
  "nodes": [ ...Node ]
  "entry": string  — id node pertama
}

═══════════════════════════════════════════════
NODE TYPES & CONFIG
═══════════════════════════════════════════════

wa.send       — kirim pesan ke chat sumber (dari trigger WA)
  config: { text: string }

wa.send_to    — kirim ke JID tertentu
  config: { jid: string, text: string }

ai.call       — panggil AI dengan prompt, output = balasan AI
  config: { prompt: string, system?: string }

http.request  — HTTP call ke URL eksternal
  config: { url: string, method: "GET"|"POST"|"PUT"|"DELETE",
            body?: string, headers?: {key:val},
            extract?: string }  // dot-path dari response, e.g. "data.price"

shell         — jalankan perintah OS (sandbox harus aktif)
  config: { cmd: string, timeout?: number }

wa.read_group — baca N pesan terakhir dari grup
  config: { jid?: string, limit?: number }

wa.transcribe — voice note → teks (Speech-to-Text)
  config: { source?: "trigger" | <URL> | <path> }
  // "trigger" = pakai audio dari pesan WA yg memicu (default)
  // Cocok dipasangkan dengan trigger wa.message + onMedia: "audio"

wa.vision     — gambar → teks/jawaban via AI vision
  config: { source?: "trigger" | <URL> | <path>,
            question?: string }  // default: "Jelaskan isi gambar ini."

wa.send_media — kirim gambar/audio/video/dokumen
  config: {
    jid?: string,          // default: chat sumber trigger
    type: "image" | "audio" | "video" | "document",
    source: string,        // URL atau path file
    caption?: string,
    ptt?: boolean,         // audio only — true = voice note
    filename?: string,     // document only
    mimetype?: string      // document only, default application/octet-stream
  }

file.create   — BUAT file baru di knowledge base (pdf/docx/xlsx/txt)
  config: {
    name: string,          // contoh: "laporan_harian.pdf" (ekstensi wajib)
    content: string,       // isi (boleh pakai {{lastOutput}}, {{message}}, dll)
    title?: string,        // judul halaman/dokumen
    sheetName?: string,    // xlsx saja
    overwrite?: boolean    // default false — auto-rename kalau nama dipakai
  }

file.edit     — UBAH file existing (auto-backup .bak dgn timestamp)
  config: {
    name: string,          // nama file yang sudah ada
    content: string,       // isi baru (boleh pakai template var)
    title?: string,
    sheetName?: string
  }
  // Output: nama file + nama backup yg dibuat

transform     — transformasi nilai dengan ekspresi JS, input = lastOutput
  config: { expr: string, inputVar?: string }

json.extract  — ambil field dari JSON string
  config: { path: string }  // dot-path, e.g. "items.0.price"

condition     — percabangan true/false
  config: { expr: string }  // ekspresi JS, ctx tersedia
  branches: { "true": nodeId | null, "false": nodeId | null }

delay         — tunggu N detik (max 30)
  config: { seconds: number }

memory.read   — baca riwayat percakapan
  config: { turns?: number }

memory.write  — simpan fakta ke long-term memory
  config: { content: string }

set           — set variabel konteks
  config: { key: string, value: string }

log           — log ke CLI debug
  config: { text: string }

═══════════════════════════════════════════════
NODE FIELDS (semua node)
═══════════════════════════════════════════════
{
  "id":      string   — unik dalam workflow
  "type":    string   — salah satu di atas
  "config":  object   — sesuai tipe
  "next":    string|null  — node selanjutnya (null = selesai)
  "branches": {...}   — hanya untuk condition
  "onError": "stop"|"continue"  — default "stop"
  "label":   string   — deskripsi opsional
  "timeout": number   — opsional, milliseconds (default: 30s http, 90s ai, 60s shell, 60s lainnya)
  "retry": {          — opsional, retry jika node gagal
    "times":   number   — jumlah retry (0–9, default 0)
    "delayMs": number   — jeda awal antar retry (default 1000)
    "backoff": "fixed"|"exponential"  — default "fixed"
  }
}

CATATAN: retry hanya direkomendasikan untuk node yang fragile (http.request, ai.call, shell).
Jangan retry node wa.send (bisa duplikat pesan).

═══════════════════════════════════════════════
TEMPLATE VARIABLES (gunakan {{nama}})
═══════════════════════════════════════════════
{{message}}      — teks pesan WA yang memicu
{{sender_jid}}   — JID pengirim
{{sender_name}}  — nama pengirim
{{lastOutput}}   — output node sebelumnya
{{nodeId_output}} — output node dengan id tertentu, e.g. {{ai1_output}}
{{_jid}}         — JID grup sumber

═══════════════════════════════════════════════
ATURAN
═══════════════════════════════════════════════
1. Balas HANYA dengan JSON valid — tidak ada teks lain, tidak ada markdown fences
2. Semua node harus terhubung ke entry
3. Node terakhir: next = null
4. Condition harus punya branches dengan true dan false
5. id workflow: huruf kecil + underscore, contoh: "harga_cek", "daily_report"
6. Untuk workflow yang fetch data lalu kirim ke WA: pakai http.request → wa.send
7. Untuk workflow terjadwal: trigger type "schedule" + wa.send_to untuk output ke grup

═══════════════════════════════════════════════
CONTOH WORKFLOW
═══════════════════════════════════════════════
// Cek harga BTC setiap jam, kirim ke grup
{
  "id": "btc_price_alert",
  "name": "BTC Price Alert",
  "description": "Cek harga BTC tiap jam, kirim ke grup",
  "enabled": false,
  "trigger": { "type": "schedule", "interval": "1h" },
  "nodes": [
    {
      "id": "fetch", "type": "http.request",
      "config": { "url": "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", "method": "GET", "extract": "bitcoin.usd" },
      "next": "send"
    },
    {
      "id": "send", "type": "wa.send",
      "config": { "text": "Harga BTC sekarang: USD {{lastOutput}}" },
      "next": null
    }
  ],
  "entry": "fetch"
}`;

// Phase 5 node docs appended to BUILDER_SYSTEM at module load
const PHASE5_DOCS = `
loop          — iterasi array, jalankan body chain per item
  config: { items: string (JSON array atau {{var}}),
            itemVar: string (nama var item, default "item"),
            body: nodeId (entry node body chain),
            maxIterations?: number (max 100) }
  next: nodeId setelah loop selesai
  context: {{item}}, {{loop_index}}, {{loop_total}}

repeat        — jalankan body chain N kali
  config: { times: number, body: nodeId }
  context: {{repeat_index}}, {{repeat_total}}

parallel      — jalankan beberapa branch bersamaan, tunggu semua
  config: { branches: [nodeId, nodeId, ...] }
  output: JSON object { branchId: output }

workflow.run  — panggil workflow lain berdasarkan ID
  config: { workflowId: string, input?: string }
  output: output terakhir dari sub-workflow

ATURAN LOOP/PARALLEL:
- Node body chain HARUS ada di array nodes yang sama
- Body chain berakhir saat next = null atau tidak ada
- Body chain TIDAK boleh kembali ke loop node (akan create cycle)
- Untuk loop: lastOutput setelah loop = JSON array semua output body
- Untuk parallel: lastOutput = JSON object {branchId: output}
`;

BUILDER_SYSTEM += `\n═══════════════════════════════════════════════\nNODE TYPES LANJUTAN (Phase 5)\n═══════════════════════════════════════════════\n${PHASE5_DOCS}`;

// ── Extract JSON from AI reply ────────────────────────────────
function extractJSON(text) {
  // Strip markdown fences if AI disobeys
  let clean = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Find first { to last } in case of extra prose
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    clean = clean.slice(start, end + 1);
  }

  return JSON.parse(clean);
}

// ── Validate generated workflow ───────────────────────────────
function validateWorkflow(wf) {
  if (!wf || typeof wf !== 'object') throw new Error('Bukan object');
  if (!wf.id)    throw new Error('field "id" kosong');
  if (!wf.name)  throw new Error('field "name" kosong');
  if (!wf.entry) throw new Error('field "entry" kosong');
  if (!Array.isArray(wf.nodes) || !wf.nodes.length) throw new Error('nodes kosong');

  const nodeIds = new Set(wf.nodes.map(n => n.id));
  if (!nodeIds.has(wf.entry)) throw new Error(`entry "${wf.entry}" tidak ada di nodes`);

  const VALID_TYPES = new Set([
    'wa.send', 'wa.send_to', 'ai.call', 'http.request', 'shell',
    'wa.read_group', 'transform', 'json.extract', 'condition',
    'delay', 'memory.read', 'memory.write', 'set', 'log',
    'loop', 'repeat', 'parallel', 'workflow.run',
    'wa.transcribe', 'wa.vision', 'wa.send_media',
    'file.create', 'file.edit',
  ]);

  for (const node of wf.nodes) {
    if (!node.id)   throw new Error(`Node tanpa id: ${JSON.stringify(node).slice(0, 60)}`);
    if (!node.type) throw new Error(`Node "${node.id}" tidak punya type`);
    if (!VALID_TYPES.has(node.type)) throw new Error(`Node type tidak dikenal: "${node.type}"`);
    if (node.next && !nodeIds.has(node.next)) throw new Error(`Node "${node.id}" next "${node.next}" tidak ditemukan`);
    if (node.branches) {
      for (const [, targetId] of Object.entries(node.branches)) {
        if (targetId && !nodeIds.has(targetId)) {
          throw new Error(`Branch dari "${node.id}" ke "${targetId}" tidak ditemukan`);
        }
      }
    }
    if (node.timeout !== undefined) {
      if (typeof node.timeout !== 'number' || node.timeout <= 0) {
        throw new Error(`Node "${node.id}" timeout harus number > 0 (milliseconds)`);
      }
    }
    if (node.retry !== undefined) {
      if (typeof node.retry !== 'object') throw new Error(`Node "${node.id}" retry harus object`);
      if (node.retry.times !== undefined && (typeof node.retry.times !== 'number' || node.retry.times < 0 || node.retry.times > 9)) {
        throw new Error(`Node "${node.id}" retry.times harus 0–9`);
      }
      if (node.retry.backoff && !['fixed', 'exponential'].includes(node.retry.backoff)) {
        throw new Error(`Node "${node.id}" retry.backoff harus "fixed" atau "exponential"`);
      }
    }
  }
}

// ── Build workflow from NL description ───────────────────────
async function buildWorkflowFromDescription(description, tenantId) {
  const { callAI } = require('./ai');
  const { getConfig } = require('./config');
  const cfg = getConfig(tenantId);

  if (!cfg.provider) throw new Error('AI belum dikonfigurasi. Ketik /model');

  const reply = await callAI(
    [{ role: 'user', content: description }],
    BUILDER_SYSTEM,
    cfg
  );

  let wf;
  try {
    wf = extractJSON(reply);
  } catch (e) {
    throw new Error(`AI tidak menghasilkan JSON valid: ${e.message}\n\nRaw reply:\n${reply.slice(0, 400)}`);
  }

  // Force safety defaults
  wf.enabled   = false;
  wf.createdAt = Date.now();
  wf.updatedAt = Date.now();
  if (!wf.trigger) wf.trigger = { type: 'manual' };

  validateWorkflow(wf);
  return { wf, raw: reply };
}

// ── Refine existing workflow with AI ─────────────────────────
async function refineWorkflow(wf, instruction, tenantId) {
  const { callAI } = require('./ai');
  const { getConfig } = require('./config');
  const cfg = getConfig(tenantId);

  if (!cfg.provider) throw new Error('AI belum dikonfigurasi. Ketik /model');

  const prompt = `Workflow yang sudah ada (JSON):\n${JSON.stringify(wf, null, 2)}\n\nInstruksi perubahan:\n${instruction}\n\nHasilkan workflow JSON yang sudah dimodifikasi sesuai instruksi. Pertahankan id yang sama.`;

  const reply = await callAI(
    [{ role: 'user', content: prompt }],
    BUILDER_SYSTEM,
    cfg
  );

  let refined;
  try {
    refined = extractJSON(reply);
  } catch (e) {
    throw new Error(`AI tidak menghasilkan JSON valid: ${e.message}`);
  }

  // Keep original id and tenant
  refined.id        = wf.id;
  refined.enabled   = wf.enabled;
  refined.createdAt = wf.createdAt;
  refined.updatedAt = Date.now();
  if (!refined.trigger) refined.trigger = wf.trigger;

  validateWorkflow(refined);
  return { wf: refined, raw: reply };
}

// ── Format workflow for display ───────────────────────────────
function formatWorkflowSummary(wf) {
  const trigMap = {
    schedule:        `⏱ setiap ${wf.trigger?.interval}`,
    'wa.message':    `💬 keyword: "${wf.trigger?.match || '*'}"`,
    file:            `📁 pantau: ${wf.trigger?.path || '?'}`,
    webhook:         `🔗 /webhook/${wf.trigger?.webhookId || wf.id}`,
    'wa.group_event': `👥 event: ${(wf.trigger?.actions || ['add','remove']).join('/')}`,
  };
  const trg = trigMap[wf.trigger?.type] || '⚡ manual';

  let out = `\nWorkflow: *${wf.name}*\n`;
  out += `ID       : ${wf.id}\n`;
  out += `Trigger  : ${trg}\n`;
  out += `Nodes    :\n`;
  for (const node of wf.nodes) {
    out += `  ${node.id} [${node.type}]`;
    if (node.config?.text)   out += ` — "${String(node.config.text).slice(0, 40)}"`;
    if (node.config?.url)    out += ` — ${String(node.config.url).slice(0, 50)}`;
    if (node.config?.prompt) out += ` — "${String(node.config.prompt).slice(0, 40)}"`;
    if (node.config?.cmd)    out += ` — ${String(node.config.cmd).slice(0, 40)}`;
    if (node.next) out += ` → ${node.next}`;
    if (node.branches) out += ` → T:${node.branches.true||'stop'} F:${node.branches.false||'stop'}`;
    out += '\n';
  }
  return out;
}

module.exports = {
  buildWorkflowFromDescription,
  refineWorkflow,
  formatWorkflowSummary,
  validateWorkflow,
};
