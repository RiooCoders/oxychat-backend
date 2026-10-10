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
const webContext = require('./web-context.service');
const { buildPolicyPrompt, resolveTimezone, formatNow } = require('../config/system-policy');

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

/**
 * Gabungin aturan kejujuran ke system message pertama (atau bikin system message baru di paling atas).
 * Digabung jadi SATU system message, bukan dua, karena beberapa provider (mis. Perplexity) rewel soal itu.
 */
function injectSystem(messages, text) {
  if (!text) return messages;
  const copy = messages.slice();
  const first = copy[0];
  if (first && first.role === 'system') {
    if (typeof first.content === 'string') copy[0] = { ...first, content: text + '\n\n' + first.content };
    else if (Array.isArray(first.content)) copy[0] = { ...first, content: [{ type: 'text', text }, ...first.content] };
    else copy[0] = { ...first, content: text };
    return copy;
  }
  return [{ role: 'system', content: text }, ...copy];
}

/** Tempel blok hasil pencarian di pesan user TERAKHIR (copy; riwayat asli di client gak berubah). */
function attachToLastUser(messages, block) {
  if (!block) return messages;
  const copy = messages.slice();
  for (let i = copy.length - 1; i >= 0; i--) {
    const m = copy[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') copy[i] = { ...m, content: m.content + '\n\n' + block };
    else if (Array.isArray(m.content)) copy[i] = { ...m, content: [...m.content, { type: 'text', text: block }] };
    return copy;
  }
  return copy;
}

/**
 * Siapin "grounding" tiap request: aturan jujur/anti-halusinasi + (kalau perlu) hasil pencarian web real-time.
 * GAK PERNAH throw gara-gara pencarian: kalau gagal, lanjut tanpa hasil dan model dikasih catatan sistem
 * supaya dia jujur ke user (bukan ngarang). Cuma abort dari client yang dilempar ulang.
 */
async function prepareGrounding(body, route, { signal, events, surface, clientKey }) {
  const plain = { messages: body.messages, web: null, temperature: body.temperature };
  // Panggilan utilitas internal dari frontend sendiri (judul chat, deskripsi gambar): gak perlu cari/aturan.
  if (surface === 'app' && body.utility === true) return plain;

  const tz = resolveTimezone(body.client_timezone);
  const decision = webContext.decide({
    messages: body.messages,
    webSearch: body.web_search,
    surface,
    providerName: route.providerName,
  });

  let webState = null; // { state, reason, fetchedAtText }
  let block = '';
  let meta = null;
  if (decision.search) {
    if (events && events.status) events.status('searching');
    let ctx;
    try {
      ctx = await webContext.build({ messages: body.messages, signal, tz, clientKey, mode: decision.mode });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      logger.warn('web_context_error', { message: err.message });
      const now = new Date();
      ctx = {
        state: 'failed',
        reason: 'terjadi kesalahan saat mencari',
        block: '',
        fetchedAtText: formatNow(now, tz),
        meta: { state: 'failed', mode: decision.mode, engine: 'duckduckgo', query: '', timeRange: '', relaxed: false, searchedAt: now.toISOString(), reason: 'terjadi kesalahan saat mencari', sources: [] },
      };
    }
    webState = { state: ctx.state, reason: ctx.reason, fetchedAtText: ctx.fetchedAtText };
    block = ctx.block || '';
    meta = ctx.meta;
    if (events && events.web) events.web(meta);
    logger.info('web_grounding', { mode: decision.mode, why: decision.reason, state: ctx.state, sources: meta.sources.length });
  }

  const policyText = buildPolicyPrompt({
    tz,
    citeStyle: surface === 'api' ? 'domain' : 'number',
    core: env.policyEnabled,
    web: webState,
  });
  let messages = injectSystem(body.messages, policyText);
  if (block) messages = attachToLastUser(messages, block);

  // Jawaban yang berpegang pada hasil pencarian: suhu dibatasi biar gak "kreatif" ngarang di luar sumber.
  let temperature = body.temperature;
  if (webState && webState.state === 'used') {
    const cap = env.webSearch.maxTemperature;
    temperature = typeof temperature === 'number' ? Math.min(temperature, cap) : cap;
  }
  return { messages, web: meta, temperature };
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

/**
 * Boleh ganti model kalau pesan ditandai filter keamanan? Frontend sendiri (/api/chat) default AKTIF
 * (bisa dimatiin user lewat Pengaturan > Kemampuan); API key (/v1/chat) default MATI kecuali minta
 * eksplisit lewat body.switch_on_flag = true, supaya perilaku API publik tidak berubah diam-diam.
 */
function resolveSwitchOnFlag(body, surface) {
  if (body.switch_on_flag === true) return true;
  if (body.switch_on_flag === false) return false;
  return surface === 'app';
}

/** Error saat pesan ditandai dan penggantian model dimatikan: obrolan dijeda (bukan dialihkan diam-diam). */
function pausedError(surface) {
  const message =
    surface === 'app'
      ? 'Pesan ini ditandai filter keamanan, jadi obrolan dijeda. Ubah isi pesanmu, atau nyalakan "Ganti model saat pesan ditandai" di Pengaturan > Kemampuan.'
      : 'Pesan ini ditandai filter keamanan provider. Kirim "switch_on_flag": true kalau mau otomatis dialihkan ke model lain.';
  return new ApiError(422, 'CONTENT_FLAGGED', message);
}

/**
 * @param {object} body  body chat OpenAI-compatible (+ field opsional: web_search, client_timezone, utility, switch_on_flag)
 * @param {{signal?:AbortSignal, modelAlreadyResolved?:boolean, events?:{status?:Function, web?:Function},
 *          surface?:'app'|'api', clientKey?:string}} opts
 *   surface 'app' = frontend sendiri (/api/chat): pencarian otomatis (mode auto).
 *   surface 'api' = pemegang API key (/v1/chat): pencarian hanya kalau body.web_search diaktifkan.
 */
async function handleChat(body, { signal, modelAlreadyResolved = false, events, surface = 'app', clientKey } = {}) {
  const validated = validateChatBody(body, { modelAlreadyResolved });
  const keepThinking = wantsThinking(body);
  const route = resolveModelRoute(validated.model);
  const candidates = buildCandidates(route, { hasImage: messagesHaveImage(body.messages) });

  let grounded;
  try {
    grounded = await prepareGrounding(body, route, { signal, events, surface, clientKey });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    // Aturan jujur + pencarian web itu fitur TAMBAHAN: bug tak terduga di dalamnya gak boleh bikin chat gagal.
    // Chat tetap dilayani apa adanya, dan errornya dicatat keras di log supaya cepat ketahuan.
    logger.error('grounding_failed', { message: err.message, stack: err.stack });
    grounded = { messages: body.messages, web: null, temperature: body.temperature };
  }
  const effectiveBody = { ...body, messages: grounded.messages };
  if (grounded.temperature !== undefined) effectiveBody.temperature = grounded.temperature;

  const switchOnFlag = resolveSwitchOnFlag(body, surface);
  let flagged = false; // minimal satu kandidat menandai pesan; kalau kandidat lain berhasil, client dikasih tahu "dialihkan"
  let primaryError = null;
  const attempted = [];
  for (let idx = 0; idx < candidates.length; idx++) {
    const cand = candidates[idx];
    attempted.push(cand);
    try {
      const payload = buildSanitizedPayload(effectiveBody, cand.providerName, cand.upstreamModel);
      const result = cand.call
        ? await cand.call({ payload, stream: validated.stream, signal, switchOnFlag })
        : await cand.provider.call({ model: cand.upstreamModel, payload, stream: validated.stream, signal });
      if (idx > 0) {
        logger.warn('chat_fallback_used', {
          primary: `${candidates[0].providerName}:${candidates[0].upstreamModel}`,
          used: `${cand.providerName}:${cand.upstreamModel}`,
          reason: primaryError && (primaryError.code || primaryError.message),
        });
      }
      return finalizeResult(result, cand.providerName, cand.upstreamModel, keepThinking, grounded.web, flagged);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      logger.warn('chat_candidate_failed', {
        provider: cand.providerName,
        model: cand.upstreamModel,
        code: err.code,
        status: err.status,
        message: err.message,
      });
      const isFlag = err instanceof ApiError && err.code === 'CONTENT_FLAGGED';
      if (isFlag) {
        flagged = true;
        logger.warn('chat_content_flagged', { provider: cand.providerName, model: cand.upstreamModel, switchOnFlag });
        if (!switchOnFlag) throw pausedError(surface); // user matiin ganti-model: obrolan dijeda
      }
      if (idx === 0) {
        primaryError = err;
        if (!isFlag && !isFallbackEligible(err)) throw err; // request-nya emang salah: fallback percuma
      }
    }
  }
  if (primaryError instanceof ApiError && primaryError.code === 'CONTENT_FLAGGED') {
    throw new ApiError(
      422,
      'CONTENT_FLAGGED',
      'Pesan ini ditandai filter keamanan dan tidak ada model cadangan yang bisa melanjutkan. Ubah isi pesanmu lalu kirim lagi.'
    );
  }
  throw finalError(primaryError || badGateway('Tidak ada provider yang tersedia'), attempted);
}

function finalizeResult(result, providerName, upstreamModel, keepThinking, web, flagged = false) {
  // `flagged`: kandidat sebelumnya menandai pesan; `result.switched`: spectrax sudah pindah Gemini -> NVIDIA sendiri.
  const switched = flagged === true || (result && result.switched === true) ? { reason: 'content_flagged' } : null;
  if (result.stream) return { stream: true, upstream: result.upstream, providerName, keepThinking, web, switched };
  const data = normalizeNonStreamResponse(result.data, upstreamModel, keepThinking);
  // Info sumber pencarian / penggantian model ikut di JSON; field tambahan ini diabaikan klien OpenAI-compatible biasa.
  if ((web || switched) && data && typeof data === 'object') {
    data.vaeltrix = {};
    if (web) data.vaeltrix.web = web;
    if (switched) data.vaeltrix.switched = switched;
  }
  return { stream: false, data, providerName, keepThinking, web, switched };
}

module.exports = {
  handleChat,
  buildSanitizedPayload,
  buildCandidates,
  isFallbackEligible,
  injectSystem,
  attachToLastUser,
  resolveSwitchOnFlag,
};
