#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { getConfig, saveConfig, maskKey } = require('./config');
const { startWA, getWAStatus, logoutWA, sendWAMessage } = require('./whatsapp');
const { startNano, stopNano } = require('./nano');
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
    ['/contacts',   'Kelola buku kontak (nama → nomor telepon)'],
    ['/blacklist',  'Lihat/hapus nomor yang diblacklist (guard)'],
    ['/workflow',   'Kelola workflow otomatis (list/run/create/ai/enable)'],
    ['/compact',   'Kompres konteks dokumen (hemat token)'],
    ['/stt',       'Konfigurasi Speech-to-Text (voice note)'],
    ['/tts',       'Konfigurasi Text-to-Speech (suara Bima)'],
    ['/reminder',  'Lihat daftar pengingat aktif'],
    ['/memory',    'Reset memori percakapan semua user'],
    ['/ltm',       'Lihat / hapus memori jangka panjang'],
    ['/search',    'Cari di web langsung dari terminal'],
    ['/polymarket','Cari pasar prediksi di Polymarket'],
    ['/api',        'REST API + Web Admin panel (start/stop/key/status)'],
    ['/tg',        'Kelola Telegram bot (token/start/stop/status)'],
    ['/tenant',    'Kelola tenant (list/add/switch/del/groups)'],
    ['/skill',     'Kelola plugin/skill (list/add/remove/info)'],
    ['/watch',     'Monitor topik, kirim notif ke grup kalau berubah'],
    ['/profiles',  'Lihat profil member yang sudah berinteraksi'],
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
  const { PROVIDER_NAMES } = require('./ai');

  // 6 provider utama (urutan ditampilkan pertama), lalu provider tambahan
  const PROV = [
    { id: 'anthropic',  ex: 'claude-sonnet-4-6',                     needKey: true,  needUrl: false },
    { id: 'openai',     ex: 'gpt-4o-mini',                           needKey: true,  needUrl: false },
    { id: 'gemini',     ex: 'gemini-1.5-flash',                      needKey: true,  needUrl: false },
    { id: 'openrouter', ex: 'meta-llama/llama-3.1-8b-instruct:free', needKey: true,  needUrl: false },
    { id: 'groq',       ex: 'llama-3.1-8b-instant',                  needKey: true,  needUrl: false },
    { id: 'ollama',     ex: 'llama3',                                 needKey: false, needUrl: true  },
    // ── Provider Tambahan ─────────────────────────────────────
    { id: 'mistral',    ex: 'mistral-small-latest',                   needKey: true,  needUrl: false },
    { id: 'deepseek',   ex: 'deepseek-chat',                         needKey: true,  needUrl: false },
    { id: 'together',   ex: 'meta-llama/Llama-3-8b-chat-hf',        needKey: true,  needUrl: false },
    { id: 'lmstudio',   ex: 'local-model',                           needKey: false, needUrl: true  },
    { id: 'compat',     ex: 'my-model',                              needKey: false, needUrl: true  },
  ];

  const provItems = PROV.map(p => ({
    label: PROVIDER_NAMES[p.id] || p.id,
    desc:  p.ex,
  }));
  const provIdx = await ui.selectMenu('MODEL — Pilih AI Provider', provItems);
  if (provIdx === null) { println('Dibatalkan.'); return; }
  const prov = PROV[provIdx];

  const model = (await ask(` Model (Enter = ${prov.ex}): `)).trim() || prov.ex;

  let baseUrl = '';
  if (prov.needUrl) {
    const defUrl = prov.id === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234';
    baseUrl = (await ask(` Base URL (Enter = ${defUrl}): `)).trim() || defUrl;
  }

  let apiKey = '';
  if (prov.needKey) {
    apiKey = (await ask(' API Key: ')).trim();
    if (!apiKey) { println('✗ API Key tidak boleh kosong.'); return; }
  }

  println('⏳ Menguji koneksi...');
  const cfg = { provider: prov.id, model, apiKey, ...(baseUrl ? { baseUrl } : {}) };
  const ok  = await testAI(cfg);

  if (!ok && prov.needKey) {
    println('✗ Koneksi gagal. Periksa API key / model.'); return;
  }
  if (!ok) println('⚠ Koneksi lokal gagal — pastikan server running.');

  // Ask for fallback provider (optional)
  println('');
  println('Opsional: set provider fallback (dipakai jika provider utama rate-limit/error).');
  const wantFallback = (await ask(' Tambah fallback provider? (y/N): ')).trim().toLowerCase();
  let fallbackProvider = '', fallbackApiKey = '', fallbackModel = '';

  if (wantFallback === 'y' || wantFallback === 'ya') {
    const fbItems = PROV.filter(p => p.id !== prov.id).map(p => ({ label: PROVIDER_NAMES[p.id] || p.id, desc: p.ex }));
    const fbIdx   = await ui.selectMenu('MODEL — Pilih Fallback Provider', fbItems);
    if (fbIdx !== null) {
      const fbProvList = PROV.filter(p => p.id !== prov.id);
      const fbProv = fbProvList[fbIdx];
      fallbackModel = (await ask(` Fallback model (Enter = ${fbProv.ex}): `)).trim() || fbProv.ex;
      if (fbProv.needKey) {
        fallbackApiKey = (await ask(' Fallback API Key: ')).trim();
      }
      fallbackProvider = fbProv.id;
      println(`✓ Fallback: ${fbProv.id} / ${fallbackModel}`);
    }
  }

  const cfgToSave = {
    provider: prov.id, model, apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(fallbackProvider ? { fallbackProvider, fallbackApiKey, fallbackModel } : {}),
  };
  saveConfig(cfgToSave, _currentTenant);
  println(`✓ Disimpan!\n  Provider : ${prov.id}\n  Model    : ${model}${baseUrl ? '\n  Base URL : ' + baseUrl : ''}${apiKey ? '\n  API Key  : ' + maskKey(apiKey) : ''}${fallbackProvider ? '\n  Fallback : ' + fallbackProvider + ' / ' + fallbackModel : ''}`);
  ui.updateStatus({ provider: prov.id, model, waConnected: getWAStatus().connected, tenant: _currentTenant });
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
    const idx = await ui.selectMenu('OUTPUT — Pilih Grup WhatsApp',
      groups.map(g => ({ label: g.name, desc: g.id.split('@')[0] }))
    );
    if (idx === null) { println('Dibatalkan.'); return; }
    saveConfig({ outputGroup: groups[idx].id, outputGroupName: groups[idx].name }, _currentTenant);
    println(`✓ Grup output diset ke: ${groups[idx].name}`);
    return;
  }

  // INPUT: multi-group
  const cfg     = getConfig(_currentTenant);
  const current = Array.isArray(cfg.inputGroups) ? cfg.inputGroups
                : (cfg.inputGroup ? [cfg.inputGroup] : []);

  let statusOut = `INPUT — Grup Input WhatsApp (${_currentTenant})\n` + '─'.repeat(40) + '\n';
  if (current.length) {
    statusOut += 'Grup input aktif:\n';
    current.forEach((jid, i) => {
      const grp = groups.find(g => g.id === jid);
      statusOut += `  ${i + 1}. ${grp ? grp.name : jid}\n`;
    });
  } else {
    statusOut += 'Belum ada grup input.\n';
  }
  println(statusOut);

  const actionItems = [
    { label: 'Tambah grup input', desc: 'pilih dari daftar grup' },
    ...(current.length ? [{ label: 'Hapus grup dari list', desc: `${current.length} grup aktif` }] : []),
  ];
  const actionIdx = await ui.selectMenu('INPUT — Pilih Aksi', actionItems);
  if (actionIdx === null) { println('Dibatalkan.'); return; }

  if (actionIdx === 0) {
    const grpItems = groups.map(g => ({
      label: g.name,
      desc:  current.includes(g.id) ? '✓ aktif' : '',
    }));
    const idx = await ui.selectMenu('INPUT — Pilih Grup', grpItems);
    if (idx === null) { println('Dibatalkan.'); return; }
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

  } else if (actionIdx === 1 && current.length) {
    const remItems = current.map(jid => {
      const grp = groups.find(g => g.id === jid);
      return { label: grp ? grp.name : jid, desc: jid.split('@')[0] };
    });
    const idx = await ui.selectMenu('INPUT — Pilih Grup yang Dihapus', remItems);
    if (idx === null) { println('Dibatalkan.'); return; }
    const removedJid = current[idx];
    const updated    = current.filter((_, i) => i !== idx);
    saveConfig({ inputGroups: updated, inputGroup: updated[0] || '', inputGroupName: groups.find(g => g.id === updated[0])?.name || '' }, _currentTenant);
    const grpName = groups.find(g => g.id === removedJid)?.name || removedJid;
    println(`✓ Grup "${grpName}" dihapus dari input.`);
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
//  /contacts
// ══════════════════════════════════════════════════════════════
async function cmdContacts() {
  const { listContacts, saveContact, deleteContact, lookupContact } = require('./contacts');

  const actionIdx = await ui.selectMenu('KONTAK — Pilih Aksi', [
    { label: 'Lihat semua kontak',   desc: 'tampilkan buku kontak' },
    { label: 'Tambah kontak baru',   desc: 'simpan nama & nomor' },
    { label: 'Cari kontak',          desc: 'cari berdasarkan nama/nomor' },
    { label: 'Hapus kontak',         desc: 'hapus dari buku kontak' },
  ]);
  if (actionIdx === null) { println('Dibatalkan.'); return; }

  if (actionIdx === 0) {
    const contacts = listContacts(_currentTenant);
    if (!contacts.length) { println('Buku kontak masih kosong.'); return; }
    let out = `KONTAK — ${contacts.length} entri\n` + '─'.repeat(40) + '\n';
    contacts.forEach((c, i) => {
      out += `  ${String(i + 1).padStart(2)}. ${c.name.padEnd(25)} ${c.phone}\n`;
    });
    out += '─'.repeat(40);
    println(out);

  } else if (actionIdx === 1) {
    const name  = (await ask(' Nama (contoh: Pak Ramli): ')).trim();
    if (!name) { println('✗ Nama tidak boleh kosong.'); return; }
    const phone = (await ask(' Nomor telepon (contoh: 082171827205 atau +6282171827205): ')).trim();
    if (!phone) { println('✗ Nomor tidak boleh kosong.'); return; }
    const saved = saveContact(name, phone, _currentTenant);
    println(`✓ Kontak "${name}" disimpan: ${saved}`);

  } else if (actionIdx === 2) {
    const query   = (await ask(' Cari nama/nomor: ')).trim();
    if (!query) return;
    const results = lookupContact(query, _currentTenant);
    if (!results.length) { println(`Tidak ada kontak yang cocok dengan "${query}".`); return; }
    results.forEach((c, i) => println(`  ${i + 1}. ${c.name} → ${c.phone}`));

  } else if (actionIdx === 3) {
    const contacts = listContacts(_currentTenant);
    if (!contacts.length) { println('Buku kontak masih kosong.'); return; }
    const idx = await ui.selectMenu('KONTAK — Pilih yang Dihapus',
      contacts.map(c => ({ label: c.name, desc: c.phone }))
    );
    if (idx === null) { println('Dibatalkan.'); return; }
    deleteContact(contacts[idx].name, _currentTenant);
    println(`✓ Kontak "${contacts[idx].name}" dihapus.`);
  }
}

// ══════════════════════════════════════════════════════════════
//  /blacklist
// ══════════════════════════════════════════════════════════════
function cmdBlacklist(args) {
  const { listBlacklist, removeFromBlacklist } = require('./blacklist');

  if (args[0] === 'del') {
    const no = args[1];
    if (!no) { println('Contoh: /blacklist del 628123456789'); return; }
    const ok = removeFromBlacklist(no);
    println(ok ? `✓ Nomor ${no} dihapus dari blacklist.` : `✗ Nomor ${no} tidak ada di blacklist.`);
    return;
  }

  const list = listBlacklist();
  if (!list.length) { println('Blacklist kosong — tidak ada nomor yang diblacklist.'); return; }

  let out = `BLACKLIST — ${list.length} nomor\n` + '─'.repeat(40) + '\n';
  list.forEach((e, i) => {
    const date = e.addedAt ? e.addedAt.slice(0, 16).replace('T', ' ') : '?';
    out += `  ${i + 1}. +${e.phone}\n     Alasan: ${e.reason} | ${date}\n`;
  });
  out += '─'.repeat(40) + '\nHapus: /blacklist del <nomor>';
  println(out);
}

// ══════════════════════════════════════════════════════════════
//  /workflow
// ══════════════════════════════════════════════════════════════
async function cmdWorkflow(args) {
  const {
    listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow,
    createWorkflow, runWorkflow, scheduleWorkflow, unscheduleWorkflow,
    activateTriggers, deactivateTriggers,
    getRunHistory, getRunStats,
  } = require('./workflow');
  const { sendWAMessage } = require('./whatsapp');

  const sub = args[0];

  // ── list ──────────────────────────────────────────────────
  if (!sub || sub === 'list') {
    const workflows = listWorkflows(_currentTenant);
    let out = `WORKFLOW — ${workflows.length} workflow\n` + '─'.repeat(50) + '\n';
    if (!workflows.length) {
      out += 'Belum ada workflow.\nBuat: /workflow create';
    } else {
      workflows.forEach((wf, i) => {
        const st  = wf.enabled ? '● aktif' : '○ nonaktif';
        const trigMap = {
          schedule:        `⏱ ${wf.trigger?.interval}`,
          'wa.message':    `💬 "${wf.trigger?.match || '*'}"`,
          file:            `📁 ${wf.trigger?.path || '?'}`,
          webhook:         `🔗 /webhook/${wf.trigger?.webhookId || wf.id}`,
          'wa.group_event':`👥 ${(wf.trigger?.actions || ['add','remove']).join('/')}`,
        };
        const trg = trigMap[wf.trigger?.type] || '⚡ manual';
        out += `  ${i + 1}. [${st}] ${wf.id}\n`;
        out += `     ${wf.name}\n`;
        out += `     Trigger: ${trg} | Node: ${(wf.nodes || []).length}\n`;
      });
      out += '─'.repeat(50);
      out += '\nVisual: /workflow view <id> | Run: /workflow run <id> | Enable: /workflow enable <id>';
    }
    println(out);
    return;
  }

  // ── info ──────────────────────────────────────────────────
  if (sub === 'info') {
    const id = args[1];
    if (!id) { println('Contoh: /workflow info <id>'); return; }
    const wf = getWorkflow(_currentTenant, id);
    if (!wf) { println(`✗ Workflow "${id}" tidak ada.`); return; }
    let out = `WORKFLOW: ${wf.id}\n` + '─'.repeat(50) + '\n';
    out += `Nama       : ${wf.name}\n`;
    out += `Deskripsi  : ${wf.description || '-'}\n`;
    out += `Status     : ${wf.enabled ? '● aktif' : '○ nonaktif'}\n`;
    out += `Trigger    : ${JSON.stringify(wf.trigger)}\n`;
    out += `Entry node : ${wf.entry}\n`;
    out += `Nodes (${(wf.nodes||[]).length}):\n`;
    (wf.nodes || []).forEach(n => {
      out += `  - ${n.id} [${n.type}]`;
      if (n.next) out += ` → ${n.next}`;
      if (n.branches) out += ` branches:${JSON.stringify(n.branches)}`;
      out += '\n';
    });
    out += '─'.repeat(50);
    println(out);
    return;
  }

  // ── view — ASCII visualization ────────────────────────────
  if (sub === 'view') {
    const id = args[1];
    if (!id) { println('Contoh: /workflow view <id>'); return; }
    const wf = getWorkflow(_currentTenant, id);
    if (!wf) { println(`✗ Workflow "${id}" tidak ada.`); return; }
    const { renderWorkflow } = require('./workflow_view');
    println(renderWorkflow(wf));
    return;
  }

  // ── run ───────────────────────────────────────────────────
  if (sub === 'run') {
    const id    = args[1];
    const input = args.slice(2).join(' ').trim();
    if (!id) { println('Contoh: /workflow run <id> [input]'); return; }
    const wf = getWorkflow(_currentTenant, id);
    if (!wf) { println(`✗ Workflow "${id}" tidak ada.`); return; }

    println(`⏳ Menjalankan workflow "${id}"...`);
    const wa = getWAStatus();

    const sendFn = async (jid, text) => {
      if (wa.connected && jid) {
        await sendWAMessage(jid, text);
      } else {
        println(`[WA MOCK] → ${jid || 'no-jid'}: ${text}`);
      }
    };

    try {
      const run = await runWorkflow(wf, {
        _tenantId:  _currentTenant,
        _jid:       null,
        _sender:    'cli',
        _trigger:   'manual',
        _sendFn:    sendFn,
        lastOutput: input || '',
        message:    input || '',
        input:      input || '',
      }, log);

      const { renderRunTrace } = require('./workflow_view');
      println(renderRunTrace(wf, run));
    } catch (e) {
      println(`✗ Error: ${e.message}`);
    }
    return;
  }

  // ── enable ────────────────────────────────────────────────
  if (sub === 'enable') {
    const id = args[1];
    if (!id) { println('Contoh: /workflow enable <id>'); return; }
    const wf = getWorkflow(_currentTenant, id);
    if (!wf) { println(`✗ Workflow "${id}" tidak ada.`); return; }
    wf.enabled = true;
    saveWorkflow(_currentTenant, wf);
    const started = activateTriggers(_currentTenant, wf, { _tenantId: _currentTenant }, log);
    const trigDesc = {
      schedule:       `dijadwalkan setiap ${wf.trigger?.interval}`,
      file:           `memantau file: ${wf.trigger?.path}`,
      webhook:        `webhook ID: ${wf.trigger?.webhookId || wf.id}`,
      'wa.message':   `keyword: "${wf.trigger?.match || '*'}"`,
      'wa.group_event': `event grup: ${(wf.trigger?.actions || ['add','remove']).join('/')}`,
      manual:         'dijalankan manual',
    }[wf.trigger?.type] || '';
    println(`✓ Workflow "${id}" aktif${trigDesc ? ' — ' + trigDesc : ''}.`);
    return;
  }

  // ── disable ───────────────────────────────────────────────
  if (sub === 'disable') {
    const id = args[1];
    if (!id) { println('Contoh: /workflow disable <id>'); return; }
    const wf = getWorkflow(_currentTenant, id);
    if (!wf) { println(`✗ Workflow "${id}" tidak ada.`); return; }
    wf.enabled = false;
    saveWorkflow(_currentTenant, wf);
    deactivateTriggers(_currentTenant, id);
    println(`✓ Workflow "${id}" dinonaktifkan.`);
    return;
  }

  // ── delete / del ──────────────────────────────────────────
  if (sub === 'delete' || sub === 'del') {
    const id = args[1];
    if (!id) { println('Contoh: /workflow del <id>'); return; }
    const confirm = (await ask(` ! Hapus workflow "${id}"? (y/N): `)).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'ya') { println('Dibatalkan.'); return; }
    deactivateTriggers(_currentTenant, id);
    const ok = deleteWorkflow(_currentTenant, id);
    println(ok ? `✓ Workflow "${id}" dihapus.` : `✗ Workflow "${id}" tidak ada.`);
    return;
  }

  // ── create — interactive wizard ───────────────────────────
  if (sub === 'create') {
    println('WORKFLOW BARU — Wizard\n' + '─'.repeat(50));
    println('(Kosongkan untuk batal)\n');

    const id   = (await ask(' ID workflow (huruf kecil, tanpa spasi): ')).trim().replace(/\s+/g, '_');
    if (!id) { println('Dibatalkan.'); return; }

    const name = (await ask(' Nama tampilan workflow: ')).trim();
    if (!name) { println('Dibatalkan.'); return; }

    const desc = (await ask(' Deskripsi (opsional): ')).trim();

    // Trigger type
    const triggerIdx = await ui.selectMenu('TRIGGER — Kapan workflow dijalankan?', [
      { label: 'Manual saja',      desc: '/workflow run <id>' },
      { label: 'Pesan WA',         desc: 'Jika ada pesan cocok keyword/regex' },
      { label: 'Terjadwal',        desc: 'Interval: 30s / 5m / 1h / 24h' },
      { label: 'File berubah',     desc: 'Pantau folder/file di sistem lokal' },
      { label: 'Webhook HTTP',     desc: 'POST ke /webhook/<id> memicu workflow' },
      { label: 'Event grup WA',    desc: 'Member join/leave grup' },
    ]);
    if (triggerIdx === null) { println('Dibatalkan.'); return; }

    let trigger = { type: 'manual' };
    if (triggerIdx === 1) {
      const match     = (await ask(' Keyword/regex (kosong = semua pesan): ')).trim();
      const exclusive = (await ask(' Hentikan respon AI normal? (y/N): ')).trim().toLowerCase();
      trigger = { type: 'wa.message', match: match || null, exclusive: exclusive === 'y' };
    } else if (triggerIdx === 2) {
      const interval = (await ask(' Interval (contoh: 30s / 5m / 1h / 24h): ')).trim();
      trigger = { type: 'schedule', interval };
    } else if (triggerIdx === 3) {
      const watchPath = (await ask(' Path folder/file (contoh: ~/Documents/inbox): ')).trim();
      const evtIdx    = await ui.selectMenu('Event yang dipantau:', [
        { label: 'Baru + Berubah',  desc: 'created & modified' },
        { label: 'Hanya baru',      desc: 'created only' },
        { label: 'Hanya berubah',   desc: 'modified only' },
        { label: 'Semua',           desc: 'all' },
      ]);
      const evtMap = [['created','modified'], ['created'], ['modified'], ['all']];
      trigger = { type: 'file', path: watchPath, events: evtMap[evtIdx ?? 0] };
    } else if (triggerIdx === 4) {
      const webhookId = (await ask(' Webhook ID (default = workflow id): ')).trim() || null;
      const secret    = (await ask(' Secret header (kosong = tidak ada): ')).trim() || null;
      trigger = { type: 'webhook', webhookId: webhookId || undefined, secret: secret || undefined };
    } else if (triggerIdx === 5) {
      const grpJid    = (await ask(' JID grup (kosong = semua grup tenant): ')).trim() || null;
      const actIdx    = await ui.selectMenu('Event yang dipantau:', [
        { label: 'Join & Leave',  desc: 'add & remove' },
        { label: 'Hanya join',   desc: 'add only' },
        { label: 'Hanya leave',  desc: 'remove only' },
        { label: 'Semua',        desc: 'add/remove/promote/demote' },
      ]);
      const actMap = [['add','remove'], ['add'], ['remove'], ['add','remove','promote','demote']];
      trigger = { type: 'wa.group_event', jid: grpJid || undefined, actions: actMap[actIdx ?? 0] };
    }

    // Node wizard
    const nodes = [];
    println('\nTambah node satu per satu. Kosongkan ID untuk selesai.\n');

    const NODE_MENU = [
      { label: 'wa.send',       desc: 'Kirim pesan ke chat sumber' },
      { label: 'wa.send_to',    desc: 'Kirim pesan ke JID tertentu' },
      { label: 'ai.call',       desc: 'Panggil AI dengan prompt' },
      { label: 'http.request',  desc: 'HTTP GET/POST ke URL eksternal' },
      { label: 'shell',         desc: 'Jalankan perintah OS (butuh sandbox on)' },
      { label: 'wa.read_group', desc: 'Baca N pesan terakhir dari grup' },
      { label: 'transform',     desc: 'Transformasi output dengan ekspresi JS' },
      { label: 'json.extract',  desc: 'Ambil field dari JSON output' },
      { label: 'condition',     desc: 'Percabangan if/else' },
      { label: 'loop',          desc: 'Iterasi array, jalankan body per item' },
      { label: 'repeat',        desc: 'Ulangi body chain N kali' },
      { label: 'parallel',      desc: 'Jalankan beberapa branch bersamaan' },
      { label: 'workflow.run',  desc: 'Panggil workflow lain sebagai sub-workflow' },
      { label: 'delay',         desc: 'Tunggu N detik' },
      { label: 'memory.read',   desc: 'Baca riwayat percakapan' },
      { label: 'memory.write',  desc: 'Simpan fakta ke LTM' },
      { label: 'set',           desc: 'Set variabel konteks' },
      { label: 'log',           desc: 'Log ke CLI (debug)' },
      { label: 'Selesai',       desc: 'Tidak ada node lagi' },
    ];
    const NODE_TYPES = NODE_MENU.slice(0, -1).map(n => n.label);

    while (true) {
      const nodeTypeIdx = await ui.selectMenu('NODE — Pilih tipe', NODE_MENU);
      if (nodeTypeIdx === null || nodeTypeIdx === NODE_MENU.length - 1) break;

      const nodeType = NODE_TYPES[nodeTypeIdx];

      const nodeId = (await ask(` ID node (default: node${nodes.length + 1}): `)).trim()
        || `node${nodes.length + 1}`;

      const node = { id: nodeId, type: nodeType, config: {} };

      if (nodeType === 'wa.send') {
        node.config.text = await ask(' Teks pesan (gunakan {{lastOutput}}): ');
      } else if (nodeType === 'wa.send_to') {
        node.config.jid  = await ask(' JID tujuan (contoh: 628xxx@s.whatsapp.net): ');
        node.config.text = await ask(' Teks pesan: ');
      } else if (nodeType === 'ai.call') {
        node.config.prompt = await ask(' Prompt (gunakan {{message}} untuk teks WA): ');
        node.config.system = (await ask(' System prompt (kosong = default Bima): ')).trim() || undefined;
      } else if (nodeType === 'http.request') {
        node.config.url     = await ask(' URL (gunakan {{lastOutput}} untuk dinamis): ');
        const methodIdx     = await ui.selectMenu('Method', [
          { label: 'GET' }, { label: 'POST' }, { label: 'PUT' }, { label: 'DELETE' },
        ]);
        node.config.method  = ['GET', 'POST', 'PUT', 'DELETE'][methodIdx ?? 0];
        if (node.config.method !== 'GET') {
          const body = (await ask(' Body JSON (kosong = tidak ada): ')).trim();
          if (body) node.config.body = body;
        }
        const extract = (await ask(' Extract path dari response (contoh: data.name, kosong = semua): ')).trim();
        if (extract) node.config.extract = extract;
      } else if (nodeType === 'shell') {
        node.config.cmd     = await ask(' Perintah OS (contoh: echo {{message}}): ');
        node.config.timeout = parseInt(await ask(' Timeout detik (default 10): ')) || 10;
      } else if (nodeType === 'wa.read_group') {
        node.config.jid   = (await ask(' JID grup (kosong = grup sumber): ')).trim() || undefined;
        node.config.limit = parseInt(await ask(' Jumlah pesan (default 10): ')) || 10;
      } else if (nodeType === 'transform') {
        println(' Ekspresi JS — input tersedia sebagai variabel `input`');
        println(' Contoh: input.toUpperCase()  |  input.split(",").length');
        node.config.expr     = await ask(' Ekspresi: ');
        const inputVar       = (await ask(' Nama variabel input (kosong = lastOutput): ')).trim();
        if (inputVar) node.config.inputVar = inputVar;
      } else if (nodeType === 'json.extract') {
        node.config.path = await ask(' Path JSON (contoh: data.items.0.name): ');
      } else if (nodeType === 'condition') {
        node.config.expr = await ask(' Ekspresi (contoh: lastOutput.includes("ya")): ');
        const trueNext   = (await ask(' Node jika TRUE (kosong = stop): ')).trim();
        const falseNext  = (await ask(' Node jika FALSE (kosong = stop): ')).trim();
        node.branches = { true: trueNext || null, false: falseNext || null };
      } else if (nodeType === 'loop') {
        println(' Loop iterasi array. Body chain = rangkaian node yg dijalankan per item.');
        node.config.items     = (await ask(' Variabel/ekspresi array (contoh: {{lastOutput}}): ')).trim();
        node.config.itemVar   = (await ask(' Nama variabel item (default: item): ')).trim() || 'item';
        node.config.body      = (await ask(' ID node pertama body chain: ')).trim();
        node.config.maxIterations = parseInt(await ask(' Maks iterasi (default 20): ')) || 20;
      } else if (nodeType === 'repeat') {
        node.config.times = parseInt(await ask(' Berapa kali diulang: ')) || 2;
        node.config.body  = (await ask(' ID node pertama body chain: ')).trim();
      } else if (nodeType === 'parallel') {
        println(' Parallel menjalankan beberapa branch bersamaan, menunggu semua selesai.');
        const rawBranches = (await ask(' ID node awal setiap branch (pisah koma): ')).trim();
        node.config.branches = rawBranches.split(',').map(s => s.trim()).filter(Boolean);
      } else if (nodeType === 'workflow.run') {
        node.config.workflowId = (await ask(' ID workflow yang dipanggil: ')).trim();
        node.config.input = (await ask(' Input ke sub-workflow (kosong = lastOutput): ')).trim() || undefined;
      } else if (nodeType === 'delay') {
        node.config.seconds = parseInt(await ask(' Detik: ')) || 1;
      } else if (nodeType === 'memory.write') {
        node.config.content = await ask(' Konten fakta (gunakan {{lastOutput}}): ');
      } else if (nodeType === 'set') {
        node.config.key   = await ask(' Nama variabel: ');
        node.config.value = await ask(' Nilai (gunakan {{lastOutput}}): ');
      } else if (nodeType === 'log') {
        node.config.text = await ask(' Teks log: ');
      }

      const onErrIdx = await ui.selectMenu('Jika node ini gagal:', [
        { label: 'Stop workflow',   desc: 'Hentikan seluruh workflow (default)' },
        { label: 'Lanjut ke next',  desc: 'Abaikan error, lanjut ke node berikutnya' },
      ]);
      if (onErrIdx === 1) node.onError = 'continue';

      nodes.push(node);
      println(`  ✓ Node "${nodeId}" [${nodeType}] ditambahkan.`);
    }

    // Wire next pointers (sequential by default for non-condition nodes)
    for (let i = 0; i < nodes.length - 1; i++) {
      if (nodes[i].type !== 'condition' && !nodes[i].next) {
        nodes[i].next = nodes[i + 1].id;
      }
    }

    try {
      const wf = createWorkflow(_currentTenant, {
        id, name, description: desc, trigger, nodes, entry: nodes[0]?.id || null,
      });
      let out = `\n✓ Workflow "${wf.id}" berhasil dibuat!\n`;
      out += `  Node  : ${nodes.length}\n`;
      out += `  Trigger: ${JSON.stringify(trigger)}\n`;
      out += `  Status: nonaktif\n\n`;
      out += `Aktifkan: /workflow enable ${wf.id}\n`;
      out += `Jalankan: /workflow run ${wf.id}`;
      println(out);
    } catch (e) {
      println(`✗ Gagal: ${e.message}`);
    }
    return;
  }

  // ── ai — build workflow from NL description ──────────────
  if (sub === 'ai') {
    const desc = args.slice(1).join(' ').trim();
    if (!desc) {
      println('Contoh: /workflow ai "kirim rekap harga BTC setiap jam ke grup"');
      return;
    }

    println(`⏳ AI sedang membuat workflow...\n"${desc.slice(0, 80)}"`);
    try {
      const { buildWorkflowFromDescription, formatWorkflowSummary } = require('./workflow_ai');
      const { wf, raw } = await buildWorkflowFromDescription(desc, _currentTenant);

      println('─'.repeat(50) + formatWorkflowSummary(wf) + '─'.repeat(50));

      const choice = await ui.selectMenu('Simpan workflow ini?', [
        { label: 'Simpan',         desc: `Simpan sebagai "${wf.id}" (nonaktif)` },
        { label: 'Simpan + aktif', desc: 'Simpan langsung aktifkan' },
        { label: 'Edit ID/nama',   desc: 'Ganti ID atau nama sebelum simpan' },
        { label: 'Batalkan',       desc: 'Buang workflow ini' },
      ]);

      if (choice === null || choice === 3) { println('Dibatalkan.'); return; }

      if (choice === 2) {
        const newId   = (await ask(` ID baru (sekarang: ${wf.id}): `)).trim() || wf.id;
        const newName = (await ask(` Nama baru (sekarang: ${wf.name}): `)).trim() || wf.name;
        wf.id   = newId.replace(/\s+/g, '_');
        wf.name = newName;
      }

      // Check duplicate
      const existing = getWorkflow(_currentTenant, wf.id);
      if (existing) {
        const overwrite = (await ask(` ! Workflow "${wf.id}" sudah ada. Timpa? (y/N): `)).trim().toLowerCase();
        if (overwrite !== 'y' && overwrite !== 'ya') { println('Dibatalkan.'); return; }
      }

      wf.tenant = _currentTenant;
      saveWorkflow(_currentTenant, wf);

      if (choice === 1) {
        wf.enabled = true;
        saveWorkflow(_currentTenant, wf);
        activateTriggers(_currentTenant, wf, { _tenantId: _currentTenant }, log);
        println(`✓ Workflow "${wf.id}" disimpan & aktif.`);
      } else {
        println(`✓ Workflow "${wf.id}" disimpan (nonaktif).\nAktifkan: /workflow enable ${wf.id}`);
      }
    } catch (e) {
      println(`✗ AI error: ${e.message}`);
    }
    return;
  }

  // ── refine — improve existing workflow via AI ─────────────
  if (sub === 'refine') {
    const id   = args[1];
    const inst = args.slice(2).join(' ').trim();
    if (!id || !inst) {
      println('Contoh: /workflow refine btc_alert "tambahkan delay 5 detik sebelum kirim"');
      return;
    }
    const existing = getWorkflow(_currentTenant, id);
    if (!existing) { println(`✗ Workflow "${id}" tidak ada.`); return; }

    println(`⏳ AI sedang memodifikasi workflow "${id}"...`);
    try {
      const { refineWorkflow, formatWorkflowSummary } = require('./workflow_ai');
      const { wf } = await refineWorkflow(existing, inst, _currentTenant);

      println('─'.repeat(50) + formatWorkflowSummary(wf) + '─'.repeat(50));

      const confirm = (await ask(' Simpan perubahan ini? (y/N): ')).trim().toLowerCase();
      if (confirm !== 'y' && confirm !== 'ya') { println('Dibatalkan.'); return; }

      saveWorkflow(_currentTenant, wf);
      println(`✓ Workflow "${id}" diperbarui.`);
    } catch (e) {
      println(`✗ Refine error: ${e.message}`);
    }
    return;
  }

  // ── template — browse + install templates ────────────────
  if (sub === 'template') {
    const { listTemplates, getTemplate, installTemplate } = require('./workflow_templates');
    const tsub = args[1];

    if (!tsub || tsub === 'list') {
      const tmpls = listTemplates();
      let out = `TEMPLATE — ${tmpls.length} workflow siap pakai\n` + '─'.repeat(54) + '\n';
      tmpls.forEach((t, i) => {
        out += `  ${i + 1}. ${t.name}\n`;
        out += `     ${t.description}\n`;
        out += `     ID: ${t.id}  Tags: ${t.tags.join(', ')}\n\n`;
      });
      out += '─'.repeat(54) + '\nInstall: /workflow template install <template-id>';
      println(out);
      return;
    }

    if (tsub === 'install') {
      const tmpls  = listTemplates();
      let tmplId   = args[2];

      // Interactive picker if no ID given
      if (!tmplId) {
        const pick = await ui.selectMenu('TEMPLATE — Pilih workflow', tmpls.map(t => ({
          label: t.name,
          desc:  t.description.slice(0, 60),
        })));
        if (pick === null) { println('Dibatalkan.'); return; }
        tmplId = tmpls[pick].id;
      }

      const tmpl = getTemplate(tmplId);
      if (!tmpl) { println(`✗ Template "${tmplId}" tidak ditemukan.`); return; }

      println(`\nTemplate: ${tmpl.name}\n${tmpl.description}\nTags: ${tmpl.tags.join(', ')}\n`);

      // Collect template-specific variables
      const vars = {};
      if (tmplId === 'weather_report' || tmplId === 'multi_city_weather') {
        if (tmplId === 'weather_report') {
          vars.city = (await ask(' Nama kota (default: Jakarta): ')).trim() || 'Jakarta';
        } else {
          const raw = (await ask(' Daftar kota pisah koma (default: Jakarta,Surabaya,Bandung): ')).trim();
          vars.cities = raw ? raw.split(',').map(s => s.trim()) : undefined;
        }
      } else if (tmplId === 'ai_auto_reply') {
        vars.keyword = (await ask(' Keyword trigger (default: tanya bima): ')).trim() || 'tanya bima';
      } else if (tmplId === 'web_monitor') {
        vars.url = (await ask(' URL yang dipantau: ')).trim();
      } else if (tmplId === 'file_to_wa') {
        vars.path = (await ask(' Path folder yang dipantau (default: ~/bima-inbox): ')).trim() || '~/bima-inbox';
      }

      const newId = (await ask(` ID workflow (default: ${tmplId}): `)).trim() || tmplId;

      try {
        const wf = installTemplate(tmplId, _currentTenant, newId, vars);
        const { renderWorkflow } = require('./workflow_view');
        println(renderWorkflow(wf));
        println(`✓ Template "${wf.name}" berhasil diinstall sebagai "${wf.id}" (nonaktif).`);
        println(`Aktifkan: /workflow enable ${wf.id}`);
      } catch (e) {
        println(`✗ Gagal install: ${e.message}`);
      }
      return;
    }

    println('Subcommand: template list | template install [id]');
    return;
  }

  // ── export — save workflow to JSON file ───────────────────
  if (sub === 'export') {
    const id   = args[1];
    const file = args[2];
    if (!id) { println('Contoh: /workflow export <id> [file.json]'); return; }
    const wf = getWorkflow(_currentTenant, id);
    if (!wf) { println(`✗ Workflow "${id}" tidak ada.`); return; }

    const outPath = file
      ? path.resolve(file)
      : path.join(os.homedir(), `bima_workflow_${id}.json`);

    try {
      fs.writeFileSync(outPath, JSON.stringify(wf, null, 2));
      println(`✓ Workflow "${id}" diekspor ke:\n  ${outPath}`);
    } catch (e) {
      println(`✗ Gagal ekspor: ${e.message}`);
    }
    return;
  }

  // ── import — load workflow from JSON file or URL ──────────
  if (sub === 'import') {
    const source = args[1];
    if (!source) { println('Contoh: /workflow import <file.json>\n        /workflow import https://...'); return; }

    println(`⏳ Mengimpor dari: ${source}`);
    let raw;
    try {
      if (source.startsWith('http://') || source.startsWith('https://')) {
        const res = await fetch(source, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.text();
      } else {
        const p = path.resolve(source);
        if (!fs.existsSync(p)) throw new Error(`File tidak ditemukan: ${p}`);
        raw = fs.readFileSync(p, 'utf8');
      }
    } catch (e) {
      println(`✗ Gagal baca sumber: ${e.message}`);
      return;
    }

    let wf;
    try { wf = JSON.parse(raw); }
    catch (e) { println(`✗ JSON tidak valid: ${e.message}`); return; }

    // Validate
    try {
      const { validateWorkflow } = require('./workflow_ai');
      validateWorkflow(wf);
    } catch (e) {
      println(`⚠ Validasi gagal: ${e.message}\nLanjutkan tetap? (y/N)`);
      const cont = (await ask('')).trim().toLowerCase();
      if (cont !== 'y' && cont !== 'ya') { println('Dibatalkan.'); return; }
    }

    // Show preview
    const { renderWorkflow } = require('./workflow_view');
    println(renderWorkflow(wf));

    // Check duplicate
    const existing = getWorkflow(_currentTenant, wf.id);
    if (existing) {
      const overwrite = (await ask(` ! Workflow "${wf.id}" sudah ada. Timpa? (y/N): `)).trim().toLowerCase();
      if (overwrite !== 'y' && overwrite !== 'ya') {
        const newId = (await ask(' ID baru: ')).trim();
        if (!newId) { println('Dibatalkan.'); return; }
        wf.id = newId;
      }
    }

    wf.tenant    = _currentTenant;
    wf.enabled   = false;
    wf.updatedAt = Date.now();
    if (!wf.createdAt) wf.createdAt = Date.now();

    saveWorkflow(_currentTenant, wf);
    println(`✓ Workflow "${wf.id}" berhasil diimport (nonaktif).\nAktifkan: /workflow enable ${wf.id}`);
    return;
  }

  // ── clone — duplicate workflow ────────────────────────────
  if (sub === 'clone') {
    const srcId = args[1];
    const dstId = args[2];
    if (!srcId) { println('Contoh: /workflow clone <id-asal> <id-baru>'); return; }

    const src = getWorkflow(_currentTenant, srcId);
    if (!src) { println(`✗ Workflow "${srcId}" tidak ada.`); return; }

    const newId = dstId || (srcId + '_copy');
    if (getWorkflow(_currentTenant, newId)) {
      println(`✗ Workflow "${newId}" sudah ada. Pilih ID lain.`); return;
    }

    const clone = {
      ...JSON.parse(JSON.stringify(src)), // deep copy
      id:        newId,
      enabled:   false,
      tenant:    _currentTenant,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveWorkflow(_currentTenant, clone);
    println(`✓ Workflow "${srcId}" dikloning ke "${newId}" (nonaktif).`);
    return;
  }

  // ── history — show past runs ─────────────────────────────
  if (sub === 'history') {
    const id    = args[1];
    const limit = parseInt(args[2]) || 15;
    if (!id) { println('Contoh: /workflow history <id> [jumlah]'); return; }

    const { getRunHistory, getRunStats } = require('./workflow');
    const runs  = getRunHistory(_currentTenant, id, limit);
    const stats = getRunStats(_currentTenant, id);

    if (!runs.length) { println(`Belum ada riwayat run untuk "${id}".`); return; }

    let out = `HISTORY — ${id}  (${runs.length} run terakhir)\n` + '─'.repeat(54) + '\n';

    if (stats) {
      out += `  Total: ${stats.total}  ✓ ${stats.success}  ✗ ${stats.failed}`;
      out += `  Success: ${stats.successRate}%  Avg: ${stats.avgMs}ms\n`;
      out += '─'.repeat(54) + '\n';
    }

    runs.forEach(r => {
      const date = new Date(r.startedAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
      const icon = r.ok ? '✓' : '✗';
      const trg  = r.trigger ? `[${r.trigger}]` : '';
      out += `  ${icon} ${date}  ${r.durationMs}ms  ${trg}`;
      if (!r.ok && r.failedNode) out += `  node: ${r.failedNode}`;
      if (!r.ok && r.error)      out += `\n    ! ${r.error.slice(0, 80)}`;
      out += '\n';
    });

    out += '─'.repeat(54);
    println(out);
    return;
  }

  // ── stats — success rate + monitoring overview ────────────
  if (sub === 'stats') {
    const { getRunStats } = require('./workflow');
    const workflows = listWorkflows(_currentTenant);

    if (!workflows.length) { println('Belum ada workflow.'); return; }

    let out = `STATS — ${workflows.length} workflow\n` + '─'.repeat(54) + '\n';
    out += `  ${'ID'.padEnd(22)} ${'Status'.padEnd(10)} ${'Runs'.padEnd(6)} ${'OK%'.padEnd(6)} ${'AvgMs'}\n`;
    out += '  ' + '─'.repeat(50) + '\n';

    for (const wf of workflows) {
      const st    = wf.enabled ? '● aktif' : '○ off';
      const stats = getRunStats(_currentTenant, wf.id);
      if (!stats) {
        out += `  ${wf.id.padEnd(22)} ${st.padEnd(10)} ${'—'.padEnd(6)} ${'—'.padEnd(6)} —\n`;
      } else {
        out += `  ${wf.id.padEnd(22)} ${st.padEnd(10)} ${String(stats.total).padEnd(6)} ${(stats.successRate + '%').padEnd(6)} ${stats.avgMs}ms\n`;
      }
    }

    out += '─'.repeat(54);
    println(out);
    return;
  }

  // ── sandbox — toggle shell execution ─────────────────────
  if (sub === 'sandbox') {
    const val = args[1];
    if (!val) {
      const cfg = getConfig(_currentTenant);
      println(`Sandbox: ${cfg.sandboxEnabled ? '● aktif' : '○ nonaktif'}\nToggle: /workflow sandbox on|off`);
      return;
    }
    if (val === 'on') {
      saveConfig({ sandboxEnabled: true }, _currentTenant);
      println('✓ Sandbox aktif — node shell dapat menjalankan perintah OS.\n! Pastikan workflow dari sumber terpercaya!');
    } else if (val === 'off') {
      saveConfig({ sandboxEnabled: false }, _currentTenant);
      println('✓ Sandbox dinonaktifkan.');
    } else {
      println('Contoh: /workflow sandbox on  atau  /workflow sandbox off');
    }
    return;
  }

  println('Subcommand:\n  list | view <id> | run <id> [input] | info <id>\n  history <id> [n] | stats\n  enable <id> | disable <id> | del <id>\n  create | ai "<deskripsi>" | refine <id> "<instruksi>"\n  template list|install [id]\n  export <id> [file] | import <file|url> | clone <id> [new-id]\n  sandbox on|off');
}

// ══════════════════════════════════════════════════════════════
//  /compact
// ══════════════════════════════════════════════════════════════
async function cmdCompact() {
  const docs = getKnowledge(_currentTenant);
  const cfg  = getConfig(_currentTenant);

  if (!docs.length) { println('! Tidak ada dokumen untuk dikompres.'); return; }
  if (!cfg.provider || !cfg.apiKey) { println('✗ Set AI dulu via /model.'); return; }

  const modeIdx = await ui.selectMenu('COMPACT — Pilih Mode', [
    { label: 'Semua dokumen',        desc: `${docs.length} dokumen` },
    { label: 'Pilih dokumen tertentu', desc: 'pilih satu per satu' },
  ]);
  if (modeIdx === null) { println('Dibatalkan.'); return; }

  let targets = [];
  if (modeIdx === 0) {
    targets = docs;
  } else {
    const docItems = docs.map(d => ({ label: d.file, desc: d.timestamp?.slice(0, 10) || '' }));
    const pick = await ui.selectMenu('COMPACT — Pilih Dokumen', docItems);
    if (pick === null) { println('Dibatalkan.'); return; }
    targets = [docs[pick]];
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
  const sttItems = [
    { label: 'Lokal (Whisper)',      desc: 'offline, gratis, ~75MB — RECOMMENDED' },
    { label: 'Groq Whisper',         desc: 'online, gratis 7200 mnt/hari, cepat' },
    { label: 'HuggingFace',          desc: 'online, multilingual-asr' },
    { label: 'OpenAI Whisper',       desc: 'online, berbayar' },
    { label: 'Pakai AI key saat ini', desc: `${cfg.provider || '?'} — hanya jika OpenAI` },
  ];
  const sttIdx = await ui.selectMenu('STT — Konfigurasi Voice Note', sttItems);
  if (sttIdx === null) { println('Dibatalkan.'); return; }
  const choice = String(sttIdx + 1);

  if (choice === '1') {
    const whisperItems = [
      { label: 'whisper-tiny',  desc: '75MB, ~1-2 detik/pesan — default' },
      { label: 'whisper-base',  desc: '145MB, lebih akurat' },
      { label: 'whisper-small', desc: '290MB, terbaik untuk Indonesia' },
    ];
    const mIdx = await ui.selectMenu('STT — Pilih Model Whisper', whisperItems);
    const models = ['Xenova/whisper-tiny', 'Xenova/whisper-base', 'Xenova/whisper-small'];
    const sttModel = models[mIdx ?? 0];
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
    println(out);

    const grpIdx = await ui.selectMenu(`TENANT ${id} — Tambah Grup`,
      groups.map(g => ({ label: g.name, desc: current.has(g.id) ? '✓ aktif' : '' }))
    );
    if (grpIdx !== null) {
      const picked = groups[grpIdx];
      const merged = [...new Set([...current, picked.id])];
      updateTenant(id, { groupJids: merged });
      println(`✓ Grup "${picked.name}" ditambahkan ke tenant "${id}".`);
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
//  /watch — topic watcher
// ══════════════════════════════════════════════════════════════
async function cmdWatch(args) {
  const { addWatch, removeWatch, listWatches } = require('./watcher');
  const sub = args[0];

  if (!sub || sub === 'list') {
    const watches = listWatches(_currentTenant);
    let out = `WATCH — ${watches.length} topik dipantau\n` + '─'.repeat(40) + '\n';
    if (!watches.length) {
      out += 'Belum ada topik. Gunakan: /watch add <topik> [jam]\n';
      out += 'Contoh: /watch add "harga bbm" 6\n';
    } else {
      watches.forEach((w, i) => {
        const last = w.lastCheck ? new Date(w.lastCheck).toLocaleString('id-ID') : 'belum dicek';
        out += `  ${i + 1}. [${w.id}] ${w.topic}\n`;
        out += `     Interval: ${w.intervalHours}j | Terakhir: ${last}\n`;
        out += `     Grup: ${w.jid}\n`;
      });
      out += '\nHapus: /watch del <id>';
    }
    out += '\n' + '─'.repeat(40);
    println(out);
    return;
  }

  if (sub === 'add') {
    const wa = getWAStatus();
    if (!wa.connected) { println('! WA belum terhubung. Jalankan /wa dulu.'); return; }

    const groups = wa.groups || [];
    if (!groups.length) { println('! Belum ada grup ditemukan.'); return; }

    // Topic
    const rawTopic = args.slice(1).join(' ').replace(/["']/g, '').trim();
    const topic = rawTopic || (await ask(' Topik yang dipantau: ')).trim();
    if (!topic) { println('✗ Topik tidak boleh kosong.'); return; }

    // Interval
    const lastArg = parseInt(args[args.length - 1]);
    const interval = (!isNaN(lastArg) && lastArg !== parseInt(topic)) ? lastArg : null;
    const hours = interval || parseInt((await ask(' Interval pengecekan (jam, Enter=6): ')).trim() || '6');

    // Target group
    const grpIdx = await ui.selectMenu('WATCH — Pilih Grup Notifikasi',
      groups.map(g => ({ label: g.name, desc: g.id.split('@')[0] }))
    );
    if (grpIdx === null) { println('Dibatalkan.'); return; }
    const grp = groups[grpIdx];

    const id = addWatch(_currentTenant, grp.id, topic, hours);
    println(`✓ Watch ditambahkan!\n  ID: ${id}\n  Topik: ${topic}\n  Interval: ${hours} jam\n  Notif ke: ${grp.name}`);
    return;
  }

  if (sub === 'del' || sub === 'remove') {
    const id = args[1];
    if (!id) { println('Contoh: /watch del abc123'); return; }
    const ok = removeWatch(_currentTenant, id);
    println(ok ? `✓ Watch ${id} dihapus.` : `✗ Watch ${id} tidak ditemukan.`);
    return;
  }

  println('Subcommand: list | add <topik> [jam] | del <id>');
}

// ══════════════════════════════════════════════════════════════
//  /profiles — member profiles
// ══════════════════════════════════════════════════════════════
function cmdProfiles(args) {
  const { getAllProfiles, deleteProfile } = require('./profiles');

  if (args[0] === 'del') {
    const jid = args[1];
    if (!jid) { println('Contoh: /profiles del 628xxx'); return; }
    const ok = deleteProfile(_currentTenant, jid);
    println(ok ? `✓ Profil ${jid} dihapus.` : '✗ Profil tidak ditemukan.');
    return;
  }

  const profiles = getAllProfiles(_currentTenant);
  let out = `PROFILES — ${profiles.length} member\n` + '─'.repeat(40) + '\n';

  if (!profiles.length) {
    out += 'Belum ada profil. Profil dibuat otomatis saat member berinteraksi dengan Bima.';
  } else {
    profiles.slice(0, 20).forEach((p, i) => {
      const last = p.lastSeen ? p.lastSeen.slice(0, 10) : '?';
      out += `  ${i + 1}. ${p.name} (${p.jid?.split('@')[0] || '?'})\n`;
      out += `     ${p.messageCount}x chat | Terakhir: ${last}\n`;
      if (p.topics?.length) out += `     Topik: ${p.topics.slice(0, 4).join(', ')}\n`;
    });
    if (profiles.length > 20) out += `  ... dan ${profiles.length - 20} lainnya\n`;
    out += '\nHapus: /profiles del <jid>';
  }

  out += '\n' + '─'.repeat(40);
  println(out);
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
//  /tg — Telegram bot management
// ══════════════════════════════════════════════════════════════
async function cmdTelegram(args) {
  const { getTelegramStatus, startTelegram, stopTelegram } = require('./telegram');
  const sub = args[0];

  if (!sub || sub === 'status') {
    const st  = getTelegramStatus();
    const cfg = getConfig(_currentTenant);
    let out   = 'TELEGRAM — Status Bot\n' + '─'.repeat(40) + '\n';
    out += st.connected
      ? `  ● Terhubung  @${st.username} (${st.name})\n`
      : `  ○ Belum terhubung\n`;
    if (cfg.telegramToken) out += `  Token: ***${cfg.telegramToken.slice(-8)}\n`;
    else out += `  Token: belum diset\n`;
    out += '\nSubcommand: status | token <BOT_TOKEN> | start | stop\n';
    out += 'Dapatkan token dari @BotFather di Telegram.\n';
    out += '─'.repeat(40);
    println(out);
    return;
  }

  if (sub === 'token') {
    const token = args[1];
    if (!token) { println('Contoh: /tg token 123456789:ABCdefGHI...'); return; }
    saveConfig({ telegramToken: token }, _currentTenant);
    println('✓ Token Telegram disimpan.\nGunakan /tg start untuk mengaktifkan bot.');
    return;
  }

  if (sub === 'start') {
    const cfg = getConfig(_currentTenant);
    if (!cfg.telegramToken) {
      println('! Token belum diset.\nContoh: /tg token 123456789:ABCdefGHI...\nDapatkan token dari @BotFather di Telegram.');
      return;
    }
    println('⏳ Menghubungkan bot Telegram...');
    try {
      await startTelegram(cfg.telegramToken, log);
      const st = getTelegramStatus();
      println(`✓ Bot aktif!\n  Username: @${st.username}\n  Nama    : ${st.name}`);
      ui.updateStatus({ provider: getConfig(_currentTenant).provider, model: getConfig(_currentTenant).model, waConnected: getWAStatus().connected, tenant: _currentTenant, tgConnected: true, tgUsername: st.username });
    } catch (e) {
      println(`✗ Gagal start Telegram: ${e.message}`);
    }
    return;
  }

  if (sub === 'stop') {
    await stopTelegram();
    println('✓ Bot Telegram dihentikan.');
    ui.updateStatus({ provider: getConfig(_currentTenant).provider, model: getConfig(_currentTenant).model, waConnected: getWAStatus().connected, tenant: _currentTenant, tgConnected: false });
    return;
  }

  println('Subcommand: status | token <BOT_TOKEN> | start | stop');
}

// ══════════════════════════════════════════════════════════════
//  /api — REST API + Web Admin
// ══════════════════════════════════════════════════════════════
async function cmdApi(args) {
  const { startApi, stopApi, getApiStatus } = require('./api');
  const sub = args[0];

  if (!sub || sub === 'status') {
    const st = getApiStatus();
    if (st.running) {
      println(`REST API: berjalan di http://0.0.0.0:${st.port}\nAdmin Panel: http://localhost:${st.port}/\nAPI Key: ${st.hasKey ? '(aktif)' : '(tidak ada — akses terbuka)'}`);
    } else {
      println('REST API: tidak berjalan. Ketik /api start [port]');
    }
    return;
  }

  if (sub === 'start') {
    const st = getApiStatus();
    if (st.running) { println(`API sudah berjalan di port ${st.port}`); return; }
    const port   = parseInt(args[1], 10) || 3000;
    const cfg    = getConfig(_currentTenant);
    const apiKey = cfg.apiKey || null;
    try {
      await startApi({
        port,
        apiKey,
        getStatus: () => {
          const ws = getWAStatus();
          const tgMod = (() => { try { return require('./telegram'); } catch { return null; } })();
          const tgSt  = tgMod ? tgMod.getTelegramStatus() : {};
          return {
            waConnected: ws.connected,
            tgConnected: !!tgSt.running,
            tgUsername:  tgSt.username || null,
            provider:    cfg.provider,
            model:       cfg.model,
            tenant:      _currentTenant,
          };
        },
        sendMsg:   (jid, text) => sendWAMessage(jid, text),
        runQuery:  async (question, tenantId) => {
          const { runAgent } = require('./agent');
          const c = getConfig(tenantId || _currentTenant);
          return runAgent(question, [], c, '', null, tenantId || _currentTenant, null, 'api');
        },
        tenantId:  () => _currentTenant,
      });
      ui.log('API', `REST API berjalan di port ${port} — Admin: http://localhost:${port}/`);
      println(`✓ REST API aktif di http://localhost:${port}/\n  Admin Panel: http://localhost:${port}/\n  Kirim pesan via: POST http://localhost:${port}/api/send`);
      const cfgNow = getConfig(_currentTenant);
      cfgNow.apiPort = port;
      saveConfig(cfgNow, _currentTenant);
      ui.updateStatus({ provider: cfgNow.provider, model: cfgNow.model, tenant: _currentTenant, apiPort: port });
    } catch (e) {
      println(`✗ Gagal start API: ${e.message}`);
    }
    return;
  }

  if (sub === 'stop') {
    await stopApi();
    const cfgStop = getConfig(_currentTenant);
    delete cfgStop.apiPort;
    saveConfig(cfgStop, _currentTenant);
    ui.log('API', 'REST API dihentikan');
    println('✓ REST API dihentikan.');
    const cfgS = getConfig(_currentTenant);
    ui.updateStatus({ provider: cfgS.provider, model: cfgS.model, tenant: _currentTenant });
    return;
  }

  if (sub === 'key') {
    const newKey = args[1];
    if (!newKey) {
      const cfg = getConfig(_currentTenant);
      println(cfg.apiKey ? `API Key saat ini: ${cfg.apiKey}` : 'Belum ada API key. Ketik /api key <kunci>');
      return;
    }
    const cfg = getConfig(_currentTenant);
    cfg.apiKey = newKey;
    saveConfig(cfg, _currentTenant);
    println(`✓ API key disimpan: ${newKey}`);
    return;
  }

  println('Subcommand: status | start [port] | stop | key [nilai]');
}

// ══════════════════════════════════════════════════════════════
//  /polymarket
// ══════════════════════════════════════════════════════════════
async function cmdPolymarket(query) {
  const { searchMarkets, getTrendingMarkets } = require('./polymarket');
  log('INFO', query ? `Polymarket: "${query}"...` : 'Polymarket: trending...');
  try {
    const result = query ? await searchMarkets(query) : await getTrendingMarkets();
    println(result);
  } catch (e) {
    println(`✗ Error Polymarket: ${e.message}`);
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

  // Start nano sidecar (memory + guard + proxy) in background
  startNano(log).then(({ sidecar, proxy }) => {
    if (sidecar) ui.log('INFO', 'nano-memory & nano-guard aktif ✓');
    if (proxy)   ui.log('INFO', 'nano-proxy aktif ✓');
  }).catch(() => {});

  // Auto-start scheduled workflows
  setTimeout(() => {
    try {
      const { startScheduledWorkflows } = require('./workflow');
      const { listTenants: lT } = require('./tenant');
      const allTenants = lT().map(t => t.id);
      if (!allTenants.includes('default')) allTenants.push('default');
      let total = 0;
      for (const tid of allTenants) {
        total += startScheduledWorkflows(tid, { _tenantId: tid }, log);
      }
      if (total > 0) ui.log('WF', `${total} workflow terjadwal aktif ✓`);
    } catch {}
  }, 4000);

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

  // Auto-start Telegram if token configured
  const tgToken = getConfig(_currentTenant).telegramToken;
  if (tgToken) {
    setTimeout(async () => {
      try {
        const { startTelegram, getTelegramStatus } = require('./telegram');
        await startTelegram(tgToken, log);
        const st = getTelegramStatus();
        ui.updateStatus({ provider: cfg.provider, model: cfg.model, waConnected: false, tenant: _currentTenant, tgConnected: true, tgUsername: st.username });
      } catch (e) {
        ui.log('TG', `Auto-start gagal: ${e.message}`);
      }
    }, 2000);
  } else {
    ui.log('TG', 'Token belum diset. Gunakan /tg token <TOKEN> lalu /tg start.');
  }

  // Auto-start REST API if port configured
  const apiPort = getConfig(_currentTenant).apiPort;
  if (apiPort) {
    setTimeout(() => cmdApi(['start', String(apiPort)]), 1500);
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
      else if (line === '/contacts')       { await cmdContacts(); }
      else if (line === '/blacklist' || line.startsWith('/blacklist ')) {
        const parts = line.slice(10).trim().split(/\s+/).filter(Boolean);
        cmdBlacklist(parts);
      }
      else if (line === '/workflow' || line.startsWith('/workflow ')) {
        const parts = line.slice(9).trim().split(/\s+/).filter(Boolean);
        await cmdWorkflow(parts);
      }
      else if (line === '/compact')        { await cmdCompact(); }
      else if (line === '/stt')            { await cmdSTT(); }
      else if (line === '/watch' || line.startsWith('/watch ')) {
        const parts = line.slice(6).trim().split(/\s+/).filter(Boolean);
        await cmdWatch(parts);
      }
      else if (line === '/profiles' || line.startsWith('/profiles ')) {
        const parts = line.slice(9).trim().split(/\s+/).filter(Boolean);
        cmdProfiles(parts);
      }
      else if (line === '/tts' || line.startsWith('/tts ')) {
        const parts = line.slice(4).trim().split(/\s+/).filter(Boolean);
        cmdTTS(parts);
      }
      else if (line === '/memory')         { cmdMemory(); }
      else if (line === '/reminder')       { cmdReminder(); }
      else if (line === '/ltm')            { cmdLTM(); }
      else if (line.startsWith('/ltm del ')){ cmdLTMDelete(line.slice(9).trim()); }
      else if (line.startsWith('/search ')) { await cmdSearch(line.slice(8).trim()); }
      else if (line === '/polymarket' || line.startsWith('/polymarket ')) { await cmdPolymarket(line.slice(12).trim()); }
      else if (line === '/api' || line.startsWith('/api ')) {
        const parts = line.slice(4).trim().split(/\s+/).filter(Boolean);
        await cmdApi(parts);
      }
      else if (line === '/tg' || line.startsWith('/tg ')) {
        const parts = line.slice(3).trim().split(/\s+/).filter(Boolean);
        await cmdTelegram(parts);
      }
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
