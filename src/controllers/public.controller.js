'use strict';

const chatService = require('../services/chat.service');
const { runChatAndRespond, sendError } = require('../utils/http-chat-relay');
const { API_KEY_MODEL_ALIASES } = require('../config/models');
const { internal } = require('../utils/errors');

/**
 * POST /v1/chat — API publik buat pemegang API key (dibuat lewat halaman CreateApikey).
 * Model SELALU ditentukan oleh key yang dipakai (lihat req.apiKeyRow.modelId dari
 * middleware/api-key-auth.js), bukan dari body client — biar API key model-bound beneran
 * berarti sesuatu (lihat MASTER PROMPT #26).
 */
async function postPublicChat(req, res) {
  const internalModel = API_KEY_MODEL_ALIASES[req.apiKeyRow.modelId];
  if (!internalModel) return sendError(res, internal('API key ini terikat ke model yang sudah tidak valid'));

  const body = { ...req.body, model: internalModel };
  await runChatAndRespond(req, res, (signal) =>
    chatService.handleChat(body, { signal, modelAlreadyResolved: true })
  );
}

module.exports = { postPublicChat };
