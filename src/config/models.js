'use strict';

const env = require('./env');

/**
 * SOURCE OF TRUTH provider routing — disalin persis dari chat/js/01-config-provider.js.
 * Urutan pengecekan SENGAJA sama seperti frontend punya getProviderName():
 * spectrax -> openrouter -> nvidia -> mistral -> perplexity -> (default) groq.
 * JANGAN ubah identifier di sini, frontend mengirim persis string-string ini sebagai "model".
 */
const SPECTRAX_MODELS = ['spectrax'];
const OPENROUTER_MODELS = ['openrouter/free'];
const NVIDIA_MODELS = [
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'deepseek-ai/deepseek-r1',
  'meta/llama-3.3-70b-instruct',
];
const MISTRAL_MODELS = ['vaneus-4.0'];
const PERPLEXITY_MODELS = ['sonar-reasoning-pro', 'sonar-pro', 'sonar', 'sonar-deep-research'];
// Sisanya (llama-3.1-8b-instant, llama-3.3-70b-versatile, openai/gpt-oss-120b,
// openai/gpt-oss-20b, qwen/qwen3.6-27b, ...) default ke Groq.
const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.6-27b',
];

const ALL_KNOWN_MODELS = new Set([
  ...SPECTRAX_MODELS,
  ...OPENROUTER_MODELS,
  ...NVIDIA_MODELS,
  ...MISTRAL_MODELS,
  ...PERPLEXITY_MODELS,
  ...GROQ_MODELS,
]);

/**
 * Model yang boleh nerima content multimodal (image_url). Persis VISION_MODEL di frontend
 * (chat/js/01-config-provider.js) — CUMA qwen/qwen3.6-27b, biarpun labelnya di dropdown
 * "Oxy Thinking" (bukan "Oxy Vision"). Ini bukan typo dari reconstruction ini, itu memang
 * behavior asli frontend-nya.
 */
const VISION_MODELS = ['qwen/qwen3.6-27b'];

/** Model publik -> provider. */
function resolveProvider(model) {
  if (SPECTRAX_MODELS.includes(model)) return 'spectrax';
  if (OPENROUTER_MODELS.includes(model)) return 'openrouter';
  if (NVIDIA_MODELS.includes(model)) return 'nvidia';
  if (MISTRAL_MODELS.includes(model)) return 'mistral';
  if (PERPLEXITY_MODELS.includes(model)) return 'perplexity';
  return 'groq'; // default, sama seperti frontend
}

/**
 * Model publik (identifier yang dipakai frontend & wajib dipertahankan) -> model ASLI yang
 * beneran dikirim ke upstream provider. Default = identik (passthrough), kecuali provider
 * tsb butuh nama model yang beda (mistral & openrouter, karena "vaneus-4.0" / "openrouter/free"
 * bukan nama model asli). Override manual lewat MODEL_OVERRIDES / env khusus tetap dihormati.
 */
function resolveUpstreamModel(model) {
  if (env.modelOverrides[model]) return env.modelOverrides[model];
  if (MISTRAL_MODELS.includes(model)) return env.mistralModel;
  if (OPENROUTER_MODELS.includes(model)) return env.openrouterModel;
  return model;
}

/**
 * Alias publik yang dipakai di /api/keys (modelId) & /v1/chat -> model internal frontend.
 * HARUS sinkron persis sama APIKEY_MODEL_CATALOG di chat/js/04-account-settings.js &
 * chat/CreateApikey/script.js. Alias adalah bagian dari kontrak API, tidak boleh diubah.
 */
const API_KEY_MODEL_ALIASES = {
  'auto-model': 'openrouter/free',
  spectrax: 'spectrax',
  'vaneus-4.0': 'vaneus-4.0',
  'oxy-nemotron': 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'oxy-deepseek-r1': 'deepseek-ai/deepseek-r1',
  'oxy-llama-70b-n': 'meta/llama-3.3-70b-instruct',
  'oxy-sonar-reasoning': 'sonar-reasoning-pro',
  'oxy-sonar-pro': 'sonar-pro',
  'oxy-sonar': 'sonar',
  'oxy-sonar-deep-research': 'sonar-deep-research',
  'oxy-thinking': 'qwen/qwen3.6-27b',
  // HARDENING (audit lanjutan, MEDIUM-2 -> RESOLVED sesuai keputusan produk): sebelumnya
  // 'openai/gpt-oss-20b' (model text-only, gak ada di VISION_MODELS) -- alias "Oxy Vision" di
  // katalog pembuatan API key jadi janji kosong (kirim gambar lewat key ini SELALU ditolak
  // validateChatBody dengan MODEL_NOT_VISION_CAPABLE). Sekarang dialihkan ke model yang SAMA
  // dipakai 'oxy-thinking' (satu-satunya entri VISION_MODELS saat ini) -- lihat
  // SECURITY-AUDIT.md MEDIUM-2 buat detail & catatan soal dropdown chat utama yang punya
  // mislabeling SERUPA (independen dari alias publik ini, keputusan terpisah).
  'oxy-vision': 'qwen/qwen3.6-27b',
  'oxy-ultra': 'openai/gpt-oss-120b',
  'oxy-expert': 'llama-3.3-70b-versatile',
  'oxy-fast': 'llama-3.1-8b-instant',
};

const VALID_API_KEY_MODEL_IDS = new Set(Object.keys(API_KEY_MODEL_ALIASES));

/** Field yang boleh diteruskan ke upstream provider dari body request client (allowlist). */
const PASSTHROUGH_CHAT_FIELDS = ['temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'stop'];
// reasoning_effort & reasoning_format cuma valid & cuma diteruskan kalau providernya Groq
// (lihat services/chat.service.js) — frontend juga cuma ngirim ini kalau provider===groq.
const GROQ_REASONING_FIELDS = ['reasoning_effort', 'reasoning_format'];

module.exports = {
  SPECTRAX_MODELS,
  OPENROUTER_MODELS,
  NVIDIA_MODELS,
  MISTRAL_MODELS,
  PERPLEXITY_MODELS,
  GROQ_MODELS,
  ALL_KNOWN_MODELS,
  VISION_MODELS,
  API_KEY_MODEL_ALIASES,
  VALID_API_KEY_MODEL_IDS,
  PASSTHROUGH_CHAT_FIELDS,
  GROQ_REASONING_FIELDS,
  resolveProvider,
  resolveUpstreamModel,
};
