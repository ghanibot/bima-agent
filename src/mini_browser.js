'use strict';

/**
 * mini-browser client for bima-agent.
 * Auto-starts the Python server if not running.
 */

const { spawn } = require('child_process');

const MINI_BROWSER_URL = process.env.MINI_BROWSER_URL || 'http://127.0.0.1:7842';
const TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 15_000;

let _available = null;
let _serverProcess = null;
let _starting = false;

// ── HTTP helper ───────────────────────────────────────────────

async function _request(path, body, method = 'POST') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MINI_BROWSER_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function _ping() {
  try {
    const res = await fetch(`${MINI_BROWSER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Auto-start server ─────────────────────────────────────────

async function _startServer() {
  if (_starting) return;
  _starting = true;

  try {
    // Try 'mini-browser' CLI first, then python -m fallback
    const cmds = [
      ['mini-browser', ['serve']],
      ['python', ['-m', 'mini_browser.api']],
      ['python3', ['-m', 'mini_browser.api']],
    ];

    for (const [cmd, args] of cmds) {
      try {
        const proc = spawn(cmd, args, {
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
        });

        proc.on('error', () => {});
        _serverProcess = proc;

        // Wait up to 15s for server to respond
        const deadline = Date.now() + START_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 600));
          if (await _ping()) {
            _available = true;
            _starting = false;
            return true;
          }
        }

        proc.kill();
        _serverProcess = null;
      } catch {}
    }
  } catch {}

  _starting = false;
  return false;
}

process.on('exit', () => {
  if (_serverProcess) {
    try { _serverProcess.kill(); } catch {}
  }
});

// ── Public API ────────────────────────────────────────────────

async function isAvailable() {
  if (_available === true) return true;
  if (await _ping()) {
    _available = true;
    return true;
  }
  // Not running — try to auto-start
  return await _startServer();
}

/**
 * Clean mini-browser output for WhatsApp / chat display.
 * Removes markdown headers and source lines, keeps content only.
 */
function _cleanForChat(text) {
  return text
    .replace(/^## .+$/gm, '')           // remove ## Title lines
    .replace(/^Source: https?:\/\/.+$/gm, '') // remove Source: URL lines
    .replace(/^---+$/gm, '―――')         // soften separators
    .replace(/\n{3,}/g, '\n\n')         // collapse blank lines
    .trim();
}

/**
 * Search the web via mini-browser.
 */
async function webSearch(query, {
  maxResults = 3,
  maxTokens = 1500,
  outputFormat = 'text',
  cleanOutput = true,
} = {}) {
  const data = await _request('/search', {
    query,
    max_results: maxResults,
    max_tokens:  maxTokens,
    output_format: outputFormat,
  });
  const result = data.result || '';
  return cleanOutput ? _cleanForChat(result) : result;
}

/**
 * Fetch and extract a URL via mini-browser.
 */
async function browseUrl(url, {
  query = '',
  maxTokens = 1500,
  cleanOutput = true,
} = {}) {
  const data = await _request('/fetch', {
    url,
    query,
    max_tokens: maxTokens,
  });
  const result = data.result || '';
  return cleanOutput ? _cleanForChat(result) : result;
}

async function getCacheStats() {
  try { return await _request('/cache/stats', null, 'GET'); } catch { return null; }
}

module.exports = { isAvailable, webSearch, browseUrl, getCacheStats };
