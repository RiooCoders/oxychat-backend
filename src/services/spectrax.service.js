'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const gemini = require('../providers/gemini.provider');
const nvidia = require('../providers/nvidia.provider');
const { ApiError, badGateway } = require('../utils/errors');

// Status yang dianggap "provider/model availability failure" -> layak di-fallback.
// 400 (request invalid) SENGAJA tidak masuk sini: kalau requestnya emang salah, NVIDIA juga
// bakal nolak dengan alasan yang sama, jadi fallback cuma buang-buang waktu & bikin bingung.
const FALLBACK_WORTHY_STATUS = new Set([429, 500, 502, 503, 504]);

function isFallbackWorthy(err) {
  if (!(err instanceof ApiError)) return true; // error tak terduga (network dll) -> aman di-fallback
  return FALLBACK_WORTHY_STATUS.has(err.status);
}

/**
 * "spectrax" = model gabungan (bukan model asli di provider manapun): coba Gemini dulu,
 * kalau gagal karena availability (bukan karena request-nya emang salah), fallback ke NVIDIA.
 * Interface-nya sengaja disamain persis kayak provider biasa (call({payload,stream,signal}))
 * biar chat.service.js bisa perlakukan spectrax sama kayak provider lain.
 */
async function call({ payload, stream, signal }) {
  if (gemini.isAvailable()) {
    try {
      return await gemini.call({ model: env.geminiModel, payload, stream, signal });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (!isFallbackWorthy(err)) throw err;
      logger.warn('spectrax_fallback_to_nvidia', { reason: err.code || err.message });
    }
  } else {
    logger.warn('spectrax_gemini_unavailable_fallback_to_nvidia');
  }

  if (!nvidia.isAvailable()) {
    throw badGateway('Spectrax tidak tersedia: Gemini maupun NVIDIA belum dikonfigurasi');
  }
  return nvidia.call({ model: env.spectraxFallbackModel, payload, stream, signal });
}

module.exports = { call, name: 'spectrax' };
