'use strict';
/**
 * Test services/web-search.service.js. DuckDuckGo di-mock lewat fetch (gak ada koneksi internet di test).
 *
 * CATATAN JUJUR: fixture HTML di bawah dimodelkan dari struktur halaman html.duckduckgo.com & lite.duckduckgo.com
 * yang dikenal, BUKAN diambil live. Kalau DuckDuckGo ngubah markup-nya, test ini tetap hijau tapi parser bisa
 * gagal di produksi: makanya ada `npm run search:test` (scripts/test-web-search.js) buat uji LIVE dari mesin/server lu.
 * Jalankan: node --test tests/web-search.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { NODE_ENV: 'test', WEB_SEARCH_BLOCK_COOLDOWN_MS: '60000' });

const ws = require('../src/services/web-search.service');
const realFetch = globalThis.fetch;
let calls = [];

test.beforeEach(() => ws.resetState());
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const HTML_PAGE = `
<div class="serp__results"><div class="results">
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fberita%2Fa%3Fid%3D1%26x%3D2&amp;rut=abc123">Judul <b>Satu</b> &amp; Lainnya</a>
    </h2>
    <div class="result__extras"><a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fberita%2Fa&amp;rut=abc123">www.example.com/berita/a</a></div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fberita%2Fa&amp;rut=abc123">Ini cuplikan <b>pertama</b> tentang topik &amp; lainnya.</a>
    <div class="clear"></div>
  </div>
</div>
<div class="result results_links results_links_deep result--ad">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad_domain=iklan.com&amp;ad_provider=bingv7aa&amp;u3=zzz">Iklan Sponsor</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/y.js?x=1">Beli sekarang juga</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://berita.id/artikel/dua">Judul Dua</a></h2>
  <a class="result__snippet" href="https://berita.id/artikel/dua">Cuplikan kedua tanpa pembungkus link.</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)&amp;rut=q">Link Jahat</a></h2>
  <a class="result__snippet" href="#">Skema javascript harus dibuang</a>
</div>
</div></div>`;

const LITE_PAGE = `
<table border="0">
<tr><td valign="top">1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fx&amp;rut=zzz" class='result-link'>Judul Lite Satu</a></td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>Cuplikan lite <b>satu</b> &amp; seterusnya</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td><span class='link-text'>example.org/x</span></td></tr>
<tr><td valign="top">2.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcontoh.net%2Fy&amp;rut=yyy" class='result-link'>Judul Lite Dua</a></td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>Cuplikan lite dua</td></tr>
</table>`;

const NO_RESULTS_PAGE = '<html><body><div class="no-results">No  results.</div></body></html>';
const ANOMALY_PAGE = '<html><body><div class="anomaly-modal__modal">Unfortunately, bots use DuckDuckGo too.</div></body></html>';

function htmlRes(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
/** handler(call) -> Response; call = {host, body(URLSearchParams)} */
function mockDdg(handler) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    const body = new URLSearchParams(String((opts && opts.body) || ''));
    const call = { host: u.hostname, method: opts && opts.method, body, headers: opts && opts.headers };
    calls.push(call);
    return handler(call);
  };
}

// ---------------------------------------------------------------- parser

test('parseDdgHtml: judul/URL/cuplikan benar, iklan & skema berbahaya dibuang, entitas didekode', () => {
  const r = ws.parseDdgHtml(HTML_PAGE);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], {
    title: 'Judul Satu & Lainnya',
    url: 'https://www.example.com/berita/a?id=1&x=2',
    snippet: 'Ini cuplikan pertama tentang topik & lainnya.',
  });
  assert.equal(r[1].url, 'https://berita.id/artikel/dua');
  assert.equal(r[1].snippet, 'Cuplikan kedua tanpa pembungkus link.');
});

test('parseDdgLite: layout tabel dengan atribut berurutan beda & kutip tunggal', () => {
  const r = ws.parseDdgLite(LITE_PAGE);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Judul Lite Satu');
  assert.equal(r[0].url, 'https://example.org/x');
  assert.equal(r[0].snippet, 'Cuplikan lite satu & seterusnya');
  assert.equal(r[1].url, 'https://contoh.net/y');
});

test('parser: halaman kosong/sampah/jahat gak hang dan balikin array kosong', () => {
  assert.deepEqual(ws.parseDdgHtml(''), []);
  assert.deepEqual(ws.parseDdgHtml('<html>tidak ada hasil</html>'), []);
  const t0 = Date.now();
  ws.parseDdgHtml('<a class="result__a" '.repeat(100000));
  ws.parseDdgLite("<a class='result-link' ".repeat(100000));
  assert.ok(Date.now() - t0 < 3000, 'parser lambat untuk input jahat');
});

test('unwrapResultUrl: buka bungkus uddg, tolak iklan y.js, javascript:, data:, dan non-URL', () => {
  const u = ws.unwrapResultUrl;
  assert.equal(u('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fp%3Fq%3D1&rut=x'), 'https://a.com/p?q=1');
  assert.equal(u('https://duckduckgo.com/l/?uddg=http%3A%2F%2Fb.org%2F'), 'http://b.org/');
  assert.equal(u('https://langsung.com/halaman'), 'https://langsung.com/halaman');
  assert.equal(u('//duckduckgo.com/y.js?ad_domain=x.com'), null);
  assert.equal(u('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'), null);
  assert.equal(u('//duckduckgo.com/l/?uddg=data%3Atext%2Fhtml%2Cx'), null);
  assert.equal(u('//duckduckgo.com/l/?rut=tanpa-uddg'), null);
  assert.equal(u('javascript:alert(1)'), null);
  assert.equal(u(''), null);
  assert.equal(u(null), null);
});

test('looksBlocked: status 202/403/429 atau halaman tantangan bot', () => {
  assert.equal(ws.looksBlocked(202, ''), true);
  assert.equal(ws.looksBlocked(429, ''), true);
  assert.equal(ws.looksBlocked(200, ANOMALY_PAGE), true);
  assert.equal(ws.looksBlocked(200, HTML_PAGE), false);
});

test('dedupeResults: URL kembar dibuang, maksimal 2 hasil per domain, domain tanpa www', () => {
  const mk = (url, title = 't') => ({ title, url, snippet: 's' });
  const out = ws.dedupeResults([
    mk('https://www.a.com/x/'), mk('https://a.com/x'), mk('https://a.com/y'), mk('https://a.com/z'), mk('https://b.com/1'),
  ]);
  assert.deepEqual(out.map((r) => r.url), ['https://www.a.com/x/', 'https://a.com/y', 'https://b.com/1']);
  assert.equal(out[0].domain, 'a.com');
});

// ---------------------------------------------------------------- orkestrasi

test('searchDuckDuckGo: sukses via endpoint HTML, parameter form benar (q, kl, df)', async () => {
  mockDdg(() => htmlRes(HTML_PAGE));
  const r = await ws.searchDuckDuckGo({ query: 'harga emas', region: 'id-id', timeRange: 'd' });
  assert.equal(r.engine, 'html');
  assert.equal(r.relaxed, false);
  assert.equal(r.timeRange, 'd');
  assert.equal(r.results.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'html.duckduckgo.com');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.get('q'), 'harga emas');
  assert.equal(calls[0].body.get('kl'), 'id-id');
  assert.equal(calls[0].body.get('df'), 'd');
});

test('searchDuckDuckGo: HTML diblokir (HTTP 202) -> otomatis fallback ke Lite', async () => {
  mockDdg((c) => (c.host === 'html.duckduckgo.com' ? htmlRes(ANOMALY_PAGE, 202) : htmlRes(LITE_PAGE)));
  const r = await ws.searchDuckDuckGo({ query: 'apa saja' });
  assert.equal(r.engine, 'lite');
  assert.deepEqual(calls.map((c) => c.host), ['html.duckduckgo.com', 'lite.duckduckgo.com']);
  assert.equal(r.results[0].title, 'Judul Lite Satu');
});

test('searchDuckDuckGo: keduanya diblokir -> BLOCKED, lalu COOLDOWN tanpa menyentuh jaringan, sampai direset', async () => {
  mockDdg(() => htmlRes(ANOMALY_PAGE, 202));
  await assert.rejects(ws.searchDuckDuckGo({ query: 'a b' }), (e) => e.code === 'BLOCKED');
  assert.equal(calls.length, 2);
  await assert.rejects(ws.searchDuckDuckGo({ query: 'query lain' }), (e) => e.code === 'COOLDOWN');
  assert.equal(calls.length, 2, 'selama cooldown gak boleh ada request baru');
  ws.resetState();
  mockDdg(() => htmlRes(HTML_PAGE));
  assert.equal((await ws.searchDuckDuckGo({ query: 'pulih' })).results.length, 2);
});

test('searchDuckDuckGo: hanya satu engine yang diblokir TIDAK memicu cooldown', async () => {
  mockDdg((c) => (c.host === 'html.duckduckgo.com' ? htmlRes(ANOMALY_PAGE, 202) : htmlRes(LITE_PAGE)));
  await ws.searchDuckDuckGo({ query: 'satu' });
  mockDdg(() => htmlRes(HTML_PAGE));
  const r = await ws.searchDuckDuckGo({ query: 'dua' });
  assert.equal(r.engine, 'html');
});

test('searchDuckDuckGo: filter waktu terlalu sempit & kosong -> dilonggarkan, ditandai relaxed', async () => {
  mockDdg((c) => (c.body.get('df') ? htmlRes(NO_RESULTS_PAGE) : htmlRes(HTML_PAGE)));
  const r = await ws.searchDuckDuckGo({ query: 'berita hari ini', timeRange: 'd' });
  assert.equal(r.relaxed, true);
  assert.equal(r.timeRange, '');
  assert.equal(r.results.length, 2);
  assert.deepEqual(calls.map((c) => c.body.get('df')), ['d', null]);
});

test('searchDuckDuckGo: benar-benar tanpa hasil -> array kosong (bukan error)', async () => {
  mockDdg(() => htmlRes(NO_RESULTS_PAGE));
  const r = await ws.searchDuckDuckGo({ query: 'zzzzqqqqxxxx' });
  assert.deepEqual(r.results, []);
});

test('searchDuckDuckGo: halaman 200 tanpa hasil & tanpa "No results" -> PARSE (layout berubah, jangan pura-pura kosong)', async () => {
  mockDdg(() => htmlRes('<html><body><div>layout baru yang gak dikenal</div></body></html>'));
  await assert.rejects(ws.searchDuckDuckGo({ query: 'x y' }), (e) => e.code === 'PARSE');
});

test('searchDuckDuckGo: hasil normal yang cuplikannya menyebut "g-recaptcha" TIDAK dikira diblokir', async () => {
  const page = HTML_PAGE.replace('Ini cuplikan <b>pertama</b>', 'Cara pasang g-recaptcha di <b>form</b>');
  mockDdg(() => htmlRes(page));
  const r = await ws.searchDuckDuckGo({ query: 'cara pasang recaptcha' });
  assert.equal(r.results.length, 2);
});

test('searchDuckDuckGo: error jaringan -> NETWORK; HTTP 500 -> HTTP_ERROR di kedua engine', async () => {
  mockDdg(() => {
    throw new Error('ECONNRESET');
  });
  await assert.rejects(ws.searchDuckDuckGo({ query: 'a b' }), (e) => e.code === 'NETWORK');
  ws.resetState();
  mockDdg(() => htmlRes('oops', 500));
  await assert.rejects(ws.searchDuckDuckGo({ query: 'c d' }), (e) => e.code === 'HTTP_ERROR');
});

test('searchDuckDuckGo: timeout -> TIMEOUT', async () => {
  globalThis.fetch = (url, opts) =>
    new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })));
    });
  await assert.rejects(ws.searchDuckDuckGo({ query: 'lambat sekali', timeoutMs: 150 }), (e) => e.code === 'TIMEOUT');
});

test('searchDuckDuckGo: query identik yang BERSAMAAN berbagi satu pencarian, setelah selesai gak di-cache', async () => {
  mockDdg(async () => {
    await new Promise((r) => setTimeout(r, 40));
    return htmlRes(HTML_PAGE);
  });
  const [a, b, c] = await Promise.all([
    ws.searchDuckDuckGo({ query: 'Multi Chat' }),
    ws.searchDuckDuckGo({ query: 'multi chat' }),
    ws.searchDuckDuckGo({ query: 'multi chat' }),
  ]);
  assert.equal(calls.length, 1, 'tiga request bersamaan harus jadi satu fetch');
  assert.equal(a.results.length, 2);
  assert.equal(b.results.length, 2);
  assert.equal(c.results.length, 2);
  await ws.searchDuckDuckGo({ query: 'multi chat' });
  assert.equal(calls.length, 2, 'request berikutnya (setelah selesai) harus fetch ulang: tanpa cache');
});

test('searchDuckDuckGo: abort dari satu pemanggil gak membatalkan pemanggil lain yang berbagi pencarian', async () => {
  mockDdg(async () => {
    await new Promise((r) => setTimeout(r, 80));
    return htmlRes(HTML_PAGE);
  });
  const ac = new AbortController();
  const aborted = ws.searchDuckDuckGo({ query: 'dibatalkan sebagian', signal: ac.signal });
  const kept = ws.searchDuckDuckGo({ query: 'dibatalkan sebagian' });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(aborted, (e) => e.code === 'ABORTED');
  assert.equal((await kept).results.length, 2);
  assert.equal(calls.length, 1);
});

test('searchDuckDuckGo: query kosong ditolak; maxResults dihormati', async () => {
  await assert.rejects(ws.searchDuckDuckGo({ query: '   ' }), (e) => e.code === 'PARSE');
  mockDdg(() => htmlRes(HTML_PAGE));
  assert.equal((await ws.searchDuckDuckGo({ query: 'batas hasil', maxResults: 1 })).results.length, 1);
});
