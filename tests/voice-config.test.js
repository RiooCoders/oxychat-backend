'use strict';

/**
 * Skenario konfigurasi fitur suara: API key dibatasi izinnya, operator menentukan suara sendiri,
 * key salah, akun gratis diblokir saat mengambil daftar suara.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');
const { createVoiceMock } = require('./helpers/voice-mock');

test('suara: skenario konfigurasi', async (t) => {
  const mock = createVoiceMock();
  await mock.listen();
  const base = `http://127.0.0.1:${mock.port}`;
  const { baseUrl, teardown } = await setupHarness({
    dbName: 'voice-config',
    envOverrides: {
      ELEVENLABS_API_KEY: 'xi-test-key',
      ELEVENLABS_BASE_URL: base,
      GROQ_STT_BASE_URL: `${base}/openai/v1`,
      TTS_RATE_LIMIT_PER_MIN: '1000',
      TTS_RATE_LIMIT_PER_IP: '1000',
    },
  });
  t.after(async () => {
    await teardown();
    await mock.close();
  });

  const env = require('../src/config/env');
  const tts = require('../src/services/tts.service');
  const fresh = () => {
    mock.reset();
    env.voice.elevenlabs.voiceIds = [];
    tts._internal.reset();
  };
  const voices = async () => (await fetch(`${baseUrl}/api/tts/voices`)).json();
  const speak = (body) =>
    fetch(`${baseUrl}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'dev-config' }, body: JSON.stringify(body) });

  await t.test('API key dibatasi izinnya (tanpa voices_read): pakai 6 suara bawaan & TTS tetap jalan', async () => {
    fresh();
    mock.state.voices = 'permission';
    const data = await voices();
    assert.equal(data.available, true);
    assert.deepEqual(data.voices.map((v) => v.name), ['Sarah', 'Roger', 'Jessica', 'George', 'Alice', 'Brian']);
    assert.deepEqual(data.voices.map((v) => v.gender), ['female', 'male', 'female', 'male', 'female', 'male']);
    const res = await speak({ text: 'Halo dari key terbatas', voiceId: data.voices[0].id });
    assert.equal(res.status, 200);
    assert.equal(mock.state.ttsCalls[0].voiceId, data.voices[0].id);
  });

  await t.test('operator menentukan suara sendiri (ELEVENLABS_VOICE_IDS): isi & urutan persis, nama/gender sesuai yang ditulis', async () => {
    fresh();
    env.voice.elevenlabs.voiceIds = ['abc123:Nadia:female', 'xyz789:Budi:male', 'v-roger'];
    const data = await voices();
    assert.deepEqual(data.voices.map((v) => [v.id, v.name, v.gender]), [['abc123', 'Nadia', 'female'], ['xyz789', 'Budi', 'male'], ['v-roger', 'Roger', 'male']]);
    assert.equal(data.defaultVoiceId, 'abc123');
    assert.equal((await speak({ text: 'Halo Nadia', voiceId: 'abc123' })).status, 200);
    assert.equal(mock.state.ttsCalls[0].voiceId, 'abc123');
    const unknown = await speak({ text: 'Halo', voiceId: 'v-sarah' });
    assert.equal(unknown.status, 400, 'suara di luar daftar operator tidak boleh dipakai');
  });

  await t.test('operator menentukan suara + daftar suara ElevenLabs lagi error: tetap jalan (tidak butuh daftar)', async () => {
    fresh();
    env.voice.elevenlabs.voiceIds = ['abc123:Nadia:female'];
    mock.state.voices = 'server_error';
    const data = await voices();
    assert.equal(data.available, true);
    assert.equal(data.voices[0].name, 'Nadia');
  });

  await t.test('API key salah -> /api/tts/voices 503 TTS_NOT_CONFIGURED (bukan 500 / bukan daftar kosong diam-diam)', async () => {
    fresh();
    mock.state.voices = 'auth_fail';
    const res = await fetch(`${baseUrl}/api/tts/voices`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'TTS_NOT_CONFIGURED');
  });

  await t.test('akun gratis diblokir saat ambil daftar suara -> 503 TTS_FREE_TIER_BLOCKED dengan pesan jelas', async () => {
    fresh();
    mock.state.voices = 'unusual';
    const res = await fetch(`${baseUrl}/api/tts/voices`);
    const data = await res.json();
    assert.equal(res.status, 503);
    assert.equal(data.error.code, 'TTS_FREE_TIER_BLOCKED');
    assert.match(data.error.message, /memblokir akun gratis/);
  });
});
