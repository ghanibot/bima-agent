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

// ── Template fill (docx via docxtemplater, xlsx via cell regex) ──
// Fills `{{placeholder}}` markers in an existing template file with values from `data`.
// Produces a NEW file in filesDir (template stays intact).
//   templateName: basename of file inside filesDir (e.g. "surat_template.docx")
//   data:         object mapping placeholder name → value
//   opts:         { outputName?, overwrite? }
// Returns: { path, outputName }
async function fillTemplate(templateName, data, filesDir, opts = {}) {
  if (!templateName) throw new Error('Nama template kosong');
  if (!data || typeof data !== 'object') throw new Error('data harus object placeholder→nilai');

  // Anti-traversal — only basename allowed
  const safeTpl = safeName(templateName);
  const tplPath = path.join(filesDir, safeTpl);
  if (!fs.existsSync(tplPath)) {
    throw new Error(`File template "${templateName}" tidak ditemukan`);
  }

  const ext = path.extname(safeTpl).toLowerCase();
  if (ext !== '.docx' && ext !== '.xlsx') {
    throw new Error('Template fill mendukung .docx dan .xlsx saja');
  }

  // Build output name
  const stem = safeTpl.slice(0, safeTpl.length - ext.length);
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultOut = `${stem}_filled_${ts}${ext}`;
  const outName = safeName(opts.outputName || defaultOut);
  // Ensure correct extension on user-supplied outputName
  const outExt = path.extname(outName).toLowerCase();
  const finalOutName = outExt === ext ? outName : `${outName}${ext}`;

  const outPath = resolveTarget(finalOutName, filesDir, {
    overwrite: opts.overwrite === true,
  });

  // Normalize values to strings (docxtemplater needs strings/primitives)
  const flatData = {};
  for (const [k, v] of Object.entries(data)) {
    flatData[k] = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  }

  if (ext === '.docx') {
    const PizZip       = require('pizzip');
    const Docxtemplater = require('docxtemplater');

    const content = fs.readFileSync(tplPath, 'binary');
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks:    true,
      delimiters:    { start: '{{', end: '}}' },
    });

    try {
      doc.render(flatData);
    } catch (e) {
      // docxtemplater multi-error: include first explanation
      const msg = e.properties?.errors?.[0]?.properties?.explanation || e.message;
      throw new Error(`Gagal isi template docx: ${msg}`);
    }

    const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(outPath, buf);
  } else {
    // xlsx — read every sheet, regex-replace {{key}} in string cells
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(tplPath);
    const re = /\{\{(\w+)\}\}/g;

    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      for (const addr of Object.keys(ws)) {
        if (addr.startsWith('!')) continue; // metadata key
        const cell = ws[addr];
        if (!cell || typeof cell.v !== 'string') continue;
        if (!re.test(cell.v)) { re.lastIndex = 0; continue; }
        re.lastIndex = 0;
        const replaced = cell.v.replace(re, (m, key) =>
          Object.prototype.hasOwnProperty.call(flatData, key) ? flatData[key] : m
        );
        cell.v = replaced;
        cell.t = 's';
        if (cell.w !== undefined) delete cell.w; // clear cached formatted text
      }
    }

    XLSX.writeFile(wb, outPath);
  }

  return { path: outPath, outputName: path.basename(outPath) };
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
  fillTemplate,
  listFiles,
  findFile,
  safeName,
};
