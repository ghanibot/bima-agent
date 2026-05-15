'use strict';

/**
 * Blacklist: nomor WA yang terdeteksi prompt injection / toxic.
 * Storage: JSON file di ~/.bima/blacklist.json
 * Entry: { phone, reason, addedAt }
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const BLACKLIST_PATH = path.join(os.homedir(), '.bima', 'blacklist.json');

function _load() {
  try {
    if (!fs.existsSync(BLACKLIST_PATH)) return {};
    return JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf8'));
  } catch { return {}; }
}

function _save(data) {
  try {
    fs.mkdirSync(path.dirname(BLACKLIST_PATH), { recursive: true });
    fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

function _normalizePhone(jidOrPhone) {
  return String(jidOrPhone).split('@')[0].split(':')[0];
}

function addToBlacklist(jidOrPhone, reason) {
  const phone = _normalizePhone(jidOrPhone);
  const data  = _load();
  data[phone] = { phone, reason: reason || 'unknown', addedAt: new Date().toISOString() };
  _save(data);
}

function isBlacklisted(jidOrPhone) {
  const phone = _normalizePhone(jidOrPhone);
  const data  = _load();
  return !!data[phone];
}

function getBlacklistEntry(jidOrPhone) {
  const phone = _normalizePhone(jidOrPhone);
  return _load()[phone] || null;
}

function removeFromBlacklist(phoneInput) {
  const phone = _normalizePhone(phoneInput);
  const data  = _load();
  if (!data[phone]) return false;
  delete data[phone];
  _save(data);
  return true;
}

function listBlacklist() {
  const data = _load();
  return Object.values(data).sort((a, b) => a.addedAt < b.addedAt ? 1 : -1);
}

module.exports = { addToBlacklist, isBlacklisted, getBlacklistEntry, removeFromBlacklist, listBlacklist };
