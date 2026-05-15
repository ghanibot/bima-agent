'use strict';

const http = require('http');

let _server    = null;
let _port      = null;
let _apiKey    = null;
let _getStatus = null;
let _sendMsg   = null;
let _runQuery  = null;
let _tenantId  = () => 'default';

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
</nav>
<main>

<!-- STATUS TAB -->
<div class="tab active" id="tab-status">
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

</main>
<script>
var API_KEY = localStorage.getItem('bima_api_key') || '';
if (API_KEY) document.getElementById('api-key-input').value = API_KEY;

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
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('nav button').forEach(function(b){ b.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'kb') loadKB();
  if (name === 'status') loadGroups();
  if (name === 'send') loadGroupsForSend();
  if (name === 'log') loadGroupsForLog();
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
  if (typeof tenantId === 'function') _tenantId = tenantId;

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

module.exports = { startApi, stopApi, getApiStatus };
