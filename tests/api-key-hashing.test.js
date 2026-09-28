'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

// Regression test buat SECURITY-AUDIT.md HIGH-5: SEBELUM fix, API key disimpan APA ADANYA
// (field `key`, plaintext) di database — kalau file database-nya bocor, semua secret key
// langsung kepake. Sekarang cuma `keyHash` (SHA-256) + `keyPreview` (aman ditampilkan) yang
// disimpan; key mentah cuma ada sebentar di response `POST /api/keys` (sekali, pas dibuat).
test('HIGH-5: API key disimpan sebagai hash, bukan plaintext lagi', async (t) => {
  const { baseUrl, teardown } = await setupHarness({ dbName: 'api-key-hashing' });
  t.after(teardown);

  const created = await (
    await fetch(baseUrl + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Key Hash Test', modelId: 'oxy-fast', createdBy: 'anon-hash-test-device' }),
    })
  ).json();
  assert.ok(created.key.startsWith('oxy_'));

  const apiKeyRepo = require('../src/db/repositories/apikey.repo');
  const stored = apiKeyRepo.listByOwner('anon-hash-test-device')[0];
  assert.equal(stored.key, undefined, 'field `key` (plaintext) TIDAK BOLEH ada lagi di storage');
  assert.match(stored.keyHash, /^[a-f0-9]{64}$/, 'keyHash harus hex SHA-256 (64 karakter)');
  assert.notEqual(stored.keyHash, created.key, 'keyHash bukan key mentah yang cuma di-encode ulang');
  assert.equal(stored.keyPreview, created.key.slice(0, 8) + '\u2026' + created.key.slice(-4));

  await t.test('key yang baru dibuat (hash) tetap bisa dipakai auth /v1/chat', async () => {
    const res = await fetch(baseUrl + '/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + created.key },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'halo' }], stream: false }),
    });
    assert.notEqual(res.status, 401, 'key yang baru dibuat harus lolos auth (bukan dianggap invalid)');
  });

  await t.test('key acak/salah tetap ditolak 401 seperti biasa', async () => {
    const res = await fetch(baseUrl + '/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer oxy_bukan-key-asli-sama-sekali' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'halo' }], stream: false }),
    });
    assert.equal(res.status, 401);
  });
});

// Regression test transisi: row yang dibuat SEBELUM hardening ini (plaintext, belum sempat
// dimigrasi lewat scripts/migrate-api-key-hashes.js) harus TETAP bisa auth — bukan "hilang"
// mendadak begitu backend baru di-deploy sebelum migrasi sempat dijalankan.
test('HIGH-5: key lama (plaintext, belum dimigrasi) tetap bisa auth lewat fallback transisi', async (t) => {
  const { baseUrl, teardown } = await setupHarness({ dbName: 'api-key-hashing-legacy' });
  t.after(teardown);

  const apiKeyRepo = require('../src/db/repositories/apikey.repo');
  const { generateId, generateApiKey } = require('../src/utils/id');
  const legacyKey = generateApiKey();
  apiKeyRepo.create({
    id: generateId('key'), name: 'Key Lama Belum Migrasi', modelId: 'oxy-fast',
    owner: 'anon-legacy-device', key: legacyKey, status: 'active', createdAt: Date.now(), lastUsedAt: null,
  });

  const res = await fetch(baseUrl + '/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + legacyKey },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'halo' }], stream: false }),
  });
  assert.notEqual(res.status, 401, 'key lama (plaintext, belum dimigrasi) harus tetap lolos auth lewat fallback, gak boleh mendadak invalid');

  // Listing tetap nampilin preview yang masuk akal (fallback derive-on-the-fly), bukan "undefined".
  const list = await (await fetch(baseUrl + '/api/keys?createdBy=anon-legacy-device')).json();
  const row = list.find((k) => k.name === 'Key Lama Belum Migrasi');
  assert.ok(row, 'key lama harus tetap muncul di listing');
  assert.equal(row.keyPreview, legacyKey.slice(0, 8) + '\u2026' + legacyKey.slice(-4));
});
