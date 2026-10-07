'use strict';

require('dotenv').config();

function parseIntEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Sama seperti parseIntEnv tapi 0 dianggap valid (mis. WEB_SEARCH_READ_PAGES=0 = jangan buka halaman). */
function parseIntEnvAllowZero(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Nama zona waktu IANA yang valid (mis. Asia/Jakarta), kalau gak valid -> fallback. */
function parseTimezone(raw, fallback) {
  const tz = String(raw || '').trim();
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch (_) {
    return fallback;
  }
}

function parseOrigins(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '*') return '*';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Daftar dipisah koma -> array string (trim, buang kosong & duplikat). Kosong -> fallback. */
function parseList(raw, fallback = []) {
  const items = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? [...new Set(items)] : fallback;
}

/** Trim + buang kutip yang sering ke-copy pas paste di Railway/Vercel. */
function cleanKey(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function parseModelOverrides(raw) {
  if (!raw || !String(raw).trim()) return {};
  const text = String(raw).trim();
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    // Fallback: dukung format "a:b,c:d" biar gak silent-fail pas operator isi salah
    const out = {};
    for (const part of text.split(',')) {
      const idx = part.indexOf(':');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k && v) out[k] = v;
    }
    if (Object.keys(out).length === 0) {
      // eslint-disable-next-line no-console
      console.warn('[env] MODEL_OVERRIDES bukan JSON yang valid, diabaikan.');
    }
    return out;
  }
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseIntEnv('PORT', 3000),
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),

  providerKeys: {
    groq: cleanKey(process.env.GROQ_API_KEY),
    nvidia: cleanKey(process.env.NVIDIA_API_KEY),
    mistral: cleanKey(process.env.MISTRAL_API_KEY),
    perplexity: cleanKey(process.env.PERPLEXITY_API_KEY),
    openrouter: cleanKey(process.env.OPENROUTER_API_KEY),
    gemini: cleanKey(process.env.GEMINI_API_KEY),
  },

  mistralModel: process.env.MISTRAL_MODEL || 'mistral-large-latest',
  // Default "openrouter/free" (router model gratis). "openrouter/auto" itu router berbayar -> 402 kalau saldo kosong.
  openrouterModel: process.env.OPENROUTER_MODEL || 'openrouter/free',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  spectraxFallbackModel:
    process.env.SPECTRAX_FALLBACK_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  modelOverrides: parseModelOverrides(process.env.MODEL_OVERRIDES),

  openrouterSiteUrl: process.env.OPENROUTER_SITE_URL || '',
  openrouterSiteName: process.env.OPENROUTER_SITE_NAME || 'VaeltrixAI',

  adminToken: cleanKey(process.env.ADMIN_TOKEN),

  supabaseUrl: cleanKey(process.env.SUPABASE_URL) || 'https://ugiehwqyrfgdjdsjbtrg.supabase.co',
  supabaseAnonKey:
    cleanKey(process.env.SUPABASE_ANON_KEY) ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVnaWVod3F5cmZnZGpkc2pidHJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1MzgxMzQsImV4cCI6MjEwNjExNDEzNH0.UHfgPh-8_gdxUkF4uL70gsQtxGArcT1lMyfw5gTq3rA',
  supabaseAuthTimeoutMs: parseIntEnv('SUPABASE_AUTH_TIMEOUT_MS', 8000),
  supabaseServiceRoleKey: cleanKey(process.env.SUPABASE_SERVICE_ROLE_KEY),

  apiKeyLimitPerOwner: parseIntEnv('API_KEY_LIMIT_PER_OWNER', 1),
  v1RateLimitPerKeyPerMin: parseIntEnv('V1_CHAT_RATE_LIMIT_PER_KEY', 60),
  v1RateLimitPerIpPerMin: parseIntEnv('V1_CHAT_RATE_LIMIT_PER_IP', 120),
  chatRateLimitPerMin: parseIntEnv('CHAT_RATE_LIMIT_PER_MIN', 60),
  chatRateLimitPerIpPerMin: parseIntEnv('CHAT_RATE_LIMIT_PER_IP', 180),

  // ---------- Web search real-time (DuckDuckGo) + aturan anti-halusinasi ----------
  // WEB_SEARCH_MODE: auto (default) = cari kecuali pesannya basa-basi/kreatif/kode murni; always = selalu cari; off = matiin total.
  webSearch: {
    mode: ['off', 'auto', 'always'].includes(String(process.env.WEB_SEARCH_MODE || '').toLowerCase())
      ? String(process.env.WEB_SEARCH_MODE).toLowerCase()
      : 'auto',
    maxResults: parseIntEnv('WEB_SEARCH_MAX_RESULTS', 5),
    readPages: parseIntEnvAllowZero('WEB_SEARCH_READ_PAGES', 3),
    searchTimeoutMs: parseIntEnv('WEB_SEARCH_TIMEOUT_MS', 5000),
    pageTimeoutMs: parseIntEnv('WEB_SEARCH_PAGE_TIMEOUT_MS', 4500),
    // Total karakter blok hasil pencarian yang ditempel ke prompt. Dijaga kecil karena limit token/menit
    // Groq free tier ketat (lihat CATATAN-PERBAIKAN.md). Naikin kalau providernya longgar.
    contextMaxChars: parseIntEnv('WEB_SEARCH_CONTEXT_MAX_CHARS', 3600),
    blockCooldownMs: parseIntEnv('WEB_SEARCH_BLOCK_COOLDOWN_MS', 60000),
    // Query IDENTIK dalam jendela ini berbagi satu hasil (bukan cache jangka panjang). Perlu karena browser cuma membuka
    // ~6 koneksi paralel per host: Multi Chat (banyak model) mengirim permintaan BERGELOMBANG, bukan serentak.
    // 0 = hanya berbagi selama pencarian masih berjalan. Hasil yang gagal tidak pernah dibagikan ulang.
    shareWindowMs: parseIntEnvAllowZero('WEB_SEARCH_SHARE_WINDOW_MS', 30000),
    // Wilayah hasil DuckDuckGo (format xx-xx, mis. id-id, us-en, wt-wt = global).
    region: /^[a-z]{2}-[a-z]{2}$/.test(String(process.env.WEB_SEARCH_REGION || '').toLowerCase())
      ? String(process.env.WEB_SEARCH_REGION).toLowerCase()
      : 'id-id',
    // Pembatas laju supaya IP server gak kena blokir DuckDuckGo gara-gara satu pemakai (atau bot) nge-spam.
    maxPerClientPerMin: parseIntEnv('WEB_SEARCH_MAX_PER_CLIENT_PER_MIN', 10),
    maxPerMin: parseIntEnv('WEB_SEARCH_MAX_PER_MIN', 40),
    // Suhu (temperature) dibatasi segini kalau jawaban pakai hasil pencarian: makin tinggi makin "kreatif" = makin gampang ngarang.
    maxTemperature: (() => {
      const v = parseFloat(process.env.WEB_SEARCH_MAX_TEMPERATURE);
      return Number.isFinite(v) && v >= 0 && v <= 2 ? v : 0.7;
    })(),
  },
  // ANTI_HALLUCINATION_POLICY=off buat mematikan aturan kejujuran yang ditempel server ke tiap request.
  policyEnabled: String(process.env.ANTI_HALLUCINATION_POLICY || '').toLowerCase() !== 'off',
  timezone: parseTimezone(process.env.APP_TIMEZONE, 'Asia/Jakarta'),

  // ---------- Suara: Text-to-Speech (ElevenLabs) + Speech-to-Text (Groq Whisper / ElevenLabs Scribe) ----------
  // API key SELALU cuma ada di server ini (env), gak pernah dikirim ke frontend. Lihat .env.voice buat penjelasan tiap variabel.
  voice: {
    elevenlabs: {
      apiKey: cleanKey(process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY),
      baseUrl: (cleanKey(process.env.ELEVENLABS_BASE_URL) || 'https://api.elevenlabs.io').replace(/\/+$/, ''),
      // Urutan model: yang pertama dipakai duluan, sisanya cadangan otomatis kalau model sebelumnya ditolak/dihapus ElevenLabs.
      ttsModels: parseList(process.env.ELEVENLABS_TTS_MODEL, ['eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_multilingual_v2']),
      outputFormat: cleanKey(process.env.ELEVENLABS_OUTPUT_FORMAT) || 'mp3_44100_128',
      timeoutMs: parseIntEnv('ELEVENLABS_TIMEOUT_MS', 30000),
      // Paket gratis ElevenLabs cuma boleh 2 request paralel: lebih dari itu antre di server (bukan ditolak ElevenLabs).
      maxConcurrency: parseIntEnv('ELEVENLABS_MAX_CONCURRENCY', 2),
      queueWaitMs: parseIntEnv('ELEVENLABS_QUEUE_WAIT_MS', 15000),
      voicesCacheMs: parseIntEnv('ELEVENLABS_VOICES_CACHE_MS', 30 * 60 * 1000),
      maxVoices: parseIntEnv('ELEVENLABS_MAX_VOICES', 6),
      voiceCategories: parseList(process.env.ELEVENLABS_VOICE_CATEGORIES, ['premade']),
      // Opsional: paksa daftar suara sendiri. Format "voiceId" atau "voiceId:Nama:female|male", dipisah koma.
      voiceIds: parseList(process.env.ELEVENLABS_VOICE_IDS, []),
      sttModel: cleanKey(process.env.ELEVENLABS_STT_MODEL) || 'scribe_v1',
    },
    tts: {
      maxCharsPerRequest: parseIntEnv('TTS_MAX_CHARS_PER_REQUEST', 3000),
      // Batas karakter yang boleh dibuatkan suaranya per perangkat per 24 jam (0 = tanpa batas). Ngelindungin kuota kredit.
      maxCharsPerClientPerDay: parseIntEnvAllowZero('TTS_MAX_CHARS_PER_CLIENT_PER_DAY', 15000),
      // Audio yang sama (suara+kecepatan+teks identik) disimpan di memori supaya "dengarkan lagi" gak makan kredit (0 = mati).
      audioCacheMaxBytes: parseIntEnvAllowZero('TTS_AUDIO_CACHE_MAX_MB', 40) * 1024 * 1024,
      rateLimitPerMin: parseIntEnv('TTS_RATE_LIMIT_PER_MIN', 40),
      rateLimitPerIpPerMin: parseIntEnv('TTS_RATE_LIMIT_PER_IP', 120),
    },
    stt: {
      // auto = Groq Whisper dulu (gratis, cepat, kuotanya terpisah dari ElevenLabs), cadangannya ElevenLabs Scribe.
      provider: ['auto', 'groq', 'elevenlabs'].includes(String(process.env.STT_PROVIDER || '').toLowerCase())
        ? String(process.env.STT_PROVIDER).toLowerCase()
        : 'auto',
      groqBaseUrl: (cleanKey(process.env.GROQ_STT_BASE_URL) || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
      groqModels: parseList(process.env.GROQ_STT_MODEL, ['whisper-large-v3-turbo', 'whisper-large-v3']),
      maxAudioBytes: parseIntEnv('STT_MAX_AUDIO_MB', 8) * 1024 * 1024,
      timeoutMs: parseIntEnv('STT_TIMEOUT_MS', 30000),
      rateLimitPerMin: parseIntEnv('STT_RATE_LIMIT_PER_MIN', 20),
      rateLimitPerIpPerMin: parseIntEnv('STT_RATE_LIMIT_PER_IP', 60),
    },
  },

  databasePath: process.env.DATABASE_PATH || './data/vaeltrixai.db',
  maxBodyBytes: parseIntEnv('MAX_BODY_BYTES', 15 * 1000 * 1000),
  upstreamTimeoutMs: parseIntEnv('UPSTREAM_TIMEOUT_MS', 60000),
};

env.providerAvailable = {
  groq: Boolean(env.providerKeys.groq),
  nvidia: Boolean(env.providerKeys.nvidia),
  mistral: Boolean(env.providerKeys.mistral),
  perplexity: Boolean(env.providerKeys.perplexity),
  openrouter: Boolean(env.providerKeys.openrouter),
  gemini: Boolean(env.providerKeys.gemini),
};

env.anyProviderAvailable = Object.values(env.providerAvailable).some(Boolean);

// Status fitur suara (sengaja TERPISAH dari providerAvailable: key ElevenLabs bukan provider chat,
// jadi gak boleh ikut ngitung "anyProviderAvailable").
env.voiceAvailable = (() => {
  const mode = env.voice.stt.provider;
  const groq = Boolean(env.providerKeys.groq) && mode !== 'elevenlabs';
  const elevenlabs = Boolean(env.voice.elevenlabs.apiKey) && mode !== 'groq';
  return { tts: Boolean(env.voice.elevenlabs.apiKey), stt: { groq, elevenlabs, any: groq || elevenlabs } };
})();

module.exports = env;
