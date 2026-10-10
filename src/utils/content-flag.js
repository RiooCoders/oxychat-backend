'use strict';

/**
 * Deteksi "pesan ditandai filter keamanan" dari sisi provider. Semua sinyal di bawah datang
 * dari respons provider yang NYATA (bukan tebakan):
 *   1) HTTP error 400/403/422/451 yang isinya moderation / content-policy / safety block
 *      (mis. OpenRouter 403 "input was flagged by moderation" + metadata.reasons,
 *      Gemini "blocked due to SAFETY", OpenAI-style "content_filter").
 *   2) Response sukses (non-stream) dengan finish_reason "content_filter" dan isi kosong.
 *   3) Response stream yang chunk pertamanya langsung finish_reason "content_filter" tanpa isi.
 * Hasilnya jadi ApiError code CONTENT_FLAGGED, lalu chat.service memutuskan: ganti model atau jeda.
 */
const { ApiError } = require('./errors');

const FLAG_STATUS = new Set([400, 403, 422, 451]);

// Sengaja spesifik (bukan kata lepas "safety"/"blocked") biar error 400 biasa gak salah dikira "ditandai".
const FLAG_PATTERNS = [
  /content[\s_-]?filter/i,
  /content[\s_-]?polic/i,
  /content[\s_-]?moderation/i,
  /\bmoderation\b/i,
  /\bflagged\b/i,
  /safety[\s_-]?(?:system|filter|setting|polic|block|violation)/i,
  /(?:blocked|block(?:ed)?[\s_-]?reason|rejected)\b.{0,40}\bsafety\b/i,
  /\bsafety\b.{0,40}\b(?:blocked|rejected|violat)/i,
  /policy[\s_-]?violation/i,
  /violat\w*(?:\s+(?:our|the|content|usage|use|safety|acceptable))*\s+polic/i,
  /prompt\s+(?:was\s+)?blocked/i,
  /blocked\s+(?:by|due)\s+(?:to\s+)?(?:safety|content|moderation|policy)/i,
  /harm[\s_-]?category/i,
  /responsible[\s_-]?ai/i,
  /prohibited[\s_-]?content/i,
  /\bguardrails?\b/i,
];

const AUTH_PATTERN = /api[\s_-]?key|authenticat|unauthori[sz]ed|permission[\s_-]?denied/i;

function str(v) {
  return typeof v === 'string' ? v : '';
}

/** Kumpulin teks yang relevan dari body error provider (bentuknya beda-beda tiap provider). */
function collectErrorText(rawText) {
  const raw = String(rawText == null ? '' : rawText);
  const parts = [];
  let hasReasons = false;
  try {
    let parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) parsed = parsed[0]; // Gemini kadang ngebungkus error dalam array
    if (parsed && typeof parsed === 'object') {
      const e = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
      parts.push(str(e.message), str(e.code), str(e.type), str(e.status), str(parsed.message));
      if (typeof parsed.error === 'string') parts.push(parsed.error);
      if (e.metadata && Array.isArray(e.metadata.reasons) && e.metadata.reasons.length > 0) hasReasons = true;
    }
  } catch (_) {
    // bukan JSON: dipakai potongan teks mentah di bawah
  }
  let text = parts.filter(Boolean).join(' | ');
  if (!text) text = raw.slice(0, 800);
  return { text, hasReasons };
}

/** true kalau error HTTP provider ini artinya "pesan ditandai/diblokir filter keamanan". */
function looksFlaggedUpstream(status, rawText) {
  if (!FLAG_STATUS.has(status)) return false;
  const { text, hasReasons } = collectErrorText(rawText);
  if (hasReasons) return true; // OpenRouter moderation: metadata.reasons terisi
  if (AUTH_PATTERN.test(text)) return false; // 403 karena key salah bukan "ditandai"
  return FLAG_PATTERNS.some((re) => re.test(text));
}

function hasMessageText(message) {
  if (!message || typeof message !== 'object') return false;
  const c = message.content;
  if (typeof c === 'string') return c.trim() !== '';
  if (Array.isArray(c)) return c.some((p) => p && typeof p.text === 'string' && p.text.trim() !== '');
  return false;
}

/** Response non-stream: semua choice berhenti karena content_filter dan gak ada isinya. */
function isFlaggedCompletion(data) {
  const choices = data && Array.isArray(data.choices) ? data.choices : [];
  if (choices.length === 0) return false;
  return choices.every((c) => c && c.finish_reason === 'content_filter' && !hasMessageText(c.message));
}

/**
 * Nilai satu baris SSE: 'flagged' (ditandai sebelum ada isi), 'ok' (isi/jawaban udah mulai
 * atau selesai normal), atau null (belum bisa diputuskan, baca baris berikutnya).
 */
function judgeSseLine(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return 'ok';
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.error) return 'ok'; // error di tengah stream ditangani relay seperti biasa
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (!choice || typeof choice !== 'object') return null;
  const d = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
  const startedText = typeof d.content === 'string' && d.content !== '';
  const startedThink =
    (typeof d.reasoning === 'string' && d.reasoning !== '') ||
    (typeof d.reasoning_content === 'string' && d.reasoning_content !== '') ||
    (Array.isArray(d.tool_calls) && d.tool_calls.length > 0);
  if (startedText || startedThink) return 'ok';
  if (choice.finish_reason === 'content_filter') return 'flagged';
  if (choice.finish_reason) return 'ok';
  return null;
}

/**
 * Intip awal stream upstream SEBELUM dikirim ke client. Selama belum ada isi, chunk ditahan;
 * begitu keputusan jatuh ('ok'), semua chunk yang ditahan diputar ulang lalu sisa stream
 * dialirkan apa adanya (gak nambah latency: jawaban toh baru bisa tampil setelah isi pertama).
 * @returns {Promise<{flagged:boolean, response:Response|null}>}
 */
async function peekStreamForFlag(response, { maxBytes = 16384, maxChunks = 64 } = {}) {
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    return { flagged: false, response };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const held = [];
  let buffer = '';
  let bytes = 0;
  let chunks = 0;
  let decision = null;
  let ended = false;

  while (decision === null && !ended) {
    const r = await reader.read(); // kalau stream putus di sini, error-nya dilempar ke pemanggil
    if (r.done) {
      ended = true;
      break;
    }
    held.push(r.value);
    bytes += r.value.byteLength;
    chunks += 1;
    buffer += decoder.decode(r.value, { stream: true });
    let nl;
    while (decision === null && (nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      decision = judgeSseLine(line);
    }
    if (decision === null && (bytes >= maxBytes || chunks >= maxChunks)) decision = 'ok';
  }

  if (decision === 'flagged') {
    try {
      await reader.cancel();
    } catch (_) {
      // stream sudah tertutup, aman diabaikan
    }
    return { flagged: true, response: null };
  }

  let replayed = 0;
  const replay = new ReadableStream({
    pull(controller) {
      if (replayed < held.length) {
        controller.enqueue(held[replayed++]);
        return undefined;
      }
      if (ended) {
        controller.close();
        return undefined;
      }
      return reader.read().then(
        (r) => {
          if (r.done) controller.close();
          else controller.enqueue(r.value);
        },
        (err) => controller.error(err)
      );
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { flagged: false, response: new Response(replay, { status: response.status, headers: response.headers }) };
}

function contentFlaggedError(providerName) {
  return new ApiError(422, 'CONTENT_FLAGGED', `Pesan ini ditandai filter keamanan provider ${providerName}`);
}

module.exports = {
  FLAG_PATTERNS,
  looksFlaggedUpstream,
  isFlaggedCompletion,
  judgeSseLine,
  peekStreamForFlag,
  contentFlaggedError,
};
