'use strict';

const env = require('./env');
const SPECTRAX_MODELS = ['spectrax'];
const OPENROUTER_MODELS = ['openrouter/free'];
const NVIDIA_MODELS = [
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'deepseek-ai/deepseek-r1',
  'meta/llama-3.3-70b-instruct',
];
const MISTRAL_MODELS = ['vaneus-4.0'];
const PERPLEXITY_MODELS = ['sonar-reasoning-pro', 'sonar-pro', 'sonar', 'sonar-deep-research'];
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

const VISION_MODELS = ['qwen/qwen3.6-27b'];

const DEFAULT_UPSTREAM_REMAP = {
  // Groq udah mensunset 2 model llama ini (16 Aug 2026), id publiknya tetap dipakai frontend.
  'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
  // Groq men-deprecate qwen3.6-27b, penggantinya qwen3.8-27b (sama-sama multimodal/vision).
  'qwen/qwen3.6-27b': 'qwen/qwen3.8-27b',
};

// Kalau model Groq kena rate limit / kepanjangan / mati, coba "saudara"-nya dulu (kuota Groq
// dihitung PER MODEL, jadi saudara biasanya masih longgar) baru lari ke OpenRouter.
// Request bergambar (vision) cuma boleh ke model yang support gambar.
const GROQ_SIBLING_FALLBACKS = {
  'openai/gpt-oss-120b': ['openai/gpt-oss-20b'],
  'openai/gpt-oss-20b': ['openai/gpt-oss-120b'],
  'qwen/qwen3.8-27b': ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b'],
  'qwen/qwen3.6-27b': ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'],
};
const GROQ_VISION_UPSTREAM = new Set(['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b']);

// OpenRouter: "openrouter/auto" itu router BERBAYAR (402 kalau saldo kosong). "openrouter/free"
// router khusus model gratis. Dipakai sebagai cadangan terakhir.
const OPENROUTER_FREE_MODEL = 'openrouter/free';

function resolveProvider(model) {
  if (SPECTRAX_MODELS.includes(model)) return 'spectrax';
  if (OPENROUTER_MODELS.includes(model)) return 'openrouter';
  if (NVIDIA_MODELS.includes(model)) return 'nvidia';
  if (MISTRAL_MODELS.includes(model)) return 'mistral';
  if (PERPLEXITY_MODELS.includes(model)) return 'perplexity';
  return 'groq';
}

function resolveUpstreamModel(model) {
  if (env.modelOverrides[model]) return env.modelOverrides[model];
  if (MISTRAL_MODELS.includes(model)) return env.mistralModel;
  if (OPENROUTER_MODELS.includes(model)) return env.openrouterModel;
  if (DEFAULT_UPSTREAM_REMAP[model]) return DEFAULT_UPSTREAM_REMAP[model];
  return model;
}

const API_KEY_MODEL_ALIASES = {
  'auto-model': 'openrouter/free',
  spectrax: 'spectrax',
  'vaneus-4.0': 'vaneus-4.0',
  'vaeltrix-nemotron': 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'vaeltrix-deepseek-r1': 'deepseek-ai/deepseek-r1',
  'vaeltrix-llama-70b-n': 'meta/llama-3.3-70b-instruct',
  'vaeltrix-sonar-reasoning': 'sonar-reasoning-pro',
  'vaeltrix-sonar-pro': 'sonar-pro',
  'vaeltrix-sonar': 'sonar',
  'vaeltrix-sonar-deep-research': 'sonar-deep-research',
  'vaeltrix-thinking': 'qwen/qwen3.6-27b',
  'vaeltrix-vision': 'qwen/qwen3.6-27b',
  'vaeltrix-ultra': 'openai/gpt-oss-120b',
  'vaeltrix-expert': 'llama-3.3-70b-versatile',
  'vaeltrix-fast': 'llama-3.1-8b-instant',
};

const VALID_API_KEY_MODEL_IDS = new Set(Object.keys(API_KEY_MODEL_ALIASES));
const PASSTHROUGH_CHAT_FIELDS = ['temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'stop'];
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
  DEFAULT_UPSTREAM_REMAP,
  GROQ_SIBLING_FALLBACKS,
  GROQ_VISION_UPSTREAM,
  OPENROUTER_FREE_MODEL,
  resolveProvider,
  resolveUpstreamModel,
};
