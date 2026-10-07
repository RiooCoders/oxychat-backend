'use strict';

const ttsService = require('../services/tts.service');
const sttService = require('../services/stt.service');
const { SPEEDS, LANGUAGES } = require('../config/voice-options');
const { badRequest } = require('../utils/errors');

/** AbortController yang ikut batal kalau klien menutup koneksi sebelum respons selesai (pola sama dgn relay chat). */
function watchDisconnect(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

function fail(err, res, next, controller) {
  if (controller.signal.aborted) return; // klien sudah pergi, gak ada yang perlu dijawab
  if (err && err.retryAfter) res.set('Retry-After', String(err.retryAfter));
  next(err);
}

/** GET /api/tts/voices — daftar suara + opsi bahasa/kecepatan. Bentuk aman ditampilkan langsung ke UI. */
async function getVoices(req, res, next) {
  const controller = watchDisconnect(res);
  try {
    const catalog = await ttsService.getCatalog({ signal: controller.signal });
    if (controller.signal.aborted) return;
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      available: catalog.available,
      ...(catalog.reason ? { reason: catalog.reason } : {}),
      voices: catalog.voices,
      defaultVoiceId: catalog.defaultVoiceId,
      languages: LANGUAGES,
      speeds: SPEEDS.map(({ id, label }) => ({ id, label })),
      stt: { available: sttService.isAvailable() },
    });
  } catch (err) {
    fail(err, res, next, controller);
  }
}

/** POST /api/tts  { text, voiceId?, speed?, language? } -> audio/mpeg */
async function postTts(req, res, next) {
  const controller = watchDisconnect(res);
  try {
    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    const result = await ttsService.synthesize({
      text: body.text,
      voiceId: typeof body.voiceId === 'string' ? body.voiceId : undefined,
      speed: body.speed,
      language: body.language,
      client: { device: req.get('x-device-id') || '', ip: req.ip || '' },
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    res.status(200);
    res.set({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-TTS-Cache': result.cached ? 'HIT' : 'MISS',
    });
    res.send(result.audio);
  } catch (err) {
    fail(err, res, next, controller);
  }
}

/** POST /api/stt?language=id  — body = byte rekaman mentah (audio/webm | audio/mp4 | audio/ogg | ...) -> { text } */
async function postStt(req, res, next) {
  const controller = watchDisconnect(res);
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw badRequest('Rekaman suara kosong (kirim byte audio mentah sebagai body)', 'STT_AUDIO_EMPTY');
    }
    const language = typeof req.query.language === 'string' ? req.query.language : 'auto';
    const result = await sttService.transcribe({ audio: req.body, language, signal: controller.signal });
    if (controller.signal.aborted) return;
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ text: result.text, language: result.language, provider: result.provider });
  } catch (err) {
    fail(err, res, next, controller);
  }
}

module.exports = { getVoices, postTts, postStt };
