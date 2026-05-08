'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const C = {
  green:  s => `\x1b[38;5;46m${s}\x1b[0m`,
  dim:    s => `\x1b[38;5;245m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  yellow: s => `\x1b[38;5;220m${s}\x1b[0m`,
  red:    s => `\x1b[38;5;196m${s}\x1b[0m`,
  cyan:   s => `\x1b[38;5;51m${s}\x1b[0m`,
};

// ── Steal stdin keypress listeners (fixes arrow key issue) ────
// Removes readline's keypress handler so our picker gets raw keys
function stealKeypress(ourHandler) {
  const saved = process.stdin.rawListeners('keypress');
  process.stdin.removeAllListeners('keypress');
  process.stdin.on('keypress', ourHandler);
  return function restore() {
    process.stdin.removeAllListeners('keypress');
    saved.forEach(l => process.stdin.on('keypress', l));
  };
}

// ── Interactive file picker ───────────────────────────────────
// Returns: selected path string, or null if cancelled
async function showFilePicker(startDir) {
  return new Promise((resolve) => {
    let currentDir = path.resolve(startDir || process.cwd());
    let filter     = '';
    let selIdx     = 0;
    let items      = [];
    let uiLines    = 0;
    const MAX_SHOW = 10;

    function getItems() {
      try {
        const entries = fs.readdirSync(currentDir);
        const list = [
          ...(path.dirname(currentDir) !== currentDir
            ? [{ name: '..', isDir: true }] : []),
          ...entries
            .filter(e => e !== 'node_modules' && e !== '.git')
            .map(e => {
              const full = path.join(currentDir, e);
              let isDir = false;
              try { isDir = fs.statSync(full).isDirectory(); } catch {}
              return { name: e, isDir };
            })
            .sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .filter(e => !filter || e.name.toLowerCase().includes(filter.toLowerCase())),
        ];
        return list;
      } catch { return []; }
    }

    function clearUI() {
      if (uiLines > 0) {
        process.stdout.write(`\x1b[${uiLines}A\x1b[0J`);
        uiLines = 0;
      }
    }

    function draw() {
      clearUI();
      items  = getItems();
      selIdx = Math.min(selIdx, Math.max(0, items.length - 1));

      const show  = items.slice(0, MAX_SHOW);
      const lines = [];

      lines.push(` ${C.dim('─'.repeat(48))}`);
      lines.push(` ${C.cyan('📁')} ${C.dim(currentDir)}`);
      lines.push(` ${C.dim('─'.repeat(48))}`);

      if (!items.length) {
        lines.push(` ${C.dim('  (kosong atau tidak ada yang cocok)')}`);
      } else {
        show.forEach((item, i) => {
          const sel  = i === selIdx;
          const arr  = sel ? C.green('▶') : ' ';
          const icon = item.isDir ? '📂' : '📄';
          const nm   = sel ? C.bold(C.green(item.name)) : item.name;
          lines.push(` ${arr} ${icon} ${nm}`);
        });
        if (items.length > MAX_SHOW) {
          lines.push(` ${C.dim(`   ... ${items.length - MAX_SHOW} lainnya — ketik untuk filter`)}`);
        }
      }

      lines.push(` ${C.dim('─'.repeat(48))}`);
      if (filter) lines.push(` Filter: ${C.yellow(filter)}`);
      lines.push(` ${C.dim('↑↓ gerak  Enter pilih  Esc batal  Backspace hapus filter')}`);

      process.stdout.write('\n' + lines.join('\n') + '\n');
      uiLines = lines.length + 1;
    }

    let restore;

    function cleanup(result) {
      clearUI();
      if (restore) restore();
      resolve(result);
    }

    function onKey(str, key) {
      if (!key) return;

      switch (key.name) {
        case 'escape':
          cleanup(null);
          return;

        case 'return':
        case 'enter': {
          const item = items[selIdx];
          if (!item) { cleanup(null); return; }
          if (item.isDir) {
            currentDir = item.name === '..'
              ? path.dirname(currentDir)
              : path.join(currentDir, item.name);
            filter = ''; selIdx = 0; draw();
          } else {
            const rel = path.relative(process.cwd(), path.join(currentDir, item.name));
            cleanup(rel.replace(/\\/g, '/'));
          }
          return;
        }

        case 'up':
          selIdx = Math.max(0, selIdx - 1); draw(); return;

        case 'down':
          selIdx = Math.min(items.length - 1, selIdx + 1); draw(); return;

        case 'backspace':
          filter = filter.slice(0, -1); selIdx = 0; draw(); return;

        default:
          if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 32) {
            filter += str; selIdx = 0; draw();
          }
      }
    }

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    restore = stealKeypress(onKey);
    draw();
  });
}

// ── Simple line diff ──────────────────────────────────────────
function diffLines(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const out = [];
  let added = 0; let removed = 0;
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i]; const n = newLines[i];
    if (o === n)              continue;
    if (o === undefined)    { out.push(C.green(`+ ${n}`));  added++;   }
    else if (n === undefined){ out.push(C.red(`- ${o}`));   removed++; }
    else { out.push(C.red(`- ${o}`)); out.push(C.green(`+ ${n}`)); added++; removed++; }
  }
  return { lines: out, added, removed };
}

module.exports = { showFilePicker, diffLines };
