'use strict';

// Cross-platform file creator (Windows + Linux + Mac).
// Replaces officecli (which is Linux/Mac only) for create operations.
// Supported: pdf, docx, xlsx, txt, csv, md, json

const fs   = require('fs');
const path = require('path');

// ── Path safety: prevent escape outside files dir ─────────────
function safeName(name) {
  if (!name) throw new Error('Nama file kosong');
  // Strip directories — only basename allowed
  const base = path.basename(String(name));
  // Sanitize forbidden chars
  return base.replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 200);
}

// Resolve to absolute path inside filesDir. Reject if not unique unless overwrite=true.
function resolveTarget(filename, filesDir, { overwrite = false, suffix = '' } = {}) {
  fs.mkdirSync(filesDir, { recursive: true });
  const safe = safeName(filename);
  let target = path.join(filesDir, safe);
  if (fs.existsSync(target) && !overwrite) {
    // Auto-rename with suffix instead of overwrite
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    let i = 1;
    while (fs.existsSync(target)) {
      target = path.join(filesDir, `${stem}${suffix || `_${i}`}${ext}`);
      i++;
      if (i > 100) throw new Error('Terlalu banyak file duplikat');
    }
  }
  return target;
}

// ── PDF ───────────────────────────────────────────────────────
async function createPDF(filename, content, filesDir, opts = {}) {
  const PDFDocument = require('pdfkit');
  const target = resolveTarget(
    filename.endsWith('.pdf') ? filename : `${filename}.pdf`,
    filesDir,
    opts
  );

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const stream = fs.createWriteStream(target);
      doc.pipe(stream);

      if (opts.title) {
        doc.fontSize(18).text(opts.title, { align: 'center' });
        doc.moveDown(1);
      }

      doc.fontSize(11);
      const lines = String(content || '').split('\n');
      for (const line of lines) {
        if (line.trim()) doc.text(line);
        else doc.moveDown(0.5);
      }

      doc.end();
      stream.on('finish', () => resolve(target));
      stream.on('error', reject);
    } catch (e) { reject(e); }
  });
}

// ── DOCX ──────────────────────────────────────────────────────
async function createDOCX(filename, content, filesDir, opts = {}) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const target = resolveTarget(
    filename.endsWith('.docx') ? filename : `${filename}.docx`,
    filesDir,
    opts
  );

  const children = [];
  if (opts.title) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: opts.title, bold: true, size: 36 })],
    }));
  }

  const lines = String(content || '').split('\n');
  for (const line of lines) {
    children.push(new Paragraph({
      children: [new TextRun({ text: line || ' ', size: 22 })],
    }));
  }

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(target, buf);
  return target;
}

// ── XLSX ──────────────────────────────────────────────────────
// content can be:
//   - 2D array: [['Header', 'Val'], ['a', 1]]
//   - Array of objects: [{name: 'a', age: 1}, ...]
//   - String CSV-like (one row per line, comma-separated)
async function createXLSX(filename, content, filesDir, opts = {}) {
  const XLSX = require('xlsx');
  const target = resolveTarget(
    filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`,
    filesDir,
    opts
  );

  let rows;
  if (Array.isArray(content)) {
    if (content.length && typeof content[0] === 'object' && !Array.isArray(content[0])) {
      // Array of objects
      const headers = Object.keys(content[0]);
      rows = [headers, ...content.map(o => headers.map(h => o[h] ?? ''))];
    } else {
      rows = content; // 2D array
    }
  } else if (typeof content === 'string') {
    rows = content.trim().split('\n').map(line =>
      line.split(',').map(c => {
        const trimmed = c.trim();
        const n = Number(trimmed);
        return !isNaN(n) && trimmed !== '' ? n : trimmed;
      })
    );
  } else {
    rows = [['(kosong)']];
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, opts.sheetName || 'Sheet1');
  XLSX.writeFile(wb, target);
  return target;
}

// ── Plain text / markdown / csv / json ────────────────────────
async function createText(filename, content, filesDir, opts = {}) {
  const target = resolveTarget(filename, filesDir, opts);
  fs.writeFileSync(target, String(content || ''), 'utf8');
  return target;
}

// ── High-level dispatcher ─────────────────────────────────────
// Detects file type from extension and creates accordingly.
async function createFile(filename, content, filesDir, opts = {}) {
  const ext = path.extname(filename || '').toLowerCase();

  if (ext === '.pdf' || (!ext && opts.type === 'pdf')) {
    return createPDF(filename, content, filesDir, opts);
  }
  if (ext === '.docx' || (!ext && opts.type === 'docx')) {
    return createDOCX(filename, content, filesDir, opts);
  }
  if (['.xlsx', '.xls'].includes(ext) || (!ext && opts.type === 'xlsx')) {
    return createXLSX(filename, content, filesDir, opts);
  }
  // Fallback: text file
  const safeFilename = ext ? filename : `${filename}.txt`;
  return createText(safeFilename, content, filesDir, opts);
}

// ── Edit existing file (regenerate from new content) ──────────
// Reads target, replaces with new content (saves backup of old).
async function editFile(filename, newContent, filesDir, opts = {}) {
  const target = path.join(filesDir, safeName(filename));
  if (!fs.existsSync(target)) throw new Error(`File "${filename}" tidak ditemukan`);

  // Save backup
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${target}.${ts}.bak`;
  fs.copyFileSync(target, backupPath);

  // Recreate with same name (overwrite=true) using new content
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf')                       await createPDF(filename, newContent, filesDir, { ...opts, overwrite: true });
  else if (ext === '.docx')                 await createDOCX(filename, newContent, filesDir, { ...opts, overwrite: true });
  else if (['.xlsx', '.xls'].includes(ext)) await createXLSX(filename, newContent, filesDir, { ...opts, overwrite: true });
  else                                      await createText(filename, newContent, filesDir, { ...opts, overwrite: true });

  return { path: target, backup: backupPath };
}

// ── List files in tenant files dir ────────────────────────────
function listFiles(filesDir) {
  if (!fs.existsSync(filesDir)) return [];
  return fs.readdirSync(filesDir)
    .filter(f => !f.endsWith('.bak') && !f.startsWith('.'))
    .map(f => {
      const fp = path.join(filesDir, f);
      const st = fs.statSync(fp);
      return { name: f, size: st.size, mtime: st.mtime, isFile: st.isFile() };
    })
    .filter(f => f.isFile);
}

// ── Find existing file by partial name (case-insensitive) ────
function findFile(query, filesDir) {
  const files = listFiles(filesDir);
  const q = String(query || '').toLowerCase();
  return files.find(f => f.name.toLowerCase().includes(q));
}

module.exports = {
  createFile,
  createPDF,
  createDOCX,
  createXLSX,
  createText,
  editFile,
  listFiles,
  findFile,
  safeName,
};
