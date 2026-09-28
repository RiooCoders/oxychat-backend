'use strict';

const { badRequest } = require('./errors');
const { ALL_KNOWN_MODELS, VISION_MODELS, VALID_API_KEY_MODEL_IDS } = require('../config/models');

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Validasi satu content part multimodal (dipakai kalau content message berupa array). */
function validateContentPart(part, idx) {
  if (!isPlainObject(part) || typeof part.type !== 'string') {
    throw badRequest(`messages[].content[${idx}] harus punya field "type"`);
  }
  if (part.type === 'text') {
    if (typeof part.text !== 'string') throw badRequest(`messages[].content[${idx}].text harus string`);
    return;
  }
  if (part.type === 'image_url') {
    const url = part.image_url && part.image_url.url;
    if (typeof url !== 'string' || !url.startsWith('data:')) {
      throw badRequest(`messages[].content[${idx}].image_url.url harus data URL base64`);
    }
    return;
  }
  throw badRequest(`messages[].content[${idx}].type "${part.type}" tidak didukung`);
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw badRequest('"messages" harus array dan tidak boleh kosong');
  }
  let hasImage = false;
  for (const m of messages) {
    if (!isPlainObject(m) || !VALID_ROLES.has(m.role)) {
      throw badRequest('setiap item "messages" harus punya "role" yang valid (system/user/assistant/tool)');
    }
    if (typeof m.content === 'string') continue;
    if (Array.isArray(m.content)) {
      m.content.forEach((part, i) => {
        validateContentPart(part, i);
        if (part.type === 'image_url') hasImage = true;
      });
      continue;
    }
    throw badRequest('"messages[].content" harus string atau array multimodal');
  }
  return { hasImage };
}

/**
 * Validasi body POST /api/chat (dan /v1/chat setelah model di-resolve dari API key).
 * Mengembalikan field yang sudah divalidasi/dibersihkan.
 */
function validateChatBody(body, { modelAlreadyResolved = false } = {}) {
  if (!isPlainObject(body)) throw badRequest('Body request harus JSON object');

  const model = modelAlreadyResolved ? body.model : body.model;
  if (typeof model !== 'string' || !model.trim()) {
    throw badRequest('"model" wajib diisi', 'MODEL_REQUIRED');
  }
  if (!modelAlreadyResolved && !ALL_KNOWN_MODELS.has(model) && model !== 'spectrax') {
    throw badRequest(`Model "${model}" tidak dikenali/tidak ada di allowlist`, 'MODEL_NOT_ALLOWED');
  }

  const { hasImage } = validateMessages(body.messages);
  if (hasImage && !VISION_MODELS.includes(model)) {
    throw badRequest(`Model "${model}" tidak mendukung input gambar`, 'MODEL_NOT_VISION_CAPABLE');
  }

  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw badRequest('"stream" harus boolean');
  }
  if (body.temperature !== undefined && typeof body.temperature !== 'number') {
    throw badRequest('"temperature" harus angka');
  }

  return { model, messages: body.messages, stream: Boolean(body.stream) };
}

function validateCreateApiKeyBody(body, { supabaseUser } = {}) {
  if (!isPlainObject(body)) throw badRequest('Body request harus JSON object');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const createdBy = typeof body.createdBy === 'string' ? body.createdBy.trim() : '';
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
  if (!name) throw badRequest('"name" wajib diisi');
  if (name.length > 80) throw badRequest('"name" maksimal 80 karakter');
  // createdBy cuma wajib kalau gak ada sesi login terverifikasi (lihat api-key.service.js
  // resolveOwnerContext — kalau ada req.supabaseUser, createdBy dari client diabaikan sama sekali).
  if (!createdBy && !supabaseUser) throw badRequest('"createdBy" wajib diisi (atau sertakan sesi login)');
  if (createdBy && createdBy.length > 200) throw badRequest('"createdBy" kepanjangan');
  if (!modelId || !VALID_API_KEY_MODEL_IDS.has(modelId)) {
    throw badRequest(`"modelId" tidak valid, harus salah satu dari: ${[...VALID_API_KEY_MODEL_IDS].join(', ')}`);
  }
  return { name, createdBy, modelId };
}

function validateRedeemBody(body) {
  if (!isPlainObject(body)) throw badRequest('Body request harus JSON object');
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!code) throw badRequest('"code" wajib diisi');
  return { code };
}

module.exports = {
  validateChatBody,
  validateCreateApiKeyBody,
  validateRedeemBody,
  validateMessages,
};
