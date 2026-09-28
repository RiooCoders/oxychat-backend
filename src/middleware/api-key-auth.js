'use strict';

const { unauthorized } = require('../utils/errors');
const { resolveKeyForAuth } = require('../services/api-key.service');

function apiKeyAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return next(unauthorized('Header "Authorization: Bearer <API_KEY>" wajib diisi', 'MISSING_API_KEY'));
  try {
    req.apiKeyRow = resolveKeyForAuth(match[1].trim());
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = apiKeyAuth;
