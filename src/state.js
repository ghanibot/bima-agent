'use strict';

// ── Active runs state helpers ─────────────────────────────────
// Tracks workflow runs in-flight so we can detect crashes on next boot.
// File: ~/.bima/tenants/{tid}/workflows/_active_runs.json
// Shape: array of { runId, workflowId, startedAt, trigger, pid }

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR = process.env.BIMA_DATA || path.join(os.homedir(), '.bima');

function _workflowDir(tenantId) {
  return path.join(DATA_DIR, 'tenants', tenantId, 'workflows');
}

function activeRunsPath(tenantId) {
  return path.join(_workflowDir(tenantId), '_active_runs.json');
}

function readActiveRuns(tenantId) {
  try {
    const p = activeRunsPath(tenantId);
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeActiveRuns(tenantId, arr) {
  try {
    const p   = activeRunsPath(tenantId);
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr || []));
    fs.renameSync(tmp, p);
  } catch {}
}

function addActiveRun(tenantId, entry) {
  const arr = readActiveRuns(tenantId);
  arr.push(entry);
  writeActiveRuns(tenantId, arr);
}

function removeActiveRun(tenantId, runId) {
  const arr = readActiveRuns(tenantId).filter(e => e.runId !== runId);
  writeActiveRuns(tenantId, arr);
}

// List tenant directories that have a workflows dir
function listTenantDirs() {
  try {
    const base = path.join(DATA_DIR, 'tenants');
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}

// True if pid is alive on current host.
function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process. EPERM = exists but we can't signal it (still alive).
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

module.exports = {
  activeRunsPath,
  readActiveRuns,
  writeActiveRuns,
  addActiveRun,
  removeActiveRun,
  listTenantDirs,
  pidAlive,
};
