'use strict';

/**
 * Integrasi fitur suara lewat route ASLI (/api/tts/voices, /api/tts, /api/stt) dengan ElevenLabs & Groq palsu
 * (tests/helpers/voice-mock.js). Tiap subtest mulai dari kondisi bersih (mock.reset + tts reset).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');
const { createVoiceMock, fakeWebm } = require('./helpers/voice-mock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('suara: TTS ElevenLabs + STT (Groq/Scribe) lewat backend', async (t) => {
  const mock = createVoiceMock();
  await mock.listen();
  const base = `http://127.0.0.1:${mock.port}`;
  const { baseUrl, teardown } = await setupHarness({
    dbName: 'voice',
    envOverrides: {
      ELEVENLABS_API_KEY: 'xi-test-key',
      ELEVENLABS_BASE_URL: base,
      GROQ_STT_BASE_URL: `${base}/openai/v1`,
      ELEVENLABS_TTS_MODEL: 'eleven_turbo_v2_5,eleven_flash_v2_5',
      ELEVENLABS_MAX_CONCURRENCY: '1',
      ELEVENLABS_QUEUE_WAIT_MS: '300',
      ELEVENLABS_TIMEOUT_MS: '2000',
      TTS_MAX_CHARS_PER_CLIENT_PER_DAY: '300',
      TTS_RATE_LIMIT_PER_MIN: '30',
      TTS_RATE_LIMIT_PER_IP: '1000',
      STT_RATE_LIMIT_PER_MIN: '1000',
      STT_RATE_LIMIT_PER_IP: '1000',
      STT_MAX_AUDIO_MB: '1',
    },
  });
  t.after(async () => {
    await teardown();
    await mock.close();
  });

  const tts = require('../src/services/tts.service');
  let n = 0;
  const uniq = (s) => `${s} nomor ${++n}`;
  const dev = () => `dev-${++n}`;
  const fresh = () => {
    mock.reset();
    tts._internal.reset();
  };
  const postTts = (body, headers = {}) =>
    fetch(`${baseUrl}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': dev(), ...headers }, body: JSON.stringify(body) });
  const postStt = (bytes, { query = '', type = 'audio/webm;codecs=opus', headers = {} } = {}) =>
    fetch(`${baseUrl}/api/stt${query}`, { method: 'POST', headers: { 'Content-Type': type, 'X-Device-Id': dev(), ...headers }, body: bytes });

  await t.test('health: status suara ikut tampil, tanpa bocorin key', async () => {
    const data = await (await fetch(`${baseUrl}/`)).json();
    assert.deepEqual(data.voice, { tts: true, stt: true });
    assert.ok(!JSON.stringify(data).includes('xi-test-key'));
  });

  await t.test('GET /api/tts/voices: 6 suara seimbang P/L selang-seling, opsi bahasa & kecepatan, key tidak bocor', async () => {
    fresh();
    const res = await fetch(`${baseUrl}/api/tts/voices`);
    const raw = await res.text();
    const data = JSON.parse(raw);
    assert.equal(res.status, 200);
    assert.equal(data.available, true);
    assert.deepEqual(data.voices.map((v) => v.name), ['Sarah', 'Roger', 'Jessica', 'George', 'Alice', 'Brian']);
    assert.deepEqual(data.voices.map((v) => v.gender), ['female', 'male', 'female', 'male', 'female', 'male']);
    assert.equal(data.defaultVoiceId, 'v-sarah');
    assert.ok(data.voices.every((v) => v.id && v.tagline && v.previewUrl.startsWith('http')));
    assert.ok(!data.voices.some((v) => /Kaelen|Rachel|Pro Voice/.test(v.name)), 'karakter/cloned/professional tidak ditampilkan');
    assert.ok(data.languages.some((l) => l.code === 'auto' && l.label === 'Otomatis'));
    assert.ok(data.languages.some((l) => l.code === 'id' && l.label === 'Indonesia'));
    assert.deepEqual(data.speeds.map((s) => s.id), ['slow', 'normal', 'fast']);
    assert.deepEqual(data.stt, { available: true });
    assert.ok(!raw.includes('xi-test-key'));
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  await t.test('daftar suara: paginasi v2 dibaca semua halaman; v2 404 jatuh ke endpoint v1', async () => {
    fresh();
    mock.state.voices = 'paged';
    let data = await (await fetch(`${baseUrl}/api/tts/voices`)).json();
    assert.equal(mock.state.voiceListCalls, 2);
    assert.equal(data.voices.length, 6);

    fresh();
    mock.state.voices = 'legacy';
    data = await (await fetch(`${baseUrl}/api/tts/voices`)).json();
    assert.equal(data.available, true);
    assert.equal(data.voices.length, 6);
  });

  await t.test('daftar suara di-cache; kalau refresh gagal data lama tetap dilayani; belum pernah berhasil -> error jelas', async () => {
    fresh();
    mock.state.voices = 'server_error';
    let res = await fetch(`${baseUrl}/api/tts/voices`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'TTS_UPSTREAM_ERROR');

    fresh();
    await fetch(`${baseUrl}/api/tts/voices`);
    await fetch(`${baseUrl}/api/tts/voices`);
    assert.equal(mock.state.voiceListCalls, 1, 'panggilan kedua dilayani dari cache');
    mock.state.voices = 'server_error';
    tts._internal.state.fetchedAt = 0; // paksa kedaluwarsa
    res = await fetch(`${baseUrl}/api/tts/voices`);
    assert.equal(res.status, 200, 'stale tetap dilayani');
    assert.equal((await res.json()).voices.length, 6);
  });

  await t.test('POST /api/tts: balas audio/mpeg utuh; panggilan ke ElevenLabs benar (key di header server, model, format, speed)', async () => {
    fresh();
    const res = await postTts({ text: 'Halo, apa kabar hari ini?', voiceId: 'v-roger' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(res.headers.get('x-tts-cache'), 'MISS');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(Buffer.compare(bytes, mock.audio), 0);
    const call = mock.state.ttsCalls[0];
    assert.equal(call.voiceId, 'v-roger');
    assert.equal(call.headers['xi-api-key'], 'xi-test-key');
    assert.equal(call.query.output_format, 'mp3_44100_128');
    assert.equal(call.body.model_id, 'eleven_turbo_v2_5');
    assert.equal(call.body.text, 'Halo, apa kabar hari ini?');
    assert.equal(call.body.voice_settings.speed, 1);
    assert.equal(call.body.language_code, undefined, 'bahasa otomatis: tidak memaksa language_code');
  });

  await t.test('POST /api/tts: tanpa voiceId -> suara pertama katalog; speed & bahasa diteruskan', async () => {
    fresh();
    const res = await postTts({ text: uniq('Selamat pagi'), speed: 'fast', language: 'id' });
    assert.equal(res.status, 200);
    const call = mock.state.ttsCalls[0];
    assert.equal(call.voiceId, 'v-sarah');
    assert.equal(call.body.voice_settings.speed, 1.15);
    assert.equal(call.body.language_code, 'id');
    await postTts({ text: uniq('Selamat sore'), speed: 'slow' });
    assert.equal(mock.state.ttsCalls[1].body.voice_settings.speed, 0.85);
  });

  await t.test('cache audio: permintaan identik berikutnya HIT dan TIDAK memanggil ElevenLabs (hemat kredit)', async () => {
    fresh();
    const body = { text: 'Teks yang sama persis', voiceId: 'v-jessica', speed: 'normal' };
    assert.equal((await postTts(body)).headers.get('x-tts-cache'), 'MISS');
    const second = await postTts(body);
    assert.equal(second.headers.get('x-tts-cache'), 'HIT');
    assert.equal(Buffer.compare(Buffer.from(await second.arrayBuffer()), mock.audio), 0);
    assert.equal(mock.state.ttsCalls.length, 1);
    await postTts({ ...body, speed: 'fast' }); // kecepatan beda = audio beda
    assert.equal(mock.state.ttsCalls.length, 2);
  });

  await t.test('validasi input TTS: teks kosong/terlalu panjang, suara tak dikenal, kecepatan/bahasa salah, JSON rusak', async () => {
    fresh();
    const code = async (res) => [res.status, (await res.json()).error.code];
    assert.deepEqual(await code(await postTts({ text: '   ' })), [400, 'TTS_TEXT_EMPTY']);
    assert.deepEqual(await code(await postTts({})), [400, 'TTS_TEXT_REQUIRED']);
    assert.deepEqual(await code(await postTts({ text: 'a'.repeat(4000) })), [400, 'TTS_TEXT_TOO_LONG']);
    assert.deepEqual(await code(await postTts({ text: 'halo', voiceId: 'voice-ngarang' })), [400, 'TTS_VOICE_UNKNOWN']);
    assert.deepEqual(await code(await postTts({ text: 'halo', voiceId: 'v-pro' })), [400, 'TTS_VOICE_UNKNOWN']); // suara library tak ditampilkan = tak boleh dipakai
    assert.deepEqual(await code(await postTts({ text: 'halo', speed: 'kilat' })), [400, 'TTS_BAD_SPEED']);
    assert.deepEqual(await code(await postTts({ text: 'halo', language: 'xx' })), [400, 'TTS_BAD_LANGUAGE']);
    const bad = await fetch(`${baseUrl}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{rusak' });
    assert.deepEqual(await code(bad), [400, 'INVALID_JSON']);
    assert.equal(mock.state.ttsCalls.length, 0, 'input salah tidak pernah sampai ke ElevenLabs');
  });

  await t.test('fallback model: model ditolak ElevenLabs -> pindah model berikutnya otomatis & diingat', async () => {
    fresh();
    mock.state.rejectModels.add('eleven_turbo_v2_5');
    assert.equal((await postTts({ text: uniq('Coba model') })).status, 200);
    assert.deepEqual(mock.state.ttsCalls.map((c) => c.body.model_id), ['eleven_turbo_v2_5', 'eleven_flash_v2_5']);
    assert.equal((await postTts({ text: uniq('Coba lagi') })).status, 200);
    assert.deepEqual(mock.state.ttsCalls.map((c) => c.body.model_id), ['eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_flash_v2_5'], 'model yang ditolak gak dicoba ulang');
  });

  await t.test('language_code ditolak model -> diulang sekali tanpa language_code', async () => {
    fresh();
    mock.state.rejectLanguageCode = true;
    const res = await postTts({ text: uniq('Halo dunia'), language: 'id' });
    assert.equal(res.status, 200);
    assert.equal(mock.state.ttsCalls.length, 2);
    assert.equal(mock.state.ttsCalls[0].body.language_code, 'id');
    assert.equal(mock.state.ttsCalls[1].body.language_code, undefined);
  });

  await t.test('akun gratis diblokir ElevenLabs (IP server) -> pesan jelas + gagal-cepat 1 menit (tidak menghajar ElevenLabs terus)', async () => {
    fresh();
    mock.state.perVoice['v-sarah'] = 'unusual';
    const first = await postTts({ text: uniq('Tes blokir') });
    const data = await first.json();
    assert.equal(first.status, 503);
    assert.equal(data.error.code, 'TTS_FREE_TIER_BLOCKED');
    assert.match(data.error.message, /memblokir akun gratis/);
    const second = await postTts({ text: uniq('Tes blokir lagi') });
    assert.equal((await second.json()).error.code, 'TTS_FREE_TIER_BLOCKED');
    assert.equal(mock.state.ttsCalls.length, 1, 'panggilan kedua gagal-cepat tanpa ke ElevenLabs');
  });

  await t.test('kuota ElevenLabs habis -> 503 TTS_QUOTA_EXCEEDED', async () => {
    fresh();
    mock.state.perVoice['v-sarah'] = 'quota';
    const res = await postTts({ text: uniq('Kuota') });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'TTS_QUOTA_EXCEEDED');
  });

  await t.test('suara 404 / butuh paket berbayar -> error jelas & suara itu otomatis hilang dari daftar (sembuh sendiri)', async () => {
    fresh();
    mock.state.perVoice['v-george'] = 'not_found';
    mock.state.perVoice['v-alice'] = 'paid';
    const r1 = await postTts({ text: uniq('George'), voiceId: 'v-george' });
    assert.equal(r1.status, 502);
    assert.equal((await r1.json()).error.code, 'TTS_VOICE_NOT_FOUND');
    const r2 = await postTts({ text: uniq('Alice'), voiceId: 'v-alice' });
    assert.equal(r2.status, 502);
    assert.equal((await r2.json()).error.code, 'TTS_PAID_REQUIRED');
    const list = await (await fetch(`${baseUrl}/api/tts/voices`)).json();
    const names = list.voices.map((v) => v.name);
    assert.ok(!names.includes('George') && !names.includes('Alice'), `daftar sekarang: ${names}`);
    assert.equal(list.voices.length, 6, 'tetap penuh: diisi suara cadangan');
    const r3 = await postTts({ text: uniq('George lagi'), voiceId: 'v-george' });
    assert.equal((await r3.json()).error.code, 'TTS_VOICE_UNKNOWN', 'klien dikasih tahu suaranya sudah tidak ada');
  });

  await t.test('ElevenLabs 429 -> 429 TTS_RATE_LIMITED + Retry-After diteruskan', async () => {
    fresh();
    mock.state.perVoice['v-sarah'] = 'rate_limited';
    const res = await postTts({ text: uniq('Penuh') });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '3');
    assert.equal((await res.json()).error.code, 'TTS_RATE_LIMITED');
  });

  await t.test('antrean paralel: slot habis & menunggu > batas -> 503 TTS_BUSY, yang pertama tetap selesai', async () => {
    fresh();
    mock.state.perVoice['v-sarah'] = 'slow';
    const [a, b] = await Promise.all([postTts({ text: uniq('Pertama') }), postTts({ text: uniq('Kedua') })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 503]);
    const busy = a.status === 503 ? a : b;
    assert.equal((await busy.json()).error.code, 'TTS_BUSY');
    assert.equal(mock.state.ttsCalls.length, 1);
  });

  await t.test('klien memutus koneksi -> panggilan ke ElevenLabs dibatalkan & slot dilepas (request berikutnya tetap jalan)', async () => {
    fresh();
    mock.state.perVoice['v-sarah'] = 'hang';
    const ac = new AbortController();
    const pending = fetch(`${baseUrl}/api/tts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': dev() }, body: JSON.stringify({ text: uniq('Menggantung') }), signal: ac.signal,
    }).catch((e) => e);
    await sleep(250);
    ac.abort();
    await pending;
    await sleep(250);
    assert.ok(mock.state.closedEarly >= 1, 'koneksi ke ElevenLabs ikut diputus');
    mock.state.perVoice['v-sarah'] = 'ok';
    const res = await postTts({ text: uniq('Setelah abort') });
    assert.equal(res.status, 200, 'slot (maxConcurrency=1) sudah dilepas');
  });

  await t.test('batas karakter harian per perangkat: lewat batas -> 429 TTS_DAILY_LIMIT; perangkat lain tidak terpengaruh; cache hit tidak dihitung', async () => {
    fresh();
    const device = 'dev-harian';
    const text = (i) => `${'x'.repeat(95)} ${String(i).padStart(4, '0')}`; // 100 karakter
    for (let i = 1; i <= 3; i += 1) assert.equal((await postTts({ text: text(i) }, { 'X-Device-Id': device })).status, 200);
    const over = await postTts({ text: text(4) }, { 'X-Device-Id': device });
    assert.equal(over.status, 429);
    assert.equal((await over.json()).error.code, 'TTS_DAILY_LIMIT');
    assert.equal((await postTts({ text: text(1) }, { 'X-Device-Id': device })).headers.get('x-tts-cache'), 'HIT', 'audio yang sudah ada tetap bisa diputar ulang');
    assert.equal((await postTts({ text: text(4) }, { 'X-Device-Id': 'dev-lain' })).status, 200);
  });

  await t.test('rate limit per perangkat: lewat batas per menit -> 429 + Retry-After (sebelum menyentuh ElevenLabs)', async () => {
    fresh();
    const device = 'dev-spam';
    let last;
    for (let i = 0; i < 31; i += 1) last = await postTts({ text: '' }, { 'X-Device-Id': device });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  });

  await t.test('STT: rekaman WebM -> teks via Groq Whisper (model, format, nama file, tanpa language bila otomatis)', async () => {
    fresh();
    const res = await postStt(fakeWebm());
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(data, { text: 'halo dunia', language: 'indonesian', provider: 'groq' });
    const call = mock.state.groqCalls[0];
    assert.equal(call.fields.model, 'whisper-large-v3-turbo');
    assert.equal(call.fields.response_format, 'verbose_json');
    assert.equal(call.fields.language, undefined);
    assert.equal(call.files.file.filename, 'rekaman.webm');
    assert.equal(call.files.file.contentType, 'audio/webm');
    assert.equal(call.headers.authorization, 'Bearer key-groq');
    const withLang = await postStt(fakeWebm(), { query: '?language=id' });
    assert.equal(withLang.status, 200);
    assert.equal(mock.state.groqCalls[1].fields.language, 'id');
  });

  await t.test('STT: audio sepi / halusinasi Whisper -> teks kosong (bukan "Terima kasih telah menonton")', async () => {
    fresh();
    mock.state.groq = 'silence';
    assert.equal((await (await postStt(fakeWebm())).json()).text, '');
    mock.state.groq = 'hallucination';
    assert.equal((await (await postStt(fakeWebm())).json()).text, '');
  });

  await t.test('STT: Groq gagal (key/limit) -> otomatis pakai ElevenLabs Scribe', async () => {
    fresh();
    mock.state.groq = 'auth_fail';
    const res = await postStt(fakeWebm(), { query: '?language=id' });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.provider, 'elevenlabs');
    assert.equal(data.text, 'halo dari scribe');
    const call = mock.state.sttCalls[0];
    assert.equal(call.fields.model_id, 'scribe_v1');
    assert.equal(call.fields.tag_audio_events, 'false');
    assert.equal(call.fields.language_code, 'id');
    assert.equal(call.headers['xi-api-key'], 'xi-test-key');
  });

  await t.test('STT: model Groq pertama ditolak -> model berikutnya dicoba', async () => {
    fresh();
    mock.state.groqRejectModels.add('whisper-large-v3-turbo');
    const data = await (await postStt(fakeWebm())).json();
    assert.equal(data.provider, 'groq');
    assert.deepEqual(mock.state.groqCalls.map((c) => c.fields.model), ['whisper-large-v3-turbo', 'whisper-large-v3']);
  });

  await t.test('STT: format dari tiap browser diterima (Safari mp4, Firefox ogg) & nama file mengikuti isi asli', async () => {
    fresh();
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(2000, 3)]);
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(2000, 3)]);
    assert.equal((await postStt(mp4, { type: 'audio/mp4' })).status, 200);
    assert.equal((await postStt(ogg, { type: 'audio/ogg;codecs=opus' })).status, 200);
    assert.equal((await postStt(fakeWebm(), { type: 'video/webm' })).status, 200, 'label Content-Type salah tidak masalah: yang dicek isi file');
    assert.deepEqual(mock.state.groqCalls.map((c) => c.files.file.filename), ['rekaman.m4a', 'rekaman.ogg', 'rekaman.webm']);
  });

  await t.test('validasi STT: kosong, bukan audio, kebesaran, body JSON, bahasa salah', async () => {
    fresh();
    const code = async (res) => [res.status, (await res.json()).error.code];
    assert.deepEqual(await code(await postStt(Buffer.alloc(0))), [400, 'STT_AUDIO_EMPTY']);
    assert.deepEqual(await code(await postStt(Buffer.alloc(100, 1))), [400, 'STT_AUDIO_EMPTY']);
    assert.deepEqual(await code(await postStt(Buffer.from('<html>' + 'x'.repeat(3000) + '</html>'), { type: 'audio/webm' })), [415, 'STT_UNSUPPORTED_AUDIO']);
    assert.equal((await postStt(Buffer.concat([fakeWebm(), Buffer.alloc(1024 * 1024)]))).status, 413);
    assert.deepEqual(await code(await postStt(JSON.stringify({ a: 1 }), { type: 'application/json' })), [400, 'STT_AUDIO_EMPTY']);
    assert.deepEqual(await code(await postStt(fakeWebm(), { query: '?language=klingon' })), [400, 'STT_BAD_LANGUAGE']);
    assert.equal(mock.state.groqCalls.length + mock.state.sttCalls.length, 0, 'input salah tidak pernah diteruskan ke penyedia STT');
  });

  await t.test('STT: semua penyedia gagal -> error penyedia UTAMA yang dilaporkan (429 -> pesan antre)', async () => {
    fresh();
    mock.state.groq = 'rate_limited';
    mock.state.stt = 'auth_fail';
    const res = await postStt(fakeWebm());
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, 'STT_RATE_LIMITED');
    assert.equal(mock.state.sttCalls.length, 1, 'cadangan sempat dicoba');
  });

  await t.test('CORS preflight /api/stt (Content-Type audio + X-Device-Id) diizinkan', async () => {
    const res = await fetch(`${baseUrl}/api/stt`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://frontend.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-device-id' },
    });
    assert.equal(res.status, 204);
    const allowed = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    assert.ok(allowed.includes('content-type') && allowed.includes('x-device-id'));
  });
});
