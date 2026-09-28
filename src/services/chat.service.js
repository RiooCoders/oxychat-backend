'use strict';

const { validateChatBody } = require('../utils/validation');
const { resolveModelRoute } = require('./provider-router.service');
const spectrax = require('./spectrax.service');
const openrouter = require('../providers/openrouter.provider');
const env = require('../config/env');
const logger = require('../utils/logger');
const { PASSTHROUGH_CHAT_FIELDS, GROQ_REASONING_FIELDS } = require('../config/models');
const { badGateway, ApiError } = require('../utils/errors');

function buildSanitizedPayload(body, providerName) {
  const payload = { messages: body.messages };
  for (const field of PASSTHROUGH_CHAT_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (providerName === 'groq') {
    for (const field of GROQ_REASONING_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }
  }
  return payload;
}

function normalizeNonStreamResponse(data, upstreamModel) {
  if (!data || typeof data !== 'object') return data;
  const { sanitizeCompletionPayload } = require('../utils/sanitize-content');
  const cleaned = sanitizeCompletionPayload(data);
  return {
    id: cleaned.id || `chatcmpl-${Date.now().toString(36)}`,
    object: cleaned.object || 'chat.completion',
    created: cleaned.created || Math.floor(Date.now() / 1000),
    model: cleaned.model || upstreamModel,
    choices: cleaned.choices || [],
    usage: cleaned.usage,
  };
}

/**
 * FIX: kalau Groq/NVIDIA gagal karena model/key availability, fallback ke OpenRouter
 * (yang di server lo sudah terbukti jalan) supaya chat gak mati total.
 * Hanya untuk error availability — request invalid tetap dilempar apa adanya.
 */
function isAvailabilityFailure(err) {
  if (!(err instanceof ApiError)) return true;
  return (
    err.status === 502 ||
    err.status === 503 ||
    err.code === 'PROVIDER_UNAVAILABLE' ||
    err.code === 'PROVIDER_MODEL_UNAVAILABLE' ||
    err.code === 'PROVIDER_AUTH_ERROR'
  );
}

async function tryOpenRouterFallback({ payload, stream, signal, reason }) {
  if (!openrouter.isAvailable()) return null;
  logger.warn('chat_fallback_to_openrouter', { reason });
  const model = env.openrouterModel || 'openrouter/auto';
  return openrouter.call({ model, payload, stream, signal });
}

async function handleChat(body, { signal, modelAlreadyResolved = false } = {}) {
  const validated = validateChatBody(body, { modelAlreadyResolved });
  const route = resolveModelRoute(validated.model);
  const payload = buildSanitizedPayload(body, route.providerName);

  if (route.providerName === 'spectrax') {
    try {
      const result = await spectrax.call({ payload, stream: validated.stream, signal });
      return finalizeResult(result, 'spectrax', validated.model);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (!isAvailabilityFailure(err)) throw err;
      const fb = await tryOpenRouterFallback({
        payload,
        stream: validated.stream,
        signal,
        reason: err.code || err.message,
      });
      if (!fb) throw err;
      return finalizeResult(fb, 'openrouter', env.openrouterModel);
    }
  }

  if (!route.provider) {
    throw badGateway(`Tidak ada provider terdaftar untuk model "${validated.model}"`);
  }

  try {
    const result = await route.provider.call({
      model: route.upstreamModel,
      payload,
      stream: validated.stream,
      signal,
    });
    return finalizeResult(result, route.providerName, route.upstreamModel);
  } catch (err) {
    if (signal && signal.aborted) throw err;
    // Fallback cuma buat provider non-openrouter (hindari loop)
    if (route.providerName === 'openrouter' || !isAvailabilityFailure(err)) throw err;
    const fb = await tryOpenRouterFallback({
      payload,
      stream: validated.stream,
      signal,
      reason: `${route.providerName}:${err.code || err.message}`,
    });
    if (!fb) throw err;
    return finalizeResult(fb, 'openrouter', env.openrouterModel);
  }
}

function finalizeResult(result, providerName, upstreamModel) {
  if (result.stream) return { stream: true, upstream: result.upstream, providerName };
  return {
    stream: false,
    data: normalizeNonStreamResponse(result.data, upstreamModel),
    providerName,
  };
}

module.exports = { handleChat };
