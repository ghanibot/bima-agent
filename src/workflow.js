'use strict';

const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { execFile, spawn } = require('child_process');

const DATA_DIR = process.env.BIMA_DATA || path.join(os.homedir(), '.bima');

// ── Storage ───────────────────────────────────────────────────
function workflowDir(tenantId) {
  return path.join(DATA_DIR, 'tenants', tenantId, 'workflows');
}

function workflowPath(tenantId, wfId) {
  return path.join(workflowDir(tenantId), `${wfId}.json`);
}

function listWorkflows(tenantId) {
  const dir = workflowDir(tenantId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

function getWorkflow(tenantId, wfId) {
  const p = workflowPath(tenantId, wfId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function saveWorkflow(tenantId, wf) {
  const dir = workflowDir(tenantId);
  fs.mkdirSync(dir, { recursive: true });
  wf.updatedAt = Date.now();
  fs.writeFileSync(workflowPath(tenantId, wf.id), JSON.stringify(wf, null, 2));
}

function deleteWorkflow(tenantId, wfId) {
  const p = workflowPath(tenantId, wfId);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// ── Template variable resolution ──────────────────────────────
function resolveVars(text, ctx) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = ctx[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

// ── Retry + timeout wrapper ───────────────────────────────────
// Per-node config:
//   node.timeout  — milliseconds (top-level). Falls back to type default.
//   node.retry    — { times: 0..9, backoff: 'fixed'|'exponential', delayMs: 1000 }
const _DEFAULT_TIMEOUT_MS = {
  'http.request':  30000,
  'ai.call':       90000,
  'shell':         60000,
  'wa.read_group': 10000,
  'wa.send':       15000,
  'wa.send_to':    15000,
  'wa.send_media': 60000,  // media upload can be slow
  'wa.transcribe': 120000, // STT can be slow on long audio
  'wa.vision':     90000,  // vision AI
  'loop':          300000,
  'repeat':        300000,
  'parallel':      180000,
  'workflow.run':  180000,
  'delay':         35000, // delay caps at 30s internally
};

function _resolveTimeoutMs(node) {
  if (typeof node.timeout === 'number' && node.timeout > 0) return node.timeout;
  return _DEFAULT_TIMEOUT_MS[node.type] || 60000;
}

function _resolveRetry(node) {
  const r = node.retry || {};
  return {
    times:   Math.max(0, Math.min(parseInt(r.times) || 0, 9)),
    delayMs: Math.max(100, parseInt(r.delayMs) || 1000),
    backoff: r.backoff === 'exponential' ? 'exponential' : 'fixed',
  };
}

// ── Media buffer resolution (for wa.transcribe / wa.vision / wa.send_media) ──
// Fetches a media buffer from URL, file path, or the trigger message itself.
async function _fetchMediaSource(source) {
  if (!source || typeof source !== 'string') return null;

  // URL
  if (/^https?:\/\//i.test(source)) {
    try {
      const res = await fetch(source, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch { return null; }
  }

  // File path (~ expand)
  const abs = source.replace(/^~/, os.homedir());
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return fs.readFileSync(abs);
    }
  } catch {}
  return null;
}

// Resolves media buffer from node.config.source. Falls back to trigger msg media.
// expectedType: 'audio' | 'image' | 'video' | 'document' (for trigger fallback)
async function _resolveMediaBuffer(source, ctx, expectedType) {
  if (source && source !== 'trigger') {
    return _fetchMediaSource(source);
  }
  // Trigger fallback: use _downloadMedia from ctx (set by whatsapp.js)
  if (typeof ctx._downloadMedia === 'function') {
    try { return await ctx._downloadMedia(expectedType); }
    catch { return null; }
  }
  return null;
}

async function _runWithRetryTimeout(executor, node, ctx) {
  const timeoutMs = _resolveTimeoutMs(node);
  const retry     = _resolveRetry(node);
  const maxAttempts = retry.times + 1;

  let lastResult = { ok: false, error: 'no attempt made' };
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;

    // Expose timeoutMs to executors that need internal abort (http, shell)
    const execCtx = { ...ctx, _nodeTimeoutMs: timeoutMs };

    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`node timeout setelah ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    try {
      const result = await Promise.race([executor(node, execCtx), timeoutPromise]);
      clearTimeout(timeoutHandle);
      lastResult = result;
      if (result && result.ok) {
        return { ...result, _attempts: attempt, _timeoutMs: timeoutMs };
      }
    } catch (e) {
      clearTimeout(timeoutHandle);
      lastResult = { ok: false, error: e.message };
    }

    if (attempt < maxAttempts) {
      const delay = retry.backoff === 'exponential'
        ? retry.delayMs * Math.pow(2, attempt - 1)
        : retry.delayMs;
      await new Promise(r => setTimeout(r, Math.min(delay, 30000)));
    }
  }

  return { ...lastResult, _attempts: attempts, _timeoutMs: timeoutMs };
}

// ── Node executors ────────────────────────────────────────────
const NODE_EXECUTORS = {

  // wa.send — send text to the triggering JID
  'wa.send': async (node, ctx) => {
    const text = resolveVars(node.config?.text || '', ctx);
    if (!text) return { ok: false, error: 'text kosong' };
    if (!ctx._sendFn) return { ok: false, error: 'no _sendFn in context' };
    await ctx._sendFn(ctx._jid, text);
    return { ok: true, output: text };
  },

  // wa.send_to — send text to specific JID
  'wa.send_to': async (node, ctx) => {
    const jid  = resolveVars(node.config?.jid || '', ctx);
    const text = resolveVars(node.config?.text || '', ctx);
    if (!jid || !text) return { ok: false, error: 'jid/text kosong' };
    if (!ctx._sendFn) return { ok: false, error: 'no _sendFn in context' };
    await ctx._sendFn(jid, text);
    return { ok: true, output: text };
  },

  // ai.call — call AI with a prompt
  'ai.call': async (node, ctx) => {
    const { callAI } = require('./ai');
    const { getConfig } = require('./config');
    const prompt = resolveVars(node.config?.prompt || '', ctx);
    if (!prompt) return { ok: false, error: 'prompt kosong' };
    const cfg = getConfig(ctx._tenantId);
    const reply = await callAI(
      [{ role: 'user', content: prompt }],
      node.config?.system || 'Kamu Bima, asisten AI WhatsApp Indonesia.',
      cfg
    );
    return { ok: true, output: reply };
  },

  // memory.read — read last N turns from conversation history
  'memory.read': async (node, ctx) => {
    const { getHistory } = require('./memory');
    const n       = node.config?.turns || 5;
    const history = getHistory(ctx._jid || '', ctx._sender || '', ctx._tenantId);
    const slice   = history.slice(-n);
    const text    = slice.map(t => `${t.role}: ${t.content}`).join('\n');
    return { ok: true, output: text || '(tidak ada riwayat)' };
  },

  // memory.write — write a fact to LTM
  'memory.write': async (node, ctx) => {
    const { remember } = require('./ltm');
    const content = resolveVars(node.config?.content || '', ctx);
    if (!content) return { ok: false, error: 'content kosong' };
    remember(content, 'workflow', ctx._tenantId);
    return { ok: true, output: content };
  },

  // condition — branch on expression evaluation
  'condition': async (node, ctx) => {
    const expr = resolveVars(node.config?.expr || 'false', ctx);
    let result;
    try {
      // Safe eval: only allow simple comparisons, no function calls
      const safe = expr
        .replace(/[^a-zA-Z0-9_.'"()\s=!<>&|]+/g, '')
        .slice(0, 200);
      // eslint-disable-next-line no-new-func
      result = Boolean(new Function('ctx', `with(ctx){return !!(${safe})}`)(ctx));
    } catch {
      result = false;
    }
    return { ok: true, output: result, branch: result ? 'true' : 'false' };
  },

  // delay — wait N seconds
  'delay': async (node, ctx) => {
    const ms = (node.config?.seconds || 1) * 1000;
    await new Promise(r => setTimeout(r, Math.min(ms, 30000)));
    return { ok: true, output: null };
  },

  // log — emit to CLI log, useful for debugging
  'log': async (node, ctx) => {
    const text = resolveVars(node.config?.text || '', ctx);
    if (ctx._logFn) ctx._logFn('WF', text);
    else console.log('[WF]', text);
    return { ok: true, output: text };
  },

  // set — set a context variable
  'set': async (node, ctx) => {
    const key = node.config?.key;
    const val = resolveVars(String(node.config?.value ?? ''), ctx);
    if (key) ctx[key] = val;
    return { ok: true, output: val };
  },

  // ── Phase 2 nodes ─────────────────────────────────────────

  // shell — execute OS command, capture stdout
  // Requires sandbox.enabled = true in tenant config (safety opt-in)
  'shell': async (node, ctx) => {
    const { getConfig } = require('./config');
    const cfg = getConfig(ctx._tenantId);
    if (!cfg.sandboxEnabled) {
      return { ok: false, error: 'Sandbox nonaktif. Aktifkan dulu: /workflow sandbox on' };
    }

    const cmd = resolveVars(node.config?.cmd || '', ctx);
    // Prefer outer timeout (via ctx._nodeTimeoutMs); fall back to legacy config.timeout
    const timeout = ctx._nodeTimeoutMs
      || Math.min((node.config?.timeout || 10) * 1000, 60000);
    if (!cmd) return { ok: false, error: 'cmd kosong' };

    // Choose shell based on platform
    const isWin  = os.platform() === 'win32';
    const shell  = isWin ? 'cmd.exe' : '/bin/sh';
    const args   = isWin ? ['/c', cmd] : ['-c', cmd];

    const stdout = await new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      const child = spawn(shell, args, {
        timeout,
        env:   { ...process.env },
        stdio: 'pipe',
      });
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.on('close', code => {
        if (code !== 0) reject(new Error(`exit ${code}: ${err.slice(0, 200)}`));
        else resolve(out.trim());
      });
      child.on('error', reject);
    });

    return { ok: true, output: stdout.slice(0, 2000) };
  },

  // http.request — GET or POST with optional JSON body
  'http.request': async (node, ctx) => {
    const url    = resolveVars(node.config?.url || '', ctx);
    const method = (node.config?.method || 'GET').toUpperCase();
    if (!url) return { ok: false, error: 'url kosong' };

    // Build headers
    const headers = { 'Content-Type': 'application/json', ...(node.config?.headers || {}) };
    // Resolve header values
    for (const k of Object.keys(headers)) headers[k] = resolveVars(headers[k], ctx);

    // Build body
    let body;
    if (method !== 'GET' && node.config?.body) {
      const rawBody = typeof node.config.body === 'string'
        ? resolveVars(node.config.body, ctx)
        : JSON.stringify(node.config.body);
      body = rawBody;
    }

    // Use outer-resolved timeout so fetch actually aborts when wrapper times out
    const fetchTimeout = ctx._nodeTimeoutMs || 30000;
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(fetchTimeout),
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };

    // Try parse JSON, fallback to raw text
    let output;
    try { output = JSON.parse(text); }
    catch { output = text; }

    // If extract path specified (e.g. "data.items.0.name"), traverse result
    if (node.config?.extract && typeof output === 'object') {
      const keys = node.config.extract.split('.');
      let val = output;
      for (const k of keys) {
        val = val?.[k];
        if (val === undefined) break;
      }
      output = val !== undefined ? val : output;
    }

    const outputStr = typeof output === 'object' ? JSON.stringify(output) : String(output);
    return { ok: true, output: outputStr.slice(0, 4000), _raw: output };
  },

  // wa.read_group — read last N messages from a group as text
  'wa.read_group': async (node, ctx) => {
    const { getRecentMessages } = require('./grouplog');
    const jid   = resolveVars(node.config?.jid || ctx._jid || '', ctx);
    const limit = node.config?.limit || 10;
    if (!jid) return { ok: false, error: 'jid kosong' };

    const msgs = getRecentMessages(ctx._tenantId, jid, limit);
    if (!msgs || !msgs.length) return { ok: true, output: '(tidak ada pesan)' };

    const text = msgs.map(m => {
      const name = m.senderName || m.senderJid?.split('@')[0] || '?';
      return `[${name}]: ${m.text || '[media]'}`;
    }).join('\n');
    return { ok: true, output: text };
  },

  // transform — apply JS expression to lastOutput or named var
  // expr: JS expression, input available as `input` variable
  'transform': async (node, ctx) => {
    const expr = node.config?.expr;
    if (!expr) return { ok: false, error: 'expr kosong' };

    const inputVal = node.config?.inputVar
      ? ctx[node.config.inputVar]
      : ctx.lastOutput;

    let result;
    try {
      // Sandboxed: only access `input` and basic JSON operations
      // eslint-disable-next-line no-new-func
      result = new Function('input', 'JSON', `"use strict"; return (${expr});`)(
        inputVal, JSON
      );
    } catch (e) {
      return { ok: false, error: `transform eval: ${e.message}` };
    }

    const output = typeof result === 'object' ? JSON.stringify(result) : String(result ?? '');
    return { ok: true, output: output.slice(0, 4000) };
  },

  // ── WA media nodes ───────────────────────────────────────
  // wa.transcribe — voice note buffer → text (Whisper/HF STT)
  // source:
  //   'trigger' — use audio from message that triggered (default)
  //   <URL>     — fetch audio from URL
  //   <path>    — read from disk
  'wa.transcribe': async (node, ctx) => {
    const { transcribe } = require('./stt');
    const { getConfig }  = require('./config');
    const cfg = getConfig(ctx._tenantId);

    const buffer = await _resolveMediaBuffer(node.config?.source, ctx, 'audio');
    if (!buffer) return { ok: false, error: 'tidak ada audio (cek source/trigger)' };

    const text = await transcribe(buffer, cfg);
    if (!text) return { ok: false, error: 'transkripsi kosong' };
    return { ok: true, output: text };
  },

  // wa.vision — image buffer + pertanyaan → jawaban AI
  // source: 'trigger' | URL | path
  'wa.vision': async (node, ctx) => {
    const { analyzeImage } = require('./ai');
    const { getConfig }    = require('./config');
    const cfg = getConfig(ctx._tenantId);

    const buffer = await _resolveMediaBuffer(node.config?.source, ctx, 'image');
    if (!buffer) return { ok: false, error: 'tidak ada gambar (cek source/trigger)' };

    const mime     = ctx._mediaMime || 'image/jpeg';
    const question = resolveVars(node.config?.question || 'Jelaskan isi gambar ini.', ctx);

    const answer = await analyzeImage(buffer, mime, question, cfg);
    return { ok: true, output: answer };
  },

  // wa.send_media — kirim gambar/audio/video/dokumen ke JID
  // config:
  //   jid?      — default ctx._jid
  //   type      — 'image'|'audio'|'video'|'document' (required)
  //   source    — URL atau path file (required)
  //   caption?  — caption / teks pendamping
  //   ptt?      — true = voice note (audio only)
  //   filename? — untuk document
  'wa.send_media': async (node, ctx) => {
    if (!ctx._sendMediaFn) return { ok: false, error: 'no _sendMediaFn in context (run from WA trigger only)' };

    const jid     = resolveVars(node.config?.jid || ctx._jid || '', ctx);
    const type    = (node.config?.type || '').toLowerCase();
    const source  = resolveVars(node.config?.source || '', ctx);
    const caption = node.config?.caption ? resolveVars(node.config.caption, ctx) : undefined;
    const ptt     = !!node.config?.ptt;
    const filename = node.config?.filename ? resolveVars(node.config.filename, ctx) : undefined;

    if (!jid)    return { ok: false, error: 'jid kosong' };
    if (!type)   return { ok: false, error: 'type wajib (image/audio/video/document)' };
    if (!['image','audio','video','document'].includes(type)) {
      return { ok: false, error: `type "${type}" tidak valid` };
    }
    if (!source) return { ok: false, error: 'source kosong (URL atau path)' };

    const buffer = await _fetchMediaSource(source);
    if (!buffer) return { ok: false, error: `gagal ambil media dari "${source}"` };

    const mediaObj = { [type]: buffer };
    if (caption && (type === 'image' || type === 'video' || type === 'document')) mediaObj.caption = caption;
    if (type === 'audio') {
      mediaObj.mimetype = 'audio/ogg; codecs=opus';
      if (ptt) mediaObj.ptt = true;
    }
    if (type === 'document') {
      mediaObj.fileName = filename || 'file';
      mediaObj.mimetype = node.config?.mimetype || 'application/octet-stream';
    }

    await ctx._sendMediaFn(jid, mediaObj);
    return { ok: true, output: `${type} terkirim ke ${jid.split('@')[0]}` };
  },

  // json.extract — extract field from JSON string in lastOutput
  'json.extract': async (node, ctx) => {
    const keyPath = node.config?.path;
    if (!keyPath) return { ok: false, error: 'path kosong' };

    let obj = ctx.lastOutput;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch { return { ok: false, error: 'lastOutput bukan JSON valid' }; }
    }

    const keys = keyPath.split('.');
    let val = obj;
    for (const k of keys) {
      val = val?.[k];
      if (val === undefined) break;
    }

    const output = val !== undefined
      ? (typeof val === 'object' ? JSON.stringify(val) : String(val))
      : '';
    return { ok: true, output };
  },
};

// ── Phase 5 nodes ─────────────────────────────────────────────
// Defined here (not inside NODE_EXECUTORS object literal) because
// they need forward-reference to runChain / runWorkflow.

// Injected into NODE_EXECUTORS after runChain is defined (below).
const _phase5Executors = {};

// ── runChain: run a sub-chain within same workflow ────────────
// Used by loop, repeat, parallel nodes.
async function runChain(wf, entryNodeId, ctx, maxSteps = 100) {
  let nodeId = entryNodeId;
  const steps = [];
  const visited = new Set();

  while (nodeId && steps.length < maxSteps) {
    if (visited.has(nodeId)) break; // cycle guard
    visited.add(nodeId);

    const node = (wf.nodes || []).find(n => n.id === nodeId);
    if (!node) break;

    const executor = NODE_EXECUTORS[node.type] || _phase5Executors[node.type];
    if (!executor) { steps.push({ nodeId, ok: false, error: `unknown type "${node.type}"` }); break; }

    let result;
    try { result = await _runWithRetryTimeout(executor, node, ctx); }
    catch (e) { result = { ok: false, error: e.message }; }

    steps.push({
      nodeId,
      type:     node.type,
      ok:       result.ok,
      error:    result.error || null,
      output:   result.output,
      attempts: result._attempts || 1,
    });

    if (!result.ok && node.onError !== 'continue') break;

    if (result.output !== undefined && result.output !== null) {
      ctx[`${nodeId}_output`] = result.output;
      ctx.lastOutput = result.output;
    }

    if (node.type === 'condition' && node.branches) {
      nodeId = node.branches[result.branch] || null;
    } else {
      nodeId = node.next || null;
    }
  }

  return { lastOutput: ctx.lastOutput, steps };
}

// Populate phase5 executors (uses runChain + getWorkflow + runWorkflow via closure)
Object.assign(_phase5Executors, {

  // loop — iterate over JSON array, run body chain per item
  'loop': async (node, ctx) => {
    const itemsRaw  = resolveVars(node.config?.items || '[]', ctx);
    const itemVar   = node.config?.itemVar   || 'item';
    const bodyEntry = node.config?.body;
    const maxIter   = Math.min(node.config?.maxIterations || 20, 100);
    const wf        = ctx._wf;

    if (!bodyEntry) return { ok: false, error: 'config.body kosong' };
    if (!wf)        return { ok: false, error: 'ctx._wf tidak tersedia' };

    let items;
    try { items = typeof itemsRaw === 'string' ? JSON.parse(itemsRaw) : itemsRaw; }
    catch { return { ok: false, error: `items bukan JSON: ${itemsRaw?.slice?.(0,60)}` }; }
    if (!Array.isArray(items)) return { ok: false, error: 'items harus array' };

    const outputs  = [];
    const limit    = Math.min(items.length, maxIter);

    for (let i = 0; i < limit; i++) {
      const loopCtx = {
        ...ctx,
        [itemVar]:   typeof items[i] === 'object' ? JSON.stringify(items[i]) : String(items[i]),
        loop_index:  i,
        loop_total:  items.length,
        lastOutput:  ctx.lastOutput,
      };
      const { lastOutput } = await runChain(wf, bodyEntry, loopCtx, 50);
      if (lastOutput !== undefined) outputs.push(lastOutput);
    }

    return { ok: true, output: JSON.stringify(outputs) };
  },

  // repeat — run body chain N times (no item variable)
  'repeat': async (node, ctx) => {
    const times     = Math.min(node.config?.times || 1, 100);
    const bodyEntry = node.config?.body;
    const wf        = ctx._wf;

    if (!bodyEntry) return { ok: false, error: 'config.body kosong' };
    if (!wf)        return { ok: false, error: 'ctx._wf tidak tersedia' };

    let lastOutput = ctx.lastOutput;
    for (let i = 0; i < times; i++) {
      const repCtx = { ...ctx, repeat_index: i, repeat_total: times, lastOutput };
      const result = await runChain(wf, bodyEntry, repCtx, 50);
      lastOutput = result.lastOutput;
    }

    return { ok: true, output: lastOutput };
  },

  // parallel — run multiple branch chains concurrently, collect outputs
  'parallel': async (node, ctx) => {
    const branches = node.config?.branches;
    const wf       = ctx._wf;

    if (!Array.isArray(branches) || !branches.length) return { ok: false, error: 'config.branches kosong (array nodeId)' };
    if (!wf) return { ok: false, error: 'ctx._wf tidak tersedia' };

    const results = await Promise.all(
      branches.map(async (branchId) => {
        const branchCtx = { ...ctx };
        const { lastOutput, steps } = await runChain(wf, branchId, branchCtx, 50);
        return { branchId, output: lastOutput, steps };
      })
    );

    const outputMap = {};
    results.forEach(r => { outputMap[r.branchId] = r.output; });

    return { ok: true, output: JSON.stringify(outputMap), _branches: results };
  },

  // workflow.run — call another workflow by ID, get its output
  'workflow.run': async (node, ctx) => {
    const wfId  = resolveVars(node.config?.workflowId || '', ctx);
    const input = resolveVars(String(node.config?.input ?? ctx.lastOutput ?? ''), ctx);
    if (!wfId) return { ok: false, error: 'config.workflowId kosong' };

    const subWf = getWorkflow(ctx._tenantId, wfId);
    if (!subWf) return { ok: false, error: `Workflow "${wfId}" tidak ditemukan` };

    const subCtx = {
      _tenantId:  ctx._tenantId,
      _jid:       ctx._jid,
      _sender:    ctx._sender,
      _sendFn:    ctx._sendFn,
      _trigger:   'sub-workflow',
      lastOutput: input,
      input,
      message:    input,
    };

    const run = await runWorkflow(subWf, subCtx, ctx._logFn);
    if (!run.ok) return { ok: false, error: `Sub-workflow "${wfId}" gagal: ${run.error}` };

    const lastStep = run.steps.filter(s => s.ok).at(-1);
    return { ok: true, output: lastStep?.output ?? input };
  },
});

// ── System-wide senders (set by whatsapp.js on connect) ─────
// Scheduled/file/webhook workflows inherit these so they can call wa.send / wa.send_media
let _systemSendFn      = null;
let _systemSendMediaFn = null;

function setSystemSenders({ sendFn, sendMediaFn } = {}) {
  if (sendFn      !== undefined) _systemSendFn      = sendFn;
  if (sendMediaFn !== undefined) _systemSendMediaFn = sendMediaFn;
}

// ── DAG runner ────────────────────────────────────────────────
async function runWorkflow(wf, context, logFn) {
  const ctx = { ...context, _logFn: logFn, _wf: wf }; // _wf for loop/parallel/sub-workflow

  // Inject system-wide senders if not already provided by caller
  if (!ctx._sendFn      && _systemSendFn)      ctx._sendFn      = _systemSendFn;
  if (!ctx._sendMediaFn && _systemSendMediaFn) ctx._sendMediaFn = _systemSendMediaFn;
  const run = {
    workflowId: wf.id,
    startedAt:  Date.now(),
    steps:      [],
    ok:         true,
    error:      null,
  };

  let nodeId = wf.entry;
  const visited = new Set();

  while (nodeId) {
    if (visited.has(nodeId)) {
      run.ok    = false;
      run.error = `Cycle detected at node "${nodeId}"`;
      break;
    }
    visited.add(nodeId);

    const node = (wf.nodes || []).find(n => n.id === nodeId);
    if (!node) {
      run.ok    = false;
      run.error = `Node "${nodeId}" not found`;
      break;
    }

    const executor = NODE_EXECUTORS[node.type] || _phase5Executors[node.type];
    if (!executor) {
      run.ok    = false;
      run.error = `Unknown node type "${node.type}"`;
      break;
    }

    const t0 = Date.now();
    let result;
    try {
      result = await _runWithRetryTimeout(executor, node, ctx);
    } catch (e) {
      result = { ok: false, error: e.message };
    }

    const step = {
      nodeId,
      type:     node.type,
      ok:       result.ok,
      ms:       Date.now() - t0,
      output:   result.output,
      error:    result.error || null,
      attempts: result._attempts || 1,
    };
    run.steps.push(step);

    const retryTag = step.attempts > 1 ? ` (×${step.attempts})` : '';
    if (logFn) logFn('WF', `[${wf.id}] ${nodeId}(${node.type})${retryTag} → ${result.ok ? 'ok' : 'ERR: ' + result.error}`);

    if (!result.ok) {
      if (node.onError === 'continue') {
        nodeId = node.next || null;
        continue;
      }
      run.ok    = false;
      run.error = `Node "${nodeId}" failed: ${result.error}`;
      break;
    }

    // Store node output in context for downstream template vars
    if (result.output !== undefined && result.output !== null) {
      ctx[`${nodeId}_output`] = result.output;
      ctx.lastOutput = result.output;
    }

    // Condition branches
    if (node.type === 'condition' && node.branches) {
      nodeId = node.branches[result.branch] || null;
    } else {
      nodeId = node.next || null;
    }
  }

  run.durationMs = Date.now() - run.startedAt;
  run.trigger    = context._trigger || 'unknown';

  // Persist run history (async, non-blocking)
  _saveRunHistory(context._tenantId || 'default', run).catch(() => {});

  return run;
}

// ── Run history ───────────────────────────────────────────────
const MAX_RUNS = 100;

function _runsPath(tenantId, wfId) {
  return path.join(workflowDir(tenantId), `${wfId}.runs.json`);
}

async function _saveRunHistory(tenantId, run) {
  if (!run.workflowId || run.workflowId.startsWith('test_')) return; // skip test runs
  try {
    const p    = _runsPath(tenantId, run.workflowId);
    const dir  = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });

    let runs = [];
    try { runs = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}

    // Compact steps: keep only nodeId, type, ok, ms, error (drop large output)
    const compact = {
      runId:      run.runId || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      workflowId: run.workflowId,
      startedAt:  run.startedAt,
      durationMs: run.durationMs,
      ok:         run.ok,
      error:      run.error || null,
      trigger:    run.trigger || 'unknown',
      stepCount:  run.steps.length,
      failedNode: run.steps.find(s => !s.ok)?.nodeId || null,
    };

    runs.push(compact);
    if (runs.length > MAX_RUNS) runs = runs.slice(-MAX_RUNS);
    fs.writeFileSync(p, JSON.stringify(runs));
  } catch {}
}

function getRunHistory(tenantId, wfId, limit = 20) {
  try {
    const p = _runsPath(tenantId, wfId);
    if (!fs.existsSync(p)) return [];
    const runs = JSON.parse(fs.readFileSync(p, 'utf8'));
    return runs.slice(-limit).reverse(); // newest first
  } catch { return []; }
}

function getRunStats(tenantId, wfId) {
  const runs = getRunHistory(tenantId, wfId, MAX_RUNS);
  if (!runs.length) return null;

  const total   = runs.length;
  const success = runs.filter(r => r.ok).length;
  const avgMs   = Math.round(runs.reduce((s, r) => s + (r.durationMs || 0), 0) / total);
  const lastRun = runs[0]; // newest first

  return {
    total,
    success,
    failed:      total - success,
    successRate: Math.round((success / total) * 100),
    avgMs,
    lastRun:     lastRun.startedAt,
    lastOk:      lastRun.ok,
  };
}

// ── Schedule registry (in-memory cron-like) ──────────────────
const _scheduleTimers = new Map(); // key: `${tenantId}::${wfId}`

function _parseIntervalMs(schedule) {
  if (!schedule) return null;
  const m = String(schedule).match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1]);
  const u = m[2];
  return n * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[u];
}

function scheduleWorkflow(tenantId, wf, context, logFn) {
  const key = `${tenantId}::${wf.id}`;
  unscheduleWorkflow(tenantId, wf.id);

  const ms = _parseIntervalMs(wf.trigger?.interval);
  if (!ms) return false;

  const timer = setInterval(async () => {
    const fresh = getWorkflow(tenantId, wf.id);
    if (!fresh || !fresh.enabled) { unscheduleWorkflow(tenantId, wf.id); return; }
    try {
      await runWorkflow(fresh, { ...context, _trigger: 'schedule' }, logFn);
    } catch (e) {
      if (logFn) logFn('WF', `Schedule error [${wf.id}]: ${e.message}`);
    }
  }, ms);

  _scheduleTimers.set(key, timer);
  return true;
}

function unscheduleWorkflow(tenantId, wfId) {
  const key = `${tenantId}::${wfId}`;
  const t = _scheduleTimers.get(key);
  if (t) { clearInterval(t); _scheduleTimers.delete(key); }
}

// Auto-start all enabled auto-trigger workflows for a tenant (schedule + file + webhook)
function startScheduledWorkflows(tenantId, context, logFn) {
  const workflows = listWorkflows(tenantId);
  let count = 0;
  for (const wf of workflows) {
    const type = wf.trigger?.type;
    if (wf.enabled && (type === 'schedule' || type === 'file' || type === 'webhook')) {
      if (activateTriggers(tenantId, wf, context, logFn)) count++;
    }
  }
  return count;
}

// ── WA message trigger — called from whatsapp.js ─────────────
// Returns true if a workflow handled the message (caller should skip normal AI)
// extras (optional): { msg, downloadMedia, sendMediaFn, mediaType, mediaMime }
async function handleWATrigger(tenantId, jid, sender, text, sendFn, logFn, extras = {}) {
  const workflows = listWorkflows(tenantId);
  let handled = false;

  for (const wf of workflows) {
    if (!wf.enabled) continue;
    if (wf.trigger?.type !== 'wa.message') continue;

    const match     = wf.trigger.match;
    const mediaOnly = wf.trigger.mediaOnly === true;
    const triggerOnMedia = wf.trigger.onMedia; // 'audio' | 'image' | 'any' | undefined

    // Skip non-media messages if workflow is media-only
    if (mediaOnly && !extras.mediaType) continue;

    // If workflow specifies onMedia filter, require matching media type
    if (triggerOnMedia && triggerOnMedia !== 'any' && extras.mediaType !== triggerOnMedia) continue;

    let triggered = false;
    if (mediaOnly && extras.mediaType) {
      triggered = true;
    } else if (!match) {
      triggered = !!text;
    } else if (match.startsWith('/') && match.endsWith('/')) {
      try { triggered = new RegExp(match.slice(1, -1), 'i').test(text); } catch {}
    } else {
      triggered = text.toLowerCase().includes(match.toLowerCase());
    }

    if (!triggered) continue;

    // Don't block — run async
    const ctx = {
      _tenantId: tenantId,
      _jid:      jid,
      _sender:   sender,
      _text:     text,
      _sendFn:   sendFn,
      _sendMediaFn:   extras.sendMediaFn   || null,
      _downloadMedia: extras.downloadMedia || null,
      _mediaType:     extras.mediaType     || null,
      _mediaMime:     extras.mediaMime     || null,
      message:    text,
      sender_jid: sender,
      sender_name: sender.split('@')[0].split(':')[0],
      media_type: extras.mediaType || null,
    };

    runWorkflow(wf, ctx, logFn).catch(e => {
      if (logFn) logFn('WF', `WA trigger error [${wf.id}]: ${e.message}`);
    });

    if (wf.trigger?.exclusive) handled = true;
  }

  return handled;
}

// ── File watch triggers ───────────────────────────────────────
const _fileWatchers = new Map(); // key: `${tenantId}::${wfId}`

function startFileWatch(tenantId, wf, context, logFn) {
  const key  = `${tenantId}::${wf.id}`;
  stopFileWatch(tenantId, wf.id);

  const watchPath = wf.trigger?.path;
  if (!watchPath) return false;

  const absPath = watchPath.replace(/^~/, require('os').homedir());

  // Debounce: same file fires only once per 2s
  const _debounce = new Map();

  let watcher;
  try {
    watcher = fs.watch(absPath, { recursive: false }, (eventType, filename) => {
      if (!filename) return;
      const fileKey = `${eventType}::${filename}`;
      if (_debounce.has(fileKey)) return;
      _debounce.set(fileKey, true);
      setTimeout(() => _debounce.delete(fileKey), 2000);

      const events = wf.trigger?.events || ['created', 'modified'];
      const mappedEvent = eventType === 'rename' ? 'created' : 'modified';
      if (!events.includes(mappedEvent) && !events.includes('all')) return;

      const fullPath = path.join(absPath, filename);
      let content = '';
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          content = fs.readFileSync(fullPath, 'utf8').slice(0, 4000);
        }
      } catch {}

      const fresh = getWorkflow(tenantId, wf.id);
      if (!fresh || !fresh.enabled) { stopFileWatch(tenantId, wf.id); return; }

      const ctx = {
        ...context,
        _trigger:    'file',
        _tenantId:   tenantId,
        file_path:   fullPath,
        file_name:   filename,
        file_event:  mappedEvent,
        file_content: content,
        lastOutput:  content,
      };

      runWorkflow(fresh, ctx, logFn).catch(e => {
        if (logFn) logFn('WF', `File trigger error [${wf.id}]: ${e.message}`);
      });
    });
  } catch (e) {
    if (logFn) logFn('WF', `Cannot watch "${absPath}": ${e.message}`);
    return false;
  }

  _fileWatchers.set(key, watcher);
  return true;
}

function stopFileWatch(tenantId, wfId) {
  const key = `${tenantId}::${wfId}`;
  const w = _fileWatchers.get(key);
  if (w) { try { w.close(); } catch {} _fileWatchers.delete(key); }
}

// ── WA group-event trigger — called from whatsapp.js ─────────
// action: 'add' | 'remove' | 'promote' | 'demote'
async function handleGroupEvent(tenantId, jid, participants, action, sendFn, logFn) {
  const workflows = listWorkflows(tenantId);

  for (const wf of workflows) {
    if (!wf.enabled) continue;
    if (wf.trigger?.type !== 'wa.group_event') continue;

    const watchActions = wf.trigger?.actions || ['add', 'remove'];
    if (!watchActions.includes(action) && !watchActions.includes('all')) continue;

    // Filter by group JID if specified
    if (wf.trigger?.jid && wf.trigger.jid !== jid) continue;

    for (const participant of participants) {
      const ctx = {
        _trigger:      'group_event',
        _tenantId:     tenantId,
        _jid:          jid,
        _sendFn:       sendFn,
        group_jid:     jid,
        participant:   participant,
        participant_name: participant.split('@')[0].split(':')[0],
        action,
        message:       `${participant.split('@')[0]} ${action === 'add' ? 'bergabung' : 'keluar'}`,
      };

      runWorkflow(wf, ctx, logFn).catch(e => {
        if (logFn) logFn('WF', `Group event error [${wf.id}]: ${e.message}`);
      });
    }
  }
}

// ── Webhook trigger registry ──────────────────────────────────
// webhookId → { tenantId, wfId, secret? }
const _webhookRegistry = new Map();

function registerWebhook(tenantId, wf) {
  const webhookId = wf.trigger?.webhookId || wf.id;
  _webhookRegistry.set(webhookId, { tenantId, wfId: wf.id, secret: wf.trigger?.secret });
  return webhookId;
}

function unregisterWebhook(tenantId, wfId) {
  for (const [id, entry] of _webhookRegistry.entries()) {
    if (entry.tenantId === tenantId && entry.wfId === wfId) {
      _webhookRegistry.delete(id); return;
    }
  }
}

// Called by api.js when POST /webhook/:webhookId arrives
async function handleWebhookTrigger(webhookId, body, headers, sendFn, logFn) {
  const entry = _webhookRegistry.get(webhookId);
  if (!entry) return { ok: false, status: 404, error: 'Webhook tidak terdaftar' };

  // Validate secret if configured
  if (entry.secret) {
    const provided = headers['x-webhook-secret'] || headers['authorization']?.replace(/^Bearer\s+/, '');
    if (provided !== entry.secret) return { ok: false, status: 401, error: 'Secret salah' };
  }

  const wf = getWorkflow(entry.tenantId, entry.wfId);
  if (!wf || !wf.enabled) return { ok: false, status: 503, error: 'Workflow tidak aktif' };

  const bodyStr = typeof body === 'object' ? JSON.stringify(body) : String(body || '');
  const ctx = {
    _trigger:   'webhook',
    _tenantId:  entry.tenantId,
    _sendFn:    sendFn,
    webhook_id: webhookId,
    body:       bodyStr,
    lastOutput: bodyStr,
    ...(typeof body === 'object' ? body : {}),
  };

  // Run async — respond immediately
  runWorkflow(wf, ctx, logFn).catch(e => {
    if (logFn) logFn('WF', `Webhook error [${wf.id}]: ${e.message}`);
  });

  return { ok: true, status: 200, message: `Workflow "${wf.id}" dipicu` };
}

// ── Unified trigger start/stop ─────────────────────────────────
function activateTriggers(tenantId, wf, context, logFn) {
  const type = wf.trigger?.type;
  if (type === 'schedule')   return scheduleWorkflow(tenantId, wf, context, logFn);
  if (type === 'file')       return startFileWatch(tenantId, wf, context, logFn);
  if (type === 'webhook')    { registerWebhook(tenantId, wf); return true; }
  return false; // manual / wa.message / wa.group_event don't need registration
}

function deactivateTriggers(tenantId, wfId) {
  unscheduleWorkflow(tenantId, wfId);
  stopFileWatch(tenantId, wfId);
  unregisterWebhook(tenantId, wfId);
}

// ── Workflow schema builder (for CLI create wizard) ───────────
function createWorkflow(tenantId, { id, name, description, trigger, nodes, entry }) {
  if (!id || !name) throw new Error('id dan name wajib diisi');
  if (getWorkflow(tenantId, id)) throw new Error(`Workflow "${id}" sudah ada`);

  const wf = {
    id,
    name,
    description: description || '',
    tenant:      tenantId,
    enabled:     false,
    trigger:     trigger || { type: 'manual' },
    nodes:       nodes   || [],
    entry:       entry   || (nodes?.[0]?.id) || null,
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
  };

  saveWorkflow(tenantId, wf);
  return wf;
}

module.exports = {
  listWorkflows,
  getWorkflow,
  saveWorkflow,
  deleteWorkflow,
  createWorkflow,
  runWorkflow,
  // history / monitoring
  getRunHistory,
  getRunStats,
  // schedule
  scheduleWorkflow,
  unscheduleWorkflow,
  startScheduledWorkflows,
  // triggers phase 4
  startFileWatch,
  stopFileWatch,
  handleGroupEvent,
  registerWebhook,
  unregisterWebhook,
  handleWebhookTrigger,
  activateTriggers,
  deactivateTriggers,
  // WA message
  handleWATrigger,
  setSystemSenders,
};
