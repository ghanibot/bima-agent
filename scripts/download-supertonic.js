#!/usr/bin/env node
'use strict';

// Download Supertonic-3 model assets from Hugging Face into ~/.bima/supertonic/assets/
// Files:
//   onnx/duration_predictor.onnx (3.7 MB)
//   onnx/text_encoder.onnx       (36 MB)
//   onnx/tts.json                (8 KB)
//   onnx/unicode_indexer.json    (277 KB)
//   onnx/vector_estimator.onnx   (256 MB)  ← big
//   onnx/vocoder.onnx            (101 MB)  ← big
//   voice_styles/F1..F5,M1..M5   (~3 MB total)
//
// Run once: node scripts/download-supertonic.js

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');

const REPO   = 'Supertone/supertonic-3';
const BASE   = `https://huggingface.co/${REPO}/resolve/main`;
const TARGET = path.join(
  process.env.BIMA_DATA || path.join(os.homedir(), '.bima'),
  'supertonic', 'assets'
);

const FILES = [
  'onnx/duration_predictor.onnx',
  'onnx/text_encoder.onnx',
  'onnx/tts.json',
  'onnx/unicode_indexer.json',
  'onnx/vector_estimator.onnx',
  'onnx/vocoder.onnx',
  'voice_styles/F1.json', 'voice_styles/F2.json', 'voice_styles/F3.json', 'voice_styles/F4.json', 'voice_styles/F5.json',
  'voice_styles/M1.json', 'voice_styles/M2.json', 'voice_styles/M3.json', 'voice_styles/M4.json', 'voice_styles/M5.json',
];

function bytes(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n > 1024)        return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
      return resolve({ skipped: true, size: fs.statSync(dest).size });
    }

    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'bima-agent/1.0' } }, (res) => {
      // Handle redirects (301/302/303/307/308) — absolute or relative Location
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close(); try { fs.unlinkSync(dest); } catch {}
        let loc = res.headers.location;
        if (!loc) return reject(new Error(`${res.statusCode} but no Location header`));
        if (loc.startsWith('/')) loc = new URL(loc, url).toString();
        return resolve(download(loc, dest));
      }
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      let lastPct    = -1;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total) {
          const pct = Math.floor((downloaded / total) * 100);
          if (pct % 10 === 0 && pct !== lastPct) {
            process.stdout.write(`  ${pct}%`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve({ size: downloaded }); });
    });
    req.on('error', reject);
  });
}

(async () => {
  console.log(`Target: ${TARGET}`);
  console.log(`Source: huggingface.co/${REPO}`);
  console.log(`Files:  ${FILES.length} (~400 MB total)`);
  console.log('');

  let totalBytes = 0;
  for (let i = 0; i < FILES.length; i++) {
    const rel  = FILES[i];
    const url  = `${BASE}/${rel}`;
    const dest = path.join(TARGET, rel);
    process.stdout.write(`[${i + 1}/${FILES.length}] ${rel} `);
    try {
      const r = await download(url, dest);
      if (r.skipped) console.log(`(skip, sudah ada — ${bytes(r.size)})`);
      else           console.log(`✓ ${bytes(r.size)}`);
      totalBytes += r.size;
    } catch (e) {
      console.log(`✗ ${e.message}`);
      process.exit(1);
    }
  }

  console.log('');
  console.log(`✓ Selesai. Total: ${bytes(totalBytes)}`);
  console.log(`Set provider: tts.json → "provider": "supertonic"`);
})();
