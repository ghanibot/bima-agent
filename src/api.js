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
