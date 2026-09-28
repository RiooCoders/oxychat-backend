'use strict';

const { resolveProvider, resolveUpstreamModel } = require('../config/models');
const groq = require('../providers/groq.provider');
const nvidia = require('../providers/nvidia.provider');
const mistral = require('../providers/mistral.provider');
const perplexity = require('../providers/perplexity.provider');
const openrouter = require('../providers/openrouter.provider');

const PROVIDERS = { groq, nvidia, mistral, perplexity, openrouter };

/**
 * Model publik (dikirim frontend, mis. "vaneus-4.0", "sonar-pro", "spectrax") -> provider module
 * yang harus menanganinya + model asli yang dikirim ke upstream.
 * Untuk "spectrax", provider di sini sengaja null — ditangani terpisah oleh spectrax.service.js
 * (karena butuh logic fallback Gemini -> NVIDIA, bukan satu provider tunggal).
 */
function resolveModelRoute(model) {
  const providerName = resolveProvider(model);
  if (providerName === 'spectrax') return { providerName, provider: null, upstreamModel: null };
  const provider = PROVIDERS[providerName];
  const upstreamModel = resolveUpstreamModel(model);
  return { providerName, provider, upstreamModel };
}

module.exports = { resolveModelRoute, PROVIDERS };
