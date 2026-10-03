'use strict';

const env = require('../config/env');
const apiKeyRepo = require('../db/repositories/apikey.repo');
const { generateId, generateApiKey, hashApiKey, previewApiKey } = require('../utils/id');
const { notFound, unauthorized, conflict } = require('../utils/errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function maskKeyLegacyFallback(key) {
  if (!key || key.length < 14) return '****';
  return key.slice(0, 8) + '\u2026' + key.slice(-4);
}

function toPublicListView(row) {
  return { id: row.id, name: row.name, modelId: row.modelId, keyPreview: row.keyPreview || maskKeyLegacyFallback(row.key), createdAt: row.createdAt };
}

function createApiKey({ name, createdBy, modelId, supabaseUser }) {
  const { writeOwner, readCandidates } = resolveOwnerContext({ supabaseUser, createdBy });

  return apiKeyRepo.runTransaction(() => {
    const count = apiKeyRepo.countActiveByOwner(readCandidates);
    if (count >= env.apiKeyLimitPerOwner) {
      throw conflict(`Sudah Mencapai Batas Pembuatan APIKey (Maksimal ${env.apiKeyLimitPerOwner})`, 'API_KEY_LIMIT_REACHED');
    }
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
  if (!ok) throw notFound('APIKey Tidak Ditemukan Atau Bukan Milik Kamu', 'API_KEY_NOT_FOUND');
  return { success: true };
}

/** Dipakai middleware auth /v1/chat. Melempar 401 kalau key gak valid/gak ketemu. */
function resolveKeyForAuth(bearerKey) {
  let row = apiKeyRepo.findByKeyHash(hashApiKey(bearerKey));
  if (!row) {
    row = apiKeyRepo.findByRawKeyLegacy(bearerKey);
  }
  if (!row) throw unauthorized('API Key Tidak Valid', 'INVALID_API_KEY');
  apiKeyRepo.touchLastUsed(row.id);
  return row;
}

module.exports = { createApiKey, listApiKeys, deleteApiKey, resolveKeyForAuth };
