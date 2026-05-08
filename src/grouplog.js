'use strict';

const fs   = require('fs');
const path = require('path');

const MAX_AGE_MS  = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

function logPath(tenantId, groupJid) {
  const { tenantPaths } = require('./tenant');
  const safe = groupJid.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(tenantPaths(tenantId || 'default').dir, `grouplog_${safe}.json`);
}

function load(tenantId, groupJid) {
  try {
    const p = logPath(tenantId, groupJid);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function save(tenantId, groupJid, entries) {
  const p = logPath(tenantId, groupJid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(entries));
}

// entry: { senderJid, senderName, text, type, quotedSenderJid?, quotedSenderName?, quotedText?, lat?, lng?, locationName? }
function logMsg(tenantId, groupJid, entry) {
  const cutoff = Date.now() - MAX_AGE_MS;
  let entries = load(tenantId, groupJid).filter(e => e.ts >= cutoff);
  entries.push({ ts: Date.now(), ...entry });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  save(tenantId, groupJid, entries);
}

function getLog(tenantId, groupJid, hours = 24) {
  const cutoff = Date.now() - hours * 3_600_000;
  return load(tenantId, groupJid).filter(e => e.ts >= cutoff);
}

function formatLog(entries) {
  return entries.map(e => {
    const t = new Date(e.ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const replyPart = e.quotedSenderName
      ? ` [balas ${e.quotedSenderName}: "${(e.quotedText || '').slice(0, 50)}"]`
      : '';
    const locPart = e.type === 'location'
      ? ` [LOKASI lat=${e.lat} lng=${e.lng}${e.locationName ? ' nama=' + e.locationName : ''}]`
      : '';
    return `${t} ${e.senderName}${replyPart}: ${e.text || ''}${locPart}`;
  }).join('\n');
}

async function summarize(tenantId, groupJid, cfg, hours = 24) {
  const { callAI } = require('./ai');
  const entries = getLog(tenantId, groupJid, hours);
  if (!entries.length) return `Tidak ada percakapan dalam ${hours} jam terakhir.`;

  const logText = formatLog(entries);
  const systemPrompt = 'Kamu asisten rekap percakapan WhatsApp untuk bisnis Indonesia. Buat rekap ringkas, faktual, kronologis.';
  const userPrompt = `Rekap percakapan grup ${hours} jam terakhir sebagai timeline singkat.\n\nFormat tiap baris: *jam:menit* - Nama: ringkasan kejadian/info penting.\n\nFokus pada: konfirmasi kegiatan, info lokasi, keputusan, laporan. Abaikan sapaan/basa-basi kosong.\n\nPercakapan:\n${logText.slice(0, 8000)}`;

  try {
    return await callAI([{ role: 'user', content: userPrompt }], systemPrompt, cfg);
  } catch (e) {
    return `Gagal membuat rekap: ${e.message}`;
  }
}

// Get last known location of a person by name or phone
function getPersonLocation(tenantId, groupJid, nameOrPhone) {
  const entries = getLog(tenantId, groupJid, 24);
  const query   = nameOrPhone.toLowerCase();
  const locEntries = entries.filter(e =>
    e.type === 'location' &&
    (e.senderName?.toLowerCase().includes(query) || e.senderJid?.includes(query))
  );
  if (!locEntries.length) return null;
  return locEntries[locEntries.length - 1]; // most recent
}

module.exports = { logMsg, getLog, formatLog, summarize, getPersonLocation };
