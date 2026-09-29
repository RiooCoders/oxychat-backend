'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

test('ownership berbasis Supabase auth (perbaikan IDOR)', async (t) => {
  const { baseUrl, mockSupabase, teardown } = await setupHarness({ dbName: 'auth' });
  t.after(teardown);

  mockSupabase.users.set('token-valid-nia', { id: 'uuid-nia-111', email: 'nia@example.com' });
  mockSupabase.users.set('token-valid-budi', { id: 'uuid-budi-222', email: 'budi@example.com' });

  await t.test('createdBy BERBENTUK EMAIL tanpa token -> 401 (celah IDOR lama, sekarang ditolak)', async () => {
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', modelId: 'vaeltrix-fast', createdBy: 'nia@example.com' }),
    });
    const data = await res.json();
    assert.equal(res.status, 401);
    assert.equal(data.error.code, 'EMAIL_OWNER_REQUIRES_AUTH');
  });

  await t.test('createdBy BUKAN email (device id anonim) tanpa token -> tetap jalan seperti biasa (gak regresi)', async () => {
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', modelId: 'vaeltrix-fast', createdBy: 'anon-device-zzz' }),
    });
    assert.equal(res.status, 201);
  });

  await t.test('Bearer token TIDAK valid -> 401, bukan diem-diem dianggap anonim', async () => {
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-ngasal-salah' },
      body: JSON.stringify({ name: 'x', modelId: 'vaeltrix-fast', createdBy: 'siapa-aja@example.com' }),
    });
    const data = await res.json();
    assert.equal(res.status, 401);
    assert.equal(data.error.code, 'INVALID_SESSION');
  });

  await t.test('Bearer token VALID -> create pakai identitas terverifikasi, createdBy dari client diabaikan', async () => {
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-valid-nia' },
      // createdBy sengaja diisi email ORANG LAIN buat mastiin server BENERAN ngabaiin ini
      body: JSON.stringify({ name: 'Key Nia', modelId: 'vaeltrix-fast', createdBy: 'budi@example.com' }),
    });
    assert.equal(res.status, 201);

    // Budi coba liat key pake token Nia -> harus TETEP gak keliatan punya Budi (ownership ikut uid asli, bukan createdBy klaim)
    const listAsBudiToken = await (await fetch(baseUrl + '/api/keys', { headers: { Authorization: 'Bearer token-valid-budi' } })).json();
    assert.equal(listAsBudiToken.length, 0, 'key yang dibuat via token Nia TIDAK muncul di akun Budi walau createdBy diklaim budi@example.com');

    const listAsNia = await (await fetch(baseUrl + '/api/keys', { headers: { Authorization: 'Bearer token-valid-nia' } })).json();
    assert.equal(listAsNia.length, 1);
    assert.equal(listAsNia[0].name, 'Key Nia');
  });

  await t.test('user lain TIDAK bisa hapus key Nia biarpun tau ID-nya (kirim token sendiri)', async () => {
    const mine = await (await fetch(baseUrl + '/api/keys', { headers: { Authorization: 'Bearer token-valid-nia' } })).json();
    const resDel = await fetch(baseUrl + `/api/keys/${mine[0].id}`, { method: 'DELETE', headers: { Authorization: 'Bearer token-valid-budi' } });
    assert.equal(resDel.status, 404);
  });

  await t.test('KOMPATIBILITAS MIGRASI: key lama yang owner-nya masih format email (dibuat sebelum fix) tetap keliatan setelah user login', async () => {
    // Simulasikan key "lama" yang dibuat era sebelum fix (owner tersimpan = email polos, BUKAN
    // "supabase:<uuid>") — langsung tulis ke repo, merepresentasikan data pre-existing.
    const apiKeyRepo = require('../src/db/repositories/apikey.repo');
    const { generateId, generateApiKey } = require('../src/utils/id');
    apiKeyRepo.create({
      id: generateId('key'), name: 'Key Lama Era createdBy', modelId: 'vaeltrix-fast',
      owner: 'nia@example.com', key: generateApiKey(), status: 'active', createdAt: Date.now(), lastUsedAt: null,
    });
    const listAsNia = await (await fetch(baseUrl + '/api/keys', { headers: { Authorization: 'Bearer token-valid-nia' } })).json();
    assert.ok(listAsNia.some((k) => k.name === 'Key Lama Era createdBy'), 'key lama (owner=email) tetap muncul buat user yang sama setelah login, gak "ilang"');
  });

  await t.test('API key limit tetep berlaku buat user yang login (identitas terverifikasi)', async () => {
    // Nia dari test sebelumnya udah punya >=1 key aktif -> percobaan bikin lagi harus kena limit.
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-valid-nia' },
      body: JSON.stringify({ name: 'Key Nia Kedua', modelId: 'vaeltrix-fast' }),
    });
    assert.equal(res.status, 409);
  });
});
