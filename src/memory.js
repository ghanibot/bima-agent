'use strict';

/**
 * Persistent conversation history per user per group/DM.
 * Key: `${groupJid}::${senderJid}`
 * Stored to disk so history survives restarts.
 */

const fs   = require('fs');
const path = require('path');

const MAX_TURNS = 10; // pairs per user per context

// In-memory cache
const _cache = new Map();

function _historyPath(tenantId, groupJid, senderJid) {
  const { tenantPaths } = require('./tenant');
  const safeGroup  = groupJid.replace(/[^a-zA-Z0-9]/g, '_');
  const safeSender = senderJid.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(
    tenantPaths(tenantId || 'default').dir,
    'history',
    `${safeGroup}__${safeSender}.json`
  );
}

function _load(tenantId, groupJid, senderJid) {
  const key = `${tenantId}::${groupJid}::${senderJid}`;
  if (_cache.has(key)) return _cache.get(key);
  try {
    const p = _historyPath(tenantId, groupJid, senderJid);
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    _cache.set(key, data);
    return data;
  } catch { return []; }
}

function _persist(tenantId, groupJid, senderJid, hist) {
  try {
    const p = _historyPath(tenantId, groupJid, senderJid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(hist));
  } catch {}
}

function addTurn(groupJid, senderJid, userMsg, botReply, tenantId) {
  const tid  = tenantId || 'default';
  const key  = `${tid}::${groupJid}::${senderJid}`;
  const hist = _load(tid, groupJid, senderJid);

  hist.push({ role: 'user',      content: userMsg  });
  hist.push({ role: 'assistant', content: botReply });

  if (hist.length > MAX_TURNS * 2) {
    hist.splice(0, hist.length - MAX_TURNS * 2);
  }

  _cache.set(key, hist);
  _persist(tid, groupJid, senderJid, hist);
}

function getHistory(groupJid, senderJid, tenantId) {
  return _load(tenantId || 'default', groupJid, senderJid);
}

function clearHistory(groupJid, senderJid, tenantId) {
  const tid = tenantId || 'default';
  const key = `${tid}::${groupJid}::${senderJid}`;
  _cache.delete(key);
  try {
    const p = _historyPath(tid, groupJid, senderJid);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function clearAll(tenantId) {
  const tid = tenantId || 'default';
  for (const k of [..._cache.keys()]) {
    if (k.startsWith(tid + '::')) _cache.delete(k);
  }
  try {
    const { tenantPaths } = require('./tenant');
    const histDir = path.join(tenantPaths(tid).dir, 'history');
    if (fs.existsSync(histDir)) {
      for (const f of fs.readdirSync(histDir)) {
        fs.unlinkSync(path.join(histDir, f));
      }
    }
  } catch {}
}

// Get all group JIDs that have history for a tenant
function listGroupsWithHistory(tenantId) {
  try {
    const { tenantPaths } = require('./tenant');
    const histDir = path.join(tenantPaths(tenantId || 'default').dir, 'history');
    if (!fs.existsSync(histDir)) return [];
    const files = fs.readdirSync(histDir).filter(f => f.endsWith('.json'));
    const groups = new Set();
    for (const f of files) {
      // filename: safeGroup__safeSender.json
      const groupPart = f.split('__')[0];
      // Reconstruct JID (best effort)
      const jid = groupPart.replace(/_g_us$/, '@g.us').replace(/_c_us$/, '@c.us');
      groups.add(jid);
    }
    return [...groups];
  } catch { return []; }
}

module.exports = { addTurn, getHistory, clearHistory, clearAll, listGroupsWithHistory };
