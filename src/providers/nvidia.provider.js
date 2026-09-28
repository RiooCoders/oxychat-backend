'use strict';

const env = require('../config/env');
const { makeOpenAICompatibleProvider } = require('./base');

// https://integrate.api.nvidia.com/v1 — NVIDIA NIM (build.nvidia.com), OpenAI-compatible.
module.exports = makeOpenAICompatibleProvider({
  name: 'nvidia',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiKey: env.providerKeys.nvidia,
});
