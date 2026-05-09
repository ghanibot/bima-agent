'use strict';

// Speech-to-Text
// Providers:
//   openai  — OpenAI Whisper API
//   groq    — Groq Whisper API (faster, cheaper)
//   hf      — HuggingFace Inference API (e.g. indonesian-nlp/multilingual-asr)
//
// WhatsApp voice notes arrive as OGG/OPUS

async function transcribe(audioBuffer, cfg) {
  const { provider, apiKey, sttKey, sttProvider, sttModel } = cfg;

  const effectiveProvider = sttProvider || (provider === 'openai' ? 'openai' : null);
  const effectiveKey      = sttKey || (effectiveProvider === 'openai' ? apiKey : null);

  if (!effectiveProvider) {
    throw new Error('STT belum dikonfigurasi. Ketik /stt di terminal.');
  }
  // local provider tidak butuh API key
  if (effectiveProvider !== 'local' && !effectiveKey) {
    throw new Error('STT belum dikonfigurasi. Ketik /stt di terminal.');
  }

  if (effectiveProvider === 'local') {
    return transcribeLocal(audioBuffer, sttModel);
  }

  if (effectiveProvider === 'hf') {
    return transcribeHF(audioBuffer, effectiveKey, sttModel);
  }

  return transcribeWhisper(audioBuffer, effectiveKey, effectiveProvider);
}

// ── HuggingFace Inference API ─────────────────────────────────
// Sends raw audio bytes; model returns { text } or [{ generated_text }]
async function transcribeHF(audioBuffer, hfToken, modelId) {
  const model = modelId || 'indonesian-nlp/multilingual-asr';
  const url   = `https://api-inference.huggingface.co/models/${model}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${hfToken}`,
      'Content-Type':  'audio/ogg',
    },
    body:   audioBuffer,
    signal: AbortSignal.timeout(60_000), // HF cold-start bisa lambat
  });

  // HF returns 503 when model is loading (cold start) — retry once
  if (res.status === 503) {
    await new Promise(r => setTimeout(r, 8000));
    const retry = await fetch(url, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${hfToken}`, 'Content-Type': 'audio/ogg' },
      body:    audioBuffer,
      signal:  AbortSignal.timeout(60_000),
    });
    return parseHFResponse(await retry.json(), retry.ok);
  }

  const data = await res.json();
  return parseHFResponse(data, res.ok);
}

function parseHFResponse(data, ok) {
  if (!ok) {
    const err = data?.error || JSON.stringify(data);
    throw new Error(`HF API error: ${err}`);
  }
  // ASR models return: { text: "..." } or [{ generated_text: "..." }]
  if (data?.text)             return data.text.trim();
  if (Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text.trim();
  if (typeof data === 'string') return data.trim();
  throw new Error(`Format respons HF tidak dikenal: ${JSON.stringify(data).slice(0, 100)}`);
}

// ── OpenAI / Groq Whisper ─────────────────────────────────────
async function transcribeWhisper(audioBuffer, apiKey, provider) {
  const url = provider === 'groq'
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';

  const formData = new FormData();
  const blob     = new Blob([audioBuffer], { type: 'audio/ogg' });
  formData.append('file',            blob, 'voice.ogg');
  formData.append('model',           provider === 'groq' ? 'whisper-large-v3' : 'whisper-1');
  formData.append('language',        'id');
  formData.append('response_format', 'json');

  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body:    formData,
    signal:  AbortSignal.timeout(30_000),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`${provider} STT ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
  return (data.text || '').trim();
}

// ── ffmpeg path — prefer ffmpeg-static, fall back to system ffmpeg ──
function getFfmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p) return p;
  } catch {}
  return 'ffmpeg';
}

// ── Local Whisper via @xenova/transformers ────────────────────
// First call downloads model (~75MB tiny / ~300MB small) — cached forever after
let _localPipeline = null;

async function transcribeLocal(audioBuffer, modelId) {
  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  const ffmpegPath = getFfmpegPath();

  const model = modelId || 'Xenova/whisper-tiny';

  // Write OGG to tmp file
  const tmpIn = path.join(os.tmpdir(), `bima_in_${Date.now()}.ogg`);
  fs.writeFileSync(tmpIn, audioBuffer);

  // Use ffmpeg to decode OGG → raw PCM s16le at 16kHz mono
  // Output to stdout as raw bytes — no tmp WAV file needed
  const pcmBuffer = await new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn(ffmpegPath, [
      '-i', tmpIn,
      '-ar', '16000',   // 16kHz sample rate (Whisper requirement)
      '-ac', '1',       // mono
      '-f', 's16le',    // signed 16-bit little-endian PCM
      'pipe:1',         // output to stdout
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    proc.stdout.on('data', chunk => chunks.push(chunk));
    proc.on('close', code => {
      try { fs.unlinkSync(tmpIn); } catch {}
      if (code !== 0 && chunks.length === 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    proc.on('error', e => { try { fs.unlinkSync(tmpIn); } catch {} reject(e); });
  });

  // Convert s16le PCM → Float32Array (range -1.0 to 1.0)
  const samples    = pcmBuffer.length / 2; // 2 bytes per s16 sample
  const float32    = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    float32[i] = pcmBuffer.readInt16LE(i * 2) / 32768.0;
  }

  // Lazy-load pipeline (cached between calls — warm-up ~3s on first call)
  if (!_localPipeline) {
    process.env.ORT_LOGGING_LEVEL = '3'; // suppress ONNX verbose warnings
    let xenovaModule;
    try {
      xenovaModule = await import('@xenova/transformers');
    } catch {
      throw new Error(
        'Local STT tidak tersedia di platform ini (ONNX tidak terpasang).\n' +
        'Gunakan /stt dan pilih provider openai, groq, atau hf.'
      );
    }
    const { pipeline } = xenovaModule;
    _localPipeline = await pipeline('automatic-speech-recognition', model, {
      quantized: true,
    });
  }

  // Pass Float32Array directly with sampling_rate as option — no AudioContext needed
  const result = await _localPipeline(float32, {
    sampling_rate: 16000,
    language:      'indonesian',
    task:          'transcribe',
  });

  return (result?.text || '').trim();
}

module.exports = { transcribe, transcribeLocal };
