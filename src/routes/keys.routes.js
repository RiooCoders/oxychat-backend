'use strict';

const express = require('express');
const { postCreateKey, getListKeys, deleteKey } = require('../controllers/keys.controller');
const optionalSupabaseAuth = require('../middleware/optional-supabase-auth');
const { createRateLimiter } = require('../middleware/rate-limit');

const router = express.Router();

// HARDENING (audit lanjutan, MEDIUM-4): sebelumnya POST /api/keys CUMA dibatasi lewat
// "max 1 key AKTIF per owner" (env.apiKeyLimitPerOwner, di api-key.service.js) — itu gak
// mencegah SPAM PERCOBAAN pembuatan (tiap device-id/identitas anonim baru selalu lolos count
// check-nya sendiri-sendiri), cuma mencegah 1 identitas yang SAMA numpuk banyak key aktif.
// Limiter ini nutup itu: batasi LAJU percobaan per IP+device, terlepas dari identitas mana
// yang diklaim tiap percobaan.
const createKeyLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  keyFn: (req) => `${req.ip}__${req.get('x-device-id') || ''}`,
  message: 'Terlalu banyak percobaan bikin API key, coba lagi sebentar lagi',
});

// optionalSupabaseAuth: kalau client ngirim Authorization: Bearer <supabase_access_token>,
// verifikasi & pakai identitas itu (req.supabaseUser). Kalau gak ada header sama sekali,
// tetep lanjut sebagai anonim (createdBy/device-id) — lihat api-key.service.js.
router.post('/keys', createKeyLimiter, optionalSupabaseAuth, postCreateKey);
router.get('/keys', optionalSupabaseAuth, getListKeys);
router.delete('/keys/:id', optionalSupabaseAuth, deleteKey);

module.exports = router;
