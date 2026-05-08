'use strict';

let _bot     = null;
let _logFn   = () => {};
let _botInfo = null;

// ── Start Telegram bot ────────────────────────────────────────
async function startTelegram(token, logger) {
  if (_bot) {
    try { await _bot.stopPolling(); } catch {}
    _bot     = null;
    _botInfo = null;
  }
  _logFn = logger || _logFn;

  let TelegramBot;
  try {
    TelegramBot = require('node-telegram-bot-api');
  } catch {
    throw new Error('node-telegram-bot-api belum terinstall. Jalankan: npm install node-telegram-bot-api');
  }

  _bot = new TelegramBot(token, { polling: { interval: 1000, autoStart: true } });

  _botInfo = await _bot.getMe();
  _logFn('TG', `Bot @${_botInfo.username} (${_botInfo.first_name}) aktif`);

  _bot.on('message', async (msg) => {
    try { await handleMessage(msg); } catch (e) {
      _logFn('ERROR', `TG msg: ${e.message}`);
    }
  });

  _bot.on('polling_error', (err) => {
    _logFn('WARN', `TG polling: ${err.message}`);
  });
}

// ── Route incoming message ────────────────────────────────────
async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from?.id || chatId);
  const tid    = 'default';

  const { getConfig } = require('./config');
  const cfg = getConfig(tid);

  // /start or /help — onboarding
  const text = msg.text || msg.caption || '';
  if (text === '/start' || text === '/help') {
    await _bot.sendMessage(chatId,
      '*Halo! Aku Bima 🤖*\n\n' +
      'AI Agent WhatsApp dari Indonesia, kini hadir di Telegram!\n\n' +
      '*Kamu bisa:*\n' +
      '• Tanya apa saja — aku jawab pakai AI\n' +
      '• Kirim foto → aku analisis dengan vision AI\n' +
      '• Kirim voice note → aku transkripsi + jawab\n' +
      '• Kirim PDF/Excel/Word → masuk ke knowledge base\n\n' +
      '_Powered by BIMA Agent_',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (!cfg.provider) {
    await _bot.sendMessage(chatId, '⚠ AI belum dikonfigurasi. Admin perlu jalankan /model di terminal BIMA.');
    return;
  }

  // Route by message type
  if (msg.voice)    { await handleVoice(msg, chatId, userId, cfg, tid);    return; }
  if (msg.photo)    { await handlePhoto(msg, chatId, userId, cfg, tid);    return; }
  if (msg.document) { await handleDocument(msg, chatId, userId, cfg, tid); return; }

  if (text) await handleText(msg, chatId, userId, text, cfg, tid);
}

// ── Text → agent ──────────────────────────────────────────────
async function handleText(msg, chatId, userId, text, cfg, tid) {
  const { getHistory, addTurn } = require('./memory');
  const { recall }              = require('./ltm');
  const { runAgent }            = require('./agent');

  const senderKey = `tg::${userId}`;

  try { await _bot.sendChatAction(chatId, 'typing'); } catch {}

  _logFn('QUERY', `[TG][${chatId}] ${text.slice(0, 80)}`);

  const history  = getHistory(chatId, senderKey);
  const ltmCtx   = recall(text, 3, tid);

  try {
    const { answer } = await runAgent(
      text, history, cfg,
      ltmCtx.length ? ltmCtx : null,
      null, tid, null
    );
    addTurn(chatId, senderKey, text, answer);
    await sendChunked(chatId, answer);
  } catch (e) {
    _logFn('ERROR', `TG query: ${e.message}`);
    await _bot.sendMessage(chatId, `Maaf, ada error: ${e.message}`);
  }
}

// ── Photo → vision AI ─────────────────────────────────────────
async function handlePhoto(msg, chatId, userId, cfg, tid) {
  const { analyzeImage }        = require('./ai');
  const { addTurn }             = require('./memory');

  const caption = msg.caption || 'Jelaskan isi gambar ini secara detail.';

  try {
    await _bot.sendChatAction(chatId, 'upload_photo');
    await _bot.sendMessage(chatId, '_Sedang menganalisis gambar..._', { parse_mode: 'Markdown' });

    const largest = msg.photo[msg.photo.length - 1];
    const fileUrl = await _bot.getFileLink(largest.file_id);

    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Download gambar gagal: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const answer = await analyzeImage(buffer, 'image/jpeg', caption, cfg);
    addTurn(chatId, `tg::${userId}`, `[Foto] ${caption}`, answer);
    await sendChunked(chatId, answer);
  } catch (e) {
    _logFn('ERROR', `TG photo: ${e.message}`);
    await _bot.sendMessage(chatId, `Maaf, gagal analisis gambar: ${e.message}`);
  }
}

// ── Voice note → STT → agent ──────────────────────────────────
async function handleVoice(msg, chatId, userId, cfg, tid) {
  const { transcribe } = require('./stt');

  try {
    await _bot.sendChatAction(chatId, 'typing');
    await _bot.sendMessage(chatId, '_Sedang mendengarkan..._', { parse_mode: 'Markdown' });

    const fileUrl = await _bot.getFileLink(msg.voice.file_id);
    const res     = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Download audio gagal: HTTP ${res.status}`);
    const buffer  = Buffer.from(await res.arrayBuffer());

    const transcript = await transcribe(buffer, cfg);
    if (!transcript) {
      await _bot.sendMessage(chatId, 'Maaf, tidak bisa mendengar dengan jelas. Coba rekam ulang.');
      return;
    }

    await _bot.sendMessage(chatId, `_Bima mendengar: "${transcript}"_`, { parse_mode: 'Markdown' });
    await handleText(msg, chatId, userId, transcript, cfg, tid);
  } catch (e) {
    _logFn('ERROR', `TG voice: ${e.message}`);
    if (e.message.includes('STT belum dikonfigurasi')) {
      await _bot.sendMessage(chatId, 'Fitur voice note belum dikonfigurasi. Admin perlu set /stt di terminal BIMA.');
    } else {
      await _bot.sendMessage(chatId, `Maaf, gagal proses voice note: ${e.message}`);
    }
  }
}

// ── Document → knowledge base ─────────────────────────────────
async function handleDocument(msg, chatId, userId, cfg, tid) {
  const doc   = msg.document;
  const fname = doc.file_name || `file_${Date.now()}`;
  const mime  = doc.mime_type || '';

  const supported = ['pdf', 'spreadsheet', 'excel', 'wordprocessingml', 'text/plain'];
  if (!supported.some(s => mime.includes(s))) {
    await _bot.sendMessage(chatId, `Format *${fname}* belum didukung. Kirim PDF, Excel, Word, atau TXT.`, { parse_mode: 'Markdown' });
    return;
  }
  if (doc.file_size > 10 * 1024 * 1024) {
    await _bot.sendMessage(chatId, `File *${fname}* terlalu besar (maks 10MB).`, { parse_mode: 'Markdown' });
    return;
  }

  await _bot.sendMessage(chatId, `⏳ Memproses *${fname}*...`, { parse_mode: 'Markdown' });

  try {
    const fileUrl = await _bot.getFileLink(doc.file_id);
    const res     = await fetch(fileUrl, { signal: AbortSignal.timeout(60_000) });
    const buffer  = Buffer.from(await res.arrayBuffer());

    const { saveFile, extractText } = require('./processor');
    const { saveDocument }          = require('./db');
    const { structureText }         = require('./ai');

    const { filePath, fileName } = saveFile(buffer, fname, tid);
    const rawText = await extractText(filePath, fname);

    if (!rawText) {
      await _bot.sendMessage(chatId, `Gagal membaca isi *${fname}*.`, { parse_mode: 'Markdown' });
      return;
    }

    let structured = {};
    try { structured = await structureText(rawText); } catch {}

    const result = saveDocument({ file: fileName, raw_text: rawText, structured }, tid);
    if (result.saved) {
      await _bot.sendMessage(chatId, `✓ *${fileName}* tersimpan ke knowledge base BIMA!`, { parse_mode: 'Markdown' });
    } else {
      await _bot.sendMessage(chatId, `*${fileName}* sudah pernah diupload sebelumnya.`, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    _logFn('ERROR', `TG doc: ${e.message}`);
    await _bot.sendMessage(chatId, `Gagal proses file: ${e.message}`);
  }
}

// ── Send chunked (Telegram 4096 char limit) ───────────────────
async function sendChunked(chatId, text) {
  const MAX = 4000;
  if (text.length <= MAX) {
    try {
      await _bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch {
      await _bot.sendMessage(chatId, text);
    }
    return;
  }

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + MAX;
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start + 100) end = nl;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }

  for (const chunk of chunks) {
    try {
      await _bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch {
      await _bot.sendMessage(chatId, chunk);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

// ── Status / stop ─────────────────────────────────────────────
function getTelegramStatus() {
  return {
    connected: !!_bot && !!_botInfo,
    username:  _botInfo?.username || '',
    name:      _botInfo?.first_name || '',
  };
}

async function stopTelegram() {
  if (_bot) {
    try { await _bot.stopPolling(); } catch {}
    _bot     = null;
    _botInfo = null;
    _logFn('TG', 'Bot dihentikan.');
  }
}

module.exports = { startTelegram, getTelegramStatus, stopTelegram };
