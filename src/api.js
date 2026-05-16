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
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BIMA Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
a{color:#22c55e}
header{background:#1e293b;border-bottom:1px solid #334155;padding:12px 20px;display:flex;align-items:center;gap:12px}
header h1{font-size:1.1rem;font-weight:700;letter-spacing:.05em;color:#22c55e}
.dot{width:10px;height:10px;border-radius:50%;background:#ef4444;flex-shrink:0}
.dot.green{background:#22c55e}
.api-key-bar{background:#1e293b;border-bottom:1px solid #334155;padding:8px 20px;display:flex;align-items:center;gap:8px;font-size:.8rem;color:#94a3b8}
.api-key-bar input{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:4px 8px;border-radius:4px;font-size:.8rem;width:260px}
.api-key-bar button{background:#334155;color:#e2e8f0;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:.8rem}
nav{background:#1e293b;border-bottom:1px solid #334155;display:flex;gap:0;padding:0 20px}
nav button{background:none;border:none;color:#94a3b8;padding:12px 16px;cursor:pointer;font-size:.85rem;border-bottom:2px solid transparent;transition:.2s}
nav button.active,nav button:hover{color:#22c55e;border-bottom-color:#22c55e}
main{padding:20px;max-width:900px;margin:0 auto}
.tab{display:none}
.tab.active{display:block}
.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin-bottom:16px}
.card h2{font-size:.9rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stat{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:12px}
.stat .label{font-size:.75rem;color:#64748b;margin-bottom:4px}
.stat .value{font-size:1rem;font-weight:600;color:#e2e8f0;word-break:break-all}
.stat .value.green{color:#22c55e}
.stat .value.red{color:#ef4444}
label{display:block;font-size:.8rem;color:#94a3b8;margin-bottom:4px;margin-top:10px}
input,textarea,select{width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:8px 10px;border-radius:6px;font-size:.9rem;font-family:inherit}
input:focus,textarea:focus,select:focus{outline:none;border-color:#22c55e}
textarea{resize:vertical;min-height:80px}
.btn{display:inline-block;background:#22c55e;color:#0f172a;border:none;padding:9px 18px;border-radius:6px;cursor:pointer;font-weight:600;font-size:.85rem;margin-top:10px}
.btn:hover{background:#16a34a}
.btn.danger{background:#ef4444;color:#fff}
.btn.danger:hover{background:#dc2626}
.btn.secondary{background:#334155;color:#e2e8f0}
.btn.secondary:hover{background:#475569}
.msg{padding:8px 12px;border-radius:6px;font-size:.85rem;margin-top:8px;display:none}
.msg.ok{background:#14532d;color:#86efac;border:1px solid #166534}
.msg.err{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:#64748b;font-weight:500;padding:6px 8px;border-bottom:1px solid #334155}
td{padding:8px;border-bottom:1px solid #1e293b;vertical-align:middle}
tr:last-child td{border-bottom:none}
.badge{font-size:.7rem;padding:2px 6px;border-radius:4px;background:#334155;color:#94a3b8}
.badge.input{background:#1e3a5f;color:#60a5fa}
.badge.output{background:#14532d;color:#86efac}
.badge.io{background:#44337a;color:#c4b5fd}
pre{white-space:pre-wrap;word-break:break-word;font-size:.8rem;color:#94a3b8;background:#0f172a;padding:12px;border-radius:6px;max-height:400px;overflow-y:auto;border:1px solid #334155}
.loading{color:#64748b;font-size:.85rem;margin-top:8px}

/* ── Visual Builder ─────────────────────────────────────── */
.builder-layout{display:grid;grid-template-columns:180px 1fr 240px;gap:8px;height:calc(100vh - 240px);min-height:500px}
.builder-pane{background:#1e293b;border:1px solid #334155;border-radius:6px;overflow:auto;padding:8px}
.builder-pane h3{font-size:.75rem;color:#94a3b8;text-transform:uppercase;margin-bottom:8px;letter-spacing:.05em}
.palette-item{padding:6px 8px;margin-bottom:4px;background:#0f172a;border:1px solid #334155;border-radius:4px;cursor:grab;font-size:.78rem;display:flex;align-items:center;gap:6px;color:#e2e8f0;user-select:none}
.palette-item:hover{border-color:#22c55e;background:#1a2540}
.palette-item:active{cursor:grabbing}
.palette-icon{width:18px;text-align:center;font-size:.95rem}
.palette-group{font-size:.65rem;color:#64748b;margin:6px 0 3px;text-transform:uppercase;letter-spacing:.05em}
#wf-canvas{position:relative;background:#0f172a;background-image:radial-gradient(#1e293b 1px,transparent 1px);background-size:16px 16px;overflow:auto;min-height:400px}
.canvas-node{position:absolute;background:#1e293b;border:2px solid #334155;border-radius:8px;padding:8px 10px;min-width:120px;cursor:move;user-select:none;font-size:.8rem;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.canvas-node.entry{border-color:#22c55e}
.canvas-node.selected{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.3)}
.canvas-node .node-head{display:flex;align-items:center;gap:6px;font-weight:600}
.canvas-node .node-id{color:#e2e8f0;font-size:.78rem}
.canvas-node .node-type{color:#94a3b8;font-size:.65rem;text-transform:uppercase;letter-spacing:.05em}
.canvas-node .node-summary{color:#64748b;font-size:.7rem;margin-top:3px;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.canvas-node .node-badges{display:flex;gap:3px;margin-top:3px;font-size:.65rem}
.canvas-node .node-badge{background:#0f172a;border:1px solid #334155;padding:1px 4px;border-radius:3px;color:#94a3b8}
.node-port{position:absolute;width:10px;height:10px;border-radius:50%;background:#334155;border:2px solid #1e293b;cursor:crosshair;z-index:2}
.node-port:hover{background:#22c55e}
.node-port.in{left:-7px;top:50%;transform:translateY(-50%)}
.node-port.out{right:-7px;top:50%;transform:translateY(-50%)}
.node-port.branch-true{right:-7px;top:30%}
.node-port.branch-false{right:-7px;top:70%}
.node-port.branch-true::after{content:'T';position:absolute;right:14px;top:-2px;font-size:.6rem;color:#22c55e}
.node-port.branch-false::after{content:'F';position:absolute;right:14px;top:-2px;font-size:.6rem;color:#ef4444}
#wf-canvas-svg{position:absolute;top:0;left:0;pointer-events:none;width:100%;height:100%;z-index:1}
#wf-canvas-svg path{stroke:#475569;stroke-width:2;fill:none;pointer-events:stroke;cursor:pointer}
#wf-canvas-svg path:hover{stroke:#ef4444}
#wf-canvas-svg path.temp{stroke:#22c55e;stroke-dasharray:4 4}
.inspector-field{margin-bottom:8px}
.inspector-field label{font-size:.7rem;margin:0 0 3px}
.inspector-field input,.inspector-field textarea,.inspector-field select{padding:5px 7px;font-size:.78rem;border-radius:4px}
.inspector-field textarea{min-height:50px}
.builder-toolbar{background:#1e293b;border:1px solid #334155;border-radius:6px;padding:8px;margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.builder-toolbar input{width:auto;flex:1;min-width:120px;padding:5px 8px;font-size:.78rem}
.builder-toolbar .btn{padding:5px 12px;font-size:.78rem;margin:0}

/* ── Welcome / Quick Start ──────────────────────────────── */
.welcome{background:linear-gradient(135deg,#1e293b 0%,#0f4d2a 100%);border:1px solid #22c55e;border-radius:10px;padding:20px;margin-bottom:16px}
.welcome h2{color:#22c55e;margin-bottom:12px;font-size:1.1rem;text-transform:none;letter-spacing:0}
.welcome p{color:#e2e8f0;font-size:.88rem;line-height:1.5;margin-bottom:10px}
.welcome .qs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px}
.welcome .qs-card{background:rgba(15,23,42,.6);border:1px solid #334155;border-radius:8px;padding:12px;cursor:pointer;transition:.2s}
.welcome .qs-card:hover{border-color:#22c55e;background:rgba(15,23,42,.9)}
.welcome .qs-card .qs-icon{font-size:1.4rem;margin-bottom:6px}
.welcome .qs-card .qs-title{font-weight:600;color:#22c55e;font-size:.88rem;margin-bottom:4px}
.welcome .qs-card .qs-desc{color:#94a3b8;font-size:.75rem;line-height:1.4}
.welcome-close{float:right;color:#94a3b8;background:none;border:none;cursor:pointer;font-size:1rem;padding:0 4px}
.welcome-close:hover{color:#ef4444}

/* ── Settings / Templates / Activity ────────────────────── */
.status-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:20px;font-size:.85rem;font-weight:600}
.status-badge.green{background:#14532d;color:#86efac;border:1px solid #166534}
.status-badge.red{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
.status-badge .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.chip{display:inline-block;font-size:.7rem;padding:2px 8px;border-radius:10px;background:#334155;color:#cbd5e1;margin:2px 4px 2px 0;cursor:pointer;user-select:none;border:1px solid transparent}
.chip.active{background:#22c55e;color:#0f172a;border-color:#16a34a}
.chip.err{background:#7f1d1d;color:#fca5a5}
.chip.wa{background:#1e3a5f;color:#60a5fa}
.chip.wf{background:#44337a;color:#c4b5fd}
.chip.api{background:#1f2937;color:#94a3b8}
.tpl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:10px}
.tpl-card{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:8px;transition:.2s}
.tpl-card:hover{border-color:#22c55e}
.tpl-card .tpl-icon{font-size:1.6rem}
.tpl-card .tpl-name{font-weight:600;color:#e2e8f0;font-size:.95rem}
.tpl-card .tpl-desc{color:#94a3b8;font-size:.78rem;flex:1;line-height:1.4}
.tpl-card .tpl-tags{display:flex;flex-wrap:wrap;gap:3px}
select[multiple]{min-height:120px;padding:6px}
select[multiple] option{padding:4px 6px}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}
.modal-box{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;max-width:420px;width:100%;text-align:center}
.modal-box h3{color:#22c55e;margin-bottom:12px;font-size:1rem}
.modal-box .qr-img{background:#fff;padding:12px;border-radius:8px;display:inline-block;margin:8px 0}
.modal-box .qr-img img{display:block;width:280px;height:280px}
.modal-box .qr-status{color:#94a3b8;font-size:.8rem;margin-top:8px}
.modal-box .modal-close{margin-top:12px}
.activity-feed{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px;max-height:55vh;overflow-y:auto;font-family:ui-monospace,Consolas,monospace;font-size:.78rem}
.activity-row{display:flex;gap:8px;padding:4px 6px;border-bottom:1px solid #1e293b;align-items:flex-start}
.activity-row:last-child{border-bottom:none}
.activity-row .a-ts{color:#64748b;flex-shrink:0;white-space:nowrap}
.activity-row .a-text{color:#e2e8f0;word-break:break-word;flex:1}
.activity-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.tnt-table td .btn{padding:4px 10px;font-size:.75rem;margin:1px}

/* ── Mobile responsive ──────────────────────────────────── */
@media (max-width: 768px) {
  header h1{font-size:.95rem}
  .api-key-bar{flex-wrap:wrap;font-size:.75rem}
  .api-key-bar input{width:100%}
  nav{overflow-x:auto;-webkit-overflow-scrolling:touch;flex-wrap:nowrap;white-space:nowrap;padding:0 8px}
  nav::-webkit-scrollbar{height:3px}
  nav::-webkit-scrollbar-thumb{background:#334155}
  nav button{padding:10px 12px;font-size:.78rem;flex-shrink:0}
  main{padding:12px}
  .card{padding:12px}
  .grid-2{grid-template-columns:1fr}
  .builder-layout{grid-template-columns:1fr;height:auto}
  .builder-pane{height:auto;min-height:200px;max-height:350px}
  .builder-toolbar{flex-direction:column;align-items:stretch}
  .builder-toolbar input,.builder-toolbar select{width:100%}
  #wf-canvas{min-height:300px}
  table{font-size:.78rem}
  th,td{padding:5px 4px}
  .modal-box .qr-img img{width:220px;height:220px}
  .tpl-grid{grid-template-columns:1fr}
}

/* ── Tooltip / help icon ────────────────────────────────── */
.help-icon{display:inline-block;width:16px;height:16px;border-radius:50%;background:#334155;color:#94a3b8;text-align:center;font-size:.7rem;line-height:16px;cursor:help;margin-left:6px}
.help-icon:hover{background:#475569;color:#e2e8f0}
</style>
</head>
<body>
<header>
  <div class="dot" id="wa-dot"></div>
  <h1>&#9654; BIMA Admin Panel</h1>
  <span id="header-info" style="font-size:.8rem;color:#64748b;margin-left:auto"></span>
</header>
<div class="api-key-bar">
  <span>API Key:</span>
  <input type="password" id="api-key-input" placeholder="Masukkan API key (kosong jika tidak ada)">
  <button onclick="saveKey()">Simpan</button>
  <span id="key-status" style="color:#22c55e;display:none">&#10003; Tersimpan</span>
</div>
<nav>
  <button class="active" onclick="showTab('status',this)">&#128200; Status</button>
  <button onclick="showTab('send',this)">&#128172; Kirim Pesan</button>
  <button onclick="showTab('kb',this)">&#128218; Knowledge Base</button>
  <button onclick="showTab('log',this)">&#128203; Log Grup</button>
  <button onclick="showTab('wf',this);loadWorkflows()">&#9654; Workflow</button>
  <button onclick="showTab('builder',this);initBuilder()">&#128296; Builder</button>
  <button onclick="showTab('settings',this);loadSettings()">&#9881; Pengaturan</button>
  <button onclick="showTab('templates',this);loadTemplates()">&#128218; Template</button>
  <button onclick="showTab('activity',this);startActivityFeed()">&#128225; Aktivitas</button>
</nav>
<main>

<!-- STATUS TAB -->
<div class="tab active" id="tab-status">

  <div class="welcome" id="welcome-card">
    <button class="welcome-close" onclick="dismissWelcome()" title="Tutup">&#10005;</button>
    <h2>&#128075; Selamat datang di Bima Admin Panel</h2>
    <p>Panel ini untuk kelola WhatsApp AI agent kamu. Pilih salah satu di bawah untuk mulai:</p>
    <div class="qs-grid">
      <div class="qs-card" onclick="document.querySelector('nav button:nth-child(2)').click()">
        <div class="qs-icon">&#128172;</div>
        <div class="qs-title">Kirim Pesan WA</div>
        <div class="qs-desc">Kirim pesan ke grup atau nomor tertentu dari panel ini.</div>
      </div>
      <div class="qs-card" onclick="document.querySelector('nav button:nth-child(5)').click()">
        <div class="qs-icon">&#9654;</div>
        <div class="qs-title">Workflow</div>
        <div class="qs-desc">Lihat workflow otomatis yang aktif. Bisa enable/disable.</div>
      </div>
      <div class="qs-card" onclick="document.querySelector('nav button:nth-child(6)').click()">
        <div class="qs-icon">&#128296;</div>
        <div class="qs-title">Builder Visual</div>
        <div class="qs-desc">Drag-drop bikin workflow baru tanpa coding (desktop disarankan).</div>
      </div>
      <div class="qs-card" onclick="document.querySelector('nav button:nth-child(3)').click()">
        <div class="qs-icon">&#128218;</div>
        <div class="qs-title">Knowledge Base</div>
        <div class="qs-desc">Dokumen yang dipelajari AI untuk jawab pertanyaan.</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Koneksi</h2>
    <div class="grid-2">
      <div class="stat"><div class="label">WhatsApp</div><div class="value" id="st-wa">...</div></div>
      <div class="stat"><div class="label">Telegram</div><div class="value" id="st-tg">...</div></div>
      <div class="stat"><div class="label">AI Provider</div><div class="value" id="st-provider">...</div></div>
      <div class="stat"><div class="label">Model</div><div class="value" id="st-model">...</div></div>
      <div class="stat"><div class="label">Tenant</div><div class="value" id="st-tenant">...</div></div>
      <div class="stat"><div class="label">API Port</div><div class="value" id="st-port">...</div></div>
    </div>
    <button class="btn secondary" style="margin-top:12px" onclick="loadStatus()">&#8635; Refresh</button>
  </div>
  <div class="card">
    <h2>Grup Aktif</h2>
    <table id="groups-table">
      <thead><tr><th>Nama</th><th>JID</th><th>Tipe</th></tr></thead>
      <tbody id="groups-body"><tr><td colspan="3" style="color:#64748b">Memuat...</td></tr></tbody>
    </table>
  </div>
</div>

<!-- SEND TAB -->
<div class="tab" id="tab-send">
  <div class="card">
    <h2>Kirim Pesan WhatsApp</h2>
    <label>Tujuan (pilih grup atau masukkan JID/nomor)</label>
    <select id="send-jid-select" onchange="onSelectGroup()">
      <option value="">-- Pilih grup --</option>
    </select>
    <label>Atau masukkan JID / nomor HP langsung</label>
    <input type="text" id="send-jid" placeholder="Contoh: 6281234567890@s.whatsapp.net atau 6281234567890">
    <label>Pesan</label>
    <textarea id="send-text" placeholder="Tulis pesan..."></textarea>
    <button class="btn" onclick="sendMsg()">&#9658; Kirim</button>
    <div class="msg" id="send-msg"></div>
  </div>
  <div class="card">
    <h2>Tanya Agent</h2>
    <label>Pertanyaan untuk AI agent</label>
    <input type="text" id="query-text" placeholder="Contoh: Siapa yang tag saya pagi ini?">
    <button class="btn" onclick="runQuery()">&#129302; Tanya</button>
    <div class="msg" id="query-msg"></div>
    <pre id="query-result" style="display:none;margin-top:10px"></pre>
  </div>
</div>

<!-- KNOWLEDGE TAB -->
<div class="tab" id="tab-kb">
  <div class="card">
    <h2>Dokumen Tersimpan</h2>
    <button class="btn secondary" onclick="loadKB()">&#8635; Refresh</button>
    <div style="margin-top:12px">
      <table>
        <thead><tr><th>File</th><th>Tanggal</th><th>Ukuran</th><th>Status</th><th></th></tr></thead>
        <tbody id="kb-body"><tr><td colspan="5" style="color:#64748b">Memuat...</td></tr></tbody>
      </table>
    </div>
    <div class="msg" id="kb-msg"></div>
  </div>
</div>

<!-- LOG TAB -->
<div class="tab" id="tab-log">
  <div class="card">
    <h2>Log Percakapan Grup</h2>
    <label>Pilih grup</label>
    <select id="log-group-select">
      <option value="">-- Pilih grup --</option>
    </select>
    <label>Atau masukkan JID manual</label>
    <input type="text" id="log-jid" placeholder="Contoh: 1234567890@g.us">
    <label>Periode (jam)</label>
    <select id="log-hours">
      <option value="1">1 jam</option>
      <option value="6">6 jam</option>
      <option value="12">12 jam</option>
      <option value="24" selected>24 jam</option>
      <option value="48">48 jam</option>
    </select>
    <button class="btn" onclick="loadLog()">&#128269; Lihat Log</button>
    <div class="loading" id="log-loading" style="display:none">Memuat log...</div>
    <div id="log-meta" style="font-size:.8rem;color:#64748b;margin-top:8px"></div>
    <pre id="log-result" style="display:none;margin-top:10px"></pre>
  </div>
</div>


<!-- WORKFLOW TAB -->
<div class="tab" id="tab-wf">
  <div class="card">
    <h2>Workflow</h2>
    <button class="btn secondary" onclick="loadWorkflows()">&#8635; Refresh</button>
    <div id="wf-loading" class="loading" style="margin-top:8px">Memuat...</div>
    <table id="wf-table" style="margin-top:12px;display:none">
      <thead>
        <tr>
          <th>ID</th><th>Nama</th><th>Trigger</th><th>Nodes</th>
          <th>Runs</th><th>OK%</th><th>Status</th><th>Aksi</th>
        </tr>
      </thead>
      <tbody id="wf-body"></tbody>
    </table>
  </div>
  <div class="card" id="wf-runs-card" style="display:none">
    <h2>Riwayat Run: <span id="wf-runs-title"></span></h2>
    <button class="btn secondary" style="float:right;margin-top:-30px" onclick="document.getElementById('wf-runs-card').style.display='none'">&#10005; Tutup</button>
    <div id="wf-runs-stats" style="margin-bottom:10px;color:#94a3b8;font-size:.8rem"></div>
    <table>
      <thead><tr><th>Waktu</th><th>Status</th><th>Durasi</th><th>Trigger</th><th>Error</th></tr></thead>
      <tbody id="wf-runs-body"></tbody>
    </table>
  </div>
</div>

<!-- BUILDER TAB (Visual Workflow Editor) -->
<div class="tab" id="tab-builder">
  <div id="builder-mobile-warn" class="card" style="display:none;background:#451a03;border-color:#b45309">
    <strong style="color:#fbbf24">&#9888; Layar kecil terdeteksi</strong>
    <p style="color:#fed7aa;font-size:.85rem;margin-top:6px">Visual Builder butuh drag-drop yang lebih nyaman di desktop/laptop. Bisa tetap dipakai tapi disarankan buka di komputer dengan layar lebar.</p>
  </div>
  <div class="builder-toolbar">
    <input type="text" id="bld-id" placeholder="Workflow ID (huruf kecil, underscore)">
    <input type="text" id="bld-name" placeholder="Nama workflow">
    <select id="bld-trigger" onchange="updateTriggerConfig()" style="width:auto;min-width:140px">
      <option value="manual">manual</option>
      <option value="wa.message">wa.message</option>
      <option value="schedule">schedule</option>
      <option value="file">file</option>
      <option value="webhook">webhook</option>
      <option value="wa.group_event">wa.group_event</option>
    </select>
    <input type="text" id="bld-trigger-arg" placeholder="Trigger config" style="display:none">
    <select id="bld-load" onchange="loadWfToBuilder(this.value)" style="width:auto;min-width:160px">
      <option value="">-- Load existing --</option>
    </select>
    <button class="btn" onclick="saveBuilder()">&#128190; Save</button>
    <button class="btn secondary" onclick="newBuilder()">&#128221; New</button>
    <button class="btn secondary" onclick="testRunBuilder()">&#9654; Test Run</button>
    <span id="bld-status" style="font-size:.75rem;color:#94a3b8;margin-left:auto"></span>
  </div>

  <div class="builder-layout">
    <div class="builder-pane">
      <h3>Palette</h3>
      <div id="palette"></div>
    </div>

    <div class="builder-pane" id="wf-canvas" ondrop="onCanvasDrop(event)" ondragover="event.preventDefault()">
      <svg id="wf-canvas-svg"></svg>
    </div>

    <div class="builder-pane">
      <h3>Inspector</h3>
      <div id="inspector"><div style="color:#64748b;font-size:.75rem">Pilih node untuk edit</div></div>
    </div>
  </div>
</div>

<!-- SETTINGS TAB -->
<div class="tab" id="tab-settings">
  <div class="card">
    <h2>Koneksi WhatsApp</h2>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span id="wa-status-badge" class="status-badge red"><span class="dot"></span><span id="wa-status-text">Terputus</span></span>
      <button class="btn" id="wa-connect-btn" onclick="connectWAModal()">&#128241; Hubungkan WhatsApp</button>
      <button class="btn danger" id="wa-disconnect-btn" onclick="disconnectWA()" style="display:none">Logout</button>
    </div>
    <p style="font-size:.78rem;color:#94a3b8;margin-top:10px">Scan QR di HP kamu: Buka WhatsApp &rarr; Setelan &rarr; Perangkat tertaut &rarr; Tautkan perangkat.</p>
  </div>

  <div class="card">
    <h2>AI Provider &amp; Model</h2>
    <label>Provider</label>
    <select id="cfg-provider">
      <option value="openai">openai</option>
      <option value="anthropic">anthropic</option>
      <option value="openrouter">openrouter</option>
      <option value="gemini">gemini</option>
      <option value="groq">groq</option>
      <option value="together">together</option>
    </select>
    <label>API Key <span class="help-icon" title="Tidak ditampilkan utuh untuk keamanan">?</span></label>
    <input type="password" id="cfg-apikey" placeholder="Masukkan API key baru (kosong = tidak ubah)">
    <div id="cfg-apikey-current" style="font-size:.72rem;color:#64748b;margin-top:4px">API key saat ini: -</div>
    <label>Model</label>
    <input type="text" id="cfg-model" placeholder="contoh: gpt-4o-mini, claude-3-5-sonnet-latest">
    <label>Bahasa</label>
    <select id="cfg-language">
      <option value="id">Indonesia</option>
      <option value="en">English</option>
    </select>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" id="cfg-sandbox" style="width:auto;margin:0">
      <span>Aktifkan Sandbox Shell (eksekusi perintah shell aman)</span>
    </label>
    <button class="btn" onclick="saveConfig()">&#128190; Simpan</button>
    <div class="msg" id="cfg-msg"></div>
  </div>

  <div class="card">
    <h2>Grup Input / Output</h2>
    <p style="font-size:.78rem;color:#94a3b8;margin-bottom:8px">Pilih grup mana yang dimonitor Bima (Input) dan ke mana hasil dikirim (Output). Tahan Ctrl/Cmd untuk pilih beberapa.</p>
    <div class="grid-2">
      <div>
        <label>Grup Input (dimonitor)</label>
        <select id="cfg-input-groups" multiple></select>
      </div>
      <div>
        <label>Grup Output (tujuan kirim)</label>
        <select id="cfg-output-groups" multiple></select>
      </div>
    </div>
    <button class="btn" onclick="saveGroups()">&#128190; Simpan Grup</button>
    <button class="btn secondary" onclick="refreshWAGroups()">&#8635; Refresh dari WhatsApp</button>
    <div class="msg" id="groups-msg"></div>
  </div>

  <div class="card">
    <h2>Notifikasi Admin</h2>
    <label>Admin JID atau nomor HP</label>
    <input type="text" id="cfg-admin-jid" placeholder="6281234567890 atau 6281234567890@s.whatsapp.net">
    <label>Threshold notifikasi (jumlah error sebelum dikirim)</label>
    <input type="number" id="cfg-admin-threshold" min="1" max="100" value="3">
    <button class="btn" onclick="saveAdminConfig()">&#128190; Simpan</button>
    <div class="msg" id="admin-msg"></div>
  </div>

  <div class="card">
    <h2>Tenants</h2>
    <p style="font-size:.78rem;color:#94a3b8;margin-bottom:8px">Tenant = workspace terpisah dengan config, KB, dan workflow sendiri.</p>
    <table class="tnt-table" id="tnt-table">
      <thead><tr><th>ID</th><th>Nama</th><th>Aktif</th><th>Dibuat</th><th>Aksi</th></tr></thead>
      <tbody id="tnt-body"><tr><td colspan="5" style="color:#64748b">Memuat...</td></tr></tbody>
    </table>
    <div style="margin-top:14px;border-top:1px solid #334155;padding-top:12px">
      <h3 style="font-size:.8rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Tambah Tenant Baru</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="text" id="new-tnt-id" placeholder="ID (huruf kecil, dash)" style="flex:1;min-width:140px">
        <input type="text" id="new-tnt-name" placeholder="Nama" style="flex:1;min-width:140px">
        <button class="btn" onclick="createTenant()">&#10133; Tambah</button>
      </div>
    </div>
    <div class="msg" id="tnt-msg"></div>
  </div>
</div>

<!-- TEMPLATES TAB -->
<div class="tab" id="tab-templates">
  <div class="card">
    <h2>Template Workflow Siap Pakai</h2>
    <p style="font-size:.78rem;color:#94a3b8;margin-bottom:8px">Klik <b>Install</b> untuk pasang template ke tenant aktif. Bisa langsung dijalankan dari tab Workflow setelah install.</p>
    <button class="btn secondary" onclick="loadTemplates()">&#8635; Refresh</button>
    <div id="tpl-grid" class="tpl-grid"><div style="color:#64748b">Memuat...</div></div>
  </div>
</div>

<!-- ACTIVITY TAB -->
<div class="tab" id="tab-activity">
  <div class="card">
    <h2>Aktivitas Real-time</h2>
    <div class="activity-toolbar">
      <span style="font-size:.78rem;color:#94a3b8">Filter:</span>
      <span class="chip active" data-filter="ALL" onclick="setActivityFilter('ALL',this)">All</span>
      <span class="chip wa"  data-filter="WA"  onclick="setActivityFilter('WA',this)">WA</span>
      <span class="chip wf"  data-filter="WF"  onclick="setActivityFilter('WF',this)">WF</span>
      <span class="chip api" data-filter="API" onclick="setActivityFilter('API',this)">API</span>
      <span class="chip err" data-filter="ERROR" onclick="setActivityFilter('ERROR',this)">ERROR</span>
      <button class="btn secondary" id="act-pause-btn" style="margin-left:auto;padding:5px 10px;font-size:.75rem" onclick="toggleActivityPause()">&#9208; Pause</button>
      <button class="btn secondary" style="padding:5px 10px;font-size:.75rem" onclick="clearActivity()">&#128465; Clear</button>
    </div>
    <div class="activity-feed" id="activity-feed"><div style="color:#64748b;font-size:.78rem">Menunggu aktivitas...</div></div>
    <div style="font-size:.7rem;color:#64748b;margin-top:6px" id="act-status">Stream: belum aktif</div>
  </div>
</div>

</main>
<script>
var API_KEY = localStorage.getItem('bima_api_key') || '';
if (API_KEY) document.getElementById('api-key-input').value = API_KEY;

// Hide welcome if dismissed previously
if (localStorage.getItem('bima_welcome_dismissed') === '1') {
  var w = document.getElementById('welcome-card');
  if (w) w.style.display = 'none';
}

function dismissWelcome() {
  document.getElementById('welcome-card').style.display = 'none';
  localStorage.setItem('bima_welcome_dismissed', '1');
}

// Auto-collapse API key bar after first save (or if empty and not needed)
function toggleApiKeyBar() {
  var bar = document.querySelector('.api-key-bar');
  if (!bar) return;
  bar.style.display = bar.style.display === 'none' ? 'flex' : 'none';
}

function saveKey() {
  API_KEY = document.getElementById('api-key-input').value.trim();
  localStorage.setItem('bima_api_key', API_KEY);
  var s = document.getElementById('key-status');
  s.style.display = 'inline';
  setTimeout(function(){ s.style.display='none'; }, 2000);
  loadStatus();
}

function headers() {
  var h = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-API-Key'] = API_KEY;
  return h;
}

function showTab(name, btn) {
  try {
    document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
    document.querySelectorAll('nav button').forEach(function(b){ b.classList.remove('active'); });
    var tab = document.getElementById('tab-' + name);
    if (!tab) { console.error('Tab not found: tab-' + name); return; }
    tab.classList.add('active');
    if (btn) btn.classList.add('active');
    // Scroll tab into view on mobile (nav is horizontal-scroll)
    if (btn && btn.scrollIntoView) btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    if (name === 'kb')        loadKB();
    if (name === 'status')    loadGroups();
    if (name === 'send')      loadGroupsForSend();
    if (name === 'log')       loadGroupsForLog();
    if (name === 'settings')  loadSettings();
    if (name === 'templates') loadTemplates();
    if (name === 'activity')  startActivityFeed();
    if (name !== 'activity')  stopActivityFeed();
  } catch(e) {
    console.error('showTab error:', e);
    alert('Error ganti tab: ' + e.message);
  }
}

function showMsg(id, text, isOk) {
  var el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + (isOk ? 'ok' : 'err');
  el.style.display = 'block';
  setTimeout(function(){ el.style.display='none'; }, 5000);
}

async function loadStatus() {
  try {
    var r = await fetch('/api/status', { headers: headers() });
    var d = await r.json();
    if (!r.ok) { document.getElementById('st-wa').textContent = 'Error: ' + d.error; return; }
    var wa = document.getElementById('st-wa');
    wa.textContent = d.waConnected ? 'Terhubung' : 'Terputus';
    wa.className = 'value ' + (d.waConnected ? 'green' : 'red');
    document.getElementById('wa-dot').className = 'dot ' + (d.waConnected ? 'green' : '');
    var tg = document.getElementById('st-tg');
    tg.textContent = d.tgConnected ? ('@' + (d.tgUsername||'bot')) : 'Tidak aktif';
    tg.className = 'value ' + (d.tgConnected ? 'green' : 'red');
    document.getElementById('st-provider').textContent = d.provider || '-';
    document.getElementById('st-model').textContent = d.model || '-';
    document.getElementById('st-tenant').textContent = d.tenant || 'default';
    document.getElementById('st-port').textContent = d.apiPort || '-';
    document.getElementById('header-info').textContent = d.provider + ' / ' + d.model;
    loadGroups();
  } catch(e) { document.getElementById('st-wa').textContent = 'Tidak dapat terhubung ke API'; }
}

async function loadGroups() {
  try {
    var r = await fetch('/api/groups', { headers: headers() });
    var d = await r.json();
    if (!r.ok) return;
    var tbody = document.getElementById('groups-body');
    if (!d.groups.length) { tbody.innerHTML = '<tr><td colspan="3" style="color:#64748b">Belum ada grup dikonfigurasi</td></tr>'; return; }
    tbody.innerHTML = d.groups.map(function(g) {
      var badge = g.type === 'input+output' ? '<span class="badge io">Input+Output</span>' :
                  g.type === 'input' ? '<span class="badge input">Input</span>' :
                  '<span class="badge output">Output</span>';
      return '<tr><td>' + esc(g.name) + '</td><td style="font-size:.75rem;color:#64748b">' + esc(g.jid) + '</td><td>' + badge + '</td></tr>';
    }).join('');
  } catch(e) {}
}

async function loadGroupsForSend() {
  try {
    var r = await fetch('/api/groups', { headers: headers() });
    var d = await r.json();
    if (!r.ok) return;
    var sel = document.getElementById('send-jid-select');
    sel.innerHTML = '<option value="">-- Pilih grup --</option>';
    d.groups.forEach(function(g) {
      sel.innerHTML += '<option value="' + g.jid + '">' + esc(g.name) + '</option>';
    });
  } catch(e) {}
}

async function loadGroupsForLog() {
  try {
    var r = await fetch('/api/log?groupJid=all', { headers: headers() });
    var d = await r.json();
    if (!r.ok) return;
    var r2 = await fetch('/api/groups', { headers: headers() });
    var d2 = await r2.json();
    var nameMap = {};
    (d2.groups||[]).forEach(function(g){ nameMap[g.jid] = g.name; });
    var sel = document.getElementById('log-group-select');
    sel.innerHTML = '<option value="">-- Pilih grup --</option>';
    (d.groupJids||[]).forEach(function(jid) {
      var name = nameMap[jid] || jid;
      sel.innerHTML += '<option value="' + jid + '">' + esc(name) + '</option>';
    });
  } catch(e) {}
}

function onSelectGroup() {
  var val = document.getElementById('send-jid-select').value;
  if (val) document.getElementById('send-jid').value = '';
}

async function sendMsg() {
  var jid  = document.getElementById('send-jid').value.trim() ||
             document.getElementById('send-jid-select').value;
  var text = document.getElementById('send-text').value.trim();
  if (!jid || !text) { showMsg('send-msg', 'Isi JID/grup dan pesan', false); return; }
  var phone = null;
  if (/^\d+$/.test(jid)) { phone = jid; jid = null; }
  try {
    var r = await fetch('/api/send', {
      method: 'POST', headers: headers(),
      body: JSON.stringify(jid ? { jid, text } : { phone, text })
    });
    var d = await r.json();
    if (r.ok) { showMsg('send-msg', 'Pesan terkirim ke ' + d.to, true); document.getElementById('send-text').value = ''; }
    else showMsg('send-msg', 'Gagal: ' + d.error, false);
  } catch(e) { showMsg('send-msg', 'Error: ' + e.message, false); }
}

async function runQuery() {
  var question = document.getElementById('query-text').value.trim();
  if (!question) return;
  var pre = document.getElementById('query-result');
  pre.style.display = 'block'; pre.textContent = 'Berpikir...';
  try {
    var r = await fetch('/api/query', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ question })
    });
    var d = await r.json();
    if (r.ok) { pre.textContent = d.answer; showMsg('query-msg', 'Selesai', true); }
    else { pre.textContent = 'Error: ' + d.error; showMsg('query-msg', d.error, false); }
  } catch(e) { pre.textContent = 'Error: ' + e.message; }
}

async function loadKB() {
  try {
    var r = await fetch('/api/knowledge', { headers: headers() });
    var d = await r.json();
    var tbody = document.getElementById('kb-body');
    if (!d.docs || !d.docs.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:#64748b">Belum ada dokumen tersimpan</td></tr>';
      return;
    }
    tbody.innerHTML = d.docs.map(function(doc) {
      var ts  = doc.timestamp ? new Date(doc.timestamp).toLocaleDateString('id-ID') : '-';
      var kb  = doc.size > 1000 ? Math.round(doc.size/1000) + ' KB' : doc.size + ' B';
      var badge = doc.compacted ? '<span class="badge output">Compact</span>' : '<span class="badge">Raw</span>';
      return '<tr>' +
        '<td>' + esc(doc.file) + '</td>' +
        '<td>' + ts + '</td>' +
        '<td>' + kb + '</td>' +
        '<td>' + badge + '</td>' +
        '<td><button class="btn danger" style="padding:4px 8px;font-size:.75rem;margin:0" onclick="delDoc(\'' + doc.hash + '\',this)">Hapus</button></td>' +
        '</tr>';
    }).join('');
  } catch(e) {}
}

async function delDoc(hash, btn) {
  if (!confirm('Hapus dokumen ini?')) return;
  btn.disabled = true; btn.textContent = '...';
  try {
    var r = await fetch('/api/knowledge/' + hash, { method: 'DELETE', headers: headers() });
    if (r.ok) { showMsg('kb-msg', 'Dokumen dihapus', true); loadKB(); }
    else { showMsg('kb-msg', 'Gagal hapus', false); btn.disabled=false; btn.textContent='Hapus'; }
  } catch(e) { btn.disabled=false; btn.textContent='Hapus'; }
}

async function loadLog() {
  var jid   = document.getElementById('log-jid').value.trim() ||
              document.getElementById('log-group-select').value;
  var hours = document.getElementById('log-hours').value;
  if (!jid) { document.getElementById('log-meta').textContent = 'Pilih atau masukkan JID grup'; return; }
  document.getElementById('log-loading').style.display = 'block';
  document.getElementById('log-result').style.display = 'none';
  try {
    var r = await fetch('/api/log?groupJid=' + encodeURIComponent(jid) + '&hours=' + hours, { headers: headers() });
    var d = await r.json();
    document.getElementById('log-loading').style.display = 'none';
    if (r.ok) {
      document.getElementById('log-meta').textContent = d.count + ' pesan dalam ' + hours + ' jam terakhir';
      var pre = document.getElementById('log-result');
      pre.textContent = d.log || '(Tidak ada pesan)';
      pre.style.display = 'block';
    } else {
      document.getElementById('log-meta').textContent = 'Error: ' + d.error;
    }
  } catch(e) {
    document.getElementById('log-loading').style.display = 'none';
    document.getElementById('log-meta').textContent = 'Error: ' + e.message;
  }
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Workflow tab ───────────────────────────────────────────────
async function loadWorkflows() {
  document.getElementById('wf-loading').style.display = 'block';
  document.getElementById('wf-table').style.display   = 'none';
  try {
    var r = await fetch('/api/workflows', { headers: headers() });
    var d = await r.json();
    document.getElementById('wf-loading').style.display = 'none';
    if (!r.ok) { document.getElementById('wf-loading').textContent = 'Error: ' + d.error; return; }

    var tbody = document.getElementById('wf-body');
    tbody.innerHTML = '';
    if (!d.workflows.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:#64748b">Belum ada workflow. Buat via CLI: /workflow create</td></tr>';
    } else {
      d.workflows.forEach(function(wf) {
        var trg = wf.trigger ? (wf.trigger.type + (wf.trigger.interval ? '/' + wf.trigger.interval : '') + (wf.trigger.match ? '/' + esc(wf.trigger.match) : '')) : '-';
        var stats = wf.stats;
        var enabledClass = wf.enabled ? 'green' : '';
        var statusLabel  = wf.enabled ? '● aktif' : '○ off';
        tbody.innerHTML += '<tr>' +
          '<td><code>' + esc(wf.id) + '</code></td>' +
          '<td>' + esc(wf.name) + '</td>' +
          '<td style="font-size:.75rem;color:#94a3b8">' + trg + '</td>' +
          '<td style="text-align:center">' + wf.nodeCount + '</td>' +
          '<td style="text-align:center">' + (stats ? stats.total : '-') + '</td>' +
          '<td style="text-align:center">' + (stats ? stats.successRate + '%' : '-') + '</td>' +
          '<td class="value ' + enabledClass + '" style="font-size:.8rem">' + statusLabel + '</td>' +
          '<td>' +
            '<button class="btn secondary" style="padding:3px 8px;font-size:.75rem;margin:1px" onclick="triggerRun(\'' + esc(wf.id) + '\')">&#9654; Run</button>' +
            '<button class="btn secondary" style="padding:3px 8px;font-size:.75rem;margin:1px" onclick="showRuns(\'' + esc(wf.id) + '\')">&#128203; History</button>' +
            (wf.enabled
              ? '<button class="btn danger" style="padding:3px 8px;font-size:.75rem;margin:1px" onclick="toggleWf(\'' + esc(wf.id) + '\',false)">Stop</button>'
              : '<button class="btn" style="padding:3px 8px;font-size:.75rem;margin:1px" onclick="toggleWf(\'' + esc(wf.id) + '\',true)">Start</button>'
            ) +
          '</td>' +
        '</tr>';
      });
    }
    document.getElementById('wf-table').style.display = 'table';
  } catch(e) {
    document.getElementById('wf-loading').textContent = 'Gagal memuat: ' + e.message;
  }
}

async function triggerRun(id) {
  if (!confirm('Jalankan workflow "' + id + '"?')) return;
  try {
    var r = await fetch('/api/workflows/' + encodeURIComponent(id) + '/run', { method: 'POST', headers: headers(), body: '{}' });
    var d = await r.json();
    if (r.ok) {
      alert((d.run ? (d.run.ok ? '✓ Selesai — ' + d.run.durationMs + 'ms' : '✗ Gagal: ' + d.run.error) : d.message) || 'Done');
      loadWorkflows();
    } else { alert('Error: ' + d.error); }
  } catch(e) { alert('Error: ' + e.message); }
}

async function toggleWf(id, enable) {
  var action = enable ? 'enable' : 'disable';
  try {
    var r = await fetch('/api/workflows/' + encodeURIComponent(id) + '/' + action, { method: 'PUT', headers: headers() });
    var d = await r.json();
    if (r.ok) loadWorkflows();
    else alert('Error: ' + d.error);
  } catch(e) { alert('Error: ' + e.message); }
}

async function showRuns(id) {
  var card = document.getElementById('wf-runs-card');
  document.getElementById('wf-runs-title').textContent = id;
  document.getElementById('wf-runs-body').innerHTML = '<tr><td colspan="5" style="color:#64748b">Memuat...</td></tr>';
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth' });
  try {
    var r = await fetch('/api/workflows/' + encodeURIComponent(id) + '/runs?limit=30', { headers: headers() });
    var d = await r.json();
    if (!r.ok) { document.getElementById('wf-runs-body').innerHTML = '<tr><td colspan="5">Error: ' + esc(d.error) + '</td></tr>'; return; }

    if (d.stats) {
      document.getElementById('wf-runs-stats').textContent =
        'Total: ' + d.stats.total + '  Sukses: ' + d.stats.success + '  Gagal: ' + d.stats.failed +
        '  Rate: ' + d.stats.successRate + '%  Avg: ' + d.stats.avgMs + 'ms';
    }

    var tbody = document.getElementById('wf-runs-body');
    tbody.innerHTML = '';
    if (!d.runs.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:#64748b">Belum ada riwayat run.</td></tr>';
    } else {
      d.runs.forEach(function(run) {
        var dt    = new Date(run.startedAt).toLocaleString('id-ID');
        var stCol = run.ok ? '<span style="color:#22c55e">✓ OK</span>' : '<span style="color:#ef4444">✗ Gagal</span>';
        tbody.innerHTML += '<tr>' +
          '<td style="font-size:.75rem;white-space:nowrap">' + dt + '</td>' +
          '<td>' + stCol + '</td>' +
          '<td>' + run.durationMs + 'ms</td>' +
          '<td style="color:#94a3b8;font-size:.75rem">' + esc(run.trigger || '-') + '</td>' +
          '<td style="color:#ef4444;font-size:.75rem">' + esc(run.error ? run.error.slice(0,80) : '') + '</td>' +
        '</tr>';
      });
    }
  } catch(e) {
    document.getElementById('wf-runs-body').innerHTML = '<tr><td colspan="5">Error: ' + e.message + '</td></tr>';
  }
}

// ═══════════════════════════════════════════════════════════════
// VISUAL WORKFLOW BUILDER
// ═══════════════════════════════════════════════════════════════
var BLD = {
  nodes: [],       // [{id, type, config, retry, timeout, branches, next, x, y, onError}]
  entry: null,
  trigger: { type: 'manual' },
  selectedId: null,
  drag: null,      // current drag-from-port state
  initialized: false,
};

var NODE_DEFS = {
  'wa.send':       { icon: '\u{1F4E8}', label: 'WA Send',       group: 'WhatsApp', fields: ['text'] },
  'wa.send_to':    { icon: '\u{1F4E9}', label: 'WA Send To',    group: 'WhatsApp', fields: ['jid', 'text'] },
  'wa.send_media': { icon: '\u{1F5BC}', label: 'WA Media',      group: 'WhatsApp', fields: ['type', 'source', 'jid', 'caption'] },
  'wa.transcribe': { icon: '\u{1F399}', label: 'Transcribe',    group: 'WhatsApp', fields: ['source'] },
  'wa.vision':     { icon: '\u{1F441}', label: 'Vision',        group: 'WhatsApp', fields: ['source', 'question'] },
  'wa.read_group': { icon: '\u{1F4D6}', label: 'Read Group',    group: 'WhatsApp', fields: ['jid', 'limit'] },
  'file.create':   { icon: '\u{1F4C4}', label: 'Create File',   group: 'File',     fields: ['name', 'content', 'title'] },
  'file.edit':     { icon: '✏',    label: 'Edit File',     group: 'File',     fields: ['name', 'content', 'title'] },
  'ai.call':       { icon: '\u{1F916}', label: 'AI Call',       group: 'AI',       fields: ['prompt', 'system'] },
  'http.request':  { icon: '\u{1F310}', label: 'HTTP',          group: 'Data',     fields: ['url', 'method', 'body', 'extract'] },
  'shell':         { icon: '\u{1F4BB}', label: 'Shell',         group: 'Data',     fields: ['cmd'] },
  'transform':     { icon: '⚙',    label: 'Transform',     group: 'Data',     fields: ['expr', 'inputVar'] },
  'json.extract':  { icon: '\u{1F50D}', label: 'JSON Extract',  group: 'Data',     fields: ['path'] },
  'condition':     { icon: '❓',    label: 'Condition',     group: 'Flow',     fields: ['expr'], branches: true },
  'loop':          { icon: '\u{1F501}', label: 'Loop',          group: 'Flow',     fields: ['items', 'itemVar', 'body', 'maxIterations'] },
  'repeat':        { icon: '\u{1F502}', label: 'Repeat',        group: 'Flow',     fields: ['times', 'body'] },
  'parallel':      { icon: '⚡',    label: 'Parallel',      group: 'Flow',     fields: ['branches'] },
  'workflow.run':  { icon: '⛓',    label: 'Sub-WF',        group: 'Flow',     fields: ['workflowId', 'input'] },
  'delay':         { icon: '⏳',    label: 'Delay',         group: 'Util',     fields: ['seconds'] },
  'memory.read':   { icon: '\u{1F4DA}', label: 'Mem Read',      group: 'Util',     fields: ['turns'] },
  'memory.write':  { icon: '\u{1F4BE}', label: 'Mem Write',     group: 'Util',     fields: ['content'] },
  'set':           { icon: '\u{1F4CC}', label: 'Set Var',       group: 'Util',     fields: ['key', 'value'] },
  'log':           { icon: '\u{1F4CB}', label: 'Log',           group: 'Util',     fields: ['text'] },
};

function initBuilder() {
  if (BLD.initialized) return;
  BLD.initialized = true;
  // Show mobile warning if narrow viewport
  if (window.innerWidth < 768) {
    var w = document.getElementById('builder-mobile-warn');
    if (w) w.style.display = 'block';
  }
  renderPalette();
  refreshBuilderLoadList();
  bindCanvasEvents();
}

function renderPalette() {
  var groups = {};
  Object.keys(NODE_DEFS).forEach(function(type) {
    var g = NODE_DEFS[type].group;
    if (!groups[g]) groups[g] = [];
    groups[g].push(type);
  });
  var html = '';
  Object.keys(groups).forEach(function(g) {
    html += '<div class="palette-group">' + g + '</div>';
    groups[g].forEach(function(type) {
      var def = NODE_DEFS[type];
      html += '<div class="palette-item" draggable="true" ondragstart="onPaletteDrag(event,\'' + type + '\')">' +
              '<span class="palette-icon">' + def.icon + '</span>' +
              '<span>' + def.label + '</span></div>';
    });
  });
  document.getElementById('palette').innerHTML = html;
}

function onPaletteDrag(e, type) {
  e.dataTransfer.setData('node-type', type);
  e.dataTransfer.effectAllowed = 'copy';
}

function onCanvasDrop(e) {
  e.preventDefault();
  var type = e.dataTransfer.getData('node-type');
  if (!type) return;
  var canvas = document.getElementById('wf-canvas');
  var rect = canvas.getBoundingClientRect();
  var x = e.clientX - rect.left + canvas.scrollLeft - 60;
  var y = e.clientY - rect.top  + canvas.scrollTop  - 20;
  addNode(type, Math.max(0, x), Math.max(0, y));
}

function uid(type) {
  var base = type.replace(/\./g, '_');
  var i = 1;
  while (BLD.nodes.find(function(n){ return n.id === base + i; })) i++;
  return base + i;
}

function addNode(type, x, y) {
  var def = NODE_DEFS[type];
  var node = { id: uid(type), type: type, config: {}, next: null, x: x|0, y: y|0 };
  if (def.branches) node.branches = { true: null, false: null };
  BLD.nodes.push(node);
  if (!BLD.entry) BLD.entry = node.id;
  selectNode(node.id);
  renderCanvas();
}

function renderCanvas() {
  var canvas = document.getElementById('wf-canvas');
  // Clear existing nodes (keep svg)
  Array.from(canvas.querySelectorAll('.canvas-node')).forEach(function(n){ n.remove(); });
  BLD.nodes.forEach(function(node) {
    var def = NODE_DEFS[node.type] || { icon: '?', label: node.type };
    var div = document.createElement('div');
    div.className = 'canvas-node' + (node.id === BLD.entry ? ' entry' : '') + (node.id === BLD.selectedId ? ' selected' : '');
    div.style.left = node.x + 'px';
    div.style.top  = node.y + 'px';
    div.dataset.id = node.id;
    var summary = nodeSummary(node);
    var badges = '';
    if (node.retry && node.retry.times > 0) badges += '<span class="node-badge">↻' + node.retry.times + '</span>';
    if (node.timeout) badges += '<span class="node-badge">⏱' + Math.round(node.timeout/1000) + 's</span>';
    div.innerHTML =
      '<div class="node-head"><span>' + def.icon + '</span><span class="node-id">' + node.id + '</span></div>' +
      '<div class="node-type">' + node.type + '</div>' +
      (summary ? '<div class="node-summary">' + escapeHtml(summary) + '</div>' : '') +
      (badges ? '<div class="node-badges">' + badges + '</div>' : '') +
      '<div class="node-port in" data-port="in" data-id="' + node.id + '"></div>' +
      (def.branches
        ? '<div class="node-port branch-true" data-port="true" data-id="' + node.id + '"></div>' +
          '<div class="node-port branch-false" data-port="false" data-id="' + node.id + '"></div>'
        : '<div class="node-port out" data-port="next" data-id="' + node.id + '"></div>');
    canvas.appendChild(div);
    makeDraggable(div, node);
  });
  drawConnections();
}

function nodeSummary(n) {
  var c = n.config || {};
  if (n.type === 'wa.send' || n.type === 'log') return c.text ? '"' + c.text.slice(0,30) + '"' : '';
  if (n.type === 'wa.send_to') return (c.jid||'?').split('@')[0] + ': "' + (c.text||'').slice(0,20) + '"';
  if (n.type === 'wa.send_media') return (c.type||'?') + ' ' + (c.source||'').slice(0,25);
  if (n.type === 'wa.transcribe' || n.type === 'wa.vision') return 'source: ' + (c.source||'trigger');
  if (n.type === 'file.create' || n.type === 'file.edit') return (c.name||'?');
  if (n.type === 'ai.call') return (c.prompt||'').slice(0,30);
  if (n.type === 'http.request') return (c.method||'GET') + ' ' + (c.url||'').slice(0,25);
  if (n.type === 'shell') return '$ ' + (c.cmd||'').slice(0,25);
  if (n.type === 'condition' || n.type === 'transform') return (c.expr||'').slice(0,30);
  if (n.type === 'delay') return (c.seconds||1) + 's';
  if (n.type === 'set') return c.key + ' = ' + String(c.value||'').slice(0,15);
  if (n.type === 'workflow.run') return '→ ' + (c.workflowId||'?');
  if (n.type === 'loop') return 'items: ' + String(c.items||'').slice(0,20);
  if (n.type === 'repeat') return (c.times||1) + 'x';
  return '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; });
}

function makeDraggable(el, node) {
  var startX, startY, origX, origY, dragging = false;
  el.addEventListener('mousedown', function(e) {
    if (e.target.classList.contains('node-port')) return;
    e.stopPropagation();
    selectNode(node.id);
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    origX = node.x; origY = node.y;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  function onMove(e) {
    if (!dragging) return;
    node.x = Math.max(0, origX + (e.clientX - startX));
    node.y = Math.max(0, origY + (e.clientY - startY));
    el.style.left = node.x + 'px';
    el.style.top  = node.y + 'px';
    drawConnections();
  }
  function onUp() {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

function bindCanvasEvents() {
  var canvas = document.getElementById('wf-canvas');
  canvas.addEventListener('mousedown', function(e) {
    if (e.target.classList.contains('node-port')) {
      var port = e.target;
      var srcId = port.dataset.id;
      var portType = port.dataset.port;
      if (portType === 'in') return;
      BLD.drag = { srcId: srcId, port: portType, fromX: e.clientX, fromY: e.clientY };
      var svg = document.getElementById('wf-canvas-svg');
      var tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tempPath.setAttribute('class', 'temp');
      tempPath.setAttribute('id', 'temp-path');
      svg.appendChild(tempPath);
      e.stopPropagation();
      e.preventDefault();
    }
  });
  document.addEventListener('mousemove', function(e) {
    if (!BLD.drag) return;
    var canvas = document.getElementById('wf-canvas');
    var rect = canvas.getBoundingClientRect();
    var srcNode = BLD.nodes.find(function(n){ return n.id === BLD.drag.srcId; });
    if (!srcNode) return;
    var sx = srcNode.x + 120 - canvas.scrollLeft;
    var sy = srcNode.y + 25 - canvas.scrollTop;
    var ex = e.clientX - rect.left;
    var ey = e.clientY - rect.top;
    var temp = document.getElementById('temp-path');
    if (temp) temp.setAttribute('d', bezier(sx, sy, ex, ey));
  });
  document.addEventListener('mouseup', function(e) {
    if (!BLD.drag) return;
    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (target && target.classList.contains('node-port') && target.dataset.port === 'in') {
      var targetId = target.dataset.id;
      var srcNode = BLD.nodes.find(function(n){ return n.id === BLD.drag.srcId; });
      if (srcNode && targetId !== srcNode.id) {
        if (BLD.drag.port === 'next') srcNode.next = targetId;
        else if (BLD.drag.port === 'true' || BLD.drag.port === 'false') {
          srcNode.branches = srcNode.branches || {};
          srcNode.branches[BLD.drag.port] = targetId;
        }
      }
    }
    var temp = document.getElementById('temp-path');
    if (temp) temp.remove();
    BLD.drag = null;
    renderCanvas();
  });
  document.getElementById('wf-canvas').addEventListener('click', function(e) {
    if (e.target.id === 'wf-canvas' || e.target.id === 'wf-canvas-svg') {
      selectNode(null);
    }
  });
}

function bezier(sx, sy, ex, ey) {
  var dx = Math.max(40, Math.abs(ex - sx) / 2);
  return 'M' + sx + ',' + sy + ' C' + (sx + dx) + ',' + sy + ' ' + (ex - dx) + ',' + ey + ' ' + ex + ',' + ey;
}

function drawConnections() {
  var svg = document.getElementById('wf-canvas-svg');
  var canvas = document.getElementById('wf-canvas');
  // Clear existing paths (except temp)
  Array.from(svg.querySelectorAll('path:not(.temp)')).forEach(function(p){ p.remove(); });
  BLD.nodes.forEach(function(node) {
    var edges = [];
    if (node.next) edges.push({ to: node.next, color: '#475569' });
    if (node.branches) {
      if (node.branches.true)  edges.push({ to: node.branches.true,  color: '#22c55e', yOffset: -15 });
      if (node.branches.false) edges.push({ to: node.branches.false, color: '#ef4444', yOffset: 15 });
    }
    edges.forEach(function(edge) {
      var dst = BLD.nodes.find(function(n){ return n.id === edge.to; });
      if (!dst) return;
      var sx = node.x + 120 - canvas.scrollLeft;
      var sy = node.y + 25 + (edge.yOffset || 0) - canvas.scrollTop;
      var ex = dst.x - canvas.scrollLeft;
      var ey = dst.y + 25 - canvas.scrollTop;
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', bezier(sx, sy, ex, ey));
      path.setAttribute('stroke', edge.color);
      path.dataset.from = node.id;
      path.dataset.toEdge = edge.color === '#22c55e' ? 'true' : (edge.color === '#ef4444' ? 'false' : 'next');
      path.addEventListener('click', function() {
        if (!confirm('Hapus koneksi ini?')) return;
        if (edge.color === '#22c55e') node.branches.true = null;
        else if (edge.color === '#ef4444') node.branches.false = null;
        else node.next = null;
        renderCanvas();
      });
      svg.appendChild(path);
    });
  });
}

function selectNode(id) {
  BLD.selectedId = id;
  renderInspector();
  Array.from(document.querySelectorAll('.canvas-node')).forEach(function(n) {
    n.classList.toggle('selected', n.dataset.id === id);
  });
}

function renderInspector() {
  var insp = document.getElementById('inspector');
  if (!BLD.selectedId) {
    insp.innerHTML = '<div style="color:#64748b;font-size:.75rem">Pilih node untuk edit</div>';
    return;
  }
  var node = BLD.nodes.find(function(n){ return n.id === BLD.selectedId; });
  if (!node) return;
  var def = NODE_DEFS[node.type] || { fields: [] };
  var html = '<div class="inspector-field"><label>ID</label><input value="' + escapeHtml(node.id) + '" onchange="renameNode(\'' + node.id + '\', this.value)"></div>';
  html += '<div class="inspector-field"><label>Type</label><input value="' + node.type + '" disabled></div>';
  def.fields.forEach(function(f) {
    var val = node.config[f] || '';
    var isLong = (f === 'text' || f === 'prompt' || f === 'system' || f === 'body' || f === 'expr' || f === 'content' || f === 'caption');
    html += '<div class="inspector-field"><label>' + f + '</label>';
    if (isLong) {
      html += '<textarea oninput="updateField(\'' + node.id + '\',\'' + f + '\',this.value)">' + escapeHtml(val) + '</textarea>';
    } else {
      html += '<input value="' + escapeHtml(val) + '" oninput="updateField(\'' + node.id + '\',\'' + f + '\',this.value)">';
    }
    html += '</div>';
  });
  // Retry + timeout
  html += '<div class="inspector-field"><label>Retry times (0–9)</label><input type="number" min="0" max="9" value="' + ((node.retry && node.retry.times) || 0) + '" onchange="updateRetry(\'' + node.id + '\',\'times\',this.value)"></div>';
  html += '<div class="inspector-field"><label>Retry backoff</label><select onchange="updateRetry(\'' + node.id + '\',\'backoff\',this.value)">' +
          '<option value="fixed"' + (node.retry && node.retry.backoff === 'fixed' ? ' selected' : '') + '>fixed</option>' +
          '<option value="exponential"' + (node.retry && node.retry.backoff === 'exponential' ? ' selected' : '') + '>exponential</option>' +
          '</select></div>';
  html += '<div class="inspector-field"><label>Timeout (sec, 0=default)</label><input type="number" min="0" value="' + (node.timeout ? Math.round(node.timeout/1000) : 0) + '" onchange="updateTimeout(\'' + node.id + '\',this.value)"></div>';
  html += '<div class="inspector-field"><label>On error</label><select onchange="updateField(\'' + node.id + '\',\'_onError\',this.value)">' +
          '<option value="stop"' + (node.onError !== 'continue' ? ' selected' : '') + '>stop</option>' +
          '<option value="continue"' + (node.onError === 'continue' ? ' selected' : '') + '>continue</option>' +
          '</select></div>';
  html += '<div style="display:flex;gap:6px;margin-top:10px">';
  html += '<button class="btn secondary" style="padding:5px 10px;font-size:.75rem" onclick="setEntry(\'' + node.id + '\')">Set Entry</button>';
  html += '<button class="btn danger" style="padding:5px 10px;font-size:.75rem" onclick="deleteNode(\'' + node.id + '\')">Hapus</button>';
  html += '</div>';
  insp.innerHTML = html;
}

function updateField(id, field, value) {
  var node = BLD.nodes.find(function(n){ return n.id === id; });
  if (!node) return;
  if (field === '_onError') { node.onError = value; return; }
  node.config[field] = value;
  renderCanvas();
}

function updateRetry(id, key, value) {
  var node = BLD.nodes.find(function(n){ return n.id === id; });
  if (!node) return;
  node.retry = node.retry || { times: 0, backoff: 'fixed', delayMs: 1000 };
  if (key === 'times') node.retry.times = parseInt(value) || 0;
  if (key === 'backoff') node.retry.backoff = value;
  if (node.retry.times === 0) delete node.retry;
  renderCanvas();
}

function updateTimeout(id, sec) {
  var node = BLD.nodes.find(function(n){ return n.id === id; });
  if (!node) return;
  var n = parseInt(sec) || 0;
  if (n > 0) node.timeout = n * 1000;
  else delete node.timeout;
  renderCanvas();
}

function renameNode(oldId, newId) {
  newId = (newId || '').trim();
  if (!newId || newId === oldId) return;
  if (BLD.nodes.find(function(n){ return n.id === newId; })) {
    alert('ID "' + newId + '" sudah dipakai');
    renderInspector();
    return;
  }
  BLD.nodes.forEach(function(n) {
    if (n.id === oldId) n.id = newId;
    if (n.next === oldId) n.next = newId;
    if (n.branches) {
      if (n.branches.true === oldId)  n.branches.true  = newId;
      if (n.branches.false === oldId) n.branches.false = newId;
    }
  });
  if (BLD.entry === oldId) BLD.entry = newId;
  BLD.selectedId = newId;
  renderCanvas();
  renderInspector();
}

function setEntry(id) {
  BLD.entry = id;
  renderCanvas();
}

function deleteNode(id) {
  if (!confirm('Hapus node "' + id + '"?')) return;
  BLD.nodes = BLD.nodes.filter(function(n){ return n.id !== id; });
  BLD.nodes.forEach(function(n) {
    if (n.next === id) n.next = null;
    if (n.branches) {
      if (n.branches.true === id)  n.branches.true  = null;
      if (n.branches.false === id) n.branches.false = null;
    }
  });
  if (BLD.entry === id) BLD.entry = (BLD.nodes[0] && BLD.nodes[0].id) || null;
  BLD.selectedId = null;
  renderCanvas();
  renderInspector();
}

function updateTriggerConfig() {
  var t = document.getElementById('bld-trigger').value;
  var arg = document.getElementById('bld-trigger-arg');
  var hints = {
    'wa.message':      'Keyword/regex (kosong = semua)',
    'schedule':        'Interval: 30s / 5m / 1h / 24h',
    'file':            'Path folder/file',
    'webhook':         'Webhook ID (default = workflow ID)',
    'wa.group_event':  'Actions: add,remove (pisah koma)',
  };
  if (hints[t]) {
    arg.placeholder = hints[t];
    arg.style.display = 'inline-block';
  } else {
    arg.style.display = 'none';
  }
}

function buildTriggerFromUI() {
  var t = document.getElementById('bld-trigger').value;
  var arg = (document.getElementById('bld-trigger-arg').value || '').trim();
  if (t === 'manual') return { type: 'manual' };
  if (t === 'wa.message') return { type: 'wa.message', match: arg || null };
  if (t === 'schedule')   return { type: 'schedule', interval: arg || '1h' };
  if (t === 'file')       return { type: 'file', path: arg || '~/bima-inbox', events: ['created', 'modified'] };
  if (t === 'webhook')    return { type: 'webhook', webhookId: arg || null };
  if (t === 'wa.group_event') return { type: 'wa.group_event', actions: (arg || 'add,remove').split(',').map(function(s){ return s.trim(); }) };
  return { type: 'manual' };
}

async function saveBuilder() {
  var id = (document.getElementById('bld-id').value || '').trim();
  var name = (document.getElementById('bld-name').value || '').trim();
  if (!id || !name) { alert('ID dan nama wajib diisi'); return; }
  if (!/^[a-z][a-z0-9_]*$/.test(id)) { alert('ID harus huruf kecil + underscore'); return; }
  if (!BLD.entry) { alert('Tidak ada node entry'); return; }

  // Strip x/y before save (positions are layout-only)
  var nodes = BLD.nodes.map(function(n) {
    var copy = JSON.parse(JSON.stringify(n));
    // Store position separately in _layout so it survives reload
    copy._layout = { x: n.x, y: n.y };
    delete copy.x; delete copy.y;
    return copy;
  });

  var wf = {
    id: id,
    name: name,
    description: '',
    enabled: false,
    trigger: buildTriggerFromUI(),
    nodes: nodes,
    entry: BLD.entry,
  };

  try {
    var r = await fetch('/api/workflows', { method: 'POST', headers: headers(), body: JSON.stringify(wf) });
    var d = await r.json();
    if (!r.ok) { alert('Gagal simpan: ' + (d.error || r.status)); return; }
    setBuilderStatus('✓ Disimpan: ' + id, true);
    refreshBuilderLoadList();
  } catch(e) {
    alert('Error: ' + e.message);
  }
}

function setBuilderStatus(text, ok) {
  var s = document.getElementById('bld-status');
  s.textContent = text;
  s.style.color = ok ? '#22c55e' : '#ef4444';
  setTimeout(function(){ s.textContent = ''; }, 3000);
}

function newBuilder() {
  if (BLD.nodes.length && !confirm('Buang workflow saat ini?')) return;
  BLD.nodes = [];
  BLD.entry = null;
  BLD.selectedId = null;
  document.getElementById('bld-id').value = '';
  document.getElementById('bld-name').value = '';
  document.getElementById('bld-trigger').value = 'manual';
  updateTriggerConfig();
  renderCanvas();
  renderInspector();
}

async function refreshBuilderLoadList() {
  try {
    var r = await fetch('/api/workflows', { headers: headers() });
    var d = await r.json();
    var sel = document.getElementById('bld-load');
    sel.innerHTML = '<option value="">-- Load existing --</option>';
    (d.workflows || d || []).forEach(function(wf) {
      var opt = document.createElement('option');
      opt.value = wf.id;
      opt.textContent = wf.id + ' — ' + (wf.name || '?');
      sel.appendChild(opt);
    });
  } catch {}
}

async function loadWfToBuilder(id) {
  if (!id) return;
  try {
    var r = await fetch('/api/workflows/' + encodeURIComponent(id), { headers: headers() });
    var data = await r.json();
    if (!r.ok) { alert('Gagal load: ' + (data.error || r.status)); return; }
    var wf = data.workflow || data;
    document.getElementById('bld-id').value = wf.id;
    document.getElementById('bld-name').value = wf.name || '';
    document.getElementById('bld-trigger').value = (wf.trigger && wf.trigger.type) || 'manual';
    var arg = '';
    if (wf.trigger) {
      if (wf.trigger.type === 'wa.message')      arg = wf.trigger.match || '';
      else if (wf.trigger.type === 'schedule')   arg = wf.trigger.interval || '';
      else if (wf.trigger.type === 'file')       arg = wf.trigger.path || '';
      else if (wf.trigger.type === 'webhook')    arg = wf.trigger.webhookId || '';
      else if (wf.trigger.type === 'wa.group_event') arg = (wf.trigger.actions || ['add','remove']).join(',');
    }
    document.getElementById('bld-trigger-arg').value = arg;
    updateTriggerConfig();

    // Auto-layout if no _layout stored
    var nodes = (wf.nodes || []).map(function(n, i) {
      var node = JSON.parse(JSON.stringify(n));
      if (node._layout) {
        node.x = node._layout.x;
        node.y = node._layout.y;
      } else {
        node.x = 60 + (i % 4) * 180;
        node.y = 30 + Math.floor(i / 4) * 110;
      }
      delete node._layout;
      return node;
    });
    BLD.nodes = nodes;
    BLD.entry = wf.entry;
    BLD.selectedId = null;
    renderCanvas();
    renderInspector();
    setBuilderStatus('✓ Loaded: ' + id, true);
  } catch(e) {
    alert('Error: ' + e.message);
  }
}

async function testRunBuilder() {
  var id = (document.getElementById('bld-id').value || '').trim();
  if (!id) { alert('Simpan workflow dulu sebelum test run'); return; }
  try {
    var r = await fetch('/api/workflows/' + encodeURIComponent(id) + '/run', { method: 'POST', headers: headers(), body: '{}' });
    var d = await r.json();
    if (!r.ok) { alert('Gagal: ' + (d.error || r.status)); return; }
    alert('Run: ' + (d.ok ? 'OK' : 'FAIL') + '\n' + (d.error || (d.steps || 0) + ' steps, ' + (d.durationMs || 0) + 'ms'));
  } catch(e) {
    alert('Error: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS TAB
// ═══════════════════════════════════════════════════════════════
var _cachedGroups = [];

async function loadSettings() {
  // Status badge
  try {
    var r = await fetch('/api/status', { headers: headers() });
    var d = await r.json();
    var b = document.getElementById('wa-status-badge');
    var t = document.getElementById('wa-status-text');
    var connectBtn = document.getElementById('wa-connect-btn');
    var disconnectBtn = document.getElementById('wa-disconnect-btn');
    if (d.waConnected) {
      b.className = 'status-badge green';
      t.textContent = 'Terhubung';
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'inline-block';
    } else {
      b.className = 'status-badge red';
      t.textContent = 'Terputus';
      connectBtn.style.display = 'inline-block';
      disconnectBtn.style.display = 'none';
    }
  } catch(e) {}

  // Config
  try {
    var r = await fetch('/api/config', { headers: headers() });
    var d = await r.json();
    if (r.ok) {
      document.getElementById('cfg-provider').value = d.config.provider || 'openai';
      document.getElementById('cfg-model').value    = d.config.model || '';
      document.getElementById('cfg-language').value = d.config.language || 'id';
      document.getElementById('cfg-sandbox').checked = !!d.config.sandboxEnabled;
      document.getElementById('cfg-apikey-current').textContent =
        'API key saat ini: ' + (d.config.apiKey || '(belum diset)');
      document.getElementById('cfg-admin-jid').value = d.config.adminJid || '';
      document.getElementById('cfg-admin-threshold').value = d.config.adminNotifyThreshold || 3;
    }
  } catch(e) {}

  // Groups (from WA + currently selected)
  await refreshWAGroups();
  loadTenants();
}

async function refreshWAGroups() {
  try {
    var r = await fetch('/api/wa/groups', { headers: headers() });
    var d = await r.json();
    if (r.ok && d.groups) {
      _cachedGroups = d.groups;
    } else if (r.status === 503) {
      _cachedGroups = [];
      showMsg('groups-msg', d.error || 'WhatsApp belum siap', false);
    }
  } catch(e) { _cachedGroups = []; }

  // Currently configured
  var current = { inputGroups: [], outputGroups: [] };
  try {
    var rc = await fetch('/api/config/groups', { headers: headers() });
    var dc = await rc.json();
    if (rc.ok) current = dc;
  } catch(e) {}

  function buildSelect(elId, selected) {
    var sel = document.getElementById(elId);
    sel.innerHTML = '';
    // Show union of (known WA groups) + (already-selected JIDs not in list)
    var seen = {};
    _cachedGroups.forEach(function(g) {
      seen[g.jid] = true;
      var opt = document.createElement('option');
      opt.value = g.jid;
      opt.textContent = g.name + '  (' + g.jid.split('@')[0] + ')';
      if (selected.indexOf(g.jid) !== -1) opt.selected = true;
      sel.appendChild(opt);
    });
    selected.forEach(function(jid) {
      if (!seen[jid]) {
        var opt = document.createElement('option');
        opt.value = jid;
        opt.textContent = jid + '  (tidak ditemukan)';
        opt.selected = true;
        sel.appendChild(opt);
      }
    });
    if (!sel.options.length) {
      var opt = document.createElement('option');
      opt.disabled = true;
      opt.textContent = '(belum ada grup — connect WA dulu)';
      sel.appendChild(opt);
    }
  }
  buildSelect('cfg-input-groups',  current.inputGroups  || []);
  buildSelect('cfg-output-groups', current.outputGroups || []);
}

async function saveConfig() {
  var body = {
    provider:       document.getElementById('cfg-provider').value,
    model:          document.getElementById('cfg-model').value.trim(),
    language:       document.getElementById('cfg-language').value,
    sandboxEnabled: document.getElementById('cfg-sandbox').checked,
  };
  var newKey = document.getElementById('cfg-apikey').value.trim();
  if (newKey) body.apiKey = newKey;
  try {
    var r = await fetch('/api/config', { method:'PUT', headers: headers(), body: JSON.stringify(body) });
    var d = await r.json();
    if (r.ok) {
      showMsg('cfg-msg', '✓ Tersimpan', true);
      document.getElementById('cfg-apikey').value = '';
      loadSettings();
    } else showMsg('cfg-msg', 'Gagal: ' + d.error, false);
  } catch(e) { showMsg('cfg-msg', 'Error: ' + e.message, false); }
}

async function saveAdminConfig() {
  var body = {
    adminJid: document.getElementById('cfg-admin-jid').value.trim(),
    adminNotifyThreshold: parseInt(document.getElementById('cfg-admin-threshold').value) || 3,
  };
  try {
    var r = await fetch('/api/config', { method:'PUT', headers: headers(), body: JSON.stringify(body) });
    var d = await r.json();
    if (r.ok) showMsg('admin-msg', '✓ Tersimpan', true);
    else showMsg('admin-msg', 'Gagal: ' + d.error, false);
  } catch(e) { showMsg('admin-msg', 'Error: ' + e.message, false); }
}

async function saveGroups() {
  function collect(elId) {
    var sel = document.getElementById(elId);
    var out = [];
    for (var i=0; i<sel.options.length; i++) {
      if (sel.options[i].selected && !sel.options[i].disabled) out.push(sel.options[i].value);
    }
    return out;
  }
  var body = {
    inputGroups:  collect('cfg-input-groups'),
    outputGroups: collect('cfg-output-groups'),
  };
  try {
    var r = await fetch('/api/config/groups', { method:'PUT', headers: headers(), body: JSON.stringify(body) });
    var d = await r.json();
    if (r.ok) showMsg('groups-msg', '✓ Tersimpan ' + body.inputGroups.length + ' input, ' + body.outputGroups.length + ' output', true);
    else showMsg('groups-msg', 'Gagal: ' + d.error, false);
  } catch(e) { showMsg('groups-msg', 'Error: ' + e.message, false); }
}

// ── WhatsApp connect modal + SSE QR ────────────────────────────
var _qrEventSource = null;

function connectWAModal() {
  var existing = document.getElementById('qr-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'qr-modal';
  overlay.innerHTML =
    '<div class="modal-box">' +
      '<h3>Scan QR Code WhatsApp</h3>' +
      '<div id="qr-img-wrap" class="qr-img"><div style="color:#0f172a;padding:60px 0">Memulai...</div></div>' +
      '<div class="qr-status" id="qr-status">Buka WhatsApp di HP → Setelan → Perangkat tertaut</div>' +
      '<button class="btn secondary modal-close" onclick="closeQRModal()">Tutup</button>' +
    '</div>';
  document.body.appendChild(overlay);

  // Trigger connect
  fetch('/api/wa/connect', { method:'POST', headers: headers() }).catch(function(){});

  // Open SSE stream
  var keyParam = API_KEY ? '?key=' + encodeURIComponent(API_KEY) : '';
  if (_qrEventSource) try { _qrEventSource.close(); } catch(e){}
  _qrEventSource = new EventSource('/api/wa/qr' + keyParam);
  _qrEventSource.onmessage = function(ev) {
    try {
      var d = JSON.parse(ev.data);
      if (d.qr) {
        var url = 'https://chart.googleapis.com/chart?chs=300x300&cht=qr&chl=' + encodeURIComponent(d.qr);
        var wrap = document.getElementById('qr-img-wrap');
        if (wrap) wrap.innerHTML = '<img src="' + url + '" alt="WhatsApp QR">';
        var s = document.getElementById('qr-status');
        if (s) s.textContent = 'Scan QR di atas dari WhatsApp HP.';
      } else if (d.event === 'connected') {
        var s2 = document.getElementById('qr-status');
        if (s2) s2.textContent = '✓ Terhubung! Menutup...';
        setTimeout(function() { closeQRModal(); loadSettings(); loadStatus(); }, 1200);
      } else if (d.event === 'error') {
        var s3 = document.getElementById('qr-status');
        if (s3) { s3.textContent = '✗ Error: ' + (d.msg || 'tidak diketahui'); s3.style.color = '#ef4444'; }
      }
    } catch(e) {}
  };
  _qrEventSource.onerror = function() {
    var s = document.getElementById('qr-status');
    if (s) s.textContent = 'Koneksi stream terputus. Tutup dan coba lagi.';
  };
}

function closeQRModal() {
  if (_qrEventSource) { try { _qrEventSource.close(); } catch(e){} _qrEventSource = null; }
  var m = document.getElementById('qr-modal');
  if (m) m.remove();
}

async function disconnectWA() {
  if (!confirm('Yakin disconnect WhatsApp? Sesi akan dihapus dan perlu scan QR lagi.')) return;
  try {
    var r = await fetch('/api/wa/disconnect', { method:'POST', headers: headers() });
    var d = await r.json();
    if (r.ok) { alert('✓ Berhasil logout.'); loadSettings(); loadStatus(); }
    else alert('Gagal: ' + d.error);
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Tenants ────────────────────────────────────────────────────
async function loadTenants() {
  try {
    var r = await fetch('/api/tenants', { headers: headers() });
    var d = await r.json();
    var tbody = document.getElementById('tnt-body');
    if (!r.ok) { tbody.innerHTML = '<tr><td colspan="5">Error: ' + esc(d.error) + '</td></tr>'; return; }
    if (!d.tenants.length) { tbody.innerHTML = '<tr><td colspan="5" style="color:#64748b">Belum ada tenant</td></tr>'; return; }
    tbody.innerHTML = d.tenants.map(function(t) {
      var actChip = t.active ? '<span class="badge output">✓ Aktif</span>' : '<span class="badge">-</span>';
      var dt = t.createdAt ? new Date(t.createdAt).toLocaleDateString('id-ID') : '-';
      var actions = '';
      if (!t.active) actions += '<button class="btn" onclick="activateTenant(\'' + esc(t.id) + '\')">Aktifkan</button>';
      if (t.id !== 'default') actions += '<button class="btn danger" onclick="deleteTenantUI(\'' + esc(t.id) + '\')">Hapus</button>';
      else actions += '<button class="btn danger" disabled style="opacity:.4;cursor:not-allowed">Hapus</button>';
      return '<tr>' +
        '<td><code>' + esc(t.id) + '</code></td>' +
        '<td>' + esc(t.name || '-') + '</td>' +
        '<td>' + actChip + '</td>' +
        '<td style="color:#64748b;font-size:.75rem">' + dt + '</td>' +
        '<td>' + actions + '</td>' +
        '</tr>';
    }).join('');
  } catch(e) {}
}

async function createTenant() {
  var id = document.getElementById('new-tnt-id').value.trim();
  var name = document.getElementById('new-tnt-name').value.trim();
  if (!id) { showMsg('tnt-msg', 'ID wajib diisi', false); return; }
  try {
    var r = await fetch('/api/tenants', { method:'POST', headers: headers(), body: JSON.stringify({ id, name }) });
    var d = await r.json();
    if (r.ok) {
      showMsg('tnt-msg', '✓ Tenant ditambahkan', true);
      document.getElementById('new-tnt-id').value = '';
      document.getElementById('new-tnt-name').value = '';
      loadTenants();
    } else showMsg('tnt-msg', 'Gagal: ' + d.error, false);
  } catch(e) { showMsg('tnt-msg', 'Error: ' + e.message, false); }
}

async function activateTenant(id) {
  try {
    var r = await fetch('/api/tenants/active', { method:'PUT', headers: headers(), body: JSON.stringify({ id }) });
    var d = await r.json();
    if (r.ok) {
      showMsg('tnt-msg', '✓ Tenant "' + id + '" diaktifkan. Refresh untuk lihat datanya.', true);
      loadTenants(); loadStatus();
    } else showMsg('tnt-msg', 'Gagal: ' + d.error, false);
  } catch(e) {}
}

async function deleteTenantUI(id) {
  if (!confirm('Hapus tenant "' + id + '"? Data tenant tidak ikut terhapus dari disk.')) return;
  try {
    var r = await fetch('/api/tenants/' + encodeURIComponent(id), { method:'DELETE', headers: headers() });
    var d = await r.json();
    if (r.ok) { showMsg('tnt-msg', '✓ Dihapus', true); loadTenants(); }
    else showMsg('tnt-msg', 'Gagal: ' + d.error, false);
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATES TAB
// ═══════════════════════════════════════════════════════════════
function iconForTags(tags) {
  if (!tags) return '\u{1F4E6}';
  if (tags.indexOf('crypto') !== -1)   return '\u{1F4B0}';
  if (tags.indexOf('weather') !== -1)  return '\u{1F324}';
  if (tags.indexOf('group') !== -1)    return '\u{1F465}';
  if (tags.indexOf('summary') !== -1)  return '\u{1F4DD}';
  if (tags.indexOf('schedule') !== -1) return '\u{23F0}';
  if (tags.indexOf('ai') !== -1)       return '\u{1F916}';
  if (tags.indexOf('wa.message') !== -1) return '\u{1F4AC}';
  if (tags.indexOf('http') !== -1)     return '\u{1F310}';
  return '\u{1F4E6}';
}

async function loadTemplates() {
  var grid = document.getElementById('tpl-grid');
  grid.innerHTML = '<div style="color:#64748b">Memuat...</div>';
  try {
    var r = await fetch('/api/templates', { headers: headers() });
    var d = await r.json();
    if (!r.ok) { grid.innerHTML = '<div style="color:#ef4444">Error: ' + esc(d.error) + '</div>'; return; }
    if (!d.templates.length) { grid.innerHTML = '<div style="color:#64748b">Belum ada template</div>'; return; }
    grid.innerHTML = d.templates.map(function(t) {
      var icon = iconForTags(t.tags);
      var tags = (t.tags || []).map(function(g) { return '<span class="chip">' + esc(g) + '</span>'; }).join('');
      return '<div class="tpl-card">' +
        '<div class="tpl-icon">' + icon + '</div>' +
        '<div class="tpl-name">' + esc(t.name) + '</div>' +
        '<div class="tpl-desc">' + esc(t.description || '') + '</div>' +
        '<div class="tpl-tags">' + tags + '</div>' +
        '<button class="btn" onclick="installTemplateUI(\'' + esc(t.id) + '\')">&#10133; Install</button>' +
        '</div>';
    }).join('');
  } catch(e) {
    grid.innerHTML = '<div style="color:#ef4444">Error: ' + e.message + '</div>';
  }
}

function installTemplateUI(tplId) {
  var existing = document.getElementById('tpl-modal');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'tpl-modal';
  overlay.innerHTML =
    '<div class="modal-box" style="text-align:left;max-width:500px">' +
      '<h3 style="text-align:center">Install Template: ' + esc(tplId) + '</h3>' +
      '<label>Workflow ID (huruf kecil, underscore)</label>' +
      '<input type="text" id="tpl-wfid" value="' + esc(tplId) + '">' +
      '<label>Vars JSON (opsional, contoh: {"city":"Bandung"})</label>' +
      '<textarea id="tpl-vars" placeholder="{}"></textarea>' +
      '<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">' +
        '<button class="btn secondary" onclick="closeTplModal()">Batal</button>' +
        '<button class="btn" onclick="doInstallTemplate(\'' + esc(tplId) + '\')">Install</button>' +
      '</div>' +
      '<div class="msg" id="tpl-modal-msg"></div>' +
    '</div>';
  document.body.appendChild(overlay);
}

function closeTplModal() {
  var m = document.getElementById('tpl-modal');
  if (m) m.remove();
}

async function doInstallTemplate(tplId) {
  var wfId = (document.getElementById('tpl-wfid').value || '').trim();
  if (!wfId) { showMsg('tpl-modal-msg', 'Workflow ID wajib diisi', false); return; }
  var varsText = (document.getElementById('tpl-vars').value || '').trim();
  var vars = {};
  if (varsText) {
    try { vars = JSON.parse(varsText); }
    catch(e) { showMsg('tpl-modal-msg', 'JSON vars tidak valid: ' + e.message, false); return; }
  }
  try {
    var r = await fetch('/api/templates/' + encodeURIComponent(tplId) + '/install', {
      method:'POST', headers: headers(),
      body: JSON.stringify({ workflowId: wfId, vars: vars }),
    });
    var d = await r.json();
    if (r.ok) {
      closeTplModal();
      alert('✓ Installed: ' + (d.workflow ? d.workflow.id : wfId) + '\n\nBuka tab Workflow untuk aktifkan.');
    } else {
      showMsg('tpl-modal-msg', 'Gagal: ' + d.error, false);
    }
  } catch(e) {
    showMsg('tpl-modal-msg', 'Error: ' + e.message, false);
  }
}

// ═══════════════════════════════════════════════════════════════
// ACTIVITY TAB
// ═══════════════════════════════════════════════════════════════
var _actSource = null;
var _actPaused = false;
var _actBuffer = [];
var _actFilter = 'ALL';

function startActivityFeed() {
  if (_actSource) return;
  var keyParam = API_KEY ? '?key=' + encodeURIComponent(API_KEY) : '';
  try {
    _actSource = new EventSource('/api/activity' + keyParam);
  } catch(e) {
    document.getElementById('act-status').textContent = 'Gagal connect: ' + e.message;
    return;
  }
  document.getElementById('act-status').textContent = 'Stream: aktif';
  _actSource.onmessage = function(ev) {
    try {
      var d = JSON.parse(ev.data);
      if (_actPaused) _actBuffer.push(d);
      else appendActivity(d);
    } catch(e) {}
  };
  _actSource.onerror = function() {
    document.getElementById('act-status').textContent = 'Stream: terputus, mencoba ulang...';
  };
}

function stopActivityFeed() {
  if (_actSource) { try { _actSource.close(); } catch(e){} _actSource = null; }
  var s = document.getElementById('act-status');
  if (s) s.textContent = 'Stream: belum aktif';
}

function appendActivity(entry) {
  var feed = document.getElementById('activity-feed');
  if (!feed) return;
  if (_actFilter !== 'ALL' && entry.tag !== _actFilter) return;
  // Clear placeholder
  if (feed.children.length === 1 && feed.firstChild && feed.firstChild.style && feed.firstChild.style.color === 'rgb(100, 116, 139)') {
    feed.innerHTML = '';
  }
  var ts = new Date(entry.ts).toLocaleTimeString('id-ID');
  var chipClass = 'chip';
  if (entry.tag === 'ERROR') chipClass += ' err';
  else if (entry.tag === 'WA') chipClass += ' wa';
  else if (entry.tag === 'WF') chipClass += ' wf';
  else chipClass += ' api';
  var row = document.createElement('div');
  row.className = 'activity-row';
  row.innerHTML =
    '<span class="a-ts">' + ts + '</span>' +
    '<span class="' + chipClass + '">' + esc(entry.tag) + '</span>' +
    '<span class="a-text">' + esc(entry.text) + '</span>';
  feed.appendChild(row);
  // Cap visible rows
  while (feed.children.length > 200) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}

function toggleActivityPause() {
  _actPaused = !_actPaused;
  var btn = document.getElementById('act-pause-btn');
  if (_actPaused) {
    btn.innerHTML = '&#9654; Resume';
  } else {
    btn.innerHTML = '&#9208; Pause';
    while (_actBuffer.length) appendActivity(_actBuffer.shift());
  }
}

function clearActivity() {
  document.getElementById('activity-feed').innerHTML = '<div style="color:#64748b;font-size:.78rem">(dibersihkan)</div>';
  _actBuffer = [];
}

function setActivityFilter(f, chip) {
  _actFilter = f;
  document.querySelectorAll('.activity-toolbar .chip').forEach(function(c){ c.classList.remove('active'); });
  if (chip) chip.classList.add('active');
}

loadStatus();
</script>
</body>
</html>`;

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

  // GET /api/wa/qr  — SSE stream of QR events
  if (route === '/api/wa/qr' && method === 'GET') {
    if (!_waHas('subscribeQR')) { _waUnavailable(res, 'subscribeQR'); return; }
    const wa = _wa();
    res.writeHead(200, {
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const write = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };

    // Replay current QR if fresh
    try {
      const cur = wa.getCurrentQR && wa.getCurrentQR();
      if (cur) write({ qr: cur });
    } catch {}

    let closed = false;
    const unsubscribe = wa.subscribeQR((payload) => {
      if (closed) return;
      if (typeof payload === 'string') {
        write({ qr: payload });
      } else if (payload && payload.event === 'connected') {
        write({ event: 'connected' });
        cleanup();
        try { res.end(); } catch {}
      } else if (payload && payload.event === 'error') {
        write({ event: 'error', msg: String(payload.payload || 'unknown') });
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
      send(res, 200, { ok: true, inputGroups, outputGroups });
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
