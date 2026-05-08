'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

function _watchPath(tenantId) {
  const base = process.env.BIMA_DATA || path.join(os.homedir(), '.bima');
  const dir  = path.join(base, 'tenants', tenantId || 'default');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'watches.json');
}

function _load(tenantId) {
  try {
    const p = _watchPath(tenantId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return [];
}

function _save(tenantId, data) {
  try { fs.writeFileSync(_watchPath(tenantId), JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// Add a new watch
function addWatch(tenantId, jid, topic, intervalHours = 6) {
  const watches = _load(tenantId);
  const id = crypto.randomBytes(4).toString('hex');
  watches.push({
    id,
    tenantId,
    jid,
    topic,
    intervalHours: Math.max(1, Math.min(168, intervalHours)),
    lastCheck:  null,
    lastHash:   null,
    lastResult: null,
    createdAt:  new Date().toISOString(),
  });
  _save(tenantId, watches);
  return id;
}

// Remove a watch by id
function removeWatch(tenantId, id) {
  const watches = _load(tenantId);
  const idx = watches.findIndex(w => w.id === id);
  if (idx === -1) return false;
  watches.splice(idx, 1);
  _save(tenantId, watches);
  return true;
}

// List watches for a tenant (optionally filter by jid)
function listWatches(tenantId, jid) {
  const watches = _load(tenantId);
  return jid ? watches.filter(w => w.jid === jid) : watches;
}

// Get all watches due for a check across all tenants
function getDueWatches() {
  const base = process.env.BIMA_DATA || path.join(os.homedir(), '.bima');
  const tenantsDir = path.join(base, 'tenants');
  const due = [];

  try {
    const tenants = fs.readdirSync(tenantsDir);
    for (const tid of tenants) {
      const watches = _load(tid);
      for (const w of watches) {
        const lastMs   = w.lastCheck ? new Date(w.lastCheck).getTime() : 0;
        const intervalMs = w.intervalHours * 60 * 60 * 1000;
        if (Date.now() - lastMs >= intervalMs) {
          due.push({ ...w, tenantId: tid });
        }
      }
    }
  } catch {}

  return due;
}

function _hash(text) {
  return crypto.createHash('md5').update(text || '').digest('hex');
}

// Update watch after a check
function updateWatch(tenantId, id, result) {
  const watches = _load(tenantId);
  const w = watches.find(x => x.id === id);
  if (!w) return;

  const newHash    = _hash(result);
  const changed    = w.lastHash && w.lastHash !== newHash;
  w.lastCheck      = new Date().toISOString();
  w.lastHash       = newHash;
  w.lastResult     = result?.slice(0, 500) || '';
  _save(tenantId, watches);
  return { changed, prev: w.lastResult };
}

// ── Watcher daemon ────────────────────────────────────────────
// onAlert(tenantId, jid, topic, summary) — called when change detected
let _watcherInterval = null;

function startWatcher(onAlert, webSearchFn) {
  if (_watcherInterval) return;

  async function tick() {
    const due = getDueWatches();
    for (const w of due) {
      try {
        const result = await webSearchFn(w.topic);
        if (!result) continue;

        const update = updateWatch(w.tenantId, w.id, result);
        if (update?.changed) {
          const summary =
            `🔔 *Watch Update: ${w.topic}*\n\n` +
            `${result.slice(0, 600)}\n\n` +
            `_Interval: setiap ${w.intervalHours} jam_`;
          try { await onAlert(w.tenantId, w.jid, w.topic, summary); } catch {}
        } else if (!update?.changed && !w.lastHash) {
          // First check — just record, no alert
        }
      } catch {}
    }
  }

  // Check every 15 minutes
  _watcherInterval = setInterval(tick, 15 * 60 * 1000);
  // Also run once after 30s on start
  setTimeout(tick, 30_000);
}

function stopWatcher() {
  if (_watcherInterval) { clearInterval(_watcherInterval); _watcherInterval = null; }
}

module.exports = { addWatch, removeWatch, listWatches, getDueWatches, updateWatch, startWatcher, stopWatcher };
