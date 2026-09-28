'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');
const { API_KEY_MODEL_ALIASES, VISION_MODELS } = require('../src/config/models');

// Regression test buat SECURITY-AUDIT.md MEDIUM-2 (RESOLVED sesuai keputusan produk): alias
// publik "oxy-vision" sebelumnya resolve ke 'openai/gpt-oss-20b' (model text-only, BUKAN
// anggota VISION_MODELS) -- API key yang dibuat dengan modelId "oxy-vision" jadi SELALU gagal
// kalau dipakai kirim gambar (ditolak validateChatBody dengan MODEL_NOT_VISION_CAPABLE),
// padahal labelnya di katalog pembuatan key literally "Oxy Vision". Sekarang dialihkan ke
// model yang sama dipakai "oxy-thinking" (satu-satunya VISION_MODELS saat ini).
test('alias publik "oxy-vision" sekarang resolve ke model yang benar-benar vision-capable', () => {
  assert.ok(
    VISION_MODELS.includes(API_KEY_MODEL_ALIASES['oxy-vision']),
    `oxy-vision resolve ke "${API_KEY_MODEL_ALIASES['oxy-vision']}", yang harus ada di VISION_MODELS (${VISION_MODELS.join(', ')})`
  );
});

test('API key modelId=oxy-vision: kirim gambar lewat /v1/chat gak lagi ditolak MODEL_NOT_VISION_CAPABLE', async (t) => {
  const { baseUrl, teardown } = await setupHarness({ dbName: 'oxy-vision-fix' });
  t.after(teardown);

  const created = await (
    await fetch(baseUrl + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Vision Key Test', modelId: 'oxy-vision', createdBy: 'anon-vision-test-device' }),
    })
  ).json();

  const res = await fetch(baseUrl + '/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + created.key },
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'gambar apa ini?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aGFsbw==' } },
          ],
        },
      ],
      stream: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  assert.notEqual(
    data && data.error && data.error.code,
    'MODEL_NOT_VISION_CAPABLE',
    `masih ditolak sebagai model non-vision, dapat status ${res.status}: ${JSON.stringify(data)}`
  );
});
