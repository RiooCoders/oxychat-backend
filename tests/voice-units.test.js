'use strict';

/**
 * Test unit fitur suara: murni logika (tanpa server/jaringan).
 * Test integrasi lewat HTTP ada di voice.test.js, voice-config.test.js, voice-disabled.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ELEVENLABS_API_KEY = 'xi-unit-test';

const tts = require('../src/services/tts.service');
const stt = require('../src/services/stt.service');
const { detectAudioType } = require('../src/utils/audio-sniff');
const { ByteLruCache } = require('../src/utils/lru-cache');
const { createSemaphore } = require('../src/utils/semaphore');
const { extractErrorFields } = require('../src/utils/upstream-http');
const { resolveSpeed, resolveLanguage } = require('../src/config/voice-options');

const { curateVoices, normalizeApiVoice, sanitizeText } = tts._internal;

function apiVoice(id, name, gender, extra = {}) {
  return { voice_id: id, name, category: 'premade', labels: { gender, descriptive: 'warm', use_case: 'conversational' }, ...extra };
}
const norm = (list) => list.map(normalizeApiVoice);

test('curateVoices: seimbang 3 perempuan + 3 laki-laki, selang-seling, urutan prioritas natural', () => {
  const voices = norm([
    apiVoice('1', 'Eric', 'male'), apiVoice('2', 'Laura', 'female'), apiVoice('3', 'Roger', 'male'), apiVoice('4', 'Sarah', 'female'),
    apiVoice('5', 'George', 'male'), apiVoice('6', 'Jessica', 'female'), apiVoice('7', 'Brian', 'male'), apiVoice('8', 'Alice', 'female'),
    apiVoice('9', 'Matilda', 'female'), apiVoice('10', 'Charlie', 'male'),
  ]);
  const out = curateVoices(voices, { max: 6 });
  assert.deepEqual(out.map((v) => v.name), ['Sarah', 'Roger', 'Jessica', 'George', 'Alice', 'Brian']);
  assert.equal(out.filter((v) => v.gender === 'female').length, 3);
  assert.equal(out.filter((v) => v.gender === 'male').length, 3);
  assert.ok(out.every((v) => v.tagline && v.id), 'tiap suara punya id & deskripsi singkat');
});

test('curateVoices: buang karakter, kategori library/cloned, dan suara yang diblokir', () => {
  const voices = norm([
    apiVoice('a', 'Sarah', 'female'), apiVoice('b', 'Roger', 'male'),
    apiVoice('c', 'Kaelen - Amateur Warrior', 'male', { labels: { gender: 'male', use_case: 'characters_animation' } }),
    apiVoice('d', 'Rachel', 'female', { category: 'cloned' }),
    apiVoice('e', 'Pro Voice', 'male', { category: 'professional' }),
    apiVoice('f', 'Jessica', 'female'),
  ]);
  const out = curateVoices(voices, { max: 6, blocked: new Set(['f']) });
  assert.deepEqual(out.map((v) => v.name).sort(), ['Roger', 'Sarah']);
});

test('curateVoices: kalau satu gender kurang, diisi gender lain (tetap sampai max)', () => {
  const voices = norm([apiVoice('1', 'Sarah', 'female'), apiVoice('2', 'Roger', 'male'), apiVoice('3', 'Eric', 'male'), apiVoice('4', 'Brian', 'male'), apiVoice('5', 'George', 'male')]);
  const out = curateVoices(voices, { max: 6 });
  assert.equal(out.length, 5);
  assert.equal(out[0].name, 'Sarah');
});

test('curateVoices: akun tanpa suara premade -> pakai suara apa pun kecuali library berbayar', () => {
  const voices = norm([
    apiVoice('1', 'Suaraku', 'female', { category: 'generated' }),
    apiVoice('2', 'Mahaputra', 'male', { category: 'professional' }),
  ]);
  const out = curateVoices(voices, { max: 6, categories: ['premade'] });
  assert.deepEqual(out.map((v) => v.name), ['Suaraku']);
});

test('curateVoices: ELEVENLABS_VOICE_IDS (explicit) dihormati persis urutan & isinya', () => {
  const items = tts._internal.resolveConfiguredVoices(['x1:Nadia:female', 'x2:Budi:m', 'x3'], [{ voice_id: 'x3', name: 'Dari Akun', preview_url: 'https://a.test/p.mp3', labels: { gender: 'male' } }]);
  const out = curateVoices(norm(items), { max: 2 });
  assert.deepEqual(out.map((v) => [v.id, v.name, v.gender]), [['x1', 'Nadia', 'female'], ['x2', 'Budi', 'male'], ['x3', 'Dari Akun', 'male']]);
});

test('normalizeApiVoice: potong nama "Talia - Warm Soft Guide", gender cadangan dari preset, tagline dari label', () => {
  const a = normalizeApiVoice(apiVoice('1', 'Talia - Warm Soft Guide', ''));
  assert.equal(a.name, 'Talia');
  assert.equal(a.gender, 'female'); // label kosong -> dari preset
  assert.equal(a.tagline, 'Hangat & lembut');
  const b = normalizeApiVoice({ voice_id: '2', name: 'Orang Baru', labels: { gender: 'male', descriptive: 'calm', use_case: 'narration' }, preview_url: 'javascript:alert(1)' });
  assert.equal(b.tagline, 'Tenang & Narasi');
  assert.equal(b.previewUrl, '', 'URL preview non-https dibuang');
});

test('sanitizeText: buang karakter kontrol, rapikan spasi, tolak kosong/tanpa huruf/terlalu panjang', () => {
  assert.equal(sanitizeText('  Halo\u0000   dunia\n\nlagi '), 'Halo dunia lagi');
  assert.throws(() => sanitizeText('   '), (e) => e.code === 'TTS_TEXT_EMPTY');
  assert.throws(() => sanitizeText('... --- !!!'), (e) => e.code === 'TTS_TEXT_EMPTY');
  assert.throws(() => sanitizeText(123), (e) => e.code === 'TTS_TEXT_REQUIRED');
  assert.throws(() => sanitizeText('a'.repeat(5000)), (e) => e.code === 'TTS_TEXT_TOO_LONG');
});

test('resolveSpeed / resolveLanguage: validasi input', () => {
  assert.equal(resolveSpeed('slow').value, 0.85);
  assert.equal(resolveSpeed(undefined).id, 'normal');
  assert.equal(resolveSpeed(1.1).value, 1.1);
  assert.equal(resolveSpeed(3), null);
  assert.equal(resolveSpeed('ngebut'), null);
  assert.equal(resolveLanguage('ID'), 'id');
  assert.equal(resolveLanguage(''), 'auto');
  assert.equal(resolveLanguage('xx'), null);
});

test('detectAudioType: kenali container dari magic bytes, tolak yang bukan audio', () => {
  const pad = Buffer.alloc(32, 1);
  assert.equal(detectAudioType(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), pad])).ext, 'webm');
  assert.equal(detectAudioType(Buffer.concat([Buffer.from('OggS'), pad])).ext, 'ogg');
  assert.equal(detectAudioType(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), pad])).ext, 'm4a');
  assert.equal(detectAudioType(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVEfmt '), pad])).ext, 'wav');
  assert.equal(detectAudioType(Buffer.concat([Buffer.from('ID3'), pad])).ext, 'mp3');
  assert.equal(detectAudioType(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), pad])).ext, 'mp3');
  assert.equal(detectAudioType(Buffer.concat([Buffer.from('fLaC'), pad])).ext, 'flac');
  assert.equal(detectAudioType(Buffer.from('<html><body>bukan audio sama sekali</body></html>')), null);
  assert.equal(detectAudioType(Buffer.from('pendek')), null);
  assert.equal(detectAudioType('bukan buffer'), null);
});

test('ByteLruCache: batas total byte, buang yang paling lama dipakai, item terlalu besar ditolak', () => {
  const c = new ByteLruCache(100);
  assert.equal(c.set('a', 'A', 40), true);
  assert.equal(c.set('b', 'B', 40), true);
  assert.equal(c.get('a'), 'A'); // a jadi yang terbaru dipakai
  assert.equal(c.set('c', 'C', 40), true); // total 120 > 100 -> b (paling lama) dibuang
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 'A');
  assert.equal(c.get('c'), 'C');
  assert.equal(c.set('gede', 'X', 101), false);
  assert.equal(new ByteLruCache(0).set('a', 'A', 1), false, 'maxBytes 0 = cache mati');
});

test('semaphore: batasi paralel, antre FIFO, timeout antrean, abort, release idempoten', async () => {
  const sem = createSemaphore(1);
  const r1 = await sem.acquire({ timeoutMs: 1000 });
  assert.equal(sem.active, 1);

  const order = [];
  const p2 = sem.acquire({ timeoutMs: 1000 }).then((r) => { order.push(2); return r; });
  const p3 = sem.acquire({ timeoutMs: 1000 }).then((r) => { order.push(3); return r; });
  assert.equal(sem.waiting, 2);
  r1(); r1(); // dipanggil dua kali: tetap hanya melepas SATU slot
  const r2 = await p2;
  assert.equal(sem.active, 1);
  r2();
  const r3 = await p3;
  assert.deepEqual(order, [2, 3]);
  r3();
  assert.equal(sem.active, 0);

  const hold = await sem.acquire({ timeoutMs: 1000 });
  await assert.rejects(sem.acquire({ timeoutMs: 40 }), (e) => e.code === 'QUEUE_TIMEOUT');
  assert.equal(sem.waiting, 0, 'yang timeout keluar dari antrean');
  const ac = new AbortController();
  const pAbort = sem.acquire({ timeoutMs: 5000, signal: ac.signal });
  ac.abort();
  await assert.rejects(pAbort, (e) => e.code === 'ABORTED');
  assert.equal(sem.waiting, 0);
  hold();
  await assert.rejects(sem.acquire({ signal: AbortSignal.abort() }), (e) => e.code === 'ABORTED');
});

test('extractErrorFields: bentuk error ElevenLabs & Groq/OpenAI terbaca', () => {
  assert.deepEqual(extractErrorFields(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'Kuota habis' } })), { code: 'quota_exceeded', message: 'Kuota habis' });
  assert.deepEqual(extractErrorFields(JSON.stringify({ error: { message: 'model gak ada', code: 'model_not_found' } })), { code: 'model_not_found', message: 'model gak ada' });
  assert.equal(extractErrorFields(JSON.stringify({ detail: [{ loc: ['body', 'text'], msg: 'wajib diisi' }] })).message, 'body.text: wajib diisi');
  assert.equal(extractErrorFields('Bad Gateway').message, 'Bad Gateway');
  assert.equal(extractErrorFields('').message, '');
});

test('STT: filter halusinasi Whisper (segmen sepi dibuang, kalimat penutup video dibuang)', () => {
  const { textFromWhisper, cleanTranscript } = stt._internal;
  assert.equal(textFromWhisper({ segments: [{ text: ' Halo apa kabar', no_speech_prob: 0.01, avg_logprob: -0.2 }, { text: ' Terima kasih telah menonton', no_speech_prob: 0.9, avg_logprob: -1.5 }] }), 'Halo apa kabar');
  assert.equal(textFromWhisper({ segments: [{ text: ' Subtitle by Amara.org', no_speech_prob: 0.95, avg_logprob: -1.8 }] }), '');
  // no_speech tinggi tapi logprob bagus = ucapan sungguhan, jangan dibuang
  assert.equal(textFromWhisper({ segments: [{ text: ' Tes satu dua', no_speech_prob: 0.7, avg_logprob: -0.3 }] }), 'Tes satu dua');
  assert.equal(textFromWhisper({ text: '  Sampai jumpa di video berikutnya! ' }), '');
  assert.equal(cleanTranscript('Terima kasih'), 'Terima kasih', 'ucapan wajar tidak ikut terbuang');
});

test('STT: urutan penyedia mengikuti STT_PROVIDER & key yang ada', () => {
  const env = require('../src/config/env');
  const saved = { mode: env.voice.stt.provider, groq: env.providerKeys.groq, eleven: env.voice.elevenlabs.apiKey };
  try {
    env.providerKeys.groq = 'g'; env.voice.elevenlabs.apiKey = 'e';
    env.voice.stt.provider = 'auto';
    assert.deepEqual(stt._internal.providersInOrder(), ['groq', 'elevenlabs']);
    env.voice.stt.provider = 'elevenlabs';
    assert.deepEqual(stt._internal.providersInOrder(), ['elevenlabs']);
    env.voice.stt.provider = 'groq';
    assert.deepEqual(stt._internal.providersInOrder(), ['groq']);
    env.voice.stt.provider = 'auto'; env.providerKeys.groq = '';
    assert.deepEqual(stt._internal.providersInOrder(), ['elevenlabs']);
    env.voice.elevenlabs.apiKey = '';
    assert.deepEqual(stt._internal.providersInOrder(), []);
    assert.equal(stt.isAvailable(), false);
  } finally {
    env.voice.stt.provider = saved.mode; env.providerKeys.groq = saved.groq; env.voice.elevenlabs.apiKey = saved.eleven;
  }
});
