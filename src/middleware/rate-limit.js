'use strict';

const { tooManyRequests } = require('../utils/errors');

/**
 * Rate limiter in-memory (sliding-ish window per counter reset berkala). Ini proteksi ABUSE
 * INFRASTRUKTUR (flood/spam request), BUKAN product limit (limit pesan per plan itu urusan
 * frontend, lihat chat/js/01-config-provider.js MSG_LIMIT_WINDOW_MS — sengaja gak diduplikasi
 * di sini). Catatan: state di memory proses, jadi kalau di-deploy multi-instance tiap instance
 * punya hitungan sendiri-sendiri — cukup buat skala hobby/single-instance seperti target project ini.
 */
function createRateLimiter({ windowMs, max, keyFn = (req) => req.ip, message }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 60000)).unref();

  return function rateLimit(req, res, next) {
    const key = keyFn(req) || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(tooManyRequests(message));
    }
    next();
  };
}

module.exports = { createRateLimiter };
