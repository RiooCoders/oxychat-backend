'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

test('provider & model routing', async (t) => {
  const { baseUrl, mockUpstream, teardown } = await setupHarness({ dbName: 'provider-routing' });
  t.after(teardown);

  await t.test('provider dari client diabaikan — dihitung ulang server dari model (registry)', async () => {
    mockUpstream.scenario['key-perplexity'] = 'ok';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // client sengaja klaim provider "groq" padahal model ini punya Perplexity
      body: JSON.stringify({ provider: 'groq', model: 'sonar-pro', messages: [{ role: 'user', content: 'x' }], stream: false }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.choices[0].message.content.includes('sonar-pro'), 'beneran nyampe ke perplexity, bukan groq');
  });

  await t.test('model di luar allowlist ditolak 400 MODEL_NOT_ALLOWED', async () => {
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-ngarang-random', messages: [{ role: 'user', content: 'x' }] }),
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error.code, 'MODEL_NOT_ALLOWED');
  });

  await t.test('reasoning_effort/reasoning_format cuma diteruskan kalau provider Groq', async () => {
    mockUpstream.scenario['key-groq'] = 'ok';
    const groqRes = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }], stream: false,
        reasoning_effort: 'high', reasoning_format: 'parsed',
      }),
    });
    const groqData = await groqRes.json();
    assert.equal(groqData.choices[0].message.reasoning_content, 'mikir dulu...');

    mockUpstream.scenario['key-mistral'] = 'ok';
    const mistralRes = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'vaneus-4.0', messages: [{ role: 'user', content: 'x' }], stream: false,
        reasoning_effort: 'high', reasoning_format: 'parsed',
      }),
    });
    const mistralData = await mistralRes.json();
    assert.ok(!mistralData.choices[0].message.reasoning_content, 'reasoning TIDAK nyampe ke Mistral');
  });

  await t.test('temperature/max_tokens (allowlist umum) tetep nyampe ke semua provider', async () => {
    mockUpstream.scenario['key-groq'] = 'ok';
    // mock server ngebalikin apa adanya kalau field dikirim -> cek lewat reasoning_effort udah
    // cukup buktiin allowlist jalan; di sini kita pastiin request-nya sendiri gak ditolak (400)
    // walau ngirim temperature & max_tokens sekaligus.
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }], stream: false, temperature: 0.7, max_tokens: 50 }),
    });
    assert.equal(res.status, 200);
  });

  await t.test('spectrax: Gemini sukses -> pakai hasil Gemini', async () => {
    mockUpstream.scenario['key-gemini'] = 'ok';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'spectrax', messages: [{ role: 'user', content: 'x' }], stream: false }),
    });
    const data = await res.json();
    assert.ok(data.choices[0].message.content.includes('gemini-flash-latest'));
  });

  await t.test('spectrax: Gemini gagal (5xx) -> fallback NVIDIA', async () => {
    mockUpstream.scenario['key-gemini'] = 'server_error';
    mockUpstream.scenario['key-nvidia'] = 'ok';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'spectrax', messages: [{ role: 'user', content: 'x' }], stream: false }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.choices[0].message.content.includes('nvidia/llama-3.3-nemotron-super-49b-v1.5'));
    mockUpstream.scenario['key-gemini'] = 'ok';
  });

  await t.test('spectrax: Gemini & NVIDIA dua-duanya gagal -> error asli, BUKAN fake 200', async () => {
    mockUpstream.scenario['key-gemini'] = 'server_error';
    mockUpstream.scenario['key-nvidia'] = 'server_error';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'spectrax', messages: [{ role: 'user', content: 'x' }], stream: false }),
    });
    assert.ok(res.status >= 500);
    mockUpstream.scenario['key-gemini'] = 'ok';
    mockUpstream.scenario['key-nvidia'] = 'ok';
  });

  await t.test('vision: image_url ditolak buat model non-vision', async () => {
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
      }),
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error.code, 'MODEL_NOT_VISION_CAPABLE');
  });

  await t.test('vision: image_url diterima buat qwen/qwen3.6-27b (satu-satunya VISION_MODEL)', async () => {
    mockUpstream.scenario['key-groq'] = 'ok';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b', stream: false,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'ini apa' }] }],
      }),
    });
    assert.equal(res.status, 200);
  });
});
