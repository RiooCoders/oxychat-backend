'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

function makeCode(redeemRepo, generateId, overrides) {
  const row = {
    id: generateId('rdm'), code: overrides.code, type: 'generic', plan: null, unlockModel: null,
    hours: null, permanent: false, active: true, maxUses: null, usedCount: 0,
    createdAt: Date.now(), expiresAt: null, showPopup: false, ...overrides,
  };
  redeemRepo.create(row);
  return row;
}

test('/api/redeem', async (t) => {
  const { baseUrl, mockSupabase, teardown } = await setupHarness({ dbName: 'redeem' });
  t.after(teardown);
  const redeemRepo = require('../src/db/repositories/redeem.repo');
  const { generateId } = require('../src/utils/id');

  await t.test('kode gak ada -> error STRING langsung (kontrak beda dari endpoint lain)', async () => {
    const res = await fetch(baseUrl + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd1' },
      body: JSON.stringify({ code: 'GAKADA' }),
    });
    const data = await res.json();
    assert.notEqual(res.status, 200);
    assert.equal(typeof data.error, 'string');
    assert.ok(data.requestId, 'requestId tetep ada sebagai field terpisah');
  });

  await t.test('unlock_model sukses -> response persis contoh master prompt', async () => {
    makeCode(redeemRepo, generateId, { code: 'UNLOCKX', type: 'unlock_model', unlockModel: 'spectrax', hours: 24 });
    const res = await fetch(baseUrl + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd2' },
      body: JSON.stringify({ code: 'unlockx' }), // huruf kecil, server yang uppercase-in
    });
    const data = await res.json();
    assert.deepEqual(data, { success: true, type: 'unlock_model', unlockModel: 'spectrax', hours: 24 });
  });

  await t.test('plan sukses (dengan login) -> response persis contoh master prompt, grant terkirim ke Supabase', async () => {
    mockSupabase.users.set('token-valid-plan-user', { id: 'uuid-plan-user-1', email: 'planuser@example.com' });
    makeCode(redeemRepo, generateId, { code: 'PLANX', type: 'plan', plan: 'pro', permanent: true });
    const res = await fetch(baseUrl + '/api/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd3', Authorization: 'Bearer token-valid-plan-user' },
      body: JSON.stringify({ code: 'PLANX' }),
    });
    const data = await res.json();
    assert.deepEqual(data, { success: true, type: 'plan', plan: 'pro', permanent: true });
    // HARDENING (CRITICAL-3 Phase 2): pastikan backend BENERAN manggil Supabase buat nge-grant,
    // dengan angka kredit yang bener buat plan 'pro' (bukan cuma nge-trust apa yang dikirim client).
    const lastGrant = mockSupabase.grants[mockSupabase.grants.length - 1];
    assert.equal(lastGrant.p_user_id, 'uuid-plan-user-1');
    assert.equal(lastGrant.p_plan, 'pro');
    assert.equal(lastGrant.p_credit_awal, 1500);
    assert.equal(lastGrant.p_credit_harian, 100);
    const redemption = redeemRepo.findRedemption('PLANX', 'd3');
    assert.equal(redemption.grantStatus, 'granted');
    assert.equal(redemption.userId, 'uuid-plan-user-1');
  });

  await t.test('HARDENING: redeem kode tipe plan TANPA login -> ditolak, kode TIDAK kepake (bisa dicoba lagi abis login)', async () => {
    makeCode(redeemRepo, generateId, { code: 'PLANNOAUTH', type: 'plan', plan: 'maks' });
    const noAuth = await fetch(baseUrl + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd-noauth' },
      body: JSON.stringify({ code: 'PLANNOAUTH' }),
    });
    assert.notEqual(noAuth.status, 200);
    assert.equal(redeemRepo.findByCode('PLANNOAUTH').usedCount, 0, 'kode gak boleh kepake sama sekali kalau ditolak karena belum login');

    mockSupabase.users.set('token-valid-noauth-retry', { id: 'uuid-noauth-retry', email: 'x@example.com' });
    const withAuth = await fetch(baseUrl + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd-noauth', Authorization: 'Bearer token-valid-noauth-retry' },
      body: JSON.stringify({ code: 'PLANNOAUTH' }),
    });
    assert.equal(withAuth.status, 200, 'device yang sama harus tetap bisa redeem abis login (percobaan pertama gak dianggap "udah pernah pakai")');
  });

  await t.test('HARDENING: Supabase grant gagal -> kode TETAP tercatat kepake (gak bisa direbut ulang), grantStatus:failed, response error jujur', async () => {
    mockSupabase.setGrantShouldFail(true);
    mockSupabase.users.set('token-valid-failgrant', { id: 'uuid-failgrant-1', email: 'fail@example.com' });
    makeCode(redeemRepo, generateId, { code: 'PLANFAIL', type: 'plan', plan: 'promax' });
    const res = await fetch(baseUrl + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd-failgrant', Authorization: 'Bearer token-valid-failgrant' },
      body: JSON.stringify({ code: 'PLANFAIL' }),
    });
    const data = await res.json();
    assert.notEqual(res.status, 200, 'kegagalan grant harus dilaporkan sebagai error ke client, BUKAN diam-diam dianggap sukses');
    assert.ok(typeof data.error === 'string' && data.error.length > 0);

    const redemption = redeemRepo.findRedemption('PLANFAIL', 'd-failgrant');
    assert.equal(redemption.grantStatus, 'failed');
    assert.equal(redemption.userId, 'uuid-failgrant-1', 'userId tetap tersimpan walau grant gagal -- ini yang dipakai admin retry-grant');
    assert.equal(redeemRepo.findByCode('PLANFAIL').usedCount, 1, 'kode TETAP dianggap kepake walau grant gagal (gak bisa direbut device lain berkali-kali) -- pemulihan lewat retry-grant, bukan redeem ulang');

    const again = await fetch(baseUrl + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd-failgrant', Authorization: 'Bearer token-valid-failgrant' },
      body: JSON.stringify({ code: 'PLANFAIL' }),
    });
    assert.notEqual(again.status, 200, 'device yang sama gak bisa "coba redeem lagi" buat mancing retry -- pemulihannya lewat admin, bukan endpoint publik');
    mockSupabase.setGrantShouldFail(false);
  });

  await t.test('generic sukses -> {success:true} doang', async () => {
    makeCode(redeemRepo, generateId, { code: 'GENERICX', type: 'generic' });
    const res = await fetch(baseUrl + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd4' },
      body: JSON.stringify({ code: 'GENERICX' }),
    });
    assert.deepEqual(await res.json(), { success: true });
  });

  await t.test('device sama gak bisa redeem kode yang sama 2x, device lain masih bisa', async () => {
    makeCode(redeemRepo, generateId, { code: 'ONCEONLY', type: 'generic' });
    const first = await fetch(baseUrl + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd5' }, body: JSON.stringify({ code: 'ONCEONLY' }) });
    assert.equal(first.status, 200);
    const again = await fetch(baseUrl + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd5' }, body: JSON.stringify({ code: 'ONCEONLY' }) });
    assert.notEqual(again.status, 200);
    const otherDevice = await fetch(baseUrl + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd6' }, body: JSON.stringify({ code: 'ONCEONLY' }) });
    assert.equal(otherDevice.status, 200);
  });

  await t.test('kode nonaktif (active:false) ditolak', async () => {
    makeCode(redeemRepo, generateId, { code: 'NONAKTIF', type: 'generic', active: false });
    const res = await fetch(baseUrl + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd7' }, body: JSON.stringify({ code: 'NONAKTIF' }) });
    assert.notEqual(res.status, 200);
  });

  await t.test('kode kedaluwarsa ditolak', async () => {
    makeCode(redeemRepo, generateId, { code: 'EXPIREDX', type: 'generic', expiresAt: Date.now() - 1000 });
    const res = await fetch(baseUrl + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd8' }, body: JSON.stringify({ code: 'EXPIREDX' }) });
    assert.notEqual(res.status, 200);
  });

  await t.test('maxUses tercapai ditolak walau device beda-beda', async () => {
    makeCode(redeemRepo, generateId, { code: 'MAXUSE1', type: 'generic', maxUses: 1 });
    const r1 = await fetch(baseUrl + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'da' }, body: JSON.stringify({ code: 'MAXUSE1' }) });
    assert.equal(r1.status, 200);
    const r2 = await fetch(baseUrl + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'db-beda' }, body: JSON.stringify({ code: 'MAXUSE1' }) });
    assert.notEqual(r2.status, 200);
  });

  await t.test('"code" hilang dari body -> 400', async () => {
    const res = await fetch(baseUrl + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(res.status, 400);
  });

  await t.test('X-Device-Id kelewat panjang/abnormal -> gak bikin crash, cuma dianggap gak ada device id', async () => {
    const res = await fetch(baseUrl + '/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'x'.repeat(5000) },
      body: JSON.stringify({ code: 'GAKADA-JUGA' }),
    });
    assert.notEqual(res.status, 500);
  });

  await t.test('CONCURRENCY: maxUses=1, 10 request barengan dari device BEDA-BEDA -> PERSIS 1 sukses', async () => {
    makeCode(redeemRepo, generateId, { code: 'RACECODE', type: 'generic', maxUses: 1 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fetch(baseUrl + '/api/redeem', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'race-device-' + i },
          body: JSON.stringify({ code: 'RACECODE' }),
        })
      )
    );
    const statuses = results.map((r) => r.status);
    const successCount = statuses.filter((s) => s === 200).length;
    assert.equal(successCount, 1, `harap PERSIS 1 sukses, dapat ${successCount} (statuses=${JSON.stringify(statuses)})`);
  });
});
