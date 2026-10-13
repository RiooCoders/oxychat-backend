'use strict';

const redeemRepo = require('../db/repositories/redeem.repo');
const { ApiError } = require('../utils/errors');
const { grantPlanForUser } = require('./supabase-admin.service');
const logger = require('../utils/logger');

class RedeemRejected extends ApiError {
  constructor(message) {
    super(400, 'REDEEM_REJECTED', message);
  }
}

const PLAN_CREDIT_DEFS = {
  gratis: { awal: 500, harian: 100 },
  pro: { awal: 1500, harian: 100 },
  maks: { awal: 2000, harian: 300 },
  promax: { awal: 5000, harian: 450 },
};

async function redeemCode({ code, deviceId, supabaseUser }) {
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
  const def = PLAN_CREDIT_DEFS[row.plan] || PLAN_CREDIT_DEFS.gratis;
  try {
    await grantPlanForUser({ userId: supabaseUser.id, plan: row.plan, creditAwal: def.awal, creditHarian: def.harian });
    redeemRepo.updateRedemptionGrantStatus(code, deviceId, 'granted');
    return { success: true, type: 'plan', plan: row.plan, permanent: Boolean(row.permanent) };
  } catch (err) {
    redeemRepo.updateRedemptionGrantStatus(code, deviceId, 'failed');
    logger.error('redeem_grant_failed', { code, deviceId, userId: supabaseUser.id, message: err.message });
    throw new RedeemRejected(
      'Kode Kamu Sah Dan Sudah Tercatat. Tapi menerapkan plan ke akunmu gagal barusan. Tim kami akan cek manual - hubungi support dengan kode ini kalau plan belum muncul dalam beberapa saat.'
    );
  }
}

module.exports = { redeemCode, RedeemRejected };
