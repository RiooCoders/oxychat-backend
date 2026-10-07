'use strict';

const { ApiError } = require('../utils/errors');
const logger = require('../utils/logger');

/** Error yang artinya akun/key ElevenLabs-nya yang bermasalah (bukan request ini): perlu tindakan operator, jangan diulang-ulang. */
const ACCOUNT_LEVEL_CODES = new Set(['FREE_TIER_BLOCKED', 'QUOTA_EXCEEDED', 'NOT_CONFIGURED', 'KEY_PERMISSION']);

function isAbortError(err) {
  return Boolean(err) && err.name === 'UpstreamError' && err.kind === 'aborted';
}

function withRetryAfter(apiErr, retryAfter) {
  const n = parseInt(retryAfter, 10);
  if (Number.isFinite(n) && n > 0) apiErr.retryAfter = Math.min(n, 120);
  return apiErr;
}

/**
 * Terjemahkan UpstreamError (ElevenLabs / Groq) jadi ApiError berpesan Indonesia yang aman ditampilkan ke user.
 * scope: 'TTS' | 'STT' (jadi prefix kode error). Detail mentah dari upstream cuma masuk LOG server, tidak ke klien.
 */
function mapVoiceUpstreamError(err, { scope, provider }) {
  if (err instanceof ApiError) return err;
  const P = scope;
  const noun = scope === 'TTS' ? 'suara' : 'dikte';

  if (!err || err.name !== 'UpstreamError') {
    logger.error(`${scope.toLowerCase()}_unexpected_error`, { message: err && err.message, stack: err && err.stack });
    return new ApiError(500, `${P}_INTERNAL_ERROR`, `Layanan ${noun} mengalami kesalahan internal`);
  }
  if (err.kind === 'timeout') return new ApiError(504, `${P}_TIMEOUT`, `Layanan ${noun} terlalu lama merespons, coba lagi`);
  if (err.kind === 'network') return new ApiError(502, `${P}_UNREACHABLE`, `Gak bisa terhubung ke layanan ${noun}, coba lagi`);
  if (err.kind === 'aborted') return new ApiError(499, `${P}_ABORTED`, 'Dibatalkan');

  const status = err.status;
  const code = String(err.code || '').toLowerCase();
  const text = `${code} ${String(err.message || '').toLowerCase()}`;
  const logMeta = { provider, status, code: err.code, message: String(err.message || '').slice(0, 200) };

  if (status === 401 || status === 403) {
    if (/unusual_activity/.test(text)) {
      logger.error(`${scope.toLowerCase()}_free_tier_blocked`, {
        ...logMeta,
        note: 'ElevenLabs memblokir akun GRATIS yang dipakai dari IP datacenter/proxy/VPN (anti-abuse). Solusi: pakai paket berbayar ElevenLabs (mulai Starter).',
      });
      return new ApiError(503, `${P}_FREE_TIER_BLOCKED`, 'Suara belum bisa dipakai: ElevenLabs memblokir akun gratis dari server ini');
    }
    if (/quota/.test(text)) {
      logger.error(`${scope.toLowerCase()}_quota_exceeded`, logMeta);
      return new ApiError(503, `${P}_QUOTA_EXCEEDED`, `Kuota ${noun} bulan ini sudah habis`);
    }
    if (/permission/.test(text)) {
      logger.error(`${scope.toLowerCase()}_key_permission`, { ...logMeta, note: 'API key dibatasi izinnya; aktifkan izin Text to Speech / Speech to Text di dashboard.' });
      return new ApiError(503, `${P}_KEY_PERMISSION`, `API key layanan ${noun} di server belum punya izin yang cukup`);
    }
    logger.error(`${scope.toLowerCase()}_auth_failed`, logMeta);
    return new ApiError(503, `${P}_NOT_CONFIGURED`, `API key layanan ${noun} di server tidak valid`);
  }
  if (status === 402) {
    logger.warn(`${scope.toLowerCase()}_paid_required`, logMeta);
    return new ApiError(502, `${P}_PAID_REQUIRED`, scope === 'TTS' ? 'Suara ini butuh paket ElevenLabs berbayar' : 'Layanan dikte butuh paket berbayar');
  }
  if (status === 404) {
    logger.warn(`${scope.toLowerCase()}_not_found`, logMeta);
    return scope === 'TTS'
      ? new ApiError(502, 'TTS_VOICE_NOT_FOUND', 'Suara ini sudah tidak tersedia, pilih suara lain')
      : new ApiError(502, 'STT_UPSTREAM_ERROR', 'Layanan dikte sedang bermasalah, coba lagi nanti');
  }
  if (status === 413) return new ApiError(413, 'STT_AUDIO_TOO_LARGE', 'Rekaman terlalu panjang, coba lebih singkat');
  if (status === 429) {
    logger.warn(`${scope.toLowerCase()}_upstream_rate_limited`, logMeta);
    return withRetryAfter(new ApiError(429, `${P}_RATE_LIMITED`, `Layanan ${noun} lagi penuh, coba lagi sebentar`), err.retryAfter);
  }
  if (status === 400 || status === 422) {
    logger.warn(`${scope.toLowerCase()}_bad_request`, logMeta);
    return scope === 'TTS'
      ? new ApiError(502, 'TTS_BAD_REQUEST', 'Layanan suara menolak permintaan ini')
      : new ApiError(422, 'STT_AUDIO_UNPROCESSABLE', 'Rekaman suara gak bisa diproses, coba rekam ulang');
  }
  logger.warn(`${scope.toLowerCase()}_upstream_error`, logMeta);
  return new ApiError(502, `${P}_UPSTREAM_ERROR`, `Layanan ${noun} sedang bermasalah, coba lagi nanti`);
}

/** Kode tanpa prefix (mis. 'TTS_QUOTA_EXCEEDED' -> 'QUOTA_EXCEEDED') buat cek apakah ini error level-akun. */
function isAccountLevelError(apiErr) {
  if (!(apiErr instanceof ApiError)) return false;
  return ACCOUNT_LEVEL_CODES.has(String(apiErr.code).replace(/^(TTS|STT)_/, ''));
}

module.exports = { mapVoiceUpstreamError, isAbortError, isAccountLevelError };
