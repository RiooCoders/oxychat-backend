'use strict';

const express = require('express');
const { getVoices, postTts, postStt } = require('../controllers/voice.controller');
const { createRateLimiter } = require('../middleware/rate-limit');
const env = require('../config/env');

const router = express.Router();
const { tts, stt } = env.voice;

const perIp = (max, message) => createRateLimiter({ windowMs: 60 * 1000, max, keyFn: (req) => req.ip, message });
const perDevice = (max, message) =>
  createRateLimiter({ windowMs: 60 * 1000, max, keyFn: (req) => req.get('x-device-id') || req.ip, message });

const voicesIpLimiter = perIp(60, 'Terlalu banyak permintaan dari alamat ini. Coba sebentar lagi...');
const ttsIpLimiter = perIp(tts.rateLimitPerIpPerMin, 'Terlalu banyak permintaan suara dari alamat ini. Coba sebentar lagi...');
const ttsDeviceLimiter = perDevice(tts.rateLimitPerMin, 'Terlalu banyak permintaan suara. Coba sebentar lagi...');
const sttIpLimiter = perIp(stt.rateLimitPerIpPerMin, 'Terlalu banyak rekaman dari alamat ini. Coba sebentar lagi...');
const sttDeviceLimiter = perDevice(stt.rateLimitPerMin, 'Terlalu banyak rekaman. Coba sebentar lagi...');

router.get('/tts/voices', voicesIpLimiter, getVoices);
router.post('/tts', ttsIpLimiter, ttsDeviceLimiter, postTts);
// Pembatas laju SEBELUM body audio dibaca (supaya banjir upload ditolak sebelum memakan memori).
// type: () => true karena MediaRecorder tiap browser melabeli audionya beda-beda; format asli dicek lewat magic bytes di service.
router.post('/stt', sttIpLimiter, sttDeviceLimiter, express.raw({ type: () => true, limit: stt.maxAudioBytes }), postStt);

module.exports = router;
