'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');
const { API_KEY_MODEL_ALIASES, VISION_MODELS } = require('../src/config/models');

// Regression test buat SECURITY-AUDIT.md MEDIUM-2 (RESOLVED sesuai keputusan produk): alias
// publik "vaeltrix-vision" sebelumnya resolve ke 'openai/gpt-oss-20b' (model text-only, BUKAN
// anggota VISION_MODELS) -- API key yang dibuat dengan modelId "vaeltrix-vision" jadi SELALU gagal
// kalau dipakai kirim gambar (ditolak validateChatBody dengan MODEL_NOT_VISION_CAPABLE),
// padahal labelnya di katalog pembuatan key literally "Vaeltrix Vision". Sekarang dialihkan ke
// model yang sama dipakai "vaeltrix-thinking" (satu-satunya VISION_MODELS saat ini).
test('alias publik "vaeltrix-vision" sekarang resolve ke model yang benar-benar vision-capable', () => {
  assert.ok(
    VISION_MODELS.includes(API_KEY_MODEL_ALIASES['vaeltrix-vision']),
    `vaeltrix-vision resolve ke "${API_KEY_MODEL_ALIASES['vaeltrix-vision']}", yang harus ada di VISION_MODELS (${VISION_MODELS.join(', ')})`
  );
});

test('API key modelId=vaeltrix-vision: kirim gambar lewat /v1/chat gak lagi ditolak MODEL_NOT_VISION_CAPABLE', async (t) => {
  const { baseUrl, teardown } = await setupHarness({ dbName: 'vaeltrix-vision-fix' });
  t.after(teardown);

  const created = await (
    await fetch(baseUrl + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Vision Key Test', modelId: 'vaeltrix-vision', createdBy: 'anon-vision-test-device' }),
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
            { type: 'text', text: 'Gambar Apa Ini?' },
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
    `Masih Ditolak Sebagai Model non-vision. Dapat Status ${res.status}: ${JSON.stringify(data)}`
  );
});
