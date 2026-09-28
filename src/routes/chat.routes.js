'use strict';

const express = require('express');
const { postChat } = require('../controllers/chat.controller');
const { createRateLimiter } = require('../middleware/rate-limit');
const env = require('../config/env');

const router = express.Router();

// Proteksi abuse infrastruktur KHUSUS /api/chat (BUKAN product message-limit — itu sudah
// ditangani frontend sendiri, lihat MSG_LIMIT_WINDOW_MS di chat/js/01-config-provider.js).
// Dipasang di sini (bukan di app.js dengan prefix "/api" umum) biar scope-nya jelas cuma
// ngenain /api/chat, gak nyampur ke /api/keys atau /api/redeem yang punya limiter sendiri.
//
// HARDENING (audit lanjutan, lihat SECURITY-AUDIT.md HIGH-4): SEBELUM fix ini, cuma ada 1
// limiter yang key-nya "x-device-id || req.ip" — karena X-Device-Id dikirim mentah oleh
// client dan tidak diverifikasi apa pun, siapa pun bisa kirim header X-Device-Id BARU
// (acak/berbeda) di TIAP request dan dapat bucket rate-limit baru tiap kali, otomatis
// melewati limit sepenuhnya. Fix: tambah lapis KEDUA yang WAJIB dan dikunci ke req.ip SAJA
// (tidak pernah baca header dari client), persis pola yang sudah dipakai /v1/chat di
// public.routes.js. Lapis device-id/IP yang lama TETAP dipertahankan (masih berguna buat
// membedakan banyak user asli di belakang 1 IP/NAT yang sama), tapi sekarang tidak lagi
// jadi satu-satunya proteksi.
const chatIpLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: env.chatRateLimitPerIpPerMin,
  keyFn: (req) => req.ip,
  message: 'Terlalu banyak request dari alamat ini, coba lagi sebentar lagi',
});
const chatAbuseLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: env.chatRateLimitPerMin,
  keyFn: (req) => req.get('x-device-id') || req.ip,
  message: 'Terlalu banyak request, coba lagi sebentar lagi',
});

// POST /api/chat — endpoint utama, dipanggil frontend lewat callOxyAPI() di 01-config-provider.js
// Urutan: limiter per-IP (gak bisa dilewati header) dulu, baru limiter device-id/IP lama.
router.post('/chat', chatIpLimiter, chatAbuseLimiter, postChat);

module.exports = router;
