'use strict';

const GAMMA = 'https://gamma-api.polymarket.com';

function _parsePrice(raw) {
  const n = parseFloat(raw);
  return isNaN(n) ? 0 : n;
}

function _parseArr(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch {}
  }
  return [];
}

function _fmtVol(raw) {
  const n = parseFloat(raw) || 0;
  // Gamma API returns volume in USDC with 6 decimals stored as float string
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function _fmtMarket(m, idx) {
  const outcomes = _parseArr(m.outcomes);
  const prices   = _parseArr(m.outcomePrices);
  const lines    = [];

  let probStr = '';
  if (outcomes.length >= 2 && prices.length >= 2) {
    if (outcomes.length === 2) {
      // Binary — show Yes %
      const yi  = outcomes.findIndex(o => /yes/i.test(o));
      const p   = yi >= 0 ? prices[yi] : prices[0];
      probStr   = `${Math.round(_parsePrice(p) * 100)}% Ya`;
    } else {
      // Multi — top 2 by prob
      const pairs = outcomes.map((o, i) => ({ o, p: _parsePrice(prices[i]) }))
        .sort((a, b) => b.p - a.p).slice(0, 2);
      probStr = pairs.map(x => `${x.o}: ${Math.round(x.p * 100)}%`).join(' · ');
    }
  }

  const vol  = m.volume   ? _fmtVol(m.volume) + ' vol'                                              : '';
  const ends = m.endDate  ? 'tutup ' + new Date(m.endDate).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: '2-digit' }) : '';

  const num = idx != null ? `${idx + 1}. ` : '';
  lines.push(`${num}*${m.question}*`);
  if (probStr)          lines.push(`   Peluang: ${probStr}`);
  if (vol || ends)      lines.push(`   ${[vol, ends].filter(Boolean).join(' · ')}`);
  return lines.join('\n');
}

async function searchMarkets(query, limit = 8) {
  const params = new URLSearchParams({
    limit:     String(limit),
    active:    'true',
    closed:    'false',
    order:     'volume24hr',
    ascending: 'false',
    ...(query ? { search: query } : {}),
  });

  const res = await fetch(`${GAMMA}/markets?${params}`, {
    headers: { Accept: 'application/json' },
    signal:  AbortSignal.timeout(12_000),
  });

  if (!res.ok) throw new Error(`Polymarket API error ${res.status}`);
  const data = await res.json();

  if (!Array.isArray(data) || !data.length) {
    return query
      ? `Tidak ada pasar prediksi untuk "${query}".`
      : 'Tidak ada pasar aktif ditemukan.';
  }

  const header = `🎯 *Polymarket — ${query ? `"${query}"` : 'Trending'}*\n`;
  return header + data.map((m, i) => _fmtMarket(m, i)).join('\n\n');
}

async function getTrendingMarkets(limit = 6) {
  return searchMarkets('', limit);
}

async function getMarketDetail(query) {
  // First search, return top result with more detail
  const params = new URLSearchParams({
    limit: '1', active: 'true', closed: 'false', search: query,
  });
  const res = await fetch(`${GAMMA}/markets?${params}`, {
    headers: { Accept: 'application/json' },
    signal:  AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Polymarket API error ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) return `Pasar "${query}" tidak ditemukan.`;
  return _fmtMarket(data[0], null);
}

module.exports = { searchMarkets, getTrendingMarkets, getMarketDetail };
