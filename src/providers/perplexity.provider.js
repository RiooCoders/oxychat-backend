'use strict';

const env = require('../config/env');
const { makeOpenAICompatibleProvider } = require('./base');

// https://api.perplexity.ai — endpoint resmi Perplexity (Sonar), OpenAI-compatible.
module.exports = makeOpenAICompatibleProvider({
  name: 'perplexity',
  baseUrl: 'https://api.perplexity.ai',
  apiKey: env.providerKeys.perplexity,
});
