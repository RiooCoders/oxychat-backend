'use strict';

const { Transform } = require('node:stream');
const { ThinkingFilter, firstString } = require('./sanitize-content');

/**
 * Transform SSE OpenAI-compatible yang STATEFUL (1 ThinkingFilter per choice):
 *  - `delta.content` dilewatin filter thinking (tag kepecah antar delta aman)
 *  - reasoning native provider (`reasoning` / `reasoning_content` / `reasoning_details`) dibuang,
 *    KECUALI keepThinking=true -> dirapiin jadi SATU field `reasoning_content` (gak pernah nyampur ke content)
 *  - chunk yang isinya kosong setelah disaring di-skip (finish_reason / usage tetap diteruskan)
 *  - pas [DONE]/stream putus, sisa buffer filter di-flush (mis. jawaban hasil "recovery")
 */
function createSseFilterTransform({ keepThinking = false } = {}) {
  let buffer = '';
  const filters = new Map();
  const meta = { id: null, model: null, created: null };

  const getFilter = (idx) => {
    let f = filters.get(idx);
    if (!f) {
      f = new ThinkingFilter({ keepThinking });
      filters.set(idx, f);
    }
    return f;
  };

  function extraChunk(idx, r) {
    const delta = {};
    if (r.content) delta.content = r.content;
    if (keepThinking && r.thinking) delta.reasoning_content = r.thinking;
    return (
      'data: ' +
      JSON.stringify({
        id: meta.id || 'chatcmpl-flush',
        object: 'chat.completion.chunk',
        created: meta.created || Math.floor(Date.now() / 1000),
        model: meta.model || undefined,
        choices: [{ index: idx, delta, finish_reason: null }],
      }) +
      '\n\n'
    );
  }

  function flushAll() {
    let out = '';
    for (const [idx, f] of filters) {
      const r = f.flush();
      if (r.content || (keepThinking && r.thinking)) out += extraChunk(idx, r);
    }
    filters.clear();
    return out;
  }

  /** Return: string baris "data: ..." (tanpa newline) atau null kalau chunk harus di-skip. */
  function processPayload(payload) {
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch (_) {
      return 'data: ' + payload; // bukan JSON, teruskan apa adanya
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.choices)) return 'data: ' + JSON.stringify(obj);
    if (obj.id) meta.id = obj.id;
    if (obj.model) meta.model = obj.model;
    if (obj.created) meta.created = obj.created;

    const kept = [];
    for (const ch of obj.choices) {
      if (!ch || typeof ch !== 'object' || !ch.delta || typeof ch.delta !== 'object') {
        kept.push(ch);
        continue;
      }
      const idx = Number.isInteger(ch.index) ? ch.index : 0;
      const delta = { ...ch.delta };
      const native = firstString(delta.reasoning_content, delta.reasoning);
      delete delta.reasoning;
      delete delta.reasoning_content;
      delete delta.reasoning_details;

      let contentOut = '';
      let thinkOut = '';
      if (typeof delta.content === 'string' && delta.content !== '') {
        const r = getFilter(idx).push(delta.content);
        contentOut = r.content;
        thinkOut = r.thinking;
      }
      if (keepThinking && native) thinkOut = native + thinkOut;
      if (typeof delta.content === 'string') {
        if (contentOut) delta.content = contentOut;
        else delete delta.content;
      }
      if (keepThinking && thinkOut) delta.reasoning_content = thinkOut;

      if (ch.finish_reason || Object.keys(delta).length > 0) kept.push({ ...ch, delta });
    }
    if (kept.length === 0 && !obj.usage) return null;
    return 'data: ' + JSON.stringify({ ...obj, choices: kept });
  }

  function processLine(line) {
    // return string output (sudah termasuk newline) buat 1 baris input
    if (!line.startsWith('data:')) return line + '\n';
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return flushAll() + 'data: [DONE]\n';
    if (!payload) return line + '\n';
    const out = processPayload(payload);
    return out === null ? '' : out + '\n';
  }

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        let out = '';
        for (const part of parts) out += processLine(part.endsWith('\r') ? part.slice(0, -1) : part);
        if (out) this.push(out);
        cb();
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        let out = '';
        if (buffer) {
          out += processLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
          buffer = '';
        }
        out += flushAll();
        if (out) this.push(out);
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}

module.exports = { createSseFilterTransform };
