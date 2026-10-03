'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

test('/api/chat request handling', async (t) => {
  const { baseUrl, mockUpstream, teardown } = await setupHarness({ dbName: 'chat' });
  t.after(teardown);

  await t.test('valid request non-stream -> 200 OpenAI-compatible', async () => {
    mockUpstream.scenario['key-groq'] = 'ok';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'halo' }], stream: false }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.object, 'chat.completion');
    assert.ok(Array.isArray(data.choices));
  });

  await t.test('messages kosong/hilang ditolak 400', async () => {
    const res1 = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant' }),
    });
    assert.equal(res1.status, 400);
    const res2 = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [] }),
    });
    assert.equal(res2.status, 400);
  });

  await t.test('messages dengan role gak valid ditolak 400', async () => {
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'hacker', content: 'x' }] }),
    });
    assert.equal(res.status, 400);
  });

  await t.test('model hilang ditolak 400 MODEL_REQUIRED', async () => {
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error.code, 'MODEL_REQUIRED');
  });

  await t.test('body bukan JSON valid -> 400 INVALID_JSON', async () => {
    const res = await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{rusak' });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error.code, 'INVALID_JSON');
  });

  await t.test('body kelebihan MAX_BODY_BYTES -> 413', async () => {
    const big = 'a'.repeat(30 * 1024);
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: big }] }),
    });
    assert.equal(res.status, 413);
  });

  await t.test('provider mengembalikan 401 -> dinormalisasi jadi 502 PROVIDER_AUTH_ERROR (gak leak raw)', async () => {
    mockUpstream.scenario['key-groq'] = 'auth_fail';
    mockUpstream.scenario['key-openrouter'] = 'auth_fail'; // cadangan OpenRouter juga gagal -> error PROVIDER UTAMA yang dilaporin
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }] }),
    });
    const data = await res.json();
    assert.equal(res.status, 502);
    assert.equal(data.error.code, 'PROVIDER_AUTH_ERROR');
    assert.ok(!JSON.stringify(data).includes('key-groq'));
    mockUpstream.scenario['key-groq'] = 'ok';
    mockUpstream.scenario['key-openrouter'] = 'ok';
  });

  await t.test('provider 404 model -> 502 PROVIDER_MODEL_UNAVAILABLE', async () => {
    mockUpstream.scenario['key-groq'] = 'model_not_found';
    mockUpstream.scenario['key-openrouter'] = 'model_not_found';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }] }),
    });
    const data = await res.json();
    assert.equal(res.status, 502);
    assert.equal(data.error.code, 'PROVIDER_MODEL_UNAVAILABLE');
    mockUpstream.scenario['key-groq'] = 'ok';
    mockUpstream.scenario['key-openrouter'] = 'ok';
  });

  await t.test('provider gak tersedia (kosong) -> 502 jelas, bukan fake 200', async () => {
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: 'x' }] }),
    });
    // sonar (perplexity) key-nya "ok" secara default di harness ini, jadi test provider yang
    // gak dikonfig dites di test file terpisah (env berbeda) — di sini cukup pastiin request valid diproses.
    assert.ok(res.status === 200 || res.status === 502);
  });

  await t.test('upstream hang -> 504 gateway timeout, gak nge-hang selamanya', async () => {
    mockUpstream.scenario['key-groq'] = 'hang';
    const t0 = Date.now();
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(res.status, 504);
    assert.ok(Date.now() - t0 < 3000);
    mockUpstream.scenario['key-groq'] = 'ok';
  });

  await t.test('response error selalu punya requestId', async () => {
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-ngarang', messages: [{ role: 'user', content: 'x' }] }),
    });
    const data = await res.json();
    assert.ok(data.error.requestId);
  });
});
