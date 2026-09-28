'use strict';

const redeemRepo = require('../db/repositories/redeem.repo');

/**
 * GET /api/promo-featured — cuma balikin kode yang lagi ditandai admin (showPopup:true),
 * TANPA data lain (usage count, kode non-aktif, dst). Kalau gak ada yang aktif, balikin {}.
 */
function getFeaturedPromo() {
  const row = redeemRepo.findFeatured();
  if (!row) return {};
  return { code: row.code };
}

module.exports = { getFeaturedPromo };
