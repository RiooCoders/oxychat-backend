'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

test('/api/keys (jalur anonim/device-id, tanpa login)', async (t) => {
  const { baseUrl, teardown } = await setupHarness({ dbName: 'api-key' });
  t.after(teardown);

  await t.test('create key -> 201, balikin key mentah (SEKALI, pas dibuat)', async () => {
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Key A', modelId: 'vaeltrix-fast', createdBy: 'anon-device-aaa' }),
    });
    const data = await res.json();
    assert.equal(res.status, 201);
    assert.ok(data.key.startsWith('vaeltrix_'));
  });

  await t.test('list balikin ARRAY langsung (bukan {data:[...]}), key mentah TIDAK muncul lagi (cuma keyPreview)', async () => {
    const res = await fetch(baseUrl + '/api/keys?createdBy=anon-device-aaa');
    const list = await res.json();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 1);
    assert.equal(list[0].key, undefined, 'field key mentah gak boleh ada lagi di listing');
    assert.ok(list[0].keyPreview.startsWith('vaeltrix_'));
    assert.ok(list[0].keyPreview.includes('\u2026'), 'dimasking, bukan full key');
  });

  await t.test('modelId di luar katalog ditolak 400', async () => {
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', modelId: 'model-ngarang', createdBy: 'anon-device-bbb' }),
    });
    assert.equal(res.status, 400);
  });

  await t.test('owner isolation: device lain gak bisa liat/hapus key device-aaa', async () => {
    const listOther = await (await fetch(baseUrl + '/api/keys?createdBy=anon-device-lain')).json();
    assert.equal(listOther.length, 0);

    const mine = await (await fetch(baseUrl + '/api/keys?createdBy=anon-device-aaa')).json();
    const resDel = await fetch(baseUrl + `/api/keys/${mine[0].id}?createdBy=anon-device-lain`, { method: 'DELETE' });
    assert.equal(resDel.status, 404, 'device lain ditolak hapus key device-aaa');
  });

  await t.test('API KEY LIMIT: owner yang sama gak bisa bikin key ke-2 (flat limit sesuai PLANS.*.keyLimit = 1x)', async () => {
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Key A2', modelId: 'vaeltrix-fast', createdBy: 'anon-device-aaa' }),
    });
    const data = await res.json();
    assert.equal(res.status, 409);
    assert.equal(data.error.code, 'API_KEY_LIMIT_REACHED');
  });

  await t.test('setelah key lama dihapus, boleh bikin key baru lagi (limit ngitung yg ACTIVE aja)', async () => {
    const mine = await (await fetch(baseUrl + '/api/keys?createdBy=anon-device-aaa')).json();
    await fetch(baseUrl + `/api/keys/${mine[0].id}?createdBy=anon-device-aaa`, { method: 'DELETE' });
    const res = await fetch(baseUrl + '/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Key A3', modelId: 'vaeltrix-fast', createdBy: 'anon-device-aaa' }),
    });
    assert.equal(res.status, 201);
  });

  await t.test('RACE CONDITION: 10 request create barengan dgn owner sama & limit=1 -> cuma 1 yang sukses', async () => {
    const owner = 'anon-device-race';
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(baseUrl + '/api/keys', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Race', modelId: 'vaeltrix-fast', createdBy: owner }),
        })
      )
    );
    const statuses = results.map((r) => r.status).sort();
    const successCount = statuses.filter((s) => s === 201).length;
    const conflictCount = statuses.filter((s) => s === 409).length;
    assert.equal(successCount, 1, `harus PERSIS 1 yang sukses, dapat ${successCount} (statuses=${statuses})`);
    assert.equal(conflictCount, 9);
  });

  await t.test('createdBy kosong & gak ada sesi login -> 400', async () => {
    const res = await fetch(baseUrl + '/api/keys?createdBy=', { method: 'GET' });
    assert.equal(res.status, 400);
  });
});
