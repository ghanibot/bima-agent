'use strict';

let _pipeline = null;
let _loading  = false;
let _waiters  = [];
let _disabled = false; // true when ONNX unavailable (ARM/Termux fallback)

async function getPipeline() {
  if (_disabled) throw new Error('Semantic embedding tidak tersedia di platform ini (ONNX tidak didukung).');
  if (_pipeline) return _pipeline;

  if (_loading) {
    return new Promise((res, rej) => _waiters.push({ res, rej }));
  }

  _loading = true;
  try {
    const { pipeline, env } = await import('@xenova/transformers');
    const os   = require('os');
    const path = require('path');
    env.cacheDir = process.env.BIMA_DATA
      ? path.join(process.env.BIMA_DATA, 'models')
      : path.join(os.homedir(), '.bima', 'models');

    _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    });

    _waiters.forEach(w => w.res(_pipeline));
    _waiters = [];
    return _pipeline;
  } catch (e) {
    _loading  = false;
    _disabled = true;
    _waiters.forEach(w => w.rej(e));
    _waiters = [];
    throw e;
  }
}

async function embed(text) {
  const pipe   = await getPipeline();
  const output = await pipe(text.slice(0, 512), { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function isReady()     { return !!_pipeline && !_disabled; }
function isAvailable() { return !_disabled; }

module.exports = { embed, cosine, isReady, isAvailable, getPipeline };
