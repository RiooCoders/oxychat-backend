'use strict';

const { validateChatBody } = require('../utils/validation');
const { resolveModelRoute } = require('./provider-router.service');
const spectrax = require('./spectrax.service');
const openrouter = require('../providers/openrouter.provider');
const env = require('../config/env');
const logger = require('../utils/logger');
const {
  PASSTHROUGH_CHAT_FIELDS,
  GROQ_SIBLING_FALLBACKS,
  GROQ_VISION_UPSTREAM,
  OPENROUTER_FREE_MODEL,
} = require('../config/models');
const { wantsThinking, providerReasoningParams } = require('../utils/reasoning');
const { badGateway, ApiError } = require('../utils/errors');

function buildSanitizedPayload(body, providerName, upstreamModel) {
  const payload = { messages: body.messages };
  for (const field of PASSTHROUGH_CHAT_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  // Parameter thinking diterjemahin per provider + model upstream (lihat utils/reasoning.js).
  Object.assign(payload, providerReasoningParams(providerName, upstreamModel, body));
  return payload;
}

function normalizeNonStreamResponse(data, upstreamModel, keepThinking) {
  if (!data || typeof data !== 'object') return data;
  const { sanitizeCompletionPayload } = require('../utils/sanitize-content');
  const cleaned = sanitizeCompletionPayload(data, { keepThinking });
  return {
    id: cleaned.id || `chatcmpl-${Date.now().toString(36)}`,
    object: cleaned.object || 'chat.completion',
    created: cleaned.created || Math.floor(Date.now() / 1000),
    model: cleaned.model || upstreamModel,
    choices: cleaned.choices || [],
    usage: cleaned.usage,
  };
}

function messagesHaveImage(messages) {
  return (
    Array.isArray(messages) &&
    messages.some((m) => m && Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url'))
  );
}

/**
 * Error yang layak dicoba lagi ke kandidat lain: provider/model mati, key ditolak, saldo/kuota habis,
 * rate limit, request kegedean buat model itu, timeout. Request yang emang SALAH (400) gak di-fallback.
 */
const FALLBACK_CODES = new Set([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_MODEL_UNAVAILABLE',
  'PROVIDER_AUTH_ERROR',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_PAYLOAD_TOO_LARGE',
]);

// PROVIDER_TIMEOUT (nunggu sampai UPSTREAM_TIMEOUT_MS) SENGAJA gak masuk: kalau tiap kandidat
// nge-hang 60 detik, user bisa nunggu berlapis-lapis. Gagal-cepat (4xx/5xx) baru di-fallback.
function isFallbackEligible(err) {
  if (!(err instanceof ApiError)) return true; // error jaringan/tak terduga
  if (err.code === 'PROVIDER_TIMEOUT') return false;
  return FALLBACK_CODES.has(err.code) || err.status === 502 || err.status === 503;
}

/**
 * Urutan percobaan: [provider utama] -> [model "saudara" di provider yang sama (khusus Groq)]
 * -> [OpenRouter]. Dulu langsung lompat ke OpenRouter "auto" (berbayar) dan kalau itu gagal,
 * error-nya MENIMPA error asli — makanya user liat "Provider openrouter sedang tidak tersedia"
 * padahal lagi pakai model Groq.
 */
function buildCandidates(route, { hasImage }) {
  const list = [];
  if (route.providerName === 'spectrax') {
    list.push({
      providerName: 'spectrax',
      upstreamModel: null,
      call: (args) => spectrax.call(args),
    });
  } else {
    list.push({ providerName: route.providerName, provider: route.provider, upstreamModel: route.upstreamModel });
    if (route.providerName === 'groq') {
      for (const sib of GROQ_SIBLING_FALLBACKS[route.upstreamModel] || []) {
        if (hasImage && !GROQ_VISION_UPSTREAM.has(sib)) continue;
        list.push({ providerName: 'groq', provider: route.provider, upstreamModel: sib });
      }
    }
  }
  if (openrouter.isAvailable()) {
    const models = route.providerName === 'openrouter'
      ? [route.upstreamModel, OPENROUTER_FREE_MODEL]
      : [env.openrouterModel || OPENROUTER_FREE_MODEL, OPENROUTER_FREE_MODEL];
    const seen = new Set();
    for (const m of models) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      // model utama-nya sendiri udah ada di list[0] kalau primary = openrouter
      if (route.providerName === 'openrouter' && m === route.upstreamModel) continue;
      list.push({ providerName: 'openrouter', provider: openrouter, upstreamModel: m });
    }
  }
  return list;
}

/** Error akhir = error PROVIDER UTAMA (yang relevan buat user), plus catatan kalau cadangan juga gagal. */
function finalError(primaryErr, attempts) {
  if (!(primaryErr instanceof ApiError)) return primaryErr;
  const backups = [...new Set(attempts.slice(1).map((a) => a.providerName))].filter((n) => n !== attempts[0].providerName);
  if (!backups.length) return primaryErr;
  return new ApiError(primaryErr.status, primaryErr.code, `${primaryErr.message} (cadangan ${backups.join(', ')} juga gagal)`);
}

async function handleChat(body, { signal, modelAlreadyResolved = false } = {}) {
  const validated = validateChatBody(body, { modelAlreadyResolved });
  const keepThinking = wantsThinking(body);
  const route = resolveModelRoute(validated.model);
  const candidates = buildCandidates(route, { hasImage: messagesHaveImage(body.messages) });

  let primaryError = null;
  const attempted = [];
  for (let idx = 0; idx < candidates.length; idx++) {
    const cand = candidates[idx];
    attempted.push(cand);
    try {
      const payload = buildSanitizedPayload(body, cand.providerName, cand.upstreamModel);
      const result = cand.call
        ? await cand.call({ payload, stream: validated.stream, signal })
        : await cand.provider.call({ model: cand.upstreamModel, payload, stream: validated.stream, signal });
      if (idx > 0) {
        logger.warn('chat_fallback_used', {
          primary: `${candidates[0].providerName}:${candidates[0].upstreamModel}`,
          used: `${cand.providerName}:${cand.upstreamModel}`,
          reason: primaryError && (primaryError.code || primaryError.message),
        });
      }
      return finalizeResult(result, cand.providerName, cand.upstreamModel, keepThinking);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      logger.warn('chat_candidate_failed', {
        provider: cand.providerName,
        model: cand.upstreamModel,
        code: err.code,
        status: err.status,
        message: err.message,
      });
      if (idx === 0) {
        primaryError = err;
        if (!isFallbackEligible(err)) throw err; // request-nya emang salah: fallback percuma
      }
    }
  }
  throw finalError(primaryError || badGateway('Tidak ada provider yang tersedia'), attempted);
}

function finalizeResult(result, providerName, upstreamModel, keepThinking) {
  if (result.stream) return { stream: true, upstream: result.upstream, providerName, keepThinking };
  return {
    stream: false,
    data: normalizeNonStreamResponse(result.data, upstreamModel, keepThinking),
    providerName,
    keepThinking,
  };
}

module.exports = { handleChat, buildSanitizedPayload, buildCandidates, isFallbackEligible };
