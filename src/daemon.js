'use strict';

/**
 * Daemon entry point — runs Bima as a background process without an interactive CLI.
 * Survives terminal/browser close. Stoppable via SIGTERM or `bima daemon stop`.
 *
 * Started by: `node src/cli.js daemon start` (detached spawn) or directly via
 *             `node src/daemon.js` (foreground for debugging).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR = process.env.BIMA_DATA || path.join(os.homedir(), '.bima');
const PID_PATH = path.join(DATA_DIR, 'daemon.pid');
const LOG_PATH = path.join(DATA_DIR, 'daemon.log');
const LOG_MAX  = 10 * 1024 * 1024; // 10 MB

// ── Logging ──────────────────────────────────────────────────
let _logStream = null;

function openLogStream() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Rotate if too big
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX) {
      const rotated = LOG_PATH + '.1';
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(LOG_PATH, rotated);
    }
  } catch {}
  _logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
}

function log(tag, msg) {
  const time = new Date().toLocaleString('id-ID', { hour12: false });
  const line = `[${time}] [${tag}] ${msg}\n`;
  if (_logStream) _logStream.write(line);
  if (process.stdout.isTTY) process.stdout.write(line); // also print when running in foreground
}

// ── Liveness check helper ────────────────────────────────────
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// ── PID file ─────────────────────────────────────────────────
function writePidFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, String(process.pid));
}

function removePidFile() {
  try { fs.unlinkSync(PID_PATH); } catch {}
}

function checkExistingDaemon() {
  if (!fs.existsSync(PID_PATH)) return null;
  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8'), 10);
    if (!pid || pid === process.pid) return null;
    if (pidAlive(pid)) return pid;
    // stale pid file
    removePidFile();
    return null;
  } catch { return null; }
}

// ── Graceful shutdown ────────────────────────────────────────
let _shuttingDown = false;

async function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log('DAEMON', `Received ${signal}, shutting down...`);

  // Stop REST API
  try {
    const { stopApi, getApiStatus } = require('./api');
    if (getApiStatus().running) {
      await stopApi();
      log('DAEMON', '✓ REST API stopped');
    }
  } catch (e) { log('ERROR', 'Stop API: ' + e.message); }

  // Disconnect WA
  try {
    const wa = require('./whatsapp');
    if (wa.disconnect) {
      await wa.disconnect();
      log('DAEMON', '✓ WhatsApp disconnected');
    }
  } catch (e) { log('ERROR', 'WA disconnect: ' + e.message); }

  // Stop scheduled workflows (clear all timers)
  try {
    const wf = require('./workflow');
    // Best-effort: iterate tenants + deactivate
    const { listTenants } = require('./tenant');
    const tenants = (listTenants() || []).map(t => t.id);
    if (!tenants.includes('default')) tenants.push('default');
    for (const tid of tenants) {
      const list = wf.listWorkflows(tid);
      for (const w of list) {
        try { wf.deactivateTriggers(tid, w.id); } catch {}
      }
    }
    log('DAEMON', '✓ Workflows deactivated');
  } catch (e) { log('ERROR', 'Stop workflows: ' + e.message); }

  removePidFile();
  log('DAEMON', '👋 Daemon stopped cleanly');

  if (_logStream) _logStream.end();
  setTimeout(() => process.exit(0), 200);
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  openLogStream();

  const existing = checkExistingDaemon();
  if (existing) {
    log('ERROR', `Daemon sudah berjalan (PID: ${existing}). Stop dulu via "node src/cli.js daemon stop".`);
    process.exit(1);
  }

  writePidFile();
  log('DAEMON', `🤖 Bima daemon starting (PID: ${process.pid})...`);

  // Load config
  const { getConfig } = require('./config');
  const cfg = getConfig();

  // ── Start REST API + Admin Panel ───────────────────────
  try {
    const { startApi } = require('./api');
    const apiPort = cfg.apiPort || 3000;

    const { getStatus: getWAStatus, sendMessage: sendWAMessage } = require('./whatsapp');
    const tgMod = (() => { try { return require('./telegram'); } catch { return null; } })();

    await startApi({
      port:    apiPort,
      apiKey:  cfg.apiKey || null,
      getStatus: () => {
        const ws  = getWAStatus();
        const tgSt = tgMod ? tgMod.getTelegramStatus() : {};
        return {
          waConnected: ws.connected,
          tgConnected: !!tgSt.running,
          tgUsername:  tgSt.username || null,
          provider:    cfg.provider,
          model:       cfg.model,
          tenant:      'default',
        };
      },
      sendMsg:  (jid, text) => sendWAMessage(jid, text),
      runQuery: async (question, tenantId) => {
        const { runAgent } = require('./agent');
        const c = getConfig(tenantId || 'default');
        return runAgent(question, [], c, '', null, tenantId || 'default', null, 'api');
      },
      tenantId: () => 'default',
    });
    log('API', `REST API + Admin Panel: http://localhost:${apiPort}/`);
  } catch (e) {
    log('ERROR', 'Start API: ' + e.message);
  }

  // ── Start WhatsApp (auto-reconnect from saved session) ─
  if (cfg.provider && cfg.apiKey) {
    try {
      const { startWA } = require('./whatsapp');
      await startWA(log);
      log('WA', '✓ WhatsApp module initialized');
    } catch (e) {
      log('ERROR', 'Start WA: ' + e.message);
    }
  } else {
    log('WARN', 'AI belum dikonfigurasi. Buka admin panel untuk setup.');
  }

  // ── Start scheduled / file / webhook workflows ─────────
  try {
    const { startScheduledWorkflows } = require('./workflow');
    const { listTenants } = require('./tenant');
    const tenants = (listTenants() || []).map(t => t.id);
    if (!tenants.includes('default')) tenants.push('default');
    let total = 0;
    for (const tid of tenants) {
      total += startScheduledWorkflows(tid, { _tenantId: tid }, log);
    }
    if (total > 0) log('WF', `✓ ${total} workflow terjadwal aktif`);
  } catch (e) { log('ERROR', 'Start workflows: ' + e.message); }

  log('DAEMON', '✓ Daemon ready. Use "node src/cli.js daemon stop" to shut down.');

  // ── Signal handlers ────────────────────────────────────
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));

  // On Windows, only SIGINT/SIGTERM are reliable; uncaught exceptions also trigger shutdown
  process.on('uncaughtException', (e) => {
    log('FATAL', 'Uncaught: ' + e.message);
    log('FATAL', e.stack || '(no stack)');
  });
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  console.error(e.stack);
  removePidFile();
  process.exit(1);
});

module.exports = { pidAlive, PID_PATH, LOG_PATH };
