'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

test('/v1/chat: limit per-KEY independen antar key', async (t) => {
  const { baseUrl, mockUpstream, teardown } = await setupHarness({
    dbName: 'rate-limit-perkey',
    envOverrides: { V1_CHAT_RATE_LIMIT_PER_KEY: '3', V1_CHAT_RATE_LIMIT_PER_IP: '1000' },
  });
  t.after(teardown);
  mockUpstream.scenario['key-groq'] = 'ok';

  async function createKey(owner) {
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'k', modelId: 'vaeltrix-fast', createdBy: owner }),
    });
    return (await res.json()).key;
  }
  const keyA = await createKey('owner-ratelimit-a');
  const keyB = await createKey('owner-ratelimit-b');

  const statusesA = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(baseUrl + '/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyA}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: false }),
    });
    statusesA.push(res.status);
  }
  assert.ok(statusesA.includes(429), `key A (limit 3/menit) harus kena 429, dapat: ${statusesA}`);

  const resB = await fetch(baseUrl + '/v1/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyB}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: false }),
  });
  assert.equal(resB.status, 200, 'key B (belum pernah dipake) TIDAK ikut ke-limit gara-gara key A');
});
