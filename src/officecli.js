'use strict';

/**
 * Integration with OfficeCLI (https://github.com/iOfficeAI/OfficeCLI).
 * OfficeCLI di-bundle sebagai dependency — tidak perlu install global terpisah.
 * Binary tersedia di node_modules/.bin/officecli setelah npm install.
 */

const { execFile } = require('child_process');
const fs           = require('fs');
const path         = require('path');

// Cari binary officecli: local node_modules → global PATH
function resolveOfficeCLIBin() {
  // Prioritas 1: node_modules/.bin lokal (bundled via package.json dependency)
  const localBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'officecli');
  if (fs.existsSync(localBin)) return localBin;

  // Prioritas 2: global PATH (jika sudah install -g officecli)
  return 'officecli';
}

let _cachedBin = null;

async function getBin() {
  if (_cachedBin) return _cachedBin;

  const candidate = resolveOfficeCLIBin();

  // Verifikasi bisa dijalankan
  return new Promise(resolve => {
    execFile(candidate, ['--version'], { timeout: 5000 }, (err) => {
      if (!err) {
        _cachedBin = candidate;
        resolve(candidate);
      } else {
        // Fallback: npx (tidak perlu install apapun, tapi lambat pertama kali)
        _cachedBin = null; // jangan cache npx agar re-check tiap restart
        resolve('__npx__');
      }
    });
  });
}

/**
 * Run an OfficeCLI command.
 * @param {string[]} args - CLI arguments, e.g. ['excel', 'create', '--output', 'out.xlsx']
 * @param {string}   cwd  - working directory
 */
async function runOfficeCLI(args, cwd) {
  const bin = await getBin();

  let cmd, argv;
  if (bin === '__npx__') {
    // Gunakan npx sebagai last resort
    cmd  = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    argv = ['officecli', ...args];
  } else {
    cmd  = bin;
    argv = args;
  }

  return new Promise((resolve, reject) => {
    execFile(cmd, argv, {
      cwd:       cwd || process.cwd(),
      timeout:   60_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve((stdout + (stderr ? '\n' + stderr : '')).trim());
    });
  });
}

/**
 * High-level: jalankan perintah Office dari teks natural/CLI.
 *
 * Contoh:
 *   "baca data.xlsx"
 *   "excel create --output laporan.xlsx --data '[{\"nama\":\"Apel\",\"harga\":5000}]'"
 *   "word create --output surat.docx --content 'Kepada Yth...'"
 *   "pptx create --output presentasi.pptx --slides '[{\"title\":\"Slide 1\"}]'"
 */
async function officeCommand(command, filesDir) {
  const cmdLower = String(command || '').toLowerCase();

  // ── Read / extract text (tidak perlu OfficeCLI binary) ───────
  const readMatch = cmdLower.match(/\b(baca|read|tampilkan|lihat|isi|konten)\b.*?\b([\w.\-]+\.(xlsx?|docx?|pptx?|csv|txt))\b/i)
    || command.match(/^([\w.\-]+\.(xlsx?|docx?|pptx?|csv|txt))$/i);

  if (readMatch) {
    const filename = readMatch[2] || readMatch[1];
    const filepath = path.join(filesDir, filename);
    if (!fs.existsSync(filepath)) return `File "${filename}" tidak ditemukan di direktori data.`;
    try {
      const { extractText } = require('./processor');
      const text = await extractText(filepath, filename);
      if (!text) return `Tidak bisa membaca isi "${filename}".`;
      return `*Isi file ${filename}:*\n\n${text.slice(0, 3000)}`;
    } catch (e) {
      return `Gagal membaca "${filename}": ${e.message}`;
    }
  }

  // ── OfficeCLI manipulation ────────────────────────────────────
  try {
    const args   = parseCommandString(command);
    const result = await runOfficeCLI(args, filesDir);
    return result || 'Perintah berhasil dijalankan.';
  } catch (e) {
    return `OfficeCLI error: ${e.message}`;
  }
}

// Shell-like tokenizer — handles quoted strings
function parseCommandString(str) {
  const tokens  = [];
  let current   = '';
  let inQuote   = false;
  let quoteChar = '';

  for (const ch of str.trim()) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; tokens.push(current); current = ''; }
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = true; quoteChar = ch;
    } else if (ch === ' ') {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

module.exports = { runOfficeCLI, officeCommand };
