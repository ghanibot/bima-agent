'use strict';

const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const https        = require('https');
const { execFile } = require('child_process');

const CONFIG_PATH = path.join(
  process.env.BIMA_DATA || path.join(os.homedir(), '.bima'),
  'tts.json'
);

// Speed options (Google TTS: 0.5 slow, 1.0 normal)
const SPEED_MAP = { slow: '0.7', normal: '1', fast: '1' };

// Voice options (Google TTS = single Indonesian voice, lang code only)
const VOICE_LIST = [
  { name: 'id',    gender: 'Default', alias: 'id',   desc: 'Indonesia (Google TTS)' },
  { name: 'id',    gender: 'Slow',    alias: 'slow',  desc: 'Indonesia lambat' },
];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return { lang: 'id', slow: false, provider: 'google' };
}

function _save(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

let _cfg = loadConfig();

function setVoice(input) {
  const v = String(input || '').trim().toUpperCase();
  // Supertonic voice styles
  if (/^[MF][1-5]$/.test(v)) {
    _cfg.voiceStyle = v;
    _save(_cfg);
    return `Supertonic ${v} (${v.startsWith('M') ? 'male' : 'female'})`;
  }
  // Legacy google modes
  const lower = v.toLowerCase();
  if (lower === 'slow')   { _cfg.slow = true;  _save(_cfg); return 'Indonesia (lambat)'; }
  if (lower === 'normal') { _cfg.slow = false; _save(_cfg); return 'Indonesia (normal)'; }
  return `Pilihan: M1-M5 | F1-F5 (Supertonic) | slow | normal (Google)`;
}

function getConfig() { return { ..._cfg, VOICE_LIST }; }

// Fetch URL → Buffer
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://translate.google.com/',
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TTS request timeout')); });
  });
}

// Split text into ≤200 char chunks on sentence/word boundary
function splitChunks(text, max = 200) {
  const parts = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (candidate.length > max && cur) {
      parts.push(cur);
      cur = word;
    } else {
      cur = candidate;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// Synthesize text → MP3 buffer via Google Translate TTS (free, no key)
async function synthesizeMp3(text) {
  const lang  = _cfg.lang || 'id';
  const slow  = _cfg.slow ? '1' : '0';
  const chunks = splitChunks(text.trim(), 180);
  const buffers = [];

  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${lang}&sl=${lang}&client=tw-ob&ttsspeed=${slow === '1' ? '0.6' : '1'}`;
    const buf = await fetchBuffer(url);
    buffers.push(buf);
  }

  return Buffer.concat(buffers);
}

function _getFfmpegPath() {
  try { const p = require('ffmpeg-static'); if (p) return p; } catch {}
  return 'ffmpeg';
}

// Convert MP3 buffer → OGG Opus buffer (WhatsApp voice note format)
async function mp3ToOgg(mp3Buffer) {
  const id      = `bima_tts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpDir  = os.tmpdir();
  const mp3Path = path.join(tmpDir, `${id}.mp3`);
  const oggPath = path.join(tmpDir, `${id}.ogg`);

  try {
    fs.writeFileSync(mp3Path, mp3Buffer);
    const ffmpegPath = _getFfmpegPath();

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        '-i', mp3Path,
        '-c:a', 'libopus',
        '-b:a', '24k',
        '-ar', '24000',
        '-ac', '1',
        '-y', oggPath,
      ], (err, _stdout, stderr) => {
        if (err) reject(new Error(`ffmpeg: ${stderr?.slice(-200) || err.message}`));
        else resolve();
      });
    });

    return fs.readFileSync(oggPath);
  } finally {
    try { fs.unlinkSync(mp3Path); } catch {}
    try { fs.unlinkSync(oggPath); } catch {}
  }
}

// ── Supertonic provider (ONNX, on-device, multilingual incl. Indonesian) ──
// Install: clone https://github.com/supertone-inc/supertonic into ~/.bima/supertonic
//          cd nodejs && npm install
// We shell out to the local example_onnx.js to avoid bundling its heavy deps
// inside Bima. Outputs WAV → we convert to OGG Opus via ffmpeg.
async function synthesizeSupertonic(text) {
  const supertonicRoot = path.join(
    process.env.BIMA_DATA || path.join(os.homedir(), '.bima'),
    'supertonic'
  );
  const nodeJsDir = path.join(supertonicRoot, 'nodejs');
  const entry     = path.join(nodeJsDir, 'example_onnx.js');
  const onnxDir   = path.join(supertonicRoot, 'assets', 'onnx');
  const voicesDir = path.join(supertonicRoot, 'assets', 'voice_styles');

  if (!fs.existsSync(entry)) {
    throw new Error(
      'Supertonic belum terinstall. Setup:\n' +
      '  1) cd ' + supertonicRoot + '/..\n' +
      '  2) git clone https://github.com/supertone-inc/supertonic\n' +
      '  3) cd supertonic/nodejs && npm install\n' +
      'Pakai provider lain di tts.json (provider: "google").'
    );
  }
  if (!fs.existsSync(onnxDir)) {
    throw new Error(
      'Model Supertonic belum di-download. Run:\n' +
      '  node scripts/download-supertonic.js'
    );
  }

  const lang  = _cfg.lang || 'id';
  const voice = _cfg.voiceStyle || 'M1';
  const voiceJson = path.join(voicesDir, voice + '.json');
  if (!fs.existsSync(voiceJson)) {
    throw new Error(`Voice style "${voice}.json" tidak ada di ${voicesDir}. Pilih: M1-M5 atau F1-F5.`);
  }

  // Per-run save dir (Supertonic writes its own filename inside).
  const tmpSaveDir = path.join(os.tmpdir(), `bima_st_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpSaveDir, { recursive: true });

  await new Promise((resolve, reject) => {
    execFile('node', [entry,
      '--text', text,
      '--lang', lang,
      '--voice-style', voiceJson,
      '--onnx-dir', onnxDir,
      '--save-dir', tmpSaveDir,
      '--n-test', '1',
    ], { cwd: nodeJsDir, timeout: 120000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error('Supertonic: ' + (stderr?.slice(-300) || err.message)));
      else resolve();
    });
  });

  // Pick the first .wav file the example wrote
  const wavs = fs.readdirSync(tmpSaveDir).filter(f => f.toLowerCase().endsWith('.wav'));
  if (!wavs.length) {
    try { fs.rmSync(tmpSaveDir, { recursive: true, force: true }); } catch {}
    throw new Error('Supertonic tidak menghasilkan output WAV');
  }
  const wav = fs.readFileSync(path.join(tmpSaveDir, wavs[0]));
  try { fs.rmSync(tmpSaveDir, { recursive: true, force: true }); } catch {}
  return wav;
}

// Convert WAV → OGG Opus (voice note format)
async function wavToOgg(wavBuffer) {
  const id      = `bima_st_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpDir  = os.tmpdir();
  const wavPath = path.join(tmpDir, `${id}.wav`);
  const oggPath = path.join(tmpDir, `${id}.ogg`);
  try {
    fs.writeFileSync(wavPath, wavBuffer);
    const ffmpegPath = _getFfmpegPath();
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, ['-i', wavPath, '-c:a', 'libopus', '-b:a', '24k', '-ar', '24000', '-ac', '1', '-y', oggPath],
        (err, _stdout, stderr) => err ? reject(new Error(`ffmpeg: ${stderr?.slice(-200) || err.message}`)) : resolve());
    });
    return fs.readFileSync(oggPath);
  } finally {
    try { fs.unlinkSync(wavPath); } catch {}
    try { fs.unlinkSync(oggPath); } catch {}
  }
}

// Switch provider (google | supertonic)
function setProvider(name) {
  const p = String(name || '').toLowerCase();
  if (!['google', 'supertonic'].includes(p)) return 'Pilihan: google | supertonic';
  _cfg.provider = p;
  _save(_cfg);
  return p === 'google' ? 'Google Translate TTS (online, gratis)' : 'Supertonic ONNX (on-device, multilingual)';
}

// Main: text → OGG buffer ready to send as WhatsApp voice note
async function textToVoiceNote(text) {
  const provider = _cfg.provider || 'google';
  if (provider === 'supertonic') {
    const wav = await synthesizeSupertonic(text);
    return await wavToOgg(wav);
  }
  // Default: Google
  const mp3 = await synthesizeMp3(text);
  return await mp3ToOgg(mp3);
}

module.exports = { textToVoiceNote, setVoice, setProvider, getConfig, VOICE_LIST };
