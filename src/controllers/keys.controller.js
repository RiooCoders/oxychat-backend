'use strict';

const apiKeyService = require('../services/api-key.service');
const { validateCreateApiKeyBody } = require('../utils/validation');
const { badRequest } = require('../utils/errors');

function postCreateKey(req, res) {
  const { name, createdBy, modelId } = validateCreateApiKeyBody(req.body, { supabaseUser: req.supabaseUser });
  const result = apiKeyService.createApiKey({ name, createdBy, modelId, supabaseUser: req.supabaseUser });
  res.status(201).json(result);
}

function getListKeys(req, res) {
  const createdBy = typeof req.query.createdBy === 'string' ? req.query.createdBy.trim() : '';
  if (!createdBy && !req.supabaseUser) throw badRequest('Query param "createdBy" wajib diisi (atau sertakan sesi login)');
  res.status(200).json(apiKeyService.listApiKeys({ createdBy, supabaseUser: req.supabaseUser }));
}

function deleteKey(req, res) {
  const { id } = req.params;
  const createdBy = typeof req.query.createdBy === 'string' ? req.query.createdBy.trim() : '';
  if (!createdBy && !req.supabaseUser) throw badRequest('Query param "createdBy" wajib diisi (atau sertakan sesi login)');
  const result = apiKeyService.deleteApiKey(id, { createdBy, supabaseUser: req.supabaseUser });
  res.status(200).json(result);
}

module.exports = { postCreateKey, getListKeys, deleteKey };
