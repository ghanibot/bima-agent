'use strict';

/**
 * Nano Sidecar Manager
 * Spawns nano-proxy (port 8765) + nano-sidecar (port 8769: memory + guard).
 * Falls back gracefully if Python / packages unavailable.
 */

const { spawn }    = require('child_process');
const path         = require('path');
const os           = require('os');
const http         = require('http');

const SIDECAR_PORT = 8769;
const PROXY_PORT   = 8765;
const SIDECAR_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'nano_sidecar.py');

let _sidecarProc  = null;
let _proxyProc    = null;
let _sidecarReady = false;
let _proxyReady   = false;
let _logFn        = () => {};

// ── Python binary detection ────────────────────────────────────
function _findPython() {
  const candidates = [
    'C:/Users/USER/AppData/Local/Programs/Python/Python312/python.exe',
    'python3',
    'python',
  ];
  const { execFileSync } = require('child_process');
  for (const py of candidates) {
    try {
      const out = execFileSync(py, ['--version'], { timeout: 3000, stdio: 'pipe' }).toString();
      if (out.includes('Python 3')) return py;
    } catch {}
  }
  return null;
}

// ── HTTP health check ──────────────────────────────────────────
function _ping(port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function _waitReady(port, retries = 12, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    if (await _ping(port)) return true;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// ── Start nano sidecar (memory + guard) ───────────────────────
async function _startSidecar(python) {
  if (_sidecarReady) return true;

  // Check if already running from a previous session
  if (await _ping(SIDECAR_PORT, 500)) {
    _sidecarReady = true;
    return true;
  }

  const env = {
    ...process.env,
    NANO_SIDECAR_PORT: String(SIDECAR_PORT),
    NANO_SIDECAR_HOST: '127.0.0.1',
  };

  _sidecarProc = spawn(python, [SIDECAR_SCRIPT], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  _sidecarProc.stdout.on('data', d => _logFn('DEBUG', `[nano-sidecar] ${d.toString().trim()}`));
  _sidecarProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg && !msg.includes('INFO') && !msg.includes('Uvicorn')) {
      _logFn('DEBUG', `[nano-sidecar] ${msg}`);
    }
  });

  _sidecarProc.on('exit', (code) => {
    _sidecarReady = false;
    if (code !== 0 && code !== null) {
      _logFn('WARN', `nano-sidecar exited (code ${code})`);
    }
  });

  const ok = await _waitReady(SIDECAR_PORT, 15, 1000);
  _sidecarReady = ok;
  if (ok) _logFn('INFO', `nano-sidecar ready (port ${SIDECAR_PORT})`);
  else     _logFn('WARN', 'nano-sidecar tidak bisa start — memory & guard fallback aktif');
  return ok;
}

// ── Start nano-proxy ───────────────────────────────────────────
async function _startProxy(python) {
  if (_proxyReady) return true;

  if (await _ping(PROXY_PORT, 500)) {
    _proxyReady = true;
    return true;
  }

  // nano-proxy needs NANO_PATHS injected via PYTHONPATH
  const nanoPaths = [
    path.join(os.homedir(), 'Desktop', 'github projects', 'nano-proxy'),
    path.join(os.homedir(), 'Desktop', 'github projects', 'nano-memory'),
    path.join(os.homedir(), 'Desktop', 'github projects', 'nano-guard'),
  ].join(path.delimiter);

  const proxyScript = path.join(os.homedir(), 'Desktop', 'github projects', 'nano-proxy', 'nano_proxy', '__main__.py');

  const env = {
    ...process.env,
    PYTHONPATH: nanoPaths + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
  };

  _proxyProc = spawn(python, [proxyScript, 'start', '--port', String(PROXY_PORT), '--host', '127.0.0.1'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  _proxyProc.stdout.on('data', d => _logFn('DEBUG', `[nano-proxy] ${d.toString().trim()}`));
  _proxyProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg && !msg.includes('INFO') && !msg.includes('Uvicorn') && !msg.includes('Started')) {
      _logFn('DEBUG', `[nano-proxy] ${msg}`);
    }
  });

  _proxyProc.on('exit', (code) => {
    _proxyReady = false;
    if (code !== 0 && code !== null) _logFn('WARN', `nano-proxy exited (code ${code})`);
  });

  const ok = await _waitReady(PROXY_PORT, 12, 1000);
  _proxyReady = ok;
  if (ok) _logFn('INFO', `nano-proxy ready (port ${PROXY_PORT})`);
  else     _logFn('WARN', 'nano-proxy tidak bisa start — AI calls langsung ke provider');
  return ok;
}

// ── Public: start all ─────────────────────────────────────────
async function startNano(logger) {
  _logFn = logger || _logFn;

  const python = _findPython();
  if (!python) {
    _logFn('WARN', 'Python tidak ditemukan — nano features dinonaktifkan');
    return { sidecar: false, proxy: false };
  }

  _logFn('INFO', `Python ditemukan: ${python}`);

  const [sidecar, proxy] = await Promise.all([
    _startSidecar(python),
    _startProxy(python),
  ]);

  return { sidecar, proxy };
}

// ── Graceful shutdown ─────────────────────────────────────────
function stopNano() {
  if (_sidecarProc) { try { _sidecarProc.kill('SIGTERM'); } catch {} _sidecarProc = null; }
  if (_proxyProc)   { try { _proxyProc.kill('SIGTERM');   } catch {} _proxyProc   = null; }
  _sidecarReady = false;
  _proxyReady   = false;
}

process.on('exit', stopNano);
process.on('SIGINT',  () => { stopNano(); process.exit(0); });
process.on('SIGTERM', () => { stopNano(); process.exit(0); });

// ── HTTP helper for Node.js → sidecar calls ───────────────────
function _request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 5000,
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Nano Memory API (called by memory.js) ─────────────────────
const nanoMemory = {
  isAvailable: () => _sidecarReady,

  async add(namespace, role, content) {
    await _request(SIDECAR_PORT, 'POST', '/memory/add', { namespace, role, content });
  },

  async history(namespace, limit = 20) {
    const r = await _request(SIDECAR_PORT, 'GET', `/memory/history?namespace=${encodeURIComponent(namespace)}&limit=${limit}`);
    return r.history || [];
  },

  async recall(namespace, query, topK = 5) {
    const r = await _request(SIDECAR_PORT, 'GET',
      `/memory/recall?namespace=${encodeURIComponent(namespace)}&query=${encodeURIComponent(query)}&top_k=${topK}`);
    return r.results || [];
  },

  async clear(namespace) {
    await _request(SIDECAR_PORT, 'DELETE', `/memory/clear?namespace=${encodeURIComponent(namespace)}`);
  },
};

// ── Nano Guard API (called by whatsapp.js) ────────────────────
const nanoGuard = {
  isAvailable: () => _sidecarReady,

  async scan(text) {
    try {
      const r = await _request(SIDECAR_PORT, 'POST', '/guard/scan', { text });
      return r;
    } catch {
      return { blocked: false, categories: [], redacted_text: text, scan_ms: 0 };
    }
  },
};

// ── Nano Proxy: build URL for provider ────────────────────────
const nanoProxy = {
  isAvailable: () => _proxyReady,
  getPort: () => PROXY_PORT,
  url: (provider) => `http://127.0.0.1:${PROXY_PORT}/${provider}`,
};

module.exports = { startNano, stopNano, nanoMemory, nanoGuard, nanoProxy };
