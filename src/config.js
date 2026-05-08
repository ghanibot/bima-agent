'use strict';

const fs   = require('fs');
const path = require('path');

// Tenant-aware config. tenantId defaults to 'default'.
function configPath(tenantId) {
  const { tenantPaths } = require('./tenant');
  return tenantPaths(tenantId || 'default').config;
}

function getConfig(tenantId) {
  try {
    const p = configPath(tenantId);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
}

function saveConfig(patch, tenantId) {
  const p   = configPath(tenantId);
  const cur = getConfig(tenantId);
  const next = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2));
}

function maskKey(key) {
  if (!key || key.length < 8) return '****';
  return key.slice(0, 3) + '••••' + key.slice(-4);
}

module.exports = { getConfig, saveConfig, maskKey };
