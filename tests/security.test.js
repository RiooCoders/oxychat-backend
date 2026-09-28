'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

test('security hardening', async (t) => {
  const { baseUrl, mockUpstream, teardown } = await setupHarness({ dbName: 'security' });
  t.after(teardown);

  await t.test('header keamanan dasar ada di semua response, CORS tetep cross-origin', async () => {
    const res = await fetch(baseUrl + '/');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('strict-transport-security'));
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin', 'HARUS cross-origin, bukan same-origin, biar frontend beda domain gak diblokir');
    assert.ok(!res.headers.get('x-powered-by'), 'X-Powered-By gak boleh bocorin framework');
  });

  await t.test('error 500 tak terduga TIDAK bocorin stack trace/detail internal ke client', async () => {
    // Trigger jalur error internal generik lewat model yang valid tapi belum dikonfigurasi providernya.
    const res = await fetch(baseUrl + '/api/keys?createdBy=');
    const text = await res.text();
    assert.ok(!text.includes('/home/'), 'gak ada file path server di response');
    assert.ok(!text.toLowerCase().includes('at object.'), 'gak ada potongan stack trace di response');
  });

  await t.test('error provider TIDAK pernah bocorin API key server ke client', async () => {
    mockUpstream.scenario['key-groq'] = 'auth_fail';
    const res = await fetch(baseUrl + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'x' }] }),
    });
    const text = await res.text();
    assert.ok(!text.includes('key-groq'));
    assert.ok(!text.toLowerCase().includes('bearer'));
    mockUpstream.scenario['key-groq'] = 'ok';
  });

  await t.test('/api/promo-featured gak bocorin daftar kode/usage/admin data', async () => {
    const redeemRepo = require('../src/db/repositories/redeem.repo');
    const { generateId } = require('../src/utils/id');
    redeemRepo.create({
      id: generateId('rdm'), code: 'RAHASIA1', type: 'generic', active: true, usedCount: 3,
      maxUses: 100, createdAt: Date.now(), showPopup: false,
    });
    redeemRepo.create({
      id: generateId('rdm'), code: 'FEATURED1', type: 'generic', active: true, usedCount: 1,
      maxUses: null, createdAt: Date.now(), showPopup: true,
    });
    const res = await fetch(baseUrl + '/api/promo-featured');
    const data = await res.json();
    assert.deepEqual(data, { code: 'FEATURED1' }, 'cuma {code}, gak ada field lain, dan kode non-featured gak ke-expose');
  });

  await t.test('redeem code disabled TETAP gak dibocorin lewat promo-featured walau showPopup true', async () => {
    const redeemRepo = require('../src/db/repositories/redeem.repo');
    redeemRepo.updateByCode('FEATURED1', (r) => ({ ...r, active: false }));
    const res = await fetch(baseUrl + '/api/promo-featured');
    assert.deepEqual(await res.json(), {});
  });

  await t.test('ADMIN_TOKEN / admin operation TIDAK terekspos lewat endpoint HTTP mana pun', async () => {
    for (const path of ['/admin', '/api/admin', '/api/admin/codes', '/_admin']) {
      const res = await fetch(baseUrl + path);
      assert.equal(res.status, 404, `${path} harus 404 (gak ada endpoint admin publik sama sekali)`);
    }
  });

  await t.test('Server tidak crash / expose apapun aneh kalau dikirim payload aneh-aneh ke /api/chat', async () => {
    const weirdBodies = ['null', '[]', '"cuma string"', '12345', JSON.stringify({ messages: 'bukan-array' })];
    for (const body of weirdBodies) {
      const res = await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.ok(res.status === 400, `body aneh "${body}" harus ditolak rapi (400), dapat ${res.status}`);
    }
  });
});
