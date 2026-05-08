'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http  = require('https'); // used for URL installs

const PLUGINS_DIR = process.env.BIMA_DATA
  ? path.join(process.env.BIMA_DATA, 'plugins')
  : path.join(os.homedir(), '.bima', 'plugins');

let _plugins    = [];
let _watcher    = null;
let _onReload   = null;  // callback(pluginName) when hot-reload fires

// ── Load ──────────────────────────────────────────────────────
function loadPlugins() {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  _plugins = [];
  try {
    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
    for (const f of files) {
      _loadOne(path.join(PLUGINS_DIR, f));
    }
  } catch {}
  return _plugins;
}

function _loadOne(fullPath) {
  try {
    // Clear require cache so hot-reload works
    delete require.cache[require.resolve(fullPath)];
    const p = require(fullPath);
    if (!p.name) return null;
    // Remove old version of same plugin if present
    const idx = _plugins.findIndex(x => x.name === p.name);
    if (idx !== -1) _plugins.splice(idx, 1);
    _plugins.push(p);
    return p;
  } catch (e) {
    return null;
  }
}

// ── Hot reload ────────────────────────────────────────────────
function watchPlugins(onReload) {
  if (_watcher) return;
  _onReload = onReload;
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  _watcher = fs.watch(PLUGINS_DIR, (event, filename) => {
    if (!filename || !filename.endsWith('.js')) return;
    const fullPath = path.join(PLUGINS_DIR, filename);

    // Debounce 500ms
    clearTimeout(_watcher._debounce);
    _watcher._debounce = setTimeout(() => {
      if (!fs.existsSync(fullPath)) {
        // File deleted — remove plugin
        const base = path.basename(filename, '.js');
        const idx  = _plugins.findIndex(p => p.name === base || p._file === filename);
        if (idx !== -1) {
          const name = _plugins[idx].name;
          _plugins.splice(idx, 1);
          if (_onReload) _onReload(`unloaded:${name}`);
        }
        return;
      }
      const p = _loadOne(fullPath);
      if (p && _onReload) _onReload(p.name);
    }, 500);
  });
}

// ── Getters ───────────────────────────────────────────────────
function getPlugins()     { return _plugins; }
function getPluginTools() { return _plugins.flatMap(p => p.tools || []); }
function getPluginCommands() {
  const cmds = {};
  for (const p of _plugins) {
    for (const [cmd, fn] of Object.entries(p.commands || {})) cmds[cmd] = fn;
  }
  return cmds;
}

// ── Install from local file ───────────────────────────────────
function installPlugin(filePath) {
  const dest = path.join(PLUGINS_DIR, path.basename(filePath));
  fs.copyFileSync(path.resolve(filePath), dest);
  const p = _loadOne(dest);
  if (!p) throw new Error('Plugin tidak valid (butuh exports.name)');
  return p;
}

// ── Install from URL or GitHub shorthand ──────────────────────
// Supports:
//   https://raw.githubusercontent.com/.../plugin.js  (direct raw URL)
//   https://github.com/user/repo                     (tries /main/index.js)
//   user/repo                                         (GitHub shorthand)
async function installFromUrl(input) {
  let url = input.trim();

  // GitHub shorthand: "user/repo" or "user/repo/file.js"
  if (!url.startsWith('http')) {
    const parts = url.split('/');
    if (parts.length === 2) {
      url = `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/main/index.js`;
    } else if (parts.length >= 3) {
      const file = parts.slice(2).join('/');
      url = `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/main/${file}`;
    }
  }

  // Convert github.com → raw.githubusercontent.com
  if (url.includes('github.com') && !url.includes('raw.githubusercontent.com')) {
    url = url
      .replace('https://github.com/', 'https://raw.githubusercontent.com/')
      .replace('/blob/', '/');
    if (!url.endsWith('.js')) url += '/main/index.js';
  }

  const code = await _fetchUrl(url);
  if (!code) throw new Error(`Gagal download dari: ${url}`);

  // Extract filename from URL
  const urlParts  = url.split('/');
  let   filename  = urlParts[urlParts.length - 1];
  if (!filename.endsWith('.js')) filename = filename + '.js';
  if (filename === 'index.js') {
    // Use repo name instead
    const repoIdx = urlParts.indexOf('raw.githubusercontent.com');
    filename = repoIdx !== -1 ? (urlParts[repoIdx + 2] || 'plugin') + '.js' : filename;
  }

  const dest = path.join(PLUGINS_DIR, filename);
  fs.writeFileSync(dest, code, 'utf8');

  const p = _loadOne(dest);
  if (!p) {
    fs.unlinkSync(dest);
    throw new Error('File bukan plugin Bima yang valid (butuh exports.name)');
  }
  return p;
}

function _fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return _fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Uninstall ─────────────────────────────────────────────────
function uninstallPlugin(name) {
  const idx = _plugins.findIndex(p => p.name === name);
  if (idx === -1) return false;

  // Find file
  const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    try {
      const full = path.join(PLUGINS_DIR, f);
      const p    = require(full);
      if (p.name === name) {
        fs.unlinkSync(full);
        delete require.cache[require.resolve(full)];
        break;
      }
    } catch {}
  }

  _plugins.splice(idx, 1);
  return true;
}

module.exports = {
  loadPlugins, watchPlugins,
  getPlugins, getPluginTools, getPluginCommands,
  installPlugin, installFromUrl, uninstallPlugin,
  PLUGINS_DIR,
};
