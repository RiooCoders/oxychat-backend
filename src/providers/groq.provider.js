'use strict';

const env = require('../config/env');
const { makeOpenAICompatibleProvider } = require('./base');

// https://api.groq.com/openai/v1 — endpoint resmi Groq, OpenAI-compatible.
module.exports = makeOpenAICompatibleProvider({
  name: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: env.providerKeys.groq,
});
