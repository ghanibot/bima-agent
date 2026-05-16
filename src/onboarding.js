'use strict';

// ══════════════════════════════════════════════════════════════
//  Onboarding wizard for first-time users
//
//  Walks new users through the recommended setup order:
//    1) AI provider + API key   (so Bima can actually think)
//    2) WhatsApp connection     (so Bima can listen / reply)
//    3) Input/output groups     (optional — only if WA terhubung)
//    4) REST API + Admin Panel  (optional)
//
//  Every step is skippable. A summary card is shown at the end and
//  `cfg.onboarded = true` is persisted so the wizard does not
//  auto-run again on the next boot.
//
//  Exported signature:
//      runOnboarding(tenantId, deps)
//
//  Where `deps` injects functions from cli.js to avoid the circular
//  require (cli.js itself requires this file).
//      deps = {
//        cmdModel, cmdWA, cmdSetGroup, cmdApi,
//        ui, ask, println,
//        getConfig, saveConfig, getWAStatus,
//      }
// ══════════════════════════════════════════════════════════════

const YES_NO_OPTS = [
  { label: 'Ya, lanjutkan',                desc: 'Mulai langkah ini sekarang' },
  { label: 'Lewati',                       desc: 'Lompati, bisa diatur nanti' },
];

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

async function runOnboarding(tenantId, deps) {
  const {
    cmdModel, cmdWA, cmdSetGroup, cmdApi,
    ui, ask, println,
    getConfig, saveConfig, getWAStatus,
  } = deps || {};

  // Defensive: if essential deps missing, abort silently rather than crash.
  if (!ui || !println || !getConfig || !saveConfig) return;

  const summary = {
    model:  'dilewati',
    wa:     'dilewati',
    groups: 'dilewati',
    api:    'dilewati',
  };

  // ── Welcome banner ────────────────────────────────────────────
  const welcome = [
    '',
    '╔══════════════════════════════════════════════════════╗',
    '║   Selamat datang di Bima Agent!                      ║',
    '╠══════════════════════════════════════════════════════╣',
    '║  Wizard ini akan memandu pengaturan awal step-by-    ║',
    '║  step: AI model, WhatsApp, grup, dan panel admin.    ║',
    '║  Setiap langkah bisa dilewati — pilih "Lewati" jika  ║',
    '║  belum siap, kamu bisa ulang kapan saja dengan /start║',
    '╚══════════════════════════════════════════════════════╝',
    '',
  ].join('\n');
  println(welcome);

  // Helper: 2-option yes/no via selectMenu. Returns true (Ya), false (Lewati/cancel).
  async function confirm(title) {
    try {
      const idx = await ui.selectMenu(title, YES_NO_OPTS);
      return idx === 0;
    } catch {
      return false;
    }
  }

  // ── Step 1: AI provider ──────────────────────────────────────
  try {
    const cfg = getConfig(tenantId) || {};
    const hasModel = !!(cfg.provider && cfg.apiKey);

    if (hasModel) {
      println(`[1/4] AI provider sudah diset: ${cfg.provider} / ${cfg.model || '--'}. Dilewati.`);
      summary.model = `sudah ada (${cfg.provider})`;
    } else {
      println('[1/4] AI Provider — pilih siapa "otak" Bima (OpenAI, Anthropic, Gemini, dll).');
      const go = await confirm('Set up AI provider sekarang?');
      if (go && typeof cmdModel === 'function') {
        await cmdModel();
        const after = getConfig(tenantId) || {};
        if (after.provider && after.apiKey) {
          summary.model = `${after.provider} / ${after.model || '--'}`;
          println(`✓ AI provider tersimpan: ${after.provider} / ${after.model || '--'}`);
        } else {
          summary.model = 'belum lengkap';
          println('(AI provider belum tersimpan lengkap — bisa diulang dengan /model)');
        }
      } else {
        println('Dilewati. Jalankan /model kapan saja untuk set provider.');
      }
    }
  } catch (e) {
    println(`(Step 1 error: ${e.message}) — lanjut ke step berikutnya.`);
  }

  // ── Step 2: WhatsApp ─────────────────────────────────────────
  let waConnectedAfterStep2 = false;
  try {
    const wa = safe(() => getWAStatus && getWAStatus(), {}) || {};
    if (wa.connected) {
      println('[2/4] WhatsApp sudah terhubung. Dilewati.');
      summary.wa = 'sudah terhubung';
      waConnectedAfterStep2 = true;
    } else {
      println('[2/4] WhatsApp — hubungkan akun WA-mu dengan scan QR code.');
      const go = await confirm('Hubungkan WhatsApp sekarang?');
      if (go && typeof cmdWA === 'function') {
        await cmdWA();
        // cmdWA starts the QR flow but does not block until connected.
        // We mark as "initiated" — actual connection happens async.
        summary.wa = 'proses QR dimulai';
        waConnectedAfterStep2 = !!(safe(() => getWAStatus && getWAStatus(), {}).connected);
        if (!waConnectedAfterStep2) {
          println('(Scan QR di terminal. Setelah terhubung, kamu bisa pilih grup dengan /input dan /output.)');
        }
      } else {
        println('Dilewati. Jalankan /wa kapan saja untuk hubungkan WhatsApp.');
      }
    }
  } catch (e) {
    println(`(Step 2 error: ${e.message}) — lanjut ke step berikutnya.`);
  }

  // ── Step 3: Input / Output groups (only meaningful if WA connected) ──
  try {
    const waNow = safe(() => getWAStatus && getWAStatus(), {}) || {};
    if (!waNow.connected) {
      println('[3/4] Grup Input/Output — perlu WhatsApp terhubung dulu. Dilewati.');
      summary.groups = 'butuh WA dulu';
    } else {
      println('[3/4] Grup WA — tentukan grup mana yang Bima dengarkan (input) dan balas ke (output).');
      const go = await confirm('Set up grup input/output sekarang?');
      if (go && typeof cmdSetGroup === 'function') {
        try { await cmdSetGroup('input');  } catch (e) { println(`(Set grup input gagal: ${e.message})`); }
        try { await cmdSetGroup('output'); } catch (e) { println(`(Set grup output gagal: ${e.message})`); }
        const after = getConfig(tenantId) || {};
        const inLbl  = after.inputGroupName  || (Array.isArray(after.inputGroups) && after.inputGroups.length ? `${after.inputGroups.length} grup` : '');
        const outLbl = after.outputGroupName || '';
        if (inLbl || outLbl) {
          summary.groups = `in: ${inLbl || '-'} | out: ${outLbl || '-'}`;
        } else {
          summary.groups = 'belum diset';
        }
      } else {
        println('Dilewati. Jalankan /input atau /output kapan saja.');
      }
    }
  } catch (e) {
    println(`(Step 3 error: ${e.message}) — lanjut ke step berikutnya.`);
  }

  // ── Step 4: REST API + Admin panel ───────────────────────────
  try {
    println('[4/4] REST API + Admin Panel — buka dashboard web untuk pantau & atur Bima dari browser.');
    const go = await confirm('Start REST API di port 3000 sekarang?');
    if (go && typeof cmdApi === 'function') {
      await cmdApi(['start', '3000']);
      summary.api = 'http://localhost:3000';
      println('Admin URL akan dibuka otomatis di browser. Ketik /admin untuk buka manual.');
    } else {
      println('Dilewati. Jalankan /api start [port] kapan saja.');
    }
  } catch (e) {
    println(`(Step 4 error: ${e.message})`);
  }

  // ── Persist onboarded flag ───────────────────────────────────
  try {
    saveConfig({ onboarded: true }, tenantId);
  } catch (e) {
    // Non-fatal — wizard ran successfully even if flag did not save.
    println(`(Catatan: tidak bisa simpan flag onboarded: ${e.message})`);
  }

  // ── Summary card ─────────────────────────────────────────────
  const mark = v => (v === 'dilewati' || v === 'belum lengkap' || v === 'butuh WA dulu' || v === 'belum diset')
    ? '○' : '✓';
  const card = [
    '',
    '╔══════════════════════════════════════════════════════╗',
    '║   Setup selesai!                                     ║',
    '╠══════════════════════════════════════════════════════╣',
    `║  ${mark(summary.model)}  AI Model   : ${String(summary.model).slice(0, 35).padEnd(35)} ║`,
    `║  ${mark(summary.wa)}  WhatsApp   : ${String(summary.wa).slice(0, 35).padEnd(35)} ║`,
    `║  ${mark(summary.groups)}  Grup WA    : ${String(summary.groups).slice(0, 35).padEnd(35)} ║`,
    `║  ${mark(summary.api)}  REST API   : ${String(summary.api).slice(0, 35).padEnd(35)} ║`,
    '╠══════════════════════════════════════════════════════╣',
    '║  Langkah selanjutnya:                                ║',
    '║   • ketik /help untuk lihat semua perintah           ║',
    '║   • kirim pertanyaan ke Bima langsung di sini        ║',
    '║   • /workflow template install untuk pasang          ║',
    '║     otomasi siap pakai                               ║',
    '╚══════════════════════════════════════════════════════╝',
    '',
  ].join('\n');
  println(card);
}

module.exports = { runOnboarding };
