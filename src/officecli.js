'use strict';

/**
 * Integration with OfficeCLI (https://github.com/iOfficeAI/OfficeCLI).
 * OfficeCLI must be installed: npm install -g officecli  OR  npx officecli
 * Allows Bima to create/read/edit Excel, Word, PowerPoint files.
 */

const { execFile } = require('child_process');
const fs           = require('fs');
const path         = require('path');

function resolveOfficeCLI() {
  // Try global install first, fall back to npx
  return new Promise(resolve => {
    execFile('officecli', ['--version'], { timeout: 5000 }, (err) => {
      resolve(err ? 'npx' : 'officecli');
    });
  });
}

/**
 * Run an OfficeCLI command.
 * @param {string[]} args  - CLI arguments array, e.g. ['excel', 'create', '--output', 'file.xlsx', '--data', '[...]']
 * @param {string}   cwd   - working directory (usually tenant files dir)
 * @returns {Promise<string>} stdout/stderr combined
 */
async function runOfficeCLI(args, cwd) {
  const bin = await resolveOfficeCLI();
  const cmd  = bin === 'npx' ? 'npx' : 'officecli';
  const argv = bin === 'npx' ? ['officecli', ...args] : args;

  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { cwd: cwd || process.cwd(), timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve((stdout + (stderr ? '\n' + stderr : '')).trim());
    });
  });
}

/**
 * High-level: manipulate Office file based on natural language command string.
 * command examples:
 *   "buat excel dengan data penjualan bulan ini, kolom: tanggal,produk,jumlah"
 *   "tambah sheet baru di file laporan.xlsx"
 *   "baca file data.xlsx dan tampilkan semua baris"
 *   "edit word file surat.docx, ganti judul jadi 'Laporan Q2'"
 *
 * This function parses the command and maps it to OfficeCLI CLI args.
 */
async function officeCommand(command, filesDir) {
  const cmd = String(command || '').toLowerCase();

  // ── Read / extract text ──────────────────────────────────────
  const readMatch = cmd.match(/\b(baca|read|tampilkan|lihat|isi|konten)\b.*\b([\w.\-]+\.(xlsx?|docx?|pptx?|csv))\b/i)
    || command.match(/\b([\w.\-]+\.(xlsx?|docx?|pptx?|csv))\b/i);

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

  // ── OfficeCLI manipulation commands ─────────────────────────
  // Forward the raw command to OfficeCLI via its CLI flags
  // Format expected: "officecli <subcommand> [args]"
  // We expose this directly so AI can pass structured commands.
  try {
    const args = parseCommandString(command);
    const result = await runOfficeCLI(args, filesDir);
    return result || 'Perintah berhasil dijalankan (tidak ada output).';
  } catch (e) {
    return `OfficeCLI error: ${e.message}`;
  }
}

// Simple shell-like tokenizer
function parseCommandString(str) {
  const tokens = [];
  let current  = '';
  let inQuote  = false;
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
