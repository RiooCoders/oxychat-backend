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
  openrouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  spectraxFallbackModel:
    process.env.SPECTRAX_FALLBACK_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  modelOverrides: parseModelOverrides(process.env.MODEL_OVERRIDES),

  openrouterSiteUrl: process.env.OPENROUTER_SITE_URL || '',
  openrouterSiteName: process.env.OPENROUTER_SITE_NAME || 'OxyChat',

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
