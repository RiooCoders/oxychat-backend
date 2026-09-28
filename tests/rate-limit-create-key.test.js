'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

// Regression test buat SECURITY-AUDIT.md MEDIUM-4: SEBELUM fix, POST /api/keys cuma dibatasi
// "max 1 key AKTIF per owner" -- itu gak nyegah SPAM PERCOBAAN kalau tiap percobaan ngaku jadi
// device-id/identitas anonim yang BEDA-beda (masing-masing lolos cek count=0 punya sendiri).
test('POST /api/keys: percobaan berulang dengan identitas anonim BEDA-beda tetap kena rate limit', async (t) => {
  const { baseUrl, teardown } = await setupHarness({ dbName: 'keys-create-rate-limit' });
  t.after(teardown);

  const statuses = [];
  for (let i = 0; i < 13; i++) {
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // createdBy BEDA tiap percobaan -- simulasi device-id acak yang gonta-ganti, masing-masing
      // akan lolos limit "1 key aktif per owner" karena masing-masing owner-nya baru & belum
      // punya key sama sekali. Limiter yang diuji di sini keyed IP saja (X-Device-Id sengaja
      // TIDAK dikirim), jadi ini murni ngetes lapis per-IP.
      body: JSON.stringify({ name: 'x', modelId: 'oxy-fast', createdBy: `anon-spam-device-${i}` }),
    });
    statuses.push(res.status);
  }

  assert.ok(statuses.slice(10).every((s) => s === 429), `setelah 10 percobaan, sisanya harus 429 walau createdBy beda-beda tiap kali, dapat: ${statuses}`);
});
