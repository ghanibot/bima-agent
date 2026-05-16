'use strict';
// Quick smoke test for Supertonic TTS integration.
// Run: node scripts/test-supertonic.js "Halo, saya Bima"
//
// Verifies the full flow: synth WAV -> ffmpeg OGG conversion -> playable buffer.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const text = process.argv.slice(2).join(' ') || 'Halo, saya Bima, asisten WhatsApp Indonesia.';

(async () => {
  console.log('Text :', text);
  console.log('CWD  :', process.cwd());

  const { textToVoiceNote, getConfig } = require('./../src/tts');
  console.log('Cfg  :', getConfig());

  const t0 = Date.now();
  const buf = await textToVoiceNote(text);
  const ms = Date.now() - t0;

  const out = path.join(os.tmpdir(), `bima_st_test_${Date.now()}.ogg`);
  fs.writeFileSync(out, buf);
  console.log('OGG written:', out);
  console.log('Size       :', (buf.length / 1024).toFixed(1), 'KB');
  console.log('Took       :', ms, 'ms');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
