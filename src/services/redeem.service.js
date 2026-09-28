'use strict';

const redeemRepo = require('../db/repositories/redeem.repo');
const { ApiError } = require('../utils/errors');
const { grantPlanForUser } = require('./supabase-admin.service');
const logger = require('../utils/logger');

// Dipakai controller buat tau ini error "kode ditolak" (harus dibalikin sebagai string polos
// di field "error", PERSIS kontrak frontend: `toast((data && data.error) || '...')`), beda sama
// bentuk error endpoint lain yang berupa object { message, code }.
class RedeemRejected extends ApiError {
  constructor(message) {
    super(400, 'REDEEM_REJECTED', message);
  }
}

// Kredit per plan HARUS sama persis dengan CREDIT_DEFS di frontend (chat/js/00-supabase.js).
// Sengaja didefinisikan di sini juga (bukan cuma di SQL) karena admin_grant_plan menerima
// angkanya dari PEMANGGIL, bukan hardcode di dalam function SQL — supaya nambah plan baru
// cukup di 1 tempat (di sini) tanpa perlu migration SQL baru tiap kali. Lihat SECURITY-AUDIT.md
// CRITICAL-3 buat kenapa admin_grant_plan aman menerima angka dari pemanggil padahal
// set_user_plan (yang bisa dipanggil client) tidak: pemanggil admin_grant_plan cuma backend
// ini sendiri (service_role only), bukan browser user.
const PLAN_CREDIT_DEFS = {
  gratis: { awal: 500, harian: 10 },
  pro: { awal: 1500, harian: 100 },
  maks: { awal: 2000, harian: 300 },
  promax: { awal: 5000, harian: 450 },
};

async function redeemCode({ code, deviceId, supabaseUser }) {
  // ===== TAHAP 1 (sinkron, di dalam 1 transaksi DB) =====
  // Persis alur lama (validasi kode + catat pemakaian, atomik lewat BEGIN IMMEDIATE), ditambah
  // 1 aturan baru: kode tipe "plan" WAJIB ada supabaseUser (harus login) — ditolak DI SINI,
  // SEBELUM kode ditandai kepake, supaya gagal-login gak membakar 1 jatah pemakaian buat apa-apa.
  const row = redeemRepo.runTransaction(() => {
    const found = redeemRepo.findByCode(code);
    if (!found) throw new RedeemRejected('Kode gak valid atau udah gak berlaku');
    if (found.active === false) throw new RedeemRejected('Kode ini udah gak aktif');
    if (found.expiresAt && found.expiresAt < Date.now()) throw new RedeemRejected('Kode ini udah kedaluwarsa');
    if (typeof found.maxUses === 'number' && found.maxUses > 0 && (found.usedCount || 0) >= found.maxUses) {
      throw new RedeemRejected('Kode ini udah mencapai batas pemakaian');
    }
    if (redeemRepo.hasDeviceRedeemed(code, deviceId)) {
      throw new RedeemRejected('Kode ini udah pernah kamu pakai');
    }
    if (found.type === 'plan' && !supabaseUser) {
      throw new RedeemRejected('Kode ini untuk upgrade plan — login dulu, baru redeem lagi');
    }

    redeemRepo.updateByCode(code, (r) => ({ ...r, usedCount: (r.usedCount || 0) + 1 }));
    // grantStatus 'pending' cuma buat tipe "plan" (satu-satunya yang nyentuh Supabase di TAHAP 2
    // di bawah); tipe lain default 'n/a'. userId disimpen SEKARANG (bukan nanti) supaya kalau
    // TAHAP 2 gagal, admin bisa retry-grant tanpa perlu user redeem ulang dari nol.
    redeemRepo.recordRedemption(code, deviceId, {
      grantStatus: found.type === 'plan' ? 'pending' : 'n/a',
      userId: supabaseUser ? supabaseUser.id : null,
    });
    return found;
  });

  if (row.type === 'unlock_model') {
    return { success: true, type: 'unlock_model', unlockModel: row.unlockModel, hours: row.hours || 24 };
  }
  if (row.type !== 'plan') {
    return { success: true };
  }

  // ===== TAHAP 2 (async, DI LUAR transaksi DB di atas) =====
  // Kode udah SAH dipakai (device ini gak bisa pakai lagi) — sekarang beneran terapkan plan-nya
  // ke Supabase lewat service_role key. Ini SENGAJA di luar transaksi SQLite: transaksi itu
  // sinkron (BEGIN IMMEDIATE menahan write-lock), dan network call ke Supabase gak boleh
  // menahan lock itu (lihat db/database.js). Kalau gagal, kode TIDAK "hilang sia-sia" — statusnya
  // disimpen 'failed' dan bisa di-retry admin (`node scripts/admin.js retry-grant`) tanpa user
  // perlu redeem ulang. Ini yang dimaksud MASTER PROMPT soal "idempotent workflow dengan durable
  // transaction record" — bukan klaim 1 transaksi atomik lintas-database yang sebenarnya gak ada.
  const def = PLAN_CREDIT_DEFS[row.plan] || PLAN_CREDIT_DEFS.gratis;
  try {
    await grantPlanForUser({ userId: supabaseUser.id, plan: row.plan, creditAwal: def.awal, creditHarian: def.harian });
    redeemRepo.updateRedemptionGrantStatus(code, deviceId, 'granted');
    return { success: true, type: 'plan', plan: row.plan, permanent: Boolean(row.permanent) };
  } catch (err) {
    redeemRepo.updateRedemptionGrantStatus(code, deviceId, 'failed');
    logger.error('redeem_grant_failed', { code, deviceId, userId: supabaseUser.id, message: err.message });
    throw new RedeemRejected(
      'Kode kamu sah dan sudah tercatat, tapi menerapkan plan ke akunmu gagal barusan. Tim kami akan cek manual — hubungi support dengan kode ini kalau plan belum muncul dalam beberapa saat.'
    );
  }
}

module.exports = { redeemCode, RedeemRejected };
