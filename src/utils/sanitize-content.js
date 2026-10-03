'use strict';

/**
 * Pemisah "thinking" (proses mikir model) dari jawaban final.
 *
 * KENAPA DIROMBAK: versi lama nyaring PER-POTONGAN (per baris SSE) pakai regex. Padahal model
 * streaming ngirim tag kepecah-pecah ("<", "think", ">" = 3 delta beda), dan isi thinking-nya
 * ngalir di delta-delta berikutnya yang sama sekali gak punya tag. Hasilnya: tag gak pernah
 * kedeteksi, isi thinking tembus ke layar. Di sini filter-nya STATEFUL (ingat lagi di dalam
 * thinking atau enggak) dan nahan buntut potongan yang mungkin awal sebuah tag.
 *
 * Yang dikenali:
 *  - <think>, <thinking>, <thought>, <reasoning>, <reason>, <redacted_reasoning> (+ atribut)
 *  - varian rusak ala gpt-oss:  <think<|message|>  /  <think|message|>  /  <think>|message|>
 *  - format Harmony mentah: <|channel|>analysis<|message|> ... <|end|> ... <|channel|>final<|message|>
 *  - token spesial nyasar (<|im_end|>, <|eot_id|>, dst) dibuang
 *  - varian token-ke-strip: "analysisXxxx ... assistantfinalXxxx"
 * Tag DIABAIKAN kalau lagi di dalam blok kode (``` atau `inline`) biar jawaban yang ngebahas
 * tag <think> (contoh kode, dokumentasi) gak ikut kehapus.
 */

const NAMES = ['redacted_reasoning', 'reasoning', 'reason', 'thinking', 'think', 'thought'];
const NAME_ALT = NAMES.join('|');
const HOLD_MAX = 120; // maksimal karakter yang ditahan nunggu tag kelar
const THINK_BUF_MAX = 400000; // salinan thinking buat "recovery", dibatasi biar memori aman
const FINAL_MARK = 'assistantfinal';

const MSG_TERM = '(?:<\\|message\\|>|\\|message\\|>|>)';
const MSG_RESIDUE = '(?:\\s*(?:<\\|message\\|>|\\|message\\|>))?';
const OPEN_RE = new RegExp('^<(?:' + NAME_ALT + ')\\b[^<>\\n]{0,80}?' + MSG_TERM + MSG_RESIDUE, 'i');
const CLOSE_RE = new RegExp('^<\\/(?:' + NAME_ALT + ')\\b[^<>\\n]{0,20}>', 'i');
const CHANNEL_RE = /^<\|channel\|>\s*([a-z_]+)(?:[^<]|<\|constrain\|>){0,80}?<\|message\|>/i;
const END_RE = /^<\|(?:end|return|call)\|>/i;
const SPECIAL_RE = /^<\|[a-z0-9_]{1,24}\|>/i;
const ROLE_WORDS = ['assistant', 'user', 'system', 'developer', 'tool'];

/** `s` diawali "<" — mungkin ini awal sebuah tag yang belum lengkap? (buat nahan potongan) */
function mightBeTagStart(s) {
  if (s.length <= 1) return true;
  const l = s.toLowerCase();
  if (l[1] === '|') return true;
  const close = l[1] === '/';
  const body = l.slice(close ? 2 : 1);
  for (const n of NAMES) {
    if (n.startsWith(body)) return true;
    if (body.startsWith(n)) {
      const after = body.slice(n.length);
      if (close ? /^\s*$/.test(after) : /^[\s|<]/.test(after)) return true;
    }
  }
  return false;
}

/** Setelah tag pembuka, mungkin masih ada sisa "|message|>" yang nyusul di potongan berikutnya? */
function residueMightFollow(after) {
  const a = after.replace(/^\s+/, '');
  if (a === '') return true;
  return '|message|>'.startsWith(a) || '<|message|>'.startsWith(a);
}

function isRolePrefix(after) {
  const a = after.trimStart().toLowerCase();
  return ROLE_WORDS.some((w) => w.startsWith(a));
}

/**
 * Darurat: stream kelar padahal masih "di dalam thinking" dan gak ada satu pun teks jawaban.
 * Biasanya gara-gara provider nge-strip token pemisah (reasoning langsung nyambung ke jawaban:
 * "...beyond minimal.Berikut contoh ..."). Coba cari batas itu (titik langsung ketemu kata
 * berawalan kapital tanpa spasi); kalau gak ketemu, tampilkan semuanya daripada balasan kosong.
 */
function recoverAnswer(thinkText) {
  const re = /[a-z0-9)\]"'][.!?](?=[A-Z][a-z]{2,}(?:\s|[,;:!?]|$))/g;
  let cut = -1;
  let m;
  while ((m = re.exec(thinkText))) cut = m.index + 2;
  if (cut > 0 && cut < thinkText.length) return thinkText.slice(cut);
  return thinkText;
}

class ThinkingFilter {
  /** @param {{keepThinking?: boolean}} opts keepThinking=true -> teks thinking dikembalikan di field `thinking` */
  constructor({ keepThinking = false } = {}) {
    this.keep = Boolean(keepThinking);
    this.mode = 'content'; // 'content' | 'think'
    this.buf = '';
    this.started = false;
    this.awaitFinal = false; // lagi nunggu kata "assistantfinal" (varian token-ke-strip)
    this.sawThink = false;
    this.fence = false; // di dalam ``` ... ```
    this.inline = false; // di dalam `...` satu baris
    this.lineHasText = false;
    this.emittedVisible = false;
    this.thinkBuf = '';
  }

  push(text) {
    if (typeof text !== 'string' || text === '') return { content: '', thinking: '' };
    this.buf += text;
    return this._drain(false);
  }

  flush() {
    const out = this._drain(true);
    if (this.mode === 'think' && !this.emittedVisible && this.thinkBuf.trim()) {
      const recovered = recoverAnswer(this.thinkBuf).replace(/^\s+/, '');
      if (recovered) {
        out.content += recovered;
        this.emittedVisible = true;
      }
    }
    return out;
  }

  _emit(text, out) {
    if (!text) return;
    if (this.mode === 'think') {
      this.thinkBuf += text;
      if (this.thinkBuf.length > THINK_BUF_MAX) this.thinkBuf = this.thinkBuf.slice(-THINK_BUF_MAX);
      if (this.keep) out.thinking += text;
      return;
    }
    if (!this.emittedVisible && this.sawThink) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
    }
    out.content += text;
    if (/\S/.test(text)) this.emittedVisible = true;
    const nl = text.lastIndexOf('\n');
    if (nl === -1) {
      if (/\S/.test(text)) this.lineHasText = true;
    } else {
      this.lineHasText = /\S/.test(text.slice(nl + 1));
      this.inline = false;
    }
  }

  _matchTag(s, final) {
    let m;
    if (this.mode === 'content') {
      if ((m = OPEN_RE.exec(s))) {
        if (!final && residueMightFollow(s.slice(m[0].length))) return { kind: 'hold' };
        return { kind: 'open', len: m[0].length };
      }
      if ((m = CLOSE_RE.exec(s))) return { kind: 'stray', len: m[0].length };
    } else {
      if ((m = CLOSE_RE.exec(s))) return { kind: 'close', len: m[0].length };
      if ((m = OPEN_RE.exec(s))) {
        if (!final && residueMightFollow(s.slice(m[0].length))) return { kind: 'hold' };
        return { kind: 'nested', len: m[0].length };
      }
    }
    if ((m = CHANNEL_RE.exec(s))) return { kind: 'channel', name: m[1].toLowerCase(), len: m[0].length };
    if (/^<\|channel\|>/i.test(s)) {
      // "<|channel|>" doang belum cukup (nama channel + <|message|> masih di jalan) -> tunggu.
      if (!final && s.length < HOLD_MAX) return { kind: 'hold' };
      return { kind: 'drop', len: 11 };
    }
    if ((m = /^<\|start\|>/i.exec(s))) {
      const after = s.slice(m[0].length);
      const role = /^\s*(?:assistant|user|system|developer|tool)/i.exec(after);
      if (role) return { kind: 'drop', len: m[0].length + role[0].length };
      if (!final && after.length < 12 && isRolePrefix(after)) return { kind: 'hold' };
      return { kind: 'drop', len: m[0].length };
    }
    if ((m = END_RE.exec(s))) return { kind: 'end', len: m[0].length };
    if ((m = SPECIAL_RE.exec(s))) return { kind: 'drop', len: m[0].length };
    return null;
  }

  _apply(m) {
    switch (m.kind) {
      case 'open':
        this.mode = 'think';
        this.sawThink = true;
        this.awaitFinal = false;
        break;
      case 'close':
        this.mode = 'content';
        this.awaitFinal = false;
        break;
      case 'channel':
        if (m.name === 'final') this.mode = 'content';
        else {
          this.mode = 'think';
          this.sawThink = true;
        }
        this.awaitFinal = false;
        break;
      case 'end':
        if (this.mode === 'think') this.mode = 'content';
        break;
      default:
        break; // stray / nested / drop: buang aja tokennya
    }
  }

  _drain(final) {
    const out = { content: '', thinking: '' };

    if (!this.started) {
      const b = this.buf;
      if (!final && b.length < 9 && 'analysis'.startsWith(b.slice(0, 8))) return out; // belum bisa mutusin
      this.started = true;
      if (/^analysis[A-Z]/.test(b)) {
        this.mode = 'think';
        this.sawThink = true;
        this.awaitFinal = true;
        this.buf = b.slice(8);
      }
    }

    const buf = this.buf;
    let i = 0;
    let plainStart = 0;
    const flushPlain = (end) => {
      if (end > plainStart) this._emit(buf.slice(plainStart, end), out);
    };

    while (i < buf.length) {
      const ch = buf[i];
      const inCode = this.mode === 'content' && (this.fence || this.inline);

      if (ch === '<' && !inCode) {
        const rest = buf.slice(i);
        const m = this._matchTag(rest, final);
        if (m && m.kind === 'hold') {
          flushPlain(i);
          this.buf = rest;
          return out;
        }
        if (m) {
          flushPlain(i);
          this._apply(m);
          i += m.len;
          plainStart = i;
          continue;
        }
        if (!final && rest.length < HOLD_MAX && mightBeTagStart(rest)) {
          flushPlain(i);
          this.buf = rest;
          return out;
        }
        i++;
        continue;
      }

      if (ch === '`' && this.mode === 'content') {
        let j = i;
        while (j < buf.length && buf[j] === '`') j++;
        if (j === buf.length && !final) {
          flushPlain(i);
          this.buf = buf.slice(i);
          return out;
        }
        flushPlain(i);
        const run = j - i;
        const lineStart = !this.lineHasText;
        if (this.fence) {
          if (run >= 3 && lineStart) this.fence = false;
        } else if (run >= 3 && lineStart) {
          this.fence = true;
        } else if (run < 3) {
          this.inline = !this.inline;
        }
        this._emit(buf.slice(i, j), out);
        i = j;
        plainStart = j;
        continue;
      }

      if (ch === 'a' && this.mode === 'think' && this.awaitFinal) {
        if (buf.startsWith(FINAL_MARK, i)) {
          flushPlain(i);
          this.mode = 'content';
          this.awaitFinal = false;
          i += FINAL_MARK.length;
          plainStart = i;
          continue;
        }
        const tail = buf.slice(i);
        if (!final && tail.length < FINAL_MARK.length && FINAL_MARK.startsWith(tail)) {
          flushPlain(i);
          this.buf = tail;
          return out;
        }
      }
      i++;
    }

    flushPlain(buf.length);
    this.buf = '';
    return out;
  }
}

/** Pisahin teks lengkap (non-stream) jadi { content, thinking }. */
function splitThinking(text, opts = {}) {
  if (typeof text !== 'string' || text === '') return { content: typeof text === 'string' ? text : '', thinking: '' };
  const f = new ThinkingFilter({ keepThinking: true, ...opts });
  const a = f.push(text);
  const b = f.flush();
  return { content: a.content + b.content, thinking: a.thinking + b.thinking };
}

/** Buang semua thinking, sisain jawaban final aja. */
function stripThinkingTags(text) {
  if (!text || typeof text !== 'string') return text;
  return splitThinking(text, { keepThinking: false }).content;
}

function flattenContent(raw) {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function firstString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return '';
}

/** Ambil teks jawaban final dari message OpenAI-compatible (buang field reasoning). */
function pickAssistantContent(message) {
  if (!message || typeof message !== 'object') return '';
  return stripThinkingTags(flattenContent(message.content)) || '';
}

/**
 * Sanitasi response non-stream.
 *  - content: thinking dibuang (tag, harmony, dll)
 *  - reasoning_*: dibuang, KECUALI keepThinking=true -> dirapiin jadi satu field `reasoning_content`
 */
function sanitizeCompletionPayload(data, { keepThinking = false } = {}) {
  if (!data || typeof data !== 'object') return data;
  const clone = { ...data };
  if (Array.isArray(clone.choices)) {
    clone.choices = clone.choices.map((ch) => {
      if (!ch || typeof ch !== 'object') return ch;
      const next = { ...ch };
      if (next.message && typeof next.message === 'object') {
        const msg = { ...next.message };
        const native = firstString(msg.reasoning_content, msg.reasoning);
        const { content, thinking } = splitThinking(flattenContent(msg.content), { keepThinking: true });
        msg.content = content;
        delete msg.reasoning;
        delete msg.reasoning_content;
        delete msg.reasoning_details;
        if (keepThinking) {
          const t = [native, thinking].filter(Boolean).join('\n\n').trim();
          if (t) msg.reasoning_content = t;
        }
        next.message = msg;
      }
      if (next.delta && typeof next.delta === 'object') {
        // Jalur lama (stateless) — dipertahankan buat kompatibilitas. Stream asli pakai sse-think-filter.js.
        const delta = { ...next.delta };
        if (typeof delta.content === 'string') delta.content = stripThinkingTags(delta.content);
        delete delta.reasoning;
        delete delta.reasoning_content;
        delete delta.reasoning_details;
        next.delta = delta;
      }
      return next;
    });
  }
  return clone;
}

/** (Legacy, stateless) Sanitasi satu baris SSE `data: {...}`. Stream asli pakai sse-think-filter.js. */
function sanitizeSseDataLine(line) {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) return line;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return line;
  try {
    return 'data: ' + JSON.stringify(sanitizeCompletionPayload(JSON.parse(payload)));
  } catch (_) {
    return line;
  }
}

module.exports = {
  ThinkingFilter,
  splitThinking,
  stripThinkingTags,
  pickAssistantContent,
  sanitizeCompletionPayload,
  sanitizeSseDataLine,
  firstString,
};
