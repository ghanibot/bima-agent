'use strict';

const fs   = require('fs');
const path = require('path');

function reminderPath(tenantId) {
  const { tenantPaths } = require('./tenant');
  return tenantPaths(tenantId || 'default').reminders;
}

// pending: [{ id, jid, senderJid, senderPhone, message, targetMs, tenantId }]
let pending = [];
let _sendFn = null;
let _logFn  = () => {};

function init(sendFn, logFn) {
  _sendFn = sendFn;
  _logFn  = logFn || _logFn;
  _loadAll();
}

function _loadAll() {
  // Load reminders from all tenant dirs
  const { listTenants } = require('./tenant');
  const tenants = listTenants();
  const ids = tenants.length ? tenants.map(t => t.id) : ['default'];

  const now = Date.now();
  for (const id of ids) {
    try {
      const p = reminderPath(id);
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const r of data) {
        if (r.targetMs > now) _schedule({ ...r, tenantId: r.tenantId || id });
      }
    } catch {}
  }
}

function _save(tenantId) {
  const p = reminderPath(tenantId || 'default');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const relevant = pending.filter(r => (r.tenantId || 'default') === (tenantId || 'default'));
  fs.writeFileSync(p, JSON.stringify(relevant, null, 2));
}

function _schedule(r) {
  const delay = Math.max(0, r.targetMs - Date.now());
  setTimeout(async () => {
    if (!_sendFn) return;
    try {
      await _sendFn(r.jid, `Pengingat @${r.senderPhone}\n\n${r.message}`);
    } catch {}
    pending = pending.filter(x => x.id !== r.id);
    _save(r.tenantId);
  }, delay);

  if (!pending.find(x => x.id === r.id)) {
    pending.push(r);
  }
}

function parseTime(text) {
  const now = new Date();

  const inMin = text.match(/dalam\s+(\d+)\s*(menit|min)/i);
  if (inMin) return now.getTime() + parseInt(inMin[1]) * 60_000;

  const inHr = text.match(/dalam\s+(\d+)\s*(jam|hour|hr)/i);
  if (inHr) return now.getTime() + parseInt(inHr[1]) * 3_600_000;

  const atTime = text.match(/(?:jam|pukul|at)\s+(\d{1,2})[:\.](\d{2})/i);
  if (atTime) {
    const t = new Date(now);
    t.setHours(parseInt(atTime[1]), parseInt(atTime[2]), 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t.getTime();
  }

  const bare = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (bare) {
    const t = new Date(now);
    t.setHours(parseInt(bare[1]), parseInt(bare[2]), 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t.getTime();
  }

  const tomorrow = text.match(/besok.{0,15}(\d{1,2})[:\.](\d{2})/i);
  if (tomorrow) {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(parseInt(tomorrow[1]), parseInt(tomorrow[2]), 0, 0);
    return t.getTime();
  }

  return null;
}

function addReminder(jid, senderJid, rawText, tenantId) {
  const content = rawText
    .replace(/ingatkan?\s*(aku|saya|me)?/gi, '')
    .replace(/\bremind\s*(me)?\b/gi, '')
    .replace(/tolong\b/gi, '')
    .trim();

  const targetMs = parseTime(content);
  if (!targetMs) return { ok: false };

  const msg = content
    .replace(/dalam\s+\d+\s*(menit|jam|min|hour|hr)/gi, '')
    .replace(/(?:jam|pukul|at)\s+\d{1,2}[:\.]?\d{0,2}/gi, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/besok/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || 'waktunya!';

  const senderPhone = senderJid.split('@')[0].split(':')[0];
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const r = { id, jid, senderJid, senderPhone, message: msg, targetMs, tenantId: tenantId || 'default' };
  _schedule(r);
  _save(tenantId);

  const when = new Date(targetMs).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return { ok: true, when, msg };
}

function listReminders(jid, tenantId) {
  return pending.filter(r => r.jid === jid && (r.tenantId || 'default') === (tenantId || 'default'));
}

module.exports = { init, addReminder, listReminders, parseTime };
