'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const { upstreamRequest, UpstreamError } = require('../utils/upstream-http');
const { ApiError, badRequest } = require('../utils/errors');
const { detectAudioType } = require('../utils/audio-sniff');
const { resolveLanguage } = require('../config/voice-options');
const { elevenRequest } = require('./elevenlabs.client');
const { mapVoiceUpstreamError, isAbortError } = require('./voice-errors');

const cfg = () => env.voice.stt;
const MIN_AUDIO_BYTES = 512;

/** Urutan penyedia STT sesuai STT_PROVIDER + key yang tersedia. */
function providersInOrder() {
  const mode = cfg().provider;
  const list = [];
  if ((mode === 'auto' || mode === 'groq') && env.providerKeys.groq) list.push('groq');
  if ((mode === 'auto' || mode === 'elevenlabs') && env.voice.elevenlabs.apiKey) list.push('elevenlabs');
  return list;
}

function isAvailable() {
  return providersInOrder().length > 0;
}

// Whisper kadang "berhalusinasi" kalimat penutup video saat audionya sepi. Kalau SELURUH hasilnya cuma itu, buang.
const HALLUCINATIONS = new Set([
  'terima kasih telah menonton',
  'terima kasih sudah menonton',
  'terima kasih telah menonton video ini',
  'terima kasih sudah menonton video ini',
  'sampai jumpa di video berikutnya',
  'thanks for watching',
  'thank you for watching',
  'subtitles by the amara org community',
  'subtitle by amara org',
  'subtitles by amara org',
]);

function compareForm(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTranscript(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return HALLUCINATIONS.has(compareForm(t)) ? '' : t;
}

/** verbose_json Whisper: segmen yang diduga bukan ucapan (no_speech_prob tinggi + logprob rendah) dibuang. */
function textFromWhisper(data) {
  const segments = data && Array.isArray(data.segments) ? data.segments : null;
  if (segments && segments.length) {
    const kept = segments.filter((s) => !(Number(s.no_speech_prob) > 0.6 && Number(s.avg_logprob) < -1));
    return cleanTranscript(kept.map((s) => String((s && s.text) || '')).join(' '));
  }
  return cleanTranscript((data && data.text) || '');
}

function buildForm(audio, type, fields) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: type.mime }), `rekaman.${type.ext}`);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, String(v));
  return form;
}

async function transcribeWithGroq({ audio, type, language, signal }) {
  let lastErr;
  for (const model of cfg().groqModels) {
    const form = buildForm(audio, type, {
      model,
      response_format: 'verbose_json',
      temperature: 0,
      language: language !== 'auto' ? language : undefined,
    });
    try {
      const data = await upstreamRequest({
        url: `${cfg().groqBaseUrl}/audio/transcriptions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${env.providerKeys.groq}`, Accept: 'application/json' },
        form,
        signal,
        timeoutMs: cfg().timeoutMs,
        as: 'json',
      });
      return { text: textFromWhisper(data), language: data && typeof data.language === 'string' ? data.language : null, model };
    } catch (err) {
      lastErr = err;
      const modelProblem =
        err instanceof UpstreamError && err.kind === 'http' && [400, 404].includes(err.status) && /model/i.test(`${err.code} ${err.message}`);
      if (modelProblem) {
        logger.warn('stt_groq_model_rejected_trying_next', { model, status: err.status, code: err.code });
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function transcribeWithElevenLabs({ audio, type, language, signal }) {
  const model = env.voice.elevenlabs.sttModel;
  const form = buildForm(audio, type, {
    model_id: model,
    tag_audio_events: 'false', // jangan sisipkan "(tertawa)", "(batuk)" ke teks
    language_code: language !== 'auto' ? language : undefined,
  });
  const data = await elevenRequest('POST', '/v1/speech-to-text', { form, signal, timeoutMs: cfg().timeoutMs, as: 'json' });
  return {
    text: cleanTranscript((data && data.text) || ''),
    language: data && typeof data.language_code === 'string' ? data.language_code : null,
    model,
  };
}

/**
 * Ubah rekaman suara jadi teks.
 * @param {{audio:Buffer, language?:string, signal?:AbortSignal}} p
 * @returns {Promise<{text:string, language:string|null, provider:string}>} text kosong = gak ada ucapan terdeteksi
 */
async function transcribe({ audio, language, signal }) {
  const providers = providersInOrder();
  if (!providers.length) throw new ApiError(503, 'STT_NOT_CONFIGURED', 'Dikte suara belum diaktifkan di server');
  if (!Buffer.isBuffer(audio) || audio.length < MIN_AUDIO_BYTES) throw badRequest('Rekaman suara kosong atau terlalu pendek', 'STT_AUDIO_EMPTY');
  if (audio.length > cfg().maxAudioBytes) throw new ApiError(413, 'STT_AUDIO_TOO_LARGE', 'Rekaman terlalu panjang, coba lebih singkat');
  const type = detectAudioType(audio);
  if (!type) throw new ApiError(415, 'STT_UNSUPPORTED_AUDIO', 'Format rekaman tidak didukung');
  const lang = resolveLanguage(language);
  if (!lang) throw badRequest('Bahasa tidak didukung', 'STT_BAD_LANGUAGE');

  let firstError = null;
  for (const provider of providers) {
    const startedAt = Date.now();
    try {
      const run = provider === 'groq' ? transcribeWithGroq : transcribeWithElevenLabs;
      const r = await run({ audio, type, language: lang, signal });
      logger.info('stt_transcribed', { provider, model: r.model, bytes: audio.length, chars: r.text.length, ms: Date.now() - startedAt });
      return { text: r.text, language: r.language, provider };
    } catch (err) {
      if (isAbortError(err)) throw err;
      const mapped = mapVoiceUpstreamError(err, { scope: 'STT', provider });
      if (!firstError) firstError = mapped;
      logger.warn('stt_provider_failed', { provider, code: mapped.code, status: mapped.status });
    }
  }
  throw firstError;
}

module.exports = { transcribe, isAvailable, _internal: { providersInOrder, textFromWhisper, cleanTranscript } };
