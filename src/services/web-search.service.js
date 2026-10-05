'use strict';

/**
 * Pencarian web real-time lewat DuckDuckGo.
 *
 * Kenapa bukan api.duckduckgo.com (yang dipakai kode lama)? Itu "Instant Answer API": cuma ngasih
 * ringkasan ala Wikipedia buat sebagian kecil query dan KOSONG buat kebanyakan pertanyaan, jadi model
 * tetap ngarang. Pencarian web beneran di DuckDuckGo = endpoint HTML (html.duckduckgo.com/html) dan Lite
 * (lite.duckduckgo.com/lite). Keduanya gak punya header CORS, jadi HARUS dipanggil dari server.
 *
 * Catatan jujur: ini scraping endpoint publik, bukan API resmi. DuckDuckGo bisa membatasi/memblokir IP
 * datacenter kalau trafiknya tinggi. Makanya ada: fallback html -> lite, circuit breaker (kalau diblokir,
 * berhenti nyoba sebentar biar chat gak nunggu), dan error yang jelas supaya model bisa JUJUR bilang
 * "pencarian gagal" alih-alih ngarang.
 */

const env = require('../config/env');
const logger = require('../utils/logger');
const { withTimeout, raceAbort } = require('../utils/abort');
const { decodeEntities, cleanSnippet } = require('../utils/html-text');

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const DDG_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class WebSearchError extends Error {
  /** code: BLOCKED | COOLDOWN | TIMEOUT | HTTP_ERROR | NETWORK | PARSE | ABORTED */
  constructor(code, message) {
    super(message);
    this.name = 'WebSearchError';
    this.code = code;
  }
}

// ------------------------------------------------------------------ parsing

/** Buka bungkus link DDG (//duckduckgo.com/l/?uddg=<url-asli>). Iklan (y.js) & link non-http -> null. */
function unwrapResultUrl(href) {
  if (!href) return null;
  let h = decodeEntities(String(href).trim());
  if (h.startsWith('//')) h = 'https:' + h;
  else if (h.startsWith('/')) h = 'https://duckduckgo.com' + h;
  let u;
  try {
    u = new URL(h);
  } catch (_) {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) {
    if (u.pathname.startsWith('/y.js')) return null; // iklan
    const target = u.searchParams.get('uddg');
    if (!target) return null;
    try {
      const t = new URL(target);
      return t.protocol === 'http:' || t.protocol === 'https:' ? t.toString() : null;
    } catch (_) {
      return null;
    }
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
}

function hrefOfTag(tag) {
  const m = /\bhref\s*=\s*"([^"]{1,2000})"/i.exec(tag) || /\bhref\s*=\s*'([^']{1,2000})'/i.exec(tag);
  return m ? m[1] : '';
}

/** Cari penanda class (mis. "result__a") sebagai nama class utuh, bukan awalan class lain. */
function findClass(html, cls, from) {
  let idx = html.indexOf(cls, from);
  while (idx !== -1) {
    const next = html[idx + cls.length];
    const prev = html[idx - 1];
    if ((next === '"' || next === "'" || next === ' ') && (prev === '"' || prev === "'" || prev === ' ')) return idx;
    idx = html.indexOf(cls, idx + cls.length);
  }
  return -1;
}

const TAG_WINDOW = 1600; // tag <a ...> yang wajar jauh lebih pendek dari ini
const MAX_PARSE_CHARS = 1500000; // halaman hasil DDG asli ~30-150KB

function parseResults(rawHtml, { linkClass, snippetClass, snippetEnds }) {
  const html = rawHtml.length > MAX_PARSE_CHARS ? rawHtml.slice(0, MAX_PARSE_CHARS) : rawHtml;
  const out = [];
  let pos = 0;
  while (out.length < 40 && pos < html.length) {
    const hit = findClass(html, linkClass, pos);
    if (hit === -1) break;
    // Pencarian awal/akhir tag DIBATASI ke jendela kecil: tanpa batas, input jahat (class berulang tanpa '>')
    // bikin lastIndexOf/indexOf nyisir seluruh dokumen tiap putaran = kuadratik.
    const backFrom = Math.max(0, hit - TAG_WINDOW);
    const aRel = html.slice(backFrom, hit).lastIndexOf('<a');
    const gtRel = html.slice(hit, hit + TAG_WINDOW).indexOf('>');
    const aStart = aRel === -1 ? -1 : backFrom + aRel;
    const aEnd = gtRel === -1 ? -1 : hit + gtRel;
    if (aStart === -1 || aEnd === -1) {
      pos = hit + linkClass.length;
      continue;
    }
    const closeA = html.indexOf('</a>', aEnd);
    if (closeA === -1) break;
    const tag = html.slice(aStart, aEnd + 1);
    const title = cleanSnippet(html.slice(aEnd + 1, closeA));
    pos = closeA + 4;

    const nextHit = findClass(html, linkClass, pos);
    const seg = html.slice(pos, nextHit === -1 ? Math.min(html.length, pos + 6000) : nextHit);
    let snippet = '';
    const sIdx = findClass(seg, snippetClass, 0);
    if (sIdx !== -1) {
      const sGt = seg.indexOf('>', sIdx);
      if (sGt !== -1) {
        const ends = snippetEnds.map((e) => seg.indexOf(e, sGt)).filter((x) => x !== -1);
        const end = ends.length ? Math.min(...ends) : seg.length;
        snippet = cleanSnippet(seg.slice(sGt + 1, end));
      }
    }

    const url = unwrapResultUrl(hrefOfTag(tag));
    if (!url || !title) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

function parseDdgHtml(html) {
  return parseResults(html, { linkClass: 'result__a', snippetClass: 'result__snippet', snippetEnds: ['</a>', '</div>', '</td>'] });
}

function parseDdgLite(html) {
  return parseResults(html, { linkClass: 'result-link', snippetClass: 'result-snippet', snippetEnds: ['</td>', '</tr>'] });
}

const BLOCK_STATUS = new Set([202, 403, 429]);
const BLOCK_MARKERS = /anomaly-modal|anomaly\.js|bots use DuckDuckGo|challenge-form|g-recaptcha/i;

/** Status HTTP khas pembatasan (DDG pakai 202 untuk "anomaly"), atau halaman tantangan bot. */
function looksBlocked(status, body) {
  if (BLOCK_STATUS.has(status)) return true;
  return BLOCK_MARKERS.test(String(body).slice(0, 30000));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/** Buang duplikat (host+path sama) dan batasi per-domain biar hasilnya beragam. */
function dedupeResults(list, { maxPerDomain = 2 } = {}) {
  const seen = new Set();
  const perDomain = new Map();
  const out = [];
  for (const r of list) {
    let key;
    try {
      const u = new URL(r.url);
      key = u.hostname.replace(/^www\./, '').toLowerCase() + u.pathname.replace(/\/+$/, '').toLowerCase();
    } catch (_) {
      continue;
    }
    if (seen.has(key)) continue;
    const domain = hostOf(r.url);
    const n = perDomain.get(domain) || 0;
    if (n >= maxPerDomain) continue;
    seen.add(key);
    perDomain.set(domain, n + 1);
    out.push({
      title: r.title.slice(0, 160),
      url: r.url,
      snippet: (r.snippet || '').slice(0, 400),
      domain,
    });
  }
  return out;
}

// ------------------------------------------------------------------ request

async function ddgRequest(endpoint, params, { timeoutMs }) {
  const t = withTimeout(null, timeoutMs);
  try {
    const origin = new URL(endpoint).origin;
    const res = await globalThis.fetch(endpoint, {
      method: 'POST',
      redirect: 'follow',
      signal: t.signal,
      headers: {
        'User-Agent': DDG_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: origin + '/',
        Origin: origin,
      },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    if (t.timedOut || err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new WebSearchError('TIMEOUT', 'DuckDuckGo timeout');
    }
    throw new WebSearchError('NETWORK', `Gagal menghubungi DuckDuckGo: ${err.message}`);
  } finally {
    t.done();
  }
}

async function searchEngine(engine, { query, region, timeRange }, { timeoutMs }) {
  const lite = engine === 'lite';
  const params = lite ? { q: query, kl: region } : { q: query, b: '', kl: region };
  if (timeRange) params.df = timeRange;
  const { status, text } = await ddgRequest(lite ? DDG_LITE_URL : DDG_HTML_URL, params, { timeoutMs });

  if (BLOCK_STATUS.has(status)) throw new WebSearchError('BLOCKED', `DuckDuckGo membatasi request (HTTP ${status})`);
  if (status < 200 || status >= 300) throw new WebSearchError('HTTP_ERROR', `DuckDuckGo membalas HTTP ${status}`);

  const results = lite ? parseDdgLite(text) : parseDdgHtml(text);
  if (results.length === 0) {
    // Penanda tantangan bot baru dipercaya kalau gak ada satu pun hasil: halaman hasil normal yang
    // cuplikannya kebetulan menyebut "g-recaptcha" gak boleh salah dikira diblokir.
    if (BLOCK_MARKERS.test(text.slice(0, 30000))) throw new WebSearchError('BLOCKED', 'DuckDuckGo menampilkan tantangan bot');
    if (/No\s+results\.?|no-results/i.test(text)) return [];
    // Halaman 200 tapi gak ada hasil & gak ada tulisan "No results" = kemungkinan layout berubah.
    throw new WebSearchError('PARSE', 'Format halaman hasil DuckDuckGo tidak terbaca');
  }
  return results;
}

// ------------------------------------------------------------------ orkestrasi

const breaker = { until: 0 };
const inflight = new Map();

function resetState() {
  breaker.until = 0;
  inflight.clear();
}

async function runEngines({ query, region, timeRange }, { timeoutMs }) {
  let lastErr = null;
  let blocked = 0;
  for (const engine of ['html', 'lite']) {
    try {
      const results = await searchEngine(engine, { query, region, timeRange }, { timeoutMs });
      return { engine, results };
    } catch (err) {
      lastErr = err;
      if (err.code === 'BLOCKED') blocked++;
      logger.warn('ddg_engine_failed', { engine, code: err.code, message: err.message });
    }
  }
  if (blocked === 2) breaker.until = Date.now() + env.webSearch.blockCooldownMs;
  throw lastErr;
}

async function doSearch({ query, region, timeRange, maxResults, timeoutMs }) {
  if (Date.now() < breaker.until) {
    throw new WebSearchError('COOLDOWN', 'DuckDuckGo sedang membatasi request dari server ini, dicoba lagi sebentar lagi');
  }
  let relaxed = false;
  let res = await runEngines({ query, region, timeRange }, { timeoutMs });
  if (res.results.length === 0 && timeRange) {
    // Filter waktu terlalu sempit (mis. "hari ini" belum ada yang ke-index) -> coba tanpa filter.
    relaxed = true;
    res = await runEngines({ query, region, timeRange: '' }, { timeoutMs });
  }
  return {
    engine: res.engine,
    timeRange: relaxed ? '' : timeRange || '',
    relaxed,
    results: dedupeResults(res.results).slice(0, maxResults),
  };
}

/**
 * @param {{query:string, region?:string, timeRange?:''|'d'|'w'|'m'|'y', maxResults?:number, signal?:AbortSignal, timeoutMs?:number}} opts
 * @returns {Promise<{engine:'html'|'lite', timeRange:string, relaxed:boolean, results:Array<{title,url,snippet,domain}>}>}
 */
function searchDuckDuckGo({ query, region = 'wt-wt', timeRange = '', maxResults, signal, timeoutMs } = {}) {
  const q = String(query || '').trim();
  if (!q) return Promise.reject(new WebSearchError('PARSE', 'Query kosong'));
  const cfg = env.webSearch;
  const args = {
    query: q,
    region,
    timeRange,
    maxResults: maxResults || cfg.maxResults,
    timeoutMs: timeoutMs || cfg.searchTimeoutMs,
  };
  // Query identik yang jalan BERSAMAAN (mis. Multi Chat nembak N model sekaligus) berbagi satu pencarian.
  // Begitu selesai, entri dihapus: gak ada cache, jadi hasil selalu segar.
  const key = `${region}|${timeRange}|${args.maxResults}|${q.toLowerCase()}`;
  let p = inflight.get(key);
  if (!p) {
    p = doSearch(args).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return raceAbort(p, signal, () => new WebSearchError('ABORTED', 'Dibatalkan'));
}

module.exports = {
  searchDuckDuckGo,
  WebSearchError,
  // diekspor buat test
  parseDdgHtml,
  parseDdgLite,
  unwrapResultUrl,
  looksBlocked,
  dedupeResults,
  resetState,
  _breaker: breaker,
};
