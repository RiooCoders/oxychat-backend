'use strict';

/**
 * Bersihin "reasoning leak" dari model (DeepSeek R1, Qwen thinking, OpenRouter auto, dll):
 * - blok <think>...</think> (termasuk atribut / isi aneh seperti <think>|message|>)
 * - <thinking>, <reason>, <reasoning>, redacted_reasoning
 * - tag terbuka yang belum ketutup (stream potongan)
 * - sisa tag penutup nyangkut
 * Jangan sentuh kode HTML user yang sah di luar pola ini.
 */
function stripThinkingTags(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;

  // Blok think/thinking/reason lengkap (buka + tutup)
  out = out.replace(/<(?:think|thinking|reason|reasoning|redacted_reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thinking|reason|reasoning|redacted_reasoning)>/gi, '');

  // Tag terbuka yang belum ketutup (stream potong di tengah / model gak nutup)
  out = out.replace(/<(?:think|thinking|reason|reasoning|redacted_reasoning)\b[^>]*>[\s\S]*$/gi, '');

  // Sisa tag penutup nyangkut
  out = out.replace(/<\/(?:think|thinking|reason|reasoning|redacted_reasoning)>/gi, '');

  // Beberapa model (terutama OpenRouter / Qwen) kadang nyisipin prefix aneh di awal jawaban
  // contoh: "|message|>" atau "User wants a ..." yang kebawa dari system prompt
  out = out.replace(/^\s*\|message\|>\s*/i, '');

  return out;
}

/** Ambil teks jawaban final dari message OpenAI-compatible (buang field reasoning). */
function pickAssistantContent(message) {
  if (!message || typeof message !== 'object') return '';
  const raw = message.content;
  if (typeof raw === 'string') return stripThinkingTags(raw);
  if (Array.isArray(raw)) {
    return stripThinkingTags(
      raw
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          return '';
        })
        .join('')
    );
  }
  return '';
}

/**
 * Sanitasi response non-stream: hapus reasoning_* dari message, bersihin content.
 */
function sanitizeCompletionPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const clone = { ...data };
  if (Array.isArray(clone.choices)) {
    clone.choices = clone.choices.map((ch) => {
      if (!ch || typeof ch !== 'object') return ch;
      const next = { ...ch };
      if (next.message && typeof next.message === 'object') {
        const msg = { ...next.message };
        const cleaned = pickAssistantContent(msg);
        msg.content = cleaned;
        delete msg.reasoning;
        delete msg.reasoning_content;
        delete msg.reasoning_details;
        next.message = msg;
      }
      if (next.delta && typeof next.delta === 'object') {
        const delta = { ...next.delta };
        if (typeof delta.content === 'string') delta.content = stripThinkingTags(delta.content);
        delete delta.reasoning;
        delete delta.reasoning_content;
        next.delta = delta;
      }
      return next;
    });
  }
  return clone;
}

/**
 * Sanitasi satu baris SSE `data: {...}`.
 * Return string baris lengkap (dengan prefix data: ) atau null kalau baris harus di-drop.
 */
function sanitizeSseDataLine(line) {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) return line;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return line;
  try {
    const obj = JSON.parse(payload);
    const clean = sanitizeCompletionPayload(obj);
    return 'data: ' + JSON.stringify(clean);
  } catch (_) {
    return line;
  }
}

module.exports = {
  stripThinkingTags,
  pickAssistantContent,
  sanitizeCompletionPayload,
  sanitizeSseDataLine,
};
