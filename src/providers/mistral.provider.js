'use strict';

const env = require('../config/env');
const { makeOpenAICompatibleProvider } = require('./base');

// https://api.mistral.ai/v1 — endpoint resmi Mistral, OpenAI-compatible.
// Model publik frontend "vaneus-4.0" di-map ke MISTRAL_MODEL (lihat config/models.js).
module.exports = makeOpenAICompatibleProvider({
  name: 'mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  apiKey: env.providerKeys.mistral,
});
