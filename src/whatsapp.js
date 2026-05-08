'use strict';

const fs   = require('fs');
const path = require('path');

const os       = require('os');
const AUTH_DIR = process.env.BIMA_DATA
  ? path.join(process.env.BIMA_DATA, 'auth')
  : path.join(os.homedir(), '.bima', 'auth');

let sock              = null;
let botId             = '';
let botIdentities     = new Set();
let state             = { connected: false, groups: [] };
let logFn             = () => {};
let started           = false;
let watchdogTimer     = null;
let _reconnectAttempts = 0;

const msgStore = new Map();

// Reply chain: users bima recently replied to per group (5 min TTL)
const replyChain = new Map();
const CHAIN_TTL  = 5 * 60 * 1000;

// Pagination store: long answers split into pages
const pageStore  = new Map();
const PAGE_CHARS = 1200;
const PAGE_TTL   = 5 * 60 * 1000;

function storePage(jid, senderJid, pages) {
  pageStore.set(`${jid}::${senderJid}`, {
    pages, idx: 1, expiresAt: Date.now() + PAGE_TTL,
  });
}

function nextPage(jid, senderJid) {
  const key   = `${jid}::${senderJid}`;
  const entry = pageStore.get(key);
  if (!entry || Date.now() > entry.expiresAt) { pageStore.delete(key); return null; }
  if (entry.idx >= entry.pages.length) { pageStore.delete(key); return null; }
  const page = entry.pages[entry.idx];
  entry.idx++;
  if (entry.idx >= entry.pages.length) pageStore.delete(key);
  return { text: page, current: entry.idx, total: entry.pages.length };
}

function hasPendingPage(jid, senderJid) {
  const entry = pageStore.get(`${jid}::${senderJid}`);
  return entry && Date.now() <= entry.expiresAt;
}

function splitIntoPages(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const pages = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length > maxChars && current) {
      pages.push(current.trim());
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) pages.push(current.trim());
  return pages.length ? pages : [text];
}

async function sendPaged(jid, senderJid, text, quotedMsg) {
  const pages = splitIntoPages(text, PAGE_CHARS);
  if (pages.length === 1) {
    await sendMsg(jid, text, quotedMsg);
    return;
  }

  const total = pages.length;
  await sendMsg(jid, `${pages[0]}\n\n_(1/${total}) — ketik *lanjut* untuk halaman berikutnya_`, quotedMsg);
  storePage(jid, senderJid, pages);
}

// Pending confirmations for date-mismatch file requests
const pendingConfirm = new Map();
const CONFIRM_TTL    = 2 * 60 * 1000;

function setPendingConfirm(jid, senderJid, doc, msgRef) {
  pendingConfirm.set(`${jid}::${senderJid}`, {
    doc, msgRef, expiresAt: Date.now() + CONFIRM_TTL,
  });
}

function popPendingConfirm(jid, senderJid) {
  const key   = `${jid}::${senderJid}`;
  const entry = pendingConfirm.get(key);
  if (!entry) return null;
  pendingConfirm.delete(key);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

function addToChain(groupJid, senderJid) {
  if (!senderJid) return;
  if (!replyChain.has(groupJid)) replyChain.set(groupJid, new Map());
  replyChain.get(groupJid).set(senderJid, Date.now() + CHAIN_TTL);
}

function isInChain(groupJid, senderJid) {
  if (!senderJid) return false;
  const group = replyChain.get(groupJid);
  if (!group) return false;
  const exp = group.get(senderJid);
  if (!exp) return false;
  if (Date.now() > exp) { group.delete(senderJid); return false; }
  return true;
}

// ── Start / reconnect ──────────────────────────────────────────
async function startWA(logger) {
  if (started && state.connected) return;
  logFn   = logger || logFn;
  started = true;

  // Run migration once: move flat data/ → tenants/default/
  const { migrateDefault } = require('./tenant');
  const migrated = migrateDefault();
  if (migrated) logFn('WA', 'Migrasi data ke tenant default selesai.');

  let Baileys;
  try {
    Baileys = await import('@whiskeysockets/baileys');
  } catch (e) {
    logFn('ERROR', `Baileys error: ${e.message}. Run: npm install`);
    return;
  }

  const makeWASocket = Baileys.default;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = Baileys;

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const silentLogger = {
    level: 'silent',
    trace: () => {}, debug: () => {}, info: () => {},
    warn:  () => {}, error: () => {}, fatal: () => {},
    child: () => silentLogger,
  };

  const { init: initReminder } = require('./reminder');
  initReminder(
    async (jid, text) => sendMsg(jid, text),
    logFn
  );

  // Start topic watcher
  try {
    const { startWatcher } = require('./watcher');
    const { webSearch }    = require('./search');
    startWatcher(async (tenantId, jid, topic, summary) => {
      logFn('WATCH', `Change detected: "${topic}" → ${jid}`);
      await sendMsg(jid, summary);
    }, webSearch);
    logFn('INFO', 'Topic watcher aktif.');
  } catch (e) { logFn('DEBUG', `Watcher skip: ${e.message}`); }

  function connect() {
    sock = makeWASocket({
      version,
      auth:                authState,
      logger:              silentLogger,
      printQRInTerminal:   false,
      browser:             ['Bima', 'Chrome', '3.0'],
      syncFullHistory:     false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 15_000,
      retryRequestDelayMs: 500,
      maxMsgRetryCount:    5,
      getMessage: async (key) => msgStore.get(key.id)?.message || undefined,
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const qrcode = require('qrcode-terminal');
        console.log('\n');
        qrcode.generate(qr, { small: true });
        logFn('WA', 'Scan QR code di atas dengan WhatsApp kamu!');
      }

      if (connection === 'open') {
        state.connected = true;
        _reconnectAttempts = 0;
        const user = sock.user || {};
        const uid  = user.id || '';
        botId = uid.split(':')[0].split('@')[0];

        botIdentities = new Set();
        if (botId) botIdentities.add(botId);
        if (uid)   botIdentities.add(uid.split('@')[0]);
        const lid = user.lid || user.lidJid || '';
        if (lid) {
          botIdentities.add(lid.split(':')[0].split('@')[0]);
          botIdentities.add(lid.split('@')[0]);
        }

        const botName = user.name || 'Bima';
        logFn('WA', `Terhubung sebagai ${botName} | id=${botId} | lid=${lid || '-'}`);
        logFn('DEBUG', `Bot identities: ${[...botIdentities].join(', ')}`);
        await loadGroups();
      }

      if (connection === 'close') {
        state.connected = false;
        const code        = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = code === DisconnectReason.loggedOut;
        const isReplaced  = code === 440; // connectionReplaced — another device took session

        if (isLoggedOut) {
          logFn('WA', `Logout (${code}). Ketik /wa untuk scan QR ulang.`);
          _reconnectAttempts = 0;
          started = false;
        } else if (isReplaced) {
          logFn('WA', `Sesi digantikan perangkat lain (440). Ketik /wa untuk reconnect manual.`);
          _reconnectAttempts = 0;
          started = false;
        } else {
          _reconnectAttempts++;
          // Exponential backoff: 2s, 3s, 4.5s, 6.75s … capped at 30s
          const delay = Math.min(30_000, 2000 * Math.pow(1.5, _reconnectAttempts - 1));
          logFn('WA', `Koneksi terputus (${code || '?'}). Reconnect dalam ${Math.round(delay / 1000)}s... (percobaan ${_reconnectAttempts})`);
          setTimeout(connect, delay);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    let _groupReloadTimer = null;
    const scheduleGroupReload = () => {
      if (_groupReloadTimer) clearTimeout(_groupReloadTimer);
      _groupReloadTimer = setTimeout(() => loadGroups(), 2000);
    };
    sock.ev.on('groups.upsert',             scheduleGroupReload);
    sock.ev.on('groups.update',             scheduleGroupReload);
    sock.ev.on('group-participants.update', scheduleGroupReload);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.message) {
          msgStore.set(msg.key.id, msg);
          if (msgStore.size > 500) msgStore.delete(msgStore.keys().next().value);
        }
        await handleMsg(msg);
      }
    });
  }

  connect();

  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    if (!state.connected) return;
    try {
      await sock.sendPresenceUpdate('available');
    } catch {
      logFn('WA', 'Watchdog: zombie terdeteksi, reconnect...');
      state.connected = false;
      try { sock.end(); } catch {}
      connect();
    }
  }, 3 * 60 * 1000);
}

// ── Load group list ────────────────────────────────────────────
let _lastGroupLoad = 0;
async function loadGroups() {
  const now = Date.now();
  if (now - _lastGroupLoad < 10_000) return; // min 10s between loads
  _lastGroupLoad = now;
  try {
    const grps = await sock.groupFetchAllParticipating();
    state.groups = Object.values(grps).map(g => ({
      id:           g.id,
      name:         g.subject,
      participants: (g.participants || []).map(p => p.id),
    }));
    logFn('WA', `${state.groups.length} grup dimuat`);
  } catch {}
}

// ── Helper: get all input group JIDs from config ──────────────
function getInputGroups(cfg) {
  if (Array.isArray(cfg.inputGroups) && cfg.inputGroups.length) return cfg.inputGroups;
  if (cfg.inputGroup) return [cfg.inputGroup];
  return [];
}

// ── Find tenant for a DM sender (must be in an input group) ───
function resolveTenantForDM(senderJid) {
  const { listTenants } = require('./tenant');
  const { getConfig }   = require('./config');
  const phone = senderJid.split('@')[0].split(':')[0];
  for (const tenant of listTenants()) {
    if (!tenant.active) continue;
    const cfg         = getConfig(tenant.id);
    const inputGroups = getInputGroups(cfg);
    for (const gid of inputGroups) {
      const grp = state.groups.find(g => g.id === gid);
      if (grp?.participants?.some(p => p.split('@')[0].split(':')[0] === phone)) {
        return tenant.id;
      }
    }
  }
  return null;
}

// ── Handle incoming message ────────────────────────────────────
async function handleMsg(msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid     = msg.key.remoteJid;
  const isGroup = jid?.endsWith('@g.us');

  logFn('DEBUG', `MSG from ${jid} | group=${isGroup} | botId="${botId}"`);

  const { resolveTenant } = require('./tenant');
  const { getConfig }     = require('./config');

  // ── DM (private chat) — only for input-group members ─────
  if (!isGroup) {
    const dmSender = jid; // in DM, remoteJid IS the contact
    const tenantId = resolveTenantForDM(dmSender);
    if (!tenantId) return; // not whitelisted

    const cfg  = getConfig(tenantId);
    const text = extractText(msg);
    if (!text) return;

    logFn('QUERY', `[DM][${tenantId}] ${dmSender.split('@')[0]}: ${text.slice(0, 80)}`);
    await handleQuery(msg, jid, text, cfg, dmSender, tenantId);
    return;
  }

  // ── Group message ─────────────────────────────────────────
  const sender   = msg.key.participant || '';
  const tenantId = resolveTenant(jid, sender);
  const cfg      = getConfig(tenantId);

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo ||
                      msg.message?.imageMessage?.contextInfo ||
                      msg.message?.videoMessage?.contextInfo ||
                      msg.message?.documentMessage?.contextInfo || {};

  const quotedSenderJid  = contextInfo.participant || '';
  const quotedRaw        = contextInfo.quotedMessage;
  const quotedText       = quotedRaw
    ? (quotedRaw.conversation || quotedRaw.extendedTextMessage?.text || quotedRaw.imageMessage?.caption || '').slice(0, 120)
    : '';

  const text   = extractText(msg);
  const locMsg = msg.message?.locationMessage;

  // Track member profile on every group message
  try {
    const { trackMessage } = require('./profiles');
    trackMessage(tenantId, sender, msg.pushName || '', text);
  } catch {}

  // ── /voice command: reply any message with /voice ─────────
  if (text.trim().toLowerCase() === '/voice' && quotedRaw) {
    const fullQuotedText =
      quotedRaw.conversation ||
      quotedRaw.extendedTextMessage?.text ||
      quotedRaw.imageMessage?.caption || '';
    if (fullQuotedText) {
      await handleVoiceCommand(msg, jid, fullQuotedText, tenantId);
      return;
    }
  }

  // ── Log ALL group messages (24h rolling) ─────────────────
  try {
    const { logMsg: logGroupMsg } = require('./grouplog');
    logGroupMsg(tenantId, jid, {
      senderJid: sender,
      senderName: msg.pushName || sender.split('@')[0].split(':')[0],
      text:       text || (locMsg ? '[Kirim lokasi]' : '[Media]'),
      type:       locMsg ? 'location' : (text ? 'text' : 'media'),
      ...(quotedSenderJid ? {
        quotedSenderJid,
        quotedSenderName: contextInfo.pushName || quotedSenderJid.split('@')[0].split(':')[0],
        quotedText,
      } : {}),
      ...(locMsg ? {
        lat:          locMsg.degreesLatitude,
        lng:          locMsg.degreesLongitude,
        locationName: locMsg.name || locMsg.address || '',
      } : {}),
    });
  } catch {}

  // ── File collector (input groups) ────────────────────────
  const inputGroups = getInputGroups(cfg);
  if (inputGroups.includes(jid)) {
    const docMsg = msg.message?.documentMessage;
    if (docMsg) await processFile(msg, docMsg, jid, tenantId);
  }

  const imgMsg    = msg.message?.imageMessage;
  const mentioned = contextInfo.mentionedJid || [];
  const replyTo   = contextInfo.participant   || '';

  const matchesUs  = (j) => [...botIdentities].some(id => j.includes(id));
  const isMention  = botIdentities.size > 0 && mentioned.some(matchesUs);
  const isReply    = botIdentities.size > 0 && matchesUs(replyTo);
  const hasTrigger = text.toLowerCase().includes('bima');
  const isChained  = isInChain(jid, sender);

  logFn('DEBUG', `trigger: mention=${isMention} reply=${isReply} kw=${hasTrigger} chain=${isChained} tenant=${tenantId}`);

  // "lanjut" pagination
  const isNextPage = /^(lanjut|next|next page|halaman berikutnya|lanjutkan)$/i.test(text.trim());
  if (isNextPage && hasPendingPage(jid, sender)) {
    const page = nextPage(jid, sender);
    if (page) {
      const stillMore = hasPendingPage(jid, sender);
      const suffix = stillMore
        ? `\n\n_— ketik *lanjut* untuk halaman berikutnya_`
        : `\n\n_(halaman terakhir)_`;
      await sendMsg(jid, page.text + suffix, msg);
    }
    return;
  }

  if (isMention || isReply || hasTrigger || isChained) {
    logFn('QUERY', `[${jid}][${tenantId}] ${text.slice(0, 80)}`);

    // ── Summary intent: rekap/summary grup ───────────────
    const isSummaryIntent = /\b(rekap|summary|rangkum|ringkas)\s*(grup|percakapan|chat|hari\s*ini|24\s*jam|kemarin)?\b/i.test(text);
    if (isSummaryIntent) {
      try {
        await sendMsg(jid, '_Sedang membuat rekap percakapan..._', msg);
        const { summarize } = require('./grouplog');
        const hours = /kemarin/i.test(text) ? 48 : 24;
        const rekap = await summarize(tenantId, jid, cfg, hours);
        const label = hours === 48 ? 'Kemarin (48 Jam)' : '24 Jam Terakhir';
        await sendPaged(jid, sender, `*Rekap Percakapan ${label}:*\n\n${rekap}`, msg);
      } catch (e) {
        await sendMsg(jid, `Gagal buat rekap: ${e.message}`, msg);
      }
      addToChain(jid, sender);
      return;
    }

    const audioMsg = msg.message?.audioMessage;
    if (audioMsg) {
      await handleVoiceNote(msg, jid, text, cfg, sender, tenantId);
      return;
    }

    if (imgMsg) {
      await handleImageQuery(msg, jid, text, cfg, sender, tenantId);
    } else {
      await handleQuery(msg, jid, text, cfg, sender, tenantId);
    }
  }
}

function extractText(msg) {
  const m = msg.message;
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    ''
  );
}

// ── Handle image message with vision AI ───────────────────────
async function handleImageQuery(msg, jid, caption, cfg, senderJid, tenantId) {
  const { analyzeImage } = require('./ai');
  const { addTurn } = require('./memory');

  const Baileys = await import('@whiskeysockets/baileys');
  const download = Baileys.downloadMediaMessage;

  try {
    await sendMsg(jid, 'Sedang menganalisis gambar...', msg);

    const imgMsg  = msg.message.imageMessage;
    const mime    = imgMsg.mimetype || 'image/jpeg';
    const buffer  = await download(msg, 'buffer', {});

    const question = caption
      .replace(/@\S+/gi, '')
      .replace(/\bbima\b/gi, '')
      .trim() || 'Jelaskan isi gambar ini.';

    const answer = await analyzeImage(buffer, mime, question, cfg);

    await sendMsg(jid, answer, msg);
    addTurn(jid, senderJid, `[Image] ${question}`, answer);
    addToChain(jid, senderJid);
  } catch (e) {
    logFn('ERROR', `Vision error: ${e.message}`);
    await sendMsg(jid, `Maaf, gagal menganalisis gambar: ${e.message}`, msg);
  }
}

// ── /voice command: convert quoted text → voice note ──────────
async function handleVoiceCommand(msg, jid, text, tenantId) {
  let notified = false;
  try {
    // Trim to 500 chars so TTS doesn't take too long
    const ttsText = text.slice(0, 500);
    await sendMsg(jid, '_Mengkonversi teks ke suara..._', msg);
    notified = true;

    const { textToVoiceNote } = require('./tts');
    const audioBuffer = await textToVoiceNote(ttsText);

    await sock.sendMessage(jid, {
      audio:    audioBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt:      true,
    }, { quoted: msg });

    logFn('INFO', `Voice note terkirim (${ttsText.length} chars) -> ${jid}`);
  } catch (e) {
    logFn('ERROR', `TTS /voice error: ${e?.message || String(e)}`);
    if (!notified) await sendMsg(jid, '_Mengkonversi teks ke suara..._', msg).catch(() => {});
    await sendMsg(jid, `Gagal buat voice note: ${e.message}`, msg);
  }
}

// ── Handle voice note: STT → agent ────────────────────────────
async function handleVoiceNote(msg, jid, caption, cfg, senderJid, tenantId) {
  const { transcribe }  = require('./stt');
  const { addTurn }     = require('./memory');

  const Baileys  = await import('@whiskeysockets/baileys');
  const download = Baileys.downloadMediaMessage;

  try {
    await sendMsg(jid, '_Sedang menganalisis suara..._', msg);

    const buffer = await download(msg, 'buffer', {});

    const transcript = await transcribe(buffer, cfg);
    if (!transcript) {
      await sendMsg(jid, 'Maaf, tidak bisa mendengar suara dengan jelas. Coba rekam ulang.', msg);
      return;
    }

    logFn('STT', `Transkripsi: "${transcript.slice(0, 80)}"`);
    await sendMsg(jid, `_Bima mendengar: "${transcript}"_`, msg);

    await handleQuery(msg, jid, transcript, cfg, senderJid, tenantId);

  } catch (e) {
    logFn('ERROR', `STT error: ${e.message}`);
    if (e.message.includes('STT belum dikonfigurasi')) {
      await sendMsg(jid, `Fitur voice note belum dikonfigurasi.\nAdmin perlu set STT provider di terminal dengan perintah */stt*`, msg);
    } else {
      await sendMsg(jid, `Maaf, gagal proses voice note: ${e.message}`, msg);
    }
  }
}

// ── Process uploaded file ──────────────────────────────────────
async function processFile(msg, docMsg, jid, tenantId) {
  const { checkSize, saveFile, extractText: extractFileText } = require('./processor');
  const { structureText } = require('./ai');
  const { saveDocument }  = require('./db');

  const Baileys  = await import('@whiskeysockets/baileys');
  const download = Baileys.downloadMediaMessage;

  const mime     = docMsg.mimetype || '';
  const filename = docMsg.fileName || `file_${Date.now()}`;
  const size     = docMsg.fileLength || 0;

  const supported = ['pdf', 'spreadsheet', 'excel', 'wordprocessingml', 'text/plain'];
  if (!supported.some(s => mime.includes(s))) return;

  if (!checkSize(size)) {
    await sendMsg(jid, `File *${filename}* terlalu besar (maks 10MB), tidak bisa diproses.`, msg);
    return;
  }

  logFn('FILE', `[${tenantId}] Memproses: ${filename}`);
  await sendMsg(jid, `Baik, *${filename}* sedang di-upload dan diproses... `, msg);

  try {
    const buffer   = await download(msg, 'buffer', {});
    const { filePath, fileName } = saveFile(buffer, filename, tenantId);
    const rawText  = await extractFileText(filePath, filename);

    if (!rawText) {
      await sendMsg(jid, `Gagal membaca isi *${filename}*, coba kirim ulang.`, msg);
      return;
    }

    let structured = {};
    try { structured = await structureText(rawText); } catch {}

    const result = saveDocument({ file: fileName, raw_text: rawText, structured }, tenantId);
    if (result.saved) {
      await sendMsg(jid, `*${fileName}* sudah tersimpan dan siap digunakan!`, msg);
      logFn('FILE', `[${tenantId}] Tersimpan: ${fileName}`);

      const { getConfig } = require('./config');
      const cfg = getConfig(tenantId);
      if (cfg.provider && cfg.apiKey) {
        const { compactKnowledge } = require('./db');
        sendMsg(jid, `_Mengoptimasi konteks ${fileName}..._`).catch(() => {});
        compactKnowledge(result.hash, cfg, tenantId)
          .then(ok => {
            if (ok) {
              logFn('FILE', `[${tenantId}] Auto-compact OK: ${fileName}`);
              sendMsg(jid, `Konteks *${fileName}* sudah dioptimasi, jawaban akan lebih akurat.`).catch(() => {});
            }
          })
          .catch(() => {});
      }
    } else {
      await sendMsg(jid, `*${fileName}* sudah pernah di-upload sebelumnya.`, msg);
    }
  } catch (e) {
    await sendMsg(jid, `Gagal memproses *${filename}*: ${e.message}`, msg);
    logFn('ERROR', `Gagal proses file: ${e.message}`);
  }
}

// ── Thinking indicator for complex queries ────────────────────
async function sendThinking(jid, quotedMsg) {
  const hints = [
    'Bima sedang menganalisis...',
    'Sedang mencari data...',
    'Memproses pertanyaanmu...',
  ];
  const text = hints[Math.floor(Math.random() * hints.length)];
  await sendMsg(jid, text, quotedMsg);
}

// ── Answer query — ReAct agent loop ──────────────────────────
async function handleQuery(msg, jid, text, cfg, senderJid, tenantId) {
  const { addTurn, getHistory } = require('./memory');
  const { addReminder, listReminders } = require('./reminder');

  const tid = tenantId || 'default';

  const question = text
    .replace(/@\S+/gi, '')
    .replace(/\bbima\b/gi, '')
    .trim();

  if (!question) return;

  try {
    // ── Intent: reminder ──
    const isReminder = /\b(ingatkan?|remind|pengingat)\b/i.test(question);
    if (isReminder) {
      const result = addReminder(jid, senderJid, question, tid);
      if (result.ok) {
        const reply = `Oke! Akan aku ingatkan kamu jam *${result.when}* tentang: _${result.msg}_`;
        await sendMsg(jid, reply, msg);
        addTurn(jid, senderJid, question, reply);
        addToChain(jid, senderJid);
        return;
      } else {
        const reply = 'Maaf, aku tidak bisa mendeteksi waktunya. Coba: "ingatkan aku jam 14:30 meeting" atau "dalam 30 menit".';
        await sendMsg(jid, reply, msg);
        addToChain(jid, senderJid);
        return;
      }
    }

    // ── Intent: list reminders ──
    if (/\b(daftar|list|cek)\s*(reminder|pengingat)\b/i.test(question)) {
      const list = listReminders(jid, tid);
      if (!list.length) {
        await sendMsg(jid, 'Tidak ada pengingat aktif di grup ini.', msg);
      } else {
        const lines = list.map((r, i) => {
          const t = new Date(r.targetMs).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
          return `${i + 1}. [${t}] ${r.message}`;
        });
        await sendMsg(jid, `*Pengingat aktif:*\n${lines.join('\n')}`, msg);
      }
      addToChain(jid, senderJid);
      return;
    }

    // ── Pending confirmation (date mismatch) ──
    const pending = popPendingConfirm(jid, senderJid);
    if (pending) {
      const isYes = /^(ya|iya|yes|ok|oke|boleh|lanjut|kirim|send|yep)\b/i.test(question);
      const isNo  = /^(tidak|nggak|gak|no|cancel|batal|jangan)\b/i.test(question);
      if (isYes) {
        const fileSent = await sendFile(jid, pending.doc.file, msg, tid);
        if (!fileSent) {
          const txt = pending.doc.compact_text || pending.doc.raw_text || JSON.stringify(pending.doc.structured, null, 2);
          await sendMsg(jid, `*${pending.doc.file}*\n\n${txt.slice(0, 4000)}`, msg);
        }
        addToChain(jid, senderJid);
        return;
      } else if (isNo) {
        await sendMsg(jid, 'Oke, dibatalkan.', msg);
        addToChain(jid, senderJid);
        return;
      }
      setPendingConfirm(jid, senderJid, pending.doc, pending.msgRef);
    }

    // ── Intent: clear conversation memory ──
    if (/\b(reset|hapus|clear)\s*(memori|ingatan|history|histori|chat)\b/i.test(question)) {
      const { clearHistory } = require('./memory');
      clearHistory(jid, senderJid);
      await sendMsg(jid, 'Memori percakapan kamu sudah di-reset.', msg);
      addToChain(jid, senderJid);
      return;
    }

    // ── Intent: clear long-term memory ──
    if (/\b(hapus|clear|reset)\s*(semua\s*)?(memori\s*jangka\s*panjang|ltm|fakta tersimpan)\b/i.test(question)) {
      const { clearAll: clearLTM } = require('./ltm');
      clearLTM(tid);
      await sendMsg(jid, 'Semua memori jangka panjang sudah dihapus.', msg);
      addToChain(jid, senderJid);
      return;
    }

    // ── Intent: send file / full data ──
    const wantFile = /\b(kirim(kan)?|tolong\s+kirim(kan)?|send)\b.{0,20}\b(file|dokumen|berkas|pdf|excel|xlsx)\b|\b(lampirkan|attach)\b/i.test(question);
    const wantFull = /\b(data lengkap|semua data|full data|kirim semua|lengkapnya|seluruh data)\b/i.test(question);

    if (wantFile || wantFull) {
      await handleFileRequest(msg, jid, question, cfg, senderJid, wantFile, tid);
      return;
    }

    // ── Detect complexity for thinking indicator ──
    const isComplex = /\b(jelaskan|ceritakan|analisa|analisis|bandingkan|compare|rekap|rangkum|bagaimana|mengapa|kenapa)\b/i.test(question)
      || question.length > 80;

    try { await sock.sendPresenceUpdate('composing', jid); } catch {}

    if (isComplex) {
      sendThinking(jid, msg).catch(() => {});
    }

    const history    = getHistory(jid, senderJid);
    const { recall } = require('./ltm');
    const ltmContext = recall(question, 3, tid);

    const { runAgent } = require('./agent');
    const wantWeb = /\b(cari\s*(di\s*)?(internet|web|google|online)|search\s*(online|web|internet))\b/i.test(question);

    // Inject member profile context
    let profilePrefix = '';
    try {
      const { buildProfileContext } = require('./profiles');
      profilePrefix = buildProfileContext(tid, senderJid, msg.pushName || '');
    } catch {}

    const agentQuestion = [
      profilePrefix,
      wantWeb ? `[HINT: user minta cari di internet] ${question}` : question,
    ].filter(Boolean).join('\n\n');

    let searchIndicatorSent = false;
    const onToolCall = async (action) => {
      if (!searchIndicatorSent) {
        searchIndicatorSent = true;
        const msgs = {
          web_search:    '_Bima sedang mencari di internet..._',
          compare_files: '_Bima sedang membandingkan data..._',
          get_file:      '_Bima sedang membuka file..._',
        };
        const indicator = msgs[action] || '_Bima sedang mencari data..._';
        sendMsg(jid, indicator, msg).catch(() => {});
      }
    };

    const { answer, steps } = await runAgent(agentQuestion, history, cfg, ltmContext.length ? ltmContext : null, onToolCall, tid, jid);

    if (steps.length) {
      logFn('AGENT', `[${tid}] ${steps.length} step(s): ${steps.map(s => s.action).join(' -> ')}`);
    }

    // Don't send to group if the only action was saving a fact
    const silentActions = new Set(['remember']);
    const isSilent = steps.length > 0 && steps.every(s => silentActions.has(s.action));
    if (isSilent) {
      logFn('INFO', `[${tid}] Fakta disimpan (silent — tidak dikirim ke grup)`);
      addTurn(jid, senderJid, question, answer);
      addToChain(jid, senderJid);
      try { await sock.sendPresenceUpdate('paused', jid); } catch {}
      return;
    }

    await sendPaged(jid, senderJid, answer, msg);
    addTurn(jid, senderJid, question, answer);
    addToChain(jid, senderJid);

    try { await sock.sendPresenceUpdate('paused', jid); } catch {}

  } catch (e) {
    logFn('ERROR', `Query error [${tid}]: ${e.message}`);
    try { await sendMsg(jid, `Maaf, ada masalah: ${e.message}`, msg); } catch {}
  }
}

// ── Handle file send / full data request (date-aware) ────────
async function handleFileRequest(msg, jid, question, cfg, senderJid, wantFile, tenantId) {
  const { getKnowledge, findLatestFiles, dateLabel, isToday: isTodayFn } = require('./db');
  const { addTurn } = require('./memory');
  const tid = tenantId || 'default';

  const docs = getKnowledge(tid);
  if (!docs.length) {
    await sendMsg(jid, 'Belum ada file yang tersimpan di database.', msg);
    addToChain(jid, senderJid);
    return;
  }

  const searchQuery = question
    .replace(/kirim(kan)?|tolong|coba|file|dokumen|berkas|lampir(kan)?|send|nya\b/gi, ' ')
    .replace(/terbaru|latest|terlama|hari\s*ini|kemarin/gi, ' ')
    .replace(/\s+/g, ' ').trim() || question;

  const candidates = findLatestFiles(searchQuery, tid);
  if (!candidates.length) {
    await sendMsg(jid, 'Tidak ada file yang relevan ditemukan di database.', msg);
    addToChain(jid, senderJid);
    return;
  }

  const latest    = candidates[0];
  const doc       = latest.doc;
  const docDate   = latest.date;
  const todayData = isTodayFn(docDate);

  const wantToday = /\b(hari\s*ini|today|terbaru|terkini)\b/i.test(question);

  if (wantToday && !todayData) {
    const label = dateLabel(docDate);
    const confirmMsg = `Maaf, data hari ini belum tersedia.\nData terbaru yang ada adalah *${label}* (_${doc.file}_).\n\nApakah mau pakai data tersebut?`;
    await sendMsg(jid, confirmMsg, msg);
    setPendingConfirm(jid, senderJid, doc, msg);
    addToChain(jid, senderJid);
    return;
  }

  if (wantFile) {
    const fileSent = await sendFile(jid, doc.file, msg, tid);
    if (!fileSent) {
      const fullText = doc.compact_text || doc.raw_text || JSON.stringify(doc.structured, null, 2);
      await sendMsg(jid, `*${doc.file}*\n\n${fullText.slice(0, 4000)}`, msg);
    }
  } else {
    const fullText = doc.compact_text || doc.raw_text || JSON.stringify(doc.structured, null, 2);
    await sendMsg(jid, `*Data lengkap: ${doc.file}*\n(${dateLabel(docDate)})\n\n${fullText.slice(0, 4000)}`, msg);
  }

  addTurn(jid, senderJid, question, `[File terkirim: ${doc.file}]`);
  addToChain(jid, senderJid);
}

// ── Send file as document ─────────────────────────────────────
async function sendFile(jid, fileName, quoted = null, tenantId) {
  const { tenantPaths } = require('./tenant');
  const filesDir = tenantPaths(tenantId || 'default').files;
  const filePath = path.join(filesDir, fileName);
  if (!fs.existsSync(filePath)) return false;

  const mimeMap = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls:  'application/vnd.ms-excel',
    pdf:  'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    csv:  'text/csv',
    txt:  'text/plain',
  };
  const ext      = fileName.split('.').pop().toLowerCase();
  const mimetype = mimeMap[ext] || 'application/octet-stream';

  try {
    const buffer  = fs.readFileSync(filePath);
    const options = quoted ? { quoted } : {};
    await sock.sendMessage(jid, { document: buffer, fileName, mimetype }, options);
    logFn('INFO', `File terkirim: ${fileName} -> ${jid}`);
    return true;
  } catch (e) {
    logFn('ERROR', `Gagal kirim file: ${e.message}`);
    return false;
  }
}

// ── Send with retry ───────────────────────────────────────────
async function sendMsg(jid, text, quoted = null, attempt = 1) {
  if (!text?.trim() || !sock) return;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  try {
    await delay(500 + Math.random() * 800);
    const options = quoted ? { quoted } : {};
    await sock.sendMessage(jid, { text }, options);
    logFn('INFO', `Pesan terkirim -> ${jid}`);
  } catch (e) {
    if (attempt < 3) {
      await delay(1500 * attempt);
      await sendMsg(jid, text, quoted, attempt + 1);
    } else {
      try { await sock.sendMessage(jid, { text }); } catch (e2) {
        logFn('ERROR', `Gagal total: ${e2.message}`);
      }
    }
  }
}

function getWAStatus() { return state; }

async function logoutWA() {
  try {
    if (sock && state.connected) await sock.logout();
  } catch {}
  try { if (sock) sock.end(); } catch {}
  state.connected = false;

  // Delete auth files
  const fs   = require('fs');
  const path = require('path');
  if (fs.existsSync(AUTH_DIR)) {
    for (const f of fs.readdirSync(AUTH_DIR)) {
      try { fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true }); } catch {}
    }
  }
  started = false;
}

module.exports = { startWA, getWAStatus, logoutWA };
