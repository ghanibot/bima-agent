'use strict';

// ── Built-in workflow templates ───────────────────────────────
// Each template is a factory function returning a fresh workflow object.
// tenantId and customization are applied at install time.
// Templates use placeholder {{GROUP_JID}} — replaced during install.

const TEMPLATES = [

  {
    id:          'btc_price_alert',
    name:        'BTC Price Alert',
    description: 'Cek harga Bitcoin setiap jam dari CoinGecko, kirim ke grup jika berubah ±2%',
    tags:        ['crypto', 'schedule', 'http'],
    build: () => ({
      trigger: { type: 'schedule', interval: '1h' },
      entry:   'fetch',
      nodes: [
        {
          id: 'fetch', type: 'http.request',
          config: {
            url:     'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,idr',
            method:  'GET',
            extract: 'bitcoin',
          },
          next: 'format',
        },
        {
          id: 'format', type: 'transform',
          config: { expr: '"BTC: $" + JSON.parse(input).usd.toLocaleString() + " / Rp" + JSON.parse(input).idr.toLocaleString()' },
          next: 'send',
        },
        {
          id: 'send', type: 'wa.send',
          config: { text: '📈 *Harga Bitcoin*\n{{lastOutput}}' },
          next: null,
        },
      ],
    }),
  },

  {
    id:          'weather_report',
    name:        'Laporan Cuaca Harian',
    description: 'Kirim laporan cuaca kota setiap pagi (07:00 via trigger 24h)',
    tags:        ['weather', 'schedule', 'http'],
    build: (vars = {}) => ({
      trigger: { type: 'schedule', interval: '24h' },
      entry:   'fetch',
      nodes: [
        {
          id: 'fetch', type: 'http.request',
          config: {
            url:    `https://wttr.in/${vars.city || 'Jakarta'}?format=3`,
            method: 'GET',
          },
          next: 'send',
        },
        {
          id: 'send', type: 'wa.send',
          config: { text: '🌤 *Cuaca Hari Ini*\n{{lastOutput}}' },
          next: null,
        },
      ],
    }),
  },

  {
    id:          'welcome_new_member',
    name:        'Sambut Member Baru',
    description: 'Kirim pesan sambutan otomatis saat ada yang join grup',
    tags:        ['group', 'wa.group_event'],
    build: () => ({
      trigger: { type: 'wa.group_event', actions: ['add'] },
      entry:   'greet',
      nodes: [
        {
          id: 'greet', type: 'wa.send',
          config: { text: '👋 Selamat datang *{{participant_name}}* di grup ini!\nJangan lupa baca peraturan grup ya 😊' },
          next: null,
        },
      ],
    }),
  },

  {
    id:          'ai_auto_reply',
    name:        'Auto-Reply dengan AI',
    description: 'Balas pesan WA yang cocok keyword menggunakan AI Bima',
    tags:        ['wa.message', 'ai', 'auto-reply'],
    build: (vars = {}) => ({
      trigger: { type: 'wa.message', match: vars.keyword || 'tanya bima', exclusive: true },
      entry:   'think',
      nodes: [
        {
          id: 'think', type: 'ai.call',
          config: {
            prompt: '{{message}}',
            system: 'Kamu Bima, asisten AI WhatsApp Indonesia. Jawab singkat dan informatif.',
          },
          next: 'reply',
        },
        {
          id: 'reply', type: 'wa.send',
          config: { text: '🤖 {{lastOutput}}' },
          next: null,
        },
      ],
    }),
  },

  {
    id:          'daily_group_summary',
    name:        'Rekap Harian Grup',
    description: 'Setiap malam rekap percakapan grup dengan AI, kirim ringkasan',
    tags:        ['schedule', 'ai', 'summary'],
    build: () => ({
      trigger: { type: 'schedule', interval: '24h' },
      entry:   'read',
      nodes: [
        {
          id: 'read', type: 'wa.read_group',
          config: { limit: 100 },
          next: 'summarize',
        },
        {
          id: 'summarize', type: 'ai.call',
          config: {
            prompt: 'Buat ringkasan singkat percakapan ini dalam 3-5 poin:\n\n{{lastOutput}}',
            system: 'Kamu asisten yang merangkum percakapan grup WhatsApp. Jawab bahasa Indonesia, singkat dan padat.',
          },
          next: 'send',
        },
        {
          id: 'send', type: 'wa.send',
          config: { text: '📋 *Rekap Hari Ini*\n\n{{lastOutput}}' },
          next: null,
        },
      ],
    }),
  },

  {
    id:          'web_monitor',
    name:        'Monitor Halaman Web',
    description: 'Pantau URL setiap 30 menit, kirim notif jika konten berubah',
    tags:        ['schedule', 'http', 'monitor'],
    build: (vars = {}) => ({
      trigger: { type: 'schedule', interval: '30m' },
      entry:   'fetch',
      nodes: [
        {
          id: 'fetch', type: 'http.request',
          config: { url: vars.url || 'https://example.com', method: 'GET' },
          next: 'check',
        },
        {
          id: 'check', type: 'condition',
          config: { expr: 'lastOutput && lastOutput.length > 0' },
          branches: { true: 'notify', false: 'noop' },
        },
        {
          id: 'notify', type: 'wa.send',
          config: { text: `🔔 *Update dari ${vars.url || 'website'}*\n{{lastOutput}}` },
          next: null,
        },
        {
          id: 'noop', type: 'log',
          config: { text: 'no content' },
          next: null,
        },
      ],
    }),
  },

  {
    id:          'file_to_wa',
    name:        'File Masuk → Kirim ke WA',
    description: 'Pantau folder, jika ada file baru kirim isinya ke grup via AI',
    tags:        ['file', 'ai', 'automation'],
    build: (vars = {}) => ({
      trigger: { type: 'file', path: vars.path || '~/bima-inbox', events: ['created'] },
      entry:   'read_file',
      nodes: [
        {
          id: 'read_file', type: 'set',
          config: { key: 'lastOutput', value: '{{file_content}}' },
          next: 'summarize',
        },
        {
          id: 'summarize', type: 'ai.call',
          config: {
            prompt: 'Ringkas konten file ini dalam bahasa Indonesia:\n\n{{lastOutput}}',
            system: 'Kamu asisten yang merangkum dokumen. Jawab singkat.',
          },
          next: 'send',
        },
        {
          id: 'send', type: 'wa.send',
          config: { text: '📄 *File baru: {{file_name}}*\n\n{{lastOutput}}' },
          next: null,
        },
      ],
    }),
  },

  {
    id:          'voice_to_ai_reply',
    name:        'Voice Note → AI → Reply',
    description: 'Transkripsi voice note user, jawab dengan AI, balas teks',
    tags:        ['wa.message', 'audio', 'ai'],
    build: () => ({
      trigger: { type: 'wa.message', onMedia: 'audio', mediaOnly: true, exclusive: true },
      entry:   'transcribe',
      nodes: [
        {
          id: 'transcribe', type: 'wa.transcribe',
          config: { source: 'trigger' },
          retry: { times: 1, backoff: 'fixed', delayMs: 1500 },
          next: 'think',
        },
        {
          id: 'think', type: 'ai.call',
          config: {
            prompt: 'User mengirim voice note: "{{lastOutput}}"\n\nJawab dengan singkat dan jelas.',
            system: 'Kamu Bima, asisten AI WhatsApp Indonesia. Jawab singkat dan informatif.',
          },
          retry: { times: 1, backoff: 'exponential', delayMs: 1000 },
          next: 'reply',
        },
        {
          id: 'reply', type: 'wa.send',
          config: { text: '🎙 Transkrip: _"{{transcribe_output}}"_\n\n🤖 {{lastOutput}}' },
          next: null,
        },
      ],
    }),
  },

  {
    id:          'image_to_description',
    name:        'Foto → Deskripsi AI',
    description: 'User kirim foto, AI deskripsikan/jawab pertanyaan tentang isi gambar',
    tags:        ['wa.message', 'image', 'ai', 'vision'],
    build: () => ({
      trigger: { type: 'wa.message', onMedia: 'image', mediaOnly: true, exclusive: true },
      entry:   'see',
      nodes: [
        {
          id: 'see', type: 'wa.vision',
          config: { source: 'trigger', question: '{{message}}' },
          retry: { times: 1, backoff: 'fixed', delayMs: 2000 },
          next: 'reply',
        },
        {
          id: 'reply', type: 'wa.send',
          config: { text: '👁 {{lastOutput}}' },
          next: null,
        },
      ],
    }),
  },

  {
    id:          'multi_city_weather',
    name:        'Cuaca Banyak Kota (Loop)',
    description: 'Ambil cuaca beberapa kota sekaligus, kirim rekapnya',
    tags:        ['schedule', 'loop', 'http', 'weather'],
    build: (vars = {}) => {
      const cities = vars.cities || ['Jakarta', 'Surabaya', 'Bandung'];
      return {
        trigger: { type: 'schedule', interval: '24h' },
        entry:   'setup',
        nodes: [
          {
            id: 'setup', type: 'set',
            config: { key: 'lastOutput', value: JSON.stringify(cities) },
            next: 'loop_cities',
          },
          {
            id: 'loop_cities', type: 'loop',
            config: { items: '{{lastOutput}}', itemVar: 'kota', body: 'fetch_city', maxIterations: 10 },
            next: 'collect',
          },
          {
            id: 'fetch_city', type: 'http.request',
            config: { url: 'https://wttr.in/{{kota}}?format=3', method: 'GET' },
            next: null,
          },
          {
            id: 'collect', type: 'transform',
            config: { expr: 'Array.isArray(JSON.parse(input)) ? JSON.parse(input).join("\\n") : input' },
            next: 'send',
          },
          {
            id: 'send', type: 'wa.send',
            config: { text: '🌦 *Cuaca Hari Ini*\n{{lastOutput}}' },
            next: null,
          },
        ],
      };
    },
  },
];

// ── Registry helpers ──────────────────────────────────────────
function listTemplates() {
  return TEMPLATES.map(t => ({
    id:          t.id,
    name:        t.name,
    description: t.description,
    tags:        t.tags,
  }));
}

function getTemplate(templateId) {
  return TEMPLATES.find(t => t.id === templateId) || null;
}

// ── Install template as a new workflow ───────────────────────
// vars: { city, keyword, url, path, cities, ... } for customization
function installTemplate(templateId, tenantId, newId, vars = {}) {
  const tmpl = getTemplate(templateId);
  if (!tmpl) throw new Error(`Template "${templateId}" tidak ditemukan`);

  const { saveWorkflow, getWorkflow } = require('./workflow');
  const wfId = newId || templateId;

  if (getWorkflow(tenantId, wfId)) throw new Error(`Workflow "${wfId}" sudah ada`);

  const built = tmpl.build(vars);
  const wf = {
    id:          wfId,
    name:        tmpl.name,
    description: tmpl.description,
    tenant:      tenantId,
    enabled:     false,
    trigger:     built.trigger,
    nodes:       built.nodes,
    entry:       built.entry,
    _template:   templateId,
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
  };

  saveWorkflow(tenantId, wf);
  return wf;
}

module.exports = { listTemplates, getTemplate, installTemplate };
