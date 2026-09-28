'use strict';

const { getDb } = require('../database');

function table() {
  // HARDENING (audit lanjutan, HIGH-4): kolom terindeks sekarang "keyHash" (bukan "key" lagi) --
  // key mentah TIDAK disimpan sama sekali buat row BARU. Lihat services/api-key.service.js.
  return getDb().collection('api_keys', { indexed: ['owner', 'keyHash'] });
}

function toArray(owner) {
  return Array.isArray(owner) ? owner.filter(Boolean) : [owner].filter(Boolean);
}

module.exports = {
  /** Bungkus check-then-insert (limit pembuatan key) jadi 1 transaksi atomik — lihat catatan
   * yang sama di redeem.repo.js soal kenapa ini penting biarpun sinkron-single-process. */
  runTransaction(fn) {
    return getDb().transaction(fn);
  },

  create(row) {
    return table().insert(row);
  },
  findById(id) {
    return table().findById(id);
  },
  /** Jalur utama (HARDENING, HIGH-4): cari berdasarkan HASH key, bukan key mentah. */
  findByKeyHash(keyHash) {
    return table().findOne((r) => r.keyHash === keyHash && r.status !== 'revoked');
  },
  /**
   * Fallback TRANSISI SAJA: row lama yang dibuat SEBELUM hardening ini (masih nyimpen `key`
   * plaintext, belum punya `keyHash` sama sekali karena belum sempat dijalanin
   * `scripts/migrate-api-key-hashes.js`). Setelah migrasi dijalankan, setiap row punya `keyHash`
   * dan fallback ini gak pernah kepake lagi (`!r.keyHash` gak pernah true). JANGAN dipakai buat
   * apa pun selain ini.
   */
  findByRawKeyLegacy(key) {
    return table().findOne((r) => !r.keyHash && r.key === key && r.status !== 'revoked');
  },
  /**
   * `owner` boleh 1 string atau array of string (OR match) — dipakai buat dukung 2 bentuk
   * identitas owner sekaligus (mis. UUID Supabase terverifikasi + email lama, lihat
   * services/api-key.service.js) tanpa kehilangan akses ke key yang dibuat sebelum migrasi.
   */
  listByOwner(owner) {
    const owners = toArray(owner);
    return table()
      .findAll((r) => owners.includes(r.owner) && r.status !== 'revoked')
      .sort((a, b) => a.createdAt - b.createdAt);
  },
  countActiveByOwner(owner) {
    return this.listByOwner(owner).length;
  },
  /** Hapus cuma kalau ownernya cocok salah satu kandidat — jangan sampe bisa hapus API key punya orang lain. */
  deleteByIdForOwner(id, owner) {
    const owners = toArray(owner);
    const row = table().findById(id);
    if (!row || !owners.includes(row.owner)) return false;
    return table().deleteById(id);
  },
  touchLastUsed(id) {
    return table().updateById(id, (row) => ({ ...row, lastUsedAt: Date.now() }));
  },
};
