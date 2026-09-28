#!/usr/bin/env node
'use strict';

/**
 * Migrasi HIGH-4 (audit lanjutan): API key yang sebelumnya disimpan APA ADANYA (field `key`,
 * plaintext) diubah jadi `keyHash` (SHA-256) + `keyPreview` (8 char depan + 4 char belakang —
 * SUDAH aman ditampilkan berkali-kali, beda dari key aslinya). Setelah migrasi, field `key`
 * (plaintext) DIHAPUS SAMA SEKALI dari row-nya — kalau file database ini bocor, secret API key
 * TIDAK bisa dipakai langsung lagi (harus di-brute-force dari hash — lihat utils/id.js buat
 * kenapa itu gak feasible untuk key yang di-generate acak >200 bit).
 *
 * AMAN dijalankan berkali-kali (idempotent) — row yang udah punya `keyHash` dilewatin begitu aja.
 *
 * KAPAN JALANIN INI: SEKALI, SEBELUM (atau bersamaan dengan) deploy versi backend yang sudah
 * pakai kode keyHash ini. Backend versi baru TETAP bisa auth key lama yang belum sempat
 * dimigrasi (lihat apikey.repo.js findByRawKeyLegacy — fallback transisi), jadi urutan persis
 * "sebelum vs sesudah" gak fatal, tapi lebih baik dijalankan secepatnya biar semua key konsisten
 * ke bentuk hash & fallback transisi itu gak perlu dipertahankan lama-lama.
 *
 * Pemakaian: node scripts/migrate-api-key-hashes.js
 */

const { getDb } = require('../src/db/database');
const { hashApiKey, previewApiKey } = require('../src/utils/id');

function run() {
  const db = getDb();

  // Pastiin tabel ada dulu (no-op kalau udah ada) sebelum coba nambah kolom baru ke dalamnya.
  db.collection('api_keys', { indexed: ['owner'] });
  db.ensureColumn('api_keys', 'keyHash');
  db.ensureColumn('api_keys', 'keyPreview');

  const table = db.collection('api_keys', { indexed: ['owner', 'keyHash'] });
  const rows = table.findAll();

  let migrated = 0;
  let alreadyDone = 0;
  let skippedNoKey = 0;

  for (const row of rows) {
    if (row.keyHash) {
      alreadyDone++;
      continue;
    }
    if (!row.key) {
      // Row aneh (gak ada key plaintext ATAU keyHash) — di luar cakupan migrasi ini, lewatin
      // daripada nebak-nebak.
      skippedNoKey++;
      continue;
    }
    const keyHash = hashApiKey(row.key);
    const keyPreview = previewApiKey(row.key);
    table.updateById(row.id, (r) => {
      const { key, ...rest } = r; // buang field `key` (plaintext) SAMA SEKALI dari row ini
      return { ...rest, keyHash, keyPreview };
    });
    migrated++;
  }

  console.log(
    `Selesai. ${migrated} key dimigrasi ke keyHash, ${alreadyDone} udah pernah dimigrasi sebelumnya, ` +
      `${skippedNoKey} dilewatin (gak ada key/keyHash sama sekali), total ${rows.length} row diperiksa.`
  );
  db.close();
}

run();
