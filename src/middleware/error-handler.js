'use strict';

const { ApiError } = require('../utils/errors');
const logger = require('../utils/logger');

/** Nempelin requestId ke body error JSON — buat korelasi ke log server (lihat app.js). */
function withRequestId(errorBody, req) {
  if (req && req.id) errorBody.error.requestId = req.id;
  return errorBody;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return; // udah kepake buat streaming dll, gak bisa kirim JSON lagi

  // Body JSON yang gak valid dari express.json() punya bentuk error bawaan Express sendiri.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json(withRequestId({ error: { message: 'Body request bukan JSON yang valid', code: 'INVALID_JSON' } }, req));
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json(withRequestId({ error: { message: 'Request body terlalu besar', code: 'PAYLOAD_TOO_LARGE' } }, req));
  }

  const apiErr = err instanceof ApiError ? err : null;
  if (!apiErr) {
    // Error body-parser lain di luar 2 kasus umum di atas (charset gak didukung, request
    // keburu putus, dst) tetep bawa `.status`/`.statusCode` valid dari Express — hormati itu
    // kalau ada, daripada maksa jadi 500 semua.
    const status = Number(err.status || err.statusCode);
    const isClientError = Number.isInteger(status) && status >= 400 && status < 500;
    if (isClientError) {
      return res.status(status).json(withRequestId({ error: { message: err.message || 'Request tidak valid', code: 'BAD_REQUEST' } }, req));
    }
    logger.error('unhandled_error', { id: req.id, message: err.message, stack: err.stack, path: req.originalUrl });
    return res.status(500).json(withRequestId({ error: { message: 'Terjadi kesalahan internal', code: 'INTERNAL_ERROR' } }, req));
  }
  if (apiErr.status >= 500) logger.error('api_error', { id: req.id, message: apiErr.message, code: apiErr.code, path: req.originalUrl });
  res.status(apiErr.status).json(withRequestId(apiErr.toJSON(), req));
}

function notFoundHandler(req, res) {
  res.status(404).json(
    withRequestId({ error: { message: `Route tidak ditemukan: ${req.method} ${req.path}`, code: 'ROUTE_NOT_FOUND' } }, req)
  );
}

module.exports = { errorHandler, notFoundHandler };
