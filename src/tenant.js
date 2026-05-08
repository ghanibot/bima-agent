'use strict';

const fs   = require('fs');
const path = require('path');

const os            = require('os');
const DATA_DIR      = process.env.BIMA_DATA || path.join(os.homedir(), '.bima');
const TENANTS_DIR   = path.join(DATA_DIR, 'tenants');
const REGISTRY_PATH = path.join(DATA_DIR, 'tenants.json');

// ── Registry: [{id, name, groupJids, ownerJid, active}] ──────
function loadRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return [];
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch { return []; }
}

function saveRegistry(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(list, null, 2));
}

// ── Paths for a tenant ────────────────────────────────────────
function tenantDir(tenantId) {
  return path.join(TENANTS_DIR, tenantId);
}

function tenantPaths(tenantId) {
  const dir = tenantDir(tenantId);
  return {
    dir,
    config:    path.join(dir, 'config.json'),
    db:        path.join(dir, 'db.json'),
    ltm:       path.join(dir, 'ltm.json'),
    reminders: path.join(dir, 'reminders.json'),
    files:     path.join(dir, 'files'),
  };
}

// ── Ensure tenant folder exists ───────────────────────────────
function initTenantDir(tenantId) {
  const p = tenantPaths(tenantId);
  fs.mkdirSync(p.dir,   { recursive: true });
  fs.mkdirSync(p.files, { recursive: true });
  return p;
}

// ── Resolve tenantId from a group JID or sender JID ───────────
// Returns 'default' if no match found
function resolveTenant(groupJid, senderJid) {
  const registry = loadRegistry();
  for (const t of registry) {
    if (!t.active) continue;
    if (t.groupJids && t.groupJids.includes(groupJid)) return t.id;
    if (t.ownerJid && senderJid && senderJid.startsWith(t.ownerJid)) return t.id;
  }
  return 'default';
}

// ── CRUD ──────────────────────────────────────────────────────
function getTenant(id) {
  return loadRegistry().find(t => t.id === id) || null;
}

function listTenants() {
  return loadRegistry();
}

function addTenant({ id, name, groupJids = [], ownerJid = '' }) {
  if (!id || !/^[\w-]+$/.test(id)) throw new Error('ID harus alfanumerik/dash');
  const registry = loadRegistry();
  if (registry.find(t => t.id === id)) throw new Error(`Tenant "${id}" sudah ada`);

  const tenant = { id, name: name || id, groupJids, ownerJid, active: true, createdAt: new Date().toISOString() };
  registry.push(tenant);
  saveRegistry(registry);
  initTenantDir(id);
  return tenant;
}

function updateTenant(id, patch) {
  const registry = loadRegistry();
  const idx = registry.findIndex(t => t.id === id);
  if (idx === -1) return false;
  registry[idx] = { ...registry[idx], ...patch };
  saveRegistry(registry);
  return true;
}

function deleteTenant(id) {
  if (id === 'default') throw new Error('Tenant default tidak bisa dihapus');
  const registry = loadRegistry();
  const idx = registry.findIndex(t => t.id === id);
  if (idx === -1) return false;
  registry.splice(idx, 1);
  saveRegistry(registry);
  return true;
}

// ── Migration: move legacy flat data → default tenant ─────────
function migrateDefault() {
  const registry = loadRegistry();
  if (registry.find(t => t.id === 'default')) return false; // already done

  const defaultPaths = tenantPaths('default');
  initTenantDir('default');

  // Move old flat files to default tenant folder
  const moves = [
    [path.join(DATA_DIR, 'config.json'),    defaultPaths.config],
    [path.join(DATA_DIR, 'db.json'),        defaultPaths.db],
    [path.join(DATA_DIR, 'ltm.json'),       defaultPaths.ltm],
    [path.join(DATA_DIR, 'reminders.json'), defaultPaths.reminders],
  ];

  for (const [src, dst] of moves) {
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }

  // Move old files/ directory contents
  const oldFiles = path.join(DATA_DIR, 'files');
  if (fs.existsSync(oldFiles)) {
    for (const f of fs.readdirSync(oldFiles)) {
      const src = path.join(oldFiles, f);
      const dst = path.join(defaultPaths.files, f);
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  }

  // Register default tenant
  registry.unshift({
    id: 'default',
    name: 'Default',
    groupJids: [],
    ownerJid: '',
    active: true,
    createdAt: new Date().toISOString(),
  });
  saveRegistry(registry);
  return true;
}

module.exports = {
  tenantPaths, initTenantDir, resolveTenant,
  getTenant, listTenants, addTenant, updateTenant, deleteTenant,
  migrateDefault,
};
