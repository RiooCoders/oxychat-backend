'use strict';

const env = require('../config/env');
const { makeOpenAICompatibleProvider } = require('./base');

// https://openrouter.ai/api/v1 — OpenAI-compatible. Model publik frontend "openrouter/free"
// (berlabel "Auto Model") di-map ke OPENROUTER_MODEL, default "openrouter/auto" (Auto Router
// resmi OpenRouter yang otomatis milih model terbaik per prompt).
const extraHeaders = {};
if (env.openrouterSiteUrl) extraHeaders['HTTP-Referer'] = env.openrouterSiteUrl;
if (env.openrouterSiteName) extraHeaders['X-Title'] = env.openrouterSiteName;

module.exports = makeOpenAICompatibleProvider({
  name: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: env.providerKeys.openrouter,
  extraHeaders,
});
