'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const { badGateway, gatewayTimeout, ApiError } = require('../utils/errors');

/**
 * Coba ekstrak message error yang manusiawi dari body error provider (macem-macem bentuknya
 * tiap provider), lalu di-normalize ke bentuk internal kita. Detail mentah provider (yang bisa
 * aja ngandung info gak perlu) sengaja gak diteruskan apa adanya ke client.
 */
function normalizeUpstreamError(status, rawText, providerName) {
  let parsedMessage = '';
  try {
    const parsed = JSON.parse(rawText);
    parsedMessage =
      (parsed.error && (parsed.error.message || parsed.error)) ||
      parsed.message ||
      '';
  } catch (_) {
    // bukan JSON, biarin kosong — jangan bocorin raw HTML/text provider ke client
  }
  const lower = String(parsedMessage).toLowerCase();

  if (status === 401 || status === 403 || lower.includes('authentication') || lower.includes('api key')) {
    return new ApiError(502, 'PROVIDER_AUTH_ERROR', `Provider ${providerName} menolak API key (cek key di .env)`);
  }
  if (status === 404 || lower.includes('does not exist') || lower.includes('not found') || lower.includes('unknown model')) {
    return new ApiError(502, 'PROVIDER_MODEL_UNAVAILABLE', `Model tidak dikenali/tidak tersedia di provider ${providerName}`);
  }
  if (status === 429 || lower.includes('rate limit')) {
    return new ApiError(429, 'PROVIDER_RATE_LIMITED', `Provider ${providerName} lagi rate limit, coba lagi sebentar`);
  }
  if (status === 400 || lower.includes('invalid')) {
    return new ApiError(400, 'PROVIDER_INVALID_REQUEST', parsedMessage || `Request ke provider ${providerName} tidak valid`);
  }
  return badGateway(`Provider ${providerName} sedang tidak tersedia`);
}

/**
 * fetch() ke upstream dengan timeout + hormat abort dari client. `signal` dari client dan
 * timeout internal digabung jadi satu AbortController biar dua-duanya bisa motong request.
 */
async function fetchWithTimeout(url, options, timeoutMs, clientSignal) {
  const controller = new AbortController();
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort();
    // SENGAJA gak di-removeEventListener pas fetch() resolve: fetch() resolve begitu HEADER
    // response upstream nyampe, sedangkan buat request stream, BODY-nya masih terus mengalir
    // setelah itu. Listener ini harus tetap nyala sepanjang hidup response (bukan cuma sampai
    // header nyampe) supaya client disconnect di TENGAH streaming tetap ke-propagate buat
    // motong koneksi ke upstream. `{once:true}` udah cukup buat auto-cleanup begitu abort
    // beneran kejadian, dan clientSignal ini scoped ke 1 request doang (gak dipakai ulang),
    // jadi gak ada resiko listener numpuk/leak lintas request.
    else clientSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  // Timer ini cuma buat batasin waktu SAMPAI dapet response awal (header) dari upstream —
  // begitu header nyampe, response dianggap "hidup" dan boleh terus streaming selama itu
  // (respons AI yang panjang wajar makan waktu lebih dari UPSTREAM_TIMEOUT_MS buat KELAR,
  // yang penting dia gak macet di awal).
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bikin provider OpenAI-compatible generik. Semua provider chat di project ini (Groq, NVIDIA,
 * Mistral, Perplexity, OpenRouter, Gemini) ngomong protokol yang sama persis
 * (POST {baseUrl}/chat/completions, Authorization: Bearer <key>), jadi logic HTTP-nya di-share
 * di sini biar gak dobel-dobel di tiap file provider.
 */
function makeOpenAICompatibleProvider({ name, baseUrl, apiKey, extraHeaders = {} }) {
  return {
    name,
    isAvailable: () => Boolean(apiKey),

    /**
     * @param {{model:string, payload:object, stream:boolean, signal:AbortSignal}} opts
     * @returns {Promise<{stream:true, upstream:Response}|{stream:false, data:object}>}
     */
    async call({ model, payload, stream, signal }) {
      if (!apiKey) {
        throw badGateway(`Provider ${name} belum dikonfigurasi (${name.toUpperCase()}_API_KEY kosong)`);
      }
      const body = { ...payload, model, stream: Boolean(stream) };
      let res;
      try {
        res = await fetchWithTimeout(
          `${baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              ...extraHeaders,
            },
            body: JSON.stringify(body),
          },
          env.upstreamTimeoutMs,
          signal
        );
      } catch (err) {
        if (signal && signal.aborted) throw err; // biarin abort client keluar apa adanya, ditangani di service
        if (err.name === 'AbortError') throw gatewayTimeout(`Provider ${name} timeout`);
        logger.error('provider_network_error', { provider: name, message: err.message });
        throw badGateway(`Gagal menghubungi provider ${name}`);
      }

      if (!res.ok) {
        const rawText = await res.text().catch(() => '');
        logger.warn('provider_error_response', { provider: name, status: res.status });
        throw normalizeUpstreamError(res.status, rawText, name);
      }

      if (stream) return { stream: true, upstream: res };
      const data = await res.json().catch(() => {
        throw badGateway(`Provider ${name} mengembalikan response yang tidak valid`);
      });
      return { stream: false, data };
    },
  };
}

module.exports = { makeOpenAICompatibleProvider, fetchWithTimeout, normalizeUpstreamError };
