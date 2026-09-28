'use strict';

const crypto = require('node:crypto');

// Base62, biar hasilnya aman dipakai di URL/query string tanpa encoding tambahan.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomBase62(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** ID internal (buat primary key row: api key id, redeem code row id, dst). Bukan secret. */
function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomBase62(10)}`;
}

/**
 * API key publik. Sengaja PANJANG & random murni dari CSPRNG (bukan Math.random, bukan
 * turunan dari email/device id) supaya gak predictable/enumerable. Prefix "oxy_" cuma
 * penanda visual, bukan bagian dari entropy.
 */
function generateApiKey() {
  return `oxy_${randomBase62(40)}`;
}

/**
 * HARDENING (audit lanjutan, HIGH-4): hash satu-arah buat nyimpen API key di database — SETELAH
 * fix ini, key mentah TIDAK PERNAH disimpan lagi (cuma dikembalikan sekali ke client pas dibuat).
 * SHA-256 polos (bukan bcrypt/argon2 /w salt-per-row) sengaja dipilih di sini KARENA beda dari
 * password manusia: `generateApiKey()` di atas menghasilkan >200 bit entropy dari CSPRNG asli,
 * jadi gak butuh proteksi lambat-secara-sengaja terhadap brute-force kamus/tebak-tebakan seperti
 * password — brute-force SHA-256 buat 1 nilai 240-bit spesifik gak feasible apa pun cost
 * function-nya. Ini pola yang sama dipakai layanan lain buat API key (beda dari cara mereka
 * nyimpen password akun).
 */
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Preview aman ditampilkan berkali-kali (list) — 8 char depan + 4 char belakang, BUKAN secret
 * aslinya lagi. Dihitung SEKALI pas key dibuat & disimpan apa adanya (bukan secret, aman plaintext). */
function previewApiKey(key) {
  if (!key || key.length < 14) return '****';
  return key.slice(0, 8) + '\u2026' + key.slice(-4);
}

/** Kode redeem acak (dipakai CLI admin kalau operator gak nentuin kode sendiri). */
function generateRedeemCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa karakter yg gampang ketuker (0/O, 1/I)
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/** ID korelasi per-request (X-Request-Id) — buat nyambungin error yang diliat user/frontend ke log server. */
function generateRequestId() {
  return `req_${Date.now().toString(36)}${randomBase62(8)}`;
}

module.exports = { generateId, generateApiKey, generateRedeemCode, generateRequestId, hashApiKey, previewApiKey };
