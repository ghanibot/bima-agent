'use strict';

// Conversation history per user (in-memory, max MAX_TURNS pairs)
// Key: `${groupJid}::${senderJid}`

const histories = new Map();
const MAX_TURNS = 8; // 8 user+bot pairs kept per user per group

function _key(groupJid, senderJid) {
  return `${groupJid}::${senderJid}`;
}

function addTurn(groupJid, senderJid, userMsg, botReply) {
  const k = _key(groupJid, senderJid);
  if (!histories.has(k)) histories.set(k, []);
  const hist = histories.get(k);

  hist.push({ role: 'user',      content: userMsg  });
  hist.push({ role: 'assistant', content: botReply });

  // Keep only last MAX_TURNS pairs (2 messages per pair)
  if (hist.length > MAX_TURNS * 2) {
    hist.splice(0, hist.length - MAX_TURNS * 2);
  }
}

// Returns [{role, content}] array ready for AI messages
function getHistory(groupJid, senderJid) {
  return histories.get(_key(groupJid, senderJid)) || [];
}

function clearHistory(groupJid, senderJid) {
  histories.delete(_key(groupJid, senderJid));
}

function clearAll() {
  histories.clear();
}

module.exports = { addTurn, getHistory, clearHistory, clearAll };
