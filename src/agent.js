'use strict';

const MAX_STEPS          = 12;  // cukup untuk riset mendalam
const MAX_STEPS_SIMPLE   = 4;   // pertanyaan singkat

// ── System prompt ─────────────────────────────────────────────
// Built dynamically so current date is always fresh
function buildSystemPrompt(cfg) {
  const now = new Date().toLocaleString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta',
  });

  // Language instruction
  const { langInstruction } = require('./languages');
  const langSuffix = cfg?.language ? langInstruction(cfg.language) : '';

  return `Kamu adalah *Bima Agent*, asisten AI WhatsApp dari Indonesia yang cerdas, profesional, dan selalu siap membantu.${langSuffix}

Gaya bicara: sopan, formal namun tetap natural dan bersahabat. Gunakan bahasa Indonesia yang baik dan benar. Hindari bahasa gaul berlebihan. Boleh sesekali santai, tetapi tetap terkesan profesional.

⚠️ KONTEKS WAKTU: Sekarang ${now} WIB.
⚠️ KNOWLEDGE CUTOFF: Training berakhir awal 2024 — data setelah itu tidak tersedia tanpa pencarian web.

TOOLS TERSEDIA:
1.  search_kb(query)              - Cari di knowledge base internal (dokumen, harga, data bisnis)
2.  get_file(filename)            - Ambil isi lengkap file tertentu dari KB
3.  compare_files(query)          - Bandingkan data dari beberapa file sekaligus
4.  get_price(asset)              - Harga realtime crypto/saham via API
5.  web_search(query)             - Cari info terkini di internet
6.  browse_url(url)               - Buka & baca konten halaman web
7.  deep_research(topic)          - Riset mendalam multi-sumber
8.  list_files()                  - Daftar semua file di knowledge base
9.  recall_memory(query)          - Cari fakta dari memori jangka panjang
10. remember(content)             - Simpan fakta penting ke memori jangka panjang
11. update_kb(hash,field,val)     - Update field di dokumen KB
12. get_group_log(hours)          - Ambil log percakapan grup N jam terakhir
13. get_person_location(name)     - Cari lokasi terakhir seseorang dari log grup
14. get_polymarket(query)         - Cari pasar prediksi di Polymarket
15. get_my_mentions(hours)        - Siapa yang men-tag/mention user ini di semua grup
16. get_conversation_patterns(hours) - Pola percakapan: siapa ngobrol dengan siapa
17. lookup_contact(name)          - Cari nomor telepon kontak berdasarkan nama
18. save_contact(name,phone)      - Simpan nomor telepon kontak baru
19. list_contacts()               - Tampilkan semua kontak yang tersimpan
20. delete_contact(name)          - Hapus kontak dari buku kontak
21. edit_office(command)          - Manipulasi file Excel/Word/PowerPoint (buat, edit, baca)
22. final_answer(text)            - Kirim jawaban akhir ke pengguna

FORMAT RESPONS - balas HANYA JSON valid, tidak ada teks lain:
{"thought":"pikirku singkat","action":"nama_tool","input":"parameter"}

Jawaban final:
{"thought":"sudah cukup info","action":"final_answer","input":"teks jawaban"}

FORMAT DATA (WhatsApp — bukan web):
- DILARANG tabel markdown
- Gunakan list bernomor atau bullet
- Label penting pakai *bold*
- Nomor telepon tampilkan dengan format: +62xxxxxxxxxx

ATURAN TOOL — PRIORITAS WAJIB:
1. Data operasional/bisnis/internal → search_kb DULU. JANGAN web_search untuk data internal.
   - Jika tidak ada → beritahu: "Data [X] belum tersedia di knowledge base."
2. Pertanyaan nomor/kontak seseorang → lookup_contact DULU sebelum hal lain
3. Harga crypto/saham → get_price
4. Fakta dunia terkini → web_search
5. Topik kompleks/analitis → deep_research
6. User kirim link → browse_url
7. Prediksi pasar → get_polymarket
8. "Siapa yang tag/mention saya?" → get_my_mentions
9. "Siapa ngobrol dengan siapa?" → get_conversation_patterns
10. Percakapan biasa/math → langsung final_answer

ATURAN JAWABAN:
- Setiap jawaban HARUS diakhiri dengan 1-2 saran atau langkah lanjutan yang relevan.
- Format saran: "💡 *Saran:* ..." atau "📌 *Info tambahan:* ..."
- Jika informasi tidak ada di KB → sarankan data yang perlu diunggah.
- Pengecualian: pertanyaan sapaan atau terima kasih tidak perlu saran tambahan.
`;
}

// Search-type tools — trigger "sedang mencari" indicator
const SEARCH_TOOLS = new Set(['search_kb', 'web_search', 'browse_url', 'deep_research', 'get_price', 'compare_files', 'get_file', 'list_files', 'recall_memory', 'get_group_log', 'get_person_location', 'get_polymarket', 'get_my_mentions', 'get_conversation_patterns', 'lookup_contact', 'list_contacts', 'edit_office']);

// ── Main agent loop ───────────────────────────────────────────
// onToolCall(action, input) — optional async callback before each tool executes
async function runAgent(question, history, cfg, ltmContext, onToolCall, tenantId, groupJid, senderJid) {
  const { callAI }    = require('./ai');
  const { searchKnowledge, getKnowledge, updateDocument, getDocument, searchAllFiles } = require('./db');
  const { webSearch, browseUrl, deepResearch, getPrice } = require('./search');
  const { remember, recall } = require('./ltm');

  const tid = tenantId || 'default';

  // Inject LTM context into the first user message if available
  let enrichedQuestion = question;
  if (ltmContext?.length) {
    const ltmStr = ltmContext.map(m => `- ${m.content}`).join('\n');
    enrichedQuestion = `[Memori relevan]\n${ltmStr}\n\n${question}`;
  }

  const messages = [
    ...history,
    { role: 'user', content: enrichedQuestion },
  ];

  // Adaptive step limit
  const RESEARCH_RE = /\b(analisa|analisis|jelaskan|ceritakan|mendalam|riset|investigasi|dampak|konflik|geopolitik|bagaimana jika|apa yang terjadi|kenapa|mengapa|sejarah|latar belakang|komprehensif|lengkap)\b/i;
  const maxSteps = RESEARCH_RE.test(question) ? MAX_STEPS : MAX_STEPS_SIMPLE;

  // ── Forced pre-search for current-fact questions ──────────────
  // Only trigger for clear world-fact questions, NOT internal/operational data.
  // Operational keywords that must NOT trigger web pre-search:
  const INTERNAL_RE = /\b(ongkos|tarif|harga\s*(jasa|kirim|angkut|sewa|kapal|cargo|kontainer)|biaya\s*(operasional|kirim|angkut)|jadwal\s*(kapal|armada|pengiriman)|rute\s*(kapal|pelabuhan)|manifest|muatan|tonase|sop|prosedur|stok|inventory|karyawan|gaji|laporan|omzet|penjualan|order|invoice|klien|pelanggan)\b/i;

  const CURRENT_FACT_RE = /\b(siapa (presiden|pm|perdana menteri|menteri|gubernur|walikota|ceo|direktur\s*utama) (indonesia|amerika|rusia|china|prancis|\w+)|presiden (indonesia|amerika|rusia|china|prancis)|harga (btc|eth|bitcoin|emas|dolar|minyak\s*dunia)|berapa (kurs|nilai) (dolar|euro|yen|usd)|hasil (pemilu|pilpres|pilkada)|yang terpilih|yang menang (pilpres|pilkada|pemilu))\b/i;

  const steps = [];
  let finalAnswer = null;

  // Pre-search: inject result as first observation so AI is grounded
  // Skip if question is about internal/operational data (should use KB instead)
  if (CURRENT_FACT_RE.test(question) && !INTERNAL_RE.test(question) && steps.length === 0) {
    try {
      if (onToolCall) await onToolCall('web_search', question).catch(() => {});
      const preResult = await webSearch(question);
      if (preResult) {
        steps.push({
          thought:     'Cek info terkini sebelum menjawab',
          action:      'web_search',
          input:       question,
          observation: preResult,
        });
      }
    } catch {}
  }

  for (let i = 0; i < maxSteps; i++) {
    const agentMessages = [
      ...messages,
      ...steps.map(s => [
        { role: 'assistant', content: JSON.stringify({ thought: s.thought, action: s.action, input: s.input }) },
        { role: 'user',      content: `Observation: ${s.observation}` },
      ]).flat(),
    ];

    let raw;
    try {
      raw = await callAI(agentMessages, buildSystemPrompt(cfg), cfg);
    } catch (e) {
      if (steps.length === 0) {
        try {
          const { answerQuestion } = require('./ai');
          const ctx = searchKnowledge(question, tid);
          finalAnswer = await answerQuestion(question, ctx || '', cfg);
        } catch (e2) {
          finalAnswer = `Maaf, ada error: ${e2.message}`;
        }
      } else {
        finalAnswer = `Maaf, ada error: ${e.message}`;
      }
      break;
    }

    let step;
    try {
      const cleaned   = raw.replace(/```json|```/gi, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      step = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    } catch {
      // JSON parse failed — raw is plain text answer, sanitize and use it
      finalAnswer = sanitizeAnswer(raw);
      break;
    }

    if (!step.action || step.action === 'final_answer') {
      finalAnswer = sanitizeAnswer(step.input || step.thought || raw);
      break;
    }

    if (onToolCall && SEARCH_TOOLS.has(step.action) && steps.length === 0) {
      try { await onToolCall(step.action, step.input); } catch {}
    }

    let observation = '';
    try {
      // Check plugin tools first
      let handledByPlugin = false;
      try {
        const { getPluginTools } = require('./plugins');
        const pluginTools = getPluginTools();
        const pluginTool  = pluginTools.find(t => t.name === step.action);
        if (pluginTool) {
          observation     = await pluginTool.execute(step.input, tid);
          handledByPlugin = true;
        }
      } catch {}

      if (!handledByPlugin) {
        observation = await executeTool(step.action, step.input, {
          searchKnowledge, getKnowledge, webSearch, browseUrl, deepResearch, getPrice,
          updateDocument, getDocument, searchAllFiles, remember, recall,
          cfg, groupJid, senderJid,
        }, tid);
      }
    } catch (e) {
      observation = `Error: ${e.message}`;
    }

    steps.push({ ...step, observation });
  }

  if (!finalAnswer) finalAnswer = 'Maaf, aku tidak bisa menyelesaikan permintaan ini.';

  return { answer: sanitizeAnswer(finalAnswer), steps };
}

// ── sanitizeAnswer ─────────────────────────────────────────────
function sanitizeAnswer(text) {
  if (!text || typeof text !== 'string') return String(text || '');

  let out = text;

  // Pass 1: Remove code fences
  out = out.replace(/```[\w]*\n?/g, '').replace(/```/g, '');

  // Pass 2: Remove agent JSON blocks using brace-matching (robust vs regex)
  out = _removeAgentJsonBlocks(out);

  // Pass 3: Remove leaked prefixes
  out = out.replace(/^(Observation|Thought|Action|Input)\s*:\s*/gim, '');

  // Pass 4: Line filter — drop any line that starts with { and has agent keys
  const AGENT_KEY_RE = /"(thought|action|input|observation)"\s*:/;
  out = out.split('\n').filter(line => {
    const t = line.trim();
    if (!t) return true;
    if (/^[{[]/.test(t) && AGENT_KEY_RE.test(t)) return false;
    return true;
  }).join('\n');

  // Pass 5: Collapse blank lines
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out || text.trim();
}

// Brace-matching remover for agent JSON blocks
function _removeAgentJsonBlocks(text) {
  const AGENT_KEY_RE = /"(thought|action|input|observation)"\s*:/;
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      // Find matching closing brace
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const block = text.slice(i, j);
      if (AGENT_KEY_RE.test(block)) {
        // Skip this block — it's an agent artifact
        i = j;
        continue;
      }
    }
    result += text[i];
    i++;
  }
  return result;
}

// ── Tool executor ─────────────────────────────────────────────
async function executeTool(action, input, tools, tenantId) {
  const tid = tenantId || 'default';

  switch (action) {

    case 'search_kb': {
      const result = tools.searchKnowledge(String(input), tid);
      return result || 'Tidak ada hasil relevan di knowledge base.';
    }

    case 'get_file': {
      const doc = tools.getDocument(String(input), tid);
      if (!doc) return `File "${input}" tidak ditemukan di KB.`;
      return `[File: ${doc.file}]\n${doc.text.slice(0, 3000)}`;
    }

    case 'compare_files': {
      const results = tools.searchAllFiles(String(input), tid);
      if (!results.length) return 'Tidak ada file relevan ditemukan untuk perbandingan.';
      return results
        .map(r => `[File: ${r.file}]\n${r.text}`)
        .join('\n\n----------\n\n');
    }

    case 'web_search': {
      const result = await tools.webSearch(String(input));
      return result || 'Tidak ada hasil dari pencarian web.';
    }

    case 'get_price': {
      const result = await tools.getPrice(String(input));
      return result || 'Data harga tidak ditemukan.';
    }

    case 'browse_url': {
      const result = await tools.browseUrl(String(input));
      return result || 'Tidak ada konten yang bisa dibaca dari URL tersebut.';
    }

    case 'deep_research': {
      const result = await tools.deepResearch(String(input), tools.cfg);
      return result || 'Tidak ada hasil riset ditemukan.';
    }

    case 'list_files': {
      const docs = tools.getKnowledge(tid);
      if (!docs.length) return 'Belum ada file di knowledge base.';
      return docs.map((d, i) =>
        `${i + 1}. ${d.file} (${d.timestamp?.slice(0, 10) || '-'}) hash=${d.hash.slice(0, 8)}`
      ).join('\n');
    }

    case 'recall_memory': {
      const memories = tools.recall(String(input), 5, tid);
      if (!memories.length) return 'Tidak ada memori relevan ditemukan.';
      return memories.map(m => `- ${m.content}`).join('\n');
    }

    case 'remember': {
      const id = tools.remember(String(input), '', tid);
      return id ? `Fakta disimpan ke memori jangka panjang (id: ${id}).` : 'Fakta sudah ada di memori, dilewati.';
    }

    case 'update_kb': {
      let params = input;
      if (typeof input === 'string') {
        try { params = JSON.parse(input); } catch { return 'Input tidak valid (butuh JSON).'; }
      }
      const { hash, field, value } = params;
      if (!hash || !field) return 'Butuh hash dan field.';
      const ok = tools.updateDocument(hash, { [field]: value }, tid);
      return ok ? `Update berhasil: field "${field}" pada ${hash.slice(0, 8)}...` : 'Dokumen tidak ditemukan.';
    }

    case 'get_group_log': {
      if (!tools.groupJid) return 'Tidak dalam konteks grup.';
      const { getLog, formatLog } = require('./grouplog');
      const hours   = parseInt(input) || 24;
      const entries = getLog(tid, tools.groupJid, hours);
      if (!entries.length) return `Tidak ada percakapan dalam ${hours} jam terakhir.`;
      return formatLog(entries).slice(0, 3000);
    }

    case 'get_person_location': {
      if (!tools.groupJid) return 'Tidak dalam konteks grup.';
      const { getPersonLocation } = require('./grouplog');
      const loc = getPersonLocation(tid, tools.groupJid, String(input));
      if (!loc) return `Tidak ada data lokasi untuk "${input}" dalam 24 jam terakhir.`;
      const t   = new Date(loc.ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      const maps = `https://maps.google.com/?q=${loc.lat},${loc.lng}`;
      return `Lokasi terakhir ${loc.senderName} (${t}):\nKoordinat: ${loc.lat}, ${loc.lng}\nMaps: ${maps}${loc.locationName ? '\nNama lokasi: ' + loc.locationName : ''}`;
    }

    case 'get_polymarket': {
      const { searchMarkets, getTrendingMarkets } = require('./polymarket');
      const q = String(input || '').trim();
      return q ? await searchMarkets(q) : await getTrendingMarkets();
    }

    case 'get_my_mentions': {
      const { getMentions, formatMentions } = require('./grouplog');
      const targetJid = tools.senderJid;
      if (!targetJid) return 'Tidak bisa mendeteksi JID pengirim untuk mencari mention.';
      const hours    = parseInt(input) || 24;
      const mentions = getMentions(tid, targetJid, hours);
      if (!mentions.length) return `Tidak ada yang men-tag kamu dalam ${hours} jam terakhir.`;
      const phone    = targetJid.split('@')[0].split(':')[0];
      const formatted = formatMentions(mentions, phone);
      return formatted || 'Tidak ada mention ditemukan.';
    }

    case 'get_conversation_patterns': {
      const { getConversationPatterns } = require('./grouplog');
      if (!tools.groupJid) return 'Tool ini membutuhkan konteks grup.';
      const hours    = parseInt(input) || 24;
      const patterns = getConversationPatterns(tid, tools.groupJid, hours);
      if (!patterns) return `Tidak ada percakapan dalam ${hours} jam terakhir.`;

      let out = `*Pola percakapan ${hours}j terakhir (${patterns.totalMessages} pesan):*\n\n`;
      if (patterns.topActive.length) {
        out += `*Paling aktif:*\n${patterns.topActive.map(x => `• ${x}`).join('\n')}\n\n`;
      }
      if (patterns.topPairs.length) {
        out += `*Sering berinteraksi:*\n${patterns.topPairs.map(x => `• ${x}`).join('\n')}`;
      }
      return out;
    }

    case 'lookup_contact': {
      const { lookupContact } = require('./contacts');
      const results = lookupContact(String(input), tid);
      if (!results.length) return `Kontak dengan nama "${input}" tidak ditemukan dalam buku kontak.`;
      return results.map(c => `• *${c.name}*: ${c.phone}`).join('\n');
    }

    case 'save_contact': {
      const { saveContact } = require('./contacts');
      let name, phone;
      if (typeof input === 'object') {
        name  = input.name;
        phone = input.phone;
      } else {
        const str = String(input);
        // Try JSON first
        try {
          const parsed = JSON.parse(str);
          name  = parsed.name;
          phone = parsed.phone;
        } catch {
          // Format: "nama, nomor" or "nama: nomor"
          const parts = str.split(/[,:]/).map(s => s.trim());
          name  = parts[0];
          phone = parts[1];
        }
      }
      if (!name || !phone) return 'Format tidak valid. Gunakan: {"name":"Pak Ramli","phone":"+6282171827205"}';
      const saved = saveContact(name, phone, tid);
      return `Kontak *${name}* berhasil disimpan dengan nomor ${saved}.`;
    }

    case 'list_contacts': {
      const { listContacts } = require('./contacts');
      const contacts = listContacts(tid);
      if (!contacts.length) return 'Belum ada kontak yang tersimpan.';
      return `*Buku Kontak (${contacts.length}):*\n\n` +
        contacts.map((c, i) => `${i + 1}. *${c.name}*: ${c.phone}`).join('\n');
    }

    case 'delete_contact': {
      const { deleteContact } = require('./contacts');
      const ok = deleteContact(String(input), tid);
      return ok ? `Kontak "${input}" berhasil dihapus.` : `Kontak "${input}" tidak ditemukan.`;
    }

    case 'edit_office': {
      const { officeCommand } = require('./officecli');
      const { tenantPaths }   = require('./tenant');
      const filesDir = tenantPaths(tid).files;
      const result   = await officeCommand(String(input), filesDir);
      return result;
    }

    default:
      return `Tool "${action}" tidak dikenal.`;
  }
}

module.exports = { runAgent };
