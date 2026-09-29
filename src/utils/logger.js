'use strict';

// Logger minimal. Sengaja gak pakai library eksternal biar dependency tetep sedikit.
// SELALU lewat sini (jangan console.log langsung di tempat lain) supaya field sensitif
// (Authorization, api key, dst) konsisten ke-redact di semua log.

const SENSITIVE_KEY_RE = /(authorization|api[_-]?key|x-device-id|password|secret|token)/i;

function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    // Bearer token / key panjang di dalam string tetep disamarin sebagian.
    return value.replace(/(vaeltrix_[A-Za-z0-9]{6})[A-Za-z0-9_-]+/g, '$1***');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

function timestamp() {
  return new Date().toISOString();
}

function line(level, msg, meta) {
  const base = `[${timestamp()}] [${level}] ${msg}`;
  if (meta === undefined) return base;
  try {
    return base + ' ' + JSON.stringify(redact(meta));
  } catch (_) {
    return base;
  }
}

module.exports = {
  info: (msg, meta) => console.log(line('INFO', msg, meta)),
  warn: (msg, meta) => console.warn(line('WARN', msg, meta)),
  error: (msg, meta) => console.error(line('ERROR', msg, meta)),
  redact,
};
