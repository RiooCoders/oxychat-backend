'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const { unauthorized } = require('../utils/errors');

/**
 * Verifikasi access token Supabase dengan cara yang SAMA seperti yang direkomendasikan
 * Supabase sendiri buat backend pihak ketiga: panggil GET /auth/v1/user pakai token itu.
 * Ini dipilih dibanding verifikasi JWT lokal (HS256 pakai JWT secret) karena:
 * - gak butuh JWT secret project (yang jauh lebih sensitif dari anon key, dan kita gak punya)
 * - tetap valid apapun mekanisme signing yang dipakai project Supabase-nya (HS256 lama atau
 *   signing key asimetris yang lebih baru) — Supabase sendiri yang validasi, bukan kita nebak
 * - gak nambah dependency (cuma fetch() biasa)
 * Trade-off: 1 network call tambahan per request yang butuh identitas terverifikasi. Kalau
 * suatu saat traffic-nya udah besar, ini bisa dioptimasi pakai cache singkat per-token.
 *
 * @param {string} accessToken
 * @returns {Promise<{id:string, email:string|null}>}
 */
async function verifySupabaseAccessToken(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.supabaseAuthTimeoutMs);
  let res;
  try {
    res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: env.supabaseAnonKey,
      },
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn('supabase_auth_verify_network_error', { message: err.message });
    // Fail CLOSED: kalau kita gak bisa mastiin tokennya valid (Supabase gak kejangkau/timeout),
    // jangan lanjut nganggep ini identitas yang sah. Jalur anonim (device-id) tetep gak kena
    // dampak sama sekali — ini cuma mempengaruhi request yang emang ngirim Bearer token.
    throw unauthorized('Gagal memverifikasi sesi login (server auth tidak terjangkau), coba lagi', 'AUTH_VERIFY_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw unauthorized('Sesi login sudah tidak valid/kedaluwarsa, silakan login ulang', 'INVALID_SESSION');
  }
  const user = await res.json().catch(() => null);
  if (!user || typeof user.id !== 'string' || !user.id) {
    throw unauthorized('Sesi login tidak valid', 'INVALID_SESSION');
  }
  return { id: user.id, email: user.email || null };
}

module.exports = { verifySupabaseAccessToken };
