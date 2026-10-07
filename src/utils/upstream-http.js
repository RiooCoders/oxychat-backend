'use strict';

const { withTimeout } = require('./abort');

/**
 * Error dari panggilan HTTP ke layanan luar (ElevenLabs, Groq). `kind`:
 *   'http'    -> layanan membalas status non-2xx (status/code/message terisi)
 *   'timeout' -> kena batas waktu kita sendiri
 *   'network' -> gak bisa konek / respons rusak
 *   'aborted' -> dibatalkan dari sisi kita (mis. klien menutup koneksi)
 */
class UpstreamError extends Error {
  constructor({ kind, status = 0, code = '', message = '', retryAfter = null }) {
    super(message || kind);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Ambil (code, message) dari berbagai bentuk body error: ElevenLabs {detail:{status,message}} / {detail:[...]} / OpenAI-Groq {error:{code,type,message}}. */
function extractErrorFields(raw) {
  let code = '';
  let message = '';
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object') {
    const detail = parsed.detail !== undefined ? parsed.detail : parsed.error !== undefined ? parsed.error : parsed;
    if (Array.isArray(detail)) {
      message = detail
        .map((d) => (d && d.msg ? `${Array.isArray(d.loc) ? d.loc.join('.') : ''}: ${d.msg}` : ''))
        .filter(Boolean)
        .join('; ');
    } else if (detail && typeof detail === 'object') {
      code = String(detail.status || detail.code || detail.type || '');
      message = String(detail.message || detail.msg || '');
    } else if (typeof detail === 'string') {
      message = detail;
    }
  }
  if (!message) message = String(raw || '').slice(0, 300);
  return { code, message: message.slice(0, 300) };
}

async function toHttpError(res) {
  let raw = '';
  try {
    raw = await res.text();
  } catch (_) {
    raw = '';
  }
  const { code, message } = extractErrorFields(raw);
  return new UpstreamError({
    kind: 'http',
    status: res.status,
    code,
    message,
    retryAfter: res.headers && res.headers.get ? res.headers.get('retry-after') : null,
  });
}

/**
 * fetch + timeout + klasifikasi error. `as`: 'json' | 'buffer' | 'text' (cara baca body sukses).
 * Batas waktu mencakup SELURUH proses, termasuk membaca body.
 * URL selalu dikirim sebagai string (bukan objek URL) — kompatibel dengan wrapper fetch di test harness.
 */
async function upstreamRequest({ url, method = 'GET', headers = {}, json, form, signal, timeoutMs = 30000, as = 'json' }) {
  const h = { ...headers };
  let body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // FormData: boundary + Content-Type diurus fetch sendiri
  }

  const t = withTimeout(signal, timeoutMs);
  const classify = (err) => {
    if (signal && signal.aborted) return new UpstreamError({ kind: 'aborted', message: 'aborted' });
    if (t.timedOut) return new UpstreamError({ kind: 'timeout', message: 'timeout' });
    return new UpstreamError({ kind: 'network', message: err && err.message ? String(err.message) : 'network error' });
  };

  try {
    let res;
    try {
      res = await fetch(String(url), { method, headers: h, body, signal: t.signal });
    } catch (err) {
      throw classify(err);
    }
    if (!res.ok) {
      const httpErr = await toHttpError(res).catch((e) => classify(e));
      throw httpErr;
    }
    try {
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      if (as === 'text') return await res.text();
      return await res.json();
    } catch (err) {
      throw classify(err);
    }
  } finally {
    t.done();
  }
}

module.exports = { UpstreamError, upstreamRequest, extractErrorFields };
