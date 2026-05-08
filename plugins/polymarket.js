'use strict';

// ── Polymarket Plugin untuk Bima ──────────────────────────────
// Data prediksi pasar dari Polymarket (public API, no key needed)
//
// Install: /skill add plugins/polymarket.js
//
// Tools yang ditambahkan ke agent:
//   polymarket_search(query)   — cari pasar prediksi
//   polymarket_market(keyword) — detail + probabilitas market
//   polymarket_trending()      — pasar paling ramai
//
// CLI command:
//   /polymarket [query]        — tampilkan di terminal

const BASE    = 'https://gamma-api.polymarket.com';
const TIMEOUT = 10000;

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`, {
    signal:  AbortSignal.timeout(TIMEOUT),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fmtVolume(v) {
  if (!v) return '';
  const n = Number(v);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatMarket(m) {
  const title    = m.question || m.title || m.slug || '?';
  const vol      = m.volume   ? `Vol: ${fmtVolume(m.volume)}` : '';
  const end      = m.endDate  ? `Tutup: ${new Date(m.endDate).toLocaleDateString('id-ID')}` : '';

  const outcomes = (m.outcomes || []).map((o, i) => {
    const price = m.outcomePrices?.[i];
    const pct   = price != null ? `${(parseFloat(price) * 100).toFixed(1)}%` : '?';
    return `  • ${o}: *${pct}*`;
  });

  return [
    `*${title}*`,
    outcomes.join('\n'),
    [vol, end].filter(Boolean).join('  |  '),
  ].filter(Boolean).join('\n');
}

async function toolSearch(query) {
  try {
    const p = new URLSearchParams({ q: query, limit: '5', active: 'true', closed: 'false' });
    const r = await apiFetch(`/markets?${p}`);
    if (!r?.length) return `Tidak ada pasar prediksi untuk "${query}".`;
    return r.map(formatMarket).join('\n\n─────\n\n');
  } catch (e) { return `Error Polymarket: ${e.message}`; }
}

async function toolMarket(input) {
  try {
    let market;
    // Try slug first
    try {
      const r = await apiFetch(`/markets?slug=${encodeURIComponent(input)}&limit=1`);
      market  = Array.isArray(r) ? r[0] : r;
    } catch {}
    // Fallback: search
    if (!market) {
      const r = await apiFetch(`/markets?q=${encodeURIComponent(input)}&limit=1&active=true`);
      market  = Array.isArray(r) ? r[0] : null;
    }
    if (!market) return `Market "${input}" tidak ditemukan.`;

    const lines = [formatMarket(market)];
    if (market.description) lines.push(`\n${market.description.slice(0, 400)}`);
    if (market.slug) lines.push(`\nhttps://polymarket.com/market/${market.slug}`);
    return lines.join('\n');
  } catch (e) { return `Error: ${e.message}`; }
}

async function toolTrending() {
  try {
    const r = await apiFetch('/markets?active=true&closed=false&limit=8&order=volume&ascending=false');
    if (!r?.length) return 'Tidak ada data trending saat ini.';
    return '*Polymarket — Pasar Paling Ramai:*\n\n' + r.map(formatMarket).join('\n\n─────\n\n');
  } catch (e) { return `Error: ${e.message}`; }
}

async function cmdPolymarket(args, ctx) {
  const q = (args || '').trim();
  ctx.log('INFO', `Polymarket: ${q || 'trending'}`);
  const result = q ? await toolSearch(q) : await toolTrending();
  ctx.appendChat('system', result);
}

module.exports = {
  name:        'polymarket',
  description: 'Prediksi pasar Polymarket — probabilitas event dunia secara real-time',

  commands: {
    '/polymarket': cmdPolymarket,
  },

  tools: [
    {
      name:        'polymarket_search',
      description: 'Cari pasar prediksi Polymarket berdasarkan topik (misal: "trump", "bitcoin", "indonesia election")',
      async execute(input) { return toolSearch(String(input)); },
    },
    {
      name:        'polymarket_market',
      description: 'Detail probabilitas satu market Polymarket (slug atau keyword spesifik)',
      async execute(input) { return toolMarket(String(input)); },
    },
    {
      name:        'polymarket_trending',
      description: 'Pasar prediksi paling ramai di Polymarket hari ini',
      async execute()      { return toolTrending(); },
    },
  ],
};
