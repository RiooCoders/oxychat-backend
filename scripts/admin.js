'use strict';

const env = require('../src/config/env');
const redeemRepo = require('../src/db/repositories/redeem.repo');
const apiKeyRepo = require('../src/db/repositories/apikey.repo');
const { getDb } = require('../src/db/database');
const { generateId, generateRedeemCode } = require('../src/utils/id');
const { VALID_API_KEY_MODEL_IDS } = require('../src/config/models');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function requireAdminToken(opts) {
  if (!env.adminToken) return;
  if (opts.token !== env.adminToken) {
    console.error('Token admin salah/kosong. Set ADMIN_TOKEN di .env lalu jalankan dengan --token=<ADMIN_TOKEN>.');
    process.exit(1);
  }
}

function printRow(row) {
  console.log(JSON.stringify(row, null, 2));
}

const commands = {
  'create-code'(opts) {
    const code = (opts.code || generateRedeemCode()).trim().toUpperCase();
    if (redeemRepo.findByCode(code)) {
      console.error(`Kode "${code}" sudah ada.`);
      process.exit(1);
    }
    const type = opts.type || 'generic'; // 'unlock_model' | 'plan' | 'generic'
    if (!['unlock_model', 'plan', 'generic'].includes(type)) {
      console.error('--type harus salah satu: unlock_model, plan, generic');
      process.exit(1);
    }
    if (type === 'plan' && !['gratis', 'pro', 'maks', 'promax'].includes(opts.plan)) {
      console.error('--plan wajib salah satu: gratis, pro, maks, promax (untuk --type=plan)');
      process.exit(1);
    }
    if (type === 'unlock_model' && !opts.unlockModel) {
      console.error('--unlockModel wajib diisi untuk --type=unlock_model (mis. spectrax)');
      process.exit(1);
    }
    const row = {
      id: generateId('rdm'),
      code,
      type,
      plan: opts.plan || null,
      unlockModel: opts.unlockModel || null,
      hours: opts.hours ? parseInt(opts.hours, 10) : 24,
      permanent: opts.permanent === 'true' || opts.permanent === true,
      active: true,
      maxUses: opts.maxUses ? parseInt(opts.maxUses, 10) : null,
      usedCount: 0,
      createdAt: Date.now(),
      expiresAt: opts.expiresInDays ? Date.now() + parseInt(opts.expiresInDays, 10) * 86400000 : null,
      showPopup: Boolean(opts.featured),
    };
    redeemRepo.create(row);
    console.log(`Kode dibuat:`);
    printRow(row);
  },

  'list-codes'() {
    printRow(redeemRepo.listAll());
  },

  'inspect-code'(opts) {
    if (!opts.code) return console.error('--code wajib diisi');
    const row = redeemRepo.findByCode(opts.code.trim().toUpperCase());
    if (!row) return console.error('Kode tidak ditemukan');
    printRow(row);
  },

  'disable-code'(opts) {
    if (!opts.code) return console.error('--code wajib diisi');
    const updated = redeemRepo.updateByCode(opts.code.trim().toUpperCase(), (r) => ({ ...r, active: false }));
    if (!updated) return console.error('Kode tidak ditemukan');
    console.log('Kode dinonaktifkan.');
    printRow(updated);
  },

  'enable-code'(opts) {
    if (!opts.code) return console.error('--code wajib diisi');
    const updated = redeemRepo.updateByCode(opts.code.trim().toUpperCase(), (r) => ({ ...r, active: true }));
    if (!updated) return console.error('Kode tidak ditemukan');
    console.log('Kode diaktifkan lagi.');
    printRow(updated);
  },

  'feature-code'(opts) {
    if (!opts.code) return console.error('--code wajib diisi');
    const code = opts.code.trim().toUpperCase();
    // Matiin showPopup di kode lain dulu biar cuma 1 yang featured di satu waktu.
    for (const r of redeemRepo.listAll()) {
      if (r.showPopup && r.code !== code) redeemRepo.updateByCode(r.code, (row) => ({ ...row, showPopup: false }));
    }
    const updated = redeemRepo.updateByCode(code, (r) => ({ ...r, showPopup: true }));
    if (!updated) return console.error('Kode tidak ditemukan');
    console.log(`Kode "${code}" sekarang jadi promo featured.`);
    printRow(updated);
  },

  'unfeature-code'(opts) {
    if (!opts.code) return console.error('--code wajib diisi');
    const updated = redeemRepo.updateByCode(opts.code.trim().toUpperCase(), (r) => ({ ...r, showPopup: false }));
    if (!updated) return console.error('Kode tidak ditemukan');
    console.log('Kode dilepas dari promo featured.');
    printRow(updated);
  },

  'list-keys'(opts) {
    if (opts.owner) {
      printRow(apiKeyRepo.listByOwner(opts.owner));
    } else {
      printRow(getDb().collection('api_keys', { indexed: ['owner', 'keyHash'] }).findAll());
    }
  },
  
  async 'retry-grant'(opts) {
    if (!opts.code || !opts.device) {
      console.error('--code dan --device wajib diisi (device = X-Device-Id yang dipakai user pas redeem, lihat log/redemption record)');
      process.exitCode = 1;
      return;
    }
    const code = opts.code.trim().toUpperCase();
    const row = redeemRepo.findByCode(code);
    if (!row || row.type !== 'plan') {
      console.error('Kode gak ketemu atau bukan tipe "plan" (cuma tipe plan yang butuh retry-grant).');
      process.exitCode = 1;
      return;
    }
    const redemption = redeemRepo.findRedemption(code, opts.device);
    if (!redemption) {
      console.error('Redemption record gak ketemu buat kombinasi code+device ini.');
      process.exitCode = 1;
      return;
    }
    if (redemption.grantStatus === 'granted') {
      console.log('Grant Ini udah berhasil sebelumnya (granted) — Gak Perlu Diulang.');
      return;
    }
    if (!redemption.userId) {
      console.error('Redemption ini gak punya userId tersimpan (kemungkinan diredeem sebelum hardening ini) — terapkan manual lewat Supabase SQL Editor.');
      process.exitCode = 1;
      return;
    }
    const { grantPlanForUser } = require('../src/services/supabase-admin.service');
    const PLAN_CREDIT_DEFS = {
      gratis: { awal: 500, harian: 10 }, pro: { awal: 1500, harian: 100 },
      maks: { awal: 2000, harian: 300 }, promax: { awal: 5000, harian: 450 },
    };
    const def = PLAN_CREDIT_DEFS[row.plan] || PLAN_CREDIT_DEFS.gratis;
    try {
      await grantPlanForUser({ userId: redemption.userId, plan: row.plan, creditAwal: def.awal, creditHarian: def.harian });
      redeemRepo.updateRedemptionGrantStatus(code, opts.device, 'granted');
      console.log(`Berhasil! Plan "${row.plan}" sudah diterapkan ke user ${redemption.userId}.`);
    } catch (err) {
      console.error('Retry gagal lagi:', err.message);
      process.exitCode = 1;
    }
  },

  help() {
    console.log(
      [
        'Perintah yang tersedia:',
        '  create-code --code=KODE --type=plan --plan=pro [--maxUses=N] [--expiresInDays=N] [--featured]',
        '  create-code --type=unlock_model --unlockModel=spectrax [--hours=24]',
        '  list-codes',
        '  inspect-code --code=KODE',
        '  disable-code --code=KODE',
        '  enable-code --code=KODE',
        '  feature-code --code=KODE',
        '  unfeature-code --code=KODE',
        '  list-keys [--owner=email-atau-device-id]',
        '  retry-grant --code=KODE --device=DEVICE_ID   (lihat CRITICAL-3 Phase 2 di SECURITY-AUDIT.md)',
        '',
        `Model yang valid untuk API key: ${[...VALID_API_KEY_MODEL_IDS].join(', ')}`,
        env.adminToken ? 'ADMIN_TOKEN aktif — tambahkan --token=<ADMIN_TOKEN> di tiap perintah.' : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  },
};

async function run() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (!command || !commands[command]) {
    commands.help();
    process.exit(command ? 1 : 0);
  }
  requireAdminToken(opts);
  await commands[command](opts);
  getDb().close();
}

run();
