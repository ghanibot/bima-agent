'use strict';

const fs   = require('fs');
const path = require('path');

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function saveFile(buffer, originalName, tenantId) {
  const { tenantPaths } = require('./tenant');
  const filesDir = tenantPaths(tenantId || 'default').files;
  fs.mkdirSync(filesDir, { recursive: true });
  const ext  = path.extname(originalName) || '.bin';
  const name = `${Date.now()}_${originalName.replace(/[^\w._-]/g, '_')}`;
  const dest = path.join(filesDir, name);
  fs.writeFileSync(dest, buffer);
  return { filePath: dest, fileName: name };
}

async function extractText(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  try {
    if (ext === '.pdf')               return await extractPDF(filePath);
    if (['.xlsx', '.xls'].includes(ext)) return await extractExcel(filePath);
    if (ext === '.docx')              return await extractWord(filePath);
    if (['.txt', '.csv', '.md'].includes(ext)) return fs.readFileSync(filePath, 'utf8');
    return null;
  } catch (e) {
    return `[Gagal ekstrak: ${e.message}]`;
  }
}

async function extractPDF(fp) {
  const parse = require('pdf-parse');
  const d = await parse(fs.readFileSync(fp));
  return d.text;
}

async function extractExcel(fp) {
  const XLSX = require('xlsx');
  const wb   = XLSX.readFile(fp);
  return wb.SheetNames
    .map(s => `=== ${s} ===\n${XLSX.utils.sheet_to_csv(wb.Sheets[s])}`)
    .join('\n\n');
}

async function extractWord(fp) {
  const m = require('mammoth');
  const r = await m.extractRawText({ buffer: fs.readFileSync(fp) });
  return r.value;
}

function checkSize(bytes) { return bytes <= MAX_BYTES; }

module.exports = { saveFile, extractText, checkSize };
