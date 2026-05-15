'use strict';

const readline = require('readline');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

// ── ANSI colors ────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    s => `\x1b[1m${s}\x1b[0m`,
  dim:     s => `\x1b[2m${s}\x1b[0m`,
  green:   s => `\x1b[38;5;46m${s}\x1b[0m`,
  cyan:    s => `\x1b[38;5;81m${s}\x1b[0m`,
  yellow:  s => `\x1b[38;5;220m${s}\x1b[0m`,
  red:     s => `\x1b[38;5;196m${s}\x1b[0m`,
  blue:    s => `\x1b[38;5;39m${s}\x1b[0m`,
  gray:    s => `\x1b[38;5;245m${s}\x1b[0m`,
  white:   s => `\x1b[38;5;255m${s}\x1b[0m`,
  bgBlack: s => `\x1b[40m${s}\x1b[0m`,
};

const LOG_PREFIX = {
  INFO:  C.blue('[INFO]'),
  FILE:  C.green('[FILE]'),
  QUERY: C.yellow('[QURY]'),
  RETRY: C.yellow('[RTRY]'),
  ERROR: C.red('[ERR ]'),
  WARN:  C.yellow('[WARN]'),
  WA:    C.green('[WA  ]'),
  TG:    C.cyan('[TG  ]'),
  API:   C.yellow('[API ]'),
  AGENT: C.cyan('[AGNT]'),
  DEBUG: C.gray('[DEBG]'),
  STT:   C.yellow('[STT ]'),
};

// ── State ──────────────────────────────────────────────────────
let _rl           = null;
let _inputHandler = null;
let _promptText   = C.green('Bima') + C.gray(' › ') + ' ';
let _pickerActive = false;
let _cmdRunning   = false;  // true while an input handler is awaited
let _logQueue     = [];     // buffered logs while picker/ask is active

// ── init ──────────────────────────────────────────────────────
function init() {
  // Banner
  const banner = [
    '',
    C.green('  ██████╗ ██╗███╗   ███╗ █████╗ '),
    C.green('  ██╔══██╗██║████╗ ████║██╔══██╗'),
    C.green('  ██████╔╝██║██╔████╔██║███████║'),
    C.green('  ██╔══██╗██║██║╚██╔╝██║██╔══██║'),
    C.green('  ██████╔╝██║██║ ╚═╝ ██║██║  ██║'),
    C.green('  ╚═════╝ ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝'),
    C.dim('  WhatsApp AI Agent — Indonesia'),
    C.dim('  Ketik /help · @ attach file · / lihat perintah'),
    '',
  ].join('\n');

  process.stdout.write(banner + '\n');

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  _rl = readline.createInterface({
    input:   process.stdin,
    output:  process.stdout,
    prompt:  _promptText,
    terminal: true,
  });

  _rl.prompt();

  _rl.on('line', async (line) => {
    if (_pickerActive || _cmdRunning) return;
    const val = line.trim();
    if (!val) { _rl.prompt(); return; }
    if (_inputHandler) {
      _cmdRunning = true;
      try {
        await _inputHandler(val);
      } finally {
        _cmdRunning = false;
        if (!_pickerActive) _rl.prompt(true);
      }
    }
  });

  // Intercept @ and / keypresses before readline sees full line
  process.stdin.on('keypress', (ch, key) => {
    if (_pickerActive) return;
    if (!key) return;

    if (ch === '@') {
      // small delay so readline writes the char first, then we intercept
      setImmediate(() => {
        const cur = _rl.line || '';
        if (!cur.endsWith('@')) return;
        _pickerActive = true;
        _clearCurrentLine();
        showAtPicker((chosen) => {
          _pickerActive = false;
          const base = cur.slice(0, -1); // strip the '@'
          if (chosen) {
            _rl.write(null, { ctrl: true, name: 'u' }); // clear line
            _writeToLine(`${base}@${chosen} `);
          } else {
            _rl.write(null, { ctrl: true, name: 'u' });
            _writeToLine(base);
          }
          _rl.prompt(true);
        });
      });
      return;
    }

    if (ch === '/' && (!_rl.line || _rl.line === '')) {
      setImmediate(() => {
        const cur = _rl.line || '';
        if (cur !== '/') return;
        _pickerActive = true;
        _clearCurrentLine();
        showCmdPicker((chosen) => {
          _pickerActive = false;
          _rl.write(null, { ctrl: true, name: 'u' }); // clear line
          if (chosen) _writeToLine(chosen);
          _rl.prompt(true);
        });
      });
    }
  });

  _rl.on('SIGINT', () => {
    process.stdout.write('\n');
    if (_pickerActive || _cmdRunning) {
      // Force-reset stuck state so user can type again
      _pickerActive = false;
      _cmdRunning   = false;
      try { if (process.stdin.isTTY) process.stdin.setRawMode(true); } catch {}
      process.stdout.write(C.yellow('  ⚠ Operasi dibatalkan (Ctrl+C)\n'));
      _flushLogs();
    } else {
      process.stdout.write(C.gray('  Ctrl+C · ketik /exit untuk keluar\n'));
    }
    _rl.prompt(true);
  });

  _rl.on('close', () => process.exit(0));
}

function _clearCurrentLine() {
  process.stdout.write('\r\x1b[K');
}

function _writeToLine(text) {
  // Simulate keypress to set readline buffer
  // Instead, use a trick: clear line + re-prompt + write
  process.stdout.write(_promptText + text);
  // Inject into readline's internal buffer
  _rl.line = text;
  _rl.cursor = text.length;
}

// ── appendChat ────────────────────────────────────────────────
function appendChat(role, text) {
  _clearCurrentLine();
  const t = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  if (role === 'user') {
    process.stdout.write(C.gray(`[${t}] `) + C.bold(C.cyan('▶ Kamu')) + '\n');
  } else if (role === 'bima') {
    process.stdout.write(C.gray(`[${t}] `) + C.bold(C.green('◈ Bima')) + '\n');
  }

  const lines = String(text).split('\n');
  for (const l of lines) {
    if (role === 'system') {
      process.stdout.write(C.dim('  ' + l) + '\n');
    } else {
      process.stdout.write('  ' + l + '\n');
    }
  }

  process.stdout.write('\n');
  if (_rl && !_pickerActive) _rl.prompt(true);
}

// ── log ───────────────────────────────────────────────────────
function _printLog(type, msg) {
  _clearCurrentLine();
  const t     = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const label = LOG_PREFIX[type] || C.gray(`[${type.slice(0,4).padEnd(4)}]`);
  process.stdout.write(C.gray(t) + ' ' + label + ' ' + C.gray(msg) + '\n');
  if (_rl && !_pickerActive) _rl.prompt(true);
}

function _flushLogs() {
  while (_logQueue.length) {
    const { type, msg } = _logQueue.shift();
    _printLog(type, msg);
  }
}

function log(type, msg) {
  if (_pickerActive) {
    _logQueue.push({ type, msg });
    return;
  }
  _printLog(type, msg);
}

// ── updateStatus ──────────────────────────────────────────────
function updateStatus({ provider, model, waConnected, tenant, tgConnected, tgUsername, apiPort } = {}) {
  const wa  = waConnected  ? C.green('WA:●') : C.red('WA:○');
  const tg  = tgConnected  ? C.cyan(`TG:@${tgUsername || '●'}`) : C.gray('TG:○');
  const api = apiPort      ? C.yellow(`API:${apiPort}`) : '';
  const ten = tenant || 'default';
  const ai  = `${provider || '--'}/${model || '--'}`;
  _clearCurrentLine();
  process.stdout.write(
    C.gray('[STATUS] ') +
    C.dim(`tenant:${ten}  ai:${ai}  `) + wa + C.dim('  ') + tg +
    (api ? C.dim('  ') + api : '') + '\n'
  );
  if (_rl && !_pickerActive) _rl.prompt(true);
}

// ── onInput ───────────────────────────────────────────────────
function onInput(callback) {
  _inputHandler = callback;
}

// ── ask (interactive prompt) ──────────────────────────────────
function ask(question) {
  return new Promise(resolve => {
    _clearCurrentLine();
    process.stdout.write(C.yellow(question));
    const prevPickerActive = _pickerActive;
    _pickerActive = true;

    // Pause _rl agar tidak double-echo input saat ask() aktif
    try { if (_rl) _rl.pause(); } catch {}

    const savedKeypress = process.stdin.rawListeners('keypress');
    process.stdin.removeAllListeners('keypress');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);

    // terminal:false → tmp uses data events, tidak ada keypress/echo conflict
    const tmp = readline.createInterface({
      input: process.stdin, output: process.stdout, terminal: false,
    });

    let settled = false;
    function cleanup(ans) {
      if (settled) return;
      settled = true;
      try { tmp.close(); } catch {}
      try { if (process.stdin.isTTY) process.stdin.setRawMode(true); } catch {}
      savedKeypress.forEach(l => { try { process.stdin.on('keypress', l); } catch {} });
      // Resume _rl dan bersihkan sisa buffer
      try {
        if (_rl) {
          _rl.resume();
          if (_rl.line) _rl.write(null, { ctrl: true, name: 'u' });
        }
      } catch {}
      _pickerActive = prevPickerActive;
      if (!_pickerActive) _flushLogs();
      resolve(ans);
    }

    tmp.once('line',  ans => cleanup(ans));
    tmp.once('close', ()  => cleanup(''));  // stdin closed unexpectedly
  });
}

// ── Picker base: steal keypress from readline ─────────────────
function _stealKeypress(handler) {
  const saved = process.stdin.rawListeners('keypress');
  process.stdin.removeAllListeners('keypress');

  // Debounce wrapper — cegah double-fire dalam 60ms (key repeat OS)
  let _lastKeyMs = 0;
  function debounced(ch, key) {
    const now = Date.now();
    if (now - _lastKeyMs < 60) return;
    _lastKeyMs = now;
    handler(ch, key);
  }

  process.stdin.on('keypress', debounced);

  // Pause _rl agar tidak buffering input saat picker aktif
  try { if (_rl) _rl.pause(); } catch {}

  return function restore() {
    process.stdin.removeAllListeners('keypress');
    saved.forEach(l => process.stdin.on('keypress', l));
    // Resume _rl dan bersihkan buffer yang mungkin tertampung
    try {
      if (_rl) {
        _rl.resume();
        // Buang karakter yang sempat masuk ke buffer _rl selama picker
        if (_rl.line) {
          _rl.write(null, { ctrl: true, name: 'u' });
        }
      }
    } catch {}
  };
}

// ── showAtPicker ──────────────────────────────────────────────
function showAtPicker(callback) {
  let currentDir = process.cwd();
  let filterText = '';
  let selIdx     = 0;
  let items      = [];
  let drawnLines = 0;
  const MAX_SHOW = 12;

  function getItems() {
    try {
      const isRoot = path.dirname(currentDir) === currentDir;
      const up = isRoot ? [] : [{ name: '..', isDir: true, full: path.dirname(currentDir) }];
      const entries = fs.readdirSync(currentDir)
        .filter(e => e !== 'node_modules' && e !== '.git' &&
          (!filterText || e.toLowerCase().includes(filterText.toLowerCase())))
        .map(e => {
          const full = path.join(currentDir, e);
          let isDir = false;
          try { isDir = fs.statSync(full).isDirectory(); } catch {}
          return { name: e, isDir, full };
        })
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
      return [...up, ...entries];
    } catch { return []; }
  }

  function clearDraw() {
    if (drawnLines > 0) {
      process.stdout.write(`\x1b[${drawnLines}A\x1b[0J`);
      drawnLines = 0;
    }
  }

  function draw() {
    clearDraw();
    items  = getItems();
    selIdx = Math.min(selIdx, Math.max(0, items.length - 1));

    const show  = items.slice(0, MAX_SHOW);
    const lines = [];
    lines.push(C.dim('  ┌' + '─'.repeat(50) + '┐'));
    lines.push(C.dim('  │') + ' ' + C.cyan('@') + ' ' + C.dim(currentDir.replace(os.homedir(), '~').slice(-44).padEnd(46)) + C.dim('│'));
    lines.push(C.dim('  │') + ' Filter: ' + C.yellow(filterText || C.dim('(ketik untuk filter)')) + C.dim(' '.repeat(Math.max(0, 38 - filterText.length)) + '│'));
    lines.push(C.dim('  ├' + '─'.repeat(50) + '┤'));

    if (!show.length) {
      lines.push(C.dim('  │  (tidak ada file)' + ' '.repeat(32) + '│'));
    } else {
      show.forEach((item, i) => {
        const sel  = i === selIdx;
        const icon = item.isDir ? '▶' : ' ';
        const nm   = item.isDir ? C.yellow(icon + ' ' + item.name + '/') : (icon + ' ' + item.name);
        const raw  = (icon + ' ' + item.name + (item.isDir ? '/' : '')).slice(0, 44).padEnd(46);
        if (sel) {
          lines.push(C.dim('  │') + C.bgBlack(C.green(' ► ') + C.bold(C.green(raw))) + C.dim('│'));
        } else {
          lines.push(C.dim('  │') + '   ' + (item.isDir ? C.yellow(item.name + '/') : item.name).slice(0,44).padEnd(46) + C.dim('│'));
        }
      });
      if (items.length > MAX_SHOW) {
        lines.push(C.dim(`  │  ... ${items.length - MAX_SHOW} lainnya` + ' '.repeat(35) + '│'));
      }
    }

    lines.push(C.dim('  └' + '─'.repeat(50) + '┘'));
    lines.push(C.dim('  ↑↓:gerak  Enter:pilih/masuk  Esc:batal  Backspace:hapus filter'));

    process.stdout.write('\n' + lines.join('\n') + '\n');
    drawnLines = lines.length + 1;
  }

  let restore;

  function done(result) {
    clearDraw();
    if (restore) restore();
    callback(result);
  }

  function onKey(ch, key) {
    if (!key) return;
    switch (key.name) {
      case 'escape': done(null); return;
      case 'up':    selIdx = Math.max(0, selIdx - 1); draw(); return;
      case 'down':  selIdx = Math.min(Math.min(items.length, MAX_SHOW) - 1, selIdx + 1); draw(); return;
      case 'backspace':
        if (filterText.length > 0) { filterText = filterText.slice(0, -1); selIdx = 0; draw(); }
        else done(null);
        return;
      case 'return':
      case 'enter': {
        const item = items[selIdx];
        if (!item) { done(null); return; }
        if (item.isDir) {
          currentDir = item.full; filterText = ''; selIdx = 0; draw();
        } else {
          done(path.relative(process.cwd(), item.full).replace(/\\/g, '/'));
        }
        return;
      }
      default:
        if (ch && ch.charCodeAt(0) >= 32 && ch.length === 1 && !key.ctrl && !key.meta) {
          filterText += ch; selIdx = 0; draw();
        }
    }
  }

  restore = _stealKeypress(onKey);
  draw();
}

// ── showCmdPicker ─────────────────────────────────────────────
const COMMANDS = [
  { cmd: '/help',      desc: 'Tampilkan daftar perintah' },
  { cmd: '/wa',        desc: 'Hubungkan WhatsApp (scan QR)' },
  { cmd: '/status',    desc: 'Status koneksi & konfigurasi' },
  { cmd: '/model',     desc: 'Set AI provider & API key' },
  { cmd: '/input',     desc: 'Pilih grup WhatsApp input' },
  { cmd: '/output',    desc: 'Pilih grup WhatsApp output' },
  { cmd: '/knowledge', desc: 'Lihat dokumen tersimpan' },
  { cmd: '/compact',   desc: 'Kompres konteks dokumen' },
  { cmd: '/stt',       desc: 'Konfigurasi Speech-to-Text' },
  { cmd: '/reminder',  desc: 'Lihat daftar pengingat aktif' },
  { cmd: '/memory',    desc: 'Reset memori percakapan' },
  { cmd: '/ltm',       desc: 'Lihat / hapus memori jangka panjang' },
  { cmd: '/search',    desc: 'Cari di web dari terminal' },
  { cmd: '/polymarket', desc: 'Cari pasar prediksi Polymarket' },
  { cmd: '/tg',        desc: 'Kelola Telegram bot (token/start/stop)' },
  { cmd: '/tenant',    desc: 'Kelola tenant (list/add/switch/del)' },
  { cmd: '/skill',     desc: 'Kelola plugin/skill (list/add/info)' },
  { cmd: '/logout',    desc: 'Logout WhatsApp & hapus session' },
  { cmd: '/clear',     desc: 'Bersihkan layar' },
  { cmd: '/exit',      desc: 'Keluar dari Bima' },
];

function showCmdPicker(callback) {
  let filterText = '';
  let selIdx     = 0;
  let filtered   = [...COMMANDS];
  let drawnLines = 0;

  function clearDraw() {
    if (drawnLines > 0) {
      process.stdout.write(`\x1b[${drawnLines}A\x1b[0J`);
      drawnLines = 0;
    }
  }

  function draw() {
    clearDraw();
    filtered = filterText
      ? COMMANDS.filter(c => c.cmd.includes(filterText) || c.desc.toLowerCase().includes(filterText.toLowerCase()))
      : [...COMMANDS];
    selIdx = Math.min(selIdx, Math.max(0, filtered.length - 1));

    const lines = [];
    lines.push(C.dim('  ┌' + '─'.repeat(56) + '┐'));
    lines.push(C.dim('  │') + ' ' + C.green('/') + ' ' + C.dim('Perintah') + '  Filter: ' + C.yellow(filterText || C.dim('ketik untuk filter...')) + C.dim('│'));
    lines.push(C.dim('  ├' + '─'.repeat(56) + '┤'));

    if (!filtered.length) {
      lines.push(C.dim('  │  (tidak ada perintah yang cocok)' + ' '.repeat(22) + '│'));
    } else {
      filtered.forEach((c, i) => {
        const sel = i === selIdx;
        const row = ` ${c.cmd.padEnd(14)} ${c.desc}`.slice(0, 54).padEnd(56);
        if (sel) {
          lines.push(C.dim('  │') + C.bgBlack(C.green('►') + C.bold(C.cyan(c.cmd.padEnd(14))) + ' ' + C.white(c.desc.slice(0,39).padEnd(41))) + C.dim('│'));
        } else {
          lines.push(C.dim('  │') + '  ' + C.cyan(c.cmd.padEnd(14)) + ' ' + C.dim(c.desc.slice(0,39).padEnd(41)) + C.dim(' │'));
        }
      });
    }

    lines.push(C.dim('  └' + '─'.repeat(56) + '┘'));
    lines.push(C.dim('  ↑↓:gerak  Enter:pilih  Esc/Backspace(kosong):batal'));

    process.stdout.write('\n' + lines.join('\n') + '\n');
    drawnLines = lines.length + 1;
  }

  let restore;

  function done(result) {
    clearDraw();
    if (restore) restore();
    callback(result);
  }

  function onKey(ch, key) {
    if (!key) return;
    switch (key.name) {
      case 'escape': done(null); return;
      case 'up':    selIdx = Math.max(0, selIdx - 1); draw(); return;
      case 'down':  selIdx = Math.min(filtered.length - 1, selIdx + 1); draw(); return;
      case 'backspace':
        if (filterText.length > 0) { filterText = filterText.slice(0, -1); selIdx = 0; draw(); }
        else done(null);
        return;
      case 'return':
      case 'enter': {
        const item = filtered[selIdx];
        done(item ? item.cmd + ' ' : null);
        return;
      }
      default:
        if (ch && ch.charCodeAt(0) >= 32 && ch.length === 1 && !key.ctrl && !key.meta) {
          filterText += ch; selIdx = 0; draw();
        }
    }
  }

  restore = _stealKeypress(onKey);
  draw();
}

// ── selectMenu ────────────────────────────────────────────────
// Generic interactive arrow-key list picker.
// items: array of {label, desc} or strings.
// opts.canSkip (default true) — show Esc=batal hint.
// Returns Promise<number (0-based index)> or null if cancelled.
function selectMenu(title, items, opts = {}) {
  const MAX_SHOW = 12;
  const INNER_W  = 56;
  const LABEL_W  = 18;
  const DESC_W   = INNER_W - 2 - 3 - 1 - LABEL_W - 1; // 31
  const canSkip  = opts.canSkip !== false;

  return new Promise(resolve => {
    if (!items.length) { resolve(null); return; }

    _pickerActive = true;

    const norm = items.map(it =>
      typeof it === 'string' ? { label: it, desc: '' } : { label: '', desc: '', ...it }
    );

    let selIdx    = 0;
    let scrollTop = 0;
    let drawnLines = 0;
    // Skip any Enter keypress that was queued from the command that triggered this menu
    let ready = false;
    setImmediate(() => { ready = true; });

    function clearDraw() {
      if (drawnLines > 0) {
        process.stdout.write(`\x1b[${drawnLines}A\x1b[0J`);
        drawnLines = 0;
      }
    }

    function draw() {
      clearDraw();

      if (selIdx < scrollTop) scrollTop = selIdx;
      if (selIdx >= scrollTop + MAX_SHOW) scrollTop = selIdx - MAX_SHOW + 1;
      scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, norm.length - MAX_SHOW)));

      const visible = norm.slice(scrollTop, scrollTop + MAX_SHOW);
      const lines = [];

      lines.push(C.dim('  ┌' + '─'.repeat(INNER_W) + '┐'));
      lines.push(C.dim('  │') + C.bold(C.cyan((' ' + title).slice(0, INNER_W).padEnd(INNER_W))) + C.dim('│'));
      lines.push(C.dim('  ├' + '─'.repeat(INNER_W) + '┤'));

      if (scrollTop > 0) {
        lines.push(C.dim('  │') + C.dim(`  ↑ ${scrollTop} item di atas`.padEnd(INNER_W)) + C.dim('│'));
      }

      visible.forEach((item, vi) => {
        const gi  = scrollTop + vi;
        const num = String(gi + 1).padStart(2);
        const lbl = String(item.label || '').slice(0, LABEL_W).padEnd(LABEL_W);
        const dsc = String(item.desc  || '').slice(0, DESC_W).padEnd(DESC_W);

        if (gi === selIdx) {
          lines.push(
            C.dim('  │') +
            C.bgBlack(C.green(`► ${num}. `) + C.bold(C.white(lbl)) + ' ' + C.dim(dsc)) +
            C.dim('│')
          );
        } else {
          lines.push(
            C.dim('  │') +
            '  ' + C.dim(`${num}. `) + C.white(lbl) + ' ' + C.dim(dsc) +
            C.dim('│')
          );
        }
      });

      const remaining = norm.length - (scrollTop + visible.length);
      if (remaining > 0) {
        lines.push(C.dim('  │') + C.dim(`  ↓ ${remaining} item di bawah`.padEnd(INNER_W)) + C.dim('│'));
      }

      lines.push(C.dim('  └' + '─'.repeat(INNER_W) + '┘'));
      lines.push(C.dim(
        canSkip
          ? '  ↑↓:gerak  1-9:pilih cepat  Enter:pilih  Esc:batal'
          : '  ↑↓:gerak  1-9:pilih cepat  Enter:pilih'
      ));

      process.stdout.write('\n' + lines.join('\n') + '\n');
      drawnLines = lines.length + 1;
    }

    let restore;
    let settled = false;

    function done(idx) {
      if (settled) return;
      settled = true;
      _pickerActive = false;
      try { clearDraw(); } catch {}
      try { if (restore) restore(); } catch {}
      _flushLogs();
      resolve(idx);
    }

    function onKey(ch, key) {
      if (!key || !ready || settled) return;
      switch (key.name) {
        case 'escape': done(null); return;
        case 'up':    selIdx = Math.max(0, selIdx - 1); draw(); return;
        case 'down':  selIdx = Math.min(norm.length - 1, selIdx + 1); draw(); return;
        case 'return':
        case 'enter': done(selIdx); return;
        default:
          if (ch && /^[0-9]$/.test(ch) && !key.ctrl && !key.meta) {
            const n = parseInt(ch) === 0 ? 10 : parseInt(ch);
            if (n >= 1 && n <= norm.length) {
              selIdx = n - 1;
              draw();
              // Langsung confirm — tidak perlu tekan Enter lagi
              setTimeout(() => done(selIdx), 120);
            }
          }
      }
    }

    restore = _stealKeypress(onKey);
    draw();
  });
}

module.exports = { init, appendChat, log, updateStatus, onInput, showAtPicker, showCmdPicker, ask, selectMenu };
