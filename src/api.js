'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

let _server    = null;
let _port      = null;
let _apiKey    = null;
let _getStatus = null;
let _sendMsg   = null;
let _runQuery  = null;
let _tenantIdRaw = () => 'default';

// Resolve data dir consistently with tenant.js / daemon.js
const DATA_DIR = process.env.BIMA_DATA || path.join(os.homedir(), '.bima');
const ACTIVE_TENANT_FILE = path.join(DATA_DIR, 'active_tenant.json');

// Resolve current tenant: prefer active_tenant.json (set via PUT /api/tenants/active),
// otherwise fall back to the function injected by the CLI/daemon.
function _tenantId() {
  try {
    if (fs.existsSync(ACTIVE_TENANT_FILE)) {
      const j = JSON.parse(fs.readFileSync(ACTIVE_TENANT_FILE, 'utf8'));
      if (j && typeof j.id === 'string' && j.id) return j.id;
    }
  } catch {}
  try { return _tenantIdRaw() || 'default'; } catch { return 'default'; }
}

// ── Module-level activity ring buffer (for /api/activity SSE) ──
const ACTIVITY_MAX = 500;
const _activity    = [];
const _activitySubs = new Set();

function pushActivity(tag, text) {
  const entry = { ts: Date.now(), tag: String(tag || 'INFO'), text: String(text || '') };
  _activity.push(entry);
  if (_activity.length > ACTIVITY_MAX) _activity.shift();
  for (const fn of _activitySubs) { try { fn(entry); } catch {} }
  return entry;
}

// Seed
pushActivity('SYS', 'Activity log started');

// ── Load whatsapp module lazily and tolerate missing exports ──
function _wa() {
  try { return require('./whatsapp'); } catch { return null; }
}

function _waHas(fn) {
  const m = _wa();
  return !!(m && typeof m[fn] === 'function');
}

// Indonesian helper for graceful 503 when WA glue isn't available yet
function _waUnavailable(res, what) {
  send(res, 503, { error: `Modul WhatsApp belum tersedia (${what}). Coba restart Bima atau perbarui ke versi terbaru.` });
}

// ── HTTP helpers ──────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'X-API-Key, Content-Type',
  });
  res.end(json);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function auth(req, res) {
  if (!_apiKey) return true;
  const key = req.headers['x-api-key'] ||
    new URL(req.url, 'http://x').searchParams.get('key');
  if (key === _apiKey) return true;
  send(res, 401, { error: 'Unauthorized. Sertakan header X-API-Key.' });
  return false;
}

// ── Admin Panel HTML ──────────────────────────────────────────
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

// ── Route handler ─────────────────────────────────────────────
async function handleRequest(req, res) {
  const { pathname: route, searchParams } = new URL(req.url, 'http://localhost');
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'X-API-Key, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    });
    res.end();
    return;
  }

  if (route === '/' || route === '/admin') {
    sendHtml(res, ADMIN_HTML);
    return;
  }

  if (!auth(req, res)) return;

  // GET /api/status
  if (route === '/api/status' && method === 'GET') {
    const st = _getStatus ? _getStatus() : {};
    send(res, 200, { ok: true, ...st, apiPort: _port });
    return;
  }

  // GET /api/groups
  if (route === '/api/groups' && method === 'GET') {
    const { getConfig } = require('./config');
    const cfg    = getConfig(_tenantId());
    const groups = [];
    if (cfg.inputGroups) {
      for (const [jid, name] of Object.entries(cfg.inputGroups)) {
        groups.push({ jid, name, type: 'input' });
      }
    }
    if (cfg.outputGroupJid) {
      const existing = groups.find(g => g.jid === cfg.outputGroupJid);
      if (existing) existing.type = 'input+output';
      else groups.push({ jid: cfg.outputGroupJid, name: cfg.outputGroupName || cfg.outputGroupJid, type: 'output' });
    }
    send(res, 200, { ok: true, groups });
    return;
  }

  // POST /api/send
  if (route === '/api/send' && method === 'POST') {
    try {
      const { jid, text, phone } = await readBody(req);
      let target = jid;
      if (!target && phone) {
        const num = String(phone).replace(/\D/g, '');
        target = `${num.startsWith('0') ? '62' + num.slice(1) : num}@s.whatsapp.net`;
      }
      if (!target || !text) { send(res, 400, { error: 'Butuh: jid + text (atau phone + text)' }); return; }
      if (!_sendMsg)        { send(res, 503, { error: 'WhatsApp tidak terhubung' }); return; }
      await _sendMsg(target, text);
      send(res, 200, { ok: true, to: target });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/query
  if (route === '/api/query' && method === 'POST') {
    try {
      const { question } = await readBody(req);
      if (!question) { send(res, 400, { error: 'Butuh: question' }); return; }
      if (!_runQuery) { send(res, 503, { error: 'Agent belum siap' }); return; }
      const answer = await _runQuery(question, _tenantId());
      send(res, 200, { ok: true, answer });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // GET /api/knowledge
  if (route === '/api/knowledge' && method === 'GET') {
    const { getKnowledge } = require('./db');
    const docs = getKnowledge(_tenantId()).map(d => ({
      file:      d.file,
      hash:      d.hash,
      timestamp: d.timestamp,
      compacted: !!d.compacted,
      size:      (d.raw_text || '').length,
    }));
    send(res, 200, { ok: true, count: docs.length, docs });
    return;
  }

  // DELETE /api/knowledge/:hash
  const delMatch = route.match(/^\/api\/knowledge\/([a-f0-9]{32})$/);
  if (delMatch && method === 'DELETE') {
    const { deleteDocument } = require('./db');
    const ok = deleteDocument(delMatch[1], _tenantId());
    send(res, ok ? 200 : 404, { ok });
    return;
  }

  // GET /api/log?groupJid=xxx&hours=24
  if (route === '/api/log' && method === 'GET') {
    const groupJid = searchParams.get('groupJid');
    const hours    = Math.min(parseInt(searchParams.get('hours') || '24', 10), 48);
    if (!groupJid) { send(res, 400, { error: 'Butuh: ?groupJid=xxx (atau groupJid=all untuk list)' }); return; }
    const { getLog, formatLog, listGroupJids } = require('./grouplog');
    if (groupJid === 'all') {
      send(res, 200, { ok: true, groupJids: listGroupJids(_tenantId()) });
      return;
    }
    const entries = getLog(_tenantId(), groupJid, hours);
    send(res, 200, {
      ok:       true,
      groupJid, hours,
      count:    entries.length,
      log:      formatLog(entries),
      entries,
    });
    return;
  }

  // GET /api/ltm
  if (route === '/api/ltm' && method === 'GET') {
    const { getAll } = require('./ltm');
    send(res, 200, { ok: true, entries: getAll(_tenantId()) });
    return;
  }

  // ── Workflow REST API ─────────────────────────────────────

  // POST /api/workflows — create or replace workflow (used by visual builder)
  if (route === '/api/workflows' && method === 'POST') {
    if (!auth(req, res)) return;
    try {
      const wf = await readBody(req);
      if (!wf.id || !wf.name || !wf.entry) {
        return send(res, 400, { error: 'id, name, entry wajib diisi' });
      }

      const { validateWorkflow } = require('./workflow_ai');
      try { validateWorkflow(wf); }
      catch (e) { return send(res, 400, { error: 'Validasi gagal: ' + e.message }); }

      const { saveWorkflow, getWorkflow, deactivateTriggers, activateTriggers } = require('./workflow');
      const existed = getWorkflow(_tenantId(), wf.id);
      if (existed) {
        // Preserve enabled state + createdAt; restart triggers
        wf.enabled   = existed.enabled;
        wf.createdAt = existed.createdAt;
        deactivateTriggers(_tenantId(), wf.id);
      } else {
        wf.enabled   = wf.enabled || false;
        wf.createdAt = Date.now();
      }
      wf.tenant = _tenantId();
      saveWorkflow(_tenantId(), wf);
      if (wf.enabled) activateTriggers(_tenantId(), wf, { _tenantId: _tenantId() }, null);
      return send(res, 200, { ok: true, id: wf.id, created: !existed });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }

  // DELETE /api/workflows/:id — remove workflow
  if (route.match(/^\/api\/workflows\/[^/]+$/) && method === 'DELETE') {
    if (!auth(req, res)) return;
    const wfId = route.slice(15);
    const { getWorkflow, deleteWorkflow, deactivateTriggers } = require('./workflow');
    if (!getWorkflow(_tenantId(), wfId)) return send(res, 404, { error: 'Workflow tidak ditemukan' });
    deactivateTriggers(_tenantId(), wfId);
    deleteWorkflow(_tenantId(), wfId);
    return send(res, 200, { ok: true, id: wfId });
  }

  // GET /api/workflows
  if (route === '/api/workflows' && method === 'GET') {
    if (!auth(req, res)) return;
    const { listWorkflows, getRunStats } = require('./workflow');
    const workflows = listWorkflows(_tenantId()).map(wf => ({
      id:          wf.id,
      name:        wf.name,
      description: wf.description || '',
      enabled:     wf.enabled,
      trigger:     wf.trigger,
      nodeCount:   (wf.nodes || []).length,
      entry:       wf.entry,
      updatedAt:   wf.updatedAt,
      stats:       getRunStats(_tenantId(), wf.id),
    }));
    send(res, 200, { ok: true, workflows });
    return;
  }

  // GET /api/workflows/:id
  if (route.startsWith('/api/workflows/') && !route.includes('/runs') && !route.includes('/run') && method === 'GET') {
    if (!auth(req, res)) return;
    const wfId = route.slice(15);
    const { getWorkflow } = require('./workflow');
    const wf = getWorkflow(_tenantId(), wfId);
    if (!wf) { send(res, 404, { error: 'Workflow tidak ditemukan' }); return; }
    send(res, 200, { ok: true, workflow: wf });
    return;
  }

  // GET /api/workflows/:id/runs
  if (route.match(/^\/api\/workflows\/[^/]+\/runs$/) && method === 'GET') {
    if (!auth(req, res)) return;
    const wfId = route.split('/')[3];
    const limit = parseInt(searchParams.get('limit') || '20');
    const { getRunHistory, getRunStats } = require('./workflow');
    const runs  = getRunHistory(_tenantId(), wfId, limit);
    const stats = getRunStats(_tenantId(), wfId);
    send(res, 200, { ok: true, runs, stats });
    return;
  }

  // POST /api/workflows/:id/run  — manual trigger
  if (route.match(/^\/api\/workflows\/[^/]+\/run$/) && method === 'POST') {
    if (!auth(req, res)) return;
    const wfId = route.split('/')[3];
    const { getWorkflow, runWorkflow } = require('./workflow');
    const wf = getWorkflow(_tenantId(), wfId);
    if (!wf) { send(res, 404, { error: 'Workflow tidak ditemukan' }); return; }
    try {
      const body    = await readBody(req);
      const input   = body.input || '';
      const sendFn  = _sendMsg ? async (jid, text) => _sendMsg(jid, text) : null;
      // Run async, respond immediately with run start info
      const runP = runWorkflow(wf, {
        _tenantId:  _tenantId(),
        _jid:       body.jid || null,
        _sendFn:    sendFn,
        _trigger:   'api',
        lastOutput: input,
        message:    input,
        input,
      }, null);
      // Wait max 5s for quick workflows, else return "accepted"
      const run = await Promise.race([
        runP,
        new Promise(r => setTimeout(() => r(null), 5000)),
      ]);
      if (run) {
        send(res, 200, { ok: true, run: { ok: run.ok, durationMs: run.durationMs, steps: run.steps.length, error: run.error } });
      } else {
        send(res, 202, { ok: true, message: 'Workflow sedang berjalan (timeout 5s terlampaui)' });
      }
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // PUT /api/workflows/:id/enable
  if (route.match(/^\/api\/workflows\/[^/]+\/enable$/) && method === 'PUT') {
    if (!auth(req, res)) return;
    const wfId = route.split('/')[3];
    const { getWorkflow, saveWorkflow, activateTriggers } = require('./workflow');
    const wf = getWorkflow(_tenantId(), wfId);
    if (!wf) { send(res, 404, { error: 'Workflow tidak ditemukan' }); return; }
    wf.enabled = true;
    saveWorkflow(_tenantId(), wf);
    activateTriggers(_tenantId(), wf, { _tenantId: _tenantId() }, null);
    send(res, 200, { ok: true, id: wfId, enabled: true });
    return;
  }

  // PUT /api/workflows/:id/disable
  if (route.match(/^\/api\/workflows\/[^/]+\/disable$/) && method === 'PUT') {
    if (!auth(req, res)) return;
    const wfId = route.split('/')[3];
    const { getWorkflow, saveWorkflow, deactivateTriggers } = require('./workflow');
    const wf = getWorkflow(_tenantId(), wfId);
    if (!wf) { send(res, 404, { error: 'Workflow tidak ditemukan' }); return; }
    wf.enabled = false;
    saveWorkflow(_tenantId(), wf);
    deactivateTriggers(_tenantId(), wfId);
    send(res, 200, { ok: true, id: wfId, enabled: false });
    return;
  }

  // POST /webhook/:webhookId  — workflow webhook trigger
  if (method === 'POST' && route.startsWith('/webhook/')) {
    const webhookId = route.slice(9); // strip '/webhook/'
    if (!webhookId) { send(res, 400, { error: 'Butuh webhookId' }); return; }
    try {
      const body = await readBody(req);
      const { handleWebhookTrigger } = require('./workflow');
      const result = await handleWebhookTrigger(webhookId, body, req.headers, _sendMsg, null);
      send(res, result.status, result);
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ════════════════════════════════════════════════════════════
  // WhatsApp connection control
  // ════════════════════════════════════════════════════════════

  // POST /api/wa/connect
  if (route === '/api/wa/connect' && method === 'POST') {
    if (!_waHas('reconnectWA')) { _waUnavailable(res, 'reconnectWA'); return; }
    try {
      const wa = _wa();
      const result = await wa.reconnectWA((msg) => pushActivity('WA', String(msg)));
      pushActivity('WA', result && result.already ? 'Sudah terhubung' : 'Mencoba menyambung WhatsApp...');
      send(res, 200, { ok: true, already: !!(result && result.already) });
    } catch (e) {
      pushActivity('ERROR', 'WA connect: ' + e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/wa/disconnect
  if (route === '/api/wa/disconnect' && method === 'POST') {
    if (!_waHas('logoutWA')) { _waUnavailable(res, 'logoutWA'); return; }
    try {
      const wa = _wa();
      await wa.logoutWA();
      pushActivity('WA', 'Logged out');
      send(res, 200, { ok: true });
    } catch (e) {
      pushActivity('ERROR', 'WA logout: ' + e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/wa/qr  — SSE stream of QR events (server renders to data-URI PNG)
  if (route === '/api/wa/qr' && method === 'GET') {
    if (!_waHas('subscribeQR')) { _waUnavailable(res, 'subscribeQR'); return; }
    const wa = _wa();
    let qrcodeLib;
    try { qrcodeLib = require('qrcode'); } catch { qrcodeLib = null; }

    res.writeHead(200, {
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const write = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };

    async function emitQR(qrText) {
      if (!qrcodeLib) { write({ qr: qrText }); return; } // fallback: raw QR text
      try {
        const dataUrl = await qrcodeLib.toDataURL(qrText, { width: 300, margin: 2 });
        write({ qr: qrText, dataUrl });
      } catch (e) {
        write({ qr: qrText, error: 'render: ' + e.message });
      }
    }

    // Replay current QR if fresh
    try {
      const cur = wa.getCurrentQR && wa.getCurrentQR();
      if (cur) emitQR(cur);
    } catch {}

    let closed = false;
    const unsubscribe = wa.subscribeQR((payload) => {
      if (closed) return;
      if (typeof payload === 'string') {
        emitQR(payload);
      } else if (payload && payload.event === 'connected') {
        write({ event: 'connected' });
        cleanup();
        try { res.end(); } catch {}
      } else if (payload && payload.event === 'error') {
        // Ignore residual "logged out" emitted right before reconnect
        const msg = String(payload.payload || 'unknown');
        if (msg !== 'logged out') write({ event: 'error', msg });
      }
    });

    const heartbeat = setInterval(() => {
      if (closed) return;
      try { res.write(':ping\n\n'); } catch {}
    }, 15000);

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try { unsubscribe(); } catch {}
    }
    req.on('close', cleanup);
    req.on('error', cleanup);
    return;
  }

  // GET /api/wa/groups
  if (route === '/api/wa/groups' && method === 'GET') {
    if (!_waHas('getJoinedGroups')) { _waUnavailable(res, 'getJoinedGroups'); return; }
    try {
      const wa = _wa();
      const groups = wa.getJoinedGroups() || [];
      send(res, 200, { ok: true, groups });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ════════════════════════════════════════════════════════════
  // Telegram control
  // ════════════════════════════════════════════════════════════
  const _tg = () => { try { return require('./telegram'); } catch { return null; } };
  const _tgUnavailable = () => send(res, 503, { error: 'Modul Telegram tidak tersedia.' });

  // GET /api/tg/token (returns sanitized tail)
  if (route === '/api/tg/token' && method === 'GET') {
    try {
      const { getConfig } = require('./config');
      const cfg = getConfig(_tenantId()) || {};
      const tk  = cfg.telegramToken || '';
      const tail = tk ? (tk.slice(0, 6) + '...' + tk.slice(-4) + ' (len=' + tk.length + ')') : '';
      send(res, 200, { ok: true, token: tail });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // PUT /api/tg/token
  if (route === '/api/tg/token' && method === 'PUT') {
    try {
      const body = await readBody(req);
      const token = String(body.token || '').trim();
      if (!token) { send(res, 400, { error: 'Token kosong' }); return; }
      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) { send(res, 400, { error: 'Format token tidak valid (harus seperti 12345:AB...)' }); return; }
      const { getConfig, saveConfig } = require('./config');
      const cfg = getConfig(_tenantId()) || {};
      cfg.telegramToken = token;
      saveConfig(cfg, _tenantId());
      pushActivity('TG', 'Token tersimpan');
      send(res, 200, { ok: true });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // GET /api/tg/status
  if (route === '/api/tg/status' && method === 'GET') {
    const tg = _tg();
    if (!tg) return _tgUnavailable();
    try {
      const st = tg.getTelegramStatus() || {};
      send(res, 200, { ok: true, running: !!st.running, username: st.username || null });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/tg/start
  if (route === '/api/tg/start' && method === 'POST') {
    const tg = _tg();
    if (!tg) return _tgUnavailable();
    try {
      const { getConfig } = require('./config');
      const cfg = getConfig(_tenantId()) || {};
      if (!cfg.telegramToken) { send(res, 400, { error: 'Token belum diset. Simpan token dulu.' }); return; }
      const log = (tag, text) => pushActivity('TG', String(text || tag));
      await tg.startTelegram(cfg.telegramToken, log);
      const st = tg.getTelegramStatus() || {};
      pushActivity('TG', 'Bot aktif' + (st.username ? ' (@' + st.username + ')' : ''));
      send(res, 200, { ok: true, username: st.username || null });
    } catch (e) {
      pushActivity('ERROR', 'TG start: ' + e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/tg/stop
  if (route === '/api/tg/stop' && method === 'POST') {
    const tg = _tg();
    if (!tg) return _tgUnavailable();
    try {
      await tg.stopTelegram();
      pushActivity('TG', 'Bot dihentikan');
      send(res, 200, { ok: true });
    } catch (e) {
      pushActivity('ERROR', 'TG stop: ' + e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ════════════════════════════════════════════════════════════
  // Config
  // ════════════════════════════════════════════════════════════
  const _sanitizeKey = (k) => {
    if (!k) return null;
    if (typeof k !== 'string') return '***SET***';
    if (k.length < 12) return '***SET***';
    return k.slice(0, 4) + '...' + k.slice(-4) + ' (len=' + k.length + ')';
  };

  // GET /api/config
  if (route === '/api/config' && method === 'GET') {
    try {
      const { getConfig } = require('./config');
      const cfg = getConfig(_tenantId()) || {};
      const safe = { ...cfg };
      safe.apiKey = _sanitizeKey(cfg.apiKey);
      send(res, 200, { ok: true, config: safe, tenant: _tenantId() });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // PUT /api/config
  if (route === '/api/config' && method === 'PUT') {
    try {
      const body = await readBody(req);
      const allowed = ['provider', 'model', 'apiKey', 'language', 'sandboxEnabled', 'adminJid', 'adminNotifyThreshold', 'apiPort'];
      const knownProviders = ['openai', 'anthropic', 'openrouter', 'gemini', 'groq', 'together'];
      const patch = {};
      for (const k of allowed) {
        if (!(k in body)) continue;
        let v = body[k];
        if (typeof v === 'string') v = v.trim();
        if (k === 'provider' && v && !knownProviders.includes(v)) {
          return send(res, 400, { error: `Provider tidak dikenal. Pilih salah satu: ${knownProviders.join(', ')}` });
        }
        if (k === 'apiPort') {
          const n = parseInt(v, 10);
          if (isNaN(n) || n < 1 || n > 65535) return send(res, 400, { error: 'apiPort harus angka 1-65535' });
          patch[k] = n;
          continue;
        }
        if (k === 'adminNotifyThreshold') {
          const n = parseInt(v, 10);
          if (isNaN(n) || n < 1) return send(res, 400, { error: 'adminNotifyThreshold harus angka >= 1' });
          patch[k] = n;
          continue;
        }
        if (k === 'sandboxEnabled') { patch[k] = !!v; continue; }
        if (k === 'apiKey' && v === '') continue; // empty = no change
        patch[k] = v;
      }
      const { saveConfig } = require('./config');
      saveConfig(patch, _tenantId());
      pushActivity('API', `Config disimpan: ${Object.keys(patch).join(', ')}`);
      send(res, 200, { ok: true, updated: Object.keys(patch) });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // GET /api/config/groups
  if (route === '/api/config/groups' && method === 'GET') {
    try {
      const { getConfig } = require('./config');
      const cfg = getConfig(_tenantId()) || {};
      // Normalize: inputGroups may be {jid:name} object OR array
      let inputGroups = [];
      if (Array.isArray(cfg.inputGroups)) inputGroups = cfg.inputGroups.slice();
      else if (cfg.inputGroups && typeof cfg.inputGroups === 'object') inputGroups = Object.keys(cfg.inputGroups);
      let outputGroups = [];
      if (Array.isArray(cfg.outputGroups)) outputGroups = cfg.outputGroups.slice();
      else if (cfg.outputGroupJid) outputGroups = [cfg.outputGroupJid];
      // Build groupNames map so UI can show friendly names even when WA disconnected
      const groupNames = {};
      if (cfg.inputGroups && typeof cfg.inputGroups === 'object' && !Array.isArray(cfg.inputGroups)) {
        for (const [jid, name] of Object.entries(cfg.inputGroups)) groupNames[jid] = name;
      }
      if (cfg.outputGroupJid && cfg.outputGroupName) groupNames[cfg.outputGroupJid] = cfg.outputGroupName;
      if (cfg.inputGroupName && cfg.inputGroup)      groupNames[cfg.inputGroup]      = cfg.inputGroupName;
      send(res, 200, { ok: true, inputGroups, outputGroups, groupNames });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // PUT /api/config/groups
  if (route === '/api/config/groups' && method === 'PUT') {
    try {
      const body = await readBody(req);
      const inp  = Array.isArray(body.inputGroups)  ? body.inputGroups.map(s => String(s).trim()).filter(Boolean)  : [];
      const out  = Array.isArray(body.outputGroups) ? body.outputGroups.map(s => String(s).trim()).filter(Boolean) : [];
      const { getConfig, saveConfig } = require('./config');
      const cfg = getConfig(_tenantId()) || {};

      // Build inputGroups as {jid:name} map (preserve names where known)
      let names = {};
      try {
        const wa = _wa();
        if (wa && typeof wa.getJoinedGroups === 'function') {
          for (const g of wa.getJoinedGroups()) names[g.jid] = g.name;
        }
      } catch {}
      // Also preserve any pre-existing names
      if (cfg.inputGroups && typeof cfg.inputGroups === 'object' && !Array.isArray(cfg.inputGroups)) {
        for (const [k, v] of Object.entries(cfg.inputGroups)) {
          if (!names[k]) names[k] = v;
        }
      }
      const inputGroupsMap = {};
      for (const jid of inp) inputGroupsMap[jid] = names[jid] || jid;

      const patch = {
        inputGroups:  inputGroupsMap,
        outputGroups: out,
      };
      // For backward compat: also set outputGroupJid/Name when single
      if (out.length === 1) {
        patch.outputGroupJid  = out[0];
        patch.outputGroupName = names[out[0]] || out[0];
      } else if (out.length === 0) {
        patch.outputGroupJid  = '';
        patch.outputGroupName = '';
      }
      saveConfig(patch, _tenantId());
      pushActivity('API', `Grup disimpan: ${inp.length} input, ${out.length} output`);
      send(res, 200, { ok: true, inputGroups: inp, outputGroups: out });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ════════════════════════════════════════════════════════════
  // Tenants
  // ════════════════════════════════════════════════════════════

  // GET /api/tenants
  if (route === '/api/tenants' && method === 'GET') {
    try {
      const { listTenants } = require('./tenant');
      const tenants = (listTenants() || []).map(t => ({
        id:        t.id,
        name:      t.name || t.id,
        active:    t.id === _tenantId(),
        createdAt: t.createdAt || null,
      }));
      send(res, 200, { ok: true, tenants });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/tenants
  if (route === '/api/tenants' && method === 'POST') {
    try {
      const body = await readBody(req);
      const id   = String(body.id || '').trim();
      const name = String(body.name || '').trim() || id;
      if (!id) return send(res, 400, { error: 'ID wajib diisi' });
      const { addTenant, getTenant } = require('./tenant');
      if (getTenant(id)) return send(res, 409, { error: `Tenant "${id}" sudah ada` });
      const tenant = addTenant({ id, name });
      pushActivity('API', `Tenant baru: ${id}`);
      send(res, 200, { ok: true, tenant });
    } catch (e) { send(res, 400, { error: e.message }); }
    return;
  }

  // PUT /api/tenants/active
  if (route === '/api/tenants/active' && method === 'PUT') {
    try {
      const body = await readBody(req);
      const id   = String(body.id || '').trim();
      if (!id) return send(res, 400, { error: 'ID wajib diisi' });
      const { getTenant } = require('./tenant');
      if (!getTenant(id)) return send(res, 404, { error: `Tenant "${id}" tidak ditemukan` });
      try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
      fs.writeFileSync(ACTIVE_TENANT_FILE, JSON.stringify({ id }, null, 2));
      pushActivity('API', `Tenant aktif: ${id}`);
      send(res, 200, { ok: true, active: id });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // DELETE /api/tenants/:id
  const tntDel = route.match(/^\/api\/tenants\/([^/]+)$/);
  if (tntDel && method === 'DELETE') {
    const id = decodeURIComponent(tntDel[1]);
    if (id === 'default') return send(res, 400, { error: 'Tenant default tidak bisa dihapus' });
    try {
      const { deleteTenant } = require('./tenant');
      const ok = deleteTenant(id);
      if (!ok) return send(res, 404, { error: `Tenant "${id}" tidak ditemukan` });
      pushActivity('API', `Tenant dihapus: ${id}`);
      // If the active tenant was the one deleted, reset active file
      try {
        if (fs.existsSync(ACTIVE_TENANT_FILE)) {
          const j = JSON.parse(fs.readFileSync(ACTIVE_TENANT_FILE, 'utf8'));
          if (j && j.id === id) fs.unlinkSync(ACTIVE_TENANT_FILE);
        }
      } catch {}
      send(res, 200, { ok: true });
    } catch (e) { send(res, 400, { error: e.message }); }
    return;
  }

  // ════════════════════════════════════════════════════════════
  // Workflow templates
  // ════════════════════════════════════════════════════════════

  // GET /api/templates
  if (route === '/api/templates' && method === 'GET') {
    try {
      const { listTemplates } = require('./workflow_templates');
      send(res, 200, { ok: true, templates: listTemplates() });
    } catch (e) { send(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/templates/:id/install
  const tplInstall = route.match(/^\/api\/templates\/([^/]+)\/install$/);
  if (tplInstall && method === 'POST') {
    try {
      const tplId = decodeURIComponent(tplInstall[1]);
      const body  = await readBody(req);
      const wfId  = body.workflowId || tplId;
      const vars  = body.vars || {};
      const { installTemplate } = require('./workflow_templates');
      const wf = installTemplate(tplId, _tenantId(), wfId, vars);
      pushActivity('WF', `Template installed: ${tplId} → ${wf.id}`);
      send(res, 200, { ok: true, workflow: wf });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
    return;
  }

  // ════════════════════════════════════════════════════════════
  // Activity SSE
  // ════════════════════════════════════════════════════════════

  // GET /api/activity
  if (route === '/api/activity' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const write = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };

    // Replay last 50
    const replay = _activity.slice(-50);
    for (const e of replay) write(e);

    let closed = false;
    const listener = (entry) => { if (!closed) write(entry); };
    _activitySubs.add(listener);

    const heartbeat = setInterval(() => {
      if (closed) return;
      try { res.write(':ping\n\n'); } catch {}
    }, 15000);

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      _activitySubs.delete(listener);
    }
    req.on('close', cleanup);
    req.on('error', cleanup);
    return;
  }

  send(res, 404, { error: 'Route tidak ditemukan' });
}

// ── Start / Stop ──────────────────────────────────────────────
function startApi({ port = 3000, apiKey, getStatus, sendMsg, runQuery, tenantId } = {}) {
  if (_server) throw new Error(`REST API sudah berjalan di port ${_port}`);

  _port      = port;
  _apiKey    = apiKey || null;
  _getStatus = getStatus || null;
  _sendMsg   = sendMsg   || null;
  _runQuery  = runQuery  || null;
  if (typeof tenantId === 'function') _tenantIdRaw = tenantId;

  _server = http.createServer((req, res) => {
    handleRequest(req, res).catch(e => {
      try { send(res, 500, { error: e.message }); } catch {}
    });
  });

  return new Promise((resolve, reject) => {
    _server.listen(port, '0.0.0.0', () => resolve(port));
    _server.on('error', reject);
  });
}

function stopApi() {
  return new Promise((resolve) => {
    if (!_server) { resolve(); return; }
    _server.close(() => { _server = null; _port = null; resolve(); });
  });
}

function getApiStatus() {
  return _server
    ? { running: true, port: _port, hasKey: !!_apiKey }
    : { running: false };
}

module.exports = { startApi, stopApi, getApiStatus, pushActivity };
