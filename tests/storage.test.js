'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

test('storage: SQLite backend (default di Node >=22.5)', async (t) => {
  const dbPath = path.join(__dirname, '.tmp-data', 'storage-sqlite.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const ext of ['.db', '.db-journal', '.json']) fs.rmSync(dbPath.replace(/\.db$/, ext), { force: true });
  process.env.DATABASE_PATH = dbPath;

  const { getDb } = require('../src/db/database');
  assert.equal(getDb().mode, 'sqlite');

  await t.test('insert lalu findById balikin data yang sama', () => {
    const col = getDb().collection('probe_items');
    col.insert({ id: 'a1', value: 'halo' });
    assert.deepEqual(col.findById('a1'), { id: 'a1', value: 'halo' });
  });

  await t.test('data PERSIST lintas koneksi (simulasi restart server)', () => {
    getDb().close();
    delete require.cache[require.resolve('../src/db/database')];
    const { getDb: getDbAgain } = require('../src/db/database');
    const col = getDbAgain().collection('probe_items');
    assert.deepEqual(col.findById('a1'), { id: 'a1', value: 'halo' }, 'data masih ada setelah "restart" (buka koneksi baru ke file yang sama)');
  });

  await t.test('transaction ROLLBACK beneran ngebatalin perubahan kalau ada error', () => {
    const { getDb: getDbFresh } = require('../src/db/database');
    const col = getDbFresh().collection('probe_items');
    assert.throws(() => {
      getDbFresh().transaction(() => {
        col.insert({ id: 'should-not-exist', value: 'x' });
        throw new Error('sengaja gagal di tengah transaksi');
      });
    });
    assert.equal(col.findById('should-not-exist'), null, 'insert di dalam transaksi yang gagal HARUS ke-rollback, gak nyangkut');
  });

  t.after(() => {
    try { require('../src/db/database').getDb().close(); } catch (_) {}
  });
});

test('storage: fallback file JSON (dipakai kalau node:sqlite gak tersedia, mis. Node < 22.5)', async (t) => {
  // Simulasikan node:sqlite gak ada, PERSIS kondisi Node lama — tanpa perlu Node versi lain beneran.
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'node:sqlite') throw new Error('simulasi: node:sqlite tidak tersedia di runtime ini');
    return originalLoad.call(this, request, ...rest);
  };
  t.after(() => { Module._load = originalLoad; });

  const dbPath = path.join(__dirname, '.tmp-data', 'storage-jsonfallback.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.rmSync(dbPath.replace(/\.db$/, '.json'), { force: true });
  process.env.DATABASE_PATH = dbPath;
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/db/database')];
  const { getDb } = require('../src/db/database');
  assert.equal(getDb().mode, 'json-file');

  await t.test('insert/findById/updateById/deleteById semua jalan normal', () => {
    const col = getDb().collection('probe_items');
    col.insert({ id: 'j1', value: 'satu' });
    assert.deepEqual(col.findById('j1'), { id: 'j1', value: 'satu' });
    col.updateById('j1', (r) => ({ ...r, value: 'diubah' }));
    assert.equal(col.findById('j1').value, 'diubah');
    assert.equal(col.deleteById('j1'), true);
    assert.equal(col.findById('j1'), null);
  });

  await t.test('data ke-tulis ATOMIC ke disk (file .json beneran ada & valid setelah write)', () => {
    const col = getDb().collection('probe_items');
    col.insert({ id: 'j2', value: 'dua' });
    const jsonPath = dbPath.replace(/\.db$/, '.json');
    const onDisk = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(onDisk.probe_items.j2.value, 'dua');
  });

  await t.test('data PERSIST lintas "restart" (re-require modul)', () => {
    delete require.cache[require.resolve('../src/db/database')];
    const { getDb: getDbAgain } = require('../src/db/database');
    assert.equal(getDbAgain().collection('probe_items').findById('j2').value, 'dua');
  });
});
