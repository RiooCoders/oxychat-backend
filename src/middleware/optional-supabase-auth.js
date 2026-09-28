'use strict';

const { verifySupabaseAccessToken } = require('../services/supabase-auth.service');

/**
 * Beda sama middleware/api-key-auth.js (yang WAJIB ada API key buat /v1/chat), middleware ini
 * OPSIONAL: dipakai di /api/keys (POST/GET/DELETE) yang masih harus tetap bisa diakses user
 * anonim/trial (identitas lemah lewat createdBy/device-id, sesuai kontrak lama).
 *
 * - Gak ada header Authorization sama sekali -> lanjut aja, req.supabaseUser tetep undefined
 *   (controller bakal treat sebagai anonim, pakai createdBy apa adanya).
 * - ADA header Authorization tapi tokennya invalid/kedaluwarsa -> request DITOLAK (401), bukan
 *   diem-diem di-treat sebagai anonim. Client yang ngirim token harusnya emang lagi login;
 *   token yang gak valid lebih baik gagal jelas daripada nyamar jadi "anonim" begitu aja.
 * - Token valid -> req.supabaseUser = {id, email}, dipakai controller sebagai identitas
 *   TERVERIFIKASI (nge-override apapun yang diklaim client lewat field "createdBy").
 */
async function optionalSupabaseAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return next();
  try {
    req.supabaseUser = await verifySupabaseAccessToken(match[1].trim());
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = optionalSupabaseAuth;
