'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

function ltmPath(tenantId) {
  const { tenantPaths } = require('./tenant');
  return tenantPaths(tenantId || 'default').ltm;
}

function load(tenantId) {
  try {
    const p = ltmPath(tenantId);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function save(data, tenantId) {
  const p = ltmPath(tenantId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function remember(content, source, tenantId) {
  if (!content?.trim()) return null;
  const db = load(tenantId);

  const lower = content.toLowerCase();
  if (db.some(m => m.content.toLowerCase() === lower)) return null;

  const id = crypto.randomBytes(4).toString('hex');
  db.push({ id, content: content.trim(), source: source || '', timestamp: new Date().toISOString() });
  save(db, tenantId);
  return id;
}

function recall(query, limit = 5, tenantId) {
  const db = load(tenantId);
  if (!db.length) return [];

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = db.map(m => {
    const text  = m.content.toLowerCase();
    const score = words.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
    return { m, score };
  });

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.m);
}

function getAll(tenantId) { return load(tenantId); }

function deleteMemory(id, tenantId) {
  const db  = load(tenantId);
  const idx = db.findIndex(m => m.id === id);
  if (idx === -1) return false;
  db.splice(idx, 1);
  save(db, tenantId);
  return true;
}

function clearAll(tenantId) {
  save([], tenantId);
}

module.exports = { remember, recall, getAll, deleteMemory, clearAll };
