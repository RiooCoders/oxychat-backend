'use strict';

require('dotenv').config();

function parseIntEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function parseOrigins(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '*') return '*';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseModelOverrides(raw) {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    // eslint-disable-next-line no-console
    console.warn('[env] MODEL_OVERRIDES bukan JSON yang valid, diabaikan.');
    return {};
  }
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseIntEnv('PORT', 3000),
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),

  providerKeys: {
    groq: process.env.GROQ_API_KEY || '',
    nvidia: process.env.NVIDIA_API_KEY || '',
    mistral: process.env.MISTRAL_API_KEY || '',
    perplexity: process.env.PERPLEXITY_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
    gemini: process.env.GEMINI_API_KEY || '',
  },

  mistralModel: process.env.MISTRAL_MODEL || 'mistral-large-latest',
  openrouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  spectraxFallbackModel: process.env.SPECTRAX_FALLBACK_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  modelOverrides: parseModelOverrides(process.env.MODEL_OVERRIDES),

  openrouterSiteUrl: process.env.OPENROUTER_SITE_URL || '',
  openrouterSiteName: process.env.OPENROUTER_SITE_NAME || 'OxyChat',

  adminToken: process.env.ADMIN_TOKEN || '',

  // ---------- Supabase (verifikasi identitas user yang login, BUKAN service role) ----------
  // Default di bawah ini persis nilai yang ada di chat/js/00-supabase.js (SUPABASE_URL +
  // anon key) — anon key ini memang didesain publik (dilindungi RLS), makanya aman dijadiin
  // default, tapi tetep bisa dioverride lewat env kalau project Supabase-nya beda/pindah.
  supabaseUrl: process.env.SUPABASE_URL || 'https://decfoxbykpcqvaagwtwe.supabase.co',
  supabaseAnonKey:
    process.env.SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlY2ZveGJ5a3BjcXZhYWd3dHdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5NjE2ODAsImV4cCI6MjEwMDUzNzY4MH0.R4hDp9KFLI4PPNVUyLy5drMDIN9JXWSafsMYdlQJ5U0',
  supabaseAuthTimeoutMs: parseIntEnv('SUPABASE_AUTH_TIMEOUT_MS', 8000),
  // ---------- Supabase service_role (HARDENING, audit lanjutan CRITICAL-3 Phase 2) ----------
  // RAHASIA — beda total dari anon key di atas. HANYA dipakai server-to-server lewat
  // services/supabase-admin.service.js (satu-satunya pemanggil: redeem.service.js, buat benar-
  // benar menerapkan plan berbayar ke Supabase setelah redeem code tervalidasi). TIDAK PERNAH
  // dikirim ke frontend/browser dengan cara apa pun. Kalau kosong, redeem tipe "plan" akan gagal
  // dengan jelas (bukan diam-diam nge-skip grant) — lihat redeem.service.js & supabase-admin.service.js.
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  // Limit pembuatan API key per identitas owner — flat 1x buat SEMUA plan sesuai
  // PLANS.*.keyLimit di chat/js/01-config-provider.js (gratis/pro/maks/promax semua "1x").
  apiKeyLimitPerOwner: parseIntEnv('API_KEY_LIMIT_PER_OWNER', 1),

  // Rate limit /v1/chat (API publik) — dua lapis sesuai master prompt: per API key & per IP.
  v1RateLimitPerKeyPerMin: parseIntEnv('V1_CHAT_RATE_LIMIT_PER_KEY', 60),
  v1RateLimitPerIpPerMin: parseIntEnv('V1_CHAT_RATE_LIMIT_PER_IP', 120),
  // Proteksi abuse infrastruktur buat /api/chat (dipakai frontend sendiri) — beda dari limit
  // produk (jumlah pesan per plan), yang memang sudah jadi urusan frontend, bukan backend ini.
  chatRateLimitPerMin: parseIntEnv('CHAT_RATE_LIMIT_PER_MIN', 60),
  // HARDENING (audit lanjutan): lapis KEDUA, wajib, dikunci ke req.ip SAJA (tidak baca header
  // apa pun dari client) — supaya limit di atas tidak bisa dilewati dengan gonta-ganti
  // X-Device-Id tiap request. Lihat SECURITY-AUDIT.md HIGH-4.
  chatRateLimitPerIpPerMin: parseIntEnv('CHAT_RATE_LIMIT_PER_IP', 180),

  databasePath: process.env.DATABASE_PATH || './data/oxychat.db',

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

module.exports = env;
