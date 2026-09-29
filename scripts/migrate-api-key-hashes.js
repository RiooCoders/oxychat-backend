'use strict';

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
