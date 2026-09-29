'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

test('/v1/chat: limit per-IP jalan bahkan buat percobaan auth yang gagal', async (t) => {
  const { baseUrl, teardown } = await setupHarness({
    dbName: 'rate-limit-perip',
    envOverrides: { V1_CHAT_RATE_LIMIT_PER_KEY: '1000', V1_CHAT_RATE_LIMIT_PER_IP: '5' },
  });
  t.after(teardown);

  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(baseUrl + '/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer vaeltrix_salah_banget_tokennya' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: false }),
    });
    statuses.push(res.status);
  }
  assert.ok(statuses.slice(0, 5).every((s) => s === 401), `5 percobaan pertama gagal auth (401) dulu, dapat: ${statuses}`);
  assert.ok(statuses.slice(5).every((s) => s === 429), `setelah limit IP (5) abis, sisanya 429, dapat: ${statuses}`);
});
