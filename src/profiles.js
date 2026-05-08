'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

function _profilePath(tenantId) {
  const base = process.env.BIMA_DATA || path.join(os.homedir(), '.bima');
  const dir  = path.join(base, 'tenants', tenantId || 'default');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'profiles.json');
}

function _load(tenantId) {
  try {
    const p = _profilePath(tenantId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
}

function _save(tenantId, data) {
  try { fs.writeFileSync(_profilePath(tenantId), JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// Get or create profile for a member
function getProfile(tenantId, jid, pushName) {
  const all = _load(tenantId);
  const id  = jid.split('@')[0].split(':')[0];
  if (!all[id]) {
    all[id] = {
      jid,
      name:        pushName || id,
      messageCount: 0,
      firstSeen:   new Date().toISOString(),
      lastSeen:    new Date().toISOString(),
      topics:      [],
      language:    null,
    };
    _save(tenantId, all);
  }
  return all[id];
}

// Update profile after a message
function trackMessage(tenantId, jid, pushName, text) {
  const all = _load(tenantId);
  const id  = jid.split('@')[0].split(':')[0];

  const profile = all[id] || {
    jid,
    name:         pushName || id,
    messageCount: 0,
    firstSeen:    new Date().toISOString(),
    lastSeen:     null,
    topics:       [],
    language:     null,
  };

  profile.name         = pushName || profile.name;
  profile.lastSeen     = new Date().toISOString();
  profile.messageCount = (profile.messageCount || 0) + 1;

  // Extract simple topic keywords (nouns > 4 chars, not stopwords)
  if (text) {
    const stopwords = new Set(['yang', 'dengan', 'untuk', 'adalah', 'dari', 'dan', 'atau', 'ini', 'itu', 'saya', 'aku', 'kamu', 'bima', 'tolong', 'mohon', 'bisa']);
    const keywords = text.toLowerCase()
      .replace(/[^a-zA-Z\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4 && !stopwords.has(w));

    const recent = profile.topics || [];
    const merged = [...new Set([...keywords.slice(0, 3), ...recent])].slice(0, 15);
    profile.topics = merged;
  }

  all[id] = profile;
  _save(tenantId, all);
  return profile;
}

// Get all profiles for a tenant
function getAllProfiles(tenantId) {
  const all = _load(tenantId);
  return Object.values(all).sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
}

// Build context string to inject into agent prompt
function buildProfileContext(tenantId, jid, pushName) {
  const id      = jid.split('@')[0].split(':')[0];
  const all     = _load(tenantId);
  const profile = all[id];
  if (!profile) return '';

  const lines = [`Profil pengirim: ${profile.name || pushName || id}`];
  if (profile.messageCount) lines.push(`Sudah ${profile.messageCount}x berinteraksi`);
  if (profile.topics?.length) lines.push(`Topik biasa: ${profile.topics.slice(0, 5).join(', ')}`);
  if (profile.firstSeen) lines.push(`Pertama chat: ${profile.firstSeen.slice(0, 10)}`);

  return `[Context pengirim]\n${lines.join(' | ')}`;
}

// CLI: delete a profile
function deleteProfile(tenantId, jid) {
  const all = _load(tenantId);
  const id  = jid.split('@')[0].split(':')[0];
  if (!all[id]) return false;
  delete all[id];
  _save(tenantId, all);
  return true;
}

module.exports = { getProfile, trackMessage, getAllProfiles, buildProfileContext, deleteProfile };
