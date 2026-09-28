'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

test('SSE streaming', async (t) => {
  const { baseUrl, mockUpstream, teardown } = await setupHarness({ dbName: 'sse' });
  t.after(teardown);

  await t.test('stream=true -> Content-Type text/event-stream, relay sampai [DONE]', async () => {
    mockUpstream.scenario['key-groq'] = 'ok';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }], stream: true }),
    });
    assert.ok(res.headers.get('content-type').includes('text/event-stream'));
    const text = await res.text();
    assert.ok(text.includes('"content":"Ha"'));
    assert.ok(text.includes('"content":"lo"'));
    assert.ok(text.includes('data: [DONE]'));
  });

  await t.test('client abort (disconnect) motong koneksi ke upstream juga', async () => {
    mockUpstream.scenario['key-groq'] = 'ok';
    const controller = new AbortController();
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }], stream: true }),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mockUpstream.lastRequestByKey['key-groq'].closedEarly, true);
  });

  await t.test('provider gagal di tengah stream -> pesan error dikirim lewat SSE, bukan connection rusak diem-diem', async () => {
    mockUpstream.scenario['key-groq'] = 'fail_midstream';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }], stream: true }),
    });
    assert.equal(res.status, 200); // header udah kekirim duluan sebelum upstream putus
    const text = await res.text();
    assert.ok(text.includes('Halo'), 'chunk yang sempet nyampe tetep ada');
    assert.ok(text.includes('Koneksi ke provider terputus'), 'ada pesan eksplisit soal koneksi putus');
    assert.ok(text.trim().endsWith('data: [DONE]'), 'tetep ditutup rapi dengan [DONE] biar frontend gak nge-hang nunggu lebih lanjut');
    mockUpstream.scenario['key-groq'] = 'ok';
  });
});
