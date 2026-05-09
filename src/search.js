'use strict';

const miniBrowser = require('./mini_browser');

// ── Sandbox config ─────────────────────────────────────────────
const FETCH_TIMEOUT_MS  = 12000;
const MAX_BODY_BYTES    = 150_000;   // 150 KB max per page
const MAX_PAGES_FETCH   = 3;         // fetch top N result pages

// Block private/local IPs for sandbox safety
const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|file:)/i;

function isSafeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (BLOCKED_HOSTS.test(u.hostname)) return false;
    return true;
  } catch { return false; }
}

// ── Fetch with timeout + size limit ───────────────────────────
async function safeFetch(url, timeoutMs = FETCH_TIMEOUT_MS) {
  if (!isSafeUrl(url)) throw new Error(`URL tidak diizinkan: ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BimaBot/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Stream body with size cap
    const reader = res.body?.getReader();
    if (!reader) return await res.text();

    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
      if (total > MAX_BODY_BYTES) { reader.cancel(); break; }
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML → readable text ───────────────────────────────────────
function htmlToText(html) {
  let text = html
    // Strip unwanted blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    // Block-level tags → newline
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // HTML entities
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');

  // Clean up lines — drop JSON-like lines, very short lines, lines of symbols
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => {
      if (l.length < 25) return false;                          // terlalu pendek
      if (/^[\{\[\,\:\}\]\"\']+/.test(l)) return false;        // JSON artifact
      if ((l.match(/[{}[\]]/g) || []).length > 4) return false; // banyak brackets
      if (/^(\s*[\|\-\+]{2,}\s*)+$/.test(l)) return false;     // tabel ASCII
      if (l.split(' ').filter(Boolean).length < 4) return false; // kurang dari 4 kata
      const alphaRatio = (l.match(/[a-zA-ZÀ-ɏ-ɏ]/g) || []).length / l.length;
      if (alphaRatio < 0.4) return false;                       // terlalu banyak simbol
      return true;
    });

  // Deduplicate consecutive identical lines
  const deduped = lines.filter((l, i) => l !== lines[i - 1]);

  return deduped.slice(0, 80).join('\n').trim();
}

// ── DuckDuckGo search → result URLs ───────────────────────────
async function duckduckgoSearch(query) {
  const instant = [];
  const urls    = [];
  const seen    = new Set();

  // 1. Instant Answer API
  try {
    const iaRes = await safeFetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    );
    const ia = JSON.parse(iaRes);
    if (ia.Answer)       instant.push(ia.Answer);
    if (ia.AbstractText) instant.push(`${ia.AbstractText}${ia.AbstractURL ? ' — ' + ia.AbstractURL : ''}`);
    (ia.RelatedTopics || []).filter(t => t.Text).slice(0, 2).forEach(t => instant.push(`• ${t.Text}`));
  } catch {}

  // 2. DDG HTML search for result page URLs
  try {
    const html = await safeFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const re   = /uddg=([^"&]+)/g;
    let m;
    while ((m = re.exec(html)) !== null && urls.length < 5) {
      const url = decodeURIComponent(m[1]);
      if (isSafeUrl(url) && !seen.has(url)) { seen.add(url); urls.push(url); }
    }
  } catch {}

  // 3. Brave Search as fallback / supplement (free, no key, better freshness)
  if (urls.length < 2) {
    try {
      const braveHtml = await safeFetch(
        `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
        8000
      );
      const re = /href="(https?:\/\/[^"]+)"/g;
      let m;
      const braveUrls = [];
      while ((m = re.exec(braveHtml)) !== null && braveUrls.length < 6) {
        const url = m[1];
        if (isSafeUrl(url) && !seen.has(url) &&
            !url.includes('brave.com') && !url.includes('accounts.')) {
          seen.add(url); braveUrls.push(url);
        }
      }
      // Take top 3 from Brave
      braveUrls.slice(0, 3).forEach(u => urls.push(u));
    } catch {}
  }

  return { instant, urls };
}

// ── Fetch and extract page content ────────────────────────────
async function fetchPage(url) {
  try {
    const html = await safeFetch(url, 8000);
    const text = htmlToText(html);
    if (text.length < 100) return null;
    return { url, text };
  } catch { return null; }
}

// ── Main web_search ────────────────────────────────────────────
async function webSearch(query) {
  // Try mini-browser first (Playwright + trafilatura, token-efficient)
  try {
    if (await miniBrowser.isAvailable()) {
      const result = await miniBrowser.webSearch(query, { maxResults: 3, maxTokens: 1500 });
      if (result && result.length > 50) return result;
    }
  } catch {}

  // Fallback: original implementation
  try {
    const { instant, urls } = await duckduckgoSearch(query);

    const parts = [];

    if (instant.length) {
      parts.push('📌 Jawaban Cepat:\n' + instant.join('\n'));
    }

    if (urls.length) {
      const pages = await Promise.all(urls.slice(0, MAX_PAGES_FETCH).map(fetchPage));
      const valid = pages.filter(Boolean);
      if (valid.length) {
        parts.push(
          valid.map(p =>
            `🔗 ${p.url}\n${p.text.slice(0, 1200)}`
          ).join('\n\n---\n\n')
        );
      }
    }

    return parts.length ? parts.join('\n\n') : null;
  } catch (e) {
    return null;
  }
}

// ── browse_url — fetch any URL and return readable text ────────
async function browseUrl(url) {
  if (!isSafeUrl(url)) return `URL tidak diizinkan: ${url}`;

  // Try mini-browser first (handles JS-heavy sites, PDFs, stealth mode)
  try {
    if (await miniBrowser.isAvailable()) {
      const result = await miniBrowser.browseUrl(url, { maxTokens: 1500 });
      if (result && result.length > 50 && !result.startsWith('Failed')) return result;
    }
  } catch {}

  // Fallback: original implementation
  try {
    const page = await fetchPage(url);
    if (!page) return `Gagal membaca konten dari ${url}`;
    return `[${url}]\n${page.text}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// ── getPrice — harga crypto/saham/forex realtime ──────────────
const COIN_MAP = {
  bitcoin: 'bitcoin', btc: 'bitcoin',
  ethereum: 'ethereum', eth: 'ethereum',
  solana: 'solana', sol: 'solana',
  bnb: 'binancecoin', binance: 'binancecoin',
  xrp: 'ripple', ripple: 'ripple',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  ada: 'cardano', cardano: 'cardano',
  usdt: 'tether', tether: 'tether',
  usdc: 'usd-coin',
  avax: 'avalanche-2', avalanche: 'avalanche-2',
  dot: 'polkadot', polkadot: 'polkadot',
  matic: 'matic-network', polygon: 'matic-network',
  link: 'chainlink', chainlink: 'chainlink',
  ton: 'the-open-network',
  trx: 'tron', tron: 'tron',
};

async function getPrice(query) {
  const q = query.toLowerCase().trim();

  // ── Crypto via CoinGecko (free, no key) ──────────────────────
  const coinId = COIN_MAP[q] || (Object.values(COIN_MAP).includes(q) ? q : null);
  if (coinId) {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd,idr&include_24hr_change=true&include_market_cap=true`;
      const res  = await safeFetch(url, 8000);
      const data = JSON.parse(res);
      const d    = data[coinId];
      if (!d) return `Data harga ${query} tidak ditemukan.`;

      const usd    = d.usd?.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }) || '?';
      const idr    = d.idr ? `Rp ${Math.round(d.idr).toLocaleString('id-ID')}` : '';
      const chg    = d.usd_24h_change != null ? `${d.usd_24h_change > 0 ? '+' : ''}${d.usd_24h_change.toFixed(2)}%` : '';
      const cap    = d.usd_market_cap ? `$${(d.usd_market_cap / 1e9).toFixed(1)}B` : '';
      const trend  = d.usd_24h_change > 0 ? '📈' : '📉';

      const lines = [`*${query.toUpperCase()} — Harga Terkini*`];
      lines.push(`💵 USD : ${usd}`);
      if (idr) lines.push(`🇮🇩 IDR : ${idr}`);
      if (chg) lines.push(`${trend} 24h  : ${chg}`);
      if (cap) lines.push(`📊 Mkt Cap: ${cap}`);
      lines.push(`🔗 coingecko.com/en/coins/${coinId}`);
      return lines.join('\n');
    } catch (e) {
      return `Error ambil harga crypto: ${e.message}`;
    }
  }

  // ── Saham/Forex via Yahoo Finance (no key needed) ─────────────
  // Try as stock ticker
  const ticker = q.toUpperCase().replace(/\s+/g, '');
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res  = await safeFetch(url, 8000);
    const data = JSON.parse(res);
    const meta = data?.chart?.result?.[0]?.meta;
    if (meta) {
      const price  = meta.regularMarketPrice;
      const prev   = meta.chartPreviousClose;
      const chgPct = prev ? (((price - prev) / prev) * 100).toFixed(2) : null;
      const cur    = meta.currency || 'USD';
      const trend  = chgPct > 0 ? '📈' : '📉';

      const lines  = [`*${meta.symbol} — ${meta.shortName || ticker}*`];
      lines.push(`💵 Harga: ${price?.toLocaleString('en-US')} ${cur}`);
      if (chgPct) lines.push(`${trend} 24h : ${chgPct > 0 ? '+' : ''}${chgPct}%`);
      lines.push(`📅 ${new Date(meta.regularMarketTime * 1000).toLocaleString('id-ID')}`);
      return lines.join('\n');
    }
  } catch {}

  // Fallback to web_search for price
  return await webSearch(`harga ${query} sekarang`);
}

// ── deep_research ─────────────────────────────────────────────
// Multi-angle research: break topic into sub-queries, search each,
// browse top pages, compile into a dense context block.
async function deepResearch(topic, cfg) {
  const results = [];

  // Step 1: Generate sub-queries using AI (if available), else split manually
  let subQueries = [topic];
  if (cfg?.provider && cfg?.apiKey) {
    try {
      const { callAI } = require('./ai');
      const raw = await callAI([{
        role: 'user',
        content: `Buat 3 query pencarian Google singkat (bahasa Inggris, 4-6 kata) untuk meneliti topik ini secara mendalam: "${topic}"\n\nBalas HANYA dengan JSON array string, contoh: ["query1","query2","query3"]`,
      }], 'Kamu adalah research assistant. Balas hanya JSON valid.', cfg);
      const cleaned = raw.replace(/```json|```/gi, '').trim();
      const parsed  = JSON.parse(cleaned.match(/\[[\s\S]*\]/)?.[0] || '[]');
      if (Array.isArray(parsed) && parsed.length) subQueries = parsed.slice(0, 3);
    } catch {
      // fallback: use original topic + English translation attempt
      subQueries = [topic, `${topic} latest news`, `${topic} analysis`];
    }
  }

  // Step 2: Search each sub-query + collect unique URLs
  const seenUrls = new Set();
  const allUrls  = [];

  for (const q of subQueries) {
    try {
      const { instant, urls } = await duckduckgoSearch(q);
      if (instant.length) {
        results.push(`🔍 [${q}]\n${instant.join('\n')}`);
      }
      for (const u of urls) {
        if (!seenUrls.has(u)) { seenUrls.add(u); allUrls.push(u); }
      }
    } catch {}
  }

  // Step 3: Browse top unique pages (max 5, parallel with timeout)
  const pages = await Promise.allSettled(
    allUrls.slice(0, 5).map(url => fetchPage(url))
  );

  const validPages = pages
    .filter(p => p.status === 'fulfilled' && p.value)
    .map(p => p.value);

  for (const page of validPages) {
    results.push(`📄 ${page.url}\n${page.text.slice(0, 2000)}`);
  }

  if (!results.length) return `Tidak dapat menemukan informasi tentang: ${topic}`;

  return (
    `🔬 Hasil Riset: "${topic}"\n` +
    `📊 ${subQueries.length} sudut pandang  •  ${validPages.length} halaman dibaca\n\n` +
    results.join('\n\n━━━\n\n')
  );
}

module.exports = { webSearch, browseUrl, deepResearch, getPrice, isSafeUrl };
