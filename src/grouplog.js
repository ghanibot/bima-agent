'use strict';

const fs   = require('fs');
const path = require('path');

const MAX_AGE_MS  = 48 * 60 * 60 * 1000; // keep 48h so "tadi pagi" still queryable
const MAX_ENTRIES = 3000;

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

// ── List all group JIDs logged for a tenant ───────────────────
function listGroupJids(tenantId) {
  const { tenantPaths } = require('./tenant');
  const dir = tenantPaths(tenantId || 'default').dir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('grouplog_') && f.endsWith('.json'))
    .map(f => {
      // Reverse the safe-encode: grouplog_1234567890_g_us.json → 1234567890@g.us
      const inner = f.replace(/^grouplog_/, '').replace(/\.json$/, '');
      // Try to reconstruct JID — replace last _g_us with @g.us
      return inner.replace(/_g_us$/, '@g.us').replace(/_c_us$/, '@c.us');
    });
}

// ── Get all mentions of a JID across all groups ───────────────
// Returns array of { ts, groupJid, groupName?, senderJid, senderName, senderPhone, text, mentionedJids }
function getMentions(tenantId, targetJid, hours = 24) {
  const phone  = targetJid.split('@')[0].split(':')[0];
  const cutoff = Date.now() - hours * 3_600_000;
  const results = [];

  const { tenantPaths } = require('./tenant');
  const dir = tenantPaths(tenantId || 'default').dir;
  if (!fs.existsSync(dir)) return results;

  const files = fs.readdirSync(dir).filter(f => f.startsWith('grouplog_') && f.endsWith('.json'));

  for (const file of files) {
    const rawJid = file.replace(/^grouplog_/, '').replace(/\.json$/, '');
    const groupJid = rawJid.replace(/_g_us$/, '@g.us').replace(/_c_us$/, '@c.us');

    let entries;
    try { entries = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
    catch { continue; }

    for (const e of entries) {
      if (e.ts < cutoff) continue;
      if (!Array.isArray(e.mentionedJids) || !e.mentionedJids.length) continue;

      const wasMentioned = e.mentionedJids.some(mjid => {
        const mPhone = mjid.split('@')[0].split(':')[0];
        return mPhone === phone || mjid === targetJid;
      });
      if (!wasMentioned) continue;

      results.push({
        ts:          e.ts,
        msgId:       e.msgId || null,
        groupJid,
        groupName:   e.groupName || groupJid.split('@')[0],
        senderJid:   e.senderJid || '',
        senderName:  e.senderName || '?',
        senderPhone: (e.senderJid || '').split('@')[0].split(':')[0],
        text:        e.text || '',
        quotedText:  e.quotedText || '',
      });
    }
  }

  return results.sort((a, b) => a.ts - b.ts);
}

// ── Format mentions for WhatsApp reply ────────────────────────
function formatMentions(mentions, targetName) {
  if (!mentions.length) return null;

  const lines = mentions.map((m, i) => {
    const t     = new Date(m.ts).toLocaleString('id-ID', {
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
    const grpDisplay = m.groupName || m.groupJid.split('@')[0];
    const phone = m.senderPhone ? `0${m.senderPhone.replace(/^62/, '')}` : '?';
    return (
      `${i + 1}. *${m.senderName}* (${phone})\n` +
      `   Grup: ${grpDisplay}\n` +
      `   Waktu: ${t}\n` +
      `   Pesan: "${m.text.slice(0, 120)}"`
    );
  });

  return (
    `📣 *Tag untuk ${targetName || 'kamu'} (${mentions.length}x):*\n\n` +
    lines.join('\n\n')
  );
}

// ── Conversation pattern analysis (who talks to whom) ─────────
function getConversationPatterns(tenantId, groupJid, hours = 24) {
  const entries = getLog(tenantId, groupJid, hours);
  if (!entries.length) return null;

  const pairs  = {};   // "A→B": count
  const active = {};   // name: messageCount

  for (const e of entries) {
    const from = e.senderName || '?';
    active[from] = (active[from] || 0) + 1;

    if (e.quotedSenderName) {
      const key = `${from}→${e.quotedSenderName}`;
      pairs[key] = (pairs[key] || 0) + 1;
    }
    if (Array.isArray(e.mentionedNames)) {
      for (const to of e.mentionedNames) {
        const key = `${from}→${to}`;
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
  }

  const topPairs = Object.entries(pairs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, v]) => `${k} (${v}x)`);

  const topActive = Object.entries(active)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([n, c]) => `${n}: ${c} pesan`);

  return { topPairs, topActive, totalMessages: entries.length };
}

module.exports = {
  logMsg, getLog, formatLog, summarize,
  getPersonLocation, getMentions, formatMentions,
  listGroupJids, getConversationPatterns,
};
