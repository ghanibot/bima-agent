'use strict';

// Unit tests for the workflow engine.
// Uses Node's built-in node:test runner — no external dependencies.

const test     = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');
const os       = require('node:os');

// ── Isolated data dir per-process ─────────────────────────────
// Must be set BEFORE requiring workflow.js / workflow_ai.js so
// DATA_DIR is captured at module load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bima-wf-test-'));
process.env.BIMA_DATA = TMP_ROOT;

const wf  = require('../src/workflow');
const wai = require('../src/workflow_ai');

// Default tenant + sender stubs used by every test.
const TENANT_ID = 'default';
function newCtx(overrides = {}) {
  return {
    _tenantId: TENANT_ID,
    _jid:      '111@s.whatsapp.net',
    _sender:   '222@s.whatsapp.net',
    _sendFn:   async () => {},
    _trigger:  'manual',
    ...overrides,
  };
}

// Wait briefly so async _saveRunHistory has time to flush.
const flush = () => new Promise(r => setTimeout(r, 60));

// Clean up tmp dir after all tests in this file complete.
test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// ──────────────────────────────────────────────────────────────
// Core node executors
// ──────────────────────────────────────────────────────────────

test('set node sets context var and preserves output', async () => {
  const workflow = {
    id:    'wf_set_node',
    entry: 'a',
    nodes: [
      { id: 'a', type: 'set', config: { key: 'foo', value: 'bar' }, next: null },
    ],
  };
  const ctx = newCtx();
  const run = await wf.runWorkflow(workflow, ctx);
  assert.equal(run.ok, true);
  assert.equal(run.steps[0].output, 'bar');
  assert.equal(run.steps[0].ok, true);
});

test('log node executes and output captured', async () => {
  const workflow = {
    id:    'wf_log_node',
    entry: 'l',
    nodes: [
      { id: 'l', type: 'log', config: { text: 'hello world' }, next: null },
    ],
  };
  let logged = null;
  const run = await wf.runWorkflow(workflow, newCtx(), (_tag, msg) => { logged = msg; });
  assert.equal(run.ok, true);
  assert.equal(run.steps[0].output, 'hello world');
  // logFn is also invoked for the per-step trace; just confirm callback fired.
  assert.ok(logged !== null);
});

test('transform node evaluates JS expression with input available', async () => {
  // input defaults to ctx.lastOutput. Pre-populate it via initial context.
  const workflow = {
    id:    'wf_transform',
    entry: 't',
    nodes: [
      { id: 't', type: 'transform',
        config: { expr: 'Number(input) * 2' }, next: null },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx({ lastOutput: '21' }));
  assert.equal(run.ok, true);
  const tStep = run.steps.find(s => s.nodeId === 't');
  assert.equal(tStep.output, '42');
});

test('json.extract works with dot-path', async () => {
  const workflow = {
    id:    'wf_json_extract',
    entry: 'j',
    nodes: [
      { id: 'j', type: 'json.extract', config: { path: 'a.b' }, next: null },
    ],
  };
  const ctx = newCtx({ lastOutput: JSON.stringify({ a: { b: 42, c: 'x' } }) });
  const run = await wf.runWorkflow(workflow, ctx);
  assert.equal(run.ok, true);
  assert.equal(run.steps[0].output, '42');
});

test('condition node branches correctly on true / false', async () => {
  const workflow = {
    id:    'wf_condition',
    entry: 'c',
    nodes: [
      { id: 'c',   type: 'condition',
        config: { expr: "flag == 'yes'" },
        branches: { true: 'yes', false: 'no' } },
      { id: 'yes', type: 'set', config: { key: 'result', value: 'TRUE' },  next: null },
      { id: 'no',  type: 'set', config: { key: 'result', value: 'FALSE' }, next: null },
    ],
  };
  // True branch
  const runT = await wf.runWorkflow(workflow, newCtx({ flag: 'yes' }));
  assert.equal(runT.ok, true);
  assert.deepEqual(runT.steps.map(s => s.nodeId), ['c', 'yes']);
  // False branch
  const runF = await wf.runWorkflow(workflow, newCtx({ flag: 'no' }));
  assert.equal(runF.ok, true);
  assert.deepEqual(runF.steps.map(s => s.nodeId), ['c', 'no']);
});

test('delay node waits a small amount and returns ok', async () => {
  const workflow = {
    id:    'wf_delay',
    entry: 'd',
    nodes: [
      { id: 'd', type: 'delay', config: { seconds: 0.05 }, next: null },
    ],
  };
  const t0 = Date.now();
  const run = await wf.runWorkflow(workflow, newCtx());
  const elapsed = Date.now() - t0;
  assert.equal(run.ok, true);
  assert.ok(elapsed >= 45, `delay too short: ${elapsed}ms`);
  assert.ok(elapsed < 2000, `delay too long: ${elapsed}ms`);
});

test('delay caps long sleeps so the engine aborts via wrapper timeout', async () => {
  // delay applies Math.min(ms, 30000) — i.e. it is bounded. We use a short
  // requested duration (500ms) plus an even shorter wrapper timeout (100ms)
  // so the wrapper times out first. The point is that the wrapper timeout
  // *can* abort delay, proving delay is not unbounded.
  // NB: we cannot use seconds=1000 because delay's internal setTimeout is
  // not cancellable from the wrapper, so it would keep the event loop alive
  // for ~30s after the test finishes.
  const workflow = {
    id:    'wf_delay_cap',
    entry: 'd',
    nodes: [
      { id: 'd', type: 'delay', config: { seconds: 0.5 }, timeout: 100, next: null },
    ],
  };
  const t0 = Date.now();
  const run = await wf.runWorkflow(workflow, newCtx());
  const elapsed = Date.now() - t0;
  assert.equal(run.ok, false);
  assert.match(String(run.error), /timeout/i);
  assert.ok(elapsed < 400, `delay did not abort fast enough: ${elapsed}ms`);
});

// ──────────────────────────────────────────────────────────────
// DAG runner mechanics
// ──────────────────────────────────────────────────────────────

test('linear workflow runs every node in the next chain', async () => {
  const workflow = {
    id:    'wf_linear',
    entry: 'a',
    nodes: [
      { id: 'a', type: 'set', config: { key: 'x', value: '1' }, next: 'b' },
      { id: 'b', type: 'set', config: { key: 'y', value: '2' }, next: 'c' },
      { id: 'c', type: 'log', config: { text: 'done' },         next: null },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx());
  assert.equal(run.ok, true);
  assert.deepEqual(run.steps.map(s => s.nodeId), ['a', 'b', 'c']);
});

test('cycle detection: A→B→A errors out gracefully', async () => {
  const workflow = {
    id:    'wf_cycle',
    entry: 'a',
    nodes: [
      { id: 'a', type: 'set', config: { key: 'x', value: '1' }, next: 'b' },
      { id: 'b', type: 'set', config: { key: 'y', value: '2' }, next: 'a' },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx());
  assert.equal(run.ok, false);
  assert.match(String(run.error), /Cycle detected/);
});

test('unknown node type errors out gracefully', async () => {
  const workflow = {
    id:    'wf_unknown_type',
    entry: 'a',
    nodes: [
      { id: 'a', type: 'this.node.does.not.exist', config: {}, next: null },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx());
  assert.equal(run.ok, false);
  assert.match(String(run.error), /Unknown node type/);
});

test('onError: "continue" skips failed node and continues to next', async () => {
  const workflow = {
    id:    'wf_on_error_continue',
    entry: 'a',
    nodes: [
      { id: 'a', type: 'transform',
        config: { expr: '(() => { throw new Error("boom"); })()' },
        onError: 'continue', next: 'b' },
      { id: 'b', type: 'set', config: { key: 'reached', value: 'yes' }, next: null },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx());
  assert.equal(run.ok, true, `expected ok with onError continue, got ${run.error}`);
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[0].ok, false);
  assert.equal(run.steps[1].ok, true);
  assert.equal(run.steps[1].output, 'yes');
});

test('retry: failing node retries up to retry.times and records attempt count', async () => {
  const workflow = {
    id:    'wf_retry',
    entry: 'fail',
    nodes: [
      { id: 'fail', type: 'transform',
        config: { expr: '(() => { throw new Error("nope") })()' },
        retry:   { times: 2, delayMs: 100, backoff: 'fixed' },
        next: null },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx());
  assert.equal(run.ok, false);
  // 1 initial + 2 retries = 3 attempts
  assert.equal(run.steps[0].attempts, 3);
});

test('timeout: long-running node aborts at node.timeout ms', async () => {
  // Use seconds=0.3 (not larger) — delay's setTimeout is not cancellable
  // from the wrapper, so it would keep the event loop alive after the
  // test if we used a multi-second value.
  const workflow = {
    id:    'wf_timeout',
    entry: 't',
    nodes: [
      { id: 't', type: 'delay',
        config: { seconds: 0.3 }, timeout: 50, next: null },
    ],
  };
  const t0 = Date.now();
  const run = await wf.runWorkflow(workflow, newCtx());
  const elapsed = Date.now() - t0;
  assert.equal(run.ok, false);
  assert.match(String(run.error), /timeout/i);
  assert.ok(elapsed < 250, `did not abort within budget: ${elapsed}ms`);
});

// ──────────────────────────────────────────────────────────────
// Template variable resolution
// ──────────────────────────────────────────────────────────────

test('template vars resolve {{lastOutput}}, {{nodeId_output}}, {{ctx_var}}', async () => {
  // ctx vars are read from the workflow context. Initial context vars (e.g.
  // {{message}}, {{sender_jid}}, or any custom var supplied at trigger time)
  // are spread into ctx by runWorkflow and so are visible to template
  // resolution. `{{lastOutput}}` and `{{nodeId_output}}` are populated by the
  // engine after each step.
  const workflow = {
    id:    'wf_template_vars',
    entry: 'first',
    nodes: [
      { id: 'first', type: 'set', config: { key: 'unused', value: 'apple' },  next: 'mid' },
      { id: 'mid',   type: 'set', config: { key: 'unused', value: 'banana' }, next: 'log1' },
      { id: 'log1',  type: 'log',
        config: { text: 'last={{lastOutput}} first={{first_output}} ctx={{myvar}}' },
        next: null },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx({ myvar: 'cherry' }));
  assert.equal(run.ok, true);
  const logStep = run.steps.find(s => s.nodeId === 'log1');
  assert.equal(logStep.output, 'last=banana first=apple ctx=cherry');
});

// ──────────────────────────────────────────────────────────────
// Phase 5: loop / repeat / parallel
// ──────────────────────────────────────────────────────────────

test('loop iterates array and runs body chain per item', async () => {
  const workflow = {
    id:    'wf_loop',
    entry: 'lp',
    nodes: [
      { id: 'lp',   type: 'loop',
        config: { items: '[1,2,3]', itemVar: 'it', body: 'body' }, next: null },
      { id: 'body', type: 'set',  config: { key: 'cur', value: 'v={{it}}' }, next: null },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx());
  assert.equal(run.ok, true);
  const lp = run.steps.find(s => s.nodeId === 'lp');
  const arr = JSON.parse(lp.output);
  assert.deepEqual(arr, ['v=1', 'v=2', 'v=3']);
});

test('repeat node runs body N times', async () => {
  const workflow = {
    id:    'wf_repeat',
    entry: 'r',
    nodes: [
      { id: 'r',    type: 'repeat',
        config: { times: 3, body: 'body' }, next: null },
      { id: 'body', type: 'set',  config: { key: 'k', value: 'i={{repeat_index}}' }, next: null },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx());
  assert.equal(run.ok, true);
  const rStep = run.steps.find(s => s.nodeId === 'r');
  // Last iteration index is 2 (0,1,2)
  assert.equal(rStep.output, 'i=2');
});

test('parallel runs branches concurrently, output is JSON map', async () => {
  const workflow = {
    id:    'wf_parallel',
    entry: 'par',
    nodes: [
      { id: 'par', type: 'parallel',
        config: { branches: ['b1', 'b2'] }, next: null },
      { id: 'b1',  type: 'set', config: { key: 'x', value: 'one' }, next: null },
      { id: 'b2',  type: 'set', config: { key: 'y', value: 'two' }, next: null },
    ],
  };
  const run = await wf.runWorkflow(workflow, newCtx());
  assert.equal(run.ok, true);
  const par = run.steps.find(s => s.nodeId === 'par');
  const map = JSON.parse(par.output);
  assert.deepEqual(map, { b1: 'one', b2: 'two' });
});

// ──────────────────────────────────────────────────────────────
// Run history persistence
// ──────────────────────────────────────────────────────────────

test('run history saved + retrievable via getRunHistory', async () => {
  const workflow = {
    id:    'wf_history_keep',
    entry: 'a',
    nodes: [
      { id: 'a', type: 'set', config: { key: 'x', value: '1' }, next: null },
    ],
  };
  // Ensure workflows dir exists so _saveRunHistory can write next to it.
  // (workflowDir resolution is internal; we only care that the run file shows up.)
  fs.mkdirSync(path.join(TMP_ROOT, 'tenants', TENANT_ID, 'workflows'), { recursive: true });

  await wf.runWorkflow(workflow, newCtx());
  await wf.runWorkflow(workflow, newCtx());
  await flush();

  const hist = wf.getRunHistory(TENANT_ID, 'wf_history_keep');
  assert.ok(Array.isArray(hist));
  assert.equal(hist.length, 2);
  assert.equal(hist[0].workflowId, 'wf_history_keep');
  assert.equal(hist[0].ok, true);
});

test('run history skips workflowId starting with "test_"', async () => {
  const workflow = {
    id:    'test_should_not_persist',
    entry: 'a',
    nodes: [
      { id: 'a', type: 'set', config: { key: 'x', value: '1' }, next: null },
    ],
  };
  await wf.runWorkflow(workflow, newCtx());
  await flush();
  const hist = wf.getRunHistory(TENANT_ID, 'test_should_not_persist');
  assert.deepEqual(hist, []);
});

// ──────────────────────────────────────────────────────────────
// validateWorkflow (from workflow_ai.js)
// ──────────────────────────────────────────────────────────────

test('validateWorkflow passes a valid workflow', () => {
  const v = {
    id: 'ok', name: 'OK', entry: 'a',
    nodes: [{ id: 'a', type: 'set', config: { key: 'x', value: '1' }, next: null }],
  };
  assert.doesNotThrow(() => wai.validateWorkflow(v));
});

test('validateWorkflow throws on missing entry', () => {
  const bad = {
    id: 'no_entry', name: 'X', entry: 'missing',
    nodes: [{ id: 'a', type: 'set', config: {}, next: null }],
  };
  assert.throws(() => wai.validateWorkflow(bad), /entry .* tidak ada/i);
});

test('validateWorkflow throws on invalid node type', () => {
  const bad = {
    id: 'bad_type', name: 'X', entry: 'a',
    nodes: [{ id: 'a', type: 'not.a.real.type', config: {}, next: null }],
  };
  assert.throws(() => wai.validateWorkflow(bad), /tidak dikenal/i);
});

test('validateWorkflow throws on dangling next reference', () => {
  const bad = {
    id: 'dangling', name: 'X', entry: 'a',
    nodes: [{ id: 'a', type: 'set', config: {}, next: 'ghost' }],
  };
  assert.throws(() => wai.validateWorkflow(bad), /tidak ditemukan/i);
});

test('validateWorkflow throws on invalid retry config', () => {
  const bad = {
    id: 'bad_retry', name: 'X', entry: 'a',
    nodes: [{ id: 'a', type: 'set', config: {}, next: null,
              retry: { times: 99 } }],
  };
  assert.throws(() => wai.validateWorkflow(bad), /retry\.times harus 0/);

  const bad2 = {
    id: 'bad_retry2', name: 'X', entry: 'a',
    nodes: [{ id: 'a', type: 'set', config: {}, next: null,
              retry: { backoff: 'jitter' } }],
  };
  assert.throws(() => wai.validateWorkflow(bad2), /retry\.backoff/);
});
