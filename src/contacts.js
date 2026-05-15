'use strict';

const fs   = require('fs');
const path = require('path');

function contactsPath(tenantId) {
  const { tenantPaths } = require('./tenant');
  return path.join(tenantPaths(tenantId || 'default').dir, 'contacts.json');
}

function load(tenantId) {
  try {
    const p = contactsPath(tenantId);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function save(tenantId, contacts) {
  const p = contactsPath(tenantId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(contacts, null, 2));
}

// Normalize phone: strip non-digits, ensure starts with 62
function normalizePhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
}

function formatDisplay(phone) {
  const p = normalizePhone(phone);
  return '+' + p;
}

function saveContact(name, phone, tenantId) {
  const contacts = load(tenantId);
  const normalized = normalizePhone(phone);
  const nameLower  = name.trim().toLowerCase();

  const existing = contacts.findIndex(c => c.nameLower === nameLower);
  if (existing >= 0) {
    contacts[existing] = { name: name.trim(), nameLower, phone: normalized, saved: Date.now() };
  } else {
    contacts.push({ name: name.trim(), nameLower, phone: normalized, saved: Date.now() });
  }
  save(tenantId, contacts);
  return formatDisplay(normalized);
}

function deleteContact(name, tenantId) {
  const contacts = load(tenantId);
  const nameLower = name.trim().toLowerCase();
  const idx = contacts.findIndex(c => c.nameLower === nameLower || c.name.toLowerCase() === nameLower);
  if (idx < 0) return false;
  contacts.splice(idx, 1);
  save(tenantId, contacts);
  return true;
}

// Look up by name (fuzzy/partial match). Returns array of matches.
function lookupContact(query, tenantId) {
  const contacts = load(tenantId);
  const q = query.trim().toLowerCase();
  return contacts.filter(c =>
    c.nameLower.includes(q) ||
    c.name.toLowerCase().includes(q) ||
    c.phone.includes(q)
  ).map(c => ({ name: c.name, phone: formatDisplay(c.phone) }));
}

function listContacts(tenantId) {
  return load(tenantId).map(c => ({ name: c.name, phone: formatDisplay(c.phone) }));
}

module.exports = { saveContact, deleteContact, lookupContact, listContacts, formatDisplay, normalizePhone };
