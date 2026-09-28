'use strict';

const express = require('express');
const { postPublicChat } = require('../controllers/public.controller');
const apiKeyAuth = require('../middleware/api-key-auth');
const { createRateLimiter } = require('../middleware/rate-limit');
const env = require('../config/env');

const router = express.Router();

// Dua lapis rate limit terpisah (sesuai master prompt): per IP (proteksi umum, jalan bahkan
// sebelum auth) dan per API key (proteksi abuse spesifik-per-key, biar 1 key bocor/disalahgunakan
// gak bisa nyedot kuota provider tanpa batas). Both configurable lewat ENV.
const ipLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: env.v1RateLimitPerIpPerMin,
  keyFn: (req) => req.ip,
  message: 'Terlalu banyak request dari alamat ini, coba lagi sebentar lagi',
});
const keyLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: env.v1RateLimitPerKeyPerMin,
  keyFn: (req) => (req.apiKeyRow ? `key:${req.apiKeyRow.id}` : req.ip),
  message: 'API key ini sudah mencapai batas request per menit',
});

// POST /v1/chat — API publik yang dipakai pemegang API key (lihat contoh curl di halaman
// CreateApikey). Model ditentukan oleh key, bukan oleh body. Urutan: limit per-IP dulu (jalan
// walau belum auth), baru auth, baru limit per-key (butuh req.apiKeyRow dari apiKeyAuth).
router.post('/chat', ipLimiter, apiKeyAuth, keyLimiter, postPublicChat);

module.exports = router;
