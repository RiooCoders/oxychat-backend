'use strict';

/**
 * Pembatas laju jendela-geser sederhana (in-memory, per proses). Dipakai buat ngelindungin IP server
 * dari blokir DuckDuckGo. Bukan pengganti rate-limit HTTP di middleware/rate-limit.js.
 */
function createRateWindow({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  let lastSweep = now();

  function sweep(t) {
    lastSweep = t;
    for (const [key, arr] of hits) {
      if (!arr.length || t - arr[arr.length - 1] >= windowMs) hits.delete(key);
    }
  }

  return {
    /** true = masih boleh (dan hit dicatat), false = sudah lewat batas di jendela ini. */
    hit(key) {
      const t = now();
      if (t - lastSweep > windowMs) sweep(t);
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (arr.length >= max) {
        hits.set(key, arr);
        return false;
      }
      arr.push(t);
      hits.set(key, arr);
      return true;
    },
    size: () => hits.size,
  };
}

module.exports = { createRateWindow };
