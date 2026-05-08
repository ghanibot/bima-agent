'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Tenant-aware: all functions accept optional tenantId
function dbPath(tenantId) {
  const { tenantPaths } = require('./tenant');
  return tenantPaths(tenantId || 'default').db;
}

function filesDir(tenantId) {
  const { tenantPaths } = require('./tenant');
  return tenantPaths(tenantId || 'default').files;
}

function load(tenantId) {
  try {
    const p = dbPath(tenantId);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function save(docs, tenantId) {
  const p = dbPath(tenantId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(docs, null, 2));
}

function hash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// ── Date extraction ────────────────────────────────────────────
function extractDocDate(doc) {
  const meta = doc.structured?.meta || {};
  for (const key of ['tanggal', 'date', 'tgl', 'waktu']) {
    if (meta[key]) {
      const d = new Date(meta[key]);
      if (!isNaN(d)) return d;
    }
  }

  const name = doc.file || '';

  const iso = name.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}`);

  const dmy = name.match(/(\d{2})[-_](\d{2})[-_](\d{4})/);
  if (dmy) return new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}`);

  const MONTHS_ID = { jan:1, feb:2, mar:3, apr:4, mei:5, jun:6, jul:7, agu:8, sep:9, okt:10, nov:11, des:12 };
  const MONTHS_EN = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const named = name.toLowerCase().match(/(\d{1,2})\s*(jan|feb|mar|apr|mei|may|jun|jul|agu|aug|sep|okt|oct|nov|des|dec)/);
  if (named) {
    const day = parseInt(named[1]);
    const mon = MONTHS_ID[named[2]] || MONTHS_EN[named[2]] || 0;
    if (mon) {
      const year = new Date().getFullYear();
      return new Date(year, mon - 1, day);
    }
  }

  if (doc.timestamp) return new Date(doc.timestamp);
  return null;
}

function dateLabel(d) {
  if (!d) return '?';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

function isToday(d) {
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
         d.getMonth()    === now.getMonth() &&
         d.getDate()     === now.getDate();
}

// ── Public API ─────────────────────────────────────────────────
function getKnowledge(tenantId) { return load(tenantId); }

function saveDocument({ file, raw_text, structured }, tenantId) {
  const db  = load(tenantId);
  const h   = hash(raw_text || file);
  if (db.some(d => d.hash === h)) return { saved: false, reason: 'duplikat' };

  db.push({
    file, hash: h,
    raw_text:     raw_text || '',
    structured:   structured || {},
    timestamp:    new Date().toISOString(),
    compacted:    false,
    compact_text: null,
  });
  save(db, tenantId);
  return { saved: true, hash: h };
}

function _kwScore(words, text) {
  return words.reduce((acc, w) => {
    try { return acc + (text.toLowerCase().match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length; } catch { return acc; }
  }, 0);
}

function searchKnowledge(query, tenantId) {
  const docs = load(tenantId);
  if (!docs.length) return '';

  const q     = query.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);

  const { isReady, cosine } = require('./embed');
  const useEmbeddings = isReady();

  const scored = docs.map(doc => {
    const text  = (doc.compact_text || doc.raw_text || '') + ' ' + JSON.stringify(doc.structured || {});
    const kw    = _kwScore(words, text);
    let sem     = 0;
    if (useEmbeddings && doc.embedding) {
      // embedding of query was computed async before this call
      sem = 0; // fallback — async path via searchKnowledgeAsync
    }
    return { doc, score: kw };
  });

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(r => {
      const d = r.doc;
      let t;
      if (d.compact_text) t = d.compact_text;
      else if (d.structured && Object.keys(d.structured).length > 0) t = JSON.stringify(d.structured, null, 2);
      else t = d.raw_text || '';
      return `[Sumber: ${d.file}]\n${t.slice(0, 1500)}`;
    })
    .join('\n\n---\n\n');
}

// Async hybrid search: keyword + semantic (cosine similarity)
async function searchKnowledgeSemantic(query, tenantId) {
  const docs = load(tenantId);
  if (!docs.length) return '';

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  let queryVec = null;
  try {
    const { embed, cosine } = require('./embed');
    queryVec = await embed(query);

    // Embed docs that don't have embeddings yet (background, non-blocking for search)
    const needEmbed = docs.filter(d => !d.embedding);
    if (needEmbed.length > 0) {
      // Fire and forget — update embeddings in background
      (async () => {
        const db = load(tenantId);
        for (const doc of needEmbed) {
          try {
            const idx = db.findIndex(d => d.hash === doc.hash);
            if (idx === -1) continue;
            const text = (doc.compact_text || doc.raw_text || '').slice(0, 1024);
            db[idx].embedding = await embed(text);
          } catch {}
        }
        save(db, tenantId);
      })().catch(() => {});
    }

    const { cosine: cos } = require('./embed');
    const freshDocs = load(tenantId);

    const scored = freshDocs.map(doc => {
      const text   = (doc.compact_text || doc.raw_text || '') + ' ' + JSON.stringify(doc.structured || {});
      const kw     = _kwScore(words, text);
      const sem    = doc.embedding ? cos(queryVec, doc.embedding) : 0;
      // Hybrid: 50% semantic + 50% keyword (normalised)
      const score  = sem * 50 + Math.min(kw, 50);
      return { doc, score };
    });

    return scored
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(r => {
        const d = r.doc;
        let t;
        if (d.compact_text) t = d.compact_text;
        else if (d.structured && Object.keys(d.structured).length > 0) t = JSON.stringify(d.structured, null, 2);
        else t = d.raw_text || '';
        return `[Sumber: ${d.file}]\n${t.slice(0, 1500)}`;
      })
      .join('\n\n---\n\n');

  } catch {
    // Fall back to keyword search if embed fails
    return searchKnowledge(query, tenantId);
  }
}

function findLatestFiles(query, tenantId) {
  const docs = load(tenantId);
  if (!docs.length) return [];

  const q     = query.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean).filter(w =>
    !['terbaru', 'terlama', 'latest', 'baru', 'hari', 'ini', 'kemarin', 'lama', 'lalu'].includes(w)
  );

  let candidates = docs;

  if (words.length > 0) {
    const scored = docs.map(doc => {
      const text = doc.file.toLowerCase() + ' ' +
                   (doc.compact_text || doc.raw_text || '').toLowerCase() + ' ' +
                   JSON.stringify(doc.structured || {}).toLowerCase();
      const score = words.reduce((acc, w) => acc + (text.includes(w) ? 2 : 0), 0);
      return { doc, score };
    });
    const relevant = scored.filter(r => r.score > 0);
    if (relevant.length > 0) candidates = relevant.map(r => r.doc);
  }

  const withDate = candidates.map(doc => {
    const date = extractDocDate(doc);
    return { doc, date, isToday: isToday(date), label: dateLabel(date) };
  });

  withDate.sort((a, b) => {
    const da = a.date?.getTime() || 0;
    const db = b.date?.getTime() || 0;
    return db - da;
  });

  return withDate;
}

async function compactKnowledge(docHash, cfg, tenantId) {
  const db  = load(tenantId);
  const idx = db.findIndex(d => d.hash === docHash);
  if (idx === -1) return false;

  const doc    = db[idx];
  const rawLen = (doc.raw_text || '').length;

  try {
    const { compactContext } = require('./ai');
    const compact = await compactContext(doc.raw_text || '', doc.file, cfg);

    if (!compact || compact.length < 50) return false;
    if (rawLen > 500 && compact.length < rawLen * 0.1) return false;

    const db2  = load(tenantId);
    const idx2 = db2.findIndex(d => d.hash === docHash);
    if (idx2 === -1) return false;

    db2[idx2].compact_text = compact;
    db2[idx2].compacted    = true;
    save(db2, tenantId);
    return true;
  } catch { return false; }
}

function getDocument(fileName, tenantId) {
  const docs = load(tenantId);
  const doc  = docs.find(d => d.file === fileName) ||
               docs.find(d => d.file.toLowerCase().includes(fileName.toLowerCase()));
  if (!doc) return null;

  if (doc.compact_text) return { file: doc.file, text: doc.compact_text, hash: doc.hash };
  if (doc.structured && Object.keys(doc.structured).length > 0) {
    return { file: doc.file, text: JSON.stringify(doc.structured, null, 2), hash: doc.hash };
  }
  return { file: doc.file, text: doc.raw_text || '', hash: doc.hash };
}

function searchAllFiles(query, tenantId, maxFiles = 5) {
  const docs = load(tenantId);
  if (!docs.length) return [];

  const q     = query.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);

  const scored = docs.map(doc => {
    const text  = (doc.compact_text || doc.raw_text || '') + ' ' + JSON.stringify(doc.structured || {});
    const score = words.reduce((acc, w) => {
      try { return acc + (text.toLowerCase().match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length; } catch { return acc; }
    }, 0);
    return { doc, score };
  });

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)
    .map(r => {
      const d = r.doc;
      let t;
      if (d.compact_text) t = d.compact_text;
      else if (d.structured && Object.keys(d.structured).length > 0) t = JSON.stringify(d.structured, null, 2);
      else t = d.raw_text || '';
      return { file: d.file, hash: d.hash, text: t.slice(0, 2000), score: r.score };
    });
}

function updateDocument(docHash, patch, tenantId) {
  const db  = load(tenantId);
  const idx = db.findIndex(d => d.hash === docHash);
  if (idx === -1) return false;
  db[idx] = { ...db[idx], ...patch, updated: new Date().toISOString() };
  save(db, tenantId);
  return true;
}

function deleteDocument(docHash, tenantId) {
  const db  = load(tenantId);
  const idx = db.findIndex(d => d.hash === docHash);
  if (idx === -1) return false;
  db.splice(idx, 1);
  save(db, tenantId);
  return true;
}

function getFilesDir(tenantId) {
  return filesDir(tenantId);
}

module.exports = {
  getKnowledge, saveDocument, searchKnowledge, searchKnowledgeSemantic,
  compactKnowledge, updateDocument, deleteDocument, getDocument,
  searchAllFiles, findLatestFiles, extractDocDate, dateLabel, isToday, getFilesDir,
};
