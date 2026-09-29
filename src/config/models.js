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
  'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
};

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
  resolveProvider,
  resolveUpstreamModel,
};
