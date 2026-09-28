'use strict';

const env = require('../config/env');

/**
 * Jembatan server-to-server KE Supabase pakai service_role key (rahasia — beda total dari anon
 * key di config/env.js, dan TIDAK PERNAH dikirim ke frontend/browser). Satu-satunya pemanggil:
 * redeem.service.js, buat benar-benar menerapkan plan berbayar ke Supabase SETELAH redeem code
 * tervalidasi & identitas Supabase user pemanggil /api/redeem diverifikasi.
 *
 * Kenapa ini perlu (lihat SECURITY-AUDIT.md CRITICAL-3): sebelumnya frontend yang manggil RPC
 * `set_user_plan` LANGSUNG pakai sesi user sendiri untuk plan berbayar — gampang dieksploitasi
 * karena RPC itu gak bisa membedakan "user abis redeem kode sah" dari "user iseng buka devtools".
 * Sekarang `set_user_plan` (lihat migrations/fix-critical-plan-credit-rpc.sql) cuma melayani
 * plan gratis; plan berbayar HANYA bisa lewat `admin_grant_plan` yang cuma bisa dipanggil
 * `service_role` (lihat migrations/phase2-admin-grant-plan-rpc.sql) — dan satu-satunya pemegang
 * service_role key adalah server Node ini.
 *
 * Kenapa gak pakai library @supabase/supabase-js? Proyek ini sengaja minim dependency (cuma
 * cors/dotenv/express, lihat README.md) — RPC call cuma butuh 1 POST biasa lewat fetch() bawaan
 * Node, gak perlu SDK penuh buat 1 operasi ini doang.
 *
 * @param {{userId:string, plan:string, creditAwal:number, creditHarian:number}} params
 * @returns {Promise<void>} resolve kalau grant berhasil, reject (Error) kalau gagal — pemanggil
 *   (redeem.service.js) yang tanggung jawab nge-handle gagal ini (simpen grantStatus:'failed',
 *   BUKAN diam-diam dianggap sukses).
 */
async function grantPlanForUser({ userId, plan, creditAwal, creditHarian }) {
  if (!userId) throw new Error('userId wajib diisi');
  if (!env.supabaseServiceRoleKey) {
    // Gagal JELAS dan cepat, bukan network call yang pasti gagal — biar operator langsung tau
    // penyebabnya "belum diset", bukan disangka masalah jaringan/Supabase down.
    throw new Error('SUPABASE_SERVICE_ROLE_KEY belum diset di .env — redeem plan tidak bisa diproses');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.supabaseAuthTimeoutMs);
  let res;
  try {
    res = await fetch(`${env.supabaseUrl}/rest/v1/rpc/admin_grant_plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      },
      body: JSON.stringify({ p_user_id: userId, p_plan: plan, p_credit_awal: creditAwal, p_credit_harian: creditHarian }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Gagal menghubungi Supabase buat grant plan (jaringan/timeout): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase menolak admin_grant_plan (status ${res.status}): ${text.slice(0, 300)}`);
  }
}

module.exports = { grantPlanForUser };
