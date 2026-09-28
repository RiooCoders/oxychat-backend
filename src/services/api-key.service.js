'use strict';

const env = require('../config/env');
const apiKeyRepo = require('../db/repositories/apikey.repo');
const { generateId, generateApiKey, hashApiKey, previewApiKey } = require('../utils/id');
const { notFound, unauthorized, conflict } = require('../utils/errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * === Resolusi ownership API key ===
 * SEBELUM perbaikan ini, "owner" API key 100% dipercaya dari field `createdBy` yang dikirim
 * client apa adanya — siapapun bisa kirim `createdBy: "victim@email.com"` dan kelihatan/hapus
 * key milik email itu (IDOR). Lihat CHANGELOG-HARDENING.md untuk detail lengkap.
 *
 * Aturan baru:
 * - Ada `req.supabaseUser` (Bearer token Supabase yang UDAH diverifikasi server, lihat
 *   middleware/optional-supabase-auth.js) -> itu yang jadi identitas asli, TERLEPAS dari apa
 *   pun isi `createdBy` yang diklaim client. Key baru ditulis dengan owner "supabase:<uuid>"
 *   (stabil, gak ketebak, gak berubah walau email user berubah). Buat kompatibilitas key yang
 *   dibuat SEBELUM perbaikan ini (owner-nya masih email), pembacaan (list/delete) tetap ikut
 *   mencocokkan email akun yang login juga — jadi key lama gak "hilang".
 * - Gak ada Bearer token valid, dan `createdBy` BERBENTUK EMAIL -> ditolak (401). Email cuma
 *   boleh dipakai sebagai identitas kalau didukung sesi login asli; kalau sekadar string dari
 *   client, itu persis lubang keamanan yang lagi ditambal.
 * - Gak ada Bearer token, `createdBy` BUKAN email (device id anonim ala "anon-xxxxx") -> tetap
 *   dipercaya apa adanya, PERSIS behavior lama. Ini identitas lemah buat user trial yang belum
 *   login, dan itu emang disengaja/diterima (device ID cuma anti-abuse ringan, bukan auth) —
 *   bukan celah baru, cuma mempertahankan kontrak yang sudah ada buat jalur ini.
 */
function resolveOwnerContext({ supabaseUser, createdBy }) {
  if (supabaseUser) {
    const verifiedOwner = `supabase:${supabaseUser.id}`;
    const readCandidates = supabaseUser.email ? [verifiedOwner, supabaseUser.email] : [verifiedOwner];
    return { writeOwner: verifiedOwner, readCandidates, verified: true };
  }
  if (createdBy && EMAIL_RE.test(createdBy)) {
    throw unauthorized(
      'Ownership berbasis email sekarang butuh sesi login Supabase yang valid (sertakan header Authorization: Bearer <access_token>)',
      'EMAIL_OWNER_REQUIRES_AUTH'
    );
  }
  return { writeOwner: createdBy, readCandidates: [createdBy], verified: false };
}

/** Fallback derive-on-the-fly, HANYA buat row lama yang belum sempat dimigrasi (belum punya
 * `keyPreview` tersimpan — lihat scripts/migrate-api-key-hashes.js). Row baru sudah punya
 * `keyPreview` tersimpan langsung dari `previewApiKey()` di utils/id.js pas dibuat. */
function maskKeyLegacyFallback(key) {
  if (!key || key.length < 14) return '****';
  return key.slice(0, 8) + '\u2026' + key.slice(-4);
}

function toPublicListView(row) {
  return { id: row.id, name: row.name, modelId: row.modelId, keyPreview: row.keyPreview || maskKeyLegacyFallback(row.key), createdAt: row.createdAt };
}

function createApiKey({ name, createdBy, modelId, supabaseUser }) {
  const { writeOwner, readCandidates } = resolveOwnerContext({ supabaseUser, createdBy });

  // Check-limit + insert dibungkus 1 transaksi biar gak race (2 request barengan sama-sama
  // liat count=0 terus dua-duanya lolos bikin key, padahal limitnya 1).
  return apiKeyRepo.runTransaction(() => {
    const count = apiKeyRepo.countActiveByOwner(readCandidates);
    if (count >= env.apiKeyLimitPerOwner) {
      throw conflict(`Sudah mencapai batas pembuatan API key (maksimal ${env.apiKeyLimitPerOwner})`, 'API_KEY_LIMIT_REACHED');
    }
    // HARDENING (audit lanjutan, HIGH-4): key MENTAH cuma dipegang sebentar di variabel lokal ini
    // buat dikembalikan SEKALI ke client — yang disimpan ke database adalah HASH-nya (keyHash)
    // + preview aman (keyPreview), BUKAN key mentahnya. Kalau file database ini bocor, secret
    // key TIDAK bisa dipakai langsung (lihat utils/id.js hashApiKey buat alasan lengkap).
    const rawKey = generateApiKey();
    const row = {
      id: generateId('key'),
      name,
      modelId,
      owner: writeOwner,
      keyHash: hashApiKey(rawKey),
      keyPreview: previewApiKey(rawKey),
      status: 'active',
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    apiKeyRepo.create(row);
    return { key: rawKey };
  });
}

function listApiKeys({ createdBy, supabaseUser }) {
  const { readCandidates } = resolveOwnerContext({ supabaseUser, createdBy });
  return apiKeyRepo.listByOwner(readCandidates).map(toPublicListView);
}

function deleteApiKey(id, { createdBy, supabaseUser }) {
  const { readCandidates } = resolveOwnerContext({ supabaseUser, createdBy });
  const ok = apiKeyRepo.deleteByIdForOwner(id, readCandidates);
  if (!ok) throw notFound('API key tidak ditemukan atau bukan milik kamu', 'API_KEY_NOT_FOUND');
  return { success: true };
}

/** Dipakai middleware auth /v1/chat. Melempar 401 kalau key gak valid/gak ketemu. */
function resolveKeyForAuth(bearerKey) {
  let row = apiKeyRepo.findByKeyHash(hashApiKey(bearerKey));
  if (!row) {
    // Fallback transisi (lihat apikey.repo.js findByRawKeyLegacy) — key lama yang belum
    // dimigrasi. Gak pernah kepake lagi setelah scripts/migrate-api-key-hashes.js dijalankan.
    row = apiKeyRepo.findByRawKeyLegacy(bearerKey);
  }
  if (!row) throw unauthorized('API key tidak valid', 'INVALID_API_KEY');
  apiKeyRepo.touchLastUsed(row.id);
  return row;
}

module.exports = { createApiKey, listApiKeys, deleteApiKey, resolveKeyForAuth };
