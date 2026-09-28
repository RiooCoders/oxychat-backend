'use strict';

const { validateChatBody } = require('../utils/validation');
const { resolveModelRoute } = require('./provider-router.service');
const spectrax = require('./spectrax.service');
const { PASSTHROUGH_CHAT_FIELDS, GROQ_REASONING_FIELDS } = require('../config/models');
const { badGateway } = require('../utils/errors');

/** Ambil cuma field yang di-allowlist dari body client — TIDAK blind pass-through. */
function buildSanitizedPayload(body, providerName) {
  const payload = { messages: body.messages };
  for (const field of PASSTHROUGH_CHAT_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  // reasoning_effort/reasoning_format cuma valid buat Groq (native reasoning surface-nya Groq).
  // Provider lain akan nolak/bingung kalau dikasih field ini, jadi di-filter di sini.
  if (providerName === 'groq') {
    for (const field of GROQ_REASONING_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }
  }
  return payload;
}

/** Jaga-jaga field minimum tetap ada di response non-stream, tanpa menimpa data asli provider. */
function normalizeNonStreamResponse(data, upstreamModel) {
  if (!data || typeof data !== 'object') return data;
  return {
    id: data.id || `chatcmpl-${Date.now().toString(36)}`,
    object: data.object || 'chat.completion',
    created: data.created || Math.floor(Date.now() / 1000),
    model: data.model || upstreamModel,
    choices: data.choices || [],
    usage: data.usage,
  };
}

/**
 * Proses satu request chat lengkap (dipakai baik oleh /api/chat maupun /v1/chat).
 * @param {object} body - body request yang SUDAH divalidasi bentuknya sebelumnya kalau perlu.
 * @param {{signal:AbortSignal, modelAlreadyResolved?:boolean}} opts
 * @returns {Promise<{stream:true, upstream:Response, providerName:string}|{stream:false, data:object, providerName:string}>}
 */
async function handleChat(body, { signal, modelAlreadyResolved = false } = {}) {
  const validated = validateChatBody(body, { modelAlreadyResolved });
  const route = resolveModelRoute(validated.model);
  // PENTING: allowlist dibaca dari `body` ASLI (bukan `validated`), soalnya validateChatBody()
  // cuma balikin {model,messages,stream} — field opsional kayak temperature/reasoning_effort
  // masih ada di `body` mentah, belum ke-strip. `body.messages` sama persis referensinya dengan
  // `validated.messages` (udah lolos validasi), jadi aman dipakai gabungan begini.
  const payload = buildSanitizedPayload(body, route.providerName);

  if (route.providerName === 'spectrax') {
    const result = await spectrax.call({ payload, stream: validated.stream, signal });
    return finalizeResult(result, 'spectrax', validated.model);
  }

  if (!route.provider) {
    throw badGateway(`Tidak ada provider terdaftar untuk model "${validated.model}"`);
  }
  const result = await route.provider.call({ model: route.upstreamModel, payload, stream: validated.stream, signal });
  return finalizeResult(result, route.providerName, route.upstreamModel);
}

function finalizeResult(result, providerName, upstreamModel) {
  if (result.stream) return { stream: true, upstream: result.upstream, providerName };
  return { stream: false, data: normalizeNonStreamResponse(result.data, upstreamModel), providerName };
}

module.exports = { handleChat };
