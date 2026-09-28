'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

// Regression test buat SECURITY-AUDIT.md HIGH-4: SEBELUM fix, limiter /api/chat dikunci ke
// "x-device-id || req.ip", jadi client yang kirim X-Device-Id BEDA tiap request dapat bucket
// rate-limit baru tiap kali dan melewati limit sepenuhnya. Sekarang ada lapis kedua yang wajib
// dan dikunci ke req.ip SAJA (tidak baca header apa pun) — jadi gonta-ganti device-id tidak lagi
// membantu, sesuai pola yang sama yang sudah dites di rate-limit-v1-per-ip.test.js.
test('/api/chat: limit per-IP tetap jalan walau X-Device-Id diganti tiap request', async (t) => {
  const { baseUrl, teardown } = await setupHarness({
    dbName: 'rate-limit-chat-ip',
    // CHAT_RATE_LIMIT_PER_MIN dibikin sangat longgar biar limiter device-id/IP lama TIDAK
    // pernah kena duluan — supaya test ini murni ngebuktiin lapis per-IP yang baru.
    envOverrides: { CHAT_RATE_LIMIT_PER_MIN: '1000', CHAT_RATE_LIMIT_PER_IP: '5' },
  });
  t.after(teardown);

  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Device id BEDA tiap request (simulasi client yang gonta-ganti buat lolos limit lama).
        'X-Device-Id': `spoofed-device-${i}`,
      },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }], stream: false }),
    });
    statuses.push(res.status);
  }

  assert.ok(
    statuses.slice(5).every((s) => s === 429),
    `setelah limit per-IP (5) abis, sisanya harus 429 walau device-id beda-beda, dapat: ${statuses}`
  );
});

test('/api/chat: device-id konsisten tetap dibatasi lapis lama (regresi, bukan cuma lapis IP)', async (t) => {
  const { baseUrl, teardown } = await setupHarness({
    dbName: 'rate-limit-chat-device',
    // Lapis IP dibikin longgar, lapis device-id/IP lama yang diketatin -- buktiin lapis lama
    // masih berfungsi normal buat 1 device yang konsisten (tidak ke-regresi oleh fix ini).
    envOverrides: { CHAT_RATE_LIMIT_PER_IP: '1000', CHAT_RATE_LIMIT_PER_MIN: '3' },
  });
  t.after(teardown);

  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'device-konsisten' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }], stream: false }),
    });
    statuses.push(res.status);
  }

  assert.ok(
    statuses.slice(3).every((s) => s === 429),
    `device konsisten harus tetap kena limit lama (3) setelah fix, dapat: ${statuses}`
  );
});
