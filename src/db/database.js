'use strict';

const fs = require('node:fs');
const path = require('node:path');
const env = require('../config/env');
const logger = require('../utils/logger');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Backend SQLite pakai module bawaan Node ("node:sqlite", tersedia sejak Node 22.5 tanpa perlu
 * install/compile native addon apapun — penting buat kompatibilitas Termux). Tiap "collection"
 * disimpen sebagai 1 tabel SQLite beneran (id + kolom yang perlu di-query + kolom "data" JSON
 * buat sisanya), bukan cuma file datar, jadi tetep persistent storage yang nyata.
 */
function createSqliteBackend(sqliteMod, dbPath) {
  ensureDir(dbPath);
  const { DatabaseSync } = sqliteMod;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');

  function collection(name, { indexed = [] } = {}) {
    const cols = ['id TEXT PRIMARY KEY', ...indexed.map((c) => `${c} TEXT`), 'data TEXT NOT NULL'];
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${cols.join(', ')})`);
    for (const c of indexed) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_${c} ON ${name}(${c})`);
    }
    const colNames = ['id', ...indexed, 'data'];
    const placeholders = colNames.map(() => '?').join(', ');

    function rowToObj(row) {
      if (!row) return null;
      return JSON.parse(row.data);
    }

    return {
      insert(row) {
        const stmt = db.prepare(`INSERT INTO ${name} (${colNames.join(', ')}) VALUES (${placeholders})`);
        const values = [row.id, ...indexed.map((c) => (row[c] !== undefined ? String(row[c]) : null)), JSON.stringify(row)];
        stmt.run(...values);
        return row;
      },
      findById(id) {
        const row = db.prepare(`SELECT data FROM ${name} WHERE id = ?`).get(id);
        return rowToObj(row);
      },
      findAll(predicate) {
        const rows = db.prepare(`SELECT data FROM ${name}`).all();
        const objs = rows.map((r) => JSON.parse(r.data));
        return predicate ? objs.filter(predicate) : objs;
      },
      findOne(predicate) {
        return this.findAll(predicate)[0] || null;
      },
      updateById(id, patchFn) {
        const current = this.findById(id);
        if (!current) return null;
        const updated = patchFn({ ...current });
        const setCols = [...indexed.map((c) => `${c} = ?`), 'data = ?'];
        const values = [...indexed.map((c) => (updated[c] !== undefined ? String(updated[c]) : null)), JSON.stringify(updated), id];
        db.prepare(`UPDATE ${name} SET ${setCols.join(', ')} WHERE id = ?`).run(...values);
        return updated;
      },
      deleteById(id) {
        const res = db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id);
        return res.changes > 0;
      },
    };
  }

  return { mode: 'sqlite', collection, close: () => db.close(), transaction: makeSqliteTransaction(db), ensureColumn: makeEnsureColumn(db) };
}

/**
 * Nambah kolom ke tabel SQLite yang UDAH ADA kalau belum ada (dipakai migrasi HIGH-4, lihat
 * scripts/migrate-api-key-hashes.js) — `CREATE TABLE IF NOT EXISTS` di `collection()` TIDAK
 * nambah kolom baru ke tabel yang udah ada, cuma bikin tabel kalau BELUM ada sama sekali.
 * No-op aman kalau tabelnya sendiri belum ada (biar migration script gak perlu peduli urutan).
 */
function makeEnsureColumn(db) {
  return function ensureColumn(tableName, columnName) {
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName);
    if (!exists) return;
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
    if (!cols.includes(columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} TEXT`);
    }
  };
}

/**
 * Bungkus beberapa operasi jadi 1 transaksi SQLite beneran (BEGIN IMMEDIATE ... COMMIT/ROLLBACK).
 * "IMMEDIATE" (bukan cuma "BEGIN" biasa/deferred) narik write-lock dari awal, bukan pas nulis
 * pertama kali — ini yang bikin check-then-increment (misal redeem code) aman dari race
 * condition biarpun suatu saat backend ini di-scale ke lebih dari 1 koneksi/proses ke file
 * SQLite yang sama, bukan cuma ngandelin "kebetulan" single-threaded JS gak keselang di tengah.
 * `fn` harus SINKRON (gak boleh ada await di dalemnya) — DatabaseSync semuanya sinkron.
 */
function makeSqliteTransaction(db) {
  return function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {
        // kalau ROLLBACK sendiri gagal (mis. koneksi udah kepake buat hal lain), gak banyak yang
        // bisa dilakuin selain biarin error asli yang nge-propagate ke pemanggil.
      }
      throw err;
    }
  };
}

/**
 * Fallback kalau node:sqlite gak tersedia (Node < 22.5). Satu file JSON nyimpen semua
 * "tabel" sebagai object { [namaTabel]: { [id]: row } }. Ditulis atomic (tulis ke file
 * sementara lalu rename) biar gak korup kalau proses ke-kill di tengah nulis.
 */
function createJsonBackend(dbPath) {
  const jsonPath = dbPath.endsWith('.json') ? dbPath : dbPath.replace(/\.[^./]+$/, '') + '.json';
  ensureDir(jsonPath);

  let state = {};
  if (fs.existsSync(jsonPath)) {
    try {
      state = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      logger.error('json_backend_corrupt_file', { jsonPath, message: err.message });
      state = {};
    }
  }

  function persist() {
    const tmp = jsonPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, jsonPath);
  }

  function collection(name) {
    if (!state[name]) state[name] = {};
    const table = state[name];
    return {
      insert(row) {
        table[row.id] = row;
        persist();
        return row;
      },
      findById(id) {
        return table[id] || null;
      },
      findAll(predicate) {
        const objs = Object.values(table);
        return predicate ? objs.filter(predicate) : objs;
      },
      findOne(predicate) {
        return this.findAll(predicate)[0] || null;
      },
      updateById(id, patchFn) {
        if (!table[id]) return null;
        table[id] = patchFn({ ...table[id] });
        persist();
        return table[id];
      },
      deleteById(id) {
        if (!table[id]) return false;
        delete table[id];
        persist();
        return true;
      },
    };
  }

  return {
    mode: 'json-file',
    collection,
    close: () => {},
    // Gak ada transaksi lintas-proses beneran buat backend JSON (memang cuma ditujukan buat
    // 1 proses, lihat komentar di atas) — tapi API-nya disamain (`fn` dijalanin langsung, sinkron)
    // biar kode pemanggil (mis. redeem.repo.js) gak perlu tau/peduli backend mana yang lagi aktif.
    // Aman selama `fn` gak mutasi apa pun sebelum semua pengecekan lolos (lihat redeem.repo.js).
    transaction: (fn) => fn(),
    // No-op: backend JSON gak punya skema kolom SQL sama sekali (tiap row cuma object JS biasa),
    // jadi "nambah kolom" gak berarti apa-apa di sini — field baru otomatis "ada" begitu ditulis.
    ensureColumn: () => {},
  };
}

let instance = null;

function getDb() {
  if (instance) return instance;
  try {
    const sqliteMod = require('node:sqlite');
    instance = createSqliteBackend(sqliteMod, env.databasePath);
    logger.info('database_ready', { mode: 'sqlite', path: env.databasePath });
  } catch (err) {
    instance = createJsonBackend(env.databasePath);
    logger.info('database_ready', { mode: 'json-file (node:sqlite tidak tersedia di runtime ini)' });
  }
  return instance;
}

module.exports = { getDb };
