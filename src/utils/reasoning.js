'use strict';

/**
 * Parameter "thinking" beda-beda tiap provider/model. Frontend cukup ngirim niat umumnya
 * (show_thinking / reasoning_effort); backend yang nerjemahin ke parameter yang BENER buat
 * model upstream-nya. Sebelumnya frontend nge-kirim reasoning_format:"parsed" ke SEMUA model
 * Groq, padahal gpt-oss gak support parameter itu (Groq nolak/ngaco), dan nilai effort yang
 * valid juga beda per model.
 *
 * Acuan (Groq docs, dicek 30 Sep 2026):
 *  - openai/gpt-oss-*  : reasoning_effort low|medium|high, include_reasoning true|false.
 *                        reasoning_format TIDAK didukung.
 *  - qwen/qwen3.x-27b  : reasoning_effort none|default|low|medium|high,
 *                        reasoning_format parsed|raw|hidden.
 */

const EFFORTS = new Set(['low', 'medium', 'high']);

function normalizeEffort(v) {
  const s = String(v || '').toLowerCase().trim();
  if (EFFORTS.has(s)) return s;
  if (s === 'minimal') return 'low';
  if (s === 'xhigh' || s === 'max' || s === 'maks') return 'high';
  return undefined;
}

/** Apakah client minta thinking DITAMPILKAN? (kompatibel sama frontend lama yang cuma ngirim reasoning_effort) */
function wantsThinking(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.show_thinking === true || body.include_reasoning === true) return true;
  if (body.show_thinking === false || body.include_reasoning === false) return false;
  const e = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase().trim() : '';
  return e !== '' && e !== 'none';
}

function providerReasoningParams(providerName, upstreamModel, body) {
  if (providerName !== 'groq') return {};
  const wants = wantsThinking(body);
  const effort = normalizeEffort(body && body.reasoning_effort);
  const m = String(upstreamModel || '');
  if (m.startsWith('openai/gpt-oss')) {
    return wants ? { reasoning_effort: effort || 'medium', include_reasoning: true } : { include_reasoning: false };
  }
  if (m.startsWith('qwen/')) {
    return wants ? { reasoning_effort: effort || 'medium', reasoning_format: 'parsed' } : { reasoning_effort: 'none' };
  }
  return {};
}

module.exports = { wantsThinking, normalizeEffort, providerReasoningParams };
