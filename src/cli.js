#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { getConfig, saveConfig, maskKey } = require('./config');
const { startWA, getWAStatus, logoutWA } = require('./whatsapp');
const { getKnowledge, searchKnowledge, searchKnowledgeSemantic, compactKnowledge } = require('./db');
const { testAI, answerQuestion } = require('./ai');
const { listTenants, addTenant, updateTenant, deleteTenant, getTenant, tenantPaths } = require('./tenant');
const { isSetupDone, runWizard } = require('./init');
const ui      = require('./ui');
const plugins = require('./plugins');

// Active tenant for CLI operations
let _currentTenant = 'default';

// ══════════════════════════════════════════════════════════════
//  Colors (used for non-TUI fallback text and plain formatting)
// ══════════════════════════════════════════════════════════════
const C = {
  green:   s => `\x1b[38;5;46m${s}\x1b[0m`,
  blue:    s => `\x1b[38;5;39m${s}\x1b[0m`,
  dim:     s => `\x1b[38;5;245m${s}\x1b[0m`,
  bold:    s => `\x1b[1m${s}\x1b[0m`,
  red:     s => `\x1b[38;5;196m${s}\x1b[0m`,
  yellow:  s => `\x1b[38;5;220m${s}\x1b[0m`,
  reset:   '\x1b[0m',
};

// ── Output helpers (write to chat panel) ─────────────────────
function println(msg = '') {
  ui.appendChat('system', msg);
}

function printDivider() {
  ui.appendChat('system', '─'.repeat(54));
}

// ── Logging (right panel; also exported for whatsapp.js) ──────
function log(type, msg) {
  ui.log(type, msg);
}

// ── ask() — interactive dialog, pauses blessed ────────────────
function ask(q) {
  return ui.ask(q);
}

// ══════════════════════════════════════════════════════════════
//  Extract @file references from input, read contents
// ══════════════════════════════════════════════════════════════
function resolveAtFiles(input) {
  const attachments = [];
  const clean = input.replace(/@([^\s]+)/g, (match, filePath) => {
    try {
      const resolved = path.resolve(filePath);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        const content = fs.readFileSync(resolved, 'utf8');
        attachments.push({ path: filePath, content });
        return `[file: ${path.basename(filePath)}]`;
      }
    } catch {}
    return match;
  });
  return { clean: clean.trim(), attachments };
}

// ══════════════════════════════════════════════════════════════
//  /help
// ══════════════════════════════════════════════════════════════
function cmdHelp() {
  const cmds = [
    ['/help',      'Tampilkan daftar perintah ini'],
    ['/wa',        'Hubungkan WhatsApp (scan QR)'],
    ['/status',    'Status koneksi & konfigurasi'],
    ['/model',     'Set AI provider & API key'],
    ['/input',     'Pilih grup WhatsApp sebagai input'],
    ['/output',    'Pilih grup WhatsApp sebagai output'],
    ['/knowledge', 'Lihat dokumen tersimpan'],
    ['/compact',   'Kompres konteks dokumen (hemat token)'],
    ['/stt',       'Konfigurasi Speech-to-Text (voice note)'],
    ['/tts',       'Konfigurasi Text-to-Speech (suara Bima)'],
    ['/reminder',  'Lihat daftar pengingat aktif'],
    ['/memory',    'Reset memori percakapan semua user'],
    ['/ltm',       'Lihat / hapus memori jangka panjang'],
    ['/search',    'Cari di web langsung dari terminal'],
    ['/tenant',    'Kelola tenant (list/add/switch/del/groups)'],
    ['/skill',     'Kelola plugin/skill (list/add/remove/info)'],
    ['/logout',    'Logout WhatsApp & hapus session'],
    ['/clear',     'Bersihkan layar'],
    ['/exit',      'Keluar dari Bima'],
  ];

  let out = 'BIMA — Daftar Perintah\n' + '─'.repeat(40) + '\n';
  cmds.forEach(([cmd, desc]) => {
    out += `  ${cmd.padEnd(12)} ${desc}\n`;
  });
  out += '─'.repeat(40) + '\nAtau langsung ketik pertanyaan — Bima akan jawab!';
  println(out);
}

// ══════════════════════════════════════════════════════════════
//  /status
// ══════════════════════════════════════════════════════════════
function cmdStatus() {
  const cfg  = getConfig(_currentTenant);
  const wa   = getWAStatus();
  const docs = getKnowledge(_currentTenant);

  const row = (label, val) => `  ${label.padEnd(14)} ${val}`;
  const waStr = wa.connected ? '● Terhubung' : '● Terputus';
  const inputList = Array.isArray(cfg.inputGroups) && cfg.inputGroups.length
    ? `${cfg.inputGroups.length} grup`
    : (cfg.inputGroupName || '(belum diset)');

  let out = `STATUS — Bima Agent\n${'─'.repeat(40)}\n`;
  out += row('Tenant',      _currentTenant) + '\n';
  out += row('WhatsApp',    waStr) + '\n';
  out += row('Provider',    cfg.provider   || '(belum diset)') + '\n';
  out += row('Model',       cfg.model      || '(belum diset)') + '\n';
  out += row('API Key',     cfg.apiKey     ? maskKey(cfg.apiKey) : '(belum diset)') + '\n';
  out += row('Grup Input',  inputList) + '\n';
  out += row('Grup Output', cfg.outputGroupName || '(belum diset)') + '\n';
  out += row('Knowledge',   `${docs.length} dokumen`) + '\n';
  out += '─'.repeat(40);
  println(out);

  // Also update right panel status bar
  ui.updateStatus({
    provider:    cfg.provider,
    model:       cfg.model,
    waConnected: wa.connected,
    tenant:      _currentTenant,
  });
}

// ══════════════════════════════════════════════════════════════
//  /wa
// ══════════════════════════════════════════════════════════════
async function cmdWA() {
  const wa = getWAStatus();
  if (wa.connected) {
    println('WhatsApp sudah terhubung!');
    return;
  }
  println('[WA] Memulai koneksi WhatsApp...\nQR code akan muncul — scan dengan WhatsApp kamu.');
  startWA(log);
}

// ══════════════════════════════════════════════════════════════
//  /model
// ══════════════════════════════════════════════════════════════
async function cmdModel() {
  println('MODEL — Konfigurasi AI\n─'.repeat(1) + '\n1. OpenAI (gpt-4o-mini, gpt-4o)\n2. Anthropic (claude-3-haiku, claude-3-5-sonnet)\n3. OpenRouter (akses 100+ model)');

  const providers = { '1': 'openai', '2': 'anthropic', '3': 'openrouter' };
  const examples  = {
    openai:     'gpt-4o-mini',
    anthropic:  'claude-3-haiku-20240307',
    openrouter: 'meta-llama/llama-3-8b-instruct',
  };

  const choice = (await ask(' Pilih provider (1/2/3): ')).trim();
  const provider = providers[choice];
  if (!provider) { println('✗ Pilihan tidak valid.'); return; }

  println(`✓ Provider: ${provider}`);

  const ex = examples[provider];
  const model = (await ask(` Nama model (contoh: ${ex}): `)).trim();
  if (!model) { println('✗ Model tidak boleh kosong.'); return; }

  const apiKey = (await ask(' API Key: ')).trim();
  if (!apiKey) { println('✗ API Key tidak boleh kosong.'); return; }

  println('⏳ Menguji API...');
  const ok = await testAI({ provider, model, apiKey });

  if (!ok) {
    println('✗ API Key atau model tidak valid. Konfigurasi tidak disimpan.');
    return;
  }

  saveConfig({ provider, model, apiKey }, _currentTenant);
  println(`✓ Konfigurasi berhasil disimpan!\n  Provider : ${provider}\n  Model    : ${model}\n  API Key  : ${maskKey(apiKey)}`);

  ui.updateStatus({ provider, model, waConnected: getWAStatus().connected, tenant: _currentTenant });
}

// ══════════════════════════════════════════════════════════════
//  /input & /output
// ══════════════════════════════════════════════════════════════
async function cmdSetGroup(type) {
  const wa = getWAStatus();

  if (!wa.connected) {
    println('! WhatsApp belum terhubung. Jalankan /wa dulu.');
    return;
  }

  const groups = wa.groups || [];
  if (!groups.length) {
    println('! Belum ada grup ditemukan. Tunggu beberapa detik setelah connect.');
    return;
  }

  if (type === 'output') {
    let out = 'OUTPUT — Pilih Grup WhatsApp\n' + '─'.repeat(40) + '\n';
    groups.forEach((g, i) => { out += `  ${String(i + 1).padStart(2)}. ${g.name}\n`; });
    println(out);

    const answer = (await ask(' Masukkan nomor grup: ')).trim();
    const idx = parseInt(answer) - 1;
    if (isNaN(idx) || !groups[idx]) { println('✗ Nomor tidak valid.'); return; }
    saveConfig({ outputGroup: groups[idx].id, outputGroupName: groups[idx].name }, _currentTenant);
    println(`✓ Grup output diset ke: ${groups[idx].name}`);
    return;
  }

  // INPUT: multi-group
  const cfg     = getConfig(_currentTenant);
  const current = Array.isArray(cfg.inputGroups) ? cfg.inputGroups
                : (cfg.inputGroup ? [cfg.inputGroup] : []);

  let out = `INPUT — Grup Input WhatsApp (${_currentTenant})\n` + '─'.repeat(40) + '\n';

  if (current.length) {
    out += 'Grup input aktif:\n';
    current.forEach((jid, i) => {
      const grp = groups.find(g => g.id === jid);
      out += `  ${i + 1}. ${grp ? grp.name : jid}\n`;
    });
  } else {
    out += 'Belum ada grup input.\n';
  }
  out += '\n  a. Tambah grup input baru\n';
  if (current.length) out += '  r. Hapus grup dari list\n';
  println(out);

  const action = (await ask(' Pilih aksi (a/r): ')).trim().toLowerCase();

  if (action === 'a') {
    let grpOut = '';
    groups.forEach((g, i) => {
      const mark = current.includes(g.id) ? ' ✓' : '';
      grpOut += `  ${String(i + 1).padStart(2)}. ${g.name}${mark}\n`;
    });
    println(grpOut);

    const answer = (await ask(' Masukkan nomor grup: ')).trim();
    const idx = parseInt(answer) - 1;
    if (isNaN(idx) || !groups[idx]) { println('✗ Nomor tidak valid.'); return; }
    const picked = groups[idx];
    if (current.includes(picked.id)) { println(`! Grup "${picked.name}" sudah ada di list.`); return; }
    const updated = [...current, picked.id];
    saveConfig({ inputGroups: updated, inputGroup: updated[0], inputGroupName: groups.find(g => g.id === updated[0])?.name || '' }, _currentTenant);
    const tenant = getTenant(_currentTenant);
    if (tenant) {
      const jids = new Set([...(tenant.groupJids || []), picked.id]);
      updateTenant(_currentTenant, { groupJids: [...jids] });
    }
    println(`✓ Grup "${picked.name}" ditambahkan ke input.`);

  } else if (action === 'r' && current.length) {
    let remOut = '';
    current.forEach((jid, i) => {
      const grp = groups.find(g => g.id === jid);
      remOut += `  ${i + 1}. ${grp ? grp.name : jid}\n`;
    });
    println(remOut);

    const answer = (await ask(' Nomor yang dihapus: ')).trim();
    const idx = parseInt(answer) - 1;
    if (isNaN(idx) || !current[idx]) { println('✗ Nomor tidak valid.'); return; }
    const removedJid = current[idx];
    const updated    = current.filter((_, i) => i !== idx);
    saveConfig({ inputGroups: updated, inputGroup: updated[0] || '', inputGroupName: groups.find(g => g.id === updated[0])?.name || '' }, _currentTenant);
    const grpName = groups.find(g => g.id === removedJid)?.name || removedJid;
    println(`✓ Grup "${grpName}" dihapus dari input.`);

  } else {
    println('Aksi tidak valid.');
  }
}

// ══════════════════════════════════════════════════════════════
//  /knowledge
// ══════════════════════════════════════════════════════════════
function cmdKnowledge() {
  const docs = getKnowledge(_currentTenant);
  let out = `KNOWLEDGE — ${docs.length} dokumen\n` + '─'.repeat(40) + '\n';

  if (!docs.length) {
    out += 'Belum ada dokumen. Upload file ke grup input.';
  } else {
    docs.forEach((d, i) => {
      const kb      = d.raw_text ? Math.round(d.raw_text.length / 1024) : 0;
      const compact = d.compacted ? ' [compact]' : '';
      const date    = d.timestamp ? d.timestamp.slice(0, 10) : '?';
      out += `  ${String(i + 1).padStart(2)}. ${d.file}${compact}\n`;
      out += `      ${date} · ${kb} KB teks\n`;
    });
  }

  out += '─'.repeat(40);
  println(out);
}

// ══════════════════════════════════════════════════════════════
//  /compact
// ══════════════════════════════════════════════════════════════
async function cmdCompact() {
  const docs = getKnowledge(_currentTenant);
  const cfg  = getConfig(_currentTenant);

  if (!docs.length) { println('! Tidak ada dokumen untuk dikompres.'); return; }
  if (!cfg.provider || !cfg.apiKey) { println('✗ Set AI dulu via /model.'); return; }

  let out = 'COMPACT — Kompresi Konteks\n' + '─'.repeat(40) + '\n';
  out += '  1. Semua dokumen\n  2. Pilih dokumen tertentu';
  println(out);

  const mode = (await ask(' Pilih mode (1/2): ')).trim();

  let targets = [];
  if (mode === '1') {
    targets = docs;
  } else if (mode === '2') {
    let docList = '';
    docs.forEach((d, i) => { docList += `  ${i + 1}. ${d.file}\n`; });
    println(docList);
    const pick = (await ask(' Nomor dokumen (pisah koma, misal: 1,3): ')).trim();
    targets = pick.split(',')
      .map(x => docs[parseInt(x.trim()) - 1])
      .filter(Boolean);
  } else {
    println('✗ Pilihan tidak valid.'); return;
  }

  if (!targets.length) { println('✗ Tidak ada target valid.'); return; }

  for (const doc of targets) {
    log('INFO', `Kompres: ${doc.file} ...`);
    const ok = await compactKnowledge(doc.hash, cfg, _currentTenant);
    println(`  ${doc.file} ... ${ok ? '✓' : '✗ gagal'}`);
  }

  println('✓ Selesai. Konteks lebih efisien!');
}

// ══════════════════════════════════════════════════════════════
//  File edit via AI
// ══════════════════════════════════════════════════════════════
async function handleFileEdit(instruction, attachment, cfg) {
  const { callAI } = require('./ai');
  const { diffLines } = require('./filepicker');

  println(`EDIT FILE — ${attachment.path}\n` + '─'.repeat(40));
  log('AGENT', `AI sedang membuat perubahan pada ${attachment.path}...`);

  const systemPrompt = 'Kamu editor kode/teks. Output HANYA isi file yang sudah diedit, tanpa penjelasan, tanpa markdown code fence, tanpa komentar tambahan. Output langsung isi filenya saja.';
  const userPrompt   = `File: ${attachment.path}\n\nInstruksi: ${instruction}\n\nIsi file sekarang:\n${attachment.content}`;

  let newContent;
  try {
    newContent = await callAI([{ role: 'user', content: userPrompt }], systemPrompt, cfg);
  } catch (e) {
    println(`✗ Error: ${e.message}`); return;
  }

  newContent = newContent.replace(/^```[\w]*\n?/m, '').replace(/\n?```$/m, '').trim() + '\n';

  const { lines: diffOut, added, removed } = diffLines(attachment.content, newContent);

  if (!diffOut.length) { println('Tidak ada perubahan.'); return; }

  println(`+ ${added} baris ditambah  - ${removed} baris dihapus`);
  const preview = diffOut.slice(0, 30).join('\n');
  println(preview);
  if (diffOut.length > 30) println(`... (${diffOut.length - 30} baris lainnya)`);

  const confirm = (await ask(' Terapkan perubahan? (y/N): ')).trim().toLowerCase();
  if (confirm === 'y' || confirm === 'ya') {
    try {
      fs.writeFileSync(path.resolve(attachment.path), newContent, 'utf8');
      println(`✓ File berhasil diperbarui: ${attachment.path}`);
    } catch (e) {
      println(`✗ Gagal tulis file: ${e.message}`);
    }
  } else {
    println('Dibatalkan.');
  }
}

// ══════════════════════════════════════════════════════════════
//  Direct question
// ══════════════════════════════════════════════════════════════
async function handleQuestion(input) {
  const cfg = getConfig(_currentTenant);
  if (!cfg.provider || !cfg.apiKey) {
    println('! Set AI dulu via /model.'); return;
  }

  // Check if input has @file references
  if (input.includes('@')) {
    const { clean, attachments } = resolveAtFiles(input);
    if (attachments.length) {
      attachments.forEach(a => log('FILE', `${a.path} (${Math.round(a.content.length / 1024)}KB)`));

      const isEditIntent = /\b(edit|ubah|ganti|tambah|hapus baris|refactor|perbaiki|update|tulis ulang)\b/i.test(clean);
      if (isEditIntent && attachments.length === 1) {
        await handleFileEdit(clean, attachments[0], cfg);
        return;
      }

      const question = clean + '\n\n' + attachments.map(a => `[Isi file ${path.basename(a.path)}]\n${a.content.slice(0, 4000)}`).join('\n\n');
      log('AGENT', 'Sedang berpikir...');
      try {
        const context = searchKnowledge(question, _currentTenant);
        const answer  = await answerQuestion(question, context || '', cfg);
        ui.appendChat('bima', answer);
      } catch (err) {
        println(`✗ Error: ${err.message}`);
      }
      return;
    }
  }

  log('AGENT', 'Sedang berpikir...');
  try {
    // Use semantic search if embeddings available, else keyword
    const context = await searchKnowledgeSemantic(input, _currentTenant);
    const answer  = await answerQuestion(input, context || '', cfg);
    ui.appendChat('bima', answer);
  } catch (err) {
    println(`✗ Error: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
//  /stt
// ══════════════════════════════════════════════════════════════
async function cmdSTT() {
  const cfg = getConfig(_currentTenant);
  let out = 'STT — Konfigurasi Voice Note\n' + '─'.repeat(40) + '\n';
  out += '  1. Lokal (Whisper)  (offline, gratis, ~75MB — RECOMMENDED)\n';
  out += '  2. Groq Whisper     (online, gratis 7200 mnt/hari, cepat)\n';
  out += '  3. HuggingFace      (online, indonesian-nlp/multilingual-asr)\n';
  out += '  4. OpenAI Whisper   (online, berbayar)\n';
  out += `  5. Pakai AI key sekarang (${cfg.provider || '?'} — hanya jika OpenAI)`;
  println(out);

  const choice = (await ask(' Pilih (1-5): ')).trim();

  if (choice === '1') {
    println('  a. whisper-tiny  (75MB, ~1-2 detik/pesan — default)\n  b. whisper-base  (145MB, lebih akurat)\n  c. whisper-small (290MB, terbaik untuk Indonesia)');
    const m = (await ask(' Pilih model (a/b/c, Enter=a): ')).trim() || 'a';
    const models = ['Xenova/whisper-tiny', 'Xenova/whisper-base', 'Xenova/whisper-small'];
    const mMap   = { a: models[0], b: models[1], c: models[2] };
    const sttModel = mMap[m] || models[0];
    saveConfig({ sttProvider: 'local', sttModel, sttKey: null }, _currentTenant);
    println(`✓ STT lokal: ${sttModel}\nModel didownload otomatis saat pertama kali dipakai.`);
    return;
  }

  if (choice === '5') {
    if (cfg.provider !== 'openai') { println('✗ Provider bukan OpenAI. Pilih 1-4.'); return; }
    saveConfig({ sttProvider: 'openai', sttKey: cfg.apiKey }, _currentTenant);
    println('✓ STT menggunakan OpenAI key yang sama.');
    return;
  }

  const providers = { '2': 'groq', '3': 'hf', '4': 'openai' };
  const provider  = providers[choice];
  if (!provider) { println('✗ Pilihan tidak valid.'); return; }

  const keyLabel = provider === 'hf' ? 'HuggingFace Token (hf_...)' : 'API Key';
  const key = (await ask(` ${keyLabel}: `)).trim();
  if (!key) { println('✗ Key tidak boleh kosong.'); return; }

  let sttModel;
  if (provider === 'hf') {
    const defaultModel = 'indonesian-nlp/multilingual-asr';
    const modelInput = (await ask(` Model ID (Enter = ${defaultModel}): `)).trim();
    sttModel = modelInput || defaultModel;
  }

  saveConfig({ sttProvider: provider, sttKey: key, ...(sttModel ? { sttModel } : {}) }, _currentTenant);
  println(`✓ STT dikonfigurasi: ${provider}${sttModel ? '\n  Model: ' + sttModel : ''}`);
}

// ══════════════════════════════════════════════════════════════
//  /memory
// ══════════════════════════════════════════════════════════════
function cmdMemory() {
  const { clearAll } = require('./memory');
  clearAll();
  println('✓ Semua memori percakapan berhasil di-reset.');
}

// ══════════════════════════════════════════════════════════════
//  /reminder
// ══════════════════════════════════════════════════════════════
function cmdReminder() {
  const p = tenantPaths(_currentTenant).reminders;
  let out = `REMINDER — Pengingat Aktif [${_currentTenant}]\n` + '─'.repeat(40) + '\n';

  try {
    const list   = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
    const now    = Date.now();
    const active = list.filter(r => r.targetMs > now);

    if (!active.length) {
      out += 'Tidak ada pengingat aktif.';
    } else {
      active.forEach((r, i) => {
        const t = new Date(r.targetMs).toLocaleString('id-ID');
        out += `  ${i + 1}. ${r.message}\n     ${t} → ${r.jid.split('@')[0]}\n`;
      });
    }
  } catch {
    out += 'Belum ada pengingat.';
  }

  out += '─'.repeat(40);
  println(out);
}

// ══════════════════════════════════════════════════════════════
//  /tenant
// ══════════════════════════════════════════════════════════════
async function cmdTenant(args) {
  const sub = args[0];

  if (!sub || sub === 'list') {
    const tenants = listTenants();
    let out = `TENANTS — ${tenants.length} tenant\n` + '─'.repeat(40) + '\n';
    if (!tenants.length) {
      out += 'Belum ada tenant. Ketik /tenant add';
    } else {
      tenants.forEach(t => {
        const active = t.id === _currentTenant ? ' ← aktif' : '';
        out += `  ${t.id}${active}\n`;
        out += `     nama: ${t.name} | grup: ${(t.groupJids || []).length} | owner: ${t.ownerJid || '-'}\n`;
      });
    }
    out += '─'.repeat(40) + '\nSubcommand: list | add | switch <id> | del <id> | groups <id>';
    println(out); return;
  }

  if (sub === 'add') {
    const id   = (await ask(' ID tenant (huruf, angka, dash): ')).trim();
    const name = (await ask(' Nama display (Enter = sama dengan ID): ')).trim() || id;
    try {
      const t = addTenant({ id, name });
      println(`✓ Tenant "${t.id}" dibuat. Gunakan /tenant switch ${t.id} lalu /model untuk set AI-nya.`);
    } catch (e) {
      println(`✗ ${e.message}`);
    }
    return;
  }

  if (sub === 'switch') {
    const id = args[1];
    if (!id) { println('Contoh: /tenant switch toko_abc'); return; }
    const t = getTenant(id);
    if (!t) { println(`✗ Tenant "${id}" tidak ada.`); return; }
    _currentTenant = id;
    println(`✓ CLI sekarang menggunakan tenant: ${id}`);
    const cfg = getConfig(_currentTenant);
    ui.updateStatus({ provider: cfg.provider, model: cfg.model, waConnected: getWAStatus().connected, tenant: _currentTenant });
    return;
  }

  if (sub === 'del') {
    const id = args[1];
    if (!id) { println('Contoh: /tenant del toko_abc'); return; }
    try {
      deleteTenant(id);
      if (_currentTenant === id) _currentTenant = 'default';
      println(`✓ Tenant "${id}" dihapus dari registry. Data folder tidak dihapus.`);
    } catch (e) {
      println(`✗ ${e.message}`);
    }
    return;
  }

  if (sub === 'groups') {
    const id  = args[1] || _currentTenant;
    const t   = getTenant(id);
    if (!t) { println(`✗ Tenant "${id}" tidak ada.`); return; }
    const wa = getWAStatus();
    const groups = wa.groups || [];

    let out = `GRUP — Tambah grup ke tenant "${id}"\n` + '─'.repeat(40) + '\n';

    if (!groups.length) {
      out += '! WA belum connect atau belum ada grup.';
      println(out); return;
    }

    const current = new Set(t.groupJids || []);
    groups.forEach((g, i) => {
      const mark = current.has(g.id) ? ' ✓' : '';
      out += `  ${String(i + 1).padStart(2)}. ${g.name}${mark}\n`;
    });
    println(out);

    const picks = (await ask(' Nomor grup (pisah koma, misal: 1,3): ')).trim();
    if (picks) {
      const jids = picks.split(',')
        .map(x => groups[parseInt(x.trim()) - 1]?.id)
        .filter(Boolean);
      const merged = [...new Set([...current, ...jids])];
      updateTenant(id, { groupJids: merged });
      println(`✓ ${jids.length} grup ditambahkan ke tenant "${id}".`);
    }
    return;
  }

  println('Subcommand tidak dikenal. Gunakan: list | add | switch | del | groups');
}

// ══════════════════════════════════════════════════════════════
//  /ltm
// ══════════════════════════════════════════════════════════════
function cmdLTM() {
  const { getAll } = require('./ltm');
  const all = getAll(_currentTenant);

  let out = `LONG-TERM MEMORY — ${all.length} fakta\n` + '─'.repeat(40) + '\n';

  if (!all.length) {
    out += 'Belum ada fakta tersimpan.';
  } else {
    all.forEach((m, i) => {
      const date = m.timestamp?.slice(0, 10) || '?';
      out += `  ${i + 1}. ${m.content}\n     id:${m.id} · ${date}\n`;
    });
    out += '\nHapus: /ltm del <id>';
  }

  out += '\n' + '─'.repeat(40);
  println(out);
}

function cmdLTMDelete(id) {
  if (!id) { println('Contoh: /ltm del abc123'); return; }
  const { deleteMemory } = require('./ltm');
  const ok = deleteMemory(id, _currentTenant);
  println(ok ? `✓ Memori ${id} dihapus.` : '✗ ID tidak ditemukan.');
}

// ══════════════════════════════════════════════════════════════
//  /tts — configure Text-to-Speech voice
// ══════════════════════════════════════════════════════════════
function cmdTTS(args) {
  const { setVoice, getConfig: getTTSConfig, VOICE_LIST } = require('./tts');
  const sub = args[0];

  if (!sub || sub === 'status') {
    const cfg = getTTSConfig();
    let out = 'TTS — Text-to-Speech\n' + '─'.repeat(40) + '\n';
    out += `  Voice aktif : ${cfg.voice}\n\n`;
    out += '  Suara tersedia:\n';
    VOICE_LIST.forEach(v => {
      const mark = v.name === cfg.voice ? ' ← aktif' : '';
      out += `    ${v.alias.padEnd(8)} ${v.name} (${v.gender})${mark}\n`;
    });
    out += '\n  Ubah suara: /tts voice <alias|nama>\n';
    out += '  Contoh: /tts voice gadis\n';
    out += '─'.repeat(40);
    println(out);
    return;
  }

  if (sub === 'voice' || sub === 'set') {
    const input = args[1];
    if (!input) { println('Contoh: /tts voice ardi\n        /tts voice gadis'); return; }
    const resolved = setVoice(input);
    println(`✓ Suara TTS diset ke: ${resolved}`);
    return;
  }

  if (sub === 'list') {
    let out = 'TTS — Daftar Suara Indonesia\n' + '─'.repeat(40) + '\n';
    VOICE_LIST.forEach(v => {
      out += `  ${v.alias.padEnd(8)} ${v.name}  (${v.gender})\n`;
    });
    out += '─'.repeat(40);
    println(out);
    return;
  }

  println('Subcommand: status | voice <alias> | list\nContoh: /tts voice gadis');
}

// ══════════════════════════════════════════════════════════════
//  /search
// ══════════════════════════════════════════════════════════════
async function cmdSearch(query) {
  if (!query) { println('Contoh: /search harga minyak goreng hari ini'); return; }

  log('INFO', `Mencari: "${query}"...`);
  try {
    const { webSearch } = require('./search');
    const result = await webSearch(query);
    println('Hasil Web\n' + '─'.repeat(40) + '\n' + (result || 'Tidak ada hasil.'));
  } catch (e) {
    println(`✗ Error: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
//  /skill — plugin management
// ══════════════════════════════════════════════════════════════
async function cmdSkill(args) {
  const sub = args[0];

  if (!sub || sub === 'list') {
    const ps = plugins.getPlugins();
    let out = `PLUGINS/SKILLS — ${ps.length} loaded\n` + '─'.repeat(40) + '\n';
    if (!ps.length) {
      out += `Tidak ada plugin aktif.\nPlugin dir: ${plugins.PLUGINS_DIR}\nSalin file .js plugin ke folder tersebut.`;
    } else {
      ps.forEach((p, i) => {
        const cmds = Object.keys(p.commands || {}).join(', ') || '-';
        const tools = (p.tools || []).map(t => t.name).join(', ') || '-';
        out += `  ${i + 1}. ${p.name} — ${p.description || ''}\n`;
        out += `     Perintah: ${cmds}\n`;
        out += `     Tools   : ${tools}\n`;
      });
    }
    println(out); return;
  }

  if (sub === 'add') {
    const target = args[1];
    if (!target) { println('Contoh: /skill add /path/to/plugin.js\n        /skill add user/repo\n        /skill add https://raw.../plugin.js'); return; }
    try {
      let p;
      if (target.startsWith('http') || target.includes('/')) {
        println(`⏳ Download plugin dari: ${target}...`);
        p = await plugins.installFromUrl(target);
      } else {
        p = plugins.installPlugin(path.resolve(target));
      }
      println(`✓ Plugin "${p.name}" berhasil diinstall.\n  Tools: ${(p.tools||[]).map(t=>t.name).join(', ')||'-'}\n  Cmds : ${Object.keys(p.commands||{}).join(', ')||'-'}`);
    } catch (e) {
      println(`✗ Gagal install plugin: ${e.message}`);
    }
    return;
  }

  if (sub === 'remove' || sub === 'uninstall') {
    const name = args[1];
    if (!name) { println('Contoh: /skill remove example'); return; }
    const ok = plugins.uninstallPlugin(name);
    println(ok ? `✓ Plugin "${name}" dihapus.` : `✗ Plugin "${name}" tidak ditemukan.`);
    return;
  }

  if (sub === 'info') {
    const name = args[1];
    if (!name) { println('Contoh: /skill info example'); return; }
    const p = plugins.getPlugins().find(pl => pl.name === name);
    if (!p) { println(`✗ Plugin "${name}" tidak ditemukan.`); return; }
    let out = `PLUGIN: ${p.name}\n` + '─'.repeat(40) + '\n';
    out += `Deskripsi : ${p.description || '-'}\n`;
    out += `Perintah  : ${Object.keys(p.commands || {}).join(', ') || '-'}\n`;
    out += `Tools     : ${(p.tools || []).map(t => t.name + ' — ' + (t.description || '')).join('\n            ') || '-'}\n`;
    out += '─'.repeat(40);
    println(out); return;
  }

  println('Subcommand: list | add <path|url|user/repo> | remove <name> | info <name>');
}

// ══════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════
async function main() {
  // Init TUI first (banner printed inside)
  ui.init();

  // Load plugins + start hot-reload watcher
  const loaded = plugins.loadPlugins();
  plugins.watchPlugins((name) => {
    if (name.startsWith('unloaded:')) {
      ui.log('INFO', `Plugin dihapus: ${name.slice(9)}`);
    } else {
      ui.log('INFO', `Plugin dimuat ulang: ${name}`);
    }
  });
  if (loaded.length) {
    ui.log('INFO', `${loaded.length} plugin aktif: ${loaded.map(p => p.name).join(', ')}`);
  }

  // First-run wizard
  if (!isSetupDone()) {
    const result = await runWizard(ask, println);
    if (result?.connectWA) {
      const cfg2 = getConfig(_currentTenant);
      ui.updateStatus({ provider: cfg2.provider, model: cfg2.model, waConnected: false, tenant: _currentTenant });
      startWA(log);
    }
  }

  // Initial status
  const cfg = getConfig(_currentTenant);
  ui.updateStatus({
    provider:    cfg.provider,
    model:       cfg.model,
    waConnected: false,
    tenant:      _currentTenant,
  });

  // Show startup status
  ui.appendChat('system',
    `AI: ${cfg.provider || 'Belum diset'} / ${cfg.model || '--'}` +
    `  │  Input: ${cfg.inputGroupName || 'Belum diset'}` +
    `  │  Output: ${cfg.outputGroupName || 'Belum diset'}`
  );

  // Warm up semantic embeddings in background (no block)
  setTimeout(async () => {
    try {
      const { getPipeline } = require('./embed');
      ui.log('INFO', 'Memuat model semantic search...');
      await getPipeline();
      ui.log('INFO', 'Semantic search siap ✓');
    } catch {
      ui.log('DEBUG', 'Semantic search tidak tersedia (opsional)');
    }
  }, 3000);

  // Auto-connect WA if session exists
  const authDir = process.env.BIMA_DATA
    ? path.join(process.env.BIMA_DATA, 'auth')
    : path.join(os.homedir(), '.bima', 'auth');
  const hasSession = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  if (hasSession) {
    ui.log('WA', 'Session ditemukan. Menghubungkan otomatis...');
    startWA(log);
  } else {
    ui.log('WA', 'Session tidak ada. Ketik /wa untuk mulai.');
  }

  // Set up input handler
  ui.onInput(async (line) => {
    // Echo user input to chat panel
    ui.appendChat('user', line);

    try {
      if (line === '/help')                { cmdHelp(); }
      else if (line === '/status')         { cmdStatus(); }
      else if (line === '/wa')             { await cmdWA(); }
      else if (line === '/model')          { await cmdModel(); }
      else if (line === '/input')          { await cmdSetGroup('input'); }
      else if (line === '/output')         { await cmdSetGroup('output'); }
      else if (line === '/knowledge')      { cmdKnowledge(); }
      else if (line === '/compact')        { await cmdCompact(); }
      else if (line === '/stt')            { await cmdSTT(); }
      else if (line === '/tts' || line.startsWith('/tts ')) {
        const parts = line.slice(4).trim().split(/\s+/).filter(Boolean);
        cmdTTS(parts);
      }
      else if (line === '/memory')         { cmdMemory(); }
      else if (line === '/reminder')       { cmdReminder(); }
      else if (line === '/ltm')            { cmdLTM(); }
      else if (line.startsWith('/ltm del ')){ cmdLTMDelete(line.slice(9).trim()); }
      else if (line.startsWith('/search ')) { await cmdSearch(line.slice(8).trim()); }
      else if (line === '/tenant' || line.startsWith('/tenant ')) {
        const parts = line.slice(7).trim().split(/\s+/).filter(Boolean);
        await cmdTenant(parts);
      }
      else if (line === '/skill' || line.startsWith('/skill ') ||
               line === '/skills' || line.startsWith('/skills ')) {
        const raw   = line.startsWith('/skills') ? line.slice(7) : line.slice(6);
        const parts = raw.trim().split(/\s+/).filter(Boolean);
        await cmdSkill(parts);
      }
      else if (line === '/clear') {
        // Clear chat panel by appending separator
        ui.appendChat('system', '═'.repeat(54) + '\n  Layar dibersihkan\n' + '═'.repeat(54));
      }
      else if (line === '/logout') {
        const confirm = (await ask(' ! Logout WhatsApp? Session akan dihapus (y/N): ')).trim().toLowerCase();
        if (confirm === 'y' || confirm === 'ya') {
          ui.log('WA', 'Logout...');
          await logoutWA();
          ui.log('WA', 'Logout berhasil. Ketik /wa untuk scan QR ulang.');
          ui.updateStatus({ provider: cfg.provider, model: cfg.model, waConnected: false, tenant: _currentTenant });
        } else {
          println('Dibatalkan.');
        }
      }
      else if (line === '/exit' || line === '/quit') {
        ui.appendChat('system', 'Sampai jumpa! — Bima');
        setTimeout(() => process.exit(0), 500);
      }
      else if (line.startsWith('/')) {
        // Check plugin commands
        const pluginCmds = plugins.getPluginCommands();
        const cmdKey = line.split(/\s+/)[0];
        if (pluginCmds[cmdKey]) {
          const args = line.slice(cmdKey.length).trim();
          await pluginCmds[cmdKey](args, { log, appendChat: ui.appendChat });
        } else {
          println(`? Perintah tidak dikenal: ${cmdKey}. Ketik /help`);
        }
      }
      else {
        await handleQuestion(line);
      }
    } catch (err) {
      println(`✗ Error: ${err.message}`);
    }
  });
}

module.exports = { log };
main().catch(e => { console.error(e); process.exit(1); });
