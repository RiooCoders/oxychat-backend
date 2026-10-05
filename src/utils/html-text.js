'use strict';

/**
 * Konversi HTML -> teks polos buat dibaca model. Halaman yang dibaca = input dari internet
 * (bisa sengaja dibikin jahat), jadi SEMUA scanner di sini linear (indexOf/loop manual),
 * bukan regex lazy `[\s\S]*?` yang bisa meledak O(n^2) di HTML yang tag-nya sengaja gak ditutup.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', plusmn: '±',
  times: '×', divide: '÷', rarr: '→', larr: '←',
};

function decodeEntities(str) {
  if (!str) return '';
  const s = String(str);
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]{1,8}|#[0-9]{1,10}|[a-z][a-z0-9]{1,10});/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
      try {
        return String.fromCodePoint(code);
      } catch (_) {
        return ' ';
      }
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

/** lowercase khusus A-Z ASCII: panjang string DIJAMIN sama, jadi index lower == index asli. */
function asciiLower(s) {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

function isDelimAfterTag(ch) {
  return ch === undefined || ch === '>' || ch === '/' || ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
}

/** Cari indeks awal tag `<name` (case-insensitive lewat `lower`) yang beneran tag itu, bukan awalan tag lain (<header vs <head). */
function findTagOpen(lower, name, from) {
  const open = '<' + name;
  let s = lower.indexOf(open, from);
  while (s !== -1 && !isDelimAfterTag(lower[s + open.length])) s = lower.indexOf(open, s + open.length);
  return s;
}

/** Buang seluruh blok <tag ...>...</tag> (linear). Tag yang gak ditutup = sisa dokumen dibuang. */
function removeBlocks(html, tag) {
  const lower = asciiLower(html);
  const close = '</' + tag;
  let out = '';
  let i = 0;
  for (;;) {
    const s = findTagOpen(lower, tag, i);
    if (s === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, s);
    const e = lower.indexOf(close, s + tag.length + 1);
    if (e === -1) break;
    const gt = lower.indexOf('>', e);
    if (gt === -1) break;
    i = gt + 1;
  }
  return out;
}

/** Ambil isi blok pertama <tag>...</tag> mulai dari `from`. Return {inner, end} atau null. */
function extractBlock(html, lower, tag, from = 0) {
  const s = findTagOpen(lower, tag, from);
  if (s === -1) return null;
  const openEnd = lower.indexOf('>', s);
  if (openEnd === -1) return null;
  const e = lower.indexOf('</' + tag, openEnd);
  const innerEnd = e === -1 ? html.length : e;
  const gt = e === -1 ? -1 : lower.indexOf('>', e);
  return { inner: html.slice(openEnd + 1, innerEnd), end: gt === -1 ? html.length : gt + 1 };
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'table', 'section', 'article', 'blockquote', 'pre', 'hr',
  'figure', 'figcaption', 'dd', 'dt', 'dl', 'main', 'header', 'thead', 'tbody', 'tfoot',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'details', 'summary',
]);

/** Strip tag secara linear. Tag blok -> newline, sel tabel -> " | ", heading h1-h3 -> prefix "## ". */
function htmlToPlain(html) {
  const out = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    const c1 = html.charCodeAt(lt + 1);
    const isLetter = (c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122);
    const isClose = c1 === 47; // "/"
    if (!(isLetter || isClose || c1 === 33 || c1 === 63)) {
      out.push('<'); // "<" biasa di teks (mis. "a < b")
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) break; // tag gak ketutup sampai akhir dokumen: sisanya dibuang
    let k = lt + 1 + (isClose ? 1 : 0);
    const nameStart = k;
    while (k < gt) {
      const c = html.charCodeAt(k);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k++;
      else break;
    }
    const name = html.slice(nameStart, k).toLowerCase();
    if (BLOCK_TAGS.has(name)) {
      out.push(!isClose && (name === 'h1' || name === 'h2' || name === 'h3') ? '\n## ' : '\n');
    } else if (isClose && (name === 'td' || name === 'th')) {
      out.push(' | ');
    }
    i = gt + 1;
  }
  return out.join('');
}

function trimPipes(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === '|' || s[a] === ' ')) a++;
  while (b > a && (s[b - 1] === '|' || s[b - 1] === ' ')) b--;
  return s.slice(a, b);
}

function normalizeLines(plain) {
  const lines = decodeEntities(plain).split('\n');
  const seen = new Set();
  const kept = [];
  for (const raw of lines) {
    let l = raw.length > 2000 ? raw.slice(0, 2000) : raw;
    l = l.replace(/[\t\f\v\r\u00a0\u200b\u200c\u200d\ufeff]+/g, ' ').replace(/ {2,}/g, ' ');
    l = trimPipes(l.trim());
    if (!l) continue;
    const isHeading = l.startsWith('## ');
    if (isHeading) {
      if (l.length <= 3) continue;
    } else {
      const long = l.length >= 40;
      const sentence = l.length >= 20 && /[.!?:;]$/.test(l);
      const tableRow = l.length >= 12 && l.includes(' | ');
      if (!(long || sentence || tableRow)) continue; // buang sisa menu/tombol/label pendek
      if (seen.has(l)) continue;
      seen.add(l);
    }
    kept.push(l);
  }
  return kept.join('\n');
}

// <form> SENGAJA gak dibuang: situs ASP.NET/CMS lama sering ngebungkus SELURUH halaman dalam satu <form>.
const NOISE_TAGS = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'object', 'embed',
  'select', 'button', 'nav', 'footer', 'aside', 'dialog', 'head',
];

function removeComments(html) {
  let out = '';
  let i = 0;
  for (;;) {
    const s = html.indexOf('<!--', i);
    if (s === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, s);
    const e = html.indexOf('-->', s + 4);
    if (e === -1) break;
    i = e + 3;
  }
  return out;
}

/**
 * HTML -> teks bersih. Prioritas area konten: <main> > beberapa <article> > <body> > semua.
 * Return teks baris-per-baris (heading diawali "## "), TANPA dipotong (pemotongan sesuai budget
 * dilakukan pemanggil lewat selectRelevant biar bagian yang relevan yang dipilih, bukan sekadar awal halaman).
 */
function htmlToText(html, { maxInputChars = 1500000 } = {}) {
  let h = String(html || '');
  if (h.length > maxInputChars) h = h.slice(0, maxInputChars);
  h = removeComments(h);
  for (const tag of NOISE_TAGS) h = removeBlocks(h, tag);

  const lower = asciiLower(h);
  const candidates = [];
  const main = extractBlock(h, lower, 'main');
  if (main) candidates.push({ html: main.inner, min: 400 });
  const arts = [];
  let from = 0;
  for (let k = 0; k < 3; k++) {
    const a = extractBlock(h, lower, 'article', from);
    if (!a) break;
    arts.push(a.inner);
    from = a.end;
  }
  if (arts.length) candidates.push({ html: arts.join('\n'), min: 500 });

  for (const c of candidates) {
    const text = normalizeLines(htmlToPlain(c.html));
    if (text.length >= c.min) return text;
  }
  const body = extractBlock(h, lower, 'body');
  return normalizeLines(htmlToPlain(body ? body.inner : h));
}

/** Potong di batas baris/kalimat terdekat biar gak berhenti di tengah kata. */
function cutAt(text, maxChars) {
  if (!text || text.length <= maxChars) return text || '';
  const slice = text.slice(0, maxChars);
  const floor = Math.floor(maxChars * 0.7);
  const nl = slice.lastIndexOf('\n');
  const dot = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  const cut = Math.max(nl, dot >= 0 ? dot + 1 : -1);
  return (cut >= floor ? slice.slice(0, cut) : slice).trimEnd() + '…';
}

/** HTML pendek (cuplikan hasil pencarian/judul) -> satu baris teks. */
function cleanSnippet(fragment) {
  const plain = htmlToPlain(String(fragment || ''));
  return decodeEntities(plain).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- metadata halaman

function attrOf(tag, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]{0,600})"|\'([^\']{0,600})\')', 'i');
  const m = re.exec(tag);
  return m ? m[1] !== undefined ? m[1] : m[2] : '';
}

const DATE_META_PRIORITY = [
  'article:published_time', 'og:article:published_time', 'datepublished', 'pubdate', 'publishdate',
  'date', 'dc.date.issued', 'dc.date', 'article:modified_time', 'og:updated_time', 'datemodified',
];

function normalizeDate(s, now = Date.now()) {
  if (!s) return null;
  const d = new Date(String(s).trim());
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  if (t > now + 86400000) return null; // tanggal masa depan = metadata ngaco
  if (d.getUTCFullYear() < 1990) return null;
  return d.toISOString().slice(0, 10);
}

/** Judul, deskripsi, dan tanggal terbit (YYYY-MM-DD) dari HTML mentah. Semua batas panjangnya terbatas. */
function extractMeta(html, { now = Date.now() } = {}) {
  const head = String(html || '').slice(0, 400000);
  const out = { title: '', description: '', published: null };

  const t = /<title\b[^>]{0,200}>([^<]{0,500})<\/title>/i.exec(head);
  if (t) out.title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim();

  const lower = asciiLower(head);
  const metaMap = new Map();
  let pos = 0;
  for (let guard = 0; guard < 400; guard++) {
    const s = lower.indexOf('<meta', pos);
    if (s === -1) break;
    const e = lower.indexOf('>', s);
    if (e === -1) break;
    pos = e + 1;
    const tag = head.slice(s, Math.min(e + 1, s + 1500));
    const key = (attrOf(tag, 'property') || attrOf(tag, 'name') || attrOf(tag, 'itemprop')).toLowerCase();
    const val = attrOf(tag, 'content');
    if (key && val && !metaMap.has(key)) metaMap.set(key, val);
  }

  const desc = metaMap.get('description') || metaMap.get('og:description') || '';
  out.description = decodeEntities(desc).replace(/\s+/g, ' ').trim().slice(0, 400);

  for (const k of DATE_META_PRIORITY) {
    const d = normalizeDate(metaMap.get(k), now);
    if (d) {
      out.published = d;
      break;
    }
  }
  if (!out.published) {
    const ld = /"datePublished"\s*:\s*"([^"]{8,40})"/.exec(head);
    if (ld) out.published = normalizeDate(ld[1], now);
  }
  if (!out.published) {
    const tm = /<time\b[^>]{0,200}?\bdatetime\s*=\s*["']([^"']{8,40})["']/i.exec(head);
    if (tm) out.published = normalizeDate(tm[1], now);
  }
  return out;
}

module.exports = {
  decodeEntities,
  htmlToText,
  htmlToPlain,
  cleanSnippet,
  cutAt,
  extractMeta,
  normalizeDate,
};
