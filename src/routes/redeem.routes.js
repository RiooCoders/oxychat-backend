'use strict';

const express = require('express');
const { postRedeem, getPromoFeatured } = require('../controllers/redeem.controller');
const { createRateLimiter } = require('../middleware/rate-limit');
const optionalSupabaseAuth = require('../middleware/optional-supabase-auth');

const router = express.Router();

// Rate limit lebih ketat khusus redeem (proteksi brute-force nebak kode), gabungan IP + device id.
const redeemLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 8,
  keyFn: (req) => `${req.ip}__${req.get('x-device-id') || ''}`,
  message: 'Terlalu banyak percobaan redeem, coba lagi sebentar lagi',
});

// optionalSupabaseAuth: kalau client ngirim Authorization: Bearer <token> valid, req.supabaseUser
// keisi (dipakai redeem.service.js buat kode tipe "plan", yang sekarang WAJIB login — lihat
// SECURITY-AUDIT.md CRITICAL-3). Kode tipe unlock_model/generic tetap jalan tanpa login (kalau
// gak ada header Authorization sama sekali, middleware ini lanjut aja, gak nolak apa pun).
router.post('/redeem', redeemLimiter, optionalSupabaseAuth, postRedeem);
router.get('/promo-featured', getPromoFeatured);

module.exports = router;
