'use strict';

// Unit tests for admin notification on repeated workflow failures.
// Uses Node's built-in node:test runner — no external dependencies.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

// ── Isolated data dir per-process ─────────────────────────────
// Must be set BEFORE requiring workflow.js / config.js so DATA_DIR
// is captured at module load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bima-adminnotify-test-'));
process.env.BIMA_DATA = TMP_ROOT;

const wf     = require('../src/workflow');
const config = require('../src/config');

const TENANT_ID = 'default';
const ADMIN_JID = '628111222333@s.whatsapp.net';

// Capture every notification the workflow engine emits.
const sent = [];
async function mockSendFn(jid, text) {
  sent.push({ jid, text });
}

// Wire the mock and seed config (adminJid set, threshold=3).
wf.setSystemSenders({ sendFn: mockSendFn });
config.saveConfig({ adminJid: ADMIN_JID, adminNotifyThreshold: 3 }, TENANT_ID);

// Wait briefly so async _saveRunHistory + _checkAndNotifyAdmin flush.
const flush = () => new Promise(r => setTimeout(r, 100));

// Always-failing workflow definition. Uses non-`test_` id so run-history persists.
function failingWorkflow(id) {
  return {
    id,
    name: 'Failing WF',
    entry: 'shell1',
    nodes: [
      // shell node with an empty cmd → executor returns ok:false immediately.
      { id: 'shell1', type: 'shell', config: { cmd: '' }, next: null },
    ],
  };
}

function newCtx() {
  return {
    _tenantId: TENANT_ID,
    _jid:      '111@s.whatsapp.net',
    _sender:   '222@s.whatsapp.net',
    _trigger:  'manual',
  };
}

// Clean up tmp dir after all tests in this file complete.
test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// Reset mock + cooldown between tests.
function resetState() {
  sent.length = 0;
  wf._adminNotifyCooldown.clear();
}

// ──────────────────────────────────────────────────────────────
// 1. Notification fires after N consecutive failures
// ──────────────────────────────────────────────────────────────
test('notification fires after 3 consecutive failures', async () => {
  resetState();
  const workflow = failingWorkflow('wf_notify_1');

  // First 2 failures: no notification yet (threshold = 3).
  await wf.runWorkflow(workflow, newCtx());
  await flush();
  assert.equal(sent.length, 0, 'no notify after 1st failure');

  await wf.runWorkflow(workflow, newCtx());
  await flush();
  assert.equal(sent.length, 0, 'no notify after 2nd failure');

  // 3rd failure → notification.
  await wf.runWorkflow(workflow, newCtx());
  await flush();
  assert.equal(sent.length, 1, 'notify on 3rd failure');
  assert.equal(sent[0].jid, ADMIN_JID);
  assert.match(sent[0].text, /Workflow Gagal Berulang/);
  assert.match(sent[0].text, /wf_notify_1/);
  assert.match(sent[0].text, /3x berturut-turut/);
});

// ──────────────────────────────────────────────────────────────
// 2. Cooldown prevents duplicate notification within 1 hour
// ──────────────────────────────────────────────────────────────
test('cooldown prevents duplicate notification within 1 hour', async () => {
  resetState();
  const workflow = failingWorkflow('wf_notify_2');

  // 3 failures → 1st notify.
  for (let i = 0; i < 3; i++) {
    await wf.runWorkflow(workflow, newCtx());
    await flush();
  }
  assert.equal(sent.length, 1, 'one notify after threshold reached');

  // 4th and 5th failures should NOT notify (cooldown active).
  await wf.runWorkflow(workflow, newCtx());
  await flush();
  await wf.runWorkflow(workflow, newCtx());
  await flush();
  assert.equal(sent.length, 1, 'cooldown blocks subsequent notifies');

  // Cooldown map should hold the entry.
  assert.ok(wf._adminNotifyCooldown.has(`${TENANT_ID}::wf_notify_2`));
});

// ──────────────────────────────────────────────────────────────
// 3. Success resets the cooldown
// ──────────────────────────────────────────────────────────────
test('success resets cooldown so future streak re-notifies', async () => {
  resetState();
  const failing  = failingWorkflow('wf_notify_3');
  const succeeding = {
    id:    'wf_notify_3',  // same id so history is shared
    name:  'Failing WF',
    entry: 's',
    nodes: [
      { id: 's', type: 'set', config: { key: 'foo', value: 'bar' }, next: null },
    ],
  };

  // 3 failures → notify, cooldown set.
  for (let i = 0; i < 3; i++) {
    await wf.runWorkflow(failing, newCtx());
    await flush();
  }
  assert.equal(sent.length, 1);
  assert.ok(wf._adminNotifyCooldown.has(`${TENANT_ID}::wf_notify_3`));

  // A successful run should clear the cooldown marker.
  await wf.runWorkflow(succeeding, newCtx());
  await flush();
  assert.equal(wf._adminNotifyCooldown.has(`${TENANT_ID}::wf_notify_3`), false,
    'success clears cooldown');
});
