'use strict';

/**
 * Daemon entry point — jalankan hanya WhatsApp agent tanpa CLI prompt.
 * Cocok untuk PM2 / background process 24 jam.
 */

const { startWA }   = require('./whatsapp');
const { getConfig } = require('./config');

function log(tag, msg) {
  const time = new Date().toLocaleTimeString('id-ID');
  console.log(`[${time}] [${tag}] ${msg}`);
}

async function main() {
  const cfg = getConfig();

  log('BIMA', '🤖 Bima daemon starting...');

  if (!cfg.provider || !cfg.apiKey) {
    log('ERROR', 'AI belum dikonfigurasi. Jalankan "bima" (CLI) dulu untuk setup /model');
    process.exit(1);
  }

  await startWA(log);

  log('BIMA', '✓ Agent aktif. Tekan Ctrl+C untuk stop.');

  // Keep alive
  process.on('SIGINT',  () => { log('BIMA', 'Stopped.'); process.exit(0); });
  process.on('SIGTERM', () => { log('BIMA', 'Stopped.'); process.exit(0); });
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
