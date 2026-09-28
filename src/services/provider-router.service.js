'use strict';

const { resolveProvider, resolveUpstreamModel } = require('../config/models');
const groq = require('../providers/groq.provider');
const nvidia = require('../providers/nvidia.provider');
const mistral = require('../providers/mistral.provider');
const perplexity = require('../providers/perplexity.provider');
const openrouter = require('../providers/openrouter.provider');
const { badGateway } = require('../utils/errors');

const PROVIDERS = { groq, nvidia, mistral, perplexity, openrouter };

function resolveModelRoute(model) {
  const providerName = resolveProvider(model);
  if (providerName === 'spectrax') {
    return { providerName, provider: null, upstreamModel: null };
  }
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw badGateway(`Tidak ada provider terdaftar untuk model "${model}"`);
  }
  if (typeof provider.isAvailable === 'function' && !provider.isAvailable()) {
    throw badGateway(
      `Provider \( {providerName} sedang tidak tersedia ( \){providerName.toUpperCase()}_API_KEY kosong/belum di-set di environment)`
    );
  }
  const upstreamModel = resolveUpstreamModel(model);
  return { providerName, provider, upstreamModel };
}

module.exports = { resolveModelRoute, PROVIDERS };
