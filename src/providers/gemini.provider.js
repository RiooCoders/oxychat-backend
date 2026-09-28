'use strict';

const env = require('../config/env');
const { makeOpenAICompatibleProvider } = require('./base');

// https://generativelanguage.googleapis.com/v1beta/openai — layer OpenAI-compatible resmi
// Gemini. Dipakai internal oleh spectrax.service.js (bukan model yang bisa dipilih langsung
// oleh user, sesuai frontend).
module.exports = makeOpenAICompatibleProvider({
  name: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: env.providerKeys.gemini,
});
