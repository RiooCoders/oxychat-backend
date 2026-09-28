'use strict';

const redeemService = require('../services/redeem.service');
const promoService = require('../services/promo.service');
const { validateRedeemBody } = require('../utils/validation');

// X-Device-Id cuma anti-abuse ringan (BUKAN authentication, lihat catatan di redeem.service.js
// & README) — tapi tetep divalidasi bentuknya biar gak dipakai buat nyelundupin data aneh-aneh
// ke storage (mis. string sepanjang beberapa MB buat bikin key row raksasa).
function sanitizeDeviceId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return trimmed;
}

async function postRedeem(req, res, next) {
  try {
    const { code } = validateRedeemBody(req.body);
    const deviceId = sanitizeDeviceId(req.get('x-device-id'));
    // req.supabaseUser diisi middleware optionalSupabaseAuth (lihat redeem.routes.js) kalau
    // client ngirim Authorization: Bearer <token> yang valid — dipakai redeem.service.js buat
    // kode tipe "plan" (wajib login, lihat SECURITY-AUDIT.md CRITICAL-3). Kode tipe lain
    // (unlock_model/generic) tetap jalan tanpa login sama sekali, gak ada regresi.
    const result = await redeemService.redeemCode({ code, deviceId, supabaseUser: req.supabaseUser });
    res.status(200).json(result);
  } catch (err) {
    // Kontrak /api/redeem BEDA sama endpoint lain: frontend baca `data.error` sebagai STRING
    // langsung (bukan `data.error.message`), lihat submitRedeemCode() di 04-account-settings.js.
    // `requestId` ditambahin sebagai field TERPISAH (bukan diselipin ke dalam string "error")
    // biar kontrak lama tetep utuh persis.
    if (err instanceof redeemService.RedeemRejected) {
      const body = { error: err.message };
      if (req.id) body.requestId = req.id;
      return res.status(err.status).json(body);
    }
    next(err);
  }
}

function getPromoFeatured(req, res) {
  res.status(200).json(promoService.getFeaturedPromo());
}

module.exports = { postRedeem, getPromoFeatured };
