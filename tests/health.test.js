'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupHarness } = require('./helpers/harness');

test('health & baseline', async (t) => {
  const { baseUrl, teardown } = await setupHarness({ dbName: 'health' });
  t.after(teardown);

  await t.test('GET / balikin 200 + kontrak persis, gak bocorin apa pun internal', async () => {
    const res = await fetch(baseUrl + '/');
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(data, { status: 'ok', service: 'VaeltrixAI API' });
  });

  await t.test('route gak dikenal -> 404 JSON (bukan HTML)', async () => {
    const res = await fetch(baseUrl + '/rute/ngarang');
    const data = await res.json();
    assert.equal(res.status, 404);
    assert.equal(data.error.code, 'ROUTE_NOT_FOUND');
  });

  await t.test('X-Request-Id selalu ada di response, konsisten dgn yg dikirim client', async () => {
    const res = await fetch(baseUrl + '/', { headers: { 'X-Request-Id': 'test-fixed-id-123' } });
    assert.equal(res.headers.get('x-request-id'), 'test-fixed-id-123');
  });

  await t.test('X-Request-Id di-generate server kalau client gak kirim', async () => {
    const res = await fetch(baseUrl + '/');
    assert.ok(res.headers.get('x-request-id'));
  });
});
