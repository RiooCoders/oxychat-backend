'use strict';

/** Tanpa ELEVENLABS_API_KEY & GROQ_API_KEY: fitur suara mati dengan sopan (tidak crash, pesan jelas). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');
const { fakeWebm } = require('./helpers/voice-mock');

test('suara: fitur nonaktif kalau key kosong', async (t) => {
  const { baseUrl, teardown } = await setupHarness({
    dbName: 'voice-disabled',
    envOverrides: { ELEVENLABS_API_KEY: '', XI_API_KEY: '', GROQ_API_KEY: '' },
  });
  t.after(teardown);

  await t.test('health menunjukkan suara mati', async () => {
    const data = await (await fetch(`${baseUrl}/`)).json();
    assert.deepEqual(data.voice, { tts: false, stt: false });
  });

  await t.test('GET /api/tts/voices -> 200 available:false (UI bisa menampilkan "belum aktif", bukan error)', async () => {
    const res = await fetch(`${baseUrl}/api/tts/voices`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.available, false);
    assert.equal(data.reason, 'not_configured');
    assert.deepEqual(data.voices, []);
    assert.deepEqual(data.stt, { available: false });
  });

  await t.test('POST /api/tts -> 503 TTS_NOT_CONFIGURED', async () => {
    const res = await fetch(`${baseUrl}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'halo' }) });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'TTS_NOT_CONFIGURED');
  });

  await t.test('POST /api/stt -> 503 STT_NOT_CONFIGURED', async () => {
    const res = await fetch(`${baseUrl}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: fakeWebm() });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'STT_NOT_CONFIGURED');
  });
});
