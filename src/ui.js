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
  AGENT: C.cyan('[AGNT]'),
  DEBUG: C.gray('[DEBG]'),
  STT:   C.yellow('[STT ]'),
};

// ── State ──────────────────────────────────────────────────────
let _rl           = null;
let _inputHandler = null;
let _promptText   = C.green('Bima') + C.gray(' › ') + ' ';
let _pickerActive = false;

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

  _rl.on('line', (line) => {
    if (_pickerActive) return;
    const val = line.trim();
    if (!val) { _rl.prompt(); return; }
    if (_inputHandler) _inputHandler(val);
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
function log(type, msg) {
  _clearCurrentLine();
  const t     = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const label = LOG_PREFIX[type] || C.gray(`[${type.slice(0,4).padEnd(4)}]`);
  process.stdout.write(C.gray(t) + ' ' + label + ' ' + C.gray(msg) + '\n');
  if (_rl && !_pickerActive) _rl.prompt(true);
}

// ── updateStatus ──────────────────────────────────────────────
function updateStatus({ provider, model, waConnected, tenant } = {}) {
  // Print a one-line status update into the log stream
  const wa  = waConnected ? C.green('● Online') : C.red('● Offline');
  const ten = tenant   || 'default';
  const ai  = `${provider || '--'}/${model || '--'}`;
  _clearCurrentLine();
  process.stdout.write(
    C.gray('[STATUS] ') +
    C.dim(`tenant:${ten}  ai:${ai}  wa:`) + wa + '\n'
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
    const tmp = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Temporarily disable raw mode so readline works normally
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    tmp.question('', ans => {
      tmp.close();
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      resolve(ans);
    });
  });
}

// ── Picker base: steal keypress from readline ─────────────────
function _stealKeypress(handler) {
  const saved = process.stdin.rawListeners('keypress');
  process.stdin.removeAllListeners('keypress');
  process.stdin.on('keypress', handler);
  return function restore() {
    process.stdin.removeAllListeners('keypress');
    saved.forEach(l => process.stdin.on('keypress', l));
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

module.exports = { init, appendChat, log, updateStatus, onInput, showAtPicker, showCmdPicker, ask };
