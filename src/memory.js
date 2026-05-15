'use strict';

/**
 * Persistent conversation history backed by nano-memory (semantic).
 * Falls back to JSON files if nano-memory sidecar is unavailable.
 */

const fs   = require('fs');
const path = require('path');

const MAX_TURNS = 10;

// ── Fallback: JSON file storage (same as original) ────────────
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

function _loadJson(tenantId, groupJid, senderJid) {
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

function _persistJson(tenantId, groupJid, senderJid, hist) {
  try {
    const p = _historyPath(tenantId, groupJid, senderJid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(hist));
    const key = `${tenantId}::${groupJid}::${senderJid}`;
    _cache.set(key, hist);
  } catch {}
}

// ── Namespace builder ─────────────────────────────────────────
function _ns(tenantId, groupJid, senderJid) {
  return `${tenantId || 'default'}::${groupJid}::${senderJid}`;
}

// ── addTurn ────────────────────────────────────────────────────
async function addTurn(groupJid, senderJid, userMsg, botReply, tenantId) {
  const tid = tenantId || 'default';

  // Always keep JSON fallback in sync (fast, local)
  const hist = _loadJson(tid, groupJid, senderJid);
  hist.push({ role: 'user',      content: userMsg  });
  hist.push({ role: 'assistant', content: botReply });
  if (hist.length > MAX_TURNS * 2) hist.splice(0, hist.length - MAX_TURNS * 2);
  _persistJson(tid, groupJid, senderJid, hist);

  // Also store in nano-memory for semantic recall
  try {
    const { nanoMemory } = require('./nano');
    if (nanoMemory.isAvailable()) {
      const ns = _ns(tid, groupJid, senderJid);
      await nanoMemory.add(ns, 'user',      userMsg);
      await nanoMemory.add(ns, 'assistant', botReply);
    }
  } catch {}
}

// ── getHistory ────────────────────────────────────────────────
function getHistory(groupJid, senderJid, tenantId) {
  // Always return from JSON (sequential context, fast)
  return _loadJson(tenantId || 'default', groupJid, senderJid);
}

// ── semanticRecall: find relevant past turns for a query ──────
async function semanticRecall(groupJid, senderJid, query, tenantId, topK = 5) {
  try {
    const { nanoMemory } = require('./nano');
    if (!nanoMemory.isAvailable()) return [];
    const ns = _ns(tenantId || 'default', groupJid, senderJid);
    const results = await nanoMemory.recall(ns, query, topK);
    return results.map(r => r.text);
  } catch { return []; }
}

// ── clearHistory ──────────────────────────────────────────────
async function clearHistory(groupJid, senderJid, tenantId) {
  const tid = tenantId || 'default';
  const key = `${tid}::${groupJid}::${senderJid}`;
  _cache.delete(key);
  try {
    const p = _historyPath(tid, groupJid, senderJid);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}

  try {
    const { nanoMemory } = require('./nano');
    if (nanoMemory.isAvailable()) {
      await nanoMemory.clear(_ns(tid, groupJid, senderJid));
    }
  } catch {}
}

// ── clearAll ──────────────────────────────────────────────────
async function clearAll(tenantId) {
  const tid = tenantId || 'default';
  for (const k of [..._cache.keys()]) {
    if (k.startsWith(tid + '::')) _cache.delete(k);
  }
  try {
    const { tenantPaths } = require('./tenant');
    const histDir = path.join(tenantPaths(tid).dir, 'history');
    if (fs.existsSync(histDir)) {
      for (const f of fs.readdirSync(histDir)) {
        try { fs.unlinkSync(path.join(histDir, f)); } catch {}
      }
    }
  } catch {}
}

// ── listGroupsWithHistory ─────────────────────────────────────
function listGroupsWithHistory(tenantId) {
  try {
    const { tenantPaths } = require('./tenant');
    const histDir = path.join(tenantPaths(tenantId || 'default').dir, 'history');
    if (!fs.existsSync(histDir)) return [];
    const files = fs.readdirSync(histDir).filter(f => f.endsWith('.json'));
    const groups = new Set();
    for (const f of files) {
      const jid = f.split('__')[0].replace(/_g_us$/, '@g.us').replace(/_c_us$/, '@c.us');
      groups.add(jid);
    }
    return [...groups];
  } catch { return []; }
}

module.exports = { addTurn, getHistory, semanticRecall, clearHistory, clearAll, listGroupsWithHistory };
