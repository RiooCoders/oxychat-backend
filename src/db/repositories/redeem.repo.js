'use strict';

const { getDb } = require('../database');

function codesTable() {
  return getDb().collection('redeem_codes', { indexed: ['code'] });
}
function redemptionsTable() {
  return getDb().collection('redeem_redemptions', { indexed: ['code', 'deviceId'] });
}

module.exports = {
  /**
   * Bungkus beberapa operasi baca+tulis jadi 1 transaksi atomik (dipakai redeem.service.js
   * buat validate+increment+record redeem code, biar check-then-write-nya gak race).
   * `fn` harus sinkron.
   */
  runTransaction(fn) {
    return getDb().transaction(fn);
  },

  findByCode(code) {
    return codesTable().findOne((r) => r.code === code);
  },
  create(row) {
    return codesTable().insert(row);
  },
  updateByCode(code, patchFn) {
    const row = this.findByCode(code);
    if (!row) return null;
    return codesTable().updateById(row.id, patchFn);
  },
  listAll() {
    return codesTable()
      .findAll()
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  /** Kode aktif yang lagi ditandai admin buat ditampilin di popup promo. Ambil yang terbaru
   * kalau kebetulan ada lebih dari satu (harusnya cuma 1 di satu waktu). */
  findFeatured() {
    const now = Date.now();
    const candidates = codesTable().findAll(
      (r) => r.showPopup && r.active !== false && (!r.expiresAt || r.expiresAt > now)
    );
    candidates.sort((a, b) => b.createdAt - a.createdAt);
    return candidates[0] || null;
  },

  hasDeviceRedeemed(code, deviceId) {
    if (!deviceId) return false;
    return Boolean(redemptionsTable().findById(`${code}__${deviceId}`));
  },
  /**
   * `extra` (opsional): field tambahan buat redemption record ini, dipakai HARDENING (audit
   * lanjutan) buat nyimpen `grantStatus` ('n/a' | 'pending' | 'granted' | 'failed') dan `userId`
   * (Supabase uid, kalau ada — perlu disimpen supaya grant yang gagal bisa di-retry admin tanpa
   * user harus redeem ulang). Default grantStatus 'n/a' kalau gak dispesifikasiin (kode tipe
   * unlock_model/generic memang gak pernah nyentuh Supabase sama sekali).
   */
  recordRedemption(code, deviceId, extra = {}) {
    if (!deviceId) return;
    redemptionsTable().insert({ id: `${code}__${deviceId}`, code, deviceId, redeemedAt: Date.now(), grantStatus: 'n/a', userId: null, ...extra });
  },
  findRedemption(code, deviceId) {
    if (!deviceId) return null;
    return redemptionsTable().findById(`${code}__${deviceId}`);
  },
  /** Dipanggil redeem.service.js SETELAH transaksi utama commit (lihat komentar di sana buat
   * kenapa ini terpisah, BUKAN bagian dari transaksi yang sama) & dipakai `retry-grant` admin. */
  updateRedemptionGrantStatus(code, deviceId, status) {
    if (!deviceId) return null;
    return redemptionsTable().updateById(`${code}__${deviceId}`, (r) => ({ ...r, grantStatus: status, grantStatusUpdatedAt: Date.now() }));
  },
};
