'use strict';

/**
 * Error terstruktur untuk seluruh API. Semua handler/service/provider sebaiknya throw
 * ApiError (bukan Error biasa) supaya error-handler bisa balikin JSON yang konsisten:
 *   { "error": { "message": "...", "code": "SOME_ERROR_CODE" } }
 * sesuai kontrak yang dibaca frontend (data.error.message).
 */
class ApiError extends Error {
  constructor(status, code, message, { expose = true, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.expose = expose; // false = jangan bocorin message asli ke client (mis. error internal provider mentah)
    if (cause) this.cause = cause;
  }

  toJSON() {
    return { error: { message: this.expose ? this.message : 'Terjadi kesalahan internal', code: this.code } };
  }
}

const badRequest = (message, code = 'BAD_REQUEST') => new ApiError(400, code, message);
const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') => new ApiError(401, code, message);
const forbidden = (message = 'Forbidden', code = 'FORBIDDEN') => new ApiError(403, code, message);
const notFound = (message = 'Resource not found', code = 'NOT_FOUND') => new ApiError(404, code, message);
const conflict = (message, code = 'CONFLICT') => new ApiError(409, code, message);
const payloadTooLarge = (message = 'Payload too large', code = 'PAYLOAD_TOO_LARGE') => new ApiError(413, code, message);
const tooManyRequests = (message = 'Rate limit exceeded, coba lagi sebentar lagi', code = 'RATE_LIMITED') =>
  new ApiError(429, code, message);
const internal = (message = 'Internal server error', code = 'INTERNAL_ERROR', opts = {}) =>
  new ApiError(500, code, message, { expose: false, ...opts });
const badGateway = (message = 'Provider sedang tidak tersedia', code = 'PROVIDER_UNAVAILABLE') =>
  new ApiError(502, code, message);
const gatewayTimeout = (message = 'Provider timeout', code = 'PROVIDER_TIMEOUT') => new ApiError(504, code, message);

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  payloadTooLarge,
  tooManyRequests,
  internal,
  badGateway,
  gatewayTimeout,
};
