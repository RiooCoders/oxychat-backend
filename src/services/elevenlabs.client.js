'use strict';

const env = require('../config/env');
const { upstreamRequest } = require('../utils/upstream-http');

/**
 * Satu-satunya tempat API key ElevenLabs dipakai: header `xi-api-key` dari env server.
 * Dipakai bareng oleh TTS (tts.service) dan STT cadangan (stt.service).
 */
function elevenRequest(method, path, { query, json, form, signal, as = 'json', accept, timeoutMs } = {}) {
  const cfg = env.voice.elevenlabs;
  const url = new URL(cfg.baseUrl + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return upstreamRequest({
    url: url.toString(),
    method,
    headers: { 'xi-api-key': cfg.apiKey, Accept: accept || 'application/json' },
    json,
    form,
    signal,
    as,
    timeoutMs: timeoutMs || cfg.timeoutMs,
  });
}

module.exports = { elevenRequest };
