'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

// CATATAN TEKNIS: tiap file test di sini SENGAJA cuma manggil setupHarness() SATU KALI per file.
// src/config/env.js baca process.env cuma sekali di saat pertama kali di-require dalam 1 proses
// (module Node di-cache) — jadi env override BEDA butuh PROSES BEDA (= FILE test terpisah,
// karena `node --test` udah isolasi tiap file test ke proses sendiri-sendiri secara default).
// Itu kenapa skenario limit per-key & per-IP dipisah ke rate-limit-v1-*.test.js, bukan digabung
// jadi beberapa `test()` mandiri dalam 1 file ini.

test('/api/redeem rate limit (8/menit per IP+device)', async (t) => {
  const { baseUrl, teardown } = await setupHarness({ dbName: 'rate-limit-redeem' });
  t.after(teardown);
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(baseUrl + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'ratelimit-dev' },
      body: JSON.stringify({ code: 'GAKADA-' + i }),
    });
    if (res.status === 429) { limited = true; break; }
  }
  assert.ok(limited);
});
